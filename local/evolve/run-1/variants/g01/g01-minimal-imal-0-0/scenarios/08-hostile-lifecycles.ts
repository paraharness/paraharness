import { H } from 'harness-dsl';
import { z } from 'zod';
import * as anthropic from 'harness-dsl/anthropic';
import * as claudeCode from 'harness-dsl/claude-code';
import * as http from 'harness-dsl/http';
import * as sqlite from 'harness-dsl/sqlite';
import * as shell from 'harness-dsl/shell';
import * as markdown from 'harness-dsl/markdown';

const stalled = H.state('stalled', 'waiting');

const scheduled = H.state('scheduled', 'pending');
const sampling = H.state('sampling', 'active');
const betweenSamples = H.state('between-samples', 'waiting');
const aWins = H.state('a-wins', 'terminal', 'success');
const bWins = H.state('b-wins', 'terminal', 'success');
const inconclusive = H.state('inconclusive', 'terminal', 'neutral');

const Experiment = H.kind('Experiment')
  .data(z.object({
    experimentId: z.string(),
    endsAt: z.string(),
    samplesA: z.array(z.number()),
    samplesB: z.array(z.number()),
  }))
  .states([scheduled, sampling, betweenSamples, stalled, aWins, bWins, inconclusive], { initial: 'scheduled', afterFailure: 'between-samples' });

const customer = H.state('customer', 'waiting');
const dueReview = H.state('due-review', 'pending');
const reviewing = H.state('reviewing', 'active');
const suspended = H.state('suspended', 'waiting');
const churned = H.state('churned', 'terminal', 'neutral');

const Tenancy = H.kind('Tenancy')
  .data(z.object({
    tenantId: z.string(),
    customer: z.string(),
    lastReview: z.string(),
    lastDecision: z.enum(['none', 'upsell', 'hold']),
  }))
  .states([customer, dueReview, reviewing, suspended, stalled, churned], { initial: 'due-review', afterFailure: 'stalled' });

const ourTurn = H.state('our-turn', 'pending');
const drafting = H.state('drafting', 'active');
const theirTurn = H.state('their-turn', 'waiting');
const agreed = H.state('agreed', 'terminal', 'success');
const walkedAwayUs = H.state('walked-away-us', 'terminal', 'neutral');
const walkedAwayThem = H.state('walked-away-them', 'terminal', 'neutral');
const expired = H.state('expired', 'terminal', 'neutral');

const Negotiation = H.kind('Negotiation')
  .data(z.object({
    negotiationId: z.string(),
    vendor: z.string(),
    item: z.string(),
    ourLimitUsd: z.number(),
    expiresAt: z.string(),
    vendorMessage: z.string(),
    vendorOfferUsd: z.number().nullable(),
    ourLastOfferUsd: z.number().nullable(),
    round: z.number(),
  }))
  .states([ourTurn, drafting, theirTurn, stalled, agreed, walkedAwayUs, walkedAwayThem, expired], { initial: 'our-turn', afterFailure: 'stalled' });

const local = shell.local('local', { slots: 4 });

const measure = H.command('measure-experiment')
  .input(z.object({ experimentId: z.string() }))
  .output(z.object({ a: z.number(), b: z.number() }))
  .argv(i => ['experiment-metric', i.experimentId])
  .on(local)
  .onCrash('rerun');

function mean(values: readonly number[]): number {
  return values.length === 0 ? 0 : values.reduce((s, v) => s + v, 0) / values.length;
}

const experimentVerdict = H.policy.rule<{ a: readonly number[]; b: readonly number[] }, 'a-wins' | 'b-wins' | 'inconclusive'>(
  'experiment-verdict',
  input => {
    const a = mean(input.a);
    const b = mean(input.b);
    const lift = a === 0 ? 0 : (b - a) / a;
    if (input.a.length < 24 || Math.abs(lift) < 0.05) return 'inconclusive';
    return lift > 0 ? 'b-wins' : 'a-wins';
  });

const runExperiment = H.flow('run-experiment').for(Experiment).does(async ctx => {
  await ctx.move('sampling');
  const experiment = ctx.unit.data;
  const sample = await ctx.run(measure, { experimentId: experiment.experimentId });
  if (!sample.ok) return ctx.fail(sample.error);
  const samplesA = [...experiment.samplesA, sample.value.a];
  const samplesB = [...experiment.samplesB, sample.value.b];
  await ctx.update({ samplesA, samplesB });
  const now = ctx.now();
  if (now.getTime() >= new Date(experiment.endsAt).getTime()) {
    return ctx.decide(experimentVerdict, { a: samplesA, b: samplesB });
  }
  return ctx.until('between-samples', { at: new Date(now.getTime() + 60 * 60 * 1000), then: 'scheduled' });
});

const usageReport = H.command('usage-report')
  .input(z.object({ tenantId: z.string() }))
  .output(z.object({ seats: z.number(), activeUsers: z.number(), spendUsd: z.number() }))
  .argv(i => ['billing', 'usage', i.tenantId, '--json'])
  .on(local)
  .onCrash('rerun');

const accountReviewer = H.role('account-reviewer')
  .input(z.object({ customer: z.string(), seats: z.number(), activeUsers: z.number(), spendUsd: z.number() }))
  .output(z.object({ summary: z.string() }))
  .prompt(i => `Summarise ${i.customer}'s month: ${i.activeUsers} of ${i.seats} seats active, $${i.spendUsd} spent. Say whether an upsell looks warranted.`)
  .intents([]);

const sonnet = anthropic.model('claude-sonnet-4-5');
const accountSummarizer = H.agent('account-summarizer', accountReviewer).model(sonnet);

const reviewTenancy = H.flow('review-tenancy').for(Tenancy).does(async ctx => {
  await ctx.move('reviewing');
  const tenancy = ctx.unit.data;
  const usage = await ctx.run(usageReport, { tenantId: tenancy.tenantId });
  if (!usage.ok) return ctx.fail(usage.error);
  const summary = await ctx.run(accountSummarizer, { customer: tenancy.customer, ...usage.value });
  if (!summary.ok) return ctx.fail(summary.error);
  const decision = await ctx.halt({
    name: 'upsell-decision',
    show: summary.value.summary,
    decision: z.object({ upsell: z.boolean(), note: z.string() }),
  });
  await ctx.update({ lastReview: ctx.now().toISOString(), lastDecision: decision.upsell ? 'upsell' : 'hold' });
  return 'customer';
});

const negotiatorRole = H.role('negotiator')
  .input(z.object({
    vendor: z.string(),
    item: z.string(),
    ourLimitUsd: z.number(),
    vendorMessage: z.string(),
    vendorOfferUsd: z.number().nullable(),
    ourLastOfferUsd: z.number().nullable(),
    round: z.number(),
  }))
  .output(z.object({
    action: z.enum(['offer', 'accept', 'walk-away']),
    offerUsd: z.number().nullable(),
    message: z.string(),
  }))
  .prompt(i => `Round ${i.round} with ${i.vendor} for ${i.item}. Our ceiling is $${i.ourLimitUsd}. They said: ${i.vendorMessage}`)
  .intents([]);

const negotiator = H.agent('negotiator', negotiatorRole).model(anthropic.model('claude-opus-4-1'));

const sendToVendor = H.command('send-to-vendor')
  .input(z.object({ negotiationId: z.string(), message: z.string() }))
  .argv(i => ['procurement', 'send', i.negotiationId, i.message])
  .on(local)
  .onCrash('park');

const negotiateRound = H.flow('negotiate-round').for(Negotiation).does(async ctx => {
  await ctx.move('drafting');
  const n = ctx.unit.data;
  const proposal = await ctx.run(negotiator, {
    vendor: n.vendor,
    item: n.item,
    ourLimitUsd: n.ourLimitUsd,
    vendorMessage: n.vendorMessage,
    vendorOfferUsd: n.vendorOfferUsd,
    ourLastOfferUsd: n.ourLastOfferUsd,
    round: n.round,
  });
  if (!proposal.ok) return ctx.fail(proposal.error);
  const sent = await ctx.run(sendToVendor, { negotiationId: n.negotiationId, message: proposal.value.message });
  if (!sent.ok) return ctx.fail(sent.error);
  if (proposal.value.action === 'accept') return 'agreed';
  if (proposal.value.action === 'walk-away') return 'walked-away-us';
  await ctx.update({ ourLastOfferUsd: proposal.value.offerUsd, round: n.round + 1 });
  return 'their-turn';
});

const billingEvents = http.webhook(Tenancy, {
  path: '/webhooks/billing',
  secret: H.env('BILLING_WEBHOOK_SECRET'),
  body: z.object({ tenantId: z.string(), event: z.enum(['suspended', 'reinstated', 'churned', 'other']) }),
  read: b => b.event === 'other'
    ? null
    : { update: b.tenantId, state: b.event === 'suspended' ? 'suspended' : b.event === 'churned' ? 'churned' : 'customer' },
});

const vendorReplies = http.webhook(Negotiation, {
  path: '/webhooks/vendor-replies',
  secret: H.env('VENDOR_WEBHOOK_SECRET'),
  body: z.object({
    negotiationId: z.string(),
    message: z.string(),
    offerUsd: z.number().nullable(),
    response: z.enum(['counter', 'accepted', 'declined']),
  }),
  read: b => ({
    update: b.negotiationId,
    patch: { vendorMessage: b.message, vendorOfferUsd: b.offerUsd },
    state: b.response === 'accepted' ? 'agreed' : b.response === 'declined' ? 'walked-away-them' : 'our-turn',
  }),
});

const experiments = H.lane('experiments', Experiment).handler(runExperiment).suppliers(H.operator).store(sqlite.store(Experiment, '.harness/work.db')).wip(5);
const tenancies = H.lane('tenancies', Tenancy).handler(reviewTenancy).suppliers(H.operator, billingEvents).store(sqlite.store(Tenancy, '.harness/work.db')).wip(3);
const negotiations = H.lane('negotiations', Negotiation).handler(negotiateRound).suppliers(H.operator, vendorReplies).store(sqlite.store(Negotiation, '.harness/work.db')).wip(2);

const monthlyReview = H.trigger('monthly-tenancy-review',
  H.on.cadence(Tenancy, { monthly: { day: 1, at: '09:00' } }, ['customer']),
  (_event, act) => act.move('due-review'));

const negotiationExpiry = H.trigger('negotiation-expiry',
  H.on.deadline(Negotiation, d => new Date(d.expiresAt), ['our-turn', 'drafting', 'their-turn', 'stalled']),
  (_event, act) => act.move('expired'));

const laneRank: Readonly<Record<string, number>> = { Negotiation: 0, Tenancy: 1, Experiment: 2 };

const scheduler = H.policy.scheduler('negotiations-first', v => {
  const verdicts = v.metrics.rate({
    among: { entry: 'transition', kind: 'Experiment', position: 'terminal' },
    count: { entry: 'transition', kind: 'Experiment', state: 'inconclusive' },
    days: 180,
  });
  const mostlyInconclusive = verdicts.samples >= 10 && (verdicts.value ?? 0) > 0.5;
  const experimentsRunning = v.active.filter(a => a.kind === 'Experiment').length;
  return {
    start: [...v.pending]
      .filter(p => !(mostlyInconclusive && experimentsRunning > 0 && p.is(Experiment) && p.data.samplesA.length === 0))
      .sort((a, b) => (laneRank[a.kind] ?? 9) - (laneRank[b.kind] ?? 9) || b.waitedMs - a.waitedMs),
  };
});

const api = anthropic.account('api', { apiKey: H.env('ANTHROPIC_API_KEY') });
const pool = H.pool('api', [{ account: api, share: 1 }],
  H.policy.account('provider-match', c => c.accounts.find(a => a.eligible && a.account.provider === c.model.provider)?.account ?? null));

export const hostileLifecycles = H.harness('hostile-lifecycles')
  .ledger(sqlite.ledger('.harness/ledger.db'))
  .lanes(experiments, tenancies, negotiations)
  .pools(pool)
  .triggers(monthlyReview, negotiationExpiry)
  .scheduler(scheduler)
  .clients(claudeCode.supervisor({ grants: [H.ops.readWork, H.ops.writeWork, H.ops.resolveHalts, H.ops.readTelemetry] }))
  .observers(markdown.board('BOARD.md'), markdown.telemetry('TELEMETRY.md'));
