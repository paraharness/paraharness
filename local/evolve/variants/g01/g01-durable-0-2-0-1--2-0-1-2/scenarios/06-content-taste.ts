import { z } from 'zod';
import { H, AgentTask, Assignment, Model, ModelPolicy, SeatRef } from 'harness-dsl';
import { sqlite } from 'harness-dsl/sqlite';
import { jsonl } from 'harness-dsl/jsonl';
import { anthropic } from 'harness-dsl/anthropic';
import { claudeCode } from 'harness-dsl/claude-code';
import { contentful } from 'harness-dsl/contentful';
import { local } from 'harness-dsl/local';
import { markdown } from 'harness-dsl/markdown';

const quota = sqlite.quota('content-quota', { path: './state/quota.sqlite' });
const apiAccount = anthropic.account('content-api', { apiKey: H.env('ANTHROPIC_API_KEY'), quota });
const reviewPool = H.pool('content-api').accounts(apiAccount);

const opus = anthropic.model('opus', { id: 'claude-opus-4-1' });
const sonnet = anthropic.model('sonnet', { id: 'claude-sonnet-4' });
const challenger = anthropic.model('challenger', { id: 'claude-sonnet-4-5' });

const sports = H.resource('sports');
const opinion = H.resource('opinion');
const sectionsOf = (section: string) => [sports, opinion].filter(resource => resource.name === section);

const Draft = z.object({ entryId: z.string(), title: z.string(), section: z.string(), body: z.string() });
type DraftAttrs = z.infer<typeof Draft>;

const InReview = H.state('InReview', 'pending');
const NeedsAttention = H.state('NeedsAttention', 'waiting');
const Accepted = H.terminal('Accepted', 'success');
const Returned = H.terminal('Returned', 'neutral');

const draftKind = H.kind('Draft')
  .attributes(Draft)
  .states(InReview, NeedsAttention, Accepted, Returned)
  .key(attrs => attrs.entryId)
  .initial(InReview);

const reviewerRole = H.role('reviewer').intents('read').instructions('Critique the draft: list concrete, actionable points.');
const editorRole = H.role('editor');

const modelOf = (seats: readonly Assignment[], seat: SeatRef) =>
  seats.find(assignment => assignment.seat.name === seat.name)?.model;

const reviewerModel = (name: string, incumbent: Model, replacement: Model, rival: () => SeatRef): ModelPolicy =>
  H.policy.model(name, [incumbent, replacement], ctx => {
    const mine = ctx.metrics.rate(editorActedOn, { seat: ctx.seat, model: incumbent });
    const theirs = ctx.metrics.rate(editorActedOn, { seat: rival() });
    return mine.samples >= 50 && theirs.samples >= 50 && mine.rate < theirs.rate ? replacement : incumbent;
  });

const reviewerA = H.seat('reviewer-a')
  .role(reviewerRole)
  .model(reviewerModel('reviewer-a-model', opus, challenger, (): SeatRef => reviewerB))
  .pool(reviewPool)
  .output(z.object({ points: z.array(z.string()) }));

const reviewerB = H.seat('reviewer-b')
  .role(reviewerRole)
  .model(reviewerModel('reviewer-b-model', sonnet, challenger, (): SeatRef => reviewerA))
  .pool(reviewPool)
  .output(z.object({ points: z.array(z.string()) }));

const localRunner = local.runner('local').slots(4);

const factCheck = H.command('fact-check')
  .input(z.object({ entryId: z.string(), body: z.string() }))
  .argv(input => ['./bin/fact-check', input.entryId, input.body])
  .output(z.object({ repeatMistake: z.string().nullable() }))
  .runner(localRunner);

const mergeCritiques = H.command('merge-critiques')
  .input(z.object({ a: z.array(z.string()), b: z.array(z.string()) }))
  .argv(input => ['./bin/merge-critiques', JSON.stringify(input)])
  .output(z.object({ digest: z.string() }))
  .runner(localRunner);

const editorDecision = H.halt('editorial-decision').decision(
  z.object({
    action: z.enum(['accept', 'return']),
    notes: z.string(),
    actedOn: z.enum(['a', 'b', 'both', 'neither']),
  }),
);

const reviewTask = (draft: DraftAttrs): AgentTask => ({
  task: `Critique the ${draft.section} draft "${draft.title}":\n\n${draft.body}`,
  resources: sectionsOf(draft.section),
});

const review = H.flow('review')
  .input(Draft)
  .step('critiqueA', reviewerA, ctx => reviewTask(ctx.unit.attributes))
  .step('critiqueB', reviewerB, ctx => reviewTask(ctx.unit.attributes))
  .step('factCheck', factCheck, ctx => ({ entryId: ctx.unit.attributes.entryId, body: ctx.unit.attributes.body }))
  .step('merge', mergeCritiques, ctx => ({ a: ctx.steps.critiqueA.points, b: ctx.steps.critiqueB.points }))
  .halt('editorial', editorDecision, {
    ask: ctx => `Accept or return "${ctx.unit.attributes.title}"? Mark which reviewer's points you acted on.\n\n${ctx.steps.merge.digest}`,
  })
  .exit('accepted', ctx => ctx.steps.editorial.action === 'accept')
  .exit('returned');

const draftLane = H.lane('drafts', draftKind)
  .handler(review, { exits: { accepted: Accepted, returned: Returned } })
  .store(contentful.store({ space: 'newsroom', token: H.env('CONTENTFUL_TOKEN') }))
  .retry({ maxAttempts: 2, backoff: 'exponential', initialDelayMs: 120_000, exhausted: NeedsAttention })
  .supply(contentful.drafts({ space: 'newsroom', token: H.env('CONTENTFUL_TOKEN'), everyMinutes: 5 }), (entry, to) =>
    to.create({ entryId: entry.id, title: entry.title, section: entry.section, body: entry.body }),
  );

const editorActedOn = H.metric('editor-acted-on', H.when.decision(draftKind, editorDecision)).samples(event => [
  {
    hit: event.decision.actedOn === 'a' || event.decision.actedOn === 'both',
    seat: reviewerA,
    model: modelOf(event.seats, reviewerA),
  },
  {
    hit: event.decision.actedOn === 'b' || event.decision.actedOn === 'both',
    seat: reviewerB,
    model: modelOf(event.seats, reviewerB),
  },
]);

const taste = H.journal('editor-taste', H.memory('editor-taste', 'taste'))
  .store(jsonl.memoryStore({ path: './memory/taste.jsonl' }))
  .recall({ by: 'specificity', limit: 15 })
  .readBy(reviewerRole)
  .recordedBy(editorRole);

const factLessons = H.journal('fact-check-lessons', H.memory('fact-check-lessons', 'experience'))
  .store(jsonl.memoryStore({ path: './memory/fact-check.jsonl' }))
  .recall({ by: 'specificity', limit: 8 })
  .readBy(reviewerRole);

const returnedNotesBecomeTaste = H.trigger('returned-notes-become-taste')
  .on(H.when.decision(draftKind, editorDecision))
  .record(taste, event =>
    event.decision.action === 'return'
      ? {
          text: `When reviewing a draft, ${event.decision.notes}, because the editor returned "${event.unit.attributes.title}" for it`,
          status: 'candidate',
          when: { roles: [reviewerRole], resources: sectionsOf(event.unit.attributes.section) },
        }
      : undefined,
  );

const repeatMistakeBecomesLesson = H.trigger('repeat-mistake-becomes-lesson')
  .on(H.when.step(draftLane, 'factCheck', { if: event => (event.output?.repeatMistake ?? null) !== null }))
  .record(factLessons, event => {
    const mistake = event.output?.repeatMistake;
    return mistake
      ? {
          text: `When a draft makes a claim like "${mistake}", verify it against a primary source, because the fact check caught it again in "${event.unit.attributes.title}"`,
          when: { roles: [reviewerRole] },
        }
      : undefined;
  });

const scheduler = H.scheduler('content').standard(draftLane).wip(draftLane, 3);

const supervisor = claudeCode.supervisor('editor-desk', {
  port: H.slot.port(0),
  grants: [
    H.ops.workRead,
    H.ops.attemptsRecover,
    H.ops.resolve(editorDecision),
    H.ops.memoryRead,
    H.ops.memoryWrite,
    H.ops.memoryCurate,
    H.ops.telemetryRead,
  ],
});

export default H.harness('content-review')
  .ledger(sqlite.ledger({ path: './state/ledger.sqlite' }))
  .lanes(draftLane)
  .journals(taste, factLessons)
  .triggers(returnedNotesBecomeTaste, repeatMistakeBecomesLesson)
  .metrics(editorActedOn)
  .scheduler(scheduler)
  .clients(supervisor)
  .observers(markdown.board({ path: './BOARD.md' }), markdown.telemetry({ path: './TELEMETRY.md' }));
