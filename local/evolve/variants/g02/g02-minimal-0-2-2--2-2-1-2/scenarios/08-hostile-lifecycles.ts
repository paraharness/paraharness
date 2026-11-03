import { H } from 'harness-dsl';
import type { SupplyOf } from 'harness-dsl';
import * as anthropic from 'harness-dsl/anthropic';
import * as sqlite from 'harness-dsl/sqlite';
import * as shell from 'harness-dsl/shell';
import * as http from 'harness-dsl/http';
import * as markdown from 'harness-dsl/markdown';
import { z } from 'zod';

const local = shell.local('local', { slots: 4 });
const apiAccount = anthropic.account('api', { apiKey: H.env('ANTHROPIC_API_KEY') });
const sonnet = anthropic.model('claude-sonnet');
const apiPool = H.pool('api', [{ account: apiAccount, share: 1 }]);

const scheduledExperiment = H.state('scheduled', 'pending');
const observing = H.state('observing', 'waiting');
const analysisStalled = H.state('analysis-stalled', 'waiting');
const aWins = H.state('a-wins', 'terminal', 'success');
const bWins = H.state('b-wins', 'terminal', 'success');
const inconclusive = H.state('inconclusive', 'terminal', 'neutral');
const experiment = H.kind('Experiment')
  .data(z.object({ name: z.string(), endsAt: z.string() }))
  .states(scheduledExperiment, observing, analysisStalled, aWins, bWins, inconclusive);

const collectMetric = H.command('collect-experiment-metric')
  .input(z.object({ experiment: z.string() }))
  .argv(input => ['bin/collect-metric', input.experiment])
  .on(local)
  .recovery('rerun');

const analyzeExperiment = H.command('analyze-experiment')
  .input(z.object({ experiment: z.string() }))
  .output(z.object({ winner: z.enum(['a', 'b', 'none']) }))
  .argv(input => ['bin/analyze', input.experiment])
  .on(local)
  .recovery('rerun');

const runExperiment = H.flow('run-experiment').for(experiment).does(async ctx => {
  const endsAt = new Date(ctx.unit.data.endsAt).getTime();
  while (ctx.now().getTime() < endsAt) {
    await ctx.run(collectMetric, { experiment: ctx.unit.data.name });
    await ctx.suspend('observing', { at: new Date(ctx.now().getTime() + 3600000) });
  }
  const analysis = await ctx.run(analyzeExperiment, { experiment: ctx.unit.data.name });
  if (!analysis.ok) return ctx.fail(analysis.error);
  if (analysis.value.winner === 'a') return 'a-wins';
  if (analysis.value.winner === 'b') return 'b-wins';
  return 'inconclusive';
});

const experimentLane = H.lane('experiments', experiment)
  .handler(runExperiment, { retries: 1, exhausted: 'analysis-stalled' })
  .suppliers(H.operator)
  .store(sqlite.store(experiment, '.harness/experiments.sqlite'));

const reviewDue = H.state('review-due', 'pending');
const current = H.state('current', 'waiting');
const suspendedTenancy = H.state('suspended', 'waiting');
const reviewStalled = H.state('review-stalled', 'waiting');
const churned = H.state('churned', 'terminal', 'neutral');
const tenancy = H.kind('Tenancy')
  .data(z.object({ customerId: z.string(), nextReviewAt: z.string(), upsellOffered: z.boolean() }))
  .states(reviewDue, current, suspendedTenancy, reviewStalled, churned);

const tenancyUsage = H.command('tenancy-usage')
  .input(z.object({ customerId: z.string() }))
  .output(z.object({ seats: z.number(), monthlyUsd: z.number() }))
  .argv(input => ['bin/usage', input.customerId])
  .on(local)
  .recovery('rerun');

const summarizeAccountRole = H.role('summarize-account')
  .input(z.object({ customerId: z.string(), seats: z.number(), monthlyUsd: z.number() }))
  .output(z.object({ summary: z.string() }))
  .prompt(input => `Summarize the month for customer ${input.customerId}: ${input.seats} seats, $${input.monthlyUsd}.`);

const accountSummarizer = H.seat('account-summarizer', summarizeAccountRole).model(sonnet);

const upsell = H.halt('upsell', z.object({ upsell: z.boolean(), note: z.string() }));

const reviewTenancy = H.flow('review-tenancy').for(tenancy).does(async ctx => {
  const usage = await ctx.run(tenancyUsage, { customerId: ctx.unit.data.customerId });
  if (!usage.ok) return ctx.fail(usage.error);
  const summary = await ctx.run(accountSummarizer, { customerId: ctx.unit.data.customerId, ...usage.value });
  if (!summary.ok) return ctx.fail(summary.error);
  const decision = await ctx.halt(upsell, summary.value.summary);
  await ctx.update({
    upsellOffered: decision.upsell,
    nextReviewAt: new Date(ctx.now().getTime() + 30 * 86400000).toISOString(),
  });
  return 'current';
});

const monthlyReview = H.clock('monthly-tenancy-review', tenancy, { daily: '03:00' }, tick =>
  tick.units
    .filter(unit => unit.state === 'current' && new Date(unit.data.nextReviewAt).getTime() <= tick.now.getTime())
    .map((unit): SupplyOf<typeof tenancy> => ({ update: unit.key, state: 'review-due' }))
);

const tenancyLane = H.lane('tenancies', tenancy)
  .handler(reviewTenancy, { retries: 2, backoff: { first: { hours: 1 } }, exhausted: 'review-stalled' })
  .suppliers(H.operator, monthlyReview)
  .store(sqlite.store(tenancy, '.harness/tenancies.sqlite'));

const opened = H.state('opened', 'pending');
const ourTurn = H.state('our-turn', 'pending');
const theirTurn = H.state('their-turn', 'waiting');
const negotiationStalled = H.state('negotiation-stalled', 'waiting');
const agreed = H.state('agreed', 'terminal', 'success');
const walkedAwayUs = H.state('walked-away-us', 'terminal', 'neutral');
const walkedAwayThem = H.state('walked-away-them', 'terminal', 'neutral');
const expired = H.state('expired', 'terminal', 'neutral');
const negotiation = H.kind('Negotiation')
  .data(z.object({
    vendor: z.string(),
    item: z.string(),
    expiresAt: z.string(),
    lastReply: z.string().optional(),
    lastOffer: z.string().optional(),
  }))
  .states(opened, ourTurn, theirTurn, negotiationStalled, agreed, walkedAwayUs, walkedAwayThem, expired);

const negotiateRole = H.role('negotiate')
  .input(z.object({ vendor: z.string(), item: z.string(), lastReply: z.string().optional(), lastOffer: z.string().optional() }))
  .output(z.object({ move: z.enum(['offer', 'accept', 'walk-away']), message: z.string() }))
  .prompt(input => `Negotiate ${input.item} with ${input.vendor}. Our last offer: ${input.lastOffer ?? 'none'}. Their reply: ${input.lastReply ?? 'none'}.`);

const negotiator = H.seat('negotiator', negotiateRole).model(sonnet);

const sendToVendor = H.command('send-to-vendor')
  .input(z.object({ vendor: z.string(), message: z.string() }))
  .argv(input => ['bin/send-to-vendor', input.vendor, input.message])
  .on(local)
  .recovery('park');

const negotiationRound = H.flow('negotiation-round').for(negotiation).does(async ctx => {
  const { vendor, item, lastReply, lastOffer } = ctx.unit.data;
  const draft = await ctx.run(negotiator, { vendor, item, lastReply, lastOffer });
  if (!draft.ok) return ctx.fail(draft.error);
  if (draft.value.move === 'walk-away') return 'walked-away-us';
  const sent = await ctx.run(sendToVendor, { vendor, message: draft.value.message });
  if (!sent.ok) return ctx.fail(sent.error);
  await ctx.update({ lastOffer: draft.value.message });
  return draft.value.move === 'accept' ? 'agreed' : 'their-turn';
});

const vendorReplies = http.webhook(negotiation, {
  path: '/vendor-replies',
  secret: H.env('VENDOR_WEBHOOK_SECRET'),
  body: z.object({ negotiationId: z.string(), message: z.string(), outcome: z.enum(['counter', 'accepted', 'withdrawn']) }),
  read: body => ({
    update: body.negotiationId,
    patch: { lastReply: body.message },
    state: body.outcome === 'accepted' ? 'agreed' : body.outcome === 'withdrawn' ? 'walked-away-them' : 'our-turn',
  }),
});

const negotiationLane = H.lane('negotiations', negotiation)
  .handler(negotiationRound, { retries: 2, backoff: { first: { minutes: 10 }, factor: 2 }, exhausted: 'negotiation-stalled' })
  .suppliers(H.operator, vendorReplies)
  .store(sqlite.store(negotiation, '.harness/negotiations.sqlite'));

const negotiationExpiry = H.trigger(
  'negotiation-expiry',
  H.on.deadline(negotiation, data => new Date(data.expiresAt), ['opened', 'our-turn', 'their-turn', 'negotiation-stalled']),
  (_event, act) => act.move('expired')
);

const lifecycleOrder = H.policy.scheduler('lifecycle-order', view => {
  const inconclusiveShare = view.metrics.rate({
    among: { entry: 'transition', kind: experiment, position: 'terminal' },
    count: { entry: 'transition', kind: experiment, state: 'inconclusive' },
    days: 180,
  });
  const holdExperiments = inconclusiveShare.samples >= 10 && (inconclusiveShare.value ?? 0) > 0.5;
  return { start: view.pending.filter(unit => !(holdExperiments && unit.is(experiment))) };
});

const operatorConsole = http.control({
  port: 7300,
  token: H.env('CONTROL_TOKEN'),
  grants: [
    H.ops.readWork,
    H.ops.writeWork,
    H.ops.resolve(upsell, H.halts.interrupted, H.halts.definitionChanged),
    H.ops.readTelemetry,
  ],
});

export const lifecycles = H.harness('lifecycles')
  .ledger(sqlite.ledger('.harness/ledger.sqlite'))
  .lanes(experimentLane, tenancyLane, negotiationLane)
  .pools(apiPool)
  .triggers(negotiationExpiry)
  .scheduler(lifecycleOrder)
  .clients(operatorConsole)
  .observers(markdown.board('BOARD.md'), markdown.telemetry('TELEMETRY.md'));
