import { H, type SupplyOf } from 'harness-dsl';
import { z } from 'zod';
import * as anthropic from 'harness-dsl/anthropic';
import * as sqlite from 'harness-dsl/sqlite';
import * as shell from 'harness-dsl/shell';
import * as http from 'harness-dsl/http';
import * as markdown from 'harness-dsl/markdown';

const apiAccount = anthropic.account('api', { apiKey: H.env('ANTHROPIC_API_KEY') });
const sonnet = anthropic.model('claude-sonnet-4-5');
const apiPool = H.pool('api', [{ account: apiAccount, share: 1 }]);
const localRunner = shell.local('local', { slots: 4 });
const ledger = sqlite.ledger('.harness/ledger.db');

const scheduled = H.state('scheduled', 'pending');
const collecting = H.state('collecting', 'waiting');
const aWins = H.state('a-wins', 'terminal', 'success');
const bWins = H.state('b-wins', 'terminal', 'success');
const inconclusive = H.state('inconclusive', 'terminal', 'neutral');

const experiment = H.kind('Experiment')
  .data(z.object({ name: z.string(), startsAt: z.string() }))
  .states(scheduled, collecting, aWins, bWins, inconclusive);

const measureExperiment = H.command('measure-experiment')
  .input(z.object({ experiment: z.string(), hour: z.number() }))
  .argv(input => ['./experiments/measure', input.experiment, String(input.hour)])
  .on(localRunner)
  .recovery('rerun');

const concludeExperiment = H.command('conclude-experiment')
  .input(z.object({ experiment: z.string() }))
  .output(z.object({ winner: z.enum(['a', 'b', 'none']) }))
  .argv(input => ['./experiments/conclude', input.experiment])
  .on(localRunner)
  .recovery('rerun');

const hourMs = 60 * 60 * 1000;
const experimentHours = 14 * 24;

const runExperiment = H.flow('run-experiment')
  .for(experiment)
  .does(async ctx => {
    const startsAt = Date.parse(ctx.unit.data.startsAt);
    for (let hour = 1; hour <= experimentHours; hour += 1) {
      await ctx.run(measureExperiment, { experiment: ctx.unit.data.name, hour });
      await ctx.wait('collecting', { at: new Date(startsAt + hour * hourMs) });
    }
    const verdict = await ctx.run(concludeExperiment, { experiment: ctx.unit.data.name });
    if (!verdict.ok) return ctx.fail(verdict.error);
    if (verdict.value.winner === 'a') return 'a-wins';
    if (verdict.value.winner === 'b') return 'b-wins';
    return 'inconclusive';
  });

export const inconclusiveShare = H.policy.rule('experiment-inconclusive-share', (window: { days: number }, metrics) =>
  metrics.rate({
    days: window.days,
    among: { entry: 'transition', kind: experiment, position: 'terminal' },
    count: { entry: 'transition', kind: experiment, state: inconclusive }
  })
);

export const experimentOutcomes = H.policy.rule('experiment-outcomes', (window: { days: number }, metrics) =>
  metrics.rateBy({
    days: window.days,
    by: 'state',
    among: { entry: 'transition', kind: experiment, position: 'terminal' },
    count: { entry: 'transition', kind: experiment, position: 'terminal' }
  })
);

const reviewDue = H.state('due', 'pending');
const current = H.state('current', 'waiting');
const suspended = H.state('suspended', 'waiting');
const churned = H.state('churned', 'terminal', 'neutral');

const tenancy = H.kind('Tenancy')
  .data(z.object({ customer: z.string(), plan: z.string() }))
  .states(reviewDue, current, suspended, churned);

const usageReview = H.command('usage-review')
  .input(z.object({ customer: z.string() }))
  .output(z.object({ seats: z.number(), activeUsers: z.number() }))
  .argv(input => ['./tenancy/usage', input.customer])
  .on(localRunner)
  .recovery('rerun');

const openUpsell = H.command('open-upsell')
  .input(z.object({ customer: z.string() }))
  .argv(input => ['./tenancy/open-upsell', input.customer])
  .on(localRunner)
  .recovery('park');

const summaryRole = H.role('tenancy-summary')
  .input(z.object({ customer: z.string(), plan: z.string(), seats: z.number(), activeUsers: z.number() }))
  .output(z.object({ summary: z.string() }))
  .prompt(input => `Summarise the month for ${input.customer} on ${input.plan}: ${input.activeUsers} of ${input.seats} seats active.`);

const tenancySummarizer = H.seat('tenancy-summarizer', summaryRole).model(sonnet);

const upsellDecision = H.halt('upsell-decision', z.object({ upsell: z.boolean() })).about(z.object({ customer: z.string() }));

const reviewTenancy = H.flow('review-tenancy')
  .for(tenancy)
  .does(async ctx => {
    const usage = await ctx.run(usageReview, { customer: ctx.unit.data.customer });
    if (!usage.ok) return ctx.fail(usage.error);
    const summary = await ctx.run(tenancySummarizer, {
      customer: ctx.unit.data.customer,
      plan: ctx.unit.data.plan,
      seats: usage.value.seats,
      activeUsers: usage.value.activeUsers
    });
    if (!summary.ok) return ctx.fail(summary.error);
    const decision = await ctx.halt(upsellDecision, summary.value.summary, { customer: ctx.unit.data.customer });
    if (decision.upsell) {
      const opened = await ctx.run(openUpsell, { customer: ctx.unit.data.customer });
      if (!opened.ok) return ctx.fail(opened.error);
    }
    return 'current';
  });

const monthlyReview = H.clock('monthly-tenancy-review', tenancy, { daily: '06:00' }, tick =>
  tick.now.getUTCDate() === 1
    ? tick.units
        .filter(unit => unit.state === 'current')
        .map((unit): SupplyOf<typeof tenancy> => ({ update: unit.key, state: 'due' }))
    : []
);

const ourTurn = H.state('our-turn', 'pending');
const theirTurn = H.state('their-turn', 'waiting');
const agreed = H.state('agreed', 'terminal', 'success');
const weWalked = H.state('we-walked', 'terminal', 'neutral');
const theyWalked = H.state('they-walked', 'terminal', 'failure');
const expired = H.state('expired', 'terminal', 'neutral');

const negotiation = H.kind('Negotiation')
  .data(z.object({ vendor: z.string(), expiresAt: z.string(), lastReply: z.string().optional() }))
  .states(ourTurn, theirTurn, agreed, weWalked, theyWalked, expired);

const negotiatorRole = H.role('negotiator')
  .input(z.object({ vendor: z.string(), lastReply: z.string().optional() }))
  .output(z.object({ offer: z.string(), walkAway: z.boolean() }))
  .prompt(input => `Draft the next offer to ${input.vendor}. Their last reply: ${input.lastReply ?? 'none yet'}`);

const negotiator = H.seat('negotiator', negotiatorRole).model(sonnet);

const sendOffer = H.command('send-offer')
  .input(z.object({ vendor: z.string(), offer: z.string() }))
  .argv(input => ['./procurement/send-offer', input.vendor, input.offer])
  .on(localRunner)
  .recovery('park');

const negotiateRound = H.flow('negotiate-round')
  .for(negotiation)
  .does(async ctx => {
    const offer = await ctx.run(negotiator, { vendor: ctx.unit.data.vendor, lastReply: ctx.unit.data.lastReply });
    if (!offer.ok) return ctx.fail(offer.error);
    if (offer.value.walkAway) return 'we-walked';
    const sent = await ctx.run(sendOffer, { vendor: ctx.unit.data.vendor, offer: offer.value.offer });
    if (!sent.ok) return ctx.fail(sent.error);
    return 'their-turn';
  });

const vendorReplies = http.webhook(negotiation, {
  path: '/vendor-replies',
  secret: H.env('VENDOR_WEBHOOK_SECRET'),
  body: z.object({ negotiation: z.string(), status: z.enum(['counter', 'accept', 'walk']), message: z.string() }),
  read: body =>
    body.status === 'counter'
      ? { update: body.negotiation, patch: { lastReply: body.message }, state: 'our-turn', deferred: true }
      : body.status === 'accept'
        ? { update: body.negotiation, patch: { lastReply: body.message }, state: 'agreed', deferred: true }
        : { update: body.negotiation, patch: { lastReply: body.message }, state: 'they-walked', deferred: true }
});

const negotiationExpiry = H.trigger(
  'negotiation-expiry',
  H.on.deadline(negotiation, data => new Date(data.expiresAt), ['our-turn', 'their-turn']),
  (_event, act) => act.move('expired')
);

const experimentLane = H.lane('experiments', experiment).handler(runExperiment).suppliers(H.operator).store(sqlite.store(experiment, '.harness/experiments.db'));
const tenancyLane = H.lane('tenancies', tenancy).handler(reviewTenancy).suppliers(H.operator, monthlyReview).store(sqlite.store(tenancy, '.harness/tenancies.db'));
const negotiationLane = H.lane('negotiations', negotiation)
  .handler(negotiateRound)
  .suppliers(H.operator, vendorReplies)
  .store(sqlite.store(negotiation, '.harness/negotiations.db'));

export const harness = H.harness('hostile-lifecycles')
  .ledger(ledger)
  .lanes(experimentLane, tenancyLane, negotiationLane)
  .pools(apiPool)
  .triggers(negotiationExpiry)
  .clients(
    http.control({
      port: 7410,
      token: H.env('CONTROL_TOKEN'),
      grants: [H.ops.readWork, H.ops.writeWork, H.ops.resolve(upsellDecision), H.ops.readTelemetry]
    })
  )
  .observers(markdown.board('BOARD.md'), markdown.telemetry('TELEMETRY.md'));
