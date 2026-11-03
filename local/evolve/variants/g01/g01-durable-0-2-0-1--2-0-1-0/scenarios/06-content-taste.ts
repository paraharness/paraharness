import { z } from 'zod';
import { H, Resource } from 'harness-dsl';
import { anthropic } from 'harness-dsl/anthropic';
import { claudeCode } from 'harness-dsl/claude-code';
import { contentful } from 'harness-dsl/contentful';
import { sqlite } from 'harness-dsl/sqlite';
import { jsonl } from 'harness-dsl/jsonl';
import { local } from 'harness-dsl/local';
import { markdown } from 'harness-dsl/markdown';

const localRunner = local.runner('editorial-box').slots(4);

const sports = H.resource('sports');
const opinion = H.resource('opinion');
const sectionResources = (section: string): readonly Resource[] =>
  section === 'sports' ? [sports] : section === 'opinion' ? [opinion] : [];

const quota = sqlite.quota('editorial-quota', { path: '.harness/quota.sqlite' });
const apiAccount = anthropic.account('editorial-api', { apiKey: H.env('ANTHROPIC_API_KEY'), quota });
const api = H.pool('editorial-api').accounts(apiAccount);

const opus = anthropic.model('opus', { id: 'claude-opus-4-1' });
const sonnet = anthropic.model('sonnet', { id: 'claude-sonnet-4-5' });
const challenger = anthropic.model('sonnet-previous', { id: 'claude-sonnet-4-0' });

const reviewerRole = H.role('reviewer')
  .intents('read')
  .instructions('Critique the draft: structure, clarity, accuracy and house style. List concrete edits.');

const taste = H.memory('editor-taste', 'taste');
const factChecking = H.memory('fact-checking', 'experience');

const tasteJournal = H.journal('editor-taste', taste)
  .store(jsonl.memoryStore({ path: 'memory/taste.jsonl' }))
  .recall({ by: 'specificity', limit: 25 })
  .readBy(reviewerRole);

const factCheckJournal = H.journal('fact-checking', factChecking)
  .store(jsonl.memoryStore({ path: 'memory/fact-checking.jsonl' }))
  .recall({ by: 'specificity', limit: 10 })
  .readBy(reviewerRole);

const reviewerModels = H.policy.model('reviewer-models', [opus, sonnet, challenger], ({ seat, metrics }) => {
  const isA = seat.name === reviewerA.name;
  const window = { lastDays: 60 };
  const mine = metrics.rate(critiqueActedOn, { by: { seat }, window });
  const rival = metrics.rate(critiqueActedOn, { by: { seat: isA ? reviewerB : reviewerA }, window });
  const incumbent = isA ? opus : sonnet;
  return mine.samples >= 50 && rival.samples >= 50 && mine.rate < rival.rate ? challenger : incumbent;
});

const critique = z.object({ critique: z.string() });

const reviewerA = H.seat('reviewer-a').role(reviewerRole).model(reviewerModels).pool(api).output(critique);
const reviewerB = H.seat('reviewer-b').role(reviewerRole).model(reviewerModels).pool(api).output(critique);

const factCheck = H.command('fact-check')
  .input(z.object({ body: z.string() }))
  .argv((input) => ['./bin/fact-check', '--json', input.body])
  .output(z.object({ issues: z.array(z.string()), lesson: z.string().optional() }))
  .runner(localRunner);

const mergeCritiques = H.command('merge-critiques')
  .input(z.object({ a: z.string(), b: z.string(), issues: z.array(z.string()) }))
  .argv((input) => ['./bin/merge-critiques', input.a, input.b, input.issues.join('\n')])
  .output(z.object({ merged: z.string() }))
  .runner(localRunner);

const editorDecision = H.halt('editor-decision').decision(
  z.object({
    verdict: z.enum(['accept', 'return']),
    notes: z.string(),
    actedOn: z.array(z.enum(['A', 'B'])),
  }),
);

const draftSchema = z.object({ entryId: z.string(), title: z.string(), section: z.string(), body: z.string() });

const review = H.flow('review')
  .input(draftSchema)
  .step('critiqueA', reviewerA, (ctx) => ({
    task: `Critique the ${ctx.unit.attributes.section} draft "${ctx.unit.attributes.title}":\n${ctx.unit.attributes.body}`,
    resources: sectionResources(ctx.unit.attributes.section),
  }))
  .step('critiqueB', reviewerB, (ctx) => ({
    task: `Critique the ${ctx.unit.attributes.section} draft "${ctx.unit.attributes.title}":\n${ctx.unit.attributes.body}`,
    resources: sectionResources(ctx.unit.attributes.section),
  }))
  .step('factCheck', factCheck, (ctx) => ({ body: ctx.unit.attributes.body }))
  .step('merge', mergeCritiques, (ctx) => ({
    a: ctx.steps.critiqueA.critique,
    b: ctx.steps.critiqueB.critique,
    issues: ctx.steps.factCheck.issues,
  }))
  .halt('editorial', editorDecision, {
    ask: (ctx) => `Accept or return "${ctx.unit.attributes.title}". Merged critique:\n${ctx.steps.merge.merged}`,
  })
  .exit('accepted', (ctx) => ctx.steps.editorial.verdict === 'accept')
  .exit('returned');

const Submitted = H.state('Submitted', 'pending');
const Reviewing = H.state('Reviewing', 'active');
const WithEditor = H.state('WithEditor', 'waiting');
const Accepted = H.terminal('Accepted', 'success');
const Returned = H.terminal('Returned', 'neutral');
const ReviewFailed = H.terminal('ReviewFailed', 'failure');

const Draft = H.kind('Draft')
  .attributes(draftSchema)
  .states(Submitted, Reviewing, WithEditor, Accepted, Returned, ReviewFailed)
  .key((draft) => draft.entryId)
  .initial(Submitted);

const drafts = H.lane('drafts', Draft)
  .supply(contentful.drafts({ space: 'newsroom', token: H.env('CMS_TOKEN'), everyMinutes: 5 }), (entry, to) =>
    to.create({ entryId: entry.id, title: entry.title, section: entry.section, body: entry.body }),
  )
  .store(contentful.store({ space: 'newsroom', token: H.env('CMS_TOKEN') }))
  .handler(review, {
    exits: { accepted: Accepted, returned: Returned },
    during: {
      critiqueA: Reviewing,
      critiqueB: Reviewing,
      factCheck: Reviewing,
      merge: Reviewing,
      editorial: WithEditor,
    },
  })
  .retry({ maxAttempts: 2, backoff: 'exponential', initialDelayMs: 120_000, exhausted: ReviewFailed });

const critiqueActedOn = H.metric('critique-acted-on', H.when.decision(drafts, editorDecision)).samples((event) => [
  {
    hit: event.decision.actedOn.includes('A'),
    by: { seat: reviewerA, model: event.invocations.critiqueA?.model },
  },
  {
    hit: event.decision.actedOn.includes('B'),
    by: { seat: reviewerB, model: event.invocations.critiqueB?.model },
  },
]);

const returnedNotesBecomeTaste = H.trigger('returned-notes-become-taste-candidates')
  .on(H.when.decision(drafts, editorDecision))
  .record(tasteJournal, (event) =>
    event.decision.verdict === 'return' && event.decision.notes.length > 0
      ? {
          text: `When reviewing a ${event.unit.attributes.section} draft, check for this: ${event.decision.notes}, because the editor returned "${event.unit.attributes.title}" for it.`,
          status: 'candidate',
          when: {
            kinds: [Draft],
            roles: [reviewerRole],
            resources: sectionResources(event.unit.attributes.section),
          },
        }
      : undefined,
  );

const repeatMistakesBecomeExperience = H.trigger('repeat-mistakes-become-experience')
  .on(H.when.step(drafts, 'factCheck', { if: (event) => event.output?.lesson !== undefined }))
  .record(factCheckJournal, (event) => {
    const lesson = event.output?.lesson;
    return lesson === undefined
      ? undefined
      : {
          text: lesson,
          status: 'active',
          when: { kinds: [Draft], roles: [reviewerRole] },
        };
  });

const editor = claudeCode.supervisor('editor').client('editor-desk', {
  grants: [
    H.ops.workRead,
    H.ops.resolve(editorDecision),
    H.ops.memoryRead,
    H.ops.memoryWrite,
    H.ops.memoryCurate,
    H.ops.telemetryRead,
  ],
  port: H.slot.port(1),
});

export const harness = H.harness('content-review')
  .ledger(sqlite.ledger({ path: '.harness/ledger.sqlite' }))
  .lanes(drafts)
  .journals(tasteJournal, factCheckJournal)
  .triggers(returnedNotesBecomeTaste, repeatMistakesBecomeExperience)
  .metrics(critiqueActedOn)
  .scheduler(H.scheduler('editorial').priority(drafts).wip(drafts, 3))
  .clients(editor)
  .observers(markdown.board({ path: 'BOARD.md' }), markdown.telemetry({ path: 'TELEMETRY.md' }));

void harness.start();
