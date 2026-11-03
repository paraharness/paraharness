import { z } from 'zod';
import { H, type Model, type PolicyCtx, type Sample } from 'harness-dsl';
import { sqlite } from 'harness-dsl/sqlite';
import { jsonl } from 'harness-dsl/jsonl';
import { anthropic } from 'harness-dsl/anthropic';
import { claudeCode } from 'harness-dsl/claude-code';
import { contentful } from 'harness-dsl/contentful';
import { local } from 'harness-dsl/local';
import { markdown } from 'harness-dsl/markdown';

const DraftAttributes = z.object({
  entryId: z.string(),
  title: z.string(),
  section: z.string(),
  body: z.string(),
});
type DraftAttrs = z.infer<typeof DraftAttributes>;

const Submitted = H.state('submitted', 'pending');
const UnderReview = H.state('under-review', 'active');
const WithEditor = H.state('with-editor', 'waiting');
const Accepted = H.state('accepted', 'terminal', 'success');
const Returned = H.state('returned', 'terminal', 'neutral');
const ReviewBroken = H.state('review-broken', 'terminal', 'failure');

const Draft = H.kind('Draft')
  .attributes(DraftAttributes)
  .states(Submitted, UnderReview, WithEditor, Accepted, Returned, ReviewBroken)
  .key(draft => draft.entryId);

const reviewer = H.role('reviewer')
  .intents('read')
  .instructions('Critique the draft against the house taste and the fact-checking lessons. Name each problem, quote the passage, propose the fix.');

const editorialTaste = H.memory('editorial-taste', 'taste');
const factCheckLessons = H.memory('fact-check-lessons', 'experience');
const bySpecificity = H.recall('editorial-by-specificity', { by: 'specificity', limit: 20 });

const tasteJournal = H.journal('editor-taste-journal', editorialTaste)
  .store(jsonl.memoryStore({ path: 'memory/editor-taste.jsonl' }))
  .recall(bySpecificity)
  .readBy(reviewer);

const lessonJournal = H.journal('fact-check-journal', factCheckLessons)
  .store(jsonl.memoryStore({ path: 'memory/fact-check-lessons.jsonl' }))
  .recall(bySpecificity)
  .readBy(reviewer);

const editorialApi = anthropic.account('editorial-api', { apiKey: H.env('ANTHROPIC_API_KEY') });
const opus = anthropic.model('opus', { id: 'claude-opus-4-1' });
const sonnet = anthropic.model('sonnet', { id: 'claude-sonnet-4-5' });
const haiku = anthropic.model('haiku', { id: 'claude-haiku-4-5' });
const editorialPool = H.pool('editorial-pool').accounts(editorialApi);

function reviewerSeats(ctx: PolicyCtx): { readonly first: Model; readonly second: Model } {
  const window = { windowDays: 60 };
  const opusRecord = ctx.metrics.rate(critiqueActedOn, { ...window, group: opus.name });
  const sonnetRecord = ctx.metrics.rate(critiqueActedOn, { ...window, group: sonnet.name });
  if (opusRecord.samples < 50 || sonnetRecord.samples < 50) return { first: opus, second: sonnet };
  return opusRecord.rate >= sonnetRecord.rate ? { first: opus, second: haiku } : { first: haiku, second: sonnet };
}

const Critique = z.object({
  problems: z.array(z.object({ passage: z.string(), problem: z.string(), fix: z.string() })),
});

const firstReviewer = H.agent('first-reviewer')
  .role(reviewer)
  .model(H.policy.model('first-reviewer-model', [opus, sonnet, haiku], ctx => reviewerSeats(ctx).first))
  .output(Critique);

const secondReviewer = H.agent('second-reviewer')
  .role(reviewer)
  .model(H.policy.model('second-reviewer-model', [opus, sonnet, haiku], ctx => reviewerSeats(ctx).second))
  .output(Critique);

const editorialBox = local.runner('editorial-box');

const MergedCritique = z.object({
  points: z.array(z.object({ from: z.enum(['first', 'second', 'both']), problem: z.string(), fix: z.string() })),
});

const mergeCritiques = H.command('merge-critiques')
  .input(z.object({ first: Critique, second: Critique }))
  .argv(input => ['critique-merge', '--first', JSON.stringify(input.first), '--second', JSON.stringify(input.second)])
  .output(MergedCritique)
  .runner(editorialBox);

const factCheck = H.command('fact-check')
  .input(z.object({ section: z.string(), body: z.string() }))
  .argv(input => ['fact-check', '--section', input.section, '--body', input.body])
  .output(z.object({ repeatMistake: z.object({ lesson: z.string() }).nullable() }))
  .runner(editorialBox);

const EditorDecision = z.object({
  action: z.enum(['accept', 'return']),
  notes: z.string(),
  actedOn: z.array(z.enum(['first', 'second'])),
  noteScope: z.enum(['all-drafts', 'section']),
});

function reviewTask(draft: DraftAttrs) {
  return {
    task: `Critique the ${draft.section} draft "${draft.title}":\n\n${draft.body}`,
    skills: [draft.section],
  };
}

const reviewFlow = H.flow('draft-review')
  .input(DraftAttributes)
  .step('firstCritique', firstReviewer, ctx => reviewTask(ctx.unit.attributes))
  .step('secondCritique', secondReviewer, ctx => reviewTask(ctx.unit.attributes))
  .step('merge', mergeCritiques, ctx => ({ first: ctx.steps.firstCritique, second: ctx.steps.secondCritique }))
  .step('factCheck', factCheck, ctx => ({ section: ctx.unit.attributes.section, body: ctx.unit.attributes.body }))
  .halt('editor', {
    ask: ctx => `"${ctx.unit.attributes.title}": ${ctx.steps.merge.points.length} merged review points. Accept, or return with notes; say which reviewer's points you acted on.`,
    decision: EditorDecision,
  })
  .exit('accepted', ctx => ctx.steps.editor.action === 'accept')
  .exit('returned');

const cmsToken = H.env('CONTENTFUL_TOKEN');

const drafts = H.lane('drafts', Draft)
  .supply(contentful.drafts({ space: 'publication', token: cmsToken, everyMinutes: 10 }), (entry, to) =>
    to.create({ entryId: entry.id, title: entry.title, section: entry.section, body: entry.body }),
  )
  .store(contentful.store({ space: 'publication', token: cmsToken }))
  .handler(reviewFlow, {
    exits: { accepted: Accepted, returned: Returned },
    during: { firstCritique: UnderReview, editor: WithEditor },
    failure: ReviewBroken,
  });

const critiqueActedOn = H.metric('critique-acted-on')
  .from(H.when.step(drafts, 'editor'))
  .samples(event => {
    const acted: readonly string[] = event.output?.actedOn ?? [];
    const samples: Sample[] = [];
    const firstModel = event.models.firstCritique;
    const secondModel = event.models.secondCritique;
    if (firstModel !== undefined) samples.push({ group: firstModel, hit: acted.includes('first') });
    if (secondModel !== undefined) samples.push({ group: secondModel, hit: acted.includes('second') });
    return samples;
  });

const tasteFromReturnedDrafts = H.trigger('taste-from-returned-drafts')
  .on(H.when.step(drafts, 'editor', { if: event => event.output?.action === 'return' }))
  .record(tasteJournal, event => {
    const decision = event.output;
    if (decision === undefined || decision.notes.trim() === '') return undefined;
    return {
      text: decision.notes,
      status: 'candidate',
      when: decision.noteScope === 'section'
        ? { kinds: [Draft], skills: [event.unit.attributes.section] }
        : { kinds: [Draft] },
    };
  });

const lessonsFromFactCheck = H.trigger('lessons-from-fact-check')
  .on(H.when.step(drafts, 'factCheck'))
  .record(lessonJournal, event => {
    const mistake = event.output?.repeatMistake;
    if (!mistake) return undefined;
    return { text: mistake.lesson, status: 'active', when: { kinds: [Draft], skills: [event.unit.attributes.section] } };
  });

export const editorial = H.harness('editorial')
  .ledger(sqlite.ledger({ path: 'state/editorial.db' }))
  .pools(editorialPool)
  .lanes(drafts)
  .journals(tasteJournal, lessonJournal)
  .triggers(tasteFromReturnedDrafts, lessonsFromFactCheck)
  .metrics(critiqueActedOn)
  .scheduler(H.scheduler('editorial-scheduler').priority(drafts).wip(drafts, 4))
  .clients(
    claudeCode.supervisor('editor', {
      grants: [H.ops.workRead, H.ops.blockersResolve, H.ops.memoryRead, H.ops.memoryCurate, H.ops.telemetryRead],
    }),
  )
  .observers(markdown.board({ path: 'board.md' }));
