import { H } from 'harness-dsl';
import type { Metrics, SupplyOf } from 'harness-dsl';
import { z } from 'zod';
import * as anthropic from 'harness-dsl/anthropic';
import * as sqlite from 'harness-dsl/sqlite';
import * as shell from 'harness-dsl/shell';
import * as http from 'harness-dsl/http';
import * as markdown from 'harness-dsl/markdown';

const haiku = anthropic.model('claude-haiku-4-5');
const sonnet = anthropic.model('claude-sonnet-4-5');
const api = anthropic.account('anthropic-api', { apiKey: H.env('ANTHROPIC_API_KEY') });

const local = shell.local('local', { slots: 4 });

const stalled = H.state('stalled', 'waiting');

const scheduled = H.state('scheduled', 'pending');
const observing = H.state('observing', 'waiting');
const aWins = H.state('aWins', 'terminal', 'success');
const bWins = H.state('bWins', 'terminal', 'success');
const inconclusive = H.state('inconclusive', 'terminal', 'neutral');

const experiment = H.kind('Experiment')
  .data(z.object({ name: z.string(), metric: z.string(), hours: z.number() }))
  .states(scheduled, observing, aWins, bWins, inconclusive, stalled);

const sampleMetric = H.command('sample-experiment-metric')
  .input(z.object({ experiment: z.string(), metric: z.string() }))
  .output(z.object({ a: z.number(), b: z.number() }))
  .argv(input => ['experiments', 'sample', input.experiment, input.metric])
  .on(local)
  .recovery('rerun');

const concludeExperiment = H.command('conclude-experiment')
  .input(z.object({ experiment: z.string() }))
  .output(z.object({ winner: z.enum(['a', 'b', 'none']) }))
  .argv(input => ['experiments', 'conclude', input.experiment])
  .on(local)
  .recovery('rerun');

const runExperiment = H.flow('run-experiment').for(experiment).does(async ctx => {
  for (let hour = 0; hour < ctx.unit.data.hours; hour++) {
    const sample = await ctx.run(sampleMetric, { experiment: ctx.unit.data.name, metric: ctx.unit.data.metric });
    if (!sample.ok) return ctx.fail(sample.error);
    await ctx.suspend('observing', { at: new Date(ctx.now().getTime() + 3_600_000) });
  }
  const verdict = await ctx.run(concludeExperiment, { experiment: ctx.unit.data.name });
  if (!verdict.ok) return ctx.fail(verdict.error);
  return verdict.value.winner === 'a' ? 'aWins' : verdict.value.winner === 'b' ? 'bWins' : 'inconclusive';
});

const experiments = H.lane('experiments', experiment)
  .handler(runExperiment)
  .attempts(3, { backoff: { first: { minutes: 15 }, factor: 2 }, exhausted: 'stalled' })
  .suppliers(H.operator)
  .store(sqlite.store(experiment, '.harness/experiments.db'));

export const inconclusiveShare = H.policy.rule('experiment-inconclusive-share', (window: { readonly days: number }, metrics: Metrics) =>
  metrics.rate({
    among: { entry: 'transition', kind: experiment, position: 'terminal' },
    count: { entry: 'transition', kind: experiment, state: 'inconclusive' },
    days: window.days,
  })
);

const reviewDue = H.state('reviewDue', 'pending');
const between = H.state('between', 'waiting');
const suspended = H.state('suspended', 'waiting');
const churned = H.state('churned', 'terminal', 'neutral');

const tenancy = H.kind('Tenancy')
  .data(z.object({ customer: z.string(), nextReviewAt: z.string(), lastDecision: z.enum(['upsell', 'hold']).optional() }))
  .states(reviewDue, between, suspended, churned);

const dueForReview = (key: string): SupplyOf<typeof tenancy> => ({ update: key, state: 'reviewDue' });

const reviewClock = H.schedule('tenancy-review-clock', tenancy, { daily: '03:00' }, tick =>
  tick.units
    .filter(unit => unit.state === 'between' && new Date(unit.data.nextReviewAt).getTime() <= tick.now.getTime())
    .map(unit => dueForReview(unit.key))
);

const usageReport = H.command('tenancy-usage-report')
  .input(z.object({ customer: z.string() }))
  .argv(input => ['billing', 'usage', '--customer', input.customer, '--last-month'])
  .on(local)
  .recovery('rerun');

const summarizingAccount = H.role('account-summarizer')
  .input(z.object({ customer: z.string(), usage: z.string() }))
  .output(z.object({ summary: z.string() }))
  .prompt(input => `Summarize last month for ${input.customer} and note upsell signals:\n${input.usage}`);

const accountSummarizer = H.seat('account-summarizer', summarizingAccount).model(haiku);

const upsellDecision = H.halt('upsell-decision', z.object({ upsell: z.boolean(), note: z.string().optional() }));

const nextMonth = (from: Date): Date => new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth() + 1, from.getUTCDate()));

const reviewTenancy = H.flow('review-tenancy').for(tenancy).does(async ctx => {
  const usage = await ctx.run(usageReport, { customer: ctx.unit.data.customer });
  if (!usage.ok) return ctx.fail(usage.error);
  const summary = await ctx.run(accountSummarizer, { customer: ctx.unit.data.customer, usage: usage.value });
  if (!summary.ok) return ctx.fail(summary.error);
  const decision = await ctx.halt(upsellDecision, summary.value.summary);
  await ctx.update({ nextReviewAt: nextMonth(ctx.now()).toISOString(), lastDecision: decision.upsell ? 'upsell' : 'hold' });
  return 'between';
});

const tenancies = H.lane('tenancies', tenancy)
  .handler(reviewTenancy)
  .attempts(2, { exhausted: 'between' })
  .suppliers(reviewClock, H.operator)
  .store(sqlite.store(tenancy, '.harness/tenancies.db'));

const ourTurn = H.state('ourTurn', 'pending');
const theirTurn = H.state('theirTurn', 'waiting');
const agreed = H.state('agreed', 'terminal', 'success');
const walkedAwayByUs = H.state('walkedAwayByUs', 'terminal', 'neutral');
const walkedAwayByThem = H.state('walkedAwayByThem', 'terminal', 'neutral');
const expired = H.state('expired', 'terminal', 'neutral');

const negotiation = H.kind('Negotiation')
  .data(z.object({
    vendor: z.string(),
    item: z.string(),
    expiresAt: z.string(),
    lastVendorMessage: z.string().optional(),
    ourLastOffer: z.string().optional(),
  }))
  .states(ourTurn, theirTurn, agreed, walkedAwayByUs, walkedAwayByThem, expired, stalled);

const vendorReply = (key: string, status: 'counter' | 'accepted' | 'walked', message: string): SupplyOf<typeof negotiation> =>
  status === 'accepted'
    ? { update: key, patch: { lastVendorMessage: message }, state: 'agreed' }
    : status === 'walked'
      ? { update: key, patch: { lastVendorMessage: message }, state: 'walkedAwayByThem' }
      : { update: key, patch: { lastVendorMessage: message }, state: 'ourTurn' };

const vendorReplies = http.webhook(negotiation, {
  path: '/vendor-replies',
  secret: H.env('VENDOR_WEBHOOK_SECRET'),
  body: z.object({ negotiation: z.string(), status: z.enum(['counter', 'accepted', 'walked']), message: z.string() }),
  read: reply => vendorReply(reply.negotiation, reply.status, reply.message),
});

const negotiating = H.role('negotiator')
  .input(z.object({ vendor: z.string(), item: z.string(), vendorMessage: z.string(), ourLastOffer: z.string() }))
  .output(z.object({ action: z.enum(['offer', 'accept', 'walkAway']), offer: z.string() }))
  .prompt(input => `Negotiate ${input.item} with ${input.vendor}. Our last offer: ${input.ourLastOffer}. Their message: ${input.vendorMessage}`);

const negotiator = H.seat('negotiator', negotiating).model(sonnet);

const sendOffer = H.command('send-offer')
  .input(z.object({ vendor: z.string(), text: z.string() }))
  .argv(input => ['procurement', 'send', '--vendor', input.vendor, '--text', input.text])
  .on(local)
  .recovery('park');

const negotiateRound = H.flow('negotiate-round').for(negotiation).does(async ctx => {
  const next = await ctx.run(negotiator, {
    vendor: ctx.unit.data.vendor,
    item: ctx.unit.data.item,
    vendorMessage: ctx.unit.data.lastVendorMessage ?? '',
    ourLastOffer: ctx.unit.data.ourLastOffer ?? '',
  });
  if (!next.ok) return ctx.fail(next.error);
  if (next.value.action === 'walkAway') return 'walkedAwayByUs';
  const sent = await ctx.run(sendOffer, { vendor: ctx.unit.data.vendor, text: next.value.offer });
  if (!sent.ok) return ctx.fail(sent.error);
  await ctx.update({ ourLastOffer: next.value.offer });
  return next.value.action === 'accept' ? 'agreed' : 'theirTurn';
});

const negotiations = H.lane('negotiations', negotiation)
  .handler(negotiateRound)
  .attempts(3, { backoff: { first: { minutes: 30 } }, exhausted: 'stalled' })
  .suppliers(H.operator, vendorReplies)
  .store(sqlite.store(negotiation, '.harness/negotiations.db'));

const negotiationExpiry = H.trigger(
  'negotiation-expiry',
  H.on.deadline(negotiation, data => new Date(data.expiresAt), ['ourTurn', 'theirTurn', 'stalled']),
  (_event, act) => act.move('expired')
);

export const business = H.harness('business-lifecycles')
  .ledger(sqlite.ledger('.harness/ledger.db'))
  .lanes(experiments, tenancies, negotiations)
  .pools(H.pool('api', [{ account: api, share: 1, serves: [haiku, sonnet] }]))
  .triggers(negotiationExpiry)
  .clients(http.control({
    port: 7300,
    token: H.env('CONTROL_TOKEN'),
    grants: [H.ops.readWork, H.ops.writeWork, H.ops.resolve(upsellDecision, H.halts.interrupted, H.halts.definitionChanged), H.ops.readTelemetry],
  }))
  .observers(markdown.board('BOARD.md'), markdown.telemetry('TELEMETRY.md'));
