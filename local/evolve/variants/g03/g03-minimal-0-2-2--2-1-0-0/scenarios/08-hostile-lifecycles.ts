import { H } from 'harness-dsl';
import { z } from 'zod';
import * as claudeCode from 'harness-dsl/claude-code';
import * as anthropic from 'harness-dsl/anthropic';
import * as sqlite from 'harness-dsl/sqlite';
import * as shell from 'harness-dsl/shell';
import * as http from 'harness-dsl/http';
import * as markdown from 'harness-dsl/markdown';

const local = shell.local('lifecycles-local', { slots: 4 });
const sonnet = anthropic.model('claude-sonnet-4-5');
const unitsDb = 'lifecycles/.harness/units.sqlite';

const proposed = H.state('proposed', 'pending');
const observing = H.state('observing', 'waiting');
const aWins = H.state('a-wins', 'terminal', 'neutral');
const bWins = H.state('b-wins', 'terminal', 'neutral');
const inconclusive = H.state('inconclusive', 'terminal', 'neutral');
const abandoned = H.state('abandoned', 'terminal', 'failure');

const experiment = H.kind('Experiment')
  .data(z.object({ name: z.string(), variantA: z.string(), variantB: z.string() }))
  .states(proposed, observing, aWins, bWins, inconclusive, abandoned);

const measure = H.command('measure-experiment')
  .input(z.object({ experiment: z.string() }))
  .output(z.object({ a: z.number(), b: z.number() }))
  .argv((input) => ['experiments', 'measure', input.experiment])
  .on(local)
  .recovery('rerun');

const experimentVerdict = H.policy.rule(
  'experiment-verdict',
  z.object({ aTotal: z.number(), bTotal: z.number(), hours: z.number() }),
  (input) => {
    if (input.hours < 24) return 'inconclusive';
    const lift = (input.aTotal - input.bTotal) / Math.max(Math.abs(input.bTotal), 1);
    if (lift > 0.05) return 'a-wins';
    if (lift < -0.05) return 'b-wins';
    return 'inconclusive';
  }
);

const hourMs = 60 * 60 * 1000;

const observeExperiment = H.flow('observe-experiment')
  .for(experiment)
  .does(async (ctx) => {
    const endsAt = ctx.now().getTime() + 14 * 24 * hourMs;
    let aTotal = 0;
    let bTotal = 0;
    let hours = 0;
    while (ctx.now().getTime() < endsAt) {
      const sample = await ctx.run(measure, { experiment: ctx.unit.data.name });
      if (sample.ok) {
        aTotal += sample.value.a;
        bTotal += sample.value.b;
        hours += 1;
      }
      await ctx.suspend('observing', { at: new Date(ctx.now().getTime() + hourMs) });
    }
    return ctx.decide(experimentVerdict, { aTotal, bTotal, hours });
  });

const experiments = H.lane('experiments', experiment)
  .handler(observeExperiment)
  .retries(1, { exhausted: 'abandoned' })
  .suppliers(H.operator)
  .store(sqlite.store(experiment, unitsDb));

export const inconclusiveShare = H.policy.rule('experiments-inconclusive-share', z.object({ days: z.number() }), (input, metrics) =>
  metrics.rate({
    days: input.days,
    among: { entry: 'transition', kind: experiment, position: 'terminal' },
    count: { entry: 'transition', kind: experiment, state: 'inconclusive' },
  })
);

const customer = H.state('customer', 'waiting');
const reviewDue = H.state('review-due', 'pending');
const suspended = H.state('suspended', 'waiting');
const churned = H.state('churned', 'terminal', 'neutral');

const tenancy = H.kind('Tenancy')
  .data(z.object({ customer: z.string(), plan: z.string(), reviewedMonth: z.string().optional() }))
  .states(customer, reviewDue, suspended, churned);

const monthOf = (date: Date) => date.toISOString().slice(0, 7);

const monthlyReview = H.schedule('monthly-tenancy-review', tenancy, { daily: '06:00' }, (tick, supply) =>
  tick.units
    .filter((unit) => unit.state === 'customer' && unit.data.reviewedMonth !== monthOf(tick.now))
    .map((unit) => supply.update(unit.key, { state: 'review-due' }))
);

const usageReview = H.command('usage-review')
  .input(z.object({ customer: z.string() }))
  .output(z.object({ seats: z.number(), activeUsers: z.number(), spendUsd: z.number() }))
  .argv((input) => ['billing', 'usage', input.customer, '--last-month'])
  .on(local)
  .recovery('rerun');

const accountSummaryRole = H.role('account-summarizer')
  .input(z.object({ customer: z.string(), plan: z.string(), seats: z.number(), activeUsers: z.number(), spendUsd: z.number() }))
  .output(z.object({ summary: z.string() }))
  .prompt((input) => `Summarise last month for ${input.customer} on ${input.plan}: ${input.activeUsers}/${input.seats} active, $${input.spendUsd}.`);

const accountSummarizer = H.seat('account-summarizer', accountSummaryRole).model(sonnet);

const upsellDecision = H.halt('upsell-decision', z.object({ upsell: z.boolean(), note: z.string().optional() })).about(
  z.object({ customer: z.string(), summary: z.string() })
);

const openUpsell = H.command('open-upsell-opportunity')
  .input(z.object({ customer: z.string(), note: z.string() }))
  .argv((input) => ['crm', 'opportunity', 'create', input.customer, input.note])
  .on(local)
  .recovery('park');

const reviewTenancy = H.flow('review-tenancy')
  .for(tenancy)
  .does(async (ctx) => {
    await ctx.update({ reviewedMonth: monthOf(ctx.now()) });
    const usage = await ctx.run(usageReview, { customer: ctx.unit.data.customer });
    if (!usage.ok) return ctx.fail(usage.error);
    const summary = await ctx.run(accountSummarizer, { customer: ctx.unit.data.customer, plan: ctx.unit.data.plan, ...usage.value });
    if (!summary.ok) return ctx.fail(summary.error);
    const decision = await ctx.halt(upsellDecision, summary.value.summary, { customer: ctx.unit.data.customer, summary: summary.value.summary });
    if (decision.upsell) {
      const opened = await ctx.run(openUpsell, { customer: ctx.unit.data.customer, note: decision.note ?? summary.value.summary });
      if (!opened.ok) return ctx.fail(opened.error);
    }
    return 'customer';
  });

const tenancies = H.lane('tenancies', tenancy)
  .handler(reviewTenancy)
  .retries(1, { exhausted: 'customer' })
  .suppliers(H.operator, monthlyReview)
  .store(sqlite.store(tenancy, unitsDb));

const ourTurn = H.state('our-turn', 'pending');
const theirTurn = H.state('their-turn', 'waiting');
const stalled = H.state('stalled', 'waiting');
const agreed = H.state('agreed', 'terminal', 'success');
const weWalked = H.state('we-walked', 'terminal', 'neutral');
const theyWalked = H.state('they-walked', 'terminal', 'failure');
const expired = H.state('expired', 'terminal', 'failure');

const negotiation = H.kind('Negotiation')
  .data(
    z.object({
      vendor: z.string(),
      item: z.string(),
      ceilingUsd: z.number(),
      expiresAt: z.string(),
      ourLastOfferUsd: z.number().optional(),
      theirLastOfferUsd: z.number().optional(),
    })
  )
  .states(ourTurn, theirTurn, stalled, agreed, weWalked, theyWalked, expired);

const vendorReplies = http.webhook(negotiation, {
  path: '/vendors/replies',
  secret: H.env('VENDOR_WEBHOOK_SECRET'),
  body: z.object({ negotiation: z.string(), event: z.enum(['offer', 'accept', 'walk-away']), offerUsd: z.number().optional() }),
  read: (body, supply) =>
    body.event === 'offer'
      ? supply.update(body.negotiation, { patch: { theirLastOfferUsd: body.offerUsd }, state: 'our-turn' })
      : body.event === 'accept'
        ? supply.update(body.negotiation, { state: 'agreed' })
        : supply.update(body.negotiation, { state: 'they-walked' }),
});

const negotiatorRole = H.role('negotiator')
  .input(
    z.object({
      vendor: z.string(),
      item: z.string(),
      ceilingUsd: z.number(),
      ourLastOfferUsd: z.number().nullable(),
      theirLastOfferUsd: z.number().nullable(),
    })
  )
  .output(z.object({ move: z.enum(['offer', 'accept', 'walk-away']), offerUsd: z.number(), message: z.string() }))
  .prompt(
    (input) =>
      `Negotiate ${input.item} with ${input.vendor}. Ceiling $${input.ceilingUsd}. Our last: ${input.ourLastOfferUsd ?? 'none'}. Theirs: ${input.theirLastOfferUsd ?? 'none'}.`
  );

const negotiator = H.seat('negotiator', negotiatorRole).model(sonnet);

const sendToVendor = H.command('send-to-vendor')
  .input(z.object({ vendor: z.string(), message: z.string() }))
  .argv((input) => ['procurement', 'send', input.vendor, input.message])
  .on(local)
  .recovery('park');

const negotiationRound = H.flow('negotiation-round')
  .for(negotiation)
  .does(async (ctx) => {
    const data = ctx.unit.data;
    const round = await ctx.run(negotiator, {
      vendor: data.vendor,
      item: data.item,
      ceilingUsd: data.ceilingUsd,
      ourLastOfferUsd: data.ourLastOfferUsd ?? null,
      theirLastOfferUsd: data.theirLastOfferUsd ?? null,
    });
    if (!round.ok) return ctx.fail(round.error);
    const sent = await ctx.run(sendToVendor, { vendor: data.vendor, message: round.value.message });
    if (!sent.ok) return ctx.fail(sent.error);
    if (round.value.move === 'walk-away') return 'we-walked';
    if (round.value.move === 'accept') return 'agreed';
    await ctx.update({ ourLastOfferUsd: round.value.offerUsd });
    return 'their-turn';
  });

const negotiations = H.lane('negotiations', negotiation)
  .handler(negotiationRound)
  .retries(2, { exhausted: 'stalled' })
  .suppliers(H.operator, vendorReplies)
  .store(sqlite.store(negotiation, unitsDb));

const negotiationExpiry = H.trigger(
  'negotiation-expiry',
  H.on.deadline(negotiation, (data) => new Date(data.expiresAt), ['our-turn', 'their-turn', 'stalled']),
  (_event, act) => act.move('expired')
);

export const harness = H.harness('lifecycles')
  .ledger(sqlite.ledger('lifecycles/.harness/ledger.sqlite'))
  .pools(H.pool('lifecycles-accounts', [{ account: anthropic.account('lifecycles-api', { apiKey: H.env('ANTHROPIC_API_KEY') }), share: 1 }]).serves(sonnet))
  .lanes(experiments, tenancies, negotiations)
  .triggers(negotiationExpiry)
  .scheduler(H.policy.scheduler('oldest-first', (view) => ({ start: view.sorted(() => 0) })))
  .clients(
    claudeCode.supervisor({
      grants: [
        H.ops.readWork,
        H.ops.writeWork,
        H.ops.readTelemetry,
        H.ops.resolve(upsellDecision, H.halts.interrupted, H.halts.definitionChanged),
      ],
    })
  )
  .observers(markdown.board('lifecycles/BOARD.md'), markdown.telemetry('lifecycles/TELEMETRY.md'));
