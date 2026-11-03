import { H } from 'harness-dsl';
import type { Metrics, SupplyOf } from 'harness-dsl';
import { z } from 'zod';
import { ledger, store } from 'harness-dsl/sqlite';
import { account, model } from 'harness-dsl/anthropic';
import { local } from 'harness-dsl/shell';
import { webhook, control } from 'harness-dsl/http';
import { board } from 'harness-dsl/markdown';

const shell = local('ops-shell', { slots: 4 });
const api = account('lifecycles-api', { apiKey: H.env('ANTHROPIC_API_KEY') });
const sonnet = model('claude-sonnet-4-5');
const haiku = model('claude-haiku-4-5');

const scheduled = H.state('scheduled', 'pending');
const collecting = H.state('collecting', 'waiting');
const aWins = H.state('a-wins', 'terminal', 'neutral');
const bWins = H.state('b-wins', 'terminal', 'neutral');
const inconclusive = H.state('inconclusive', 'terminal', 'neutral');
const broken = H.state('broken', 'terminal', 'failure');
const experiment = H.kind('experiment')
  .data(z.object({ name: z.string(), durationDays: z.number() }))
  .states(scheduled, collecting, aWins, bWins, inconclusive, broken);

type Sample = { readonly a: number; readonly b: number };

const sampleArms = H.command('sample-arms')
  .input(z.object({ name: z.string() }))
  .output(z.object({ a: z.number(), b: z.number() }))
  .argv(input => ['experiment-sample', input.name])
  .on(shell)
  .recovery('rerun');

const experimentLength = H.policy.rule('experiment-length', (planned: { readonly days: number }, metrics: Metrics) => {
  const inconclusiveShare = metrics.rate({
    days: 180,
    among: { entry: 'transition', kind: experiment, position: 'terminal' },
    count: { entry: 'transition', kind: experiment, state: 'inconclusive' },
  });
  return inconclusiveShare.samples >= 10 && inconclusiveShare.value !== null && inconclusiveShare.value > 0.5
    ? planned.days + 7
    : planned.days;
});

const judge = H.policy.rule('judge-experiment', (samples: readonly Sample[]): 'a-wins' | 'b-wins' | 'inconclusive' => {
  if (samples.length < 24) return 'inconclusive';
  const mean = (pick: (sample: Sample) => number) => samples.reduce((sum, sample) => sum + pick(sample), 0) / samples.length;
  const a = mean(sample => sample.a);
  const b = mean(sample => sample.b);
  const lift = (a - b) / Math.max(Math.abs(b), 1e-9);
  return lift > 0.05 ? 'a-wins' : lift < -0.05 ? 'b-wins' : 'inconclusive';
});

const runExperiment = H.flow('run-experiment')
  .for(experiment)
  .does(async ctx => {
    const days = await ctx.decide(experimentLength, { days: ctx.unit.data.durationDays });
    const started = ctx.now();
    const samples: Sample[] = [];
    for (let hour = 1; hour <= days * 24; hour += 1) {
      const sample = await ctx.run(sampleArms, { name: ctx.unit.data.name });
      if (sample.ok) samples.push(sample.value);
      await ctx.suspend('collecting', { at: new Date(started.getTime() + hour * 3_600_000) });
    }
    return ctx.decide(judge, samples);
  });

const reviewDue = H.state('review-due', 'pending');
const betweenReviews = H.state('between-reviews', 'waiting');
const onHold = H.state('on-hold', 'waiting');
const reviewStalled = H.state('review-stalled', 'waiting');
const churned = H.state('churned', 'terminal', 'neutral');
const tenancy = H.kind('tenancy')
  .data(z.object({ customer: z.string(), plan: z.string(), nextReview: z.string() }))
  .states(reviewDue, betweenReviews, onHold, reviewStalled, churned);

const usageReport = H.command('usage-report')
  .input(z.object({ customer: z.string() }))
  .output(z.object({ seats: z.number(), spendUsd: z.number(), trend: z.string() }))
  .argv(input => ['usage-report', input.customer])
  .on(shell)
  .recovery('rerun');
const proposeUpsell = H.command('propose-upsell')
  .input(z.object({ customer: z.string() }))
  .argv(input => ['crm-propose-upsell', input.customer])
  .on(shell)
  .recovery('park');

const usageSummaryRole = H.role('usage-summary')
  .input(z.object({ customer: z.string(), plan: z.string(), seats: z.number(), spendUsd: z.number(), trend: z.string() }))
  .output(z.object({ summary: z.string() }))
  .prompt(input => `Summarize ${input.customer} on ${input.plan}: ${input.seats} seats, $${input.spendUsd}, trend ${input.trend}.`);
const usageSummarizer = H.seat('usage-summarizer', usageSummaryRole).model(haiku);

const upsellCall = H.halt('upsell-call', z.object({ action: z.enum(['upsell', 'keep', 'churn']) })).about(
  z.object({ customer: z.string(), summary: z.string() })
);

const monthlyReview = H.flow('monthly-review')
  .for(tenancy)
  .does(async ctx => {
    const { customer, plan } = ctx.unit.data;
    const usage = await ctx.run(usageReport, { customer });
    if (!usage.ok) return ctx.fail(usage.error);
    const summary = await ctx.run(usageSummarizer, { customer, plan, ...usage.value });
    if (!summary.ok) return ctx.fail(summary.error);
    const call = await ctx.halt(upsellCall, summary.value.summary, { customer, summary: summary.value.summary });
    if (call.action === 'churn') return 'churned';
    if (call.action === 'upsell') {
      const proposed = await ctx.run(proposeUpsell, { customer });
      if (!proposed.ok) return ctx.fail(proposed.error);
    }
    await ctx.update({ nextReview: new Date(ctx.now().getTime() + 30 * 86_400_000).toISOString() });
    return 'between-reviews';
  });

const reviewCalendar = H.schedule('tenancy-review-calendar', tenancy, { daily: '06:00' }, tick =>
  tick.units
    .filter(unit => unit.state === 'between-reviews' && new Date(unit.data.nextReview) <= tick.now)
    .map((unit): SupplyOf<typeof tenancy> => ({ update: unit.key, state: 'review-due' }))
);

const drafting = H.state('drafting', 'pending');
const awaitingVendor = H.state('awaiting-vendor', 'waiting');
const agreed = H.state('agreed', 'terminal', 'success');
const walkedAwayByUs = H.state('walked-away-by-us', 'terminal', 'neutral');
const walkedAwayByThem = H.state('walked-away-by-them', 'terminal', 'neutral');
const expired = H.state('expired', 'terminal', 'neutral');
const stalled = H.state('stalled', 'terminal', 'failure');
const negotiation = H.kind('negotiation')
  .data(
    z.object({
      vendor: z.string(),
      item: z.string(),
      targetUsd: z.number(),
      walkAwayUsd: z.number(),
      expiresAt: z.string(),
      vendorMessage: z.string().optional(),
    })
  )
  .states(drafting, awaitingVendor, agreed, walkedAwayByUs, walkedAwayByThem, expired, stalled);

const negotiateRole = H.role('negotiate')
  .input(
    z.object({
      vendor: z.string(),
      item: z.string(),
      targetUsd: z.number(),
      walkAwayUsd: z.number(),
      vendorMessage: z.string().optional(),
    })
  )
  .output(z.object({ offerUsd: z.number(), message: z.string(), walkAway: z.boolean() }))
  .prompt(
    input =>
      `Negotiate ${input.item} with ${input.vendor}. Target $${input.targetUsd}, walk away above $${input.walkAwayUsd}. Last reply: ${input.vendorMessage ?? 'none yet'}`
  );
const negotiator = H.seat('negotiator', negotiateRole).model(sonnet);
const sendOffer = H.command('send-offer')
  .input(z.object({ vendor: z.string(), offerUsd: z.number(), message: z.string() }))
  .argv(input => ['procurement-send', input.vendor, String(input.offerUsd), input.message])
  .on(shell)
  .recovery('park');

const negotiationRound = H.flow('negotiation-round')
  .for(negotiation)
  .does(async ctx => {
    const offer = await ctx.run(negotiator, ctx.unit.data);
    if (!offer.ok) return ctx.fail(offer.error);
    if (offer.value.walkAway) return 'walked-away-by-us';
    const sent = await ctx.run(sendOffer, { vendor: ctx.unit.data.vendor, offerUsd: offer.value.offerUsd, message: offer.value.message });
    if (!sent.ok) return ctx.fail(sent.error);
    return 'awaiting-vendor';
  });

const vendorReplies = webhook(negotiation, {
  path: '/vendor-replies',
  secret: H.env('VENDOR_WEBHOOK_SECRET'),
  body: z.object({ negotiation: z.string(), message: z.string(), outcome: z.enum(['counter', 'accept', 'walk-away']) }),
  read: body => ({
    update: body.negotiation,
    patch: { vendorMessage: body.message },
    state: body.outcome === 'accept' ? 'agreed' : body.outcome === 'walk-away' ? 'walked-away-by-them' : 'drafting',
  }),
});

const negotiationExpiry = H.trigger(
  'negotiation-expiry',
  H.on.deadline(negotiation, data => new Date(data.expiresAt), ['drafting', 'awaiting-vendor']),
  (_event, act) => act.move('expired')
);

const experimentLane = H.lane('experiments', experiment)
  .handler(runExperiment)
  .retries(2, { backoff: { first: { hours: 1 } }, exhausted: 'broken' })
  .suppliers(H.operator)
  .store(store(experiment, '/srv/lifecycles/experiments.sqlite'));
const tenancyLane = H.lane('tenancies', tenancy)
  .handler(monthlyReview)
  .retries(3, { backoff: { first: { hours: 6 }, factor: 2 }, exhausted: 'review-stalled' })
  .suppliers(H.operator, reviewCalendar)
  .store(store(tenancy, '/srv/lifecycles/tenancies.sqlite'))
  .wip(3);
const negotiationLane = H.lane('negotiations', negotiation)
  .handler(negotiationRound)
  .retries(2, { backoff: { first: { minutes: 30 } }, exhausted: 'stalled' })
  .suppliers(H.operator, vendorReplies)
  .store(store(negotiation, '/srv/lifecycles/negotiations.sqlite'))
  .wip(4);

export default H.harness('lifecycles')
  .ledger(ledger('/srv/lifecycles/ledger.sqlite'))
  .lanes(experimentLane, tenancyLane, negotiationLane)
  .pools(H.pool('lifecycles-api-pool', [{ account: api, share: 1 }]))
  .triggers(negotiationExpiry)
  .clients(
    control({
      port: 7480,
      token: H.env('LIFECYCLES_CONTROL_TOKEN'),
      grants: [H.ops.readWork, H.ops.writeWork, H.ops.resolve(upsellCall, H.halts.interrupted), H.ops.readTelemetry],
    })
  )
  .observers(board('/srv/lifecycles/BOARD.md'));
