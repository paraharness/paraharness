import { z } from 'zod';
import { H } from 'harness-dsl';
import { sqlite } from 'harness-dsl/sqlite';
import { anthropic } from 'harness-dsl/anthropic';
import { local } from 'harness-dsl/local';
import { http } from 'harness-dsl/http';
import { webhook } from 'harness-dsl/webhook';
import { markdown } from 'harness-dsl/markdown';

const localRunner = local.runner('local').slots(4);
const harnessStore = sqlite.store({ path: '.harness/units.sqlite' });

const quota = sqlite.quota('lifecycles-quota', { path: '.harness/quota.sqlite' });
const apiAccount = anthropic.account('anthropic-api', { apiKey: H.env('ANTHROPIC_API_KEY'), quota });
const sonnet = anthropic.model('sonnet', { id: 'claude-sonnet-4-5' });
const pool = H.pool('api-pool').accounts(apiAccount);

const experimentSchema = z.object({ name: z.string(), metric: z.string() });

const ExperimentScheduled = H.state('ExperimentScheduled', 'pending');
const AWins = H.terminal('AWins', 'neutral');
const BWins = H.terminal('BWins', 'neutral');
const Inconclusive = H.terminal('Inconclusive', 'neutral');
const ExperimentBroken = H.terminal('ExperimentBroken', 'failure');

const experiment = H.kind('Experiment')
  .attributes(experimentSchema)
  .states(ExperimentScheduled, AWins, BWins, Inconclusive, ExperimentBroken)
  .key(a => a.name)
  .initial(ExperimentScheduled);

const sampleMetric = H.command('sample-experiment')
  .input(z.object({ name: z.string(), metric: z.string() }))
  .argv(input => ['experiments', 'sample', input.name, input.metric])
  .output(z.object({ a: z.number(), b: z.number() }))
  .runner(localRunner);

const decideExperiment = H.command('decide-experiment')
  .input(z.object({ name: z.string() }))
  .argv(input => ['experiments', 'decide', input.name])
  .output(z.object({ winner: z.enum(['a', 'b', 'none']) }))
  .runner(localRunner);

const runExperiment = H.flow('run-experiment')
  .input(experimentSchema)
  .loop('hours', hour => hour
    .step('sample', sampleMetric, ctx => ({ name: ctx.unit.attributes.name, metric: ctx.unit.attributes.metric }))
    .wait('nextHour', { ms: 3_600_000 }),
    { max: 14 * 24 })
  .step('decide', decideExperiment, ctx => ({ name: ctx.unit.attributes.name }))
  .exit('aWins', ctx => ctx.steps.decide.winner === 'a')
  .exit('bWins', ctx => ctx.steps.decide.winner === 'b')
  .exit('inconclusive');

const experiments = H.lane('experiments', experiment)
  .supply(H.operator)
  .handler(runExperiment, { exits: { aWins: AWins, bWins: BWins, inconclusive: Inconclusive } })
  .store(harnessStore)
  .retry({ maxAttempts: 2, backoff: 'exponential', initialDelayMs: 600_000, exhausted: ExperimentBroken });

const tenancySchema = z.object({ customerId: z.string(), plan: z.string() });

const ReviewDue = H.state('ReviewDue', 'pending');
const Customer = H.state('Customer', 'waiting');
const Suspended = H.state('Suspended', 'waiting');
const ReviewStuck = H.state('ReviewStuck', 'waiting');
const Churned = H.terminal('Churned', 'neutral');

const tenancy = H.kind('Tenancy')
  .attributes(tenancySchema)
  .states(ReviewDue, Customer, Suspended, ReviewStuck, Churned)
  .key(a => a.customerId)
  .initial(ReviewDue);

const usageReview = H.command('usage-review')
  .input(z.object({ customerId: z.string() }))
  .argv(input => ['billing', 'usage', input.customerId, '--last-month'])
  .output(z.object({ seats: z.number(), usageUsd: z.number(), trend: z.string() }))
  .runner(localRunner);

const accountManagerRole = H.role('account-manager').intents('read').instructions('Summarize the month of usage for a human deciding on an upsell.');

const summarizer = H.seat('tenancy-summarizer')
  .role(accountManagerRole)
  .model(sonnet)
  .pool(pool)
  .output(z.object({ summary: z.string() }));

const upsell = H.halt('upsell').decision(z.object({ upsell: z.boolean(), note: z.string() }));

const reviewTenancy = H.flow('review-tenancy')
  .input(tenancySchema)
  .step('usage', usageReview, ctx => ({ customerId: ctx.unit.attributes.customerId }))
  .step('summary', summarizer, ctx => ({
    task: `Customer ${ctx.unit.attributes.customerId} on ${ctx.unit.attributes.plan}: ${ctx.steps.usage.seats} seats, $${ctx.steps.usage.usageUsd}, trend ${ctx.steps.usage.trend}.`,
  }))
  .halt('decide', upsell, { ask: ctx => `Upsell ${ctx.unit.attributes.customerId}?\n${ctx.steps.summary.summary}` })
  .exit('reviewed');

const evaluate = H.signal('evaluate');
const suspend = H.signal('suspend');
const reinstate = H.signal('reinstate');
const churn = H.signal('churn');

const tenancies = H.lane('tenancies', tenancy)
  .supply(H.operator)
  .handler(reviewTenancy, { exits: { reviewed: Customer } })
  .store(harnessStore)
  .retry({ maxAttempts: 3, backoff: 'exponential', initialDelayMs: 3_600_000, exhausted: ReviewStuck })
  .on(evaluate, { enter: ReviewDue })
  .on(suspend, { enter: Suspended })
  .on(reinstate, { enter: Customer })
  .on(churn, { enter: Churned });

const firstOfMonth = H.clock('first-of-month').at('06:00', { on: 1, tz: 'UTC' });

const monthlyReview = H.trigger('monthly-review')
  .on(H.when.sweep(tenancies, { every: firstOfMonth, in: Customer }))
  .signal(evaluate, tenancies, event => ({ key: event.unit.key, payload: {} }));

const negotiationSchema = z.object({
  negotiationId: z.string(),
  vendor: z.string(),
  item: z.string(),
  deadline: z.string(),
  lastVendorMessage: z.string(),
});

const OurTurn = H.state('OurTurn', 'pending');
const AwaitingVendor = H.state('AwaitingVendor', 'waiting');
const NegotiationStalled = H.state('NegotiationStalled', 'waiting');
const Agreed = H.terminal('Agreed', 'success');
const WalkedAwayByUs = H.terminal('WalkedAwayByUs', 'neutral');
const WalkedAwayByThem = H.terminal('WalkedAwayByThem', 'failure');
const Expired = H.terminal('Expired', 'failure');

const negotiation = H.kind('Negotiation')
  .attributes(negotiationSchema)
  .states(OurTurn, AwaitingVendor, NegotiationStalled, Agreed, WalkedAwayByUs, WalkedAwayByThem, Expired)
  .key(a => a.negotiationId)
  .initial(OurTurn);

const negotiatorRole = H.role('negotiator').intents('read').instructions('Draft our next move in the procurement negotiation.');

const negotiator = H.seat('negotiator')
  .role(negotiatorRole)
  .model(sonnet)
  .pool(pool)
  .output(z.object({ action: z.enum(['offer', 'accept', 'walkAway']), offer: z.string() }));

const walkAway = H.halt('walk-away').decision(z.object({ confirm: z.boolean() }));

const sendOffer = H.command('send-offer')
  .input(z.object({ negotiationId: z.string(), offer: z.string() }))
  .argv(input => ['procurement', 'send', input.negotiationId, input.offer])
  .runner(localRunner);

const negotiateRound = H.flow('negotiate-round')
  .input(negotiationSchema)
  .step('draft', negotiator, ctx => ({
    task: `Round ${ctx.unit.attempts} with ${ctx.unit.attributes.vendor} for ${ctx.unit.attributes.item}. Their last message: ${ctx.unit.attributes.lastVendorMessage}`,
  }))
  .halt('confirmWalkAway', walkAway, {
    when: ctx => ctx.steps.draft.action === 'walkAway',
    ask: ctx => `Walk away from ${ctx.unit.attributes.vendor}? Reason: ${ctx.steps.draft.offer}`,
  })
  .exit('walkedAway', ctx => ctx.steps.confirmWalkAway?.confirm === true)
  .step('send', sendOffer, ctx => ({ negotiationId: ctx.unit.attributes.negotiationId, offer: ctx.steps.draft.offer }), { afterCrash: 'park' })
  .exit('agreed', ctx => ctx.steps.draft.action === 'accept')
  .exit('offered');

const vendorCountered = H.signal('vendor-countered').payload(z.object({ message: z.string() }));
const vendorAccepted = H.signal('vendor-accepted');
const vendorWithdrew = H.signal('vendor-withdrew');
const expire = H.signal('expire');

const vendorReplies = webhook.json('vendor-replies', {
  port: H.slot.port(2),
  path: '/vendor-replies',
  secret: H.env('VENDOR_WEBHOOK_SECRET'),
  payload: z.object({ negotiationId: z.string(), reply: z.enum(['counter', 'accept', 'withdraw']), message: z.string() }),
});

const negotiations = H.lane('negotiations', negotiation)
  .supply(H.operator)
  .supply(vendorReplies, (reply, to) =>
    reply.reply === 'counter'
      ? to.signal(vendorCountered, reply.negotiationId, { message: reply.message })
      : reply.reply === 'accept'
        ? to.signal(vendorAccepted, reply.negotiationId, {})
        : to.signal(vendorWithdrew, reply.negotiationId, {}))
  .handler(negotiateRound, { exits: { walkedAway: WalkedAwayByUs, agreed: Agreed, offered: AwaitingVendor } })
  .store(harnessStore)
  .retry({ maxAttempts: 3, backoff: 'exponential', initialDelayMs: 600_000, exhausted: NegotiationStalled })
  .on(vendorCountered, { update: (attrs, payload) => ({ ...attrs, lastVendorMessage: payload.message }), enter: OurTurn })
  .on(vendorAccepted, { enter: Agreed })
  .on(vendorWithdrew, { enter: WalkedAwayByThem })
  .on(expire, { enter: Expired });

const negotiationExpiry = H.trigger('negotiation-expiry')
  .on(H.when.timer(negotiations, { reads: ['deadline'], at: view => new Date(view.attributes.deadline) }))
  .signal(expire, negotiations, event => ({ key: event.unit.key, payload: {} }));

const operatorApi = http.controlApi('operator', {
  port: H.slot.port(1),
  token: H.env('OPERATOR_TOKEN'),
  grants: [H.ops.workRead, H.ops.workCreate, H.ops.workSignal, H.ops.resolve(upsell, walkAway), H.ops.telemetryRead],
});

export const lifecycles = H.harness('lifecycles')
  .ledger(sqlite.ledger({ path: '.harness/ledger.sqlite' }))
  .lanes(experiments, tenancies, negotiations)
  .triggers(monthlyReview, negotiationExpiry)
  .scheduler(H.scheduler('lifecycles')
    .standard(negotiations, tenancies, experiments)
    .admit(experiments, ctx => {
      const ended = ctx.metrics.outcomes({ of: experiments, window: { lastDays: 180 } });
      return ended.samples < 10 || ended.count(Inconclusive) / ended.samples < 0.6;
    }))
  .clients(operatorApi)
  .observers(markdown.board({ path: 'BOARD.md' }), markdown.telemetry({ path: 'TELEMETRY.md' }));
