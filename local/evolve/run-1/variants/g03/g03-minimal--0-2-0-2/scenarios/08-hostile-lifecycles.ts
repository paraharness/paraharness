import { z } from 'zod';
import { H } from 'harness-dsl';
import type { SupplyOf } from 'harness-dsl';
import * as anthropic from 'harness-dsl/anthropic';
import * as claudeCode from 'harness-dsl/claude-code';
import * as http from 'harness-dsl/http';
import * as sqlite from 'harness-dsl/sqlite';
import * as shell from 'harness-dsl/shell';
import * as markdown from 'harness-dsl/markdown';

const HOUR_MS = 3_600_000;
const TWO_WEEKS_MS = 14 * 24 * HOUR_MS;
const local = shell.local('local', { slots: 4 });
const store = 'lifecycles/units.db';

const proposed = H.state('proposed', 'pending');
const measuring = H.state('measuring', 'pending');
const running = H.state('running', 'waiting');
const aWins = H.state('a-wins', 'terminal', 'success');
const bWins = H.state('b-wins', 'terminal', 'success');
const inconclusive = H.state('inconclusive', 'terminal', 'neutral');

const Experiment = H.kind('Experiment')
  .data(z.object({ hypothesis: z.string(), startedAt: z.string().optional(), a: z.array(z.number()), b: z.array(z.number()) }))
  .states(proposed, measuring, running, aWins, bWins, inconclusive);

const measure = H.command('measure-experiment')
  .input(z.object({ experiment: z.string() }))
  .output(z.object({ a: z.number(), b: z.number() }))
  .argv(target => ['experiment-metric', target.experiment])
  .on(local)
  .recovers('rerun');

type ExperimentVerdict = 'a-wins' | 'b-wins' | 'inconclusive';
function average(values: readonly number[]): number {
  return values.length === 0 ? 0 : values.reduce((sum, v) => sum + v, 0) / values.length;
}
const experimentVerdict = H.policy.rule(
  'experiment-verdict',
  (samples: { readonly a: readonly number[]; readonly b: readonly number[] }): ExperimentVerdict => {
    const lift = average(samples.b) - average(samples.a);
    const margin = Math.max(Math.abs(average(samples.a)), 1) * 0.02;
    if (lift > margin) return 'b-wins';
    if (lift < -margin) return 'a-wins';
    return 'inconclusive';
  }
);

const experimentFlow = H.flow('experiment').for(Experiment).does(async ctx => {
  const now = ctx.now();
  const started = ctx.unit.data.startedAt ? new Date(ctx.unit.data.startedAt) : now;
  const reading = await ctx.run(measure, { experiment: ctx.unit.key });
  if (!reading.ok) return ctx.fail(reading.error);
  const a = [...ctx.unit.data.a, reading.value.a];
  const b = [...ctx.unit.data.b, reading.value.b];
  await ctx.update({ startedAt: started.toISOString(), a, b });
  if (now.getTime() - started.getTime() >= TWO_WEEKS_MS) return await ctx.decide(experimentVerdict, { a, b });
  return ctx.wait('running', { at: new Date(now.getTime() + HOUR_MS), then: 'measuring' });
});

const reviewDue = H.state('review-due', 'pending');
const reviewing = H.state('reviewing', 'active');
const customer = H.state('customer', 'waiting');
const suspended = H.state('suspended', 'waiting');
const churned = H.state('churned', 'terminal', 'neutral');

const Tenancy = H.kind('Tenancy')
  .data(z.object({ customer: z.string(), plan: z.string(), lastReview: z.string().optional(), lastDecision: z.enum(['upsell', 'hold']).optional() }))
  .states(reviewDue, reviewing, customer, suspended, churned);

const usageReport = H.command('usage-report')
  .input(z.object({ customer: z.string() }))
  .output(z.object({ seats: z.number(), activeUsers: z.number() }))
  .argv(tenant => ['usage-report', '--customer', tenant.customer])
  .on(local)
  .recovers('rerun');

const accountReviewRole = H.role('account-reviewer')
  .input(z.object({ customer: z.string(), plan: z.string(), seats: z.number(), activeUsers: z.number() }))
  .output(z.object({ summary: z.string() }))
  .prompt(t => `Summarise ${t.customer}'s month on ${t.plan}: ${t.activeUsers} of ${t.seats} seats active. Say whether an upsell is warranted.`);

const upsellDecision = H.halt('upsell-decision', z.object({ upsell: z.boolean(), note: z.string() }));

function firstOfNextMonth(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
}

const negotiatorRole = H.role('negotiator')
  .input(z.object({ vendor: z.string(), item: z.string(), lastOffer: z.string(), vendorMessage: z.string() }))
  .output(z.object({ action: z.enum(['offer', 'accept', 'walk-away']), offer: z.string() }))
  .prompt(n => `Negotiate ${n.item} with ${n.vendor}. Our last offer: ${n.lastOffer || 'none'}. Their reply: ${n.vendorMessage || 'none'}.`);

const apiModel = anthropic.model('claude-sonnet-4');
const accountReviewer = H.agent('account-reviewer', accountReviewRole).model(apiModel);
const negotiator = H.agent('negotiator', negotiatorRole).model(apiModel);

const tenancyFlow = H.flow('tenancy-review').for(Tenancy).does(async ctx => {
  const tenant = ctx.unit.data;
  await ctx.move('reviewing');
  const usage = await ctx.run(usageReport, { customer: tenant.customer });
  if (!usage.ok) return ctx.fail(usage.error);
  const summary = await ctx.run(accountReviewer, { customer: tenant.customer, plan: tenant.plan, seats: usage.value.seats, activeUsers: usage.value.activeUsers });
  if (!summary.ok) return ctx.fail(summary.error);
  const decision = await ctx.halt(upsellDecision, summary.value.summary);
  const now = ctx.now();
  await ctx.update({ lastReview: now.toISOString(), lastDecision: decision.upsell ? 'upsell' : 'hold' });
  return ctx.wait('customer', { at: firstOfNextMonth(now), then: 'review-due' });
});

const draftingOffer = H.state('drafting-offer', 'pending');
const awaitingVendor = H.state('awaiting-vendor', 'waiting');
const agreed = H.state('agreed', 'terminal', 'success');
const weWalkedAway = H.state('we-walked-away', 'terminal', 'neutral');
const theyWalkedAway = H.state('they-walked-away', 'terminal', 'failure');
const expired = H.state('expired', 'terminal', 'failure');

const Negotiation = H.kind('Negotiation')
  .data(z.object({ vendor: z.string(), item: z.string(), expiresAt: z.string(), round: z.number(), lastOffer: z.string().optional(), lastVendorMessage: z.string().optional() }))
  .states(draftingOffer, awaitingVendor, agreed, weWalkedAway, theyWalkedAway, expired);

const messageVendor = H.command('message-vendor')
  .input(z.object({ vendor: z.string(), message: z.string() }))
  .argv(m => ['vendor-mail', '--to', m.vendor, '--body', m.message])
  .on(local)
  .recovers('park');

const negotiationFlow = H.flow('negotiation-round').for(Negotiation).does(async ctx => {
  const deal = ctx.unit.data;
  const next = await ctx.run(negotiator, { vendor: deal.vendor, item: deal.item, lastOffer: deal.lastOffer ?? '', vendorMessage: deal.lastVendorMessage ?? '' });
  if (!next.ok) return ctx.fail(next.error);
  if (next.value.action === 'walk-away') return 'we-walked-away';
  const sent = await ctx.run(messageVendor, { vendor: deal.vendor, message: next.value.offer });
  if (!sent.ok) return ctx.fail(sent.error);
  if (next.value.action === 'accept') return 'agreed';
  await ctx.update({ lastOffer: next.value.offer, round: deal.round + 1 });
  return 'awaiting-vendor';
});

const billingEvent = z.object({ tenant: z.string(), plan: z.string(), event: z.enum(['signed', 'suspended', 'reinstated', 'churned']) });
function readBilling(body: z.infer<typeof billingEvent>): SupplyOf<typeof Tenancy> {
  if (body.event === 'signed') return { create: { customer: body.tenant, plan: body.plan }, key: body.tenant };
  if (body.event === 'suspended') return { update: body.tenant, state: 'suspended' };
  if (body.event === 'reinstated') return { update: body.tenant, patch: { plan: body.plan }, state: 'review-due' };
  return { update: body.tenant, state: 'churned' };
}

const vendorEvent = z.object({ negotiation: z.string(), event: z.enum(['reply', 'accepted', 'walked-away']), message: z.string() });
function readVendor(body: z.infer<typeof vendorEvent>): SupplyOf<typeof Negotiation> {
  if (body.event === 'accepted') return { update: body.negotiation, patch: { lastVendorMessage: body.message }, state: 'agreed' };
  if (body.event === 'walked-away') return { update: body.negotiation, patch: { lastVendorMessage: body.message }, state: 'they-walked-away' };
  return { update: body.negotiation, patch: { lastVendorMessage: body.message }, state: 'drafting-offer' };
}

const experimentLane = H.lane('experiments', Experiment).handler(experimentFlow).suppliers(H.operator).store(sqlite.store(Experiment, store));
const tenancyLane = H.lane('tenancies', Tenancy)
  .handler(tenancyFlow)
  .suppliers(H.operator, http.webhook(Tenancy, { path: '/billing', secret: H.env('BILLING_WEBHOOK_SECRET'), body: billingEvent, read: readBilling }))
  .store(sqlite.store(Tenancy, store));
const negotiationLane = H.lane('negotiations', Negotiation)
  .handler(negotiationFlow)
  .suppliers(H.operator, http.webhook(Negotiation, { path: '/vendor-replies', secret: H.env('VENDOR_WEBHOOK_SECRET'), body: vendorEvent, read: readVendor }))
  .store(sqlite.store(Negotiation, store))
  .maxUsdPerUnit(5);

const negotiationExpires = H.trigger(
  'negotiation-expires',
  H.on.deadline(Negotiation, deal => new Date(deal.expiresAt), ['drafting-offer', 'awaiting-vendor']),
  (_event, act) => act.move('expired')
);

const lifecycleScheduler = H.policy.scheduler('lifecycle-mix', view => {
  const outcomes = view.metrics.rate({
    among: { entry: 'transition', kind: Experiment, position: 'terminal' },
    count: { entry: 'transition', kind: Experiment, state: inconclusive },
    days: 90,
  });
  const mostlyInconclusive = outcomes.samples >= 10 && (outcomes.value ?? 0) > 0.5;
  const start = view.pending
    .filter(unit => !(mostlyInconclusive && unit.lane === experimentLane.name && unit.state === 'proposed'))
    .sort((x, y) => y.waitedMs - x.waitedMs);
  return { start };
});

export const lifecycles = H.harness('lifecycles')
  .ledger(sqlite.ledger('lifecycles/ledger.db'))
  .lanes(experimentLane, tenancyLane, negotiationLane)
  .pools(H.pool('api', [{ account: anthropic.account('lifecycles-api', { apiKey: H.env('ANTHROPIC_API_KEY') }), share: 1 }]))
  .triggers(negotiationExpires)
  .scheduler(lifecycleScheduler)
  .clients(claudeCode.supervisor({ grants: [H.ops.readWork, H.ops.writeWork, H.ops.resolveHalts, H.ops.readTelemetry] }))
  .observers(markdown.board('lifecycles/board.md'), markdown.telemetry('lifecycles/telemetry.md'));
