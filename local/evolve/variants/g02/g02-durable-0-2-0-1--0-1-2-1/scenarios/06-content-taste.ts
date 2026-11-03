import { z } from 'zod';
import { H, MetricRef, Resource } from 'harness-dsl';
import { sqlite } from 'harness-dsl/sqlite';
import { jsonl } from 'harness-dsl/jsonl';
import { anthropic } from 'harness-dsl/anthropic';
import { claudeCode } from 'harness-dsl/claude-code';
import { contentful } from 'harness-dsl/contentful';
import { local } from 'harness-dsl/local';
import { markdown } from 'harness-dsl/markdown';

const Section = z.enum(['news', 'sports', 'opinion']);
type Section = z.infer<typeof Section>;

const sections: Record<Section, Resource> = {
  news: H.resource('news'),
  sports: H.resource('sports'),
  opinion: H.resource('opinion'),
};

const DraftAttrs = z.object({ entryId: z.string(), title: z.string(), section: Section, body: z.string() });
type DraftAttrs = z.infer<typeof DraftAttrs>;

const Submitted = H.state('submitted', 'pending');
const Accepted = H.terminal('accepted', 'success');
const Returned = H.terminal('returned', 'neutral');
const ReviewFailed = H.terminal('review-failed', 'failure');

const Draft = H.kind('Draft')
  .attributes(DraftAttrs)
  .states(Submitted, Accepted, Returned, ReviewFailed)
  .key(attrs => attrs.entryId)
  .initial(Submitted);

const quota = sqlite.quota('newsroom-quota', { path: '.harness/quota.sqlite' });
const apiAccount = anthropic.account('newsroom-api', { apiKey: H.env('ANTHROPIC_API_KEY'), quota });
const opus = anthropic.model('opus', { id: 'claude-opus-4-1' });
const sonnet = anthropic.model('sonnet', { id: 'claude-sonnet-4-5' });
const haiku = anthropic.model('haiku', { id: 'claude-haiku-4-5' });
const apiPool = H.pool('newsroom-api').accounts(apiAccount);

const reviewerRole = H.role('reviewer')
  .intents('read')
  .instructions('Critique the draft against the house taste and the facts.');
const editorRole = H.role('editor')
  .intents('read', 'record')
  .instructions('Accept or return drafts; curate taste.');

const reviewerCandidates = [opus, sonnet, haiku];

const editorActedOnComparison = H.policy.model('editor-acted-on-comparison', reviewerCandidates, ctx => {
  const taken = ctx.assigned.map(assignment => assignment.model);
  const free = reviewerCandidates.filter(model => !taken.includes(model));
  const current = ctx.current;
  if (current === undefined || taken.includes(current)) return free[0] ?? opus;
  const own = ctx.metrics.rate(actedOn, { seat: ctx.seat, model: current, window: { lastDays: 90 } });
  if (own.samples < 50) return current;
  const weaker = ctx.peers.some(peer => {
    const rival = ctx.metrics.rate(actedOn, { seat: peer, window: { lastDays: 90 } });
    return rival.samples >= 50 && rival.rate > own.rate;
  });
  if (!weaker) return current;
  return free.find(model => model !== current) ?? current;
});

const Critique = z.object({ critique: z.string() });

const reviewerA = H.seat('reviewer-a')
  .role(reviewerRole)
  .model(editorActedOnComparison)
  .pool(apiPool)
  .output(Critique);

const reviewerB = H.seat('reviewer-b')
  .role(reviewerRole)
  .model(editorActedOnComparison)
  .pool(apiPool)
  .output(Critique);

const localRunner = local.runner('local');

const factCheck = H.command('fact-check')
  .input(z.object({ body: z.string() }))
  .argv(input => ['./tools/fact-check', input.body])
  .output(z.object({ repeatMistake: z.string().optional() }))
  .runner(localRunner);

const mergeCritiques = H.command('merge-critiques')
  .input(z.object({ a: z.string(), b: z.string() }))
  .argv(input => ['./tools/merge-critiques', input.a, input.b])
  .output(z.object({ merged: z.string() }))
  .runner(localRunner);

const editorial = H.halt('editorial').decision(
  z.object({
    action: z.enum(['accept', 'return']),
    notes: z.string(),
    actedOn: z.enum(['a', 'b', 'both', 'neither']),
  }),
);

const critiqueTask = (draft: DraftAttrs) => ({
  task: `Critique the ${draft.section} draft "${draft.title}":\n\n${draft.body}`,
  resources: [sections[draft.section]],
});

const reviewFlow = H.flow('review')
  .input(DraftAttrs)
  .step('critiqueA', reviewerA, ctx => critiqueTask(ctx.unit.attributes))
  .step('critiqueB', reviewerB, ctx => critiqueTask(ctx.unit.attributes))
  .step('factCheck', factCheck, ctx => ({ body: ctx.unit.attributes.body }))
  .step('merge', mergeCritiques, ctx => ({ a: ctx.steps.critiqueA.critique, b: ctx.steps.critiqueB.critique }))
  .halt('editorial', editorial, {
    ask: ctx => `Accept or return "${ctx.unit.attributes.title}"?\n\n${ctx.steps.merge.merged}`,
  })
  .exit('accepted', ctx => ctx.steps.editorial.action === 'accept')
  .exit('returned');

const contentStore = { space: 'newsroom', token: H.env('CONTENTFUL_TOKEN') };

const drafts = H.lane('drafts', Draft)
  .supply(contentful.drafts({ ...contentStore, everyMinutes: 10 }), (entry, to) => {
    const section = Section.safeParse(entry.section);
    return section.success
      ? to.create({ entryId: entry.id, title: entry.title, section: section.data, body: entry.body })
      : to.skip();
  })
  .handler(reviewFlow, { exits: { accepted: Accepted, returned: Returned } })
  .store(contentful.store(contentStore))
  .retry({ maxAttempts: 2, backoff: 'exponential', initialDelayMs: 300_000, exhausted: ReviewFailed });

const actedOn: MetricRef<'rate'> = H.metric('critique-acted-on', H.when.decision(Draft, editorial)).samples(event => [
  {
    hit: event.decision.actedOn === 'a' || event.decision.actedOn === 'both',
    seat: reviewerA,
    model: event.modelFor(reviewerA),
  },
  {
    hit: event.decision.actedOn === 'b' || event.decision.actedOn === 'both',
    seat: reviewerB,
    model: event.modelFor(reviewerB),
  },
]);

const editorTaste = H.journal('editor-taste', H.memory('editor-taste', 'taste'))
  .store(jsonl.memoryStore({ path: '.harness/taste.jsonl' }))
  .recall({ by: 'specificity', limit: 20 })
  .readBy(reviewerRole)
  .recordedBy(editorRole);

const factChecking = H.journal('fact-checking', H.memory('fact-checking', 'experience'))
  .store(jsonl.memoryStore({ path: '.harness/fact-checking.jsonl' }))
  .recall({ by: 'specificity', limit: 10 })
  .readBy(reviewerRole);

const returnedNotesBecomeTasteCandidates = H.trigger('returned-notes-become-taste-candidates')
  .on(H.when.decision(Draft, editorial))
  .record(editorTaste, event =>
    event.decision.action === 'return'
      ? {
          text: event.decision.notes,
          when: { roles: [reviewerRole], resources: [sections[event.unit.attributes.section]] },
          status: 'candidate',
        }
      : undefined,
  );

const repeatMistakesBecomeExperience = H.trigger('repeat-mistakes-become-experience')
  .on(H.when.step(drafts, 'factCheck'))
  .record(factChecking, event => {
    const mistake = event.output?.repeatMistake;
    return mistake === undefined ? undefined : { text: mistake, when: { roles: [reviewerRole] }, status: 'active' };
  });

const scheduler = H.scheduler('newsroom').standard(drafts);

const editorSupervisor = claudeCode.supervisor('editor-supervisor', {
  port: H.slot.port(0),
  grants: [
    H.ops.workRead,
    H.ops.resolve(editorial),
    H.ops.memoryRead,
    H.ops.memoryWrite,
    H.ops.memoryCurate,
    H.ops.telemetryRead,
  ],
});

export default H.harness('content-review')
  .ledger(sqlite.ledger({ path: '.harness/ledger.sqlite' }))
  .lanes(drafts)
  .journals(editorTaste, factChecking)
  .triggers(returnedNotesBecomeTasteCandidates, repeatMistakesBecomeExperience)
  .metrics(actedOn)
  .scheduler(scheduler)
  .clients(editorSupervisor)
  .observers(markdown.board({ path: 'BOARD.md' }), markdown.telemetry({ path: 'TELEMETRY.md' }));
