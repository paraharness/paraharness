import { z } from 'zod';
import { H } from 'harness-dsl';
import { anthropic } from 'harness-dsl/anthropic';
import { sqlite } from 'harness-dsl/sqlite';
import { local } from 'harness-dsl/local';
import { webhook } from 'harness-dsl/webhook';
import { http } from 'harness-dsl/http';
import { markdown } from 'harness-dsl/markdown';

const quota = sqlite.quota('lifecycles-quota', { path: '/srv/lifecycles/quota.sqlite' });
const apiAccount = anthropic.account('lifecycles-api', { apiKey: H.env('ANTHROPIC_API_KEY'), quota });
const sonnet = anthropic.model('sonnet', { id: 'claude-sonnet-4-5' });
const pool = H.pool('lifecycles').accounts(apiAccount);
const runner = local.runner('lifecycles').slots(4);

const experimentAttrs = z.object({ name: z.string(), variantA: z.string(), variantB: z.string() });

const ExperimentScheduled = H.state('experiment-scheduled', 'pending');
const AWins = H.terminal('a-wins', 'success');
const BWins = H.terminal('b-wins', 'success');
const Inconclusive = H.terminal('inconclusive', 'neutral');
const MeasurementBroken = H.terminal('measurement-broken', 'failure');

const experimentKind = H.kind('experiment')
  .attributes(experimentAttrs)
  .states(ExperimentScheduled, AWins, BWins, Inconclusive, MeasurementBroken)
  .key(a => a.name)
  .initial(ExperimentScheduled);

const measure = H.command('measure-experiment')
  .input(z.object({ experiment: z.string() }))
  .argv(i => ['experiments', 'measure', i.experiment])
  .output(z.object({ a: z.number(), b: z.number() }))
  .runner(runner);

const analyse = H.command('analyse-experiment')
  .input(z.object({ experiment: z.string() }))
  .argv(i => ['experiments', 'analyse', i.experiment])
  .output(z.object({ winner: z.enum(['a', 'b', 'none']) }))
  .runner(runner);

const experimentFlow = H.flow('experiment')
  .input(experimentAttrs)
  .loop(
    'hours',
    f =>
      f
        .step('measure', measure, ctx => ({ experiment: ctx.unit.attributes.name }), { afterCrash: 'rerun' })
        .wait('nextHour', { ms: 3_600_000 }),
    { max: 336 },
  )
  .step('analyse', analyse, ctx => ({ experiment: ctx.unit.attributes.name }), { afterCrash: 'rerun' })
  .exit('aWins', ctx => ctx.steps.analyse.winner === 'a')
  .exit('bWins', ctx => ctx.steps.analyse.winner === 'b')
  .exit('inconclusive');

const experiments = H.lane('experiments', experimentKind)
  .supply(H.operator)
  .handler(experimentFlow, { exits: { aWins: AWins, bWins: BWins, inconclusive: Inconclusive } })
  .store(sqlite.store({ path: '/srv/lifecycles/store.sqlite' }))
  .retry({ maxAttempts: 3, backoff: 'exponential', initialDelayMs: 600_000, exhausted: MeasurementBroken });

const tenancyAttrs = z.object({ customerId: z.string(), plan: z.string() });

const ReviewDue = H.state('review-due', 'pending');
const Customer = H.state('customer', 'waiting');
const Suspended = H.state('suspended', 'waiting');
const Churned = H.terminal('churned', 'neutral');

const tenancyKind = H.kind('tenancy')
  .attributes(tenancyAttrs)
  .states(ReviewDue, Customer, Suspended, Churned)
  .key(a => a.customerId)
  .initial(ReviewDue);

const accountManagerRole = H.role('account-manager').intents('read').instructions('Summarize a month of tenancy usage for an upsell decision.');
const usageSummarizer = H.seat('usage-summarizer').role(accountManagerRole).model(sonnet).pool(pool);

const usageReport = H.command('usage-report')
  .input(z.object({ customerId: z.string() }))
  .argv(i => ['billing', 'usage', i.customerId, '--last-month'])
  .output(z.object({ activeSeats: z.number(), spendUsd: z.number() }))
  .runner(runner);

const upsellHalt = H.halt('upsell').decision(z.object({ upsell: z.boolean(), note: z.string() }));

const monthlyReview = H.flow('monthly-review')
  .input(tenancyAttrs)
  .step('usage', usageReport, ctx => ({ customerId: ctx.unit.attributes.customerId }), { afterCrash: 'rerun' })
  .step('summary', usageSummarizer, ctx => ({
    task: `Customer ${ctx.unit.attributes.customerId} on ${ctx.unit.attributes.plan}: ${ctx.steps.usage.activeSeats} seats, $${ctx.steps.usage.spendUsd}. Summarize.`,
  }))
  .halt('decision', upsellHalt, { ask: ctx => ctx.steps.summary })
  .exit('reviewed');

const reviewDue = H.signal('review-due');
const suspend = H.signal('suspend').payload(z.object({ reason: z.string() }));
const reinstate = H.signal('reinstate');
const churn = H.signal('churn');

const billingEvents = webhook.json('billing-events', {
  port: H.slot.port(1),
  path: '/billing',
  secret: H.env('BILLING_WEBHOOK_SECRET'),
  payload: z.object({
    customerId: z.string(),
    plan: z.string(),
    event: z.enum(['signed', 'suspended', 'reinstated', 'churned']),
    reason: z.string(),
  }),
});

const tenancies = H.lane('tenancies', tenancyKind)
  .supply(billingEvents, (e, to) =>
    e.event === 'signed'
      ? to.create({ customerId: e.customerId, plan: e.plan })
      : e.event === 'suspended'
        ? to.signal(suspend, e.customerId, { reason: e.reason })
        : e.event === 'reinstated'
          ? to.signal(reinstate, e.customerId, {})
          : to.signal(churn, e.customerId, {}),
  )
  .handler(monthlyReview, { exits: { reviewed: Customer } })
  .store(sqlite.store({ path: '/srv/lifecycles/store.sqlite' }))
  .retry({ maxAttempts: 3, backoff: 'exponential', initialDelayMs: 3_600_000, exhausted: Customer })
  .on(reviewDue, { enter: ReviewDue })
  .on(suspend, { enter: Suspended })
  .on(reinstate, { enter: Customer })
  .on(churn, { enter: Churned });

const monthly = H.clock('monthly-review').at('09:00', { on: 1, tz: 'Europe/London' });

const openMonthlyReviews = H.trigger('open-monthly-reviews')
  .on(H.when.sweep(tenancies, { every: monthly, in: Customer }))
  .signal(reviewDue, tenancies, e => ({ key: e.unit.key, payload: {} }));

const negotiationAttrs = z.object({
  reference: z.string(),
  vendor: z.string(),
  item: z.string(),
  targetUsd: z.number(),
  deadline: z.string(),
  lastReply: z.string(),
});

const OurMove = H.state('our-move', 'pending');
const TheirMove = H.state('their-move', 'waiting');
const Agreed = H.terminal('agreed', 'success');
const WalkedAwayByUs = H.terminal('walked-away-by-us', 'neutral');
const WalkedAwayByThem = H.terminal('walked-away-by-them', 'failure');
const Expired = H.terminal('expired', 'failure');
const Stalled = H.terminal('stalled', 'failure');

const negotiationKind = H.kind('negotiation')
  .attributes(negotiationAttrs)
  .states(OurMove, TheirMove, Agreed, WalkedAwayByUs, WalkedAwayByThem, Expired, Stalled)
  .key(a => a.reference)
  .initial(OurMove);

const negotiatorRole = H.role('negotiator').intents('read').instructions('Draft the next offer, or walk away when the deal is worse than the target.');
const negotiator = H.seat('negotiator')
  .role(negotiatorRole)
  .model(sonnet)
  .pool(pool)
  .output(z.object({ walkAway: z.boolean(), offerUsd: z.number(), message: z.string() }));

const sendOffer = H.command('send-offer')
  .input(z.object({ reference: z.string(), message: z.string() }))
  .argv(i => ['procurement', 'send', i.reference, i.message])
  .runner(runner);

const negotiationRound = H.flow('negotiation-round')
  .input(negotiationAttrs)
  .step('offer', negotiator, ctx => ({
    task: `Negotiate ${ctx.unit.attributes.item} with ${ctx.unit.attributes.vendor}, target $${ctx.unit.attributes.targetUsd}. Their last reply: ${ctx.unit.attributes.lastReply}`,
  }))
  .exit('walkAway', ctx => ctx.steps.offer.walkAway)
  .step('send', sendOffer, ctx => ({ reference: ctx.unit.attributes.reference, message: ctx.steps.offer.message }), { afterCrash: 'park' })
  .exit('offered');

const vendorReplied = H.signal('vendor-replied').payload(z.object({ message: z.string() }));
const vendorAgreed = H.signal('vendor-agreed');
const vendorWalked = H.signal('vendor-walked');
const negotiationExpired = H.signal('negotiation-expired');

const vendorReplies = webhook.json('vendor-replies', {
  port: H.slot.port(2),
  path: '/vendor',
  secret: H.env('VENDOR_WEBHOOK_SECRET'),
  payload: z.object({ reference: z.string(), reply: z.enum(['counter', 'accept', 'walk-away']), message: z.string() }),
});

const negotiations = H.lane('negotiations', negotiationKind)
  .supply(H.operator)
  .supply(vendorReplies, (e, to) =>
    e.reply === 'counter'
      ? to.signal(vendorReplied, e.reference, { message: e.message })
      : e.reply === 'accept'
        ? to.signal(vendorAgreed, e.reference, {})
        : to.signal(vendorWalked, e.reference, {}),
  )
  .handler(negotiationRound, { exits: { walkAway: WalkedAwayByUs, offered: TheirMove } })
  .store(sqlite.store({ path: '/srv/lifecycles/store.sqlite' }))
  .retry({ maxAttempts: 3, backoff: 'exponential', initialDelayMs: 300_000, exhausted: Stalled })
  .on(vendorReplied, { update: (a, p) => ({ ...a, lastReply: p.message }), enter: OurMove })
  .on(vendorAgreed, { enter: Agreed })
  .on(vendorWalked, { enter: WalkedAwayByThem })
  .on(negotiationExpired, { enter: Expired });

const expireNegotiations = H.trigger('expire-negotiations')
  .on(H.when.timer(negotiations, { reads: ['deadline'], at: v => new Date(v.attributes.deadline) }))
  .signal(negotiationExpired, negotiations, e => ({ key: e.unit.key, payload: {} }));

const scheduler = H.scheduler('lifecycles')
  .standard(experiments, tenancies, negotiations)
  .wip(experiments, 5)
  .admit(experiments, ctx => {
    const record = ctx.metrics.outcomes({ of: experiments, window: { lastDays: 180 } });
    return record.terminal < 10 || record.count(Inconclusive) / record.terminal < 0.5;
  });

const operatorApi = http.controlApi('operator', {
  port: H.slot.port(3),
  token: H.env('OPERATOR_TOKEN'),
  grants: [H.ops.workRead, H.ops.workCreate, H.ops.workSignal, H.ops.resolve(upsellHalt), H.ops.telemetryRead],
});

const harness = H.harness('lifecycles')
  .ledger(sqlite.ledger({ path: '/srv/lifecycles/ledger.sqlite' }))
  .lanes(experiments, tenancies, negotiations)
  .triggers(openMonthlyReviews, expireNegotiations)
  .scheduler(scheduler)
  .clients(operatorApi)
  .observers(markdown.board({ path: '/srv/lifecycles/board.md' }));

void harness.start();
