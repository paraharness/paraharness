import { z } from 'zod';
import { H } from 'harness-dsl';
import type { SupplyOf, PendingView } from 'harness-dsl';
import * as anthropic from 'harness-dsl/anthropic';
import * as sqlite from 'harness-dsl/sqlite';
import * as shell from 'harness-dsl/shell';
import * as http from 'harness-dsl/http';
import * as markdown from 'harness-dsl/markdown';
import * as claude from 'harness-dsl/claude-code';

const apiAccount = anthropic.account('anthropic-api', { apiKey: H.env('ANTHROPIC_API_KEY') });
const haiku = anthropic.model('claude-haiku-4');
const sonnet = anthropic.model('claude-sonnet-4');
const pool = H.pool('accounts', [{ account: apiAccount, share: 1 }]);
const localRunner = shell.local('local', { slots: 4 });

const experiment = H.kind('experiment')
  .data(z.object({ name: z.string(), metric: z.string() }))
  .states(
    H.state('scheduled', 'pending'),
    H.state('a-wins', 'terminal', 'neutral'),
    H.state('b-wins', 'terminal', 'neutral'),
    H.state('inconclusive', 'terminal', 'neutral'),
    H.state('experiment-broken', 'terminal', 'failure')
  );

const collectSample = H.command('collect-experiment-sample')
  .input(z.object({ name: z.string(), metric: z.string() }))
  .output(z.object({ a: z.number(), b: z.number() }))
  .argv(input => ['./experiments/sample.sh', input.name, input.metric])
  .on(localRunner)
  .recovery('rerun');
const analyzeExperiment = H.command('analyze-experiment')
  .input(z.object({ name: z.string() }))
  .output(z.object({ winner: z.enum(['a', 'b', 'none']) }))
  .argv(input => ['./experiments/analyze.sh', input.name])
  .on(localRunner)
  .recovery('rerun');

const hourMs = 3600000;
const runExperiment = H.flow('run-experiment')
  .for(experiment)
  .does(async ctx => {
    for (let hour = 0; hour < 14 * 24; hour++) {
      await ctx.run(collectSample, { name: ctx.unit.data.name, metric: ctx.unit.data.metric });
      await ctx.sleep({ at: new Date(ctx.now().getTime() + hourMs) });
    }
    const verdict = await ctx.run(analyzeExperiment, { name: ctx.unit.data.name });
    if (!verdict.ok) return ctx.fail(verdict.error);
    if (verdict.value.winner === 'a') return 'a-wins';
    if (verdict.value.winner === 'b') return 'b-wins';
    return 'inconclusive';
  });

const experiments = H.lane('experiments', experiment)
  .handler(runExperiment)
  .retries(1, { exhausted: 'experiment-broken' })
  .suppliers(H.operator)
  .store(sqlite.store(experiment, '.harness/experiments.sqlite'))
  .wip(10);

const tenancy = H.kind('tenancy')
  .data(z.object({ customer: z.string(), plan: z.string(), reviewDay: z.number().int(), lastDecision: z.string().optional() }))
  .states(
    H.state('customer', 'waiting'),
    H.state('review-due', 'pending'),
    H.state('suspended', 'waiting'),
    H.state('review-stuck', 'waiting'),
    H.state('churned', 'terminal', 'neutral')
  );

const usageReview = H.command('usage-review')
  .input(z.object({ customer: z.string() }))
  .argv(input => ['./tenancy/usage.sh', input.customer])
  .on(localRunner)
  .recovery('rerun');

const accountSummaryRole = H.role('account-summary')
  .input(z.object({ customer: z.string(), plan: z.string(), usage: z.string() }))
  .output(z.object({ summary: z.string() }))
  .prompt(input => `Summarise last month for ${input.customer} on plan ${input.plan}:\n${input.usage}`);
const accountSummarizer = H.seat('account-summarizer', accountSummaryRole).model(haiku);

const upsell = H.halt('upsell', z.object({ upsell: z.boolean(), note: z.string().optional() }));

const reviewTenancy = H.flow('review-tenancy')
  .for(tenancy)
  .does(async ctx => {
    const usage = await ctx.run(usageReview, { customer: ctx.unit.data.customer });
    if (!usage.ok) return ctx.fail(usage.error);
    const summary = await ctx.run(accountSummarizer, {
      customer: ctx.unit.data.customer,
      plan: ctx.unit.data.plan,
      usage: usage.value,
    });
    if (!summary.ok) return ctx.fail(summary.error);
    const decision = await ctx.halt(upsell, summary.value.summary);
    await ctx.update({ lastDecision: decision.upsell ? 'upsell' : 'hold' });
    return 'customer';
  });

const tenancyReviews = H.clock('tenancy-review-day', tenancy, { daily: '06:00' }, tick =>
  tick.units
    .filter(unit => unit.state === 'customer' && unit.data.reviewDay === tick.now.getUTCDate())
    .map((unit): SupplyOf<typeof tenancy> => ({ update: unit.key, state: 'review-due' }))
);

const billingEvents = http.webhook(tenancy, {
  path: '/billing/events',
  secret: H.env('BILLING_WEBHOOK_SECRET'),
  body: z.object({
    event: z.enum(['signed', 'suspended', 'reinstated', 'churned']),
    customer: z.string(),
    plan: z.string(),
    reviewDay: z.number().int(),
  }),
  read: body => {
    if (body.event === 'signed') {
      return { create: { customer: body.customer, plan: body.plan, reviewDay: body.reviewDay }, key: body.customer };
    }
    if (body.event === 'suspended') return { update: body.customer, state: 'suspended' };
    if (body.event === 'reinstated') return { update: body.customer, state: 'customer' };
    return { update: body.customer, state: 'churned' };
  },
});

const tenancies = H.lane('tenancies', tenancy)
  .handler(reviewTenancy)
  .retries(2, { backoff: { first: { hours: 1 }, factor: 2 }, exhausted: 'review-stuck' })
  .suppliers(billingEvents, tenancyReviews)
  .store(sqlite.store(tenancy, '.harness/tenancies.sqlite'))
  .wip(3);

const negotiation = H.kind('negotiation')
  .data(
    z.object({
      vendor: z.string(),
      item: z.string(),
      expiresAt: z.string(),
      lastVendorMessage: z.string(),
      ourLastOffer: z.string().optional(),
    })
  )
  .states(
    H.state('our-turn', 'pending'),
    H.state('their-turn', 'waiting'),
    H.state('negotiation-stalled', 'waiting'),
    H.state('agreed', 'terminal', 'success'),
    H.state('we-walked', 'terminal', 'neutral'),
    H.state('they-walked', 'terminal', 'failure'),
    H.state('expired', 'terminal', 'failure')
  );

const offerRole = H.role('offer-drafter')
  .input(z.object({ vendor: z.string(), item: z.string(), theirMessage: z.string(), ourLastOffer: z.string() }))
  .output(z.object({ recommend: z.enum(['offer', 'accept', 'walk-away']), message: z.string() }))
  .prompt(
    input =>
      `Negotiating ${input.item} with ${input.vendor}. Our last offer: ${input.ourLastOffer}. Their reply: ${input.theirMessage}. Draft our next message.`
  );
const offerDrafter = H.seat('offer-drafter', offerRole).model(sonnet);

const walkAway = H.halt('walk-away', z.object({ confirm: z.boolean() }));

const sendToVendor = H.command('send-to-vendor')
  .input(z.object({ vendor: z.string(), message: z.string() }))
  .argv(input => ['./procurement/send.sh', input.vendor, input.message])
  .on(localRunner)
  .recovery('park');

const negotiationRound = H.flow('negotiation-round')
  .for(negotiation)
  .does(async ctx => {
    const draft = await ctx.run(offerDrafter, {
      vendor: ctx.unit.data.vendor,
      item: ctx.unit.data.item,
      theirMessage: ctx.unit.data.lastVendorMessage,
      ourLastOffer: ctx.unit.data.ourLastOffer ?? 'none yet',
    });
    if (!draft.ok) return ctx.fail(draft.error);
    if (draft.value.recommend === 'walk-away') {
      const decision = await ctx.halt(walkAway, draft.value.message);
      if (decision.confirm) {
        const sent = await ctx.run(sendToVendor, { vendor: ctx.unit.data.vendor, message: draft.value.message });
        return sent.ok ? 'we-walked' : ctx.fail(sent.error);
      }
    }
    const sent = await ctx.run(sendToVendor, { vendor: ctx.unit.data.vendor, message: draft.value.message });
    if (!sent.ok) return ctx.fail(sent.error);
    if (draft.value.recommend === 'accept') return 'agreed';
    await ctx.update({ ourLastOffer: draft.value.message });
    return 'their-turn';
  });

const vendorReplies = http.webhook(negotiation, {
  path: '/procurement/replies',
  secret: H.env('PROCUREMENT_WEBHOOK_SECRET'),
  body: z.object({ negotiation: z.string(), reply: z.enum(['counter', 'accept', 'walk-away']), message: z.string() }),
  read: body => {
    if (body.reply === 'accept') return { update: body.negotiation, patch: { lastVendorMessage: body.message }, state: 'agreed' };
    if (body.reply === 'walk-away') return { update: body.negotiation, patch: { lastVendorMessage: body.message }, state: 'they-walked' };
    return { update: body.negotiation, patch: { lastVendorMessage: body.message }, state: 'our-turn' };
  },
});

const negotiations = H.lane('negotiations', negotiation)
  .handler(negotiationRound)
  .retries(2, { backoff: { first: { minutes: 30 } }, exhausted: 'negotiation-stalled' })
  .suppliers(vendorReplies, H.operator)
  .store(sqlite.store(negotiation, '.harness/negotiations.sqlite'))
  .wip(4);

const negotiationExpiry = H.trigger(
  'negotiation-expiry',
  H.on.deadline(negotiation, data => new Date(data.expiresAt), ['our-turn', 'their-turn', 'negotiation-stalled']),
  (_event, act) => act.move('expired')
);

const experimentsYieldWhenInconclusive = H.policy.scheduler('experiments-yield-when-inconclusive', view => {
  const inconclusive = view.metrics.rate({
    among: { entry: 'transition', kind: experiment, position: 'terminal' },
    count: { entry: 'transition', kind: experiment, state: 'inconclusive' },
    days: 90,
  });
  const experimentsLast = inconclusive.value !== null && inconclusive.samples >= 10 && inconclusive.value > 0.5;
  const rank = (unit: PendingView): number => (experimentsLast && unit.is(experiment) ? 1 : 0);
  return { start: [...view.pending].sort((a, b) => rank(a) - rank(b) || b.waitedMs - a.waitedMs) };
});

export const lifecycles = H.harness('lifecycles')
  .ledger(sqlite.ledger('.harness/ledger.sqlite'))
  .lanes(experiments, tenancies, negotiations)
  .pools(pool)
  .triggers(negotiationExpiry)
  .scheduler(experimentsYieldWhenInconclusive)
  .clients(
    claude.supervisor('owner', {
      grants: [H.ops.readWork, H.ops.writeWork, H.ops.resolveHalts, H.ops.readTelemetry],
    })
  )
  .observers(markdown.board('.harness/board.md'), markdown.telemetry('.harness/telemetry.md'));
