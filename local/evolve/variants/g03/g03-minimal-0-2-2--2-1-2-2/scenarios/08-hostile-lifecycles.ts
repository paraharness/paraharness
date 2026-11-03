import { z } from 'zod';
import { H, type SupplyOf } from 'harness-dsl';
import * as anthropic from 'harness-dsl/anthropic';
import * as sqlite from 'harness-dsl/sqlite';
import * as http from 'harness-dsl/http';
import * as shell from 'harness-dsl/shell';
import * as claude from 'harness-dsl/claude-code';
import * as markdown from 'harness-dsl/markdown';

const api = anthropic.account('lifecycles-api', { apiKey: H.env('ANTHROPIC_API_KEY') });
const strong = anthropic.model('claude-sonnet-4-5');
const pool = H.pool('lifecycles-accounts', [{ account: api, share: 1 }]);
const local = shell.local('local', { slots: 4 });
const ledger = sqlite.ledger('./harness/lifecycles.sqlite');

const proposed = H.state('proposed', 'pending');
const sampling = H.state('sampling', 'waiting');
const aWins = H.state('a-wins', 'terminal', 'neutral');
const bWins = H.state('b-wins', 'terminal', 'neutral');
const inconclusive = H.state('inconclusive', 'terminal', 'neutral');
const aborted = H.state('aborted', 'terminal', 'failure');

const experiment = H.kind('experiment')
  .data(z.object({ hypothesis: z.string(), durationDays: z.number(), minimumEffect: z.number() }))
  .states(proposed, sampling, aWins, bWins, inconclusive, aborted);

const sampleMetric = H.command('sample-experiment-metric')
  .input(z.object({ experiment: z.string() }))
  .output(z.object({ a: z.number(), b: z.number() }))
  .argv(input => ['./bin/experiment-sample', input.experiment])
  .on(local)
  .recovery('rerun');

const runExperiment = H.flow('run-experiment').for(experiment).does(async ctx => {
  const differences: number[] = [];
  const hours = ctx.unit.data.durationDays * 24;
  for (let hour = 0; hour < hours; hour++) {
    const sample = await ctx.run(sampleMetric, { experiment: ctx.unit.key });
    if (!sample.ok) return ctx.fail(sample.error);
    differences.push(sample.value.a - sample.value.b);
    await ctx.suspend('sampling', { at: new Date(ctx.now().getTime() + 60 * 60 * 1000) });
  }
  const mean = differences.reduce((sum, d) => sum + d, 0) / Math.max(differences.length, 1);
  if (mean > ctx.unit.data.minimumEffect) return 'a-wins';
  if (mean < -ctx.unit.data.minimumEffect) return 'b-wins';
  return 'inconclusive';
});

const experiments = H.lane('experiments', experiment)
  .handler(runExperiment)
  .retry({ times: 3, backoff: { first: { minutes: 5 }, factor: 2 }, exhausted: 'aborted' })
  .suppliers(H.operator)
  .store(sqlite.store(experiment, './harness/experiments.sqlite'));

const reviewDue = H.state('review-due', 'pending');
const betweenReviews = H.state('between-reviews', 'waiting');
const suspendedTenancy = H.state('suspended', 'waiting');
const churned = H.state('churned', 'terminal', 'neutral');

const tenancy = H.kind('tenancy')
  .data(z.object({ name: z.string() }))
  .states(reviewDue, betweenReviews, suspendedTenancy, churned);

const usageReport = H.command('tenancy-usage-report')
  .input(z.object({ tenant: z.string() }))
  .output(z.object({ seats: z.number(), monthlyUsd: z.number() }))
  .argv(input => ['./bin/usage-report', input.tenant])
  .on(local);

const openUpsell = H.command('open-upsell-ticket')
  .input(z.object({ tenant: z.string(), note: z.string() }))
  .argv(input => ['./bin/open-upsell', input.tenant, input.note])
  .on(local)
  .recovery('park');

const accountReview = H.role('account-reviewer')
  .input(z.object({ tenant: z.string(), usage: z.object({ seats: z.number(), monthlyUsd: z.number() }) }))
  .output(z.object({ summary: z.string() }))
  .prompt(input => `Summarise ${input.tenant}: ${input.usage.seats} seats, $${input.usage.monthlyUsd}/month.`);

const accountReviewer = H.seat('account-reviewer', accountReview).model(strong);

const upsell = H.halt('upsell', z.object({ upsell: z.boolean(), note: z.string().optional() }))
  .about(z.object({ tenant: z.string(), summary: z.string() }));

const monthlyReview = H.flow('monthly-review').for(tenancy).does(async ctx => {
  const usage = await ctx.run(usageReport, { tenant: ctx.unit.key });
  if (!usage.ok) return ctx.fail(usage.error);
  const summary = await ctx.run(accountReviewer, { tenant: ctx.unit.data.name, usage: usage.value });
  if (!summary.ok) return ctx.fail(summary.error);
  const decision = await ctx.halt(upsell, `Upsell ${ctx.unit.data.name}?`, { tenant: ctx.unit.key, summary: summary.value.summary });
  if (decision.upsell) {
    const opened = await ctx.run(openUpsell, { tenant: ctx.unit.key, note: decision.note ?? '' });
    if (!opened.ok) return ctx.fail(opened.error);
  }
  return 'between-reviews';
});

const tenancyEvents = http.webhook(tenancy, {
  path: '/hooks/billing',
  secret: H.env('BILLING_WEBHOOK_SECRET'),
  body: z.object({
    event: z.enum(['signed-up', 'suspended', 'reinstated', 'churned']),
    tenant: z.string(),
    name: z.string(),
  }),
  read: body =>
    body.event === 'signed-up' ? { create: { name: body.name }, key: body.tenant }
    : body.event === 'suspended' ? { update: body.tenant, state: 'suspended' }
    : body.event === 'reinstated' ? { update: body.tenant, state: 'between-reviews' }
    : { update: body.tenant, state: 'churned' },
});

const monthlyReviewClock = H.clock('monthly-tenancy-review', tenancy, { every: { days: 30 } }, tick =>
  tick.units
    .filter(unit => unit.state === 'between-reviews')
    .map((unit): SupplyOf<typeof tenancy> => ({ update: unit.key, state: 'review-due' })));

const tenancies = H.lane('tenancies', tenancy)
  .handler(monthlyReview)
  .retry({ times: 1, exhausted: 'between-reviews', reopenAfter: { days: 1 } })
  .suppliers(tenancyEvents, monthlyReviewClock)
  .store(sqlite.store(tenancy, './harness/tenancies.sqlite'));

const ourMove = H.state('our-move', 'pending');
const theirMove = H.state('their-move', 'waiting');
const agreed = H.state('agreed', 'terminal', 'success');
const walkedAwayByUs = H.state('walked-away-by-us', 'terminal', 'neutral');
const walkedAwayByThem = H.state('walked-away-by-them', 'terminal', 'neutral');
const expired = H.state('expired', 'terminal', 'neutral');
const abandoned = H.state('abandoned', 'terminal', 'failure');

const negotiation = H.kind('negotiation')
  .data(z.object({
    item: z.string(),
    ceilingUsd: z.number(),
    expiresAt: z.string(),
    ourLastOffer: z.number().optional(),
    vendorLastOffer: z.number().optional(),
  }))
  .states(ourMove, theirMove, agreed, walkedAwayByUs, walkedAwayByThem, expired, abandoned);

const negotiate = H.role('negotiator')
  .input(z.object({ item: z.string(), ceilingUsd: z.number(), ourLastOffer: z.number().optional(), vendorLastOffer: z.number().optional() }))
  .output(z.object({ action: z.enum(['offer', 'accept', 'walk-away']), amountUsd: z.number(), message: z.string() }))
  .prompt(input => `Next move for ${input.item}. Ceiling $${input.ceilingUsd}. Ours: ${input.ourLastOffer ?? 'none'}. Theirs: ${input.vendorLastOffer ?? 'none'}.`);

const negotiator = H.seat('negotiator', negotiate).model(strong);

const sendToVendor = H.command('send-to-vendor')
  .input(z.object({ negotiation: z.string(), action: z.enum(['offer', 'accept']), amountUsd: z.number(), message: z.string() }))
  .argv(input => ['./bin/vendor-send', input.negotiation, input.action, String(input.amountUsd), input.message])
  .on(local)
  .recovery('park');

const negotiationRound = H.flow('negotiation-round').for(negotiation).does(async ctx => {
  const move = await ctx.run(negotiator, {
    item: ctx.unit.data.item,
    ceilingUsd: ctx.unit.data.ceilingUsd,
    ourLastOffer: ctx.unit.data.ourLastOffer,
    vendorLastOffer: ctx.unit.data.vendorLastOffer,
  });
  if (!move.ok) return ctx.fail(move.error);
  if (move.value.action === 'walk-away') return 'walked-away-by-us';
  const sent = await ctx.run(sendToVendor, {
    negotiation: ctx.unit.key,
    action: move.value.action,
    amountUsd: move.value.amountUsd,
    message: move.value.message,
  });
  if (!sent.ok) return ctx.fail(sent.error);
  if (move.value.action === 'accept') return 'agreed';
  await ctx.update({ ourLastOffer: move.value.amountUsd });
  return 'their-move';
});

const vendorReplies = http.webhook(negotiation, {
  path: '/hooks/vendor',
  secret: H.env('VENDOR_WEBHOOK_SECRET'),
  body: z.object({ negotiation: z.string(), reply: z.enum(['counter', 'accept', 'walk-away']), amountUsd: z.number().optional() }),
  read: body =>
    body.reply === 'counter' ? { update: body.negotiation, patch: { vendorLastOffer: body.amountUsd }, state: 'our-move' }
    : body.reply === 'accept' ? { update: body.negotiation, state: 'agreed' }
    : { update: body.negotiation, state: 'walked-away-by-them' },
});

const negotiations = H.lane('negotiations', negotiation)
  .handler(negotiationRound)
  .retry({ times: 2, backoff: { first: { minutes: 10 } }, exhausted: 'abandoned' })
  .suppliers(H.operator, vendorReplies)
  .store(sqlite.store(negotiation, './harness/negotiations.sqlite'));

const negotiationExpiry = H.trigger(
  'negotiation-expiry',
  H.on.deadline(negotiation, data => new Date(data.expiresAt), ['our-move', 'their-move']),
  (_event, act) => act.move('expired'),
);

const scheduler = H.policy.scheduler('hold-experiments-when-mostly-inconclusive', view => {
  const share = view.metrics.rate({
    days: 180,
    among: { entry: 'transition', kind: experiment, position: 'terminal' },
    count: { entry: 'transition', kind: experiment, state: 'inconclusive' },
  });
  const holdExperiments = share.samples >= 10 && share.value !== null && share.value > 0.5;
  return { start: view.pending.filter(unit => !(holdExperiments && unit.is(experiment))) };
});

export const lifecycles = H.harness('lifecycles')
  .ledger(ledger)
  .lanes(experiments, tenancies, negotiations)
  .pools(pool)
  .triggers(negotiationExpiry)
  .scheduler(scheduler)
  .clients(claude.supervisor({
    grants: [
      H.ops.readWork, H.ops.writeWork, H.ops.readTelemetry,
      H.ops.resolve(upsell, H.halts.interrupted, H.halts.definitionChanged),
    ],
  }))
  .observers(markdown.board('./harness/BOARD.md'));
