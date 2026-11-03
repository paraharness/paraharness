import { z } from 'zod';
import { H } from 'harness-dsl';
import * as anthropic from 'harness-dsl/anthropic';
import * as claudeCode from 'harness-dsl/claude-code';
import * as http from 'harness-dsl/http';
import * as markdown from 'harness-dsl/markdown';
import * as shell from 'harness-dsl/shell';
import * as sqlite from 'harness-dsl/sqlite';

const local = shell.local('local', { slots: 4 });
const sonnet = anthropic.model('claude-sonnet-4-5');
const unitStore = 'state/lifecycles.sqlite';

const experimentQueued = H.state('experiment-queued', 'pending');
const measuring = H.state('measuring', 'active');
const collecting = H.state('collecting', 'waiting');
const aWins = H.state('a-wins', 'terminal', 'neutral');
const bWins = H.state('b-wins', 'terminal', 'neutral');
const inconclusive = H.state('inconclusive', 'terminal', 'neutral');

const Experiment = H.kind('experiment')
  .data(z.object({ hypothesis: z.string(), metric: z.string(), minVisitors: z.number(), minLift: z.number() }))
  .states(experimentQueued, measuring, collecting, aWins, bWins, inconclusive);

const measure = H.command('measure-experiment')
  .input(z.object({ experiment: z.string(), metric: z.string() }))
  .output(z.object({ a: z.number(), b: z.number(), visitors: z.number() }))
  .argv(input => ['experiment-metric', '--id', input.experiment, '--metric', input.metric])
  .on(local)
  .recovery('rerun');

const hourMs = 3_600_000;
const readingsInTwoWeeks = 14 * 24;

const experimentFlow = H.flow('run-experiment').for(Experiment).does(async ctx => {
  await ctx.move('measuring');
  const startedAt = ctx.now().getTime();
  let latest = { a: 0, b: 0, visitors: 0 };
  for (let hour = 1; hour <= readingsInTwoWeeks; hour++) {
    const reading = await ctx.run(measure, { experiment: ctx.unit.key, metric: ctx.unit.data.metric });
    if (reading.ok) latest = reading.value;
    if (hour < readingsInTwoWeeks) await ctx.wait('collecting', { at: new Date(startedAt + hour * hourMs) });
  }
  const { minVisitors, minLift } = ctx.unit.data;
  if (latest.visitors < minVisitors || Math.abs(latest.b - latest.a) < minLift) return 'inconclusive';
  return latest.a > latest.b ? 'a-wins' : 'b-wins';
});

const reviewDue = H.state('review-due', 'pending');
const reviewing = H.state('reviewing', 'active');
const betweenReviews = H.state('between-reviews', 'waiting');
const suspended = H.state('suspended', 'waiting');
const churned = H.state('churned', 'terminal', 'neutral');

const Tenancy = H.kind('tenancy')
  .data(z.object({ customer: z.string(), plan: z.string(), lastDecision: z.enum(['upsell', 'keep', 'suspend']).optional() }))
  .states(reviewDue, reviewing, betweenReviews, suspended, churned);

const usageReport = H.command('usage-report')
  .input(z.object({ tenant: z.string() }))
  .output(z.object({ lines: z.array(z.string()) }))
  .argv(input => ['usage-report', '--tenant', input.tenant, '--days', '31'])
  .on(local)
  .recovery('rerun');

const accountReviewRole = H.role('account-reviewer')
  .input(z.object({ customer: z.string(), plan: z.string(), usage: z.array(z.string()) }))
  .output(z.object({ summary: z.string() }))
  .prompt(input => `Summarise last month for ${input.customer} on ${input.plan}:\n${input.usage.join('\n')}`)
  .intents(['read']);

const accountReviewer = H.agent('account-reviewer', accountReviewRole).model(sonnet);

const tenancyDecision = H.halt('tenancy-decision', z.object({ action: z.enum(['upsell', 'keep', 'suspend']), note: z.string() }));

const tenancyFlow = H.flow('tenancy-review').for(Tenancy).does(async ctx => {
  await ctx.move('reviewing');
  const usage = await ctx.run(usageReport, { tenant: ctx.unit.key });
  if (!usage.ok) return ctx.fail(usage.error);
  const summary = await ctx.run(accountReviewer, { customer: ctx.unit.data.customer, plan: ctx.unit.data.plan, usage: usage.value.lines });
  if (!summary.ok) return ctx.fail(summary.error);
  const decision = await ctx.halt(tenancyDecision, summary.value.summary);
  await ctx.update({ lastDecision: decision.action });
  return decision.action === 'suspend' ? 'suspended' : 'between-reviews';
});

const monthlyReview = H.clock('monthly-tenancy-review', Tenancy, { daily: '06:00' }, ({ now, units }) =>
  now.getUTCDate() === 1
    ? units.filter(unit => unit.state === 'between-reviews').map(unit => Tenancy.update(unit.key, { state: 'review-due' }))
    : []);

const ourTurn = H.state('our-turn', 'pending');
const drafting = H.state('drafting', 'active');
const theirTurn = H.state('their-turn', 'waiting');
const agreed = H.state('agreed', 'terminal', 'success');
const weWalked = H.state('we-walked', 'terminal', 'neutral');
const theyWalked = H.state('they-walked', 'terminal', 'neutral');
const expired = H.state('expired', 'terminal', 'neutral');

const Negotiation = H.kind('negotiation')
  .data(z.object({ vendor: z.string(), target: z.string(), expiresAt: z.string(), lastVendorOffer: z.string().optional() }))
  .states(ourTurn, drafting, theirTurn, agreed, weWalked, theyWalked, expired);

const negotiatorRole = H.role('negotiator')
  .input(z.object({ vendor: z.string(), target: z.string(), lastVendorOffer: z.string() }))
  .output(z.object({ move: z.enum(['offer', 'accept', 'walk-away']), offer: z.string(), rationale: z.string() }))
  .prompt(input => `Negotiate with ${input.vendor} toward ${input.target}. Their last offer: ${input.lastVendorOffer}`)
  .intents(['read']);

const negotiator = H.agent('negotiator', negotiatorRole).model(sonnet);

const sendToVendor = H.command('send-to-vendor')
  .input(z.object({ negotiation: z.string(), move: z.enum(['offer', 'accept']), text: z.string() }))
  .argv(input => ['vendor-message', '--negotiation', input.negotiation, '--move', input.move, '--text', input.text])
  .on(local)
  .recovery('park');

const walkAwayDecision = H.halt('walk-away-decision', z.object({ walkAway: z.boolean() }));

const negotiationFlow = H.flow('negotiation-round').for(Negotiation).does(async ctx => {
  await ctx.move('drafting');
  const { vendor, target } = ctx.unit.data;
  const proposal = await ctx.run(negotiator, { vendor, target, lastVendorOffer: ctx.unit.data.lastVendorOffer ?? 'none yet' });
  if (!proposal.ok) return ctx.fail(proposal.error);
  if (proposal.value.move === 'walk-away') {
    const confirmed = await ctx.halt(walkAwayDecision, proposal.value.rationale);
    if (confirmed.walkAway) return 'we-walked';
  }
  const move = proposal.value.move === 'accept' ? 'accept' : 'offer';
  const sent = await ctx.run(sendToVendor, { negotiation: ctx.unit.key, move, text: proposal.value.offer });
  if (!sent.ok) return ctx.fail(sent.error);
  return move === 'accept' ? 'agreed' : 'their-turn';
});

const vendorReplies = http.webhook(Negotiation, {
  path: '/vendor-replies',
  secret: H.env('VENDOR_WEBHOOK_SECRET'),
  body: z.object({ negotiationId: z.string(), reply: z.enum(['offer', 'accept', 'walk-away']), text: z.string() }),
  read: body =>
    body.reply === 'accept'
      ? Negotiation.update(body.negotiationId, { state: 'agreed' })
      : body.reply === 'walk-away'
        ? Negotiation.update(body.negotiationId, { state: 'they-walked' })
        : Negotiation.update(body.negotiationId, { patch: { lastVendorOffer: body.text }, state: 'our-turn' }),
});

const negotiationExpiry = H.trigger(
  'negotiation-expiry',
  H.on.deadline(Negotiation, data => new Date(data.expiresAt), ['our-turn', 'drafting', 'their-turn']),
  (_event, act) => act.move('expired'),
);

const experiments = H.lane('experiments', Experiment).handler(experimentFlow).suppliers(H.operator).store(sqlite.store(Experiment, unitStore));
const tenancies = H.lane('tenancies', Tenancy).handler(tenancyFlow).suppliers(H.operator, monthlyReview).store(sqlite.store(Tenancy, unitStore));
const negotiations = H.lane('negotiations', Negotiation).handler(negotiationFlow).suppliers(H.operator, vendorReplies).store(sqlite.store(Negotiation, unitStore));

const experimentEnds = Experiment.entered('a-wins', 'b-wins', 'inconclusive');

const scheduler = H.policy.scheduler('lifecycle-order', ({ pending, active, metrics }) => {
  const inconclusiveRate = metrics.rate({ among: experimentEnds, count: Experiment.entered('inconclusive'), days: 180 });
  const runningExperiments = active.filter(unit => unit.is(Experiment)).length;
  const welcomeExperiments = inconclusiveRate.samples < 10 || (inconclusiveRate.value ?? 0) < 0.5 || runningExperiments === 0;
  return {
    start: [
      ...pending.flatMap(unit => (unit.is(Negotiation) ? [unit] : [])),
      ...pending.flatMap(unit => (unit.is(Tenancy) ? [unit] : [])),
      ...(welcomeExperiments ? pending.flatMap(unit => (unit.is(Experiment) ? [unit] : [])) : []),
    ],
  };
});

const pool = H.pool('api', [{ account: anthropic.account('anthropic-api', { apiKey: H.env('ANTHROPIC_API_KEY') }), share: 1 }]);

export const harness = H.harness('lifecycles')
  .ledger(sqlite.ledger('state/ledger.sqlite'))
  .lanes(experiments, tenancies, negotiations)
  .pools(pool)
  .triggers(negotiationExpiry)
  .scheduler(scheduler)
  .clients(claudeCode.supervisor({ grants: [H.ops.readWork, H.ops.writeWork, H.ops.resolveHalts, H.ops.readTelemetry] }))
  .observers(markdown.board('BOARD.md'), markdown.telemetry('TELEMETRY.md'));
