import { z } from 'zod';
import { H, type Metrics } from 'harness-dsl';
import { anthropic } from 'harness-dsl/anthropic';
import { sqlite } from 'harness-dsl/sqlite';
import { local } from 'harness-dsl/local';
import { http } from 'harness-dsl/http';
import { webhook } from 'harness-dsl/webhook';
import { markdown } from 'harness-dsl/markdown';

const apiAccount = anthropic.account('lifecycles-api', {
  apiKey: H.env('ANTHROPIC_API_KEY'),
  quota: sqlite.quota('lifecycles-api', { path: '.harness/quota.db' }),
});
const sonnet = anthropic.model('sonnet', { id: 'claude-sonnet-4-5' });
const pool = H.pool('lifecycles').accounts(apiAccount);
const runner = local.runner('lifecycles-local');
const store = sqlite.store({ path: '.harness/units.db' });

const ExperimentAttrs = z.object({ experiment: z.string() });
const Planned = H.state('Planned', 'pending');
const MeasurementBroken = H.state('MeasurementBroken', 'waiting');
const AWins = H.terminal('AWins', 'success');
const BWins = H.terminal('BWins', 'success');
const Inconclusive = H.terminal('Inconclusive', 'neutral');

const Experiment = H.kind('Experiment')
  .attributes(ExperimentAttrs)
  .states(Planned, MeasurementBroken, AWins, BWins, Inconclusive)
  .key(attrs => attrs.experiment)
  .initial(Planned);

const measure = H.command('measure-experiment')
  .input(ExperimentAttrs)
  .argv(input => ['./experiments/measure', input.experiment])
  .output(z.object({ a: z.number(), b: z.number() }))
  .runner(runner);

const conclude = H.command('conclude-experiment')
  .input(ExperimentAttrs)
  .argv(input => ['./experiments/conclude', input.experiment])
  .output(z.object({ winner: z.enum(['a', 'b', 'none']) }))
  .runner(runner);

const runExperiment = H.flow('run-experiment')
  .input(ExperimentAttrs)
  .loop(
    'hours',
    hour =>
      hour
        .step('measure', measure, ctx => ({ experiment: ctx.unit.attributes.experiment }), { afterCrash: 'rerun' })
        .wait('nextHour', { ms: 3600000 }),
    { max: 336 },
  )
  .step('conclude', conclude, ctx => ({ experiment: ctx.unit.attributes.experiment }))
  .exit('aWins', ctx => ctx.steps.conclude.winner === 'a')
  .exit('bWins', ctx => ctx.steps.conclude.winner === 'b')
  .exit('inconclusive');

const experiments = H.lane('experiments', Experiment)
  .supply(H.operator)
  .store(store)
  .handler(runExperiment, { exits: { aWins: AWins, bWins: BWins, inconclusive: Inconclusive } })
  .retry({ maxAttempts: 2, exhausted: MeasurementBroken });

export const inconclusiveShare = (metrics: Metrics) => {
  const outcomes = metrics.outcomes({ of: experiments, window: { lastDays: 365 } });
  return {
    share: outcomes.terminal === 0 ? 0 : outcomes.of(Inconclusive) / outcomes.terminal,
    samples: outcomes.terminal,
  };
};

const TenancyAttrs = z.object({ tenantId: z.string(), customer: z.string() });
const DueForReview = H.state('DueForReview', 'pending');
const Customer = H.state('Customer', 'waiting');
const Suspended = H.state('Suspended', 'waiting');
const Churned = H.terminal('Churned', 'neutral');

const Tenancy = H.kind('Tenancy')
  .attributes(TenancyAttrs)
  .states(DueForReview, Customer, Suspended, Churned)
  .key(attrs => attrs.tenantId)
  .initial(DueForReview);

const accountManager = H.role('account-manager').intents('read').instructions('Summarise a tenant month for an upsell decision.');
const accountManagerSeat = H.seat('account-manager').role(accountManager).model(sonnet).pool(pool);
const tenancySummary = H.call('tenancy-summary', accountManagerSeat);

const usageReview = H.command('usage-review')
  .input(z.object({ tenantId: z.string() }))
  .argv(input => ['./tenancy/usage-review', input.tenantId])
  .output(z.object({ seats: z.number(), monthlySpendUsd: z.number(), trend: z.string() }))
  .runner(runner);

const upsellDecision = H.halt('upsell-decision').decision(z.object({ upsell: z.boolean(), note: z.string() }));

const monthlyReview = H.flow('monthly-review')
  .input(TenancyAttrs)
  .step('usage', usageReview, ctx => ({ tenantId: ctx.unit.attributes.tenantId }))
  .step('summary', tenancySummary, ctx => ({
    text: `Summarise ${ctx.unit.attributes.customer}: ${ctx.steps.usage.seats} seats, $${ctx.steps.usage.monthlySpendUsd} per month, trend ${ctx.steps.usage.trend}.`,
  }))
  .halt('upsell', upsellDecision, { ask: ctx => `Upsell ${ctx.unit.attributes.customer}?\n\n${ctx.steps.summary}` })
  .exit('reviewed');

const reviewDue = H.signal('review-due');
const suspend = H.signal('suspend');
const reinstate = H.signal('reinstate');
const churn = H.signal('churn');

const tenancies = H.lane('tenancies', Tenancy)
  .supply(H.operator)
  .store(store)
  .handler(monthlyReview, { exits: { reviewed: Customer } })
  .retry({ maxAttempts: 3, backoff: 'exponential', initialDelayMs: 600000, exhausted: Customer })
  .on(reviewDue, { enter: DueForReview })
  .on(suspend, { enter: Suspended })
  .on(reinstate, { enter: Customer })
  .on(churn, { enter: Churned });

const monthlyTenancyReview = H.trigger('monthly-tenancy-review')
  .on(H.when.timer(tenancies, {
    at: unit => (unit.state === Customer ? H.nextTime('09:00', { after: unit.enteredAt, on: 1 }) : undefined),
  }))
  .signal(reviewDue, tenancies, event => ({ key: event.unit.key, payload: {} }));

const NegotiationAttrs = z.object({
  negotiationId: z.string(),
  vendor: z.string(),
  item: z.string(),
  expiresAt: z.string(),
  vendorOffers: z.array(z.string()),
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
  .key(attrs => attrs.negotiationId)
  .initial(Drafting);

const negotiator = H.role('negotiator').intents('read').instructions('Draft the next move in a procurement negotiation.');
const negotiatorSeat = H.seat('negotiator').role(negotiator).model(sonnet).pool(pool);
const draftMove = H.call('draft-move', negotiatorSeat).output(z.object({ move: z.enum(['offer', 'accept', 'walkAway']), offer: z.string() }));

const sendMove = H.command('send-move')
  .input(z.object({ negotiationId: z.string(), move: z.string(), offer: z.string() }))
  .argv(input => ['./procurement/send', input.negotiationId, input.move, input.offer])
  .runner(runner);

const negotiationRound = H.flow('negotiation-round')
  .input(NegotiationAttrs)
  .step('draft', draftMove, ctx => ({
    text: `Negotiate ${ctx.unit.attributes.item} with ${ctx.unit.attributes.vendor}. Vendor offers so far:\n${ctx.unit.attributes.vendorOffers.join('\n')}`,
  }))
  .step('send', sendMove, ctx => ({ negotiationId: ctx.unit.attributes.negotiationId, move: ctx.steps.draft.move, offer: ctx.steps.draft.offer }), {
    afterCrash: 'park',
  })
  .exit('agreed', ctx => ctx.steps.draft.move === 'accept')
  .exit('walkedAway', ctx => ctx.steps.draft.move === 'walkAway')
  .exit('offered');

const vendorReplied = H.signal('vendor-replied').payload(z.object({ offer: z.string() }));
const vendorAccepted = H.signal('vendor-accepted');
const vendorWalkedAway = H.signal('vendor-walked-away');
const negotiationExpired = H.signal('negotiation-expired');

const VendorEvent = z.discriminatedUnion('type', [
  z.object({ type: z.literal('reply'), negotiationId: z.string(), offer: z.string() }),
  z.object({ type: z.literal('accepted'), negotiationId: z.string() }),
  z.object({ type: z.literal('walkedAway'), negotiationId: z.string() }),
]);

const vendorEvents = webhook.json('vendor-events', {
  port: H.slot.port(2),
  path: '/vendor',
  secret: H.env('VENDOR_WEBHOOK_SECRET'),
  payload: VendorEvent,
});

const negotiations = H.lane('negotiations', Negotiation)
  .supply(H.operator)
  .supply(vendorEvents, (event, to) => {
    if (event.type === 'reply') return to.signal(vendorReplied, event.negotiationId, { offer: event.offer });
    if (event.type === 'accepted') return to.signal(vendorAccepted, event.negotiationId, {});
    return to.signal(vendorWalkedAway, event.negotiationId, {});
  })
  .store(store)
  .handler(negotiationRound, { exits: { offered: AwaitingVendor, agreed: Agreed, walkedAway: WalkedAwayByUs } })
  .retry({ maxAttempts: 3, backoff: 'exponential', initialDelayMs: 60000, exhausted: Stalled })
  .on(vendorReplied, { update: (attrs, payload) => ({ ...attrs, vendorOffers: [...attrs.vendorOffers, payload.offer] }), enter: Drafting })
  .on(vendorAccepted, { enter: Agreed })
  .on(vendorWalkedAway, { enter: WalkedAwayByThem })
  .on(negotiationExpired, { enter: Expired });

const negotiationExpiry = H.trigger('negotiation-expiry')
  .on(H.when.timer(negotiations, { at: unit => new Date(unit.attributes.expiresAt) }))
  .signal(negotiationExpired, negotiations, event => ({ key: event.unit.key, payload: {} }));

export const harness = H.harness('hostile-lifecycles')
  .ledger(sqlite.ledger({ path: '.harness/ledger.db' }))
  .lanes(experiments, tenancies, negotiations)
  .triggers(monthlyTenancyReview, negotiationExpiry)
  .scheduler(H.scheduler('lifecycles').standard(negotiations, tenancies, experiments))
  .clients(
    http.controlApi('operations', {
      port: H.slot.port(1),
      token: H.env('CONTROL_API_TOKEN'),
      grants: [H.ops.workRead, H.ops.workCreate, H.ops.workSignal, H.ops.resolve(upsellDecision), H.ops.attemptsRecover, H.ops.telemetryRead],
    }),
  )
  .observers(markdown.board({ path: 'BOARD.md' }));
