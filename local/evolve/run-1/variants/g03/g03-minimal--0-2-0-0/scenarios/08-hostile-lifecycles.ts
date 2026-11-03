import { z } from 'zod';
import { H } from 'harness-dsl';
import type { Metrics, PendingView, SupplyOf } from 'harness-dsl';
import * as anthropic from 'harness-dsl/anthropic';
import * as cc from 'harness-dsl/claude-code';
import * as http from 'harness-dsl/http';
import * as markdown from 'harness-dsl/markdown';
import * as shell from 'harness-dsl/shell';
import * as sqlite from 'harness-dsl/sqlite';

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

const measuring = H.state('measuring', 'pending');
const resting = H.state('resting', 'waiting');
const aWins = H.state('aWins', 'terminal', 'success');
const bWins = H.state('bWins', 'terminal', 'success');
const inconclusive = H.state('inconclusive', 'terminal', 'neutral');

const reading = z.object({ a: z.number(), b: z.number() });

const Experiment = H.kind('experiment')
  .data(z.object({ name: z.string(), endsAt: z.string(), readings: z.array(reading) }))
  .states(measuring, resting, aWins, bWins, inconclusive);

const reviewDue = H.state('reviewDue', 'pending');
const betweenReviews = H.state('betweenReviews', 'waiting');
const suspended = H.state('suspended', 'waiting');
const churned = H.state('churned', 'terminal', 'neutral');

const Tenancy = H.kind('tenancy')
  .data(z.object({ tenant: z.string(), lastDecision: z.enum(['upsell', 'hold']).optional() }))
  .states(reviewDue, betweenReviews, suspended, churned);

const drafting = H.state('drafting', 'pending');
const awaitingVendor = H.state('awaitingVendor', 'waiting');
const agreed = H.state('agreed', 'terminal', 'success');
const walkedAwayByUs = H.state('walkedAwayByUs', 'terminal', 'neutral');
const walkedAwayByThem = H.state('walkedAwayByThem', 'terminal', 'failure');
const expired = H.state('expired', 'terminal', 'neutral');

const Negotiation = H.kind('negotiation')
  .data(
    z.object({
      item: z.string(),
      vendor: z.string(),
      expiresAt: z.string(),
      history: z.array(z.string()),
      vendorMessage: z.string().optional(),
    }),
  )
  .states(drafting, awaitingVendor, agreed, walkedAwayByUs, walkedAwayByThem, expired);

const local = shell.local('local', { slots: 4 });

const readExperiment = H.command('read-experiment-metric')
  .input(z.object({ experiment: z.string() }))
  .output(reading)
  .argv((target) => ['experiment-metric', '--json', target.experiment])
  .on(local)
  .recovers('rerun');

const judge = H.policy.rule(
  'judge-experiment',
  { input: z.object({ readings: z.array(reading) }), output: z.enum(['aWins', 'bWins', 'inconclusive']) },
  ({ readings }) => {
    if (readings.length < 24) return 'inconclusive';
    const meanA = readings.reduce((sum, r) => sum + r.a, 0) / readings.length;
    const meanB = readings.reduce((sum, r) => sum + r.b, 0) / readings.length;
    const lift = (meanB - meanA) / Math.max(Math.abs(meanA), 1e-9);
    return lift > 0.05 ? 'bWins' : lift < -0.05 ? 'aWins' : 'inconclusive';
  },
);

const experimentFlow = H.flow('experiment')
  .for(Experiment)
  .does(async (ctx) => {
    const taken = await ctx.run(readExperiment, { experiment: ctx.unit.data.name });
    if (!taken.ok) return ctx.fail(taken.error);
    const readings = [...ctx.unit.data.readings, taken.value];
    await ctx.update({ readings });
    const now = await ctx.now();
    if (now.getTime() < Date.parse(ctx.unit.data.endsAt)) {
      return ctx.wait('resting', { at: new Date(now.getTime() + HOUR_MS), then: 'measuring' });
    }
    return ctx.decide(judge, { readings });
  });

const usageReport = H.command('usage-report')
  .input(z.object({ tenant: z.string() }))
  .output(z.object({ report: z.string() }))
  .argv((target) => ['usage-report', '--json', target.tenant])
  .on(local)
  .recovers('rerun');

const accountSummary = H.role('account-summary')
  .input(z.object({ tenant: z.string(), usage: z.string() }))
  .output(z.object({ summary: z.string() }))
  .prompt((review) => `Summarise this month's usage for ${review.tenant} for an upsell decision.\n\n${review.usage}`);

const negotiatorRole = H.role('negotiator')
  .input(z.object({ item: z.string(), vendor: z.string(), history: z.array(z.string()) }))
  .output(z.object({ action: z.enum(['offer', 'accept', 'walkAway']), message: z.string() }))
  .prompt((round) => `Negotiate ${round.item} with ${round.vendor}. Conversation so far:\n${round.history.join('\n')}`);

const strong = anthropic.model('claude-opus-4-1');
const summarizer = H.agent('account-summarizer', accountSummary).model(anthropic.model('claude-sonnet-4-5'));
const negotiator = H.agent('negotiator', negotiatorRole).model(strong);

const upsellDecision = H.halt('upsell-decision', z.object({ upsell: z.boolean(), note: z.string() }));

const tenancyFlow = H.flow('tenancy-review')
  .for(Tenancy)
  .does(async (ctx) => {
    const usage = await ctx.run(usageReport, { tenant: ctx.unit.data.tenant });
    if (!usage.ok) return ctx.fail(usage.error);
    const summary = await ctx.run(summarizer, { tenant: ctx.unit.data.tenant, usage: usage.value.report });
    if (!summary.ok) return ctx.fail(summary.error);
    const choice = await ctx.halt(upsellDecision, summary.value.summary);
    await ctx.update({ lastDecision: choice.upsell ? 'upsell' : 'hold' });
    const now = await ctx.now();
    return ctx.wait('betweenReviews', { at: new Date(now.getTime() + 30 * DAY_MS), then: 'reviewDue' });
  });

const sendToVendor = H.command('send-to-vendor')
  .input(z.object({ vendor: z.string(), message: z.string() }))
  .argv((note) => ['send-vendor-message', '--vendor', note.vendor, '--message', note.message])
  .on(local)
  .recovers('park');

const negotiationFlow = H.flow('negotiation-round')
  .for(Negotiation)
  .does(async (ctx) => {
    const { item, vendor, history, vendorMessage } = ctx.unit.data;
    const heard = vendorMessage === undefined ? history : [...history, `Vendor: ${vendorMessage}`];
    const next = await ctx.run(negotiator, { item, vendor, history: heard });
    if (!next.ok) return ctx.fail(next.error);
    const sent = await ctx.run(sendToVendor, { vendor, message: next.value.message });
    if (!sent.ok) return ctx.fail(sent.error);
    await ctx.update({ history: [...heard, `Us: ${next.value.message}`], vendorMessage: undefined });
    if (next.value.action === 'accept') return 'agreed';
    if (next.value.action === 'walkAway') return 'walkedAwayByUs';
    return 'awaitingVendor';
  });

const billingEvent = z.object({
  tenant: z.string(),
  event: z.enum(['signedUp', 'suspended', 'reinstated', 'churned']),
});

const fromBilling = (event: z.infer<typeof billingEvent>): SupplyOf<typeof Tenancy> =>
  event.event === 'signedUp'
    ? { create: { tenant: event.tenant }, key: event.tenant }
    : event.event === 'suspended'
      ? { update: event.tenant, state: 'suspended' }
      : event.event === 'reinstated'
        ? { update: event.tenant, state: 'reviewDue' }
        : { update: event.tenant, state: 'churned' };

const vendorReply = z.object({ negotiation: z.string(), message: z.string(), walkAway: z.boolean() });

const experiments = H.lane('experiments', Experiment)
  .handler(experimentFlow)
  .suppliers(H.operator)
  .store(sqlite.store(Experiment, '.harness/experiments.db'));

const tenancies = H.lane('tenancies', Tenancy)
  .handler(tenancyFlow)
  .suppliers(
    http.webhook(Tenancy, {
      path: '/billing/events',
      secret: H.env('BILLING_WEBHOOK_SECRET'),
      body: billingEvent,
      read: fromBilling,
    }),
  )
  .store(sqlite.store(Tenancy, '.harness/tenancies.db'));

const negotiations = H.lane('negotiations', Negotiation)
  .handler(negotiationFlow)
  .suppliers(
    H.operator,
    http.webhook(Negotiation, {
      path: '/vendors/replies',
      secret: H.env('VENDOR_WEBHOOK_SECRET'),
      body: vendorReply,
      read: (reply) => ({
        update: reply.negotiation,
        patch: { vendorMessage: reply.message },
        state: reply.walkAway ? 'walkedAwayByThem' : 'drafting',
      }),
    }),
  )
  .store(sqlite.store(Negotiation, '.harness/negotiations.db'));

const negotiationExpiry = H.trigger(
  'negotiation-expiry',
  H.on.deadline(Negotiation, (data) => new Date(data.expiresAt), ['drafting', 'awaitingVendor']),
  (_event, act) => act.move('expired'),
);

const inconclusiveRate = (metrics: Metrics) =>
  metrics.rate({
    among: { entry: 'transition', kind: Experiment, position: 'terminal' },
    count: { entry: 'transition', kind: Experiment, state: inconclusive },
    days: 90,
  });

const lifecycleScheduler = H.policy.scheduler('lifecycle-scheduler', ({ pending, metrics }) => {
  const rate = inconclusiveRate(metrics);
  const experimentsLast = rate.samples >= 10 && rate.value !== null && rate.value > 0.5;
  const rank = (unit: PendingView) =>
    unit.is(Negotiation) ? 0 : unit.is(Tenancy) ? 1 : experimentsLast ? 3 : 2;
  return { start: [...pending].sort((a, b) => rank(a) - rank(b)) };
});

const api = anthropic.account('anthropic-api', { apiKey: H.env('ANTHROPIC_API_KEY') });

export const harness = H.harness('hostile-lifecycles')
  .ledger(sqlite.ledger('.harness/ledger.db'))
  .lanes(experiments, tenancies, negotiations)
  .pools(H.pool('accounts', [{ account: api, share: 1 }]))
  .triggers(negotiationExpiry)
  .scheduler(lifecycleScheduler)
  .clients(
    cc.supervisor({
      grants: [H.ops.readWork, H.ops.writeWork, H.ops.resolveHalts, H.ops.readTelemetry],
    }),
  )
  .observers(markdown.board('BOARD.md'), markdown.telemetry('TELEMETRY.md'));
