import { z } from 'zod';
import { H } from 'harness-dsl';
import type { SupplyOf } from 'harness-dsl';
import * as anthropic from 'harness-dsl/anthropic';
import * as http from 'harness-dsl/http';
import * as sqlite from 'harness-dsl/sqlite';
import * as shell from 'harness-dsl/shell';
import * as claude from 'harness-dsl/claude-code';
import * as markdown from 'harness-dsl/markdown';

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

const local = shell.local('local', { slots: 4 });
const api = anthropic.account('anthropic-api', { apiKey: H.env('ANTHROPIC_API_KEY') });
const sonnet = anthropic.model('claude-sonnet-4-5');

const Proposed = H.state('proposed', 'pending');
const Sampling = H.state('sampling', 'pending');
const Observing = H.state('observing', 'waiting');
const AWins = H.state('a-wins', 'terminal', 'success');
const BWins = H.state('b-wins', 'terminal', 'success');
const Inconclusive = H.state('inconclusive', 'terminal', 'neutral');

const sample = z.object({ a: z.number(), b: z.number() });
type Sample = z.infer<typeof sample>;

const Experiment = H.kind('experiment')
  .data(z.object({ name: z.string(), endsAt: z.string().optional(), samples: z.array(sample).default([]) }))
  .states(Proposed, Sampling, Observing, AWins, BWins, Inconclusive);

function winner(samples: readonly Sample[]): 'a' | 'b' | 'inconclusive' {
  if (samples.length < 24) return 'inconclusive';
  const meanA = samples.reduce((sum, s) => sum + s.a, 0) / samples.length;
  const meanB = samples.reduce((sum, s) => sum + s.b, 0) / samples.length;
  if (meanA === 0) return 'inconclusive';
  const lift = (meanB - meanA) / meanA;
  if (lift > 0.02) return 'b';
  if (lift < -0.02) return 'a';
  return 'inconclusive';
}

const experimentVerdict = H.decision('experiment-verdict')
  .input(z.object({ samples: z.array(sample) }))
  .output(z.object({ winner: z.enum(['a', 'b', 'inconclusive']) }))
  .policy(input => ({ winner: winner(input.samples) }));

const collectMetric = H.command('collect-experiment-metric')
  .input(z.object({ experiment: z.string() }))
  .output(sample)
  .argv(input => ['experiment-metric', '--experiment', input.experiment])
  .on(local)
  .recover('rerun');

const beginExperiment = H.flow('begin-experiment').for(Experiment).does(async ctx => {
  const now = ctx.now();
  await ctx.update({ endsAt: new Date(now.getTime() + 14 * DAY).toISOString(), samples: [] });
  return ctx.until('observing', { at: new Date(now.getTime() + HOUR), then: 'sampling' });
});

const sampleExperiment = H.flow('sample-experiment').for(Experiment).does(async ctx => {
  const reading = await ctx.run(collectMetric, { experiment: ctx.unit.data.name });
  if (reading.ok === false) return ctx.fail(reading.error);
  const samples = [...ctx.unit.data.samples, reading.value];
  await ctx.update({ samples });
  const now = ctx.now();
  const endsAt = new Date(ctx.unit.data.endsAt ?? now.toISOString());
  if (now.getTime() < endsAt.getTime()) {
    return ctx.until('observing', { at: new Date(now.getTime() + HOUR), then: 'sampling' });
  }
  const verdict = await ctx.decide(experimentVerdict, { samples });
  if (verdict.winner === 'a') return 'a-wins';
  if (verdict.winner === 'b') return 'b-wins';
  return 'inconclusive';
});

const experiments = H.lane('experiments', Experiment)
  .handler({ proposed: beginExperiment, sampling: sampleExperiment })
  .suppliers(H.operator)
  .store(sqlite.store(Experiment, '.harness/experiments.db'));

const ReviewDue = H.state('review-due', 'pending');
const BetweenReviews = H.state('between-reviews', 'waiting');
const Suspended = H.state('suspended', 'waiting');
const Churned = H.state('churned', 'terminal', 'neutral');

const Tenancy = H.kind('tenancy')
  .data(z.object({ customerId: z.string(), plan: z.string(), lastDecision: z.string().optional() }))
  .states(ReviewDue, BetweenReviews, Suspended, Churned);

const usageReview = H.command('usage-review')
  .input(z.object({ customerId: z.string() }))
  .output(z.object({ seats: z.number(), usageUsd: z.number(), trend: z.string() }))
  .argv(input => ['usage-review', '--customer', input.customerId])
  .on(local)
  .recover('rerun');

const tenancySummarizer = H.role('tenancy-summarizer')
  .input(z.object({ customerId: z.string(), plan: z.string(), seats: z.number(), usageUsd: z.number(), trend: z.string() }))
  .output(z.object({ summary: z.string() }))
  .prompt(input => `Summarise the month for ${input.customerId} on ${input.plan}: ${input.seats} seats, $${input.usageUsd}, trend ${input.trend}.`);

const summarizer = H.agent('tenancy-summarizer', tenancySummarizer).model(sonnet);

const upsellDecision = H.decision('upsell-decision')
  .input(z.object({ customerId: z.string(), summary: z.string() }))
  .output(z.object({ upsell: z.boolean(), note: z.string() }))
  .show(input => `${input.customerId}\n\n${input.summary}`);

const nextMonth = (now: Date): Date => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));

const reviewTenancy = H.flow('review-tenancy').for(Tenancy).does(async ctx => {
  const { customerId, plan } = ctx.unit.data;
  const usage = await ctx.run(usageReview, { customerId });
  if (usage.ok === false) return ctx.fail(usage.error);
  const summary = await ctx.run(summarizer, { customerId, plan, ...usage.value });
  if (summary.ok === false) return ctx.fail(summary.error);
  const decision = await ctx.decide(upsellDecision, { customerId, summary: summary.value.summary });
  await ctx.update({ lastDecision: `${decision.upsell ? 'upsell' : 'hold'}: ${decision.note}` });
  return ctx.until('between-reviews', { at: nextMonth(ctx.now()), then: 'review-due' });
});

const billingEvent = z.object({
  customerId: z.string(),
  event: z.enum(['signed-up', 'suspended', 'reinstated', 'churned']),
  plan: z.string(),
});

function supplyTenancy(body: z.infer<typeof billingEvent>): SupplyOf<typeof Tenancy> {
  if (body.event === 'signed-up') return { create: { customerId: body.customerId, plan: body.plan }, key: body.customerId };
  if (body.event === 'suspended') return { update: body.customerId, state: 'suspended' };
  if (body.event === 'reinstated') return { update: body.customerId, patch: { plan: body.plan }, state: 'review-due' };
  return { update: body.customerId, state: 'churned' };
}

const billingWebhook = http.webhook(Tenancy, {
  path: '/billing',
  secret: H.env('BILLING_WEBHOOK_SECRET'),
  body: billingEvent,
  read: supplyTenancy,
});

const tenancies = H.lane('tenancies', Tenancy)
  .handler(reviewTenancy)
  .suppliers(billingWebhook)
  .store(sqlite.store(Tenancy, '.harness/tenancies.db'));

const Drafting = H.state('drafting', 'pending');
const AwaitingVendor = H.state('awaiting-vendor', 'waiting');
const Agreed = H.state('agreed', 'terminal', 'success');
const WalkedAwayByUs = H.state('walked-away-by-us', 'terminal', 'neutral');
const WalkedAwayByThem = H.state('walked-away-by-them', 'terminal', 'failure');
const Expired = H.state('expired', 'terminal', 'neutral');

const turn = z.object({ from: z.enum(['us', 'them']), text: z.string() });
type Turn = z.infer<typeof turn>;

const Negotiation = H.kind('negotiation')
  .data(z.object({
    vendor: z.string(),
    item: z.string(),
    expiresAt: z.string(),
    history: z.array(turn).default([]),
    vendorReply: z.string().optional(),
  }))
  .states(Drafting, AwaitingVendor, Agreed, WalkedAwayByUs, WalkedAwayByThem, Expired);

const negotiatorRole = H.role('negotiator')
  .input(z.object({ vendor: z.string(), item: z.string(), history: z.array(turn) }))
  .output(z.object({ action: z.enum(['offer', 'accept', 'walk-away']), text: z.string() }))
  .prompt(input => `Negotiate ${input.item} with ${input.vendor}.\n\n${input.history.map(t => `${t.from}: ${t.text}`).join('\n')}`);

const negotiator = H.agent('negotiator', negotiatorRole).model(sonnet);

const sendToVendor = H.command('send-to-vendor')
  .input(z.object({ vendor: z.string(), text: z.string() }))
  .argv(input => ['vendor-mail', '--to', input.vendor, '--body', input.text])
  .on(local);

const negotiationRound = H.flow('negotiation-round').for(Negotiation).does(async ctx => {
  const { vendor, item, vendorReply } = ctx.unit.data;
  const history: Turn[] = vendorReply === undefined
    ? ctx.unit.data.history
    : [...ctx.unit.data.history, { from: 'them', text: vendorReply }];
  const move = await ctx.run(negotiator, { vendor, item, history });
  if (move.ok === false) return ctx.fail(move.error);
  const nextHistory: Turn[] = [...history, { from: 'us', text: move.value.text }];
  await ctx.update({ history: nextHistory, vendorReply: undefined });
  if (move.value.action === 'walk-away') return 'walked-away-by-us';
  const sent = await ctx.run(sendToVendor, { vendor, text: move.value.text });
  if (sent.ok === false) return ctx.fail(sent.error);
  return move.value.action === 'accept' ? 'agreed' : 'awaiting-vendor';
});

const vendorReply = z.object({
  negotiationId: z.string(),
  event: z.enum(['countered', 'accepted', 'walked-away']),
  message: z.string(),
});

function supplyNegotiation(body: z.infer<typeof vendorReply>): SupplyOf<typeof Negotiation> {
  if (body.event === 'accepted') return { update: body.negotiationId, patch: { vendorReply: body.message }, state: 'agreed' };
  if (body.event === 'walked-away') return { update: body.negotiationId, patch: { vendorReply: body.message }, state: 'walked-away-by-them' };
  return { update: body.negotiationId, patch: { vendorReply: body.message }, state: 'drafting' };
}

const vendorWebhook = http.webhook(Negotiation, {
  path: '/vendor-replies',
  secret: H.env('VENDOR_WEBHOOK_SECRET'),
  body: vendorReply,
  read: supplyNegotiation,
});

const negotiations = H.lane('negotiations', Negotiation)
  .handler(negotiationRound)
  .suppliers(H.operator, vendorWebhook)
  .store(sqlite.store(Negotiation, '.harness/negotiations.db'));

const negotiationExpires = H.trigger(
  'negotiation-expires',
  H.on.deadline(Negotiation, data => new Date(data.expiresAt), ['drafting', 'awaiting-vendor']),
  (_event, act) => act.move('expired'),
);

const scheduler = H.policy.scheduler('hold-experiments-when-inconclusive', view => {
  const inconclusive = view.metrics.rate({
    among: { entry: 'transition', kind: Experiment, position: 'terminal' },
    count: { entry: 'transition', kind: Experiment, state: Inconclusive },
    days: 90,
  });
  const holdNewExperiments = inconclusive.samples >= 10 && (inconclusive.value ?? 0) > 0.6;
  return {
    start: view.pending.filter(unit =>
      holdNewExperiments === false || unit.kind !== Experiment.name || unit.state !== Proposed.name),
  };
});

export const running = H.harness('lifecycles')
  .ledger(sqlite.ledger('.harness/lifecycles.db'))
  .pools(H.pool('anthropic', [{ account: api, share: 1 }]))
  .lanes(experiments, tenancies, negotiations)
  .triggers(negotiationExpires)
  .scheduler(scheduler)
  .clients(claude.supervisor({
    grants: [H.ops.readWork, H.ops.writeWork, H.ops.resolveDecisions, H.ops.readTelemetry],
  }))
  .observers(markdown.board('BOARD.md'), markdown.telemetry('TELEMETRY.md'))
  .start();
