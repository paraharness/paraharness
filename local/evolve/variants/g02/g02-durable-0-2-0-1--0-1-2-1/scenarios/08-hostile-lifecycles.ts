import { z } from 'zod';
import { H } from 'harness-dsl';
import { sqlite } from 'harness-dsl/sqlite';
import { anthropic } from 'harness-dsl/anthropic';
import { local } from 'harness-dsl/local';
import { webhook } from 'harness-dsl/webhook';
import { http } from 'harness-dsl/http';
import { markdown } from 'harness-dsl/markdown';

const store = sqlite.store({ path: './lifecycles/store.sqlite' });
const runner = local.runner('local');

const apiAccount = anthropic.account('api', {
  apiKey: H.env('ANTHROPIC_API_KEY'),
  quota: sqlite.quota('lifecycles-api', { path: './lifecycles/quota.sqlite' }),
});
const sonnet = anthropic.model('sonnet', { id: 'claude-sonnet-4-5' });
const pool = H.pool('main').accounts(apiAccount);

const ExperimentAttrs = z.object({ experiment: z.string() });
const ExperimentScheduled = H.state('ExperimentScheduled', 'pending');
const AWins = H.terminal('AWins', 'neutral');
const BWins = H.terminal('BWins', 'neutral');
const Inconclusive = H.terminal('Inconclusive', 'neutral');
const MeasurementFailed = H.terminal('MeasurementFailed', 'failure');
const Experiment = H.kind('Experiment')
  .attributes(ExperimentAttrs)
  .states(ExperimentScheduled, AWins, BWins, Inconclusive, MeasurementFailed)
  .key(a => a.experiment)
  .initial(ExperimentScheduled);

const measure = H.command('measure-experiment')
  .input(ExperimentAttrs)
  .argv(i => ['./bin/measure', i.experiment])
  .runner(runner);
const decideWinner = H.command('decide-experiment')
  .input(ExperimentAttrs)
  .argv(i => ['./bin/decide', i.experiment])
  .output(z.object({ winner: z.enum(['A', 'B', 'none']) }))
  .runner(runner);

const experimentFlow = H.flow('experiment')
  .input(ExperimentAttrs)
  .loop('hours', f => f
    .step('measure', measure, ctx => ({ experiment: ctx.unit.attributes.experiment }), {
      retry: { maxAttempts: 3, backoff: 'exponential', initialDelayMs: 60_000 },
      afterCrash: 'rerun',
    })
    .wait('nextHour', { ms: 3_600_000 }),
    { max: 14 * 24 })
  .step('decide', decideWinner, ctx => ({ experiment: ctx.unit.attributes.experiment }))
  .exit('aWins', ctx => ctx.steps.decide.winner === 'A')
  .exit('bWins', ctx => ctx.steps.decide.winner === 'B')
  .exit('inconclusive');

const experimentLane = H.lane('experiments', Experiment)
  .supply(H.operator)
  .handler(experimentFlow, { exits: { aWins: AWins, bWins: BWins, inconclusive: Inconclusive } })
  .store(store)
  .retry({ maxAttempts: 2, exhausted: MeasurementFailed });

const TenancyAttrs = z.object({ customerId: z.string(), plan: z.string() });
const ReviewDue = H.state('ReviewDue', 'pending');
const Customer = H.state('Customer', 'waiting');
const Suspended = H.state('Suspended', 'waiting');
const Churned = H.terminal('Churned', 'neutral');
const Tenancy = H.kind('Tenancy')
  .attributes(TenancyAttrs)
  .states(ReviewDue, Customer, Suspended, Churned)
  .key(a => a.customerId)
  .initial(ReviewDue);

const reviewDue = H.signal('review-due');
const suspend = H.signal('suspend');
const reinstate = H.signal('reinstate');
const churn = H.signal('churn');

const accountManager = H.role('account-manager').intents('read').instructions('Summarize usage and the upsell case in plain language.');
const usageSummarizer = H.seat('usage-summarizer').role(accountManager).model(sonnet).pool(pool);
const usageReport = H.command('usage-report')
  .input(z.object({ customerId: z.string() }))
  .argv(i => ['./bin/usage', i.customerId])
  .runner(runner);
const upsell = H.halt('upsell').decision(z.object({ upsell: z.boolean(), note: z.string() }));

const tenancyFlow = H.flow('tenancy-review')
  .input(TenancyAttrs)
  .step('usage', usageReport, ctx => ({ customerId: ctx.unit.attributes.customerId }))
  .step('summary', usageSummarizer, ctx => ({ task: `Summarize this month for ${ctx.unit.attributes.customerId} on ${ctx.unit.attributes.plan}:\n${ctx.steps.usage.stdout}` }))
  .halt('upsell', upsell, { ask: ctx => `Upsell ${ctx.unit.attributes.customerId}?\n${ctx.steps.summary}` })
  .exit('reviewed');

const billingEvents = webhook.json('billing-events', {
  port: H.slot.port(1),
  path: '/billing',
  secret: H.env('BILLING_WEBHOOK_SECRET'),
  payload: z.object({ type: z.enum(['signup', 'suspend', 'reinstate', 'churn']), customerId: z.string(), plan: z.string() }),
});

const tenancyLane = H.lane('tenancies', Tenancy)
  .supply(billingEvents, (ev, to) =>
    ev.type === 'signup' ? to.create({ customerId: ev.customerId, plan: ev.plan })
      : ev.type === 'suspend' ? to.signal(suspend, ev.customerId, {})
        : ev.type === 'reinstate' ? to.signal(reinstate, ev.customerId, {})
          : to.signal(churn, ev.customerId, {}))
  .supply(H.operator)
  .handler(tenancyFlow, { exits: { reviewed: Customer } })
  .store(store)
  .retry({ maxAttempts: 3, backoff: 'exponential', initialDelayMs: 3_600_000, exhausted: Customer })
  .on(reviewDue, { enter: ReviewDue })
  .on(suspend, { enter: Suspended })
  .on(reinstate, { enter: Customer })
  .on(churn, { enter: Churned });

const monthlyReview = H.trigger('monthly-tenancy-review')
  .on(H.when.timer(tenancyLane, {
    at: unit => unit.state === Customer ? H.nextTime('09:00', { after: unit.stateSince, on: 1 }) : undefined,
  }))
  .signal(reviewDue, tenancyLane, ev => ({ key: ev.unit.key, payload: {} }));

const NegotiationAttrs = z.object({
  negotiationId: z.string(),
  vendor: z.string(),
  item: z.string(),
  deadline: z.string(),
  history: z.array(z.string()),
});
const Drafting = H.state('Drafting', 'pending');
const AwaitingVendor = H.state('AwaitingVendor', 'waiting');
const Stalled = H.state('Stalled', 'waiting');
const Agreed = H.terminal('Agreed', 'success');
const WalkedAwayByUs = H.terminal('WalkedAwayByUs', 'neutral');
const WalkedAwayByThem = H.terminal('WalkedAwayByThem', 'failure');
const Expired = H.terminal('Expired', 'failure');
const Negotiation = H.kind('Negotiation')
  .attributes(NegotiationAttrs)
  .states(Drafting, AwaitingVendor, Stalled, Agreed, WalkedAwayByUs, WalkedAwayByThem, Expired)
  .key(a => a.negotiationId)
  .initial(Drafting);

const VendorMessage = z.object({ message: z.string() });
const vendorReplied = H.signal('vendor-replied').payload(VendorMessage);
const vendorAccepted = H.signal('vendor-accepted').payload(VendorMessage);
const vendorWalked = H.signal('vendor-walked').payload(VendorMessage);
const expire = H.signal('expire');
const nudge = H.signal('nudge');

const negotiator = H.role('negotiator').intents('read').instructions('Draft the next move toward an agreement within the mandate.');
const offerDrafter = H.seat('offer-drafter')
  .role(negotiator)
  .model(sonnet)
  .pool(pool)
  .output(z.object({ action: z.enum(['offer', 'accept', 'walkAway']), message: z.string() }));
const sendToVendor = H.command('send-to-vendor')
  .input(z.object({ negotiationId: z.string(), message: z.string() }))
  .argv(i => ['./bin/send-vendor', i.negotiationId, i.message])
  .runner(runner);

const roundFlow = H.flow('negotiation-round')
  .input(NegotiationAttrs)
  .step('draft', offerDrafter, ctx => ({
    task: `Negotiate ${ctx.unit.attributes.item} with ${ctx.unit.attributes.vendor}. Vendor messages so far:\n${ctx.unit.attributes.history.join('\n')}`,
  }))
  .step('send', sendToVendor, ctx => ({ negotiationId: ctx.unit.attributes.negotiationId, message: ctx.steps.draft.message }), { afterCrash: 'park' })
  .exit('accepted', ctx => ctx.steps.draft.action === 'accept')
  .exit('walkedAway', ctx => ctx.steps.draft.action === 'walkAway')
  .exit('offered');

const vendorWebhook = webhook.json('vendor-replies', {
  port: H.slot.port(2),
  path: '/vendor',
  secret: H.env('VENDOR_WEBHOOK_SECRET'),
  payload: z.object({ negotiationId: z.string(), status: z.enum(['counter', 'accept', 'walkAway']), message: z.string() }),
});

const negotiationLane = H.lane('negotiations', Negotiation)
  .supply(H.operator)
  .supply(vendorWebhook, (ev, to) =>
    ev.status === 'counter' ? to.signal(vendorReplied, ev.negotiationId, { message: ev.message })
      : ev.status === 'accept' ? to.signal(vendorAccepted, ev.negotiationId, { message: ev.message })
        : to.signal(vendorWalked, ev.negotiationId, { message: ev.message }))
  .handler(roundFlow, { exits: { accepted: Agreed, walkedAway: WalkedAwayByUs, offered: AwaitingVendor } })
  .store(store)
  .retry({ maxAttempts: 3, backoff: 'exponential', initialDelayMs: 300_000, exhausted: Stalled })
  .on(vendorReplied, { update: (a, p) => ({ ...a, history: [...a.history, p.message] }), enter: Drafting })
  .on(vendorAccepted, { update: (a, p) => ({ ...a, history: [...a.history, p.message] }), enter: Agreed })
  .on(vendorWalked, { update: (a, p) => ({ ...a, history: [...a.history, p.message] }), enter: WalkedAwayByThem })
  .on(expire, { enter: Expired })
  .on(nudge, { enter: Drafting });

const negotiationExpiry = H.trigger('negotiation-expiry')
  .on(H.when.timer(negotiationLane, {
    at: unit => unit.position === 'terminal' ? undefined : new Date(unit.attributes.deadline),
  }))
  .signal(expire, negotiationLane, ev => ({ key: ev.unit.key, payload: {} }));

const operatorApi = http.controlApi('operator-api', {
  port: H.slot.port(3),
  token: H.env('OPERATOR_API_TOKEN'),
  grants: [H.ops.workRead, H.ops.workCreate, H.ops.workSignal, H.ops.workCancel, H.ops.resolve(upsell), H.ops.telemetryRead],
});

export const harness = H.harness('lifecycles')
  .ledger(sqlite.ledger({ path: './lifecycles/ledger.sqlite' }))
  .lanes(experimentLane, tenancyLane, negotiationLane)
  .triggers(monthlyReview, negotiationExpiry)
  .scheduler(H.scheduler('lifecycles')
    .standard(negotiationLane, tenancyLane, experimentLane)
    .admit(experimentLane, ctx => {
      const outcomes = ctx.metrics.outcomes({ of: experimentLane, window: { lastDays: 180 } });
      return outcomes.samples < 10 || outcomes.count(Inconclusive) / outcomes.samples < 0.5;
    }))
  .clients(operatorApi)
  .observers(markdown.board({ path: './lifecycles/BOARD.md' }), markdown.telemetry({ path: './lifecycles/TELEMETRY.md' }));
