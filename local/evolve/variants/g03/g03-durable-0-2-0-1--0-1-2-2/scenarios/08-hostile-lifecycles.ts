import { z } from 'zod';
import { H } from 'harness-dsl';
import { claudeCode } from 'harness-dsl/claude-code';
import { sqlite } from 'harness-dsl/sqlite';
import { local } from 'harness-dsl/local';
import { http } from 'harness-dsl/http';
import { webhook } from 'harness-dsl/webhook';
import { markdown } from 'harness-dsl/markdown';

const harnessStore = sqlite.store({ path: '/srv/lifecycles/units.sqlite' });
const worker = local.runner('worker').slots(4);

const subscription = claudeCode.subscription('lifecycles-subscription', {
  token: H.env('CLAUDE_TOKEN'),
  quota: sqlite.quota('lifecycles-quota', { path: '/srv/lifecycles/quota.sqlite' }),
});
const sonnet = claudeCode.model('sonnet', { id: 'claude-sonnet-4-5' });
const pool = H.pool('lifecycles').accounts(subscription);

const Proposed = H.state('Proposed', 'pending');
const AWins = H.terminal('AWins', 'success');
const BWins = H.terminal('BWins', 'success');
const Inconclusive = H.terminal('Inconclusive', 'neutral');
const ExperimentBroken = H.terminal('ExperimentBroken', 'failure');
const experimentAttrs = z.object({ name: z.string(), metric: z.string() });
const Experiment = H.kind('Experiment')
  .attributes(experimentAttrs)
  .states(Proposed, AWins, BWins, Inconclusive, ExperimentBroken)
  .key(attrs => attrs.name)
  .initial(Proposed);

const measureVariants = H.command('measure-variants')
  .input(experimentAttrs)
  .argv(experiment => ['./experiments/measure.sh', experiment.name, experiment.metric])
  .runner(worker);

const judgeExperiment = H.command('judge-experiment')
  .input(experimentAttrs)
  .argv(experiment => ['./experiments/judge.sh', experiment.name])
  .output(z.object({ winner: z.enum(['A', 'B', 'none']) }))
  .runner(worker);

const runExperiment = H.flow('run-experiment')
  .input(experimentAttrs)
  .loop('hours', body => body.step('measure', measureVariants, ctx => ctx.unit.attributes).wait('nextHour', { ms: 3_600_000 }), {
    max: 14 * 24,
  })
  .step('judge', judgeExperiment, ctx => ctx.unit.attributes)
  .exit('aWins', ctx => ctx.steps.judge.winner === 'A')
  .exit('bWins', ctx => ctx.steps.judge.winner === 'B')
  .exit('inconclusive');

const experiments = H.lane('experiments', Experiment)
  .supply(H.operator)
  .handler(runExperiment, { exits: { aWins: AWins, bWins: BWins, inconclusive: Inconclusive } })
  .store(harnessStore)
  .retry({ maxAttempts: 2, backoff: 'fixed', initialDelayMs: 3_600_000, exhausted: ExperimentBroken });

const DueForReview = H.state('DueForReview', 'pending');
const Customer = H.state('Customer', 'waiting');
const Suspended = H.state('Suspended', 'waiting');
const Churned = H.terminal('Churned', 'neutral');
const tenancyAttrs = z.object({ customerId: z.string(), plan: z.string() });
const Tenancy = H.kind('Tenancy')
  .attributes(tenancyAttrs)
  .states(DueForReview, Customer, Suspended, Churned)
  .key(attrs => attrs.customerId)
  .initial(DueForReview);

const upsellDecision = H.halt('upsell-decision').decision(z.object({ upsell: z.boolean(), note: z.string() }));

const usageReport = H.command('usage-report')
  .input(z.object({ customerId: z.string() }))
  .argv(customer => ['./tenancy/usage.sh', customer.customerId])
  .output(z.object({ activeSeats: z.number(), monthlyUsd: z.number() }))
  .runner(worker);

const accountSummarizer = H.seat('account-summarizer')
  .role(H.role('account-summarizer').intents('read').instructions('Summarise a customer month in five sentences for an upsell decision.'))
  .model(sonnet)
  .pool(pool);

const reviewTenancy = H.flow('review-tenancy')
  .input(tenancyAttrs)
  .step('usage', usageReport, ctx => ({ customerId: ctx.unit.attributes.customerId }))
  .step('summary', accountSummarizer, ctx => ({
    task: `Customer ${ctx.unit.attributes.customerId} on ${ctx.unit.attributes.plan}: ${ctx.steps.usage.activeSeats} active seats, $${ctx.steps.usage.monthlyUsd} this month.`,
  }))
  .halt('upsell', upsellDecision, { ask: ctx => ctx.steps.summary })
  .exit('reviewed');

const monthlyReview = H.signal('monthly-review');
const suspend = H.signal('suspend').payload(z.object({ reason: z.string() }));
const reinstate = H.signal('reinstate');
const churn = H.signal('churn');

const billingEvents = webhook.json('billing-events', {
  port: H.slot.port(1),
  path: '/billing',
  secret: H.env('BILLING_WEBHOOK_SECRET'),
  payload: z.object({
    customerId: z.string(),
    type: z.enum(['suspended', 'reinstated', 'churned']),
    reason: z.string().optional(),
  }),
});

const tenancies = H.lane('tenancies', Tenancy)
  .supply(H.operator)
  .supply(
    sqlite.scan('tenancies-due-for-review', {
      path: '/srv/lifecycles/units.sqlite',
      kind: Tenancy,
      states: [Customer],
      schedule: H.clock('first-of-month').at('06:00', { on: 1, tz: 'Europe/London' }),
    }),
    (due, to) => to.signal(monthlyReview, due.key, {}),
  )
  .supply(billingEvents, (event, to) =>
    event.type === 'suspended'
      ? to.signal(suspend, event.customerId, { reason: event.reason ?? 'billing' })
      : event.type === 'reinstated'
        ? to.signal(reinstate, event.customerId, {})
        : to.signal(churn, event.customerId, {}),
  )
  .handler(reviewTenancy, { exits: { reviewed: Customer } })
  .store(harnessStore)
  .retry({ maxAttempts: 3, backoff: 'exponential', initialDelayMs: 600_000, exhausted: Customer })
  .on(monthlyReview, { enter: DueForReview })
  .on(suspend, { enter: Suspended })
  .on(reinstate, { enter: Customer })
  .on(churn, { enter: Churned });

const Drafting = H.state('Drafting', 'pending');
const AwaitingVendor = H.state('AwaitingVendor', 'waiting');
const Stalled = H.state('Stalled', 'waiting');
const Agreed = H.terminal('Agreed', 'success');
const WalkedAwayByUs = H.terminal('WalkedAwayByUs', 'neutral');
const WalkedAwayByThem = H.terminal('WalkedAwayByThem', 'failure');
const Expired = H.terminal('Expired', 'failure');
const negotiationAttrs = z.object({
  negotiationId: z.string(),
  vendor: z.string(),
  item: z.string(),
  expiresAt: z.coerce.date(),
  vendorMessages: z.array(z.string()),
});
const Negotiation = H.kind('Negotiation')
  .attributes(negotiationAttrs)
  .states(Drafting, AwaitingVendor, Stalled, Agreed, WalkedAwayByUs, WalkedAwayByThem, Expired)
  .key(attrs => attrs.negotiationId)
  .initial(Drafting);

const negotiator = H.seat('negotiator')
  .role(
    H.role('negotiator')
      .intents('read')
      .instructions('Draft our next move in the procurement negotiation; walk away when the terms cannot meet our floor.')
      .output(z.object({ move: z.enum(['offer', 'walkAway']), message: z.string() })),
  )
  .model(sonnet)
  .pool(pool);

const sendOffer = H.command('send-offer')
  .input(z.object({ vendor: z.string(), message: z.string() }))
  .argv(offer => ['./procurement/send.sh', offer.vendor, offer.message])
  .runner(worker);

const negotiateRound = H.flow('negotiate-round')
  .input(negotiationAttrs)
  .step('draft', negotiator, ctx => ({
    task: [
      `Negotiate ${ctx.unit.attributes.item} with ${ctx.unit.attributes.vendor}.`,
      ...ctx.unit.attributes.vendorMessages.map(message => `Vendor said: ${message}`),
    ].join('\n'),
  }))
  .exit('walkedAway', ctx => ctx.steps.draft.move === 'walkAway')
  .step('send', sendOffer, ctx => ({ vendor: ctx.unit.attributes.vendor, message: ctx.steps.draft.message }), { afterCrash: 'park' })
  .exit('offered');

const vendorReplied = H.signal('vendor-replied').payload(z.object({ message: z.string() }));
const vendorAccepted = H.signal('vendor-accepted');
const vendorWalkedAway = H.signal('vendor-walked-away');
const negotiationExpired = H.signal('negotiation-expired');

const vendorReplies = webhook.json('vendor-replies', {
  port: H.slot.port(2),
  path: '/vendor',
  secret: H.env('VENDOR_WEBHOOK_SECRET'),
  payload: z.object({
    negotiationId: z.string(),
    type: z.enum(['replied', 'accepted', 'walkedAway']),
    message: z.string(),
  }),
});

const negotiations = H.lane('negotiations', Negotiation)
  .supply(H.operator)
  .supply(vendorReplies, (reply, to) =>
    reply.type === 'replied'
      ? to.signal(vendorReplied, reply.negotiationId, { message: reply.message })
      : reply.type === 'accepted'
        ? to.signal(vendorAccepted, reply.negotiationId, {})
        : to.signal(vendorWalkedAway, reply.negotiationId, {}),
  )
  .handler(negotiateRound, { exits: { walkedAway: WalkedAwayByUs, offered: AwaitingVendor } })
  .store(harnessStore)
  .retry({ maxAttempts: 3, backoff: 'exponential', initialDelayMs: 300_000, exhausted: Stalled })
  .on(vendorReplied, { update: (attrs, reply) => ({ ...attrs, vendorMessages: [...attrs.vendorMessages, reply.message] }), enter: Drafting })
  .on(vendorAccepted, { enter: Agreed })
  .on(vendorWalkedAway, { enter: WalkedAwayByThem })
  .on(negotiationExpired, { enter: Expired });

const negotiationExpiry = H.trigger('negotiation-expiry')
  .on(H.when.timer(negotiations, { at: unit => unit.attributes.expiresAt }))
  .signal(negotiationExpired, negotiations, event => ({ key: event.unit.key, payload: {} }));

const scheduler = H.scheduler('lifecycles')
  .standard(negotiations, tenancies, experiments)
  .admit(experiments, ctx => {
    const ended = ctx.metrics.outcomes({ of: experiments, window: { lastDays: 90 } });
    return ended.samples < 10 || ended.count(Inconclusive) / ended.samples < 0.6;
  });

const operations = http.controlApi('operations', {
  port: H.slot.port(3),
  token: H.env('OPERATIONS_TOKEN'),
  grants: [H.ops.workRead, H.ops.workCreate, H.ops.workSignal, H.ops.resolve(upsellDecision), H.ops.attemptsRecover, H.ops.telemetryRead],
});

export const harness = H.harness('lifecycles')
  .ledger(sqlite.ledger({ path: '/srv/lifecycles/ledger.sqlite' }))
  .lanes(experiments, tenancies, negotiations)
  .triggers(negotiationExpiry)
  .scheduler(scheduler)
  .clients(operations)
  .observers(markdown.board({ path: '/srv/lifecycles/BOARD.md' }), markdown.telemetry({ path: '/srv/lifecycles/TELEMETRY.md' }));

void harness.start();
