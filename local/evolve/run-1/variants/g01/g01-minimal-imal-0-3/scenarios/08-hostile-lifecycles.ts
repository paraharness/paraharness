import { z } from 'zod';
import { H } from 'harness-dsl';
import type { Metrics } from 'harness-dsl';
import * as anthropic from 'harness-dsl/anthropic';
import * as claude from 'harness-dsl/claude-code';
import * as http from 'harness-dsl/http';
import * as sqlite from 'harness-dsl/sqlite';
import * as shell from 'harness-dsl/shell';
import * as markdown from 'harness-dsl/markdown';

const local = shell.local('local', { slots: 4 });
const sonnet = anthropic.model('claude-sonnet-4-5');
const apiAccount = anthropic.account('anthropic-api', { apiKey: H.env('ANTHROPIC_API_KEY') });
const firstEligible = H.policy.account('first-eligible', choice => choice.accounts.find(a => a.eligible)?.account ?? null);
const hourMs = 60 * 60 * 1000;
const dayMs = 24 * hourMs;

const scheduled = H.state('scheduled', 'pending');
const sampling = H.state('sampling', 'active');
const betweenSamples = H.state('between-samples', 'waiting');
const aWins = H.state('a-wins', 'terminal', 'neutral');
const bWins = H.state('b-wins', 'terminal', 'neutral');
const inconclusive = H.state('inconclusive', 'terminal', 'neutral');
const stopped = H.state('stopped', 'terminal', 'neutral');

const Experiment = H.kind('Experiment')
  .data(z.object({
    name: z.string(),
    endsAt: z.string(),
    samples: z.array(z.object({ at: z.string(), a: z.number(), b: z.number() })),
  }))
  .states([scheduled, sampling, betweenSamples, aWins, bWins, inconclusive, stopped], {
    initial: 'scheduled',
    afterFailure: 'scheduled',
    afterCancel: 'stopped',
  });

const collectExperimentSample = H.command('collect-experiment-sample')
  .input(z.object({ experiment: z.string() }))
  .output(z.object({ a: z.number(), b: z.number() }))
  .argv(e => ['experiment-sample', '--experiment', e.experiment])
  .on(local)
  .restart('rerun');

type ExperimentVerdict = 'a-wins' | 'b-wins' | 'inconclusive';

const meanOf = (values: readonly number[]) => values.length === 0 ? 0 : values.reduce((s, v) => s + v, 0) / values.length;

const experimentVerdict = H.policy.rule(
  'experiment-verdict',
  (samples: readonly { readonly a: number; readonly b: number }[], metrics: Metrics): ExperimentVerdict => {
    const inconclusiveShare = metrics.rate({
      among: { entry: 'transition', kind: 'Experiment', position: 'terminal' },
      count: { entry: 'transition', kind: 'Experiment', state: 'inconclusive' },
      days: 365,
    });
    const minimumLift = inconclusiveShare.samples >= 10 && (inconclusiveShare.value ?? 0) > 0.5 ? 0.01 : 0.02;
    const meanA = meanOf(samples.map(s => s.a));
    const meanB = meanOf(samples.map(s => s.b));
    const lift = (meanB - meanA) / Math.max(Math.abs(meanA), 1e-9);
    if (lift > minimumLift) return 'b-wins';
    if (lift < -minimumLift) return 'a-wins';
    return 'inconclusive';
  }
);

const sampleExperiment = H.flow('sample-experiment').for(Experiment).does(async ctx => {
  await ctx.move('sampling');
  const reading = await ctx.run(collectExperimentSample, { experiment: ctx.unit.data.name });
  if (!reading.ok) return ctx.fail(reading.error);
  const now = ctx.now();
  const samples = [...ctx.unit.data.samples, { at: now.toISOString(), a: reading.value.a, b: reading.value.b }];
  await ctx.update({ samples });
  if (now < new Date(ctx.unit.data.endsAt)) {
    return ctx.until('between-samples', { at: new Date(now.getTime() + hourMs), then: 'scheduled' });
  }
  return ctx.decide(experimentVerdict, samples);
});

const experimentLane = H.lane('experiments', Experiment)
  .handler(sampleExperiment)
  .suppliers(H.operator)
  .store(sqlite.store(Experiment, 'experiments.db'));

const reviewDue = H.state('review-due', 'pending');
const reviewing = H.state('reviewing', 'active');
const betweenReviews = H.state('between-reviews', 'waiting');
const suspended = H.state('suspended', 'waiting');
const churned = H.state('churned', 'terminal', 'neutral');

const Tenancy = H.kind('Tenancy')
  .data(z.object({
    customer: z.string(),
    plan: z.string(),
    lastReviewAt: z.string().optional(),
    upsellOffered: z.boolean().optional(),
  }))
  .states([reviewDue, reviewing, betweenReviews, suspended, churned], {
    initial: 'review-due',
    afterFailure: 'review-due',
    afterCancel: 'between-reviews',
  });

const usageReview = H.command('usage-review')
  .input(z.object({ customer: z.string() }))
  .output(z.object({ seats: z.number(), activeUsers: z.number(), spendUsd: z.number() }))
  .argv(t => ['usage-report', '--customer', t.customer, '--days', '30'])
  .on(local)
  .restart('rerun');

const accountSummaryRole = H.role('account-summarizer')
  .input(z.object({ customer: z.string(), plan: z.string(), seats: z.number(), activeUsers: z.number(), spendUsd: z.number() }))
  .output(z.object({ summary: z.string(), upsellCase: z.string() }))
  .prompt(t => `Summarise last month's usage for ${t.customer} on ${t.plan}: ${t.activeUsers}/${t.seats} active, $${t.spendUsd}.`);

const accountSummarizer = H.agent('account-summarizer', accountSummaryRole).model(sonnet);

const reviewTenancy = H.flow('review-tenancy').for(Tenancy).does(async ctx => {
  const tenancy = ctx.unit.data;
  await ctx.move('reviewing');
  const usage = await ctx.run(usageReview, { customer: tenancy.customer });
  if (!usage.ok) return ctx.fail(usage.error);
  const summary = await ctx.run(accountSummarizer, { customer: tenancy.customer, plan: tenancy.plan, ...usage.value });
  if (!summary.ok) return ctx.fail(summary.error);
  const decision = await ctx.halt({
    name: 'upsell-decision',
    show: `${summary.value.summary}\n\nUpsell case: ${summary.value.upsellCase}`,
    decision: z.object({ upsell: z.boolean(), note: z.string() }),
  });
  const now = ctx.now();
  await ctx.update({ lastReviewAt: now.toISOString(), upsellOffered: decision.upsell });
  return ctx.until('between-reviews', { at: new Date(now.getTime() + 30 * dayMs), then: 'review-due' });
});

const tenancyLane = H.lane('tenancies', Tenancy)
  .handler(reviewTenancy)
  .suppliers(H.operator)
  .store(sqlite.store(Tenancy, 'tenancies.db'));

const ourTurn = H.state('our-turn', 'pending');
const drafting = H.state('drafting', 'active');
const theirTurn = H.state('their-turn', 'waiting');
const needsAttention = H.state('needs-attention', 'waiting');
const agreed = H.state('agreed', 'terminal', 'success');
const weWalked = H.state('we-walked', 'terminal', 'neutral');
const theyWalked = H.state('they-walked', 'terminal', 'neutral');
const expired = H.state('expired', 'terminal', 'neutral');

const Negotiation = H.kind('Negotiation')
  .data(z.object({
    vendor: z.string(),
    item: z.string(),
    expiresAt: z.string(),
    round: z.number().int(),
    lastVendorMessage: z.string(),
    ourLastOffer: z.string().optional(),
  }))
  .states([ourTurn, drafting, theirTurn, needsAttention, agreed, weWalked, theyWalked, expired], {
    initial: 'our-turn',
    afterFailure: 'needs-attention',
    afterCancel: 'needs-attention',
  });

const vendorReplies = http.webhook(Negotiation, {
  path: '/webhooks/vendor-replies',
  secret: H.env('VENDOR_WEBHOOK_SECRET'),
  body: z.object({
    event: z.enum(['reply', 'accepted', 'walked-away']),
    negotiation: z.string(),
    message: z.string(),
  }),
  read: body => body.event === 'reply'
    ? { update: body.negotiation, patch: { lastVendorMessage: body.message }, state: 'our-turn' }
    : body.event === 'accepted'
      ? { update: body.negotiation, patch: { lastVendorMessage: body.message }, state: 'agreed' }
      : { update: body.negotiation, patch: { lastVendorMessage: body.message }, state: 'they-walked' },
});

const negotiatorRole = H.role('negotiator')
  .input(z.object({ vendor: z.string(), item: z.string(), round: z.number(), vendorMessage: z.string(), ourLastOffer: z.string() }))
  .output(z.object({ move: z.enum(['offer', 'accept', 'walk-away']), message: z.string() }))
  .prompt(n => `Round ${n.round} with ${n.vendor} for ${n.item}. Our last offer: ${n.ourLastOffer}. They said: ${n.vendorMessage}. Draft our next move.`);

const negotiator = H.agent('negotiator', negotiatorRole).model(sonnet);

const sendToVendor = H.command('send-to-vendor')
  .input(z.object({ vendor: z.string(), message: z.string() }))
  .argv(m => ['vendor-mail', '--to', m.vendor, '--body', m.message])
  .on(local);

const negotiateRound = H.flow('negotiate-round').for(Negotiation).does(async ctx => {
  const deal = ctx.unit.data;
  await ctx.move('drafting');
  const draft = await ctx.run(negotiator, {
    vendor: deal.vendor,
    item: deal.item,
    round: deal.round,
    vendorMessage: deal.lastVendorMessage,
    ourLastOffer: deal.ourLastOffer ?? 'none yet',
  });
  if (!draft.ok) return ctx.fail(draft.error);
  if (draft.value.move === 'walk-away') {
    const confirmation = await ctx.halt({
      name: 'confirm-walk-away',
      show: draft.value.message,
      decision: z.object({ walkAway: z.boolean() }),
    });
    if (!confirmation.walkAway) return 'needs-attention';
    const farewell = await ctx.run(sendToVendor, { vendor: deal.vendor, message: draft.value.message });
    return farewell.ok ? 'we-walked' : ctx.fail(farewell.error);
  }
  const sent = await ctx.run(sendToVendor, { vendor: deal.vendor, message: draft.value.message });
  if (!sent.ok) return ctx.fail(sent.error);
  await ctx.update({ round: deal.round + 1, ourLastOffer: draft.value.message });
  return draft.value.move === 'accept' ? 'agreed' : 'their-turn';
});

const negotiationLane = H.lane('negotiations', Negotiation)
  .handler(negotiateRound)
  .suppliers(H.operator, vendorReplies)
  .store(sqlite.store(Negotiation, 'negotiations.db'));

const negotiationExpires = H.trigger(
  'negotiation-expires',
  H.on.deadline(Negotiation, deal => new Date(deal.expiresAt), ['our-turn', 'drafting', 'their-turn', 'needs-attention']),
  (_event, act) => act.move('expired')
);

export const lifecycles = H.harness('lifecycles')
  .ledger(sqlite.ledger('lifecycles.db'))
  .lanes(experimentLane, tenancyLane, negotiationLane)
  .pools(H.pool('api', [{ account: apiAccount, share: 1 }], firstEligible))
  .triggers(negotiationExpires)
  .scheduler(H.policy.scheduler('oldest-first', view => ({
    start: [...view.pending].sort((a, b) => b.waitedMs - a.waitedMs),
  })))
  .clients(claude.supervisor({ grants: [H.ops.readWork, H.ops.writeWork, H.ops.resolveHalts, H.ops.readTelemetry] }))
  .observers(markdown.board('BOARD.md'), markdown.telemetry('TELEMETRY.md'));
