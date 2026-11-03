import { H } from 'harness-dsl';
import { z } from 'zod';
import { anthropic } from 'harness-dsl/anthropic';
import { claudeCode } from 'harness-dsl/claude-code';
import { local } from 'harness-dsl/local';
import { markdown } from 'harness-dsl/markdown';
import { sqlite } from 'harness-dsl/sqlite';
import { webhook } from 'harness-dsl/webhook';

const runner = local.runner('local');
const store = sqlite.store({ path: 'lifecycles/units.db' });
const apiAccount = anthropic.account('business', { apiKey: H.env('ANTHROPIC_API_KEY') });
const sonnet = anthropic.model('sonnet', { id: 'claude-sonnet-4-5' });
const pool = H.pool('business').accounts(apiAccount);

const ExperimentScheduled = H.state('ExperimentScheduled', 'pending');
const Sampling = H.state('Sampling', 'active');
const BetweenSamples = H.state('BetweenSamples', 'waiting');
const Deciding = H.state('Deciding', 'active');
const ExperimentStalled = H.state('ExperimentStalled', 'waiting');
const AWins = H.terminal('AWins', 'neutral');
const BWins = H.terminal('BWins', 'neutral');
const Inconclusive = H.terminal('Inconclusive', 'neutral');

const experimentAttrs = z.object({ name: z.string(), metric: z.string() });

const Experiment = H.kind('Experiment')
  .attributes(experimentAttrs)
  .states(ExperimentScheduled, Sampling, BetweenSamples, Deciding, ExperimentStalled, AWins, BWins, Inconclusive)
  .key(experiment => experiment.name)
  .initial(ExperimentScheduled)
  .onAttemptFailed(ExperimentStalled);

const sampleExperiment = H.command('sampleExperiment')
  .input(z.object({ name: z.string(), metric: z.string() }))
  .argv(input => ['experiment-sample', input.name, input.metric])
  .output(z.object({ a: z.number(), b: z.number() }))
  .runner(runner);

const decideExperiment = H.command('decideExperiment')
  .input(z.object({ name: z.string() }))
  .argv(input => ['experiment-decide', input.name])
  .output(z.object({ winner: z.enum(['A', 'B', 'none']) }))
  .runner(runner);

const experimentFlow = H.flow('experiment')
  .input(experimentAttrs)
  .loop('hourly', flow => flow
    .step('sample', sampleExperiment, ctx => ({
      name: ctx.unit.attributes.name,
      metric: ctx.unit.attributes.metric,
    }), { retry: { maxAttempts: 3, initialDelayMs: 60000 } })
    .wait('nextHour', { ms: 3600000 }), { max: 336 })
  .step('decide', decideExperiment, ctx => ({ name: ctx.unit.attributes.name }))
  .exit('aWins', ctx => ctx.steps.decide.winner === 'A')
  .exit('bWins', ctx => ctx.steps.decide.winner === 'B')
  .exit('inconclusive');

const experiments = H.lane('experiments', Experiment)
  .supply(H.operator)
  .store(store)
  .handler(experimentFlow, {
    exits: { aWins: AWins, bWins: BWins, inconclusive: Inconclusive },
    during: { sample: Sampling, nextHour: BetweenSamples, decide: Deciding },
  });

const Customer = H.state('Customer', 'waiting');
const DueForReview = H.state('DueForReview', 'pending');
const TenancyReviewing = H.state('TenancyReviewing', 'active');
const AwaitingUpsellDecision = H.state('AwaitingUpsellDecision', 'waiting');
const Suspended = H.state('Suspended', 'waiting');
const Churned = H.terminal('Churned', 'neutral');

const tenancyAttrs = z.object({ customerId: z.string(), plan: z.string() });

const Tenancy = H.kind('Tenancy')
  .attributes(tenancyAttrs)
  .states(Customer, DueForReview, TenancyReviewing, AwaitingUpsellDecision, Suspended, Churned)
  .key(tenancy => tenancy.customerId)
  .initial(Customer)
  .onAttemptFailed(Customer);

const reviewDue = H.signal('reviewDue');
const suspend = H.signal('suspend');
const reinstate = H.signal('reinstate');
const churn = H.signal('churn');

const accountReviewer = H.role('accountReviewer')
  .intents('read')
  .instructions('Summarise the customer month: usage, trend, risks, and the case for or against an upsell.');

const usageReport = H.command('usageReport')
  .input(z.object({ customerId: z.string() }))
  .argv(input => ['usage-report', input.customerId])
  .output(z.object({ seats: z.number(), usageUsd: z.number(), trend: z.string() }))
  .runner(runner);

const reviewAgent = H.agent('accountReviewer')
  .role(accountReviewer)
  .model(sonnet)
  .pool(pool)
  .output(z.object({ summary: z.string(), upsellCase: z.string() }));

const tenancyFlow = H.flow('monthlyReview')
  .input(tenancyAttrs)
  .step('usage', usageReport, ctx => ({ customerId: ctx.unit.attributes.customerId }))
  .step('summary', reviewAgent, ctx => ({
    task: `Customer ${ctx.unit.attributes.customerId} on ${ctx.unit.attributes.plan}: ${ctx.steps.usage.seats} seats, $${ctx.steps.usage.usageUsd}, trend ${ctx.steps.usage.trend}.`,
  }))
  .halt('decision', {
    ask: ctx => `Upsell ${ctx.unit.attributes.customerId}?\n${ctx.steps.summary.summary}\nCase: ${ctx.steps.summary.upsellCase}`,
    decision: z.object({ upsell: z.boolean(), notes: z.string() }),
  })
  .exit('reviewed');

const billing = webhook.json('billing', {
  port: H.slot.port(1),
  path: '/billing',
  secret: H.env('BILLING_WEBHOOK_SECRET'),
  payload: z.object({
    customerId: z.string(),
    plan: z.string(),
    event: z.enum(['signedUp', 'suspended', 'reinstated', 'churned']),
  }),
});

const tenancies = H.lane('tenancies', Tenancy)
  .supply(billing, (event, to) => {
    if (event.event === 'signedUp') return to.create({ customerId: event.customerId, plan: event.plan });
    if (event.event === 'suspended') return to.signal(suspend, event.customerId, {});
    if (event.event === 'reinstated') return to.signal(reinstate, event.customerId, {});
    return to.signal(churn, event.customerId, {});
  })
  .supply(H.clock('monthly').at('09:00', { on: 1, tz: 'Europe/London' }), (tick, to) =>
    to.signal(reviewDue, unit => unit.state === 'Customer', {}))
  .store(store)
  .handler(tenancyFlow, {
    exits: { reviewed: Customer },
    during: { usage: TenancyReviewing, summary: TenancyReviewing, decision: AwaitingUpsellDecision },
  })
  .on(reviewDue, { enter: DueForReview })
  .on(suspend, { enter: Suspended })
  .on(reinstate, { enter: Customer })
  .on(churn, { enter: Churned });

const NegotiationOpen = H.state('NegotiationOpen', 'pending');
const Drafting = H.state('Drafting', 'active');
const Sending = H.state('Sending', 'active');
const AwaitingVendor = H.state('AwaitingVendor', 'waiting');
const NeedsAttention = H.state('NeedsAttention', 'waiting');
const Agreed = H.terminal('Agreed', 'success');
const WalkedAwayByUs = H.terminal('WalkedAwayByUs', 'neutral');
const WalkedAwayByThem = H.terminal('WalkedAwayByThem', 'neutral');
const Expired = H.terminal('Expired', 'failure');

const negotiationAttrs = z.object({
  id: z.string(),
  vendor: z.string(),
  item: z.string(),
  ceilingUsd: z.number(),
  expiresAt: z.string(),
  lastReply: z.string(),
  round: z.number(),
});

const Negotiation = H.kind('Negotiation')
  .attributes(negotiationAttrs)
  .states(NegotiationOpen, Drafting, Sending, AwaitingVendor, NeedsAttention, Agreed, WalkedAwayByUs, WalkedAwayByThem, Expired)
  .key(negotiation => negotiation.id)
  .initial(NegotiationOpen);

const vendorCountered = H.signal('vendorCountered').payload(z.object({ message: z.string() }));
const vendorAccepted = H.signal('vendorAccepted');
const vendorWalkedAway = H.signal('vendorWalkedAway');
const expire = H.signal('expire');

const negotiator = H.role('negotiator')
  .intents('read')
  .instructions('Draft the next offer. Never exceed the ceiling. Walk away when the vendor cannot meet it.');

const negotiatorAgent = H.agent('negotiator')
  .role(negotiator)
  .model(sonnet)
  .pool(pool)
  .output(z.object({ offerUsd: z.number(), message: z.string(), walkAway: z.boolean() }));

const sendOffer = H.command('sendOffer')
  .input(z.object({ id: z.string(), vendor: z.string(), message: z.string(), offerUsd: z.number() }))
  .argv(input => ['procurement-send', input.id, input.vendor, String(input.offerUsd), input.message])
  .runner(runner);

const negotiationRound = H.flow('negotiationRound')
  .input(negotiationAttrs)
  .step('draft', negotiatorAgent, ctx => ({
    task: `Round ${ctx.unit.attributes.round} with ${ctx.unit.attributes.vendor} for ${ctx.unit.attributes.item}. Ceiling $${ctx.unit.attributes.ceilingUsd}. Their last reply: ${ctx.unit.attributes.lastReply}`,
  }))
  .exit('walkAway', ctx => ctx.steps.draft.walkAway)
  .step('send', sendOffer, ctx => ({
    id: ctx.unit.attributes.id,
    vendor: ctx.unit.attributes.vendor,
    message: ctx.steps.draft.message,
    offerUsd: ctx.steps.draft.offerUsd,
  }), { afterCrash: 'park' })
  .exit('offerSent');

const vendorReplies = webhook.json('vendorReplies', {
  port: H.slot.port(2),
  path: '/vendor-replies',
  secret: H.env('VENDOR_WEBHOOK_SECRET'),
  payload: z.object({
    negotiationId: z.string(),
    kind: z.enum(['counter', 'accepted', 'walkedAway']),
    message: z.string(),
  }),
});

const negotiations = H.lane('negotiations', Negotiation)
  .supply(H.operator)
  .supply(vendorReplies, (reply, to) => {
    if (reply.kind === 'accepted') return to.signal(vendorAccepted, reply.negotiationId, {});
    if (reply.kind === 'walkedAway') return to.signal(vendorWalkedAway, reply.negotiationId, {});
    return to.signal(vendorCountered, reply.negotiationId, { message: reply.message });
  })
  .store(store)
  .handler(negotiationRound, {
    exits: { walkAway: WalkedAwayByUs, offerSent: AwaitingVendor },
    during: { draft: Drafting, send: Sending },
  })
  .retry({ maxAttempts: 3, initialDelayMs: 600000, exhausted: NeedsAttention })
  .on(vendorCountered, {
    update: (attrs, payload) => ({ ...attrs, lastReply: payload.message, round: attrs.round + 1 }),
    enter: NegotiationOpen,
  })
  .on(vendorAccepted, { enter: Agreed })
  .on(vendorWalkedAway, { enter: WalkedAwayByThem })
  .on(expire, { enter: Expired });

const negotiationExpiry = H.trigger('negotiationExpiry')
  .on(H.when.timer(negotiations, { at: unit => new Date(unit.attributes.expiresAt) }))
  .signal(expire, negotiations, event => ({ key: event.unit.key, payload: {} }));

const supervisor = claudeCode.supervisor('supervisor', {
  grants: [
    H.ops.workRead,
    H.ops.workCreate,
    H.ops.workSignal,
    H.ops.workCancel,
    H.ops.blockersResolve,
    H.ops.telemetryRead,
  ],
});

export const lifecycles = H.harness('lifecycles')
  .ledger(sqlite.ledger({ path: 'lifecycles/ledger.db' }))
  .lanes(experiments, tenancies, negotiations)
  .triggers(negotiationExpiry)
  .scheduler(H.scheduler('lifecycles')
    .priority(negotiations, tenancies, experiments)
    .admit(experiments, ctx => {
      const history = ctx.metrics.outcomes({ of: experiments, window: { lastDays: 180 } });
      const inconclusiveShare = history.terminal === 0 ? 0 : history.byState.Inconclusive / history.terminal;
      const limit = history.terminal >= 10 && inconclusiveShare > 0.5 ? 1 : 3;
      return ctx.count(experiments, 'active') < limit;
    }))
  .clients(supervisor)
  .observers(markdown.board({ path: 'lifecycles/BOARD.md' }), markdown.telemetry({ path: 'lifecycles/TELEMETRY.md' }));
