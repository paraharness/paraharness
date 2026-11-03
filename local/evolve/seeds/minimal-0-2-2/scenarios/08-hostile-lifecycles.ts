import { z } from 'zod';
import { H } from 'harness-dsl';
import type { PendingView, SupplyOf } from 'harness-dsl';
import * as anthropic from 'harness-dsl/anthropic';
import * as claudeCode from 'harness-dsl/claude-code';
import * as http from 'harness-dsl/http';
import * as sqlite from 'harness-dsl/sqlite';
import * as shell from 'harness-dsl/shell';
import * as markdown from 'harness-dsl/markdown';

const local = shell.local('lifecycle-tools', { slots: 4 });
const strong = anthropic.model('claude-opus-4-1');
const cheap = anthropic.model('claude-haiku-4-5');

const planned = H.state('planned', 'pending');
const sampling = H.state('sampling', 'active');
const betweenSamples = H.state('between-samples', 'waiting');
const aWins = H.state('a-wins', 'terminal', 'success');
const bWins = H.state('b-wins', 'terminal', 'success');
const inconclusive = H.state('inconclusive', 'terminal', 'neutral');

const Experiment = H.kind('Experiment')
  .data(z.object({ name: z.string(), endsAt: z.string() }))
  .states(planned, sampling, betweenSamples, aWins, bWins, inconclusive);

const reading = z.object({
  visitorsA: z.number(),
  conversionsA: z.number(),
  visitorsB: z.number(),
  conversionsB: z.number(),
});
type Reading = z.infer<typeof reading>;
type ExperimentResult = 'a-wins' | 'b-wins' | 'inconclusive';

const readExperiment = H.command('read-experiment-metric')
  .input(z.object({ experiment: z.string() }))
  .output(reading)
  .argv((target) => ['experiment-metric', '--name', target.experiment, '--json'])
  .on(local);

const judgeExperiment = H.policy.rule('experiment-verdict', (latest: Reading): ExperimentResult => {
  const visitorsA = Math.max(latest.visitorsA, 1);
  const visitorsB = Math.max(latest.visitorsB, 1);
  const pooled = (latest.conversionsA + latest.conversionsB) / (visitorsA + visitorsB);
  const spread = Math.sqrt(pooled * (1 - pooled) * (1 / visitorsA + 1 / visitorsB));
  if (spread === 0) return 'inconclusive';
  const score = (latest.conversionsA / visitorsA - latest.conversionsB / visitorsB) / spread;
  return score > 1.96 ? 'a-wins' : score < -1.96 ? 'b-wins' : 'inconclusive';
});

const observeExperiment = H.flow('observe-experiment').for(Experiment).does(async (ctx) => {
  const endsAt = new Date(ctx.unit.data.endsAt);
  let latest: Reading | null = null;
  while (ctx.now() < endsAt) {
    await ctx.move('sampling');
    const sample = await ctx.run(readExperiment, { experiment: ctx.unit.data.name });
    if (sample.ok) latest = sample.value;
    await ctx.wait('between-samples', { at: new Date(ctx.now().getTime() + 3_600_000) });
  }
  if (latest === null) return ctx.fail('no metric reading was collected');
  return ctx.decide(judgeExperiment, latest);
});

const experiments = H.lane('experiments', Experiment)
  .handler(observeExperiment)
  .suppliers(H.operator)
  .store(sqlite.store(Experiment, '.harness/work.db'));

const reviewDue = H.state('review-due', 'pending');
const reviewing = H.state('reviewing', 'active');
const betweenReviews = H.state('between-reviews', 'waiting');
const suspended = H.state('suspended', 'waiting');
const churned = H.state('churned', 'terminal', 'neutral');

const Tenancy = H.kind('Tenancy')
  .data(z.object({
    customerId: z.string(),
    plan: z.string(),
    lastDecision: z.enum(['upsell', 'hold']).optional(),
  }))
  .states(reviewDue, reviewing, betweenReviews, suspended, churned);

const usageReport = H.command('usage-report')
  .input(z.object({ customerId: z.string() }))
  .output(z.object({ seats: z.number(), activeUsers: z.number(), spendUsd: z.number() }))
  .argv((tenant) => ['usage-report', '--customer', tenant.customerId, '--last-month', '--json'])
  .on(local);

const accountSummary = H.role('account-summary')
  .input(z.object({ customerId: z.string(), plan: z.string(), seats: z.number(), activeUsers: z.number(), spendUsd: z.number() }))
  .output(z.object({ summary: z.string() }))
  .prompt((usage) => `Summarise last month for ${usage.customerId} on ${usage.plan}: ${usage.activeUsers}/${usage.seats} seats active, $${usage.spendUsd} spent. Say whether an upsell is warranted.`)
  .intents(['read']);

const summarizer = H.agent('account-summarizer', accountSummary).model(cheap);

const upsellDecision = H.halt('upsell-decision', z.object({ upsell: z.boolean(), note: z.string() }));

const reviewTenancy = H.flow('review-tenancy').for(Tenancy).does(async (ctx) => {
  const { customerId, plan } = ctx.unit.data;
  await ctx.move('reviewing');
  const usage = await ctx.run(usageReport, { customerId });
  if (usage.ok === false) return ctx.fail(usage.error);
  const summary = await ctx.run(summarizer, { customerId, plan, ...usage.value });
  if (summary.ok === false) return ctx.fail(summary.error);
  const decision = await ctx.halt(upsellDecision, summary.value.summary);
  await ctx.update({ lastDecision: decision.upsell ? 'upsell' : 'hold' });
  const now = ctx.now();
  await ctx.wait('between-reviews', { at: new Date(now.getFullYear(), now.getMonth() + 1, 1) });
  return 'review-due';
});

const billingEvents = http.webhook(Tenancy, {
  path: '/billing',
  secret: H.env('BILLING_WEBHOOK_SECRET'),
  body: z.object({
    type: z.enum(['signed', 'suspended', 'reinstated', 'churned']),
    customerId: z.string(),
    plan: z.string(),
  }),
  read: (event): SupplyOf<typeof Tenancy> | null => {
    switch (event.type) {
      case 'signed':
        return { create: { customerId: event.customerId, plan: event.plan }, key: event.customerId };
      case 'suspended':
        return { update: event.customerId, state: 'suspended' };
      case 'reinstated':
        return { update: event.customerId, patch: { plan: event.plan }, state: 'review-due' };
      case 'churned':
        return { update: event.customerId, state: 'churned' };
    }
  },
});

const tenancies = H.lane('tenancies', Tenancy)
  .handler(reviewTenancy)
  .suppliers(billingEvents)
  .store(sqlite.store(Tenancy, '.harness/work.db'));

const open = H.state('open', 'pending');
const vendorReplied = H.state('vendor-replied', 'pending');
const drafting = H.state('drafting', 'active');
const awaitingVendor = H.state('awaiting-vendor', 'waiting');
const agreed = H.state('agreed', 'terminal', 'success');
const weWalked = H.state('we-walked', 'terminal', 'neutral');
const theyWalked = H.state('they-walked', 'terminal', 'failure');
const expired = H.state('expired', 'terminal', 'failure');

const Negotiation = H.kind('Negotiation')
  .data(z.object({
    vendor: z.string(),
    item: z.string(),
    expiresAt: z.string(),
    round: z.number(),
    lastVendorMessage: z.string(),
    ourLastOffer: z.string().optional(),
  }))
  .states(open, vendorReplied, drafting, awaitingVendor, agreed, weWalked, theyWalked, expired);

const negotiatorRole = H.role('negotiator')
  .input(z.object({ vendor: z.string(), item: z.string(), vendorMessage: z.string(), ourLastOffer: z.string() }))
  .output(z.object({ walkAway: z.boolean(), offer: z.string(), rationale: z.string() }))
  .prompt((state) => `Negotiating ${state.item} with ${state.vendor}.\nOur last offer: ${state.ourLastOffer}\nTheir message: ${state.vendorMessage}\nDraft the next offer or recommend walking away.`)
  .intents(['read']);

const negotiator = H.agent('negotiator', negotiatorRole).model(strong);

const sendOffer = H.command('send-offer')
  .input(z.object({ vendor: z.string(), offer: z.string() }))
  .argv((message) => ['send-offer', '--vendor', message.vendor, '--body', message.offer])
  .on(local);

const walkAway = H.halt('confirm-walk-away', z.object({ confirm: z.boolean() }));

const negotiationRound = H.flow('negotiation-round').for(Negotiation).does(async (ctx) => {
  const deal = ctx.unit.data;
  await ctx.move('drafting');
  const next = await ctx.run(negotiator, {
    vendor: deal.vendor,
    item: deal.item,
    vendorMessage: deal.lastVendorMessage,
    ourLastOffer: deal.ourLastOffer ?? 'none yet',
  });
  if (next.ok === false) return ctx.fail(next.error);
  if (next.value.walkAway) {
    const answer = await ctx.halt(walkAway, next.value.rationale);
    if (answer.confirm) return 'we-walked';
  }
  const sent = await ctx.run(sendOffer, { vendor: deal.vendor, offer: next.value.offer });
  if (sent.ok === false) return ctx.fail(sent.error);
  await ctx.update({ ourLastOffer: next.value.offer, round: deal.round + 1 });
  return 'awaiting-vendor';
});

const vendorReplies = http.webhook(Negotiation, {
  path: '/vendor-replies',
  secret: H.env('VENDOR_WEBHOOK_SECRET'),
  body: z.object({
    negotiationId: z.string(),
    reply: z.enum(['counter', 'accepted', 'withdrew']),
    message: z.string(),
  }),
  read: (event): SupplyOf<typeof Negotiation> => ({
    update: event.negotiationId,
    patch: { lastVendorMessage: event.message },
    state: event.reply === 'accepted' ? 'agreed' : event.reply === 'withdrew' ? 'they-walked' : 'vendor-replied',
  }),
});

const negotiations = H.lane('negotiations', Negotiation)
  .handler(negotiationRound)
  .suppliers(H.operator, vendorReplies)
  .store(sqlite.store(Negotiation, '.harness/work.db'));

const negotiationExpires = H.trigger(
  'negotiation-expires',
  H.on.deadline(Negotiation, (deal) => new Date(deal.expiresAt), ['open', 'vendor-replied', 'drafting', 'awaiting-vendor']),
  (event, act) => act.move('expired'),
);

const lifecycleOrder = H.policy.scheduler('lifecycle-order', ({ pending, metrics }) => {
  const outcomes = metrics.rate({
    among: { entry: 'transition', kind: Experiment, position: 'terminal' },
    count: { entry: 'transition', kind: Experiment, state: 'inconclusive' },
    days: 90,
  });
  const deferExperiments = outcomes.samples >= 10 && outcomes.value !== null && outcomes.value > 0.5;
  const rank = (unit: PendingView): number =>
    unit.is(Negotiation) ? 0 : unit.is(Tenancy) ? 1 : deferExperiments ? 3 : 2;
  return { start: [...pending].sort((a, b) => rank(a) - rank(b) || b.waitedMs - a.waitedMs) };
});

const api = anthropic.account('lifecycle-api', { apiKey: H.env('ANTHROPIC_API_KEY') });

export const lifecycles = H.harness('lifecycles')
  .ledger(sqlite.ledger('.harness/ledger.db'))
  .lanes(experiments, tenancies, negotiations)
  .pools(H.pool('lifecycle-accounts', [{ account: api, share: 1 }]))
  .triggers(negotiationExpires)
  .scheduler(lifecycleOrder)
  .clients(claudeCode.supervisor({
    grants: [H.ops.readWork, H.ops.writeWork, H.ops.resolveHalts, H.ops.readTelemetry],
  }))
  .observers(markdown.board('BOARD.md'), markdown.telemetry('TELEMETRY.md'));
