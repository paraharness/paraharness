import { H } from 'harness-dsl';
import { z } from 'zod';
import { sqlite } from 'harness-dsl/sqlite';
import { anthropic } from 'harness-dsl/anthropic';
import { claudeCode } from 'harness-dsl/claude-code';
import { webhook } from 'harness-dsl/webhook';
import { local } from 'harness-dsl/local';
import { markdown } from 'harness-dsl/markdown';

const unitStore = sqlite.store({ path: './.harness/units.sqlite' });
const apiAccount = anthropic.account('procurement-api', {
  apiKey: H.env('ANTHROPIC_API_KEY'),
  quota: sqlite.quota('procurement-api', { path: './.harness/quota.sqlite' }),
});
const apiPool = H.pool('api-pool').accounts(apiAccount);
const sonnet = anthropic.model('sonnet', { id: 'claude-sonnet-4-5' });
const runner = local.runner('local').slots(4);

const Planned = H.state('Planned', 'pending');
const AWins = H.terminal('AWins', 'success');
const BWins = H.terminal('BWins', 'success');
const Inconclusive = H.terminal('Inconclusive', 'neutral');
const MeasurementBroken = H.terminal('MeasurementBroken', 'failure');

const experimentAttrs = z.object({ key: z.string(), metric: z.string(), days: z.number().int() });

const Experiment = H.kind('Experiment')
  .attributes(experimentAttrs)
  .states(Planned, AWins, BWins, Inconclusive, MeasurementBroken)
  .key(a => a.key)
  .initial(Planned);

const measure = H.command('measure-experiment')
  .input(z.object({ key: z.string(), metric: z.string() }))
  .argv(i => ['./experiments/measure', i.key, i.metric])
  .runner(runner);

const conclude = H.command('conclude-experiment')
  .input(z.object({ key: z.string() }))
  .argv(i => ['./experiments/conclude', i.key])
  .output(z.object({ winner: z.enum(['a', 'b', 'none']) }))
  .runner(runner);

const runExperiment = H.flow('run-experiment')
  .input(experimentAttrs)
  .loop(
    'hours',
    hour =>
      hour
        .step('measure', measure, ctx => ({ key: ctx.unit.attributes.key, metric: ctx.unit.attributes.metric }), {
          retry: { maxAttempts: 3, backoff: 'exponential', initialDelayMs: 60_000 },
        })
        .wait('nextHour', { ms: 3_600_000 }),
    { max: ctx => ctx.unit.attributes.days * 24 },
  )
  .step('conclude', conclude, ctx => ({ key: ctx.unit.attributes.key }))
  .exit('aWins', ctx => ctx.steps.conclude.winner === 'a')
  .exit('bWins', ctx => ctx.steps.conclude.winner === 'b')
  .exit('inconclusive');

const experiments = H.lane('experiments', Experiment)
  .supply(H.operator)
  .store(unitStore)
  .handler(runExperiment, {
    ends: { aWins: AWins, bWins: BWins, inconclusive: Inconclusive },
    retry: { maxAttempts: 2, backoff: 'fixed', initialDelayMs: 600_000, exhausted: MeasurementBroken },
  });

const Customer = H.state('Customer', 'waiting');
const ReviewDue = H.state('ReviewDue', 'pending');
const Suspended = H.state('Suspended', 'waiting');
const ReviewStalled = H.state('ReviewStalled', 'waiting');
const Churned = H.terminal('Churned', 'neutral');

const tenancyAttrs = z.object({ customerId: z.string(), plan: z.string() });

const Tenancy = H.kind('Tenancy')
  .attributes(tenancyAttrs)
  .states(Customer, ReviewDue, Suspended, ReviewStalled, Churned)
  .key(a => a.customerId)
  .initial(Customer);

const monthlyReview = H.signal('monthly-review');
const suspend = H.signal('suspend').payload(z.object({ reason: z.string() }));
const reinstate = H.signal('reinstate');
const churn = H.signal('churn');

const usageReport = H.command('usage-report')
  .input(z.object({ customerId: z.string() }))
  .argv(i => ['./billing/usage', i.customerId])
  .output(z.object({ seats: z.number(), spendUsd: z.number() }))
  .runner(runner);

const accountReviewer = H.seat('account-reviewer')
  .role(H.role('account-reviewer').intents('read'))
  .model(sonnet)
  .pool(apiPool);

const upsellDecision = H.halt('upsell-decision').decision(z.object({ upsell: z.boolean(), note: z.string() }));

const monthlyEvaluation = H.flow('monthly-evaluation')
  .input(tenancyAttrs)
  .step('usage', usageReport, ctx => ({ customerId: ctx.unit.attributes.customerId }))
  .step('summary', accountReviewer, ctx => ({
    task: `Summarize this month for ${ctx.unit.attributes.customerId} on ${ctx.unit.attributes.plan}: ${ctx.steps.usage.seats} seats, $${ctx.steps.usage.spendUsd} spent.`,
  }))
  .halt('decide', upsellDecision, { ask: ctx => `Upsell ${ctx.unit.attributes.customerId}?\n\n${ctx.steps.summary}` })
  .exit('upsell', ctx => ctx.steps.decide.upsell)
  .exit('hold');

const billingEvents = webhook.json('billing-events', {
  port: H.slot.port(1),
  path: '/billing',
  secret: H.env('BILLING_WEBHOOK_SECRET'),
  payload: z.object({
    type: z.enum(['signed', 'suspended', 'reinstated', 'churned']),
    customerId: z.string(),
    plan: z.string(),
    reason: z.string(),
  }),
});

const tenancies = H.lane('tenancies', Tenancy)
  .supply(billingEvents, (e, to) => {
    switch (e.type) {
      case 'signed':
        return to.create({ customerId: e.customerId, plan: e.plan });
      case 'suspended':
        return to.signal(suspend, e.customerId, { reason: e.reason });
      case 'reinstated':
        return to.signal(reinstate, e.customerId, {});
      case 'churned':
        return to.signal(churn, e.customerId, {});
    }
  })
  .supply(H.clock('first-of-month').at('09:00', { on: 1, tz: 'UTC' }), (_tick, to) =>
    to.signal(monthlyReview, { in: [Customer, ReviewStalled] }, {}),
  )
  .store(unitStore)
  .handler(monthlyEvaluation, {
    rests: { upsell: Customer, hold: Customer },
    retry: { maxAttempts: 3, backoff: 'exponential', initialDelayMs: 3_600_000, exhausted: ReviewStalled },
  })
  .on(monthlyReview, { enter: ReviewDue })
  .on(suspend, { enter: Suspended })
  .on(reinstate, { enter: Customer })
  .on(churn, { enter: Churned });

const Opening = H.state('Opening', 'pending');
const AwaitingVendor = H.state('AwaitingVendor', 'waiting');
const VendorReplied = H.state('VendorReplied', 'pending');
const Stalled = H.state('Stalled', 'waiting');
const Agreed = H.terminal('Agreed', 'success');
const WalkedAwayByUs = H.terminal('WalkedAwayByUs', 'neutral');
const WalkedAwayByThem = H.terminal('WalkedAwayByThem', 'failure');
const Expired = H.terminal('Expired', 'failure');

const negotiationAttrs = z.object({
  key: z.string(),
  vendor: z.string(),
  item: z.string(),
  ceilingUsd: z.number(),
  expiresAt: z.string(),
  lastVendorMessage: z.string(),
  rounds: z.number().int(),
});

const Negotiation = H.kind('Negotiation')
  .attributes(negotiationAttrs)
  .states(Opening, AwaitingVendor, VendorReplied, Stalled, Agreed, WalkedAwayByUs, WalkedAwayByThem, Expired)
  .key(a => a.key)
  .initial(Opening);

const negotiator = H.seat('negotiator')
  .role(H.role('negotiator').intents('read').instructions('Never offer above the ceiling.'))
  .model(sonnet)
  .pool(apiPool)
  .output(z.object({ action: z.enum(['offer', 'accept', 'walkAway']), offerUsd: z.number(), message: z.string() }));

const sendToVendor = H.command('send-to-vendor')
  .input(z.object({ vendor: z.string(), message: z.string() }))
  .argv(i => ['./procurement/send', i.vendor, i.message])
  .runner(runner);

const negotiationRound = H.flow('negotiation-round')
  .input(negotiationAttrs)
  .step('draft', negotiator, ctx => ({
    task: `Round ${ctx.unit.attributes.rounds + 1} with ${ctx.unit.attributes.vendor} for ${ctx.unit.attributes.item}. Their last message: ${ctx.unit.attributes.lastVendorMessage}. Ceiling $${ctx.unit.attributes.ceilingUsd}.`,
  }))
  .step('send', sendToVendor, ctx => ({ vendor: ctx.unit.attributes.vendor, message: ctx.steps.draft.message }), {
    afterCrash: 'park',
  })
  .exit('agreed', ctx => ctx.steps.draft.action === 'accept')
  .exit('walkAway', ctx => ctx.steps.draft.action === 'walkAway')
  .exit('offered');

const vendorCountered = H.signal('vendor-countered').payload(z.object({ message: z.string() }));
const vendorAccepted = H.signal('vendor-accepted');
const vendorWalkedAway = H.signal('vendor-walked-away');
const deadlinePassed = H.signal('deadline-passed');
const resumeNegotiation = H.signal('resume-negotiation');

const vendorReplies = webhook.json('vendor-replies', {
  port: H.slot.port(2),
  path: '/vendor',
  secret: H.env('VENDOR_WEBHOOK_SECRET'),
  payload: z.object({
    negotiation: z.string(),
    type: z.enum(['counter', 'accepted', 'walkedAway']),
    message: z.string(),
  }),
});

const negotiations = H.lane('negotiations', Negotiation)
  .supply(H.operator)
  .supply(vendorReplies, (e, to) => {
    switch (e.type) {
      case 'counter':
        return to.signal(vendorCountered, e.negotiation, { message: e.message });
      case 'accepted':
        return to.signal(vendorAccepted, e.negotiation, {});
      case 'walkedAway':
        return to.signal(vendorWalkedAway, e.negotiation, {});
    }
  })
  .store(unitStore)
  .handler(negotiationRound, {
    ends: { agreed: Agreed, walkAway: WalkedAwayByUs },
    rests: { offered: AwaitingVendor },
    retry: { maxAttempts: 3, backoff: 'exponential', initialDelayMs: 300_000, exhausted: Stalled },
  })
  .on(vendorCountered, {
    update: (a, p) => ({ ...a, lastVendorMessage: p.message, rounds: a.rounds + 1 }),
    enter: VendorReplied,
  })
  .on(vendorAccepted, { enter: Agreed })
  .on(vendorWalkedAway, { enter: WalkedAwayByThem })
  .on(deadlinePassed, { enter: Expired })
  .on(resumeNegotiation, { enter: VendorReplied });

const negotiationExpiry = H.trigger('negotiation-expiry')
  .on(H.when.timer(negotiations, { at: unit => new Date(unit.attributes.expiresAt) }))
  .signal(deadlinePassed, negotiations, e => ({ key: e.unit.key, payload: {} }));

const scheduler = H.scheduler('procurement-scheduler')
  .priority(negotiations, tenancies, experiments)
  .wip(experiments, 5)
  .admit(experiments, ctx => {
    const record = ctx.metrics.outcomes({ of: experiments, window: { lastDays: 90 } });
    return record.terminal < 10 || record.byState.Inconclusive / record.terminal < 0.5;
  });

const operatorDesk = claudeCode.supervisor('procurement-desk').client('procurement-control', {
  port: H.slot.port(3),
  grants: [
    H.ops.workRead,
    H.ops.workCreate,
    H.ops.workSignal,
    H.ops.attemptsRecover,
    H.ops.resolve(upsellDecision),
    H.ops.telemetryRead,
  ],
});

export const harness = H.harness('lifecycles')
  .ledger(sqlite.ledger({ path: './.harness/ledger.sqlite' }))
  .lanes(experiments, tenancies, negotiations)
  .triggers(negotiationExpiry)
  .scheduler(scheduler)
  .clients(operatorDesk)
  .observers(markdown.board({ path: './.harness/board.md' }));
