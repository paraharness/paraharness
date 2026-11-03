import { z } from 'zod';
import { H } from 'harness-dsl';
import type { Metrics, Rate } from 'harness-dsl';
import type { Supply } from 'harness-dsl/kernel';
import * as anthropic from 'harness-dsl/anthropic';
import * as http from 'harness-dsl/http';
import * as sqlite from 'harness-dsl/sqlite';
import * as shell from 'harness-dsl/shell';
import * as markdown from 'harness-dsl/markdown';
import { supervisor } from 'harness-dsl/claude-code';

const hourMs = 60 * 60 * 1000;
const dayMs = 24 * hourMs;

const lab = shell.local('lab', { slots: 4 });
const api = anthropic.account('lifecycles-api', { apiKey: H.env('ANTHROPIC_API_KEY') });
const sonnet = anthropic.model('claude-sonnet-4-5');
const opus = anthropic.model('claude-opus-4-1');
const models = H.pool('models', [{ account: api, share: 1 }]);

const observation = z.object({ variantA: z.number(), variantB: z.number() });
type Observation = z.infer<typeof observation>;
type ExperimentVerdict = 'a-wins' | 'b-wins' | 'inconclusive';

const proposed = H.state('proposed', 'pending');
const measuring = H.state('measuring', 'active');
const observing = H.state('observing', 'waiting');
const aWins = H.state('a-wins', 'terminal', 'success');
const bWins = H.state('b-wins', 'terminal', 'success');
const inconclusive = H.state('inconclusive', 'terminal', 'neutral');

const Experiment = H.kind('Experiment')
  .data(z.object({ name: z.string(), hypothesis: z.string(), durationDays: z.number() }))
  .states(proposed, measuring, observing, aWins, bWins, inconclusive);

const measure = H.command('measure-variants')
  .input(z.object({ experiment: z.string() }))
  .output(observation)
  .argv((e) => ['experiment-metric', e.experiment])
  .on(lab)
  .recovery('rerun');

const verdict = H.policy.rule('experiment-verdict', (samples: Observation[]): ExperimentVerdict => {
  if (samples.length < 24) return 'inconclusive';
  const meanA = samples.reduce((sum, o) => sum + o.variantA, 0) / samples.length;
  const meanB = samples.reduce((sum, o) => sum + o.variantB, 0) / samples.length;
  const lift = (meanA - meanB) / Math.max(Math.abs(meanB), 1e-9);
  if (lift > 0.05) return 'a-wins';
  if (lift < -0.05) return 'b-wins';
  return 'inconclusive';
});

const runExperiment = H.flow('run-experiment')
  .for(Experiment)
  .phases('measuring', 'observing')
  .exits('a-wins', 'b-wins', 'inconclusive')
  .does(async (ctx) => {
    const endsAt = ctx.now().getTime() + ctx.unit.data.durationDays * dayMs;
    const samples: Observation[] = [];
    while (ctx.now().getTime() < endsAt) {
      await ctx.move('measuring');
      const sample = await ctx.run(measure, { experiment: ctx.unit.data.name });
      if (sample.ok) samples.push(sample.value);
      await ctx.wait('observing', { at: new Date(ctx.now().getTime() + hourMs) });
    }
    return ctx.decide(verdict, samples);
  });

const experiments = H.lane('experiments', Experiment)
  .handler(runExperiment, { measuring, observing, 'a-wins': aWins, 'b-wins': bWins, inconclusive })
  .suppliers(H.operator)
  .store(sqlite.store(Experiment, '.harness/experiments.db'));

function inconclusiveRate(metrics: Metrics): Rate {
  return metrics.rate({
    among: { entry: 'transition', kind: Experiment, position: 'terminal' },
    count: { entry: 'transition', kind: Experiment, state: inconclusive },
    days: 180,
  });
}

const tenancyData = z.object({
  tenantId: z.string(),
  customer: z.string(),
  nextReviewAt: z.string(),
  lastDecision: z.string().optional(),
});
type TenancyData = z.infer<typeof tenancyData>;

const reviewDue = H.state('review-due', 'pending');
const underReview = H.state('under-review', 'active');
const betweenReviews = H.state('between-reviews', 'waiting');
const suspended = H.state('suspended', 'waiting');
const churned = H.state('churned', 'terminal', 'neutral');

const Tenancy = H.kind('Tenancy')
  .data(tenancyData)
  .states(reviewDue, underReview, betweenReviews, suspended, churned);

const usageReport = H.command('usage-report')
  .input(z.object({ tenantId: z.string() }))
  .argv((t) => ['usage-report', '--tenant', t.tenantId])
  .on(lab);

const accountSummaryRole = H.role('account-summary')
  .input(z.object({ customer: z.string(), usage: z.string() }))
  .output(z.object({ summary: z.string() }))
  .prompt((t) => `Summarise last month's usage for ${t.customer} and note upsell signals.\n\n${t.usage}`);

const accountSummary = H.agent('account-summarizer', accountSummaryRole).model(sonnet);

const tenancyDecision = H.halt('tenancy-decision', z.object({
  action: z.enum(['upsell', 'keep', 'suspend', 'churn']),
  note: z.string(),
}));

const reviewTenancy = H.flow('review-tenancy')
  .for(Tenancy)
  .phases('reviewing')
  .exits('reviewed', 'suspended', 'churned')
  .does(async (ctx) => {
    const tenancy = ctx.unit.data;
    await ctx.move('reviewing');
    const usage = await ctx.run(usageReport, { tenantId: tenancy.tenantId });
    if (!usage.ok) return ctx.fail(usage.error);
    const summary = await ctx.run(accountSummary, { customer: tenancy.customer, usage: usage.value });
    if (!summary.ok) return ctx.fail(summary.error);
    const decision = await ctx.halt(tenancyDecision, summary.value.summary);
    if (decision.action === 'churn') return 'churned';
    if (decision.action === 'suspend') return 'suspended';
    await ctx.update({
      nextReviewAt: new Date(ctx.now().getTime() + 30 * dayMs).toISOString(),
      lastDecision: `${decision.action}: ${decision.note}`,
    });
    return 'reviewed';
  });

const billing = http.webhook(Tenancy, {
  path: '/hooks/billing',
  secret: H.env('BILLING_WEBHOOK_SECRET'),
  body: z.object({
    event: z.enum(['subscribed', 'suspended', 'reinstated', 'churned']),
    tenantId: z.string(),
    customer: z.string(),
  }),
  read: (b) => {
    if (b.event === 'subscribed') {
      return { create: { tenantId: b.tenantId, customer: b.customer, nextReviewAt: new Date().toISOString() }, key: b.tenantId };
    }
    if (b.event === 'suspended') return { update: b.tenantId, state: 'suspended' };
    if (b.event === 'reinstated') return { update: b.tenantId, state: 'between-reviews' };
    return { update: b.tenantId, state: 'churned' };
  },
});

const reviewCalendar = H.clock('monthly-review', Tenancy, { daily: '06:00' }, (tick) =>
  tick.units
    .filter((u) => u.state === 'between-reviews' && Date.parse(u.data.nextReviewAt) <= tick.now.getTime())
    .map((u): Supply<TenancyData, 'review-due'> => ({ update: u.key, state: 'review-due' })));

const tenancies = H.lane('tenancies', Tenancy)
  .handler(reviewTenancy, { reviewing: underReview, reviewed: betweenReviews, suspended, churned })
  .suppliers(H.operator, billing, reviewCalendar)
  .store(sqlite.store(Tenancy, '.harness/tenancies.db'));

const opened = H.state('opened', 'pending');
const vendorReplied = H.state('vendor-replied', 'pending');
const draftingOffer = H.state('drafting-offer', 'active');
const awaitingVendor = H.state('awaiting-vendor', 'waiting');
const agreed = H.state('agreed', 'terminal', 'success');
const weWalked = H.state('we-walked', 'terminal', 'neutral');
const theyWalked = H.state('they-walked', 'terminal', 'failure');
const expired = H.state('expired', 'terminal', 'failure');

const Negotiation = H.kind('Negotiation')
  .data(z.object({
    vendor: z.string(),
    item: z.string(),
    targetUsd: z.number(),
    expiresAt: z.string(),
    round: z.number(),
    lastVendorMessage: z.string().optional(),
  }))
  .states(opened, vendorReplied, draftingOffer, awaitingVendor, agreed, weWalked, theyWalked, expired);

const negotiatorRole = H.role('negotiator')
  .input(z.object({
    vendor: z.string(),
    item: z.string(),
    targetUsd: z.number(),
    vendorMessage: z.string(),
    round: z.number(),
  }))
  .output(z.object({ decision: z.enum(['counter', 'accept', 'walk-away']), message: z.string() }))
  .prompt((n) => `Round ${n.round} with ${n.vendor} for ${n.item}, target $${n.targetUsd}.\nVendor said:\n${n.vendorMessage}\nDecide: counter, accept, or walk away, and write the message.`);

const negotiator = H.agent('negotiator', negotiatorRole).model(opus);

const sendVendorMessage = H.command('send-vendor-message')
  .input(z.object({ vendor: z.string(), message: z.string() }))
  .argv((m) => ['procurement-mail', '--to', m.vendor, '--body', m.message])
  .on(lab);

const negotiateRound = H.flow('negotiate-round')
  .for(Negotiation)
  .phases('drafting')
  .exits('offer-sent', 'agreed', 'we-walked')
  .does(async (ctx) => {
    const n = ctx.unit.data;
    await ctx.move('drafting');
    const next = await ctx.run(negotiator, {
      vendor: n.vendor,
      item: n.item,
      targetUsd: n.targetUsd,
      vendorMessage: n.lastVendorMessage ?? '',
      round: n.round,
    });
    if (!next.ok) return ctx.fail(next.error);
    const sent = await ctx.run(sendVendorMessage, { vendor: n.vendor, message: next.value.message });
    if (!sent.ok) return ctx.fail(sent.error);
    if (next.value.decision === 'accept') return 'agreed';
    if (next.value.decision === 'walk-away') return 'we-walked';
    await ctx.update({ round: n.round + 1 });
    return 'offer-sent';
  });

const vendorReplies = http.webhook(Negotiation, {
  path: '/hooks/vendor',
  secret: H.env('VENDOR_WEBHOOK_SECRET'),
  body: z.object({
    negotiationId: z.string(),
    event: z.enum(['reply', 'accepted', 'walked-away']),
    message: z.string(),
  }),
  read: (b) => {
    if (b.event === 'reply') {
      return { update: b.negotiationId, patch: { lastVendorMessage: b.message }, state: 'vendor-replied' };
    }
    if (b.event === 'accepted') return { update: b.negotiationId, state: 'agreed' };
    return { update: b.negotiationId, state: 'they-walked' };
  },
});

const negotiations = H.lane('negotiations', Negotiation)
  .handler(negotiateRound, { drafting: draftingOffer, 'offer-sent': awaitingVendor, agreed, 'we-walked': weWalked })
  .suppliers(H.operator, vendorReplies)
  .store(sqlite.store(Negotiation, '.harness/negotiations.db'));

const negotiationExpiry = H.trigger(
  'negotiation-expiry',
  H.on.deadline(Negotiation, (n) => new Date(n.expiresAt), ['opened', 'vendor-replied', 'drafting-offer', 'awaiting-vendor']),
  (_event, act) => act.move('expired'),
);

const lifecycleScheduler = H.policy.scheduler('lifecycles', (view) => {
  const share = inconclusiveRate(view.metrics);
  const throttled = share.samples >= 10 && share.value !== null && share.value > 0.5;
  const runningExperiments = view.active.filter((u) => u.is(Experiment)).length;
  return {
    start: view.pending.filter((u) => !(throttled && runningExperiments >= 2 && u.is(Experiment))),
  };
});

export const lifecycles = H.harness('lifecycles')
  .ledger(sqlite.ledger('.harness/lifecycles.db'))
  .lanes(experiments, tenancies, negotiations)
  .pools(models)
  .triggers(negotiationExpiry)
  .scheduler(lifecycleScheduler)
  .clients(supervisor({ grants: [H.ops.readWork, H.ops.writeWork, H.ops.resolveHalts, H.ops.readTelemetry] }))
  .observers(markdown.board('board.md'), markdown.telemetry('telemetry.md'));
