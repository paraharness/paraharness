import { z } from 'zod';
import { H } from 'harness-dsl';
import * as anthropic from 'harness-dsl/anthropic';
import * as claude from 'harness-dsl/claude-code';
import * as sqlite from 'harness-dsl/sqlite';
import * as shell from 'harness-dsl/shell';
import * as http from 'harness-dsl/http';
import * as markdown from 'harness-dsl/markdown';

const local = shell.local('local', { slots: 4 });
const sonnet = anthropic.model('claude-sonnet-4-5');
const ledgerPath = '/srv/lifecycles/ledger.sqlite';

const scheduled = H.state('scheduled', 'pending');
const collecting = H.state('collecting', 'waiting');
const aWins = H.state('a-wins', 'terminal', 'success');
const bWins = H.state('b-wins', 'terminal', 'success');
const inconclusive = H.state('inconclusive', 'terminal', 'neutral');
const experiment = H.kind('Experiment')
  .data(z.object({ name: z.string(), metric: z.string(), minLift: z.number() }))
  .states(scheduled, collecting, aWins, bWins, inconclusive);

const sampleExperiment = H.command('sample-experiment')
  .input(z.object({ name: z.string(), metric: z.string() }))
  .output(z.object({ a: z.number(), b: z.number() }))
  .argv(input => ['experiment-sample', input.name, '--metric', input.metric])
  .on(local)
  .recovery('rerun');

const collectAndDecide = H.flow('collect-and-decide').for(experiment).does(async ctx => {
  let totalA = 0;
  let totalB = 0;
  for (let hour = 0; hour < 14 * 24; hour += 1) {
    const reading = await ctx.run(sampleExperiment, { name: ctx.unit.data.name, metric: ctx.unit.data.metric });
    if (reading.ok) {
      totalA += reading.value.a;
      totalB += reading.value.b;
    }
    await ctx.suspend('collecting', { at: new Date(ctx.now().getTime() + 3_600_000) });
  }
  const lift = (totalA - totalB) / Math.max(Math.abs(totalB), 1);
  if (lift >= ctx.unit.data.minLift) return 'a-wins';
  if (-lift >= ctx.unit.data.minLift) return 'b-wins';
  return 'inconclusive';
});

const experiments = H.lane('experiments', experiment)
  .handler(collectAndDecide)
  .retries(1, 'inconclusive')
  .suppliers(H.operator)
  .store(sqlite.store(experiment, ledgerPath));

export const inconclusiveShare = H.policy.rule('inconclusive-share', z.object({ days: z.number() }), (input, metrics) =>
  metrics.rate({
    days: input.days,
    among: { entry: 'transition', kind: experiment, position: 'terminal' },
    count: { entry: 'transition', kind: experiment, state: 'inconclusive' },
  })
);

const reviewDue = H.state('review-due', 'pending');
const current = H.state('current', 'waiting');
const suspended = H.state('suspended', 'waiting');
const churned = H.state('churned', 'terminal', 'neutral');
const tenancy = H.kind('Tenancy')
  .data(z.object({ customer: z.string(), plan: z.string(), nextReviewAt: z.string() }))
  .states(reviewDue, current, suspended, churned);

const usageReport = H.command('usage-report')
  .input(z.object({ customer: z.string() }))
  .argv(input => ['billing-usage', '--customer', input.customer, '--last', '30d'])
  .on(local);

const accountSummarizer = H.seat(
  'account-summarizer',
  H.role('account-summarizer')
    .input(z.object({ customer: z.string(), plan: z.string(), usage: z.string() }))
    .output(z.object({ summary: z.string() }))
    .prompt(input => `Summarise ${input.customer} on ${input.plan} for an upsell decision:\n${input.usage}`)
).model(sonnet);

const upsell = H.halt('upsell', z.object({ upsell: z.boolean(), note: z.string().optional() })).about(z.object({ summary: z.string() }));

const monthlyReview = H.flow('monthly-review').for(tenancy).does(async ctx => {
  const usage = await ctx.run(usageReport, { customer: ctx.unit.data.customer });
  if (!usage.ok) return ctx.fail(usage);
  const summary = await ctx.run(accountSummarizer, { customer: ctx.unit.data.customer, plan: ctx.unit.data.plan, usage: usage.value });
  if (!summary.ok) return ctx.fail(summary);
  await ctx.halt(upsell, `Upsell ${ctx.unit.data.customer}?`, { summary: summary.value.summary });
  await ctx.update({ nextReviewAt: new Date(ctx.now().getTime() + 30 * 86_400_000).toISOString() });
  return 'current';
});

const billingEvent = z.object({
  customer: z.string(),
  plan: z.string(),
  event: z.enum(['signed-up', 'suspended', 'reinstated', 'churned']),
  at: z.string(),
});

const tenancies = H.lane('tenancies', tenancy)
  .handler(monthlyReview)
  .retries(2, 'current', { first: { hours: 1 }, factor: 4 })
  .suppliers(
    http.webhook(tenancy, {
      path: '/billing',
      secret: H.env('BILLING_WEBHOOK_SECRET'),
      body: billingEvent,
      read: body =>
        body.event === 'signed-up'
          ? { create: { customer: body.customer, plan: body.plan, nextReviewAt: body.at }, key: body.customer }
          : {
              update: body.customer,
              state: body.event === 'suspended' ? 'suspended' : body.event === 'churned' ? 'churned' : 'current',
            },
    }),
    H.clock('monthly-review-due', tenancy, { daily: '06:00' }, tick =>
      tick.units
        .filter(unit => unit.state === 'current' && new Date(unit.data.nextReviewAt) <= tick.now)
        .map(unit => tick.update(unit.key, { state: 'review-due' }))
    )
  )
  .store(sqlite.store(tenancy, ledgerPath));

const ourTurn = H.state('our-turn', 'pending');
const theirTurn = H.state('their-turn', 'waiting');
const onHold = H.state('on-hold', 'waiting');
const agreed = H.state('agreed', 'terminal', 'success');
const weWalked = H.state('walked-away-by-us', 'terminal', 'neutral');
const theyWalked = H.state('walked-away-by-them', 'terminal', 'neutral');
const expired = H.state('expired', 'terminal', 'neutral');
const negotiation = H.kind('Negotiation')
  .data(
    z.object({
      vendor: z.string(),
      item: z.string(),
      targetUsd: z.number(),
      expiresAt: z.string(),
      vendorMessage: z.string(),
    })
  )
  .states(ourTurn, theirTurn, onHold, agreed, weWalked, theyWalked, expired);

const negotiator = H.seat(
  'negotiator',
  H.role('negotiator')
    .input(z.object({ vendor: z.string(), item: z.string(), targetUsd: z.number(), vendorMessage: z.string() }))
    .output(z.object({ action: z.enum(['offer', 'accept', 'walk-away']), message: z.string() }))
    .prompt(input => `Negotiate ${input.item} with ${input.vendor}, target $${input.targetUsd}. They wrote:\n${input.vendorMessage}`)
).model(sonnet);

const sendToVendor = H.command('send-to-vendor')
  .input(z.object({ vendor: z.string(), message: z.string() }))
  .argv(input => ['procurement-mail', 'send', input.vendor, input.message])
  .on(local)
  .recovery('park');

const walkAway = H.halt('walk-away', z.object({ confirm: z.boolean() })).about(z.object({ reasoning: z.string() }));

const negotiationRound = H.flow('negotiation-round').for(negotiation).does(async ctx => {
  const data = ctx.unit.data;
  const drafted = await ctx.run(negotiator, {
    vendor: data.vendor,
    item: data.item,
    targetUsd: data.targetUsd,
    vendorMessage: data.vendorMessage,
  });
  if (!drafted.ok) return ctx.fail(drafted);
  if (drafted.value.action === 'walk-away') {
    const decision = await ctx.halt(walkAway, `Walk away from ${data.vendor}?`, { reasoning: drafted.value.message });
    if (!decision.confirm) return 'on-hold';
  }
  const sent = await ctx.run(sendToVendor, { vendor: data.vendor, message: drafted.value.message });
  if (!sent.ok) return ctx.fail(sent);
  if (drafted.value.action === 'walk-away') return 'walked-away-by-us';
  if (drafted.value.action === 'accept') return 'agreed';
  return 'their-turn';
});

const negotiations = H.lane('negotiations', negotiation)
  .handler(negotiationRound)
  .retries(2, 'on-hold', { first: { minutes: 30 } })
  .suppliers(
    H.operator,
    http.webhook(negotiation, {
      path: '/vendor-replies',
      secret: H.env('VENDOR_WEBHOOK_SECRET'),
      body: z.object({ negotiation: z.string(), message: z.string(), status: z.enum(['countered', 'accepted', 'withdrawn']) }),
      read: body => ({
        update: body.negotiation,
        patch: { vendorMessage: body.message },
        state: body.status === 'accepted' ? 'agreed' : body.status === 'withdrawn' ? 'walked-away-by-them' : 'our-turn',
      }),
    })
  )
  .store(sqlite.store(negotiation, ledgerPath));

const negotiationExpiry = H.trigger(
  'negotiation-expiry',
  H.on.deadline(negotiation, data => new Date(data.expiresAt), ['our-turn', 'their-turn', 'on-hold']),
  (_event, act) => act.move('expired')
);

export const harness = H.harness('lifecycles')
  .ledger(sqlite.ledger(ledgerPath))
  .lanes(experiments, tenancies, negotiations)
  .pools(H.pool('api', [{ account: anthropic.account('api', { apiKey: H.env('ANTHROPIC_API_KEY') }), share: 1 }]))
  .triggers(negotiationExpiry)
  .scheduler(H.policy.scheduler('oldest-first', view => ({ start: [...view.pending].sort((a, b) => b.waitedMs - a.waitedMs) })))
  .clients(
    claude.supervisor({
      grants: [H.ops.readWork, H.ops.writeWork, H.ops.resolve(upsell, walkAway), H.ops.readTelemetry],
    })
  )
  .observers(markdown.board('/srv/lifecycles/BOARD.md'));
