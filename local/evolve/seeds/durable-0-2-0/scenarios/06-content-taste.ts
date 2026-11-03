import { z } from 'zod';
import { H, MetricRef, Metrics, Model, Sample, Window } from 'harness-dsl';
import { sqlite } from 'harness-dsl/sqlite';
import { jsonl } from 'harness-dsl/jsonl';
import { anthropic } from 'harness-dsl/anthropic';
import { contentful } from 'harness-dsl/contentful';
import { claudeCode } from 'harness-dsl/claude-code';
import { local } from 'harness-dsl/local';
import { markdown } from 'harness-dsl/markdown';

const draftAttributes = z.object({
  entryId: z.string(),
  title: z.string(),
  section: z.string(),
  body: z.string(),
});

const Submitted = H.state('Submitted', 'pending');
const InReview = H.state('InReview', 'active');
const WithEditor = H.state('WithEditor', 'active');
const Accepted = H.terminal('Accepted', 'success');
const Returned = H.terminal('Returned', 'neutral');
const Withdrawn = H.terminal('Withdrawn', 'neutral');

const Draft = H.kind('Draft')
  .attributes(draftAttributes)
  .states(Submitted, InReview, WithEditor, Accepted, Returned, Withdrawn)
  .key(draft => draft.entryId)
  .initial(Submitted)
  .onCancelled(Withdrawn);

const reviewer = H.role('reviewer')
  .intents('read')
  .instructions('Critique the draft for structure, accuracy and voice. Cite the passages you object to.');

const tasteKind = H.memory('editorial-taste', 'taste');
const factLessonKind = H.memory('fact-check-lesson', 'experience');

const taste = H.journal('taste', tasteKind)
  .store(jsonl.memoryStore({ path: '.harness/taste.jsonl' }))
  .recall({ by: 'specificity', limit: 15 })
  .readBy(reviewer);

const factLessons = H.journal('fact-lessons', factLessonKind)
  .store(jsonl.memoryStore({ path: '.harness/fact-lessons.jsonl' }))
  .recall({ by: 'specificity', limit: 10 })
  .readBy(reviewer);

const apiAccount = anthropic.account('api', { apiKey: H.env('ANTHROPIC_API_KEY') });
const reviewers = H.pool('reviewers').accounts(apiAccount);

const firstIncumbent = anthropic.model('opus', { id: 'claude-opus-4-1' });
const secondIncumbent = anthropic.model('sonnet', { id: 'claude-sonnet-4-5' });
const challenger = anthropic.model('haiku', { id: 'claude-haiku-4-5' });

const comparisonWindow: Window = { lastDays: 90 };

function weakerIncumbent(metrics: Metrics): string | undefined {
  const first = metrics.rate(critiqueActedOn, { group: firstIncumbent.name, window: comparisonWindow });
  const second = metrics.rate(critiqueActedOn, { group: secondIncumbent.name, window: comparisonWindow });
  if (first.samples < 50 || second.samples < 50 || first.rate === second.rate) return undefined;
  return first.rate < second.rate ? firstIncumbent.name : secondIncumbent.name;
}

const firstSlot = H.policy.model(
  'first-reviewer-model',
  [firstIncumbent, challenger],
  (ctx): Model => (weakerIncumbent(ctx.metrics) === firstIncumbent.name ? challenger : firstIncumbent),
);

const secondSlot = H.policy.model(
  'second-reviewer-model',
  [secondIncumbent, challenger],
  (ctx): Model => (weakerIncumbent(ctx.metrics) === secondIncumbent.name ? challenger : secondIncumbent),
);

const critique = z.object({
  critique: z.string(),
  points: z.array(z.string()),
});

const reviewerFirst = H.agent('reviewer-first').role(reviewer).model(firstSlot).pool(reviewers).output(critique);
const reviewerSecond = H.agent('reviewer-second').role(reviewer).model(secondSlot).pool(reviewers).output(critique);

const desk = local.runner('editorial-desk').slots(4);

const factFindings = z.object({
  issues: z.array(z.string()),
  repeatLesson: z.string().optional(),
});

const factCheck = H.command('fact-check')
  .input(z.object({ section: z.string(), body: z.string() }))
  .argv(input => ['fact-check', '--section', input.section, '--text', input.body])
  .output(factFindings)
  .runner(desk);

const mergeCritiques = H.command('merge-critiques')
  .input(z.object({ first: critique, second: critique, facts: factFindings }))
  .argv(input => ['merge-critiques', '--json', JSON.stringify(input)])
  .output(z.object({ summary: z.string() }))
  .runner(desk);

const editorialDecision = z.object({
  action: z.enum(['accept', 'return']),
  notes: z.string(),
  scope: z.enum(['all', 'section']),
  actedOn: z.array(z.enum(['first', 'second'])),
});

const reviewFlow = H.flow('review-draft')
  .input(draftAttributes)
  .step('critiqueFirst', reviewerFirst, ctx => ({
    task: `Critique "${ctx.unit.attributes.title}":\n\n${ctx.unit.attributes.body}`,
    resources: [`section/${ctx.unit.attributes.section}`],
  }))
  .step('critiqueSecond', reviewerSecond, ctx => ({
    task: `Critique "${ctx.unit.attributes.title}":\n\n${ctx.unit.attributes.body}`,
    resources: [`section/${ctx.unit.attributes.section}`],
  }))
  .step('factCheck', factCheck, ctx => ({ section: ctx.unit.attributes.section, body: ctx.unit.attributes.body }))
  .step('merge', mergeCritiques, ctx => ({
    first: ctx.steps.critiqueFirst,
    second: ctx.steps.critiqueSecond,
    facts: ctx.steps.factCheck,
  }))
  .halt('editorial', {
    ask: ctx => `Accept or return "${ctx.unit.attributes.title}" (${ctx.unit.attributes.section}).\n\n${ctx.steps.merge.summary}`,
    decision: editorialDecision,
  })
  .exit('accepted', ctx => ctx.steps.editorial.action === 'accept')
  .exit('returned');

const cmsToken = H.env('CONTENTFUL_TOKEN');

const drafts = H.lane('drafts', Draft)
  .supply(contentful.drafts({ space: 'newsroom', token: cmsToken, everyMinutes: 10 }), (entry, to) =>
    to.create({ entryId: entry.id, title: entry.title, section: entry.section, body: entry.body }),
  )
  .store(contentful.store({ space: 'newsroom', token: cmsToken }))
  .handler(reviewFlow, {
    exits: { accepted: Accepted, returned: Returned },
    during: {
      critiqueFirst: InReview,
      critiqueSecond: InReview,
      factCheck: InReview,
      merge: InReview,
      editorial: WithEditor,
    },
  });

const critiqueActedOn: MetricRef<'rate'> = H.metric('critique-acted-on', H.when.step(drafts, 'editorial')).samples(
  event => {
    const decision = event.output;
    if (decision === undefined) return [];
    const samples: Sample[] = [];
    const firstModel = event.models.critiqueFirst;
    const secondModel = event.models.critiqueSecond;
    if (firstModel !== undefined) samples.push({ group: firstModel, hit: decision.actedOn.includes('first') });
    if (secondModel !== undefined) samples.push({ group: secondModel, hit: decision.actedOn.includes('second') });
    return samples;
  },
);

const editorNotesToTaste = H.trigger('editor-notes-to-taste')
  .on(H.when.step(drafts, 'editorial', { if: event => event.output?.action === 'return' }))
  .record(taste, event => {
    const decision = event.output;
    if (decision === undefined || decision.notes === '') return undefined;
    const section = event.unit.attributes.section;
    return {
      text: `When reviewing a draft, ${decision.notes}, because the editor returned "${event.unit.attributes.title}" for it.`,
      status: 'candidate',
      when: decision.scope === 'section' ? { kinds: [Draft], resources: [`section/${section}`] } : { kinds: [Draft] },
    };
  });

const repeatMistakeToExperience = H.trigger('repeat-mistake-to-experience')
  .on(H.when.step(drafts, 'factCheck', { if: event => event.output?.repeatLesson !== undefined }))
  .record(factLessons, event => {
    const lesson = event.output?.repeatLesson;
    return lesson === undefined ? undefined : { text: lesson, when: { kinds: [Draft], roles: [reviewer] } };
  });

const editorDesk = claudeCode.supervisor('editor-desk', {
  grants: [
    H.ops.workRead,
    H.ops.blockersResolve,
    H.ops.memoryRead,
    H.ops.memoryWrite,
    H.ops.memoryCurate,
    H.ops.telemetryRead,
  ],
});

const content = H.harness('content-review')
  .ledger(sqlite.ledger({ path: '.harness/ledger.sqlite' }))
  .lanes(drafts)
  .journals(taste, factLessons)
  .triggers(editorNotesToTaste, repeatMistakeToExperience)
  .metrics(critiqueActedOn)
  .scheduler(H.scheduler('content').priority(drafts))
  .clients(editorDesk)
  .observers(markdown.board({ path: '.harness/board.md' }), markdown.telemetry({ path: '.harness/telemetry.md' }));

void content.start();
