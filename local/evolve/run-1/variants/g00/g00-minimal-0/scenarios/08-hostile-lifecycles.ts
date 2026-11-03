import { z } from 'zod';
import { H } from 'harness-dsl';
import * as anthropic from 'harness-dsl/anthropic';
import * as sqlite from 'harness-dsl/sqlite';
import * as shell from 'harness-dsl/shell';
import * as http from 'harness-dsl/http';
import * as claudeCode from 'harness-dsl/claude-code';
import * as markdown from 'harness-dsl/markdown';

const hourMs = 60 * 60 * 1000;
const dayMs = 24 * hourMs;
const local = shell.local('local', { slots: 4 });

const Experiment = H.kind('Experiment').data(z.object({
  name: z.string(),
  startedAt: z.string(),
  observations: z.array(z.object({ at: z.string(), a: z.number(), b: z.number() })),
})).states({
  scheduled: 'pending',
  measuring: 'active',
  waiting: 'idle',
  'a-wins': 'ended',
  'b-wins': 'ended',
  inconclusive: 'ended',
  cancelled: 'cancelled',
}, 'scheduled');

const measure = H.command('measure-experiment')
  .input(z.object({ name: z.string() }))
  .output(z.object({ a: z.number(), b: z.number() }))
  .argv(input => ['experiment-metric', '--json', input.name])
  .on(local);

const mean = (values: readonly number[]) => values.length === 0 ? 0 : values.reduce((s, v) => s + v, 0) / values.length;

const experimentFlow = H.flow('hourly-measurement').for(Experiment).does(async ctx => {
  await ctx.move('measuring');
  const now = ctx.now();
  const sample = await ctx.run(measure, { name: ctx.unit.data.name });
  const observations = sample.ok
    ? [...ctx.unit.data.observations, { at: now.toISOString(), a: sample.value.a, b: sample.value.b }]
    : ctx.unit.data.observations;
  await ctx.update({ observations });
  if (now.getTime() - Date.parse(ctx.unit.data.startedAt) < 14 * dayMs) {
    return ctx.until('waiting', { at: new Date(now.getTime() + hourMs), then: 'scheduled' });
  }
  const a = mean(observations.map(o => o.a));
  const b = mean(observations.map(o => o.b));
  const lift = Math.abs(a - b) / Math.max(Math.abs(a), Math.abs(b), Number.EPSILON);
  if (lift < 0.05) return 'inconclusive';
  return a > b ? 'a-wins' : 'b-wins';
});

const experimentLane = H.lane('experiments', Experiment)
  .handler(experimentFlow)
  .suppliers(H.operator)
  .store(sqlite.store(Experiment, '.harness/experiments.db'));

const Tenancy = H.kind('Tenancy').data(z.object({
  customer: z.string(),
  plan: z.string(),
  lastSummary: z.string().optional(),
})).states({
  onboarding: 'pending',
  'review-due': 'pending',
  reviewing: 'active',
  current: 'idle',
  suspended: 'idle',
  churned: 'ended',
}, 'onboarding');

const usageReview = H.command('usage-review')
  .input(z.object({ customer: z.string() }))
  .argv(input => ['usage-report', input.customer])
  .on(local);

const accountSummaryRole = H.role('account-summary')
  .input(z.object({ customer: z.string(), plan: z.string(), usage: z.string() }))
  .output(z.object({ summary: z.string() }))
  .prompt(input => `Summarise the month for ${input.customer} on ${input.plan}:\n\n${input.usage}`);

const sonnet = anthropic.model('claude-sonnet');
const accountSummarizer = H.agent('account-summarizer', accountSummaryRole).model(sonnet);

const tenancyFlow = H.flow('monthly-review').for(Tenancy).does(async ctx => {
  await ctx.move('reviewing');
  const { customer, plan } = ctx.unit.data;
  const usage = await ctx.run(usageReview, { customer });
  const summary = await ctx.run(accountSummarizer, { customer, plan, usage: usage.ok ? usage.value : usage.error });
  const summaryText = summary.ok ? summary.value.summary : 'Summary unavailable.';
  await ctx.update({ lastSummary: summaryText });
  const decision = await ctx.halt({
    name: 'upsell-decision',
    show: summaryText,
    decision: z.object({ upsell: z.boolean() }),
  });
  ctx.tag({ upsell: decision.upsell ? 'yes' : 'no' });
  return ctx.until('current', { at: new Date(ctx.now().getTime() + 30 * dayMs), then: 'review-due' });
});

const billingEvent = z.object({
  customer: z.string(),
  event: z.enum(['suspended', 'reinstated', 'churned']),
});

const tenancyLane = H.lane('tenancies', Tenancy)
  .handler(tenancyFlow)
  .suppliers(
    H.operator,
    http.webhook(Tenancy, {
      path: '/hooks/billing',
      secret: H.env('BILLING_WEBHOOK_SECRET'),
      body: billingEvent,
      read: body => ({
        update: body.customer,
        state: body.event === 'suspended' ? 'suspended' : body.event === 'reinstated' ? 'review-due' : 'churned',
      }),
    }),
  )
  .store(sqlite.store(Tenancy, '.harness/tenancies.db'));

const Negotiation = H.kind('Negotiation').data(z.object({
  vendor: z.string(),
  item: z.string(),
  expiresAt: z.string(),
  round: z.number(),
  lastOffer: z.string().optional(),
  vendorMessage: z.string().optional(),
})).states({
  opening: 'pending',
  'vendor-replied': 'pending',
  drafting: 'active',
  'awaiting-vendor': 'idle',
  agreed: 'succeeded',
  'walked-away-us': 'ended',
  'walked-away-them': 'ended',
  expired: 'ended',
}, 'opening');

const negotiatorRole = H.role('negotiator')
  .input(z.object({ vendor: z.string(), item: z.string(), lastOffer: z.string().optional(), vendorMessage: z.string().optional() }))
  .output(z.object({ move: z.enum(['offer', 'accept', 'walk-away']), message: z.string() }))
  .prompt(input => `Negotiate ${input.item} with ${input.vendor}. Our last offer: ${input.lastOffer ?? 'none'}. Their reply: ${input.vendorMessage ?? 'none'}.`);

const negotiator = H.agent('negotiator', negotiatorRole).model(anthropic.model('claude-opus'));

const sendToVendor = H.command('send-to-vendor')
  .input(z.object({ vendor: z.string(), message: z.string() }))
  .argv(input => ['vendor-mail', input.vendor, '--body', input.message])
  .on(local);

const negotiationFlow = H.flow('negotiation-round').for(Negotiation).does(async ctx => {
  await ctx.move('drafting');
  const { vendor, item, lastOffer, vendorMessage } = ctx.unit.data;
  const proposal = await ctx.run(negotiator, { vendor, item, lastOffer, vendorMessage });
  if (!proposal.ok) return 'vendor-replied';
  if (proposal.value.move === 'walk-away') {
    const confirm = await ctx.halt({
      name: 'confirm-walk-away',
      show: proposal.value.message,
      decision: z.object({ walkAway: z.boolean() }),
    });
    if (confirm.walkAway) return 'walked-away-us';
  }
  const sent = await ctx.run(sendToVendor, { vendor, message: proposal.value.message });
  if (!sent.ok) return 'vendor-replied';
  if (proposal.value.move === 'accept') return 'agreed';
  await ctx.update({ lastOffer: proposal.value.message, round: ctx.unit.data.round + 1 });
  return 'awaiting-vendor';
});

const vendorReply = z.object({
  negotiationId: z.string(),
  outcome: z.enum(['counter', 'accept', 'walk-away']),
  message: z.string(),
});

const negotiationLane = H.lane('negotiations', Negotiation)
  .handler(negotiationFlow)
  .suppliers(
    H.operator,
    http.webhook(Negotiation, {
      path: '/hooks/vendor-replies',
      secret: H.env('VENDOR_WEBHOOK_SECRET'),
      body: vendorReply,
      read: body => ({
        update: body.negotiationId,
        patch: { vendorMessage: body.message },
        state: body.outcome === 'counter' ? 'vendor-replied' : body.outcome === 'accept' ? 'agreed' : 'walked-away-them',
      }),
    }),
  )
  .store(sqlite.store(Negotiation, '.harness/negotiations.db'));

const negotiationExpiry = H.trigger(
  'negotiation-expiry',
  H.on.deadline(Negotiation, data => new Date(data.expiresAt), ['opening', 'vendor-replied', 'drafting', 'awaiting-vendor']),
  (_event, act) => act.move('expired'),
);

const experimentsWorthRunning = H.policy.schedule('experiments-worth-running', view => {
  const inconclusive = view.metrics.rate({
    among: { entry: 'transition', kind: Experiment.name, outcome: ['succeeded', 'failed', 'ended'] },
    count: { entry: 'transition', kind: Experiment.name, state: 'inconclusive' },
    days: 180,
  });
  const holdNewExperiments = inconclusive.samples >= 10 && (inconclusive.value ?? 0) > 0.6;
  const start = [...view.pending]
    .filter(unit => !(holdNewExperiments && unit.is(Experiment) && unit.state === 'scheduled' && unit.data.observations.length === 0))
    .sort((a, b) => b.waitedMs - a.waitedMs);
  return { start };
});

const pool = H.pool('anthropic', [
  { account: anthropic.account('business-api', { apiKey: H.env('ANTHROPIC_API_KEY') }), share: 1 },
], H.policy.account('first-eligible', choice => choice.accounts.find(view => view.eligible)?.account ?? null));

export const harness = H.harness('long-lived-work')
  .ledger(sqlite.ledger('.harness/ledger.db'))
  .lanes(experimentLane, tenancyLane, negotiationLane)
  .pools(pool)
  .triggers(negotiationExpiry)
  .scheduler(experimentsWorthRunning)
  .clients(claudeCode.supervisor({
    grants: [H.ops.readWork, H.ops.writeWork, H.ops.resolveHalts, H.ops.readTelemetry],
  }))
  .observers(markdown.board('BOARD.md'), markdown.telemetry('TELEMETRY.md'));
