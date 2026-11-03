import { z } from 'zod';
import { H } from 'harness-dsl';
import type { DataOf, Metrics, StateOf, Supply } from 'harness-dsl';
import * as anthropic from 'harness-dsl/anthropic';
import * as http from 'harness-dsl/http';
import * as shell from 'harness-dsl/shell';
import * as sqlite from 'harness-dsl/sqlite';
import * as markdown from 'harness-dsl/markdown';

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

const local = shell.local('local', { slots: 4 });
const sonnet = anthropic.model('claude-sonnet-4-5');
const opus = anthropic.model('claude-opus-4-1');

const fiveTriesThenStop = H.policy.retry('five-tries-then-stop', view =>
  view.failures >= 5 ? 'stop' : { retryInMs: 5 * 60_000 * 2 ** view.failures });

const Sample = z.object({ at: z.coerce.date(), a: z.number(), b: z.number() });
type Sample = z.infer<typeof Sample>;
type ExperimentVerdict = 'a-wins' | 'b-wins' | 'inconclusive';

const experimentDue = H.state.pending('due');
const sampling = H.state.active('sampling');
const concluding = H.state.active('concluding');
const betweenSamples = H.state.waiting('between-samples');
const aWins = H.state.terminal('a-wins', 'success');
const bWins = H.state.terminal('b-wins', 'success');
const inconclusive = H.state.terminal('inconclusive', 'neutral');
const experimentAbandoned = H.state.terminal('abandoned', 'failure');

const Experiment = H.kind('experiment')
  .data(z.object({
    name: z.string(),
    metric: z.string(),
    samples: z.array(Sample),
    endsAt: z.coerce.date().optional(),
  }))
  .states([experimentDue, sampling, concluding, betweenSamples, aWins, bWins, inconclusive, experimentAbandoned], 'due')
  .onFailure('abandoned');

const experimentLengthDays = H.policy.rule('experiment-length-days', (_experiment: string, metrics: Metrics): number => {
  const inconclusiveShare = metrics.rate({
    among: { entry: 'transition', kind: 'experiment', position: 'terminal' },
    count: { state: 'inconclusive' },
    days: 365,
  });
  return inconclusiveShare.samples >= 10 && (inconclusiveShare.value ?? 0) > 0.4 ? 21 : 14;
});

const experimentVerdict = H.policy.rule('experiment-verdict', (samples: readonly Sample[]): ExperimentVerdict => {
  if (samples.length < 24) return 'inconclusive';
  const differences = samples.map(sample => sample.a - sample.b);
  const mean = differences.reduce((sum, d) => sum + d, 0) / differences.length;
  const variance = differences.reduce((sum, d) => sum + (d - mean) ** 2, 0) / (differences.length - 1);
  const standardError = Math.sqrt(variance / differences.length);
  if (mean > 2 * standardError) return 'a-wins';
  if (mean < -2 * standardError) return 'b-wins';
  return 'inconclusive';
});

const measureExperiment = H.command('measure-experiment')
  .input(z.object({ experiment: z.string(), metric: z.string() }))
  .output(z.object({ a: z.number(), b: z.number() }))
  .argv(input => ['./experiments/measure', input.experiment, input.metric])
  .on(local)
  .restart('rerun');

const runExperiment = H.flow('run-experiment').for(Experiment).does(async ctx => {
  const now = ctx.now();
  const { name, metric, samples } = ctx.unit.data;
  const endsAt = ctx.unit.data.endsAt ?? new Date(now.getTime() + (await ctx.decide(experimentLengthDays, name)) * DAY_MS);

  if (now.getTime() >= endsAt.getTime()) {
    await ctx.move('concluding');
    return ctx.decide(experimentVerdict, samples);
  }

  await ctx.move('sampling');
  const reading = await ctx.run(measureExperiment, { experiment: name, metric });
  if (!reading.ok) return ctx.fail(reading.error);
  await ctx.update({ endsAt, samples: [...samples, { at: now, a: reading.value.a, b: reading.value.b }] });
  return ctx.rest('between-samples', { at: new Date(now.getTime() + HOUR_MS), then: 'due' });
});

const experiments = H.lane('experiments', Experiment)
  .handler(runExperiment)
  .suppliers(H.operator)
  .store(sqlite.store(Experiment, '.harness/experiments.db'))
  .retry(fiveTriesThenStop);

const reviewDue = H.state.pending('review-due');
const reviewingTenancy = H.state.active('reviewing');
const awaitingDecision = H.state.active('awaiting-decision');
const betweenReviews = H.state.waiting('between-reviews');
const suspended = H.state.waiting('suspended');
const churned = H.state.terminal('churned', 'neutral');

const Tenancy = H.kind('tenancy')
  .data(z.object({
    customer: z.string(),
    plan: z.string(),
    lastReview: z.coerce.date().optional(),
    lastDecision: z.enum(['upsell', 'hold']).optional(),
  }))
  .states([reviewDue, reviewingTenancy, awaitingDecision, betweenReviews, suspended, churned], 'review-due');

const usageReport = H.command('usage-report')
  .input(z.object({ customer: z.string() }))
  .output(z.object({ report: z.string() }))
  .argv(input => ['./billing/usage-report', '--customer', input.customer, '--months', '1'])
  .on(local)
  .restart('rerun');

const tenancySummaryRole = H.role('tenancy-summarizer')
  .input(z.object({ customer: z.string(), plan: z.string(), usage: z.string() }))
  .output(z.object({ summary: z.string(), upsellCase: z.string() }))
  .prompt(t => `Summarize last month for ${t.customer} on plan ${t.plan} and state the case for and against an upsell.\n\n${t.usage}`)
  .intents(['read']);

const tenancySummarizer = H.agent('tenancy-summarizer', tenancySummaryRole).model(sonnet);

function firstOfNextMonth(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1, 9));
}

const reviewTenancy = H.flow('review-tenancy').for(Tenancy).does(async ctx => {
  const tenancy = ctx.unit.data;
  await ctx.move('reviewing');
  const usage = await ctx.run(usageReport, { customer: tenancy.customer });
  if (!usage.ok) return ctx.fail(usage.error);
  const summary = await ctx.run(tenancySummarizer, { customer: tenancy.customer, plan: tenancy.plan, usage: usage.value.report });
  if (!summary.ok) return ctx.fail(summary.error);

  await ctx.move('awaiting-decision');
  const decision = await ctx.halt({
    name: 'upsell-decision',
    show: `${summary.value.summary}\n\n${summary.value.upsellCase}`,
    decision: z.object({ upsell: z.boolean(), note: z.string() }),
  });
  await ctx.update({ lastReview: ctx.now(), lastDecision: decision.upsell ? 'upsell' : 'hold' });
  return ctx.rest('between-reviews', { at: firstOfNextMonth(ctx.now()), then: 'review-due' });
});

const BillingEvent = z.object({
  customer: z.string(),
  plan: z.string(),
  event: z.enum(['signed-up', 'suspended', 'reinstated', 'churned']),
});
type BillingEvent = z.infer<typeof BillingEvent>;

function fromBilling(event: BillingEvent): Supply<DataOf<typeof Tenancy>, StateOf<typeof Tenancy>> {
  switch (event.event) {
    case 'signed-up':
      return { create: { customer: event.customer, plan: event.plan }, key: event.customer };
    case 'suspended':
      return { update: event.customer, state: 'suspended' };
    case 'reinstated':
      return { update: event.customer, patch: { plan: event.plan }, state: 'review-due' };
    case 'churned':
      return { update: event.customer, state: 'churned' };
  }
}

const billingWebhook = http.webhook(Tenancy, {
  path: '/hooks/billing',
  secret: H.env('BILLING_WEBHOOK_SECRET'),
  body: BillingEvent,
  read: fromBilling,
});

const tenancies = H.lane('tenancies', Tenancy)
  .handler(reviewTenancy)
  .suppliers(billingWebhook, H.operator)
  .store(sqlite.store(Tenancy, '.harness/tenancies.db'));

const ourTurn = H.state.pending('our-turn');
const drafting = H.state.active('drafting');
const confirmingWalkAway = H.state.active('confirming-walk-away');
const theirTurn = H.state.waiting('their-turn');
const agreed = H.state.terminal('agreed', 'success');
const weWalked = H.state.terminal('we-walked', 'neutral');
const theyWalked = H.state.terminal('they-walked', 'neutral');
const expired = H.state.terminal('expired', 'neutral');

const Negotiation = H.kind('negotiation')
  .data(z.object({
    vendor: z.string(),
    item: z.string(),
    targetUsd: z.number(),
    expiresAt: z.coerce.date(),
    rounds: z.number(),
    lastOffer: z.string().optional(),
    lastReply: z.string().optional(),
  }))
  .states([ourTurn, drafting, confirmingWalkAway, theirTurn, agreed, weWalked, theyWalked, expired], 'our-turn');

const negotiatorRole = H.role('negotiator')
  .input(z.object({
    vendor: z.string(),
    item: z.string(),
    targetUsd: z.number(),
    rounds: z.number(),
    lastOffer: z.string().optional(),
    lastReply: z.string().optional(),
  }))
  .output(z.object({
    action: z.enum(['offer', 'accept', 'walk-away']),
    message: z.string(),
    rationale: z.string(),
  }))
  .prompt(n => `Negotiate ${n.item} with ${n.vendor}, target $${n.targetUsd}, round ${n.rounds + 1}.\nOur last offer: ${n.lastOffer ?? 'none'}\nTheir last reply: ${n.lastReply ?? 'none'}`)
  .intents(['read']);

const negotiator = H.agent('negotiator', negotiatorRole).model(opus);

const sendToVendor = H.command('send-to-vendor')
  .input(z.object({ vendor: z.string(), negotiation: z.string(), message: z.string() }))
  .output(z.object({ messageId: z.string() }))
  .argv(input => ['./procurement/send', '--vendor', input.vendor, '--thread', input.negotiation, '--body', input.message])
  .on(local)
  .restart('park');

const negotiateRound = H.flow('negotiate-round').for(Negotiation).does(async ctx => {
  const n = ctx.unit.data;
  await ctx.move('drafting');
  const next = await ctx.run(negotiator, {
    vendor: n.vendor,
    item: n.item,
    targetUsd: n.targetUsd,
    rounds: n.rounds,
    lastOffer: n.lastOffer,
    lastReply: n.lastReply,
  });
  if (!next.ok) return ctx.fail(next.error);

  if (next.value.action === 'walk-away') {
    await ctx.move('confirming-walk-away');
    const confirmation = await ctx.halt({
      name: 'confirm-walk-away',
      show: next.value.rationale,
      decision: z.object({ walkAway: z.boolean(), guidance: z.string() }),
    });
    if (!confirmation.walkAway) {
      await ctx.update({ lastReply: `${n.lastReply ?? ''}\nOwner guidance: ${confirmation.guidance}` });
      return 'our-turn';
    }
  }

  const sent = await ctx.run(sendToVendor, { vendor: n.vendor, negotiation: ctx.unit.key, message: next.value.message });
  if (!sent.ok) return ctx.fail(sent.error);
  if (next.value.action === 'walk-away') return 'we-walked';
  if (next.value.action === 'accept') return 'agreed';
  await ctx.update({ lastOffer: next.value.message, rounds: n.rounds + 1 });
  return ctx.rest('their-turn');
});

const VendorEvent = z.object({
  negotiation: z.string(),
  event: z.enum(['countered', 'accepted', 'walked']),
  message: z.string(),
});
type VendorEvent = z.infer<typeof VendorEvent>;

function fromVendor(event: VendorEvent): Supply<DataOf<typeof Negotiation>, StateOf<typeof Negotiation>> {
  if (event.event === 'accepted') return { update: event.negotiation, patch: { lastReply: event.message }, state: 'agreed' };
  if (event.event === 'walked') return { update: event.negotiation, patch: { lastReply: event.message }, state: 'they-walked' };
  return { update: event.negotiation, patch: { lastReply: event.message }, state: 'our-turn' };
}

const vendorReplies = http.webhook(Negotiation, {
  path: '/hooks/vendor-replies',
  secret: H.env('VENDOR_WEBHOOK_SECRET'),
  body: VendorEvent,
  read: fromVendor,
});

const negotiations = H.lane('negotiations', Negotiation)
  .handler(negotiateRound)
  .suppliers(H.operator, vendorReplies)
  .store(sqlite.store(Negotiation, '.harness/negotiations.db'))
  .wip(3);

const negotiationExpires = H.trigger(
  'negotiation-expires',
  H.on.deadline(Negotiation, data => data.expiresAt, ['our-turn', 'drafting', 'confirming-walk-away', 'their-turn']),
  (_event, act) => act.move('expired'),
);

const apiPool = H.pool(
  'anthropic-api',
  [{ account: anthropic.account('anthropic-api', { apiKey: H.env('ANTHROPIC_API_KEY') }), share: 1 }],
  H.policy.account('first-eligible', choice => choice.accounts.find(view => view.eligible)?.account ?? null),
);

export const hostileLifecycles = H.harness('hostile-lifecycles')
  .ledger(sqlite.ledger('.harness/ledger.db'))
  .lanes(experiments, tenancies, negotiations)
  .pools(apiPool)
  .triggers(negotiationExpires)
  .scheduler(H.policy.scheduler('oldest-first', view => ({
    start: [...view.pending].sort((x, y) => y.waitedMs - x.waitedMs),
  })))
  .clients(http.control({
    port: H.slot.port(0),
    token: H.env('CONTROL_TOKEN'),
    grants: [H.ops.readWork, H.ops.writeWork, H.ops.resolveHalts, H.ops.readTelemetry],
  }))
  .observers(markdown.board('BOARD.md'), markdown.telemetry('TELEMETRY.md'));
