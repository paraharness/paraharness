import { z } from 'zod';
import { H } from 'harness-dsl';
import type { SupplyOf } from 'harness-dsl';
import * as anthropic from 'harness-dsl/anthropic';
import * as claudeCode from 'harness-dsl/claude-code';
import * as sqlite from 'harness-dsl/sqlite';
import * as shell from 'harness-dsl/shell';
import * as http from 'harness-dsl/http';
import * as markdown from 'harness-dsl/markdown';

const apiAccount = anthropic.account('api', { apiKey: H.env('ANTHROPIC_API_KEY') });
const sonnet = anthropic.model('claude-sonnet-4-5');
const runner = shell.local('local', { slots: 4 });
const hourMs = 60 * 60 * 1000;
const dayMs = 24 * hourMs;

const proposed = H.state('proposed', 'pending');
const collecting = H.state('collecting', 'waiting');
const aWins = H.state('a-wins', 'terminal', 'success');
const bWins = H.state('b-wins', 'terminal', 'success');
const inconclusive = H.state('inconclusive', 'terminal', 'neutral');

const experiment = H.kind('experiment')
  .data(z.object({ name: z.string(), hypothesis: z.string(), startedAt: z.string() }))
  .states(proposed, collecting, aWins, bWins, inconclusive);

const measureArms = H.command('measure-arms')
  .input(z.object({ experiment: z.string() }))
  .output(z.object({ a: z.number(), b: z.number() }))
  .argv(input => ['experiments', 'measure', input.experiment])
  .on(runner)
  .recovery('rerun');

const analyzeArms = H.command('analyze-arms')
  .input(z.object({ samples: z.array(z.object({ a: z.number(), b: z.number() })) }))
  .output(z.object({ winner: z.enum(['a', 'b', 'none']) }))
  .argv(input => ['experiments', 'analyze', JSON.stringify(input.samples)])
  .on(runner)
  .recovery('rerun');

const experimentRun = H.flow('experiment-run')
  .for(experiment)
  .does(async ctx => {
    const start = Date.parse(ctx.unit.data.startedAt);
    const samples: { a: number; b: number }[] = [];
    for (let hour = 1; hour <= 14 * 24; hour += 1) {
      const sample = await ctx.run(measureArms, { experiment: ctx.unit.data.name });
      if (sample.ok) samples.push(sample.value);
      await ctx.wait('collecting', { at: new Date(start + hour * hourMs) });
    }
    const analysis = await ctx.run(analyzeArms, { samples });
    if (!analysis.ok) return ctx.fail(analysis.error);
    return analysis.value.winner === 'a' ? 'a-wins' : analysis.value.winner === 'b' ? 'b-wins' : 'inconclusive';
  });

const experiments = H.lane('experiments', experiment)
  .handler(experimentRun)
  .suppliers(H.operator)
  .store(sqlite.store(experiment, '/srv/harness/experiments.sqlite'));

const reviewDue = H.state('review-due', 'pending');
const customer = H.state('customer', 'waiting');
const suspended = H.state('suspended', 'waiting');
const churned = H.state('churned', 'terminal', 'neutral');

const tenancy = H.kind('tenancy')
  .data(z.object({ customerId: z.string(), plan: z.string(), nextReviewAt: z.string() }))
  .states(reviewDue, customer, suspended, churned);

const monthlyReviews = H.clock('monthly-tenancy-reviews', tenancy, { daily: '06:00' }, tick =>
  tick.units
    .filter(unit => unit.state === 'customer' && Date.parse(unit.data.nextReviewAt) <= tick.now.getTime())
    .map((unit): SupplyOf<typeof tenancy> => ({ update: unit.key, state: 'review-due' }))
);

const usageReport = H.command('usage-report')
  .input(z.object({ customerId: z.string() }))
  .argv(input => ['billing', 'usage', '--customer', input.customerId, '--days', '30'])
  .on(runner)
  .recovery('rerun');

const accountSummaryRole = H.role('account-summary')
  .input(z.object({ customerId: z.string(), plan: z.string(), usage: z.string() }))
  .output(z.object({ summary: z.string() }))
  .prompt(input => `Summarise last month for customer ${input.customerId} on ${input.plan}:\n${input.usage}`);

const accountSummarizer = H.seat('account-summarizer', accountSummaryRole).model(sonnet);

const upsellDecision = H.halt('upsell-decision', z.object({ action: z.enum(['upsell', 'keep', 'suspend', 'churn']) }));

const tenancyReview = H.flow('tenancy-review')
  .for(tenancy)
  .does(async ctx => {
    const usage = await ctx.run(usageReport, { customerId: ctx.unit.data.customerId });
    if (!usage.ok) return ctx.fail(usage.error);
    const summary = await ctx.run(accountSummarizer, {
      customerId: ctx.unit.data.customerId,
      plan: ctx.unit.data.plan,
      usage: usage.value,
    });
    if (!summary.ok) return ctx.fail(summary.error);
    const decision = await ctx.halt(upsellDecision, summary.value.summary);
    await ctx.update({ nextReviewAt: new Date(ctx.now().getTime() + 30 * dayMs).toISOString() });
    if (decision.action === 'churn') return 'churned';
    if (decision.action === 'suspend') return 'suspended';
    return 'customer';
  });

const tenancies = H.lane('tenancies', tenancy)
  .handler(tenancyReview)
  .suppliers(H.operator, monthlyReviews)
  .store(sqlite.store(tenancy, '/srv/harness/tenancies.sqlite'));

const ourTurn = H.state('our-turn', 'pending');
const theirTurn = H.state('their-turn', 'waiting');
const agreed = H.state('agreed', 'terminal', 'success');
const walkedAwayByUs = H.state('walked-away-by-us', 'terminal', 'neutral');
const walkedAwayByThem = H.state('walked-away-by-them', 'terminal', 'neutral');
const expired = H.state('expired', 'terminal', 'neutral');

const negotiation = H.kind('negotiation')
  .data(z.object({
    vendor: z.string(),
    item: z.string(),
    targetUsd: z.number(),
    deadline: z.string(),
    lastVendorOffer: z.string().optional(),
  }))
  .states(ourTurn, theirTurn, agreed, walkedAwayByUs, walkedAwayByThem, expired);

const vendorReplies = http.webhook(negotiation, {
  path: '/vendor-replies',
  secret: H.env('VENDOR_WEBHOOK_SECRET'),
  body: z.discriminatedUnion('type', [
    z.object({ type: z.literal('offer'), negotiationId: z.string(), offer: z.string() }),
    z.object({ type: z.literal('accepted'), negotiationId: z.string() }),
    z.object({ type: z.literal('walked-away'), negotiationId: z.string() }),
  ]),
  read: body =>
    body.type === 'offer'
      ? { update: body.negotiationId, patch: { lastVendorOffer: body.offer }, state: 'our-turn' }
      : body.type === 'accepted'
        ? { update: body.negotiationId, state: 'agreed' }
        : { update: body.negotiationId, state: 'walked-away-by-them' },
});

const negotiatorRole = H.role('negotiator')
  .input(z.object({ vendor: z.string(), item: z.string(), targetUsd: z.number(), lastVendorOffer: z.string() }))
  .output(z.object({ action: z.enum(['offer', 'accept', 'walk-away']), offer: z.string(), reason: z.string() }))
  .prompt(input => `Negotiate ${input.item} with ${input.vendor}, target $${input.targetUsd}. Their last offer: ${input.lastVendorOffer}`);

const negotiator = H.seat('negotiator', negotiatorRole).model(sonnet);

const sendToVendor = H.command('send-to-vendor')
  .input(z.object({ vendor: z.string(), message: z.string() }))
  .argv(input => ['procurement', 'send', '--vendor', input.vendor, '--message', input.message])
  .on(runner)
  .recovery('park');

const walkAwayApproval = H.halt('walk-away-approval', z.object({ confirm: z.boolean() }));

const negotiationRound = H.flow('negotiation-round')
  .for(negotiation)
  .does(async ctx => {
    const next = await ctx.run(negotiator, {
      vendor: ctx.unit.data.vendor,
      item: ctx.unit.data.item,
      targetUsd: ctx.unit.data.targetUsd,
      lastVendorOffer: ctx.unit.data.lastVendorOffer ?? 'none yet',
    });
    if (!next.ok) return ctx.fail(next.error);
    if (next.value.action === 'walk-away') {
      const approval = await ctx.halt(walkAwayApproval, next.value.reason);
      if (approval.confirm) return 'walked-away-by-us';
    }
    const sent = await ctx.run(sendToVendor, { vendor: ctx.unit.data.vendor, message: next.value.offer });
    if (!sent.ok) return ctx.fail(sent.error);
    return next.value.action === 'accept' ? 'agreed' : 'their-turn';
  });

const negotiations = H.lane('negotiations', negotiation)
  .handler(negotiationRound)
  .suppliers(H.operator, vendorReplies)
  .store(sqlite.store(negotiation, '/srv/harness/negotiations.sqlite'));

const negotiationExpiry = H.trigger(
  'negotiation-expiry',
  H.on.deadline(negotiation, data => new Date(data.deadline), ['our-turn', 'their-turn']),
  (event, act) => act.move('expired')
);

const experimentOutcomes = H.report('experiment-outcomes', metrics => ({
  inconclusiveShare: metrics.rate({
    among: { entry: 'transition', kind: experiment, position: 'terminal' },
    count: { entry: 'transition', kind: experiment, state: inconclusive },
    days: 365,
  }),
  aWinsShare: metrics.rate({
    among: { entry: 'transition', kind: experiment, position: 'terminal' },
    count: { entry: 'transition', kind: experiment, state: aWins },
    days: 365,
  }),
  churnedThisYear: metrics.count({ of: { entry: 'transition', kind: tenancy, state: churned }, days: 365 }),
  agreementRate: metrics.rate({
    among: { entry: 'transition', kind: negotiation, position: 'terminal' },
    count: { entry: 'transition', kind: negotiation, state: agreed },
    days: 365,
  }),
}));

export const lifecycles = H.harness('lifecycles-that-do-not-fit')
  .ledger(sqlite.ledger('/srv/harness/ledger.sqlite'))
  .lanes(experiments, tenancies, negotiations)
  .pools(H.pool('api-pool', [{ account: apiAccount, share: 1 }]))
  .triggers(negotiationExpiry)
  .reports(experimentOutcomes)
  .clients(
    claudeCode.supervisor({
      grants: [
        H.ops.readWork,
        H.ops.writeWork,
        H.ops.resolve(upsellDecision, walkAwayApproval, H.halts.changed, H.halts.interrupted),
        H.ops.readTelemetry,
      ],
    })
  )
  .observers(markdown.board('/srv/harness/BOARD.md'), markdown.telemetry('/srv/harness/TELEMETRY.md'));
