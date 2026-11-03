import { z } from 'zod';
import { H, Metrics, Model, Sample } from 'harness-dsl';
import { anthropic } from 'harness-dsl/anthropic';
import { contentful } from 'harness-dsl/contentful';
import { jsonl } from 'harness-dsl/jsonl';
import { sqlite } from 'harness-dsl/sqlite';
import { local } from 'harness-dsl/local';
import { claudeCode } from 'harness-dsl/claude-code';
import { markdown } from 'harness-dsl/markdown';

const draftSchema = z.object({
  entryId: z.string(),
  title: z.string(),
  section: z.string(),
  body: z.string(),
});
type DraftAttributes = z.infer<typeof draftSchema>;

const Queued = H.state('Queued', 'pending');
const Reviewing = H.state('Reviewing', 'active');
const Merging = H.state('Merging', 'active');
const WithEditor = H.state('WithEditor', 'waiting');
const Accepted = H.terminal('Accepted', 'success');
const Returned = H.terminal('Returned', 'neutral');
const Withdrawn = H.terminal('Withdrawn', 'neutral');

const Draft = H.kind('Draft')
  .attributes(draftSchema)
  .states(Queued, Reviewing, Merging, WithEditor, Accepted, Returned, Withdrawn)
  .key(draft => draft.entryId)
  .initial(Queued)
  .onCancelled(Withdrawn);

const reviewer = H.role('reviewer')
  .intents('read')
  .instructions('Critique the draft for argument, accuracy and house style. Cite the passage for every point.');

const editorialTaste = H.memory('editorial-taste').trust('taste');
const factCheckLesson = H.memory('fact-check-lesson').trust('experience');

const recallByScope = H.recall('editorial-recall', { by: 'specificity', limit: 12 });

const tasteJournal = H.journal('editorial-taste', editorialTaste)
  .store(jsonl.memoryStore({ path: 'memory/editorial-taste.jsonl' }))
  .recall(recallByScope)
  .readBy(reviewer);

const factLessons = H.journal('fact-check-lessons', factCheckLesson)
  .store(jsonl.memoryStore({ path: 'memory/fact-check-lessons.jsonl' }))
  .recall(recallByScope)
  .readBy(reviewer);

const editorialAccount = anthropic.account('editorial-api', { apiKey: H.env('ANTHROPIC_API_KEY') });
const opus = anthropic.model('opus', { id: 'claude-opus-4-1' });
const sonnet = anthropic.model('sonnet', { id: 'claude-sonnet-4-5' });
const haiku = anthropic.model('haiku', { id: 'claude-haiku-4-5' });

const editorialPool = H.pool('editorial-api')
  .accounts(editorialAccount)
  .serves(opus, sonnet, haiku);

const reviewerModels: readonly Model[] = [opus, sonnet, haiku];
const settledAfterSamples = 50;

function reviewerSlots(metrics: Metrics): readonly Model[] {
  const standings = reviewerModels.map((model, order) => {
    const acted = metrics.rate(editorActedOn, { group: model.name });
    return { model, order, rate: acted.rate, samples: acted.samples };
  });
  const settled = standings
    .filter(standing => standing.samples >= settledAfterSamples)
    .sort((a, b) => b.rate - a.rate || a.order - b.order);
  const onTrial = standings.filter(standing => standing.samples < settledAfterSamples);
  return [...settled.slice(0, 1), ...onTrial, ...settled.slice(1)].map(standing => standing.model);
}

const reviewerAModel = H.policy.model('reviewer-a-model', reviewerModels, ctx => reviewerSlots(ctx.metrics)[0] ?? opus);
const reviewerBModel = H.policy.model('reviewer-b-model', reviewerModels, ctx => reviewerSlots(ctx.metrics)[1] ?? sonnet);

const critiqueSchema = z.object({
  points: z.array(z.string()),
  severity: z.enum(['minor', 'major']),
});

const reviewerA = H.agent('reviewer-a').role(reviewer).model(reviewerAModel).output(critiqueSchema);
const reviewerB = H.agent('reviewer-b').role(reviewer).model(reviewerBModel).output(critiqueSchema);

const critiqueTask = (draft: DraftAttributes) => ({
  task: `Critique the draft "${draft.title}" for the ${draft.section} section:\n\n${draft.body}`,
  resources: [`section:${draft.section}`],
});

const editorialRunner = local.runner('editorial');

const factCheck = H.command('fact-check')
  .input(z.object({ entryId: z.string() }))
  .argv(input => ['fact-check', '--entry', input.entryId])
  .output(z.object({ issues: z.number(), repeatLesson: z.string().optional() }))
  .runner(editorialRunner);

const mergeCritiques = H.command('merge-critiques')
  .input(z.object({ a: critiqueSchema, b: critiqueSchema }))
  .argv(input => ['merge-critiques', JSON.stringify(input.a), JSON.stringify(input.b)])
  .output(z.object({ merged: z.string() }))
  .runner(editorialRunner);

const editorDecision = H.signal('editorDecision').payload(z.object({
  verdict: z.enum(['accept', 'return']),
  notes: z.string(),
  actedOn: z.array(z.enum(['reviewerA', 'reviewerB'])),
  notesApplyTo: z.enum(['allDrafts', 'section']),
}));

const reviewFlow = H.flow('draft-review')
  .input(draftSchema)
  .step('reviewA', reviewerA, ctx => critiqueTask(ctx.unit.attributes))
  .step('reviewB', reviewerB, ctx => critiqueTask(ctx.unit.attributes))
  .step('factCheck', factCheck, ctx => ({ entryId: ctx.unit.attributes.entryId }))
  .step('merge', mergeCritiques, ctx => ({ a: ctx.steps.reviewA, b: ctx.steps.reviewB }))
  .await('editorDecision', editorDecision, {
    ask: ctx => `Accept or return "${ctx.unit.attributes.title}"? Fact-check issues: ${ctx.steps.factCheck.issues}.\n\n${ctx.steps.merge.merged}`,
  })
  .exit('accepted', ctx => ctx.steps.editorDecision.verdict === 'accept')
  .exit('returned');

const contentfulToken = H.env('CONTENTFUL_TOKEN');

const drafts = H.lane('drafts', Draft)
  .supply(
    contentful.drafts({ space: 'newsroom', token: contentfulToken, everyMinutes: 10 }),
    (entry, to) => to.create({ entryId: entry.id, title: entry.title, section: entry.section, body: entry.body }),
  )
  .store(contentful.store({ space: 'newsroom', token: contentfulToken }))
  .handler(reviewFlow, {
    exits: { accepted: Accepted, returned: Returned },
    during: {
      reviewA: Reviewing,
      reviewB: Reviewing,
      factCheck: Reviewing,
      merge: Merging,
      editorDecision: WithEditor,
    },
  });

const editorActedOn = H.metric('editor-acted-on')
  .from(H.when.step(drafts, 'editorDecision'))
  .samples(event => {
    const decision = event.output;
    if (decision === undefined || event.auto) return [];
    const samples: Sample[] = [];
    const modelA = event.models.reviewA;
    const modelB = event.models.reviewB;
    if (modelA !== undefined) samples.push({ group: modelA, hit: decision.actedOn.includes('reviewerA') });
    if (modelB !== undefined) samples.push({ group: modelB, hit: decision.actedOn.includes('reviewerB') });
    return samples;
  });

const returnedNotesToTaste = H.trigger('returned-notes-to-taste')
  .on(H.when.step(drafts, 'editorDecision', { if: event => event.output?.verdict === 'return' }))
  .record(tasteJournal, event => {
    const decision = event.output;
    if (decision === undefined || decision.notes.trim() === '') return undefined;
    return {
      body: { text: decision.notes },
      when: decision.notesApplyTo === 'section'
        ? { kinds: [Draft], resources: [`section:${event.unit.attributes.section}`] }
        : { kinds: [Draft] },
      status: 'candidate',
    };
  });

const repeatMistakeToExperience = H.trigger('repeat-mistake-to-experience')
  .on(H.when.step(drafts, 'factCheck', { if: event => event.output?.repeatLesson !== undefined }))
  .record(factLessons, event => {
    const lesson = event.output?.repeatLesson;
    return lesson ? { body: { text: lesson }, when: { kinds: [Draft], roles: [reviewer] } } : undefined;
  });

const editorDesk = claudeCode.supervisor('editor-desk', {
  grants: [
    H.ops.workRead,
    H.ops.send(editorDecision, { lanes: [drafts] }),
    H.ops.send(H.cancel, { lanes: [drafts] }),
    H.ops.memoryRead,
    H.ops.memoryWrite,
    H.ops.memoryCurate,
    H.ops.telemetryRead,
  ],
});

export const harness = H.harness('content-review')
  .ledger(sqlite.ledger({ path: 'state/ledger.sqlite' }))
  .pools(editorialPool)
  .lanes(drafts)
  .journals(tasteJournal, factLessons)
  .triggers(returnedNotesToTaste, repeatMistakeToExperience)
  .metrics(editorActedOn)
  .scheduler(H.scheduler('editorial').priority(drafts).wip(drafts, 4))
  .clients(editorDesk)
  .observers(markdown.board({ path: 'BOARD.md' }), markdown.telemetry({ path: 'TELEMETRY.md' }));

export const running = harness.start();
