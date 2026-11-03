import { H, type Metrics, type SupplyOf } from 'harness-dsl';
import * as anthropic from 'harness-dsl/anthropic';
import * as sqlite from 'harness-dsl/sqlite';
import * as shell from 'harness-dsl/shell';
import * as http from 'harness-dsl/http';
import * as claude from 'harness-dsl/claude-code';
import * as markdown from 'harness-dsl/markdown';
import { z } from 'zod';

const local = shell.local('local', { slots: 4 });
const account = anthropic.account('api', { apiKey: H.env('ANTHROPIC_API_KEY') });
const pool = H.pool('api-pool', [{ account, share: 1 }]);
const sonnet = anthropic.model('claude-sonnet');

const scheduled = H.state('scheduled', 'pending');
const sampling = H.state('sampling', 'waiting');
const aWins = H.state('a-wins', 'terminal', 'neutral');
const bWins = H.state('b-wins', 'terminal', 'neutral');
const inconclusive = H.state('inconclusive', 'terminal', 'neutral');
const experiment = H.kind('experiment')
  .data(z.object({ name: z.string() }))
  .states(scheduled, sampling, aWins, bWins, inconclusive);

const reading = z.object({ a: z.number(), b: z.number() });
const measure = H.command('measure-experiment')
  .input(z.object({ name: z.string() }))
  .output(reading)
  .argv(input => ['./experiments/measure', input.name])
  .on(local);
const judge = H.command('judge-experiment')
  .input(z.object({ name: z.string(), samples: z.array(reading) }))
  .output(z.object({ winner: z.enum(['a-wins', 'b-wins', 'inconclusive']) }))
  .argv(input => ['./experiments/judge', input.name, JSON.stringify(input.samples)])
  .on(local);

const runExperiment = H.flow('run-experiment').for(experiment).does(async ctx => {
  const startedMs = ctx.now().getTime();
  const samples: { a: number; b: number }[] = [];
  for (let hour = 1; hour <= 14 * 24; hour++) {
    const sample = await ctx.run(measure, { name: ctx.unit.data.name });
    if (sample.ok) samples.push(sample.value);
    await ctx.wait('sampling', { at: new Date(startedMs + hour * 3_600_000) });
  }
  const verdict = await ctx.run(judge, { name: ctx.unit.data.name, samples });
  return verdict.ok ? verdict.value.winner : ctx.fail(verdict.error);
});

const reviewDue = H.state('review-due', 'pending');
const betweenReviews = H.state('between-reviews', 'waiting');
const suspended = H.state('suspended', 'waiting');
const churned = H.state('churned', 'terminal', 'neutral');
const tenancy = H.kind('tenancy')
  .data(z.object({ customer: z.string(), nextReviewAt: z.string() }))
  .states(reviewDue, betweenReviews, suspended, churned);

const usageReport = H.command('usage-report')
  .input(z.object({ customer: z.string() }))
  .argv(input => ['./tenancy/usage', input.customer])
  .on(local);
const accountSummarizerRole = H.role('account-summarizer')
  .input(z.object({ customer: z.string(), usage: z.string() }))
  .output(z.object({ summary: z.string() }))
  .prompt(input => `Summarize this month's usage for ${input.customer}:\n${input.usage}`);
const accountSummarizer = H.seat('account-summarizer', accountSummarizerRole).model(sonnet);
const upsell = H.halt('upsell', z.object({ upsell: z.boolean(), note: z.string() }))
  .about(z.object({ customer: z.string(), summary: z.string() }));

const monthlyReview = H.flow('monthly-review').for(tenancy).does(async ctx => {
  const customer = ctx.unit.data.customer;
  const usage = await ctx.run(usageReport, { customer });
  if (!usage.ok) return ctx.fail(usage.error);
  const summary = await ctx.run(accountSummarizer, { customer, usage: usage.value });
  if (!summary.ok) return ctx.fail(summary.error);
  await ctx.halt(upsell, `Upsell ${customer}?`, { customer, summary: summary.value.summary });
  await ctx.update({ nextReviewAt: new Date(ctx.now().getTime() + 30 * 86_400_000).toISOString() });
  return 'between-reviews';
});

const reviewClock = H.clock('tenancy-review-clock', tenancy, { daily: '04:00' }, tick =>
  tick.units
    .filter(unit => unit.state === 'between-reviews' && new Date(unit.data.nextReviewAt) <= tick.now)
    .map((unit): SupplyOf<typeof tenancy> => ({ update: unit.key, state: 'review-due' })));

const ourTurn = H.state('our-turn', 'pending');
const theirTurn = H.state('their-turn', 'waiting');
const agreed = H.state('agreed', 'terminal', 'success');
const weWalkedAway = H.state('we-walked-away', 'terminal', 'neutral');
const theyWalkedAway = H.state('they-walked-away', 'terminal', 'neutral');
const expired = H.state('expired', 'terminal', 'neutral');
const negotiation = H.kind('negotiation')
  .data(z.object({
    vendor: z.string(),
    item: z.string(),
    expiresAt: z.string(),
    lastOffer: z.string().optional(),
    lastReply: z.string().optional(),
  }))
  .states(ourTurn, theirTurn, agreed, weWalkedAway, theyWalkedAway, expired);

const negotiatorRole = H.role('negotiator')
  .input(z.object({ vendor: z.string(), item: z.string(), lastOffer: z.string().optional(), lastReply: z.string().optional() }))
  .output(z.object({ action: z.enum(['offer', 'accept', 'walk-away']), offer: z.string() }))
  .prompt(input => `Negotiate ${input.item} with ${input.vendor}. Our last offer: ${input.lastOffer ?? 'none'}. Their reply: ${input.lastReply ?? 'none'}.`);
const negotiator = H.seat('negotiator', negotiatorRole).model(sonnet);
const sendOffer = H.command('send-offer')
  .input(z.object({ vendor: z.string(), offer: z.string() }))
  .argv(input => ['./procurement/send', input.vendor, input.offer])
  .on(local)
  .recovery('park');

const negotiationRound = H.flow('negotiation-round').for(negotiation).does(async ctx => {
  const next = await ctx.run(negotiator, ctx.unit.data);
  if (!next.ok) return ctx.fail(next.error);
  if (next.value.action === 'walk-away') return 'we-walked-away';
  const sent = await ctx.run(sendOffer, { vendor: ctx.unit.data.vendor, offer: next.value.offer });
  if (!sent.ok) return ctx.fail(sent.error);
  if (next.value.action === 'accept') return 'agreed';
  await ctx.update({ lastOffer: next.value.offer });
  return 'their-turn';
});

const vendorReplies = http.webhook(negotiation, {
  path: '/vendor-replies',
  secret: H.env('VENDOR_WEBHOOK_SECRET'),
  body: z.object({ negotiation: z.string(), reply: z.string(), walkedAway: z.boolean() }),
  read: body => body.walkedAway
    ? { update: body.negotiation, state: 'they-walked-away' }
    : { update: body.negotiation, patch: { lastReply: body.reply }, state: 'our-turn' },
});

const experiments = H.lane('experiments', experiment)
  .handler(runExperiment)
  .suppliers(H.operator)
  .store(sqlite.store(experiment, './.harness/units.db'));
const tenancies = H.lane('tenancies', tenancy)
  .handler(monthlyReview)
  .suppliers(H.operator, reviewClock)
  .store(sqlite.store(tenancy, './.harness/units.db'))
  .wip(4);
const negotiations = H.lane('negotiations', negotiation)
  .handler(negotiationRound)
  .suppliers(H.operator, vendorReplies)
  .store(sqlite.store(negotiation, './.harness/units.db'))
  .wip(2);

const negotiationExpiry = H.trigger(
  'negotiation-expiry',
  H.on.deadline(negotiation, data => new Date(data.expiresAt), ['our-turn', 'their-turn']),
  (event, act) => act.move('expired'),
);

const inconclusiveShare = (metrics: Metrics) => metrics.rate({
  among: { entry: 'transition', kind: experiment, position: 'terminal' },
  count: { entry: 'transition', kind: experiment, state: 'inconclusive' },
  days: 180,
});
const lifecycles = H.policy.scheduler('lifecycles', view => {
  const share = inconclusiveShare(view.metrics);
  const holdExperiments = share.samples >= 10 && share.value !== null && share.value > 0.5;
  return { start: view.pending.filter(unit => !(holdExperiments && unit.is(experiment))) };
});

export const harness = H.harness('lifecycles')
  .ledger(sqlite.ledger('./.harness/ledger.db'))
  .lanes(experiments, tenancies, negotiations)
  .pools(pool)
  .triggers(negotiationExpiry)
  .scheduler(lifecycles)
  .clients(claude.supervisor({ grants: [H.ops.readWork, H.ops.writeWork, H.ops.resolveHalts, H.ops.readTelemetry] }))
  .observers(markdown.board('./BOARD.md'));
