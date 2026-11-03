import { z } from 'zod';
import { H } from 'harness-dsl';
import { sqlite } from 'harness-dsl/sqlite';
import { anthropic } from 'harness-dsl/anthropic';
import { claudeCode } from 'harness-dsl/claude-code';
import { webhook } from 'harness-dsl/webhook';
import { local } from 'harness-dsl/local';
import { markdown } from 'harness-dsl/markdown';

const apiAccount = anthropic.account('api', { apiKey: H.env('ANTHROPIC_API_KEY') });
const pool = H.pool('api').accounts(apiAccount);
const strong = anthropic.model('sonnet', { id: 'claude-sonnet-4-5' });
const box = local.runner('ops-box').slots(4);
const store = sqlite.store({ path: '.harness/units.sqlite' });

const experimentAttributes = z.object({
  experiment: z.string(),
  variantA: z.string(),
  variantB: z.string(),
});

const Proposed = H.state('Proposed', 'pending');
const Observing = H.state('Observing', 'active');
const Analysing = H.state('Analysing', 'active');
const AWins = H.terminal('AWins', 'success');
const BWins = H.terminal('BWins', 'success');
const Inconclusive = H.terminal('Inconclusive', 'neutral');
const Withdrawn = H.terminal('Withdrawn', 'neutral');

const Experiment = H.kind('Experiment')
  .attributes(experimentAttributes)
  .states(Proposed, Observing, Analysing, AWins, BWins, Inconclusive, Withdrawn)
  .key(experiment => experiment.experiment)
  .initial(Proposed)
  .onCancelled(Withdrawn);

const measure = H.command('measure-experiment')
  .input(z.object({ experiment: z.string() }))
  .argv(input => ['./experiments/measure', input.experiment])
  .output(z.object({ a: z.number(), b: z.number() }))
  .runner(box);

const analyse = H.command('analyse-experiment')
  .input(z.object({ experiment: z.string() }))
  .argv(input => ['./experiments/analyse', input.experiment])
  .output(z.object({ winner: z.enum(['a', 'b', 'none']) }))
  .runner(box);

const experimentFlow = H.flow('run-experiment')
  .input(experimentAttributes)
  .loop(
    'observe',
    hour =>
      hour
        .step('measure', measure, ctx => ({ experiment: ctx.unit.attributes.experiment }))
        .wait('nextHour', { ms: 3_600_000 }),
    { max: 24 * 14 },
  )
  .step('analyse', analyse, ctx => ({ experiment: ctx.unit.attributes.experiment }))
  .exit('aWins', ctx => ctx.steps.analyse.winner === 'a')
  .exit('bWins', ctx => ctx.steps.analyse.winner === 'b')
  .exit('inconclusive');

const experiments = H.lane('experiments', Experiment)
  .supply(H.operator)
  .store(store)
  .handler(experimentFlow, {
    exits: { aWins: AWins, bWins: BWins, inconclusive: Inconclusive },
    during: { observe: Observing, analyse: Analysing },
  });

const tenancyAttributes = z.object({ customerId: z.string(), plan: z.string() });

const DueForReview = H.state('DueForReview', 'pending');
const Reviewing = H.state('Reviewing', 'active');
const Current = H.state('Current', 'waiting');
const Suspended = H.state('Suspended', 'waiting');
const Churned = H.terminal('Churned', 'neutral');

const Tenancy = H.kind('Tenancy')
  .attributes(tenancyAttributes)
  .states(DueForReview, Reviewing, Current, Suspended, Churned)
  .key(tenancy => tenancy.customerId)
  .initial(DueForReview);

const reviewDue = H.signal('review-due');
const suspend = H.signal('suspend');
const reinstate = H.signal('reinstate');
const churn = H.signal('churn');

const usageReport = H.command('usage-report')
  .input(z.object({ customerId: z.string() }))
  .argv(input => ['./billing/usage', input.customerId])
  .output(z.object({ seats: z.number(), monthlyUsd: z.number(), trend: z.string() }))
  .runner(box);

const accountManager = H.role('account-manager')
  .intents('read')
  .instructions('Summarise the month of usage in plain language and say whether an upsell is warranted.');

const summaryAgent = H.agent('tenancy-summary')
  .role(accountManager)
  .model(strong)
  .pool(pool)
  .output(z.object({ summary: z.string() }));

const tenancyReview = H.flow('tenancy-review')
  .input(tenancyAttributes)
  .step('usage', usageReport, ctx => ({ customerId: ctx.unit.attributes.customerId }))
  .step('summary', summaryAgent, ctx => ({
    task: `Customer ${ctx.unit.attributes.customerId} on ${ctx.unit.attributes.plan}: ${ctx.steps.usage.seats} seats, $${ctx.steps.usage.monthlyUsd}/month, trend ${ctx.steps.usage.trend}.`,
  }))
  .halt('upsell', {
    ask: ctx => `Upsell ${ctx.unit.attributes.customerId}?\n\n${ctx.steps.summary.summary}`,
    decision: z.object({ upsell: z.boolean(), note: z.string() }),
  })
  .exit('reviewed');

const billingEvents = webhook.json('billing-events', {
  port: H.slot.port(1),
  path: '/billing',
  secret: H.env('BILLING_WEBHOOK_SECRET'),
  payload: z.object({
    type: z.enum(['signup', 'suspended', 'reinstated', 'churned']),
    customerId: z.string(),
    plan: z.string(),
  }),
});

const tenancies = H.lane('tenancies', Tenancy)
  .supply(billingEvents, (event, to) => {
    if (event.type === 'signup') return to.create({ customerId: event.customerId, plan: event.plan });
    if (event.type === 'suspended') return to.signal(suspend, event.customerId, {});
    if (event.type === 'reinstated') return to.signal(reinstate, event.customerId, {});
    return to.signal(churn, event.customerId, {});
  })
  .supply(H.clock('monthly-review').at('09:00', { on: 1 }), (tick, to) =>
    to.signal(reviewDue, unit => unit.state === 'Current', {}),
  )
  .store(store)
  .handler(tenancyReview, {
    exits: { reviewed: Current },
    during: { usage: Reviewing, summary: Reviewing, upsell: Reviewing },
  })
  .on(reviewDue, { enter: DueForReview })
  .on(suspend, { enter: Suspended })
  .on(reinstate, { enter: Current })
  .on(churn, { enter: Churned });

const negotiationAttributes = z.object({
  vendor: z.string(),
  item: z.string(),
  targetPrice: z.number(),
  expiresAt: z.string(),
  round: z.number(),
  lastVendorMessage: z.string(),
});

const Drafting = H.state('Drafting', 'pending');
const Negotiating = H.state('Negotiating', 'active');
const AwaitingVendor = H.state('AwaitingVendor', 'waiting');
const Agreed = H.terminal('Agreed', 'success');
const WalkedAwayByUs = H.terminal('WalkedAwayByUs', 'neutral');
const WalkedAwayByThem = H.terminal('WalkedAwayByThem', 'neutral');
const Expired = H.terminal('Expired', 'neutral');

const Negotiation = H.kind('Negotiation')
  .attributes(negotiationAttributes)
  .states(Drafting, Negotiating, AwaitingVendor, Agreed, WalkedAwayByUs, WalkedAwayByThem, Expired)
  .key(negotiation => `${negotiation.vendor}/${negotiation.item}`)
  .initial(Drafting);

const vendorCountered = H.signal('vendor-countered').payload(z.object({ message: z.string() }));
const vendorAccepted = H.signal('vendor-accepted');
const vendorWalkedAway = H.signal('vendor-walked-away');
const expire = H.signal('expire');

const negotiator = H.role('negotiator')
  .intents('read')
  .instructions('Draft the next move in the procurement negotiation: a counter-offer, acceptance, or walking away.');

const negotiatorAgent = H.agent('negotiator')
  .role(negotiator)
  .model(strong)
  .pool(pool)
  .output(z.object({ move: z.enum(['offer', 'accept', 'walkAway']), message: z.string() }));

const sendToVendor = H.command('send-to-vendor')
  .input(z.object({ vendor: z.string(), message: z.string() }))
  .argv(input => ['./procurement/send', input.vendor, input.message])
  .runner(box);

const negotiationRound = H.flow('negotiation-round')
  .input(negotiationAttributes)
  .step('next', negotiatorAgent, ctx => ({
    task: `Round ${ctx.unit.attributes.round} with ${ctx.unit.attributes.vendor} for ${ctx.unit.attributes.item}, target $${ctx.unit.attributes.targetPrice}. Vendor said: ${ctx.unit.attributes.lastVendorMessage}`,
  }))
  .step('send', sendToVendor, ctx => ({ vendor: ctx.unit.attributes.vendor, message: ctx.steps.next.message }), {
    afterCrash: 'park',
  })
  .exit('agreed', ctx => ctx.steps.next.move === 'accept')
  .exit('walkedAway', ctx => ctx.steps.next.move === 'walkAway')
  .exit('offered');

const vendorReplies = webhook.json('vendor-replies', {
  port: H.slot.port(2),
  path: '/vendor',
  secret: H.env('VENDOR_WEBHOOK_SECRET'),
  payload: z.object({
    negotiation: z.string(),
    reply: z.enum(['counter', 'accept', 'walkAway']),
    message: z.string(),
  }),
});

const negotiations = H.lane('negotiations', Negotiation)
  .supply(H.operator)
  .supply(vendorReplies, (event, to) => {
    if (event.reply === 'counter') return to.signal(vendorCountered, event.negotiation, { message: event.message });
    if (event.reply === 'accept') return to.signal(vendorAccepted, event.negotiation, {});
    return to.signal(vendorWalkedAway, event.negotiation, {});
  })
  .store(store)
  .handler(negotiationRound, {
    exits: { agreed: Agreed, walkedAway: WalkedAwayByUs, offered: AwaitingVendor },
    during: { next: Negotiating, send: Negotiating },
  })
  .on(vendorCountered, {
    update: (attrs, payload) => ({ ...attrs, round: attrs.round + 1, lastVendorMessage: payload.message }),
    enter: Drafting,
  })
  .on(vendorAccepted, { enter: Agreed })
  .on(vendorWalkedAway, { enter: WalkedAwayByThem })
  .on(expire, { enter: Expired });

const negotiationExpiry = H.trigger('negotiation-expiry')
  .on(H.when.timer(negotiations, { at: unit => new Date(unit.attributes.expiresAt) }))
  .signal(expire, negotiations, event => ({ key: event.unit.key, payload: {} }));

const scheduler = H.scheduler('lifecycles')
  .priority(negotiations, tenancies, experiments)
  .admit(experiments, ctx => {
    const record = ctx.metrics.outcomes({ of: experiments, window: { lastDays: 180 } });
    if (record.terminal < 10) return true;
    const inconclusiveShare = record.byState.Inconclusive / record.terminal;
    return inconclusiveShare < 0.5 || ctx.active(experiments) === 0;
  });

const lifecycles = H.harness('lifecycles')
  .ledger(sqlite.ledger({ path: '.harness/ledger.sqlite' }))
  .lanes(experiments, tenancies, negotiations)
  .triggers(negotiationExpiry)
  .scheduler(scheduler)
  .clients(
    claudeCode.supervisor('lifecycle-supervisor', {
      grants: [H.ops.workRead, H.ops.workCreate, H.ops.workSignal, H.ops.workCancel, H.ops.blockersResolve, H.ops.telemetryRead],
    }),
  )
  .observers(markdown.board({ path: '.harness/board.md' }), markdown.telemetry({ path: '.harness/telemetry.md' }));

void lifecycles.start();
