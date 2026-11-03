import { z } from 'zod';
import { H } from 'harness-dsl';
import type { DataOf, StateOf, PendingView, Supply } from 'harness-dsl';
import * as anthropic from 'harness-dsl/anthropic';
import * as sqlite from 'harness-dsl/sqlite';
import * as shell from 'harness-dsl/shell';
import * as http from 'harness-dsl/http';
import * as markdown from 'harness-dsl/markdown';
import * as claudeCode from 'harness-dsl/claude-code';

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

const local = shell.local('local', { slots: 4 });

const observation = z.object({ at: z.string(), a: z.number(), b: z.number() });
type Observation = z.infer<typeof observation>;

const Experiment = H.kind('experiment')
  .data(z.object({ name: z.string(), startedAt: z.string(), observations: z.array(observation) }))
  .states({
    sampling: 'pending',
    'between-samples': 'waiting',
    'a-wins': 'success',
    'b-wins': 'success',
    inconclusive: 'neutral',
  }, 'sampling');

const measure = H.command('measure-experiment')
  .input(z.object({ experiment: z.string() }))
  .output(z.object({ a: z.number(), b: z.number() }))
  .argv(input => ['experiment-metric', '--name', input.experiment, '--json'])
  .on(local)
  .restart('rerun');

const experimentVerdict = H.policy.rule<readonly Observation[], 'a-wins' | 'b-wins' | 'inconclusive'>('experiment-verdict', observations => {
  const mean = (pick: (o: Observation) => number) =>
    observations.reduce((sum, o) => sum + pick(o), 0) / Math.max(observations.length, 1);
  const a = mean(o => o.a);
  const b = mean(o => o.b);
  const lift = (a - b) / Math.max(Math.abs(b), 1e-9);
  if (observations.length < 200 || Math.abs(lift) < 0.02) return 'inconclusive';
  return lift > 0 ? 'a-wins' : 'b-wins';
});

const experimentFlow = H.flow('experiment').for(Experiment).does(async ctx => {
  const measured = await ctx.run(measure, { experiment: ctx.unit.data.name });
  if (!measured.ok) return ctx.fail(measured.error);
  const now = ctx.now();
  const observations = [...ctx.unit.data.observations, { at: now.toISOString(), a: measured.value.a, b: measured.value.b }];
  await ctx.update({ observations });
  if (now.getTime() < Date.parse(ctx.unit.data.startedAt) + 14 * DAY) {
    return ctx.until('between-samples', { at: new Date(now.getTime() + HOUR), then: 'sampling' });
  }
  return ctx.decide(experimentVerdict, observations);
});

const experiments = H.lane('experiments', Experiment)
  .handler(experimentFlow)
  .suppliers(H.operator)
  .store(sqlite.store(Experiment, 'experiments.db'))
  .retry(H.policy.retry('measure-backoff', view => view.failures < 3 ? { retryInMs: 5 * 60 * 1000 * 2 ** view.failures } : 'stop'));

const Tenancy = H.kind('tenancy')
  .data(z.object({
    tenantId: z.string(),
    name: z.string(),
    lastReview: z.string().optional(),
    lastDecision: z.enum(['upsell', 'hold']).optional(),
  }))
  .states({
    'review-due': 'pending',
    'between-reviews': 'waiting',
    suspended: 'waiting',
    churned: 'neutral',
  }, 'review-due');

type TenancyData = DataOf<typeof Tenancy>;
type TenancyState = StateOf<typeof Tenancy>;

const billingEvent = z.object({
  type: z.enum(['signed-up', 'suspended', 'reinstated', 'churned']),
  tenantId: z.string(),
  name: z.string(),
});
type BillingEvent = z.infer<typeof billingEvent>;

function fromBilling(event: BillingEvent): Supply<TenancyData, TenancyState> {
  switch (event.type) {
    case 'signed-up': return { create: { tenantId: event.tenantId, name: event.name }, key: event.tenantId };
    case 'suspended': return { update: event.tenantId, state: 'suspended' };
    case 'reinstated': return { update: event.tenantId, state: 'review-due' };
    case 'churned': return { update: event.tenantId, state: 'churned' };
  }
}

const billing = http.webhook(Tenancy, {
  path: '/hooks/billing',
  secret: H.env('BILLING_WEBHOOK_SECRET'),
  body: billingEvent,
  read: fromBilling,
});

const usageReview = H.command('usage-review')
  .input(z.object({ tenantId: z.string() }))
  .output(z.object({ seats: z.number(), monthlyUsd: z.number(), trend: z.string() }))
  .argv(input => ['usage-review', '--tenant', input.tenantId, '--json'])
  .on(local)
  .restart('rerun');

const accountReviewer = H.role('account-reviewer')
  .input(z.object({ name: z.string(), seats: z.number(), monthlyUsd: z.number(), trend: z.string() }))
  .output(z.object({ summary: z.string(), upsellCase: z.string() }))
  .prompt(input => `Summarise ${input.name}'s month: ${input.seats} seats, $${input.monthlyUsd}/month, trend ${input.trend}. Make the case for or against an upsell.`);

const strong = anthropic.model('claude-sonnet-4-5');
const summarizer = H.agent('tenancy-summarizer', accountReviewer).model(strong);

const nextMonth = (now: Date) => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1, 9));

const tenancyFlow = H.flow('tenancy-review').for(Tenancy).does(async ctx => {
  const usage = await ctx.run(usageReview, { tenantId: ctx.unit.data.tenantId });
  if (!usage.ok) return ctx.fail(usage.error);
  const summary = await ctx.run(summarizer, { name: ctx.unit.data.name, ...usage.value });
  if (!summary.ok) return ctx.fail(summary.error);
  const decision = await ctx.halt({
    name: 'upsell-decision',
    show: `${summary.value.summary}\n\n${summary.value.upsellCase}`,
    decision: z.object({ upsell: z.boolean(), note: z.string() }),
  });
  await ctx.update({ lastReview: ctx.now().toISOString(), lastDecision: decision.upsell ? 'upsell' : 'hold' });
  return ctx.until('between-reviews', { at: nextMonth(ctx.now()), then: 'review-due' });
});

const tenancies = H.lane('tenancies', Tenancy)
  .handler(tenancyFlow)
  .suppliers(billing)
  .store(sqlite.store(Tenancy, 'tenancies.db'));

const Negotiation = H.kind('negotiation')
  .data(z.object({
    vendor: z.string(),
    item: z.string(),
    ceilingUsd: z.number(),
    expiresAt: z.string(),
    rounds: z.number(),
    lastOfferUsd: z.number().optional(),
    lastVendorMessage: z.string().optional(),
  }))
  .states({
    drafting: 'pending',
    'awaiting-vendor': 'waiting',
    agreed: 'success',
    'we-walked': 'neutral',
    'they-walked': 'failure',
    expired: 'failure',
  }, 'drafting');

type NegotiationData = DataOf<typeof Negotiation>;
type NegotiationState = StateOf<typeof Negotiation>;

const vendorReply = z.object({
  negotiationId: z.string(),
  type: z.enum(['counter', 'accepted', 'withdrew']),
  message: z.string(),
});
type VendorReply = z.infer<typeof vendorReply>;

function fromVendor(reply: VendorReply): Supply<NegotiationData, NegotiationState> {
  switch (reply.type) {
    case 'counter': return { update: reply.negotiationId, patch: { lastVendorMessage: reply.message }, state: 'drafting' };
    case 'accepted': return { update: reply.negotiationId, patch: { lastVendorMessage: reply.message }, state: 'agreed' };
    case 'withdrew': return { update: reply.negotiationId, patch: { lastVendorMessage: reply.message }, state: 'they-walked' };
  }
}

const vendorReplies = http.webhook(Negotiation, {
  path: '/hooks/vendor-replies',
  secret: H.env('VENDOR_WEBHOOK_SECRET'),
  body: vendorReply,
  read: fromVendor,
});

const negotiatorRole = H.role('negotiator')
  .input(z.object({
    vendor: z.string(),
    item: z.string(),
    ceilingUsd: z.number(),
    round: z.number(),
    lastOfferUsd: z.number().nullable(),
    lastVendorMessage: z.string(),
  }))
  .output(z.object({
    move: z.enum(['offer', 'accept', 'walk-away']),
    offerUsd: z.number(),
    message: z.string(),
    reasoning: z.string(),
  }))
  .prompt(input => [
    `Round ${input.round} negotiating ${input.item} with ${input.vendor}. Our ceiling is $${input.ceilingUsd}.`,
    input.lastOfferUsd === null ? 'No offer made yet.' : `Our last offer: $${input.lastOfferUsd}.`,
    input.lastVendorMessage ? `Vendor said: ${input.lastVendorMessage}` : '',
  ].join('\n\n'));

const negotiator = H.agent('negotiator', negotiatorRole).model(strong);

const sendToVendor = H.command('send-to-vendor')
  .input(z.object({ vendor: z.string(), offerUsd: z.number(), message: z.string(), accept: z.boolean() }))
  .argv(input => ['vendor-mail', '--to', input.vendor, '--json', JSON.stringify(input)])
  .on(local)
  .restart('park');

const negotiationFlow = H.flow('negotiation-round').for(Negotiation).does(async ctx => {
  const data = ctx.unit.data;
  const drafted = await ctx.run(negotiator, {
    vendor: data.vendor,
    item: data.item,
    ceilingUsd: data.ceilingUsd,
    round: data.rounds + 1,
    lastOfferUsd: data.lastOfferUsd ?? null,
    lastVendorMessage: data.lastVendorMessage ?? '',
  });
  if (!drafted.ok) return ctx.fail(drafted.error);
  const move = drafted.value;

  if (move.move === 'walk-away') {
    const confirm = await ctx.halt({
      name: 'confirm-walk-away',
      show: move.reasoning,
      decision: z.object({ walkAway: z.boolean() }),
    });
    if (confirm.walkAway) return 'we-walked';
  }

  if (move.move === 'accept') {
    const confirm = await ctx.halt({
      name: 'confirm-agreement',
      show: `${move.reasoning}\n\nAccept at $${move.offerUsd}?`,
      decision: z.object({ accept: z.boolean() }),
    });
    if (confirm.accept) {
      const accepted = await ctx.run(sendToVendor, { vendor: data.vendor, offerUsd: move.offerUsd, message: move.message, accept: true });
      if (!accepted.ok) return ctx.fail(accepted.error);
      return 'agreed';
    }
  }

  const sent = await ctx.run(sendToVendor, { vendor: data.vendor, offerUsd: move.offerUsd, message: move.message, accept: false });
  if (!sent.ok) return ctx.fail(sent.error);
  await ctx.update({ rounds: data.rounds + 1, lastOfferUsd: move.offerUsd });
  return 'awaiting-vendor';
});

const negotiations = H.lane('negotiations', Negotiation)
  .handler(negotiationFlow)
  .suppliers(H.operator, vendorReplies)
  .store(sqlite.store(Negotiation, 'negotiations.db'))
  .maxUsdPerUnit(5);

const negotiationExpiry = H.trigger(
  'negotiation-expiry',
  H.on.deadline(Negotiation, data => new Date(data.expiresAt), ['drafting', 'awaiting-vendor']),
  (event, act) => act.move('expired'),
);

const api = anthropic.account('ops-api', { apiKey: H.env('ANTHROPIC_API_KEY'), quota: sqlite.quota('quota.db') });
const pool = H.pool('api', [{ account: api, share: 1 }], H.policy.account('only-api', choice =>
  choice.accounts.find(view => view.eligible)?.account ?? null));

const laneOrder = ['tenancies', 'negotiations', 'experiments'];
const laneRank = (unit: PendingView) => laneOrder.indexOf(unit.lane);

const scheduler = H.policy.scheduler('lifecycles', ({ pending, metrics }) => {
  const inconclusive = metrics.rate({
    among: { entry: 'transition', kind: Experiment.name, position: 'terminal' },
    count: { state: 'inconclusive' },
    days: 180,
  });
  const holdNewExperiments = inconclusive.samples >= 10 && inconclusive.value !== null && inconclusive.value > 0.5;
  const startable = pending.filter(unit => !(holdNewExperiments && unit.is(Experiment) && unit.data.observations.length === 0));
  return { start: [...startable].sort((x, y) => laneRank(x) - laneRank(y)) };
});

export const hostileLifecycles = H.harness('hostile-lifecycles')
  .ledger(sqlite.ledger('hostile-lifecycles.db'))
  .lanes(experiments, tenancies, negotiations)
  .pools(pool)
  .triggers(negotiationExpiry)
  .scheduler(scheduler)
  .clients(claudeCode.supervisor({
    grants: [H.ops.readWork, H.ops.writeWork, H.ops.resolveHalts, H.ops.readTelemetry],
  }))
  .observers(markdown.board('board.md'), markdown.telemetry('telemetry.md'));
