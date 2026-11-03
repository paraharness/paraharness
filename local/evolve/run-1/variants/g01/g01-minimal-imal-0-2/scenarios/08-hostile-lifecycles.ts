import { z } from 'zod';
import { H } from 'harness-dsl';
import type { SupplyOf } from 'harness-dsl';
import * as anthropic from 'harness-dsl/anthropic';
import * as claudeCode from 'harness-dsl/claude-code';
import * as http from 'harness-dsl/http';
import * as sqlite from 'harness-dsl/sqlite';
import * as shell from 'harness-dsl/shell';
import * as markdown from 'harness-dsl/markdown';

const hourMs = 60 * 60 * 1000;
const tools = shell.local('ops-tools', { slots: 4 });
const analyst = anthropic.model('claude-sonnet-4-5');

const measureDue = H.state('measure-due', 'pending');
const measuring = H.state('measuring', 'active');
const collecting = H.state('collecting', 'waiting');
const aWins = H.state('a-wins', 'terminal', 'success');
const bWins = H.state('b-wins', 'terminal', 'success');
const inconclusive = H.state('inconclusive', 'terminal', 'neutral');

const reading = z.object({ a: z.number(), b: z.number() });
type Reading = z.infer<typeof reading>;

const Experiment = H.kind('Experiment')
  .data(z.object({ name: z.string(), metric: z.string(), endsAt: z.string(), readings: z.array(reading) }))
  .states(measureDue, measuring, collecting, aWins, bWins, inconclusive);

const readMetric = H.command('experiment-metric')
  .input(z.object({ experiment: z.string(), metric: z.string() }))
  .output(reading)
  .argv(i => ['experiment-metric', '--experiment', i.experiment, '--metric', i.metric, '--json'])
  .on(tools)
  .recovery('rerun');

type ExperimentResult = 'a-wins' | 'b-wins' | 'inconclusive';

function average(values: readonly number[]): number {
  return values.length === 0 ? 0 : values.reduce((s, v) => s + v, 0) / values.length;
}

const experimentVerdict = H.policy.rule('experiment-verdict', (readings: readonly Reading[]): ExperimentResult => {
  if (readings.length < 24) return 'inconclusive';
  const a = average(readings.map(r => r.a));
  const b = average(readings.map(r => r.b));
  const lift = (b - a) / Math.max(Math.abs(a), 1e-9);
  if (lift > 0.05) return 'b-wins';
  if (lift < -0.05) return 'a-wins';
  return 'inconclusive';
});

const experimentFlow = H.flow('experiment').for(Experiment).does(async ctx => {
  const experiment = ctx.unit.data;
  const measured = await ctx.run(readMetric, { experiment: experiment.name, metric: experiment.metric });
  if (!measured.ok) return ctx.fail(measured.error);
  const readings = [...experiment.readings, measured.value];
  await ctx.update({ readings });
  const now = ctx.now();
  if (now < new Date(experiment.endsAt)) {
    return ctx.until('collecting', { at: new Date(now.getTime() + hourMs), then: 'measure-due' });
  }
  return ctx.decide(experimentVerdict, readings);
});

const reviewDue = H.state('review-due', 'pending');
const reviewing = H.state('reviewing', 'active');
const betweenReviews = H.state('between-reviews', 'waiting');
const suspended = H.state('suspended', 'waiting');
const churned = H.state('churned', 'terminal', 'neutral');

const Tenancy = H.kind('Tenancy')
  .data(z.object({ customer: z.string(), plan: z.string(), lastDecision: z.enum(['upsell', 'hold']).optional() }))
  .states(reviewDue, reviewing, betweenReviews, suspended, churned);

const usageReport = H.command('usage-report')
  .input(z.object({ customer: z.string() }))
  .output(z.object({ seats: z.number(), activeUsers: z.number(), spendUsd: z.number() }))
  .argv(i => ['usage-report', '--customer', i.customer, '--json'])
  .on(tools)
  .recovery('rerun');

const summarizeAccount = H.role('summarize-account')
  .input(z.object({ customer: z.string(), plan: z.string(), seats: z.number(), activeUsers: z.number(), spendUsd: z.number() }))
  .output(z.object({ summary: z.string() }))
  .prompt(u => `Summarise last month for ${u.customer} on ${u.plan}: ${u.activeUsers}/${u.seats} seats active, $${u.spendUsd} spent. Recommend upsell or hold.`);
const accountSummarizer = H.agent('account-summarizer', summarizeAccount).model(analyst);

function nextMonth(from: Date): Date {
  return new Date(from.getFullYear(), from.getMonth() + 1, 1, 9);
}

const tenancyFlow = H.flow('tenancy-review').for(Tenancy).does(async ctx => {
  const tenancy = ctx.unit.data;
  const usage = await ctx.run(usageReport, { customer: tenancy.customer });
  if (!usage.ok) return ctx.fail(usage.error);
  const summary = await ctx.run(accountSummarizer, { customer: tenancy.customer, plan: tenancy.plan, ...usage.value });
  if (!summary.ok) return ctx.fail(summary.error);
  const decision = await ctx.halt({
    name: 'upsell-decision',
    show: summary.value.summary,
    decision: z.object({ upsell: z.boolean(), note: z.string().optional() }),
  });
  await ctx.update({ lastDecision: decision.upsell ? 'upsell' : 'hold' });
  return ctx.until('between-reviews', { at: nextMonth(ctx.now()), then: 'review-due' });
});

const billingEvent = z.object({
  event: z.enum(['signed-up', 'suspended', 'reinstated', 'churned']),
  customer: z.string(),
  plan: z.string(),
});

function tenancySupply(body: z.infer<typeof billingEvent>): SupplyOf<typeof Tenancy> {
  switch (body.event) {
    case 'signed-up':
      return { create: { customer: body.customer, plan: body.plan }, key: body.customer };
    case 'suspended':
      return { update: body.customer, state: 'suspended' };
    case 'reinstated':
      return { update: body.customer, patch: { plan: body.plan }, state: 'review-due' };
    case 'churned':
      return { update: body.customer, state: 'churned' };
  }
}

const billing = http.webhook(Tenancy, {
  path: '/hooks/billing',
  secret: H.env('BILLING_WEBHOOK_SECRET'),
  body: billingEvent,
  read: tenancySupply,
});

const drafting = H.state('drafting', 'pending');
const offering = H.state('offering', 'active');
const awaitingVendor = H.state('awaiting-vendor', 'waiting');
const agreed = H.state('agreed', 'terminal', 'success');
const walkedAway = H.state('walked-away', 'terminal', 'neutral');
const vendorWalkedAway = H.state('vendor-walked-away', 'terminal', 'neutral');
const expired = H.state('expired', 'terminal', 'neutral');

const Negotiation = H.kind('Negotiation')
  .data(z.object({
    vendor: z.string(),
    item: z.string(),
    maxUsd: z.number(),
    expiresAt: z.string(),
    round: z.number(),
    vendorMessage: z.string().optional(),
    lastOfferUsd: z.number().optional(),
  }))
  .states(drafting, offering, awaitingVendor, agreed, walkedAway, vendorWalkedAway, expired);

const draftOffer = H.role('draft-offer')
  .input(z.object({
    vendor: z.string(),
    item: z.string(),
    maxUsd: z.number(),
    round: z.number(),
    vendorMessage: z.string(),
    lastOfferUsd: z.number(),
  }))
  .output(z.object({ walkAway: z.boolean(), offerUsd: z.number(), message: z.string() }))
  .prompt(n => `Round ${n.round} with ${n.vendor} for ${n.item}. Our ceiling is $${n.maxUsd}; last offer $${n.lastOfferUsd}. Vendor said:\n${n.vendorMessage}\nDraft the next offer or recommend walking away.`);
const negotiator = H.agent('negotiator', draftOffer).model(analyst);

const sendOffer = H.command('send-offer')
  .input(z.object({ vendor: z.string(), message: z.string() }))
  .argv(o => ['procurement-mail', '--to', o.vendor, '--body', o.message])
  .on(tools)
  .recovery('park');

const negotiationFlow = H.flow('negotiation-round').for(Negotiation).does(async ctx => {
  const n = ctx.unit.data;
  const next = await ctx.run(negotiator, {
    vendor: n.vendor,
    item: n.item,
    maxUsd: n.maxUsd,
    round: n.round,
    vendorMessage: n.vendorMessage ?? '',
    lastOfferUsd: n.lastOfferUsd ?? 0,
  });
  if (!next.ok) return ctx.fail(next.error);
  if (next.value.walkAway) return 'walked-away';
  const sent = await ctx.run(sendOffer, { vendor: n.vendor, message: next.value.message });
  if (!sent.ok) return ctx.fail(sent.error);
  await ctx.update({ round: n.round + 1, lastOfferUsd: next.value.offerUsd });
  return 'awaiting-vendor';
});

const vendorReply = z.object({
  negotiation: z.string(),
  reply: z.enum(['counter', 'accepted', 'walked-away']),
  message: z.string(),
});

function negotiationSupply(body: z.infer<typeof vendorReply>): SupplyOf<typeof Negotiation> {
  switch (body.reply) {
    case 'counter':
      return { update: body.negotiation, patch: { vendorMessage: body.message }, state: 'drafting' };
    case 'accepted':
      return { update: body.negotiation, patch: { vendorMessage: body.message }, state: 'agreed' };
    case 'walked-away':
      return { update: body.negotiation, patch: { vendorMessage: body.message }, state: 'vendor-walked-away' };
  }
}

const vendorReplies = http.webhook(Negotiation, {
  path: '/hooks/vendor-replies',
  secret: H.env('VENDOR_WEBHOOK_SECRET'),
  body: vendorReply,
  read: negotiationSupply,
});

const negotiationExpiry = H.trigger(
  'negotiation-expiry',
  H.on.deadline(Negotiation, n => new Date(n.expiresAt), ['drafting', 'offering', 'awaiting-vendor']),
  (_event, act) => act.move('expired'),
);

const experiments = H.lane('experiments', Experiment)
  .handler(experimentFlow)
  .suppliers(H.operator)
  .store(sqlite.store(Experiment, 'lifecycles/experiments.db'));
const tenancies = H.lane('tenancies', Tenancy)
  .handler(tenancyFlow)
  .suppliers(billing, H.operator)
  .store(sqlite.store(Tenancy, 'lifecycles/tenancies.db'))
  .wip(3);
const negotiations = H.lane('negotiations', Negotiation)
  .handler(negotiationFlow)
  .suppliers(vendorReplies, H.operator)
  .store(sqlite.store(Negotiation, 'lifecycles/negotiations.db'));

const portfolio = H.policy.scheduler('portfolio', view => {
  const inconclusiveShare = view.metrics.rate({
    among: { entry: 'transition', kind: Experiment.name, position: 'terminal' },
    count: { entry: 'transition', kind: Experiment.name, state: 'inconclusive' },
    days: 90,
  });
  const holdNewExperiments = inconclusiveShare.samples >= 10 && (inconclusiveShare.value ?? 0) > 0.5;
  const ordered = [...view.pending].sort((x, y) => y.waitedMs - x.waitedMs);
  return {
    start: holdNewExperiments
      ? ordered.filter(u => !(u.is(Experiment) && u.data.readings.length === 0))
      : ordered,
  };
});

const desk = claudeCode.supervisor({
  grants: [H.ops.readWork, H.ops.writeWork, H.ops.resolveHalts, H.ops.readTelemetry],
});

export const running = H.harness('lifecycles')
  .ledger(sqlite.ledger('lifecycles/ledger.db'))
  .lanes(experiments, tenancies, negotiations)
  .pools(H.pool('analysis', [{ account: anthropic.account('analysis', { apiKey: H.env('ANTHROPIC_API_KEY') }), share: 1 }]))
  .triggers(negotiationExpiry)
  .scheduler(portfolio)
  .clients(desk)
  .observers(markdown.board('lifecycles/BOARD.md'), markdown.telemetry('lifecycles/TELEMETRY.md'))
  .start();
