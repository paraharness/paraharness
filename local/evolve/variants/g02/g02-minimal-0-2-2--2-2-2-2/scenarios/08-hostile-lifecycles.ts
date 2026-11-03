import { z } from 'zod';
import { H } from 'harness-dsl';
import type { SupplyOf } from 'harness-dsl';
import * as anthropic from 'harness-dsl/anthropic';
import * as claudeCode from 'harness-dsl/claude-code';
import * as sqlite from 'harness-dsl/sqlite';
import * as shell from 'harness-dsl/shell';
import * as http from 'harness-dsl/http';
import * as markdown from 'harness-dsl/markdown';

const local = shell.local('local', { slots: 4 });
const apiAccount = anthropic.account('anthropic-api', { apiKey: H.env('ANTHROPIC_API_KEY') });
const cheapModel = anthropic.model('claude-haiku-4-5');
const strongModel = anthropic.model('claude-sonnet-4-5');

const experimentScheduled = H.state('experiment-scheduled', 'pending');
const observing = H.state('observing', 'waiting');
const aWins = H.state('a-wins', 'terminal', 'neutral');
const bWins = H.state('b-wins', 'terminal', 'neutral');
const inconclusive = H.state('inconclusive', 'terminal', 'neutral');

const experiment = H.kind('experiment')
  .data(z.object({ name: z.string(), endsAt: z.string() }))
  .states(experimentScheduled, observing, aWins, bWins, inconclusive);

const collectReading = H.command('collect-experiment-reading')
  .input(z.object({ experiment: z.string() }))
  .argv(input => ['experiments', 'collect', input.experiment])
  .on(local)
  .recovery('rerun')
  .retry(H.retry({ times: 3, firstDelayMs: 30000 }));

const decideWinner = H.command('decide-experiment-winner')
  .input(z.object({ experiment: z.string() }))
  .output(z.enum(['a', 'b', 'inconclusive']))
  .argv(input => ['experiments', 'decide', input.experiment])
  .on(local)
  .recovery('rerun');

const runExperiment = H.flow('run-experiment')
  .for(experiment)
  .does(async ctx => {
    const endsAt = new Date(ctx.unit.data.endsAt);
    while (ctx.now() < endsAt) {
      const reading = await ctx.run(collectReading, { experiment: ctx.unit.key });
      if (reading.ok === false) return ctx.fail(reading.error);
      await ctx.wait('observing', { at: new Date(ctx.now().getTime() + 3600000) });
    }
    const verdict = await ctx.run(decideWinner, { experiment: ctx.unit.key });
    if (verdict.ok === false) return ctx.fail(verdict.error);
    return verdict.value === 'a' ? 'a-wins' : verdict.value === 'b' ? 'b-wins' : 'inconclusive';
  });

const reviewDue = H.state('review-due', 'pending');
const current = H.state('current', 'waiting');
const suspended = H.state('suspended', 'waiting');
const churned = H.state('churned', 'terminal', 'neutral');

const tenancy = H.kind('tenancy')
  .data(z.object({ customer: z.string(), lastDecision: z.enum(['upsell', 'hold']).optional() }))
  .states(reviewDue, current, suspended, churned);

const usageReview = H.command('usage-review')
  .input(z.object({ customer: z.string() }))
  .output(z.object({ seats: z.number(), monthlyUsd: z.number() }))
  .argv(input => ['billing', 'usage', input.customer])
  .on(local)
  .recovery('rerun');

const accountSummaryRole = H.role('account-summary')
  .input(z.object({ customer: z.string(), seats: z.number(), monthlyUsd: z.number() }))
  .output(z.object({ summary: z.string() }))
  .prompt(input => `Summarize the month for ${input.customer}: ${input.seats} seats, $${input.monthlyUsd}.`);

const accountSummarizer = H.seat('account-summarizer', accountSummaryRole).model(cheapModel);

const upsellDecision = H.halt('upsell-decision', z.object({ upsell: z.boolean() })).about(
  z.object({ customer: z.string(), summary: z.string() })
);

const reviewTenancy = H.flow('review-tenancy')
  .for(tenancy)
  .does(async ctx => {
    const usage = await ctx.run(usageReview, { customer: ctx.unit.data.customer });
    if (usage.ok === false) return ctx.fail(usage.error);
    const summary = await ctx.run(accountSummarizer, {
      customer: ctx.unit.data.customer,
      seats: usage.value.seats,
      monthlyUsd: usage.value.monthlyUsd,
    });
    if (summary.ok === false) return ctx.fail(summary.error);
    const decision = await ctx.halt(upsellDecision, summary.value.summary, {
      customer: ctx.unit.data.customer,
      summary: summary.value.summary,
    });
    await ctx.update({ lastDecision: decision.upsell ? 'upsell' : 'hold' });
    return 'current';
  });

const monthlyTenancyReview = H.clock('monthly-tenancy-review', tenancy, { daily: '06:00' }, tick =>
  tick.now.getUTCDate() === 1
    ? tick.units
        .filter(unit => unit.state === 'current')
        .map((unit): SupplyOf<typeof tenancy> => ({ update: unit.key, state: 'review-due' }))
    : []
);

const ourTurn = H.state('our-turn', 'pending');
const theirTurn = H.state('their-turn', 'waiting');
const agreed = H.state('agreed', 'terminal', 'success');
const walkedAwayByUs = H.state('walked-away-by-us', 'terminal', 'neutral');
const walkedAwayByThem = H.state('walked-away-by-them', 'terminal', 'failure');
const expired = H.state('expired', 'terminal', 'failure');

const negotiation = H.kind('negotiation')
  .data(
    z.object({
      vendor: z.string(),
      item: z.string(),
      expiresAt: z.string(),
      lastVendorReply: z.string().optional(),
      lastOffer: z.string().optional(),
    })
  )
  .states(ourTurn, theirTurn, agreed, walkedAwayByUs, walkedAwayByThem, expired);

const negotiatorRole = H.role('negotiator')
  .input(z.object({ vendor: z.string(), item: z.string(), lastVendorReply: z.string(), lastOffer: z.string() }))
  .output(z.object({ walkAway: z.boolean(), offer: z.string() }))
  .prompt(
    input =>
      `Negotiate ${input.item} with ${input.vendor}. Our last offer: ${input.lastOffer}. Their reply: ${input.lastVendorReply}.`
  );

const negotiator = H.seat('negotiator', negotiatorRole).model(strongModel);

const sendOffer = H.command('send-offer')
  .input(z.object({ vendor: z.string(), offer: z.string() }))
  .argv(input => ['procurement', 'send', input.vendor, input.offer])
  .on(local)
  .recovery('park');

const negotiateRound = H.flow('negotiate-round')
  .for(negotiation)
  .does(async ctx => {
    const drafted = await ctx.run(negotiator, {
      vendor: ctx.unit.data.vendor,
      item: ctx.unit.data.item,
      lastVendorReply: ctx.unit.data.lastVendorReply ?? '',
      lastOffer: ctx.unit.data.lastOffer ?? '',
    });
    if (drafted.ok === false) return ctx.fail(drafted.error);
    if (drafted.value.walkAway) return 'walked-away-by-us';
    const sent = await ctx.run(sendOffer, { vendor: ctx.unit.data.vendor, offer: drafted.value.offer });
    if (sent.ok === false) return ctx.fail(sent.error);
    await ctx.update({ lastOffer: drafted.value.offer });
    return 'their-turn';
  });

const vendorReplies = http.webhook(negotiation, {
  path: '/vendor-replies',
  secret: H.env('VENDOR_WEBHOOK_SECRET'),
  body: z.object({ negotiation: z.string(), event: z.enum(['reply', 'accept', 'withdraw']), text: z.string() }),
  read: body =>
    body.event === 'accept'
      ? { update: body.negotiation, state: 'agreed' }
      : body.event === 'withdraw'
        ? { update: body.negotiation, state: 'walked-away-by-them' }
        : { update: body.negotiation, patch: { lastVendorReply: body.text }, state: 'our-turn', deferred: true },
});

const negotiationExpiry = H.deadline('negotiation-expiry', negotiation, data => new Date(data.expiresAt), [
  'our-turn',
  'their-turn',
]);

const expireNegotiation = H.trigger('expire-negotiation', H.on.deadline(negotiationExpiry), (_event, act) =>
  act.move('expired')
);

const experiments = H.lane('experiments', experiment).handler(runExperiment).suppliers(H.operator).store(
  sqlite.store(experiment, '/srv/lifecycles/units.db')
);
const tenancies = H.lane('tenancies', tenancy)
  .handler(reviewTenancy)
  .suppliers(H.operator, monthlyTenancyReview)
  .store(sqlite.store(tenancy, '/srv/lifecycles/units.db'))
  .wip(3);
const negotiations = H.lane('negotiations', negotiation)
  .handler(negotiateRound)
  .suppliers(H.operator, vendorReplies)
  .store(sqlite.store(negotiation, '/srv/lifecycles/units.db'))
  .wip(2);

const lifecycleReport = H.report('lifecycle-outcomes', (metrics, now) => {
  const yearAgo = new Date(now.getTime() - 365 * 86400000);
  const negotiationOutcomes = metrics.rateBy({
    among: { entry: 'transition', kind: negotiation, position: 'terminal' },
    count: { entry: 'transition', kind: negotiation, position: 'terminal' },
    by: 'state',
    since: yearAgo,
  });
  return {
    experimentsInconclusive: metrics.rate({
      among: { entry: 'transition', kind: experiment, position: 'terminal' },
      count: { entry: 'transition', kind: experiment, state: inconclusive },
      since: yearAgo,
    }),
    experimentsAWins: metrics.count({ of: { entry: 'transition', kind: experiment, state: aWins }, since: yearAgo }),
    experimentsBWins: metrics.count({ of: { entry: 'transition', kind: experiment, state: bWins }, since: yearAgo }),
    tenancySuspensions: metrics.count({ of: { entry: 'transition', kind: tenancy, state: suspended }, since: yearAgo }),
    tenancyChurn: metrics.count({ of: { entry: 'transition', kind: tenancy, state: churned }, since: yearAgo }),
    ...negotiationOutcomes,
  };
});

export const lifecycles = H.harness('lifecycles')
  .ledger(sqlite.ledger('/srv/lifecycles/ledger.db'))
  .lanes(experiments, tenancies, negotiations)
  .pools(H.pool('api', [{ account: apiAccount, share: 1 }]))
  .triggers(expireNegotiation)
  .reports(lifecycleReport)
  .clients(
    claudeCode.supervisor({
      grants: [H.ops.readWork, H.ops.writeWork, H.ops.resolve(upsellDecision, H.parked), H.ops.readTelemetry],
    })
  )
  .observers(markdown.board('/srv/lifecycles/BOARD.md'), markdown.telemetry('/srv/lifecycles/TELEMETRY.md'));

export const running = lifecycles.start();
