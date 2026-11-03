import { z } from 'zod';
import { H } from 'harness-dsl';
import type { SupplyOf } from 'harness-dsl';
import * as anthropic from 'harness-dsl/anthropic';
import * as sqlite from 'harness-dsl/sqlite';
import * as shell from 'harness-dsl/shell';
import * as http from 'harness-dsl/http';
import * as markdown from 'harness-dsl/markdown';

const local = shell.local('local', { slots: 4 });
const apiAccount = anthropic.account('anthropic-api', { apiKey: H.env('ANTHROPIC_API_KEY') });
const sonnet = anthropic.model('claude-sonnet-4-5');
const store = 'lifecycles/.harness/store.sqlite';

const scheduled = H.state('scheduled', 'pending');
const collecting = H.state('collecting', 'waiting');
const aWins = H.state('a-wins', 'terminal', 'neutral');
const bWins = H.state('b-wins', 'terminal', 'neutral');
const inconclusive = H.state('inconclusive', 'terminal', 'neutral');

const experiment = H.kind('experiment')
  .data(z.object({ name: z.string(), metric: z.string() }))
  .states(scheduled, collecting, aWins, bWins, inconclusive);

const measureArms = H.command('measure-arms')
  .input(z.object({ experiment: z.string(), metric: z.string() }))
  .argv(i => ['./experiments/measure.sh', i.experiment, i.metric])
  .on(local)
  .retry(H.retry('measure-retry', { retries: 3, backoff: { initialMs: 60_000, factor: 2 } }));
const concludeExperiment = H.command('conclude-experiment')
  .input(z.object({ experiment: z.string() }))
  .output(z.object({ winner: z.enum(['a', 'b', 'none']) }))
  .argv(i => ['./experiments/conclude.sh', i.experiment])
  .on(local);

const hourMs = 3_600_000;
const experimentHours = 14 * 24;

const runExperiment = H.flow('run-experiment').for(experiment).does(async ctx => {
  const { name, metric } = ctx.unit.data;
  const started = ctx.now().getTime();
  for (let hour = 1; hour <= experimentHours; hour++) {
    await ctx.call(measureArms, { experiment: name, metric });
    await ctx.wait('collecting', { at: new Date(started + hour * hourMs) });
  }
  const verdict = await ctx.call(concludeExperiment, { experiment: name });
  if (!verdict.ok) return ctx.fail(verdict.error);
  return verdict.value.winner === 'a' ? 'a-wins' : verdict.value.winner === 'b' ? 'b-wins' : 'inconclusive';
});

const experiments = H.lane('experiments', experiment)
  .handler(runExperiment)
  .suppliers(H.operator)
  .store(sqlite.store(experiment, store));

const reviewing = H.state('reviewing', 'pending');
const customer = H.state('customer', 'waiting');
const suspended = H.state('suspended', 'waiting');
const churned = H.state('churned', 'terminal', 'neutral');

const tenancy = H.kind('tenancy')
  .data(z.object({ customer: z.string(), plan: z.string(), nextReviewAt: z.string() }))
  .states(reviewing, customer, suspended, churned);

const monthlyReviewDue = H.clock('monthly-review-due', tenancy, { daily: '03:00' }, tick =>
  tick.units
    .filter(unit => unit.state === 'customer' && Date.parse(unit.data.nextReviewAt) <= tick.now.getTime())
    .map((unit): SupplyOf<typeof tenancy> => ({ update: unit.key, state: 'reviewing' }))
);

const usageReview = H.command('usage-review')
  .input(z.object({ customer: z.string() }))
  .output(z.object({ seats: z.number(), spendUsd: z.number(), trend: z.string() }))
  .argv(i => ['./billing/usage.sh', i.customer])
  .on(local);
const openUpsell = H.command('open-upsell')
  .input(z.object({ customer: z.string(), note: z.string() }))
  .argv(i => ['./crm/open-upsell.sh', i.customer, i.note])
  .on(local);

const accountSummarizerRole = H.role('account-summarizer')
  .input(z.object({ customer: z.string(), plan: z.string(), seats: z.number(), spendUsd: z.number(), trend: z.string() }))
  .output(z.object({ summary: z.string() }))
  .prompt(i => `Summarize the month for ${i.customer} on ${i.plan}: ${i.seats} seats, $${i.spendUsd}, trend ${i.trend}.`);
const accountSummarizer = H.seat('account-summarizer', accountSummarizerRole).model(sonnet);

const upsellDecision = H.halt('upsell-decision', z.object({ upsell: z.boolean(), note: z.string() }))
  .about(z.object({ customer: z.string(), summary: z.string() }));

const reviewMs = 30 * 24 * hourMs;

const reviewTenancy = H.flow('review-tenancy').for(tenancy).does(async ctx => {
  const { customer: name, plan } = ctx.unit.data;
  const usage = await ctx.call(usageReview, { customer: name });
  if (!usage.ok) return ctx.fail(usage.error);
  const summary = await ctx.call(accountSummarizer, { customer: name, plan, ...usage.value });
  if (!summary.ok) return ctx.fail(summary.error);
  const decision = await ctx.halt(upsellDecision, summary.value.summary, { customer: name, summary: summary.value.summary });
  if (decision.upsell) {
    const opened = await ctx.call(openUpsell, { customer: name, note: decision.note });
    if (!opened.ok) return ctx.fail(opened.error);
  }
  await ctx.update({ nextReviewAt: new Date(ctx.now().getTime() + reviewMs).toISOString() });
  return 'customer';
});

const tenancies = H.lane('tenancies', tenancy)
  .handler(reviewTenancy)
  .suppliers(H.operator, monthlyReviewDue)
  .store(sqlite.store(tenancy, store))
  .retry(H.retry('tenancy-retry', { retries: 2, backoff: { initialMs: 3_600_000 } }), 'customer');

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
    targetUsd: z.number(),
    expiresAt: z.string(),
    lastVendorOffer: z.string().optional(),
  }))
  .states(ourTurn, theirTurn, agreed, weWalkedAway, theyWalkedAway, expired);

const negotiatorRole = H.role('negotiator')
  .input(z.object({ vendor: z.string(), item: z.string(), targetUsd: z.number(), lastVendorOffer: z.string() }))
  .output(z.object({ action: z.enum(['offer', 'accept', 'walk-away']), message: z.string() }))
  .prompt(i => `Negotiate ${i.item} with ${i.vendor}, target $${i.targetUsd}. Their last offer: ${i.lastVendorOffer}.`);
const negotiator = H.seat('negotiator', negotiatorRole).model(sonnet);

const sendToVendor = H.command('send-to-vendor')
  .input(z.object({ vendor: z.string(), message: z.string() }))
  .argv(i => ['./procurement/send.sh', i.vendor, i.message])
  .on(local)
  .recovery('park');

const negotiateRound = H.flow('negotiate-round').for(negotiation).does(async ctx => {
  const d = ctx.unit.data;
  const move = await ctx.call(negotiator, {
    vendor: d.vendor,
    item: d.item,
    targetUsd: d.targetUsd,
    lastVendorOffer: d.lastVendorOffer ?? 'none yet',
  });
  if (!move.ok) return ctx.fail(move.error);
  if (move.value.action === 'walk-away') return 'we-walked-away';
  const sent = await ctx.call(sendToVendor, { vendor: d.vendor, message: move.value.message });
  if (!sent.ok) return ctx.fail(sent.error);
  return move.value.action === 'accept' ? 'agreed' : 'their-turn';
});

const vendorReplies = http.webhook(negotiation, {
  path: '/vendor-replies',
  secret: H.env('VENDOR_WEBHOOK_SECRET'),
  body: z.object({ negotiationId: z.string(), reply: z.enum(['offer', 'accept', 'walk-away']), text: z.string() }),
  read: body =>
    body.reply === 'offer' ? { update: body.negotiationId, patch: { lastVendorOffer: body.text }, state: 'our-turn' }
    : body.reply === 'accept' ? { update: body.negotiationId, state: 'agreed' }
    : { update: body.negotiationId, state: 'they-walked-away' },
});

const negotiations = H.lane('negotiations', negotiation)
  .handler(negotiateRound)
  .suppliers(H.operator, vendorReplies)
  .store(sqlite.store(negotiation, store))
  .retry(H.retry('negotiation-retry', { retries: 2, backoff: { initialMs: 600_000 } }), 'we-walked-away');

const negotiationExpires = H.trigger(
  'negotiation-expires',
  H.on.deadline(negotiation, d => new Date(d.expiresAt), ['our-turn', 'their-turn']),
  (event, act) => act.move('expired')
);

const experimentOutcomes = H.report('experiment-outcomes', m => ({
  inconclusive: m.rate({
    among: { entry: 'transition', kind: experiment, position: 'terminal' },
    count: { entry: 'transition', kind: experiment, state: inconclusive },
    days: 365,
  }),
  aWins: m.rate({
    among: { entry: 'transition', kind: experiment, position: 'terminal' },
    count: { entry: 'transition', kind: experiment, state: aWins },
    days: 365,
  }),
  bWins: m.rate({
    among: { entry: 'transition', kind: experiment, position: 'terminal' },
    count: { entry: 'transition', kind: experiment, state: bWins },
    days: 365,
  }),
}));

export const lifecycles = H.harness('lifecycles')
  .ledger(sqlite.ledger('lifecycles/.harness/ledger.sqlite'))
  .lanes(experiments, tenancies, negotiations)
  .pools(H.pool('api', [{ account: apiAccount, share: 1 }]))
  .triggers(negotiationExpires)
  .reports(experimentOutcomes)
  .clients(http.control({
    port: 8080,
    token: H.env('CONTROL_TOKEN'),
    grants: [H.ops.readWork, H.ops.writeWork, H.ops.resolve(upsellDecision, H.parked), H.ops.readTelemetry],
  }))
  .observers(markdown.board('lifecycles/BOARD.md'), markdown.telemetry('lifecycles/TELEMETRY.md'));
