import { z } from 'zod';
import { H } from 'harness-dsl';
import { anthropic } from 'harness-dsl/anthropic';
import { claudeCode } from 'harness-dsl/claude-code';
import { sqlite } from 'harness-dsl/sqlite';
import { local } from 'harness-dsl/local';
import { webhook } from 'harness-dsl/webhook';
import { markdown } from 'harness-dsl/markdown';

const unitStore = sqlite.store({ path: 'state/units.sqlite' });
const opsRunner = local.runner('ops-local');

const apiAccount = anthropic.account('lifecycles-api', { apiKey: H.env('ANTHROPIC_API_KEY') });
const summaryModel = anthropic.model('summary-model', { id: 'claude-sonnet-4-5' });
const negotiationModel = anthropic.model('negotiation-model', { id: 'claude-opus-4-1' });
const apiPool = H.pool('lifecycles-api').accounts(apiAccount).serves(summaryModel, negotiationModel);

const experimentSchema = z.object({
  experimentId: z.string(),
  hypothesis: z.string(),
  endsAt: z.string(),
});

const ExperimentQueued = H.state('ExperimentQueued', 'pending');
const Measuring = H.state('Measuring', 'active');
const BetweenMeasurements = H.state('BetweenMeasurements', 'waiting');
const Deciding = H.state('Deciding', 'active');
const AWins = H.terminal('AWins', 'success');
const BWins = H.terminal('BWins', 'success');
const Inconclusive = H.terminal('Inconclusive', 'neutral');
const ExperimentStopped = H.terminal('ExperimentStopped', 'neutral');

const Experiment = H.kind('Experiment')
  .attributes(experimentSchema)
  .states(ExperimentQueued, Measuring, BetweenMeasurements, Deciding, AWins, BWins, Inconclusive, ExperimentStopped)
  .key(experiment => experiment.experimentId)
  .initial(ExperimentQueued)
  .onCancelled(ExperimentStopped);

const measureVariants = H.command('measure-variants')
  .input(z.object({ experimentId: z.string() }))
  .argv(input => ['experiment-metrics', 'collect', input.experimentId])
  .output(z.object({ conversionsA: z.number(), conversionsB: z.number() }))
  .runner(opsRunner);

const decideExperiment = H.command('decide-experiment')
  .input(z.object({ experimentId: z.string() }))
  .argv(input => ['experiment-metrics', 'decide', input.experimentId])
  .output(z.object({ verdict: z.enum(['a', 'b', 'inconclusive']) }))
  .runner(opsRunner);

const experimentFlow = H.flow('run-experiment')
  .input(experimentSchema)
  .loop(
    'hourly',
    hour => hour
      .step('measure', measureVariants, ctx => ({ experimentId: ctx.unit.attributes.experimentId }), {
        retry: H.retry({ maxAttempts: 3, backoff: 'exponential', initialDelayMs: 30000 }),
      })
      .wait('nextHour', { ms: 3600000 }),
    {
      max: 24 * 14,
      until: ctx => ctx.now.getTime() >= Date.parse(ctx.unit.attributes.endsAt),
    },
  )
  .step('decide', decideExperiment, ctx => ({ experimentId: ctx.unit.attributes.experimentId }))
  .exit('aWins', ctx => ctx.steps.decide.verdict === 'a')
  .exit('bWins', ctx => ctx.steps.decide.verdict === 'b')
  .exit('inconclusive');

const experiments = H.lane('experiments', Experiment)
  .supply(H.operator)
  .store(unitStore)
  .handler(experimentFlow, {
    exits: { aWins: AWins, bWins: BWins, inconclusive: Inconclusive },
    during: { measure: Measuring, nextHour: BetweenMeasurements, decide: Deciding },
  });

const tenancySchema = z.object({
  tenantId: z.string(),
  customer: z.string(),
  plan: z.string(),
});

const Customer = H.state('Customer', 'waiting');
const ReviewDue = H.state('ReviewDue', 'pending');
const UsageReview = H.state('UsageReview', 'active');
const AwaitingUpsellDecision = H.state('AwaitingUpsellDecision', 'waiting');
const Suspended = H.state('Suspended', 'waiting');
const Churned = H.terminal('Churned', 'neutral');

const Tenancy = H.kind('Tenancy')
  .attributes(tenancySchema)
  .states(Customer, ReviewDue, UsageReview, AwaitingUpsellDecision, Suspended, Churned)
  .key(tenancy => tenancy.tenantId)
  .initial(Customer);

const reviewDue = H.signal('reviewDue');
const suspend = H.signal('suspend').payload(z.object({ reason: z.string() }));
const reinstate = H.signal('reinstate').payload(z.object({ reason: z.string() }));
const churn = H.signal('churn').payload(z.object({ reason: z.string() }));
const upsellDecision = H.signal('upsellDecision').payload(z.object({ upsell: z.boolean(), notes: z.string() }));

const usageReport = H.command('usage-report')
  .input(z.object({ tenantId: z.string() }))
  .argv(input => ['billing', 'usage', input.tenantId, '--last-month'])
  .output(z.object({ activeSeats: z.number(), monthlyUsd: z.number(), seatLimit: z.number() }))
  .runner(opsRunner);

const accountReviewer = H.role('account-reviewer')
  .intents('read')
  .instructions('Summarise the month of usage in five plain sentences and say whether the customer is near a plan limit.');

const usageSummarizer = H.agent('usage-summarizer').role(accountReviewer).model(summaryModel);

const tenancyReview = H.flow('monthly-tenancy-review')
  .input(tenancySchema)
  .step('usage', usageReport, ctx => ({ tenantId: ctx.unit.attributes.tenantId }))
  .step('summary', usageSummarizer, ctx => ({
    task: `Customer ${ctx.unit.attributes.customer} on plan ${ctx.unit.attributes.plan}: ${ctx.steps.usage.activeSeats} of ${ctx.steps.usage.seatLimit} seats, $${ctx.steps.usage.monthlyUsd} this month.`,
  }))
  .await('decision', upsellDecision, {
    ask: ctx => `Offer ${ctx.unit.attributes.customer} an upgrade?\n\n${ctx.steps.summary}`,
  })
  .exit('upsell', ctx => ctx.steps.decision.upsell)
  .exit('keep');

const tenancies = H.lane('tenancies', Tenancy)
  .supply(H.operator)
  .supply(
    H.clock('monthly-tenancy-review').monthly(1, '08:00', { tz: 'Europe/Berlin' }),
    (_tick, to) => to.signal(reviewDue, unit => unit.state === 'Customer', {}),
  )
  .store(unitStore)
  .handler(tenancyReview, {
    exits: { upsell: Customer, keep: Customer },
    during: { usage: UsageReview, summary: UsageReview, decision: AwaitingUpsellDecision },
  })
  .on(reviewDue, { enter: ReviewDue })
  .on(suspend, { enter: Suspended })
  .on(reinstate, { enter: Customer })
  .on(churn, { enter: Churned });

const negotiationSchema = z.object({
  negotiationId: z.string(),
  vendor: z.string(),
  item: z.string(),
  targetPriceUsd: z.number(),
  expiresAt: z.string(),
  round: z.number().int(),
  lastVendorMessage: z.string().optional(),
});

const NegotiationOpen = H.state('NegotiationOpen', 'pending');
const DraftingOffer = H.state('DraftingOffer', 'active');
const SendingOffer = H.state('SendingOffer', 'active');
const AwaitingVendor = H.state('AwaitingVendor', 'waiting');
const Countered = H.state('Countered', 'pending');
const Agreed = H.terminal('Agreed', 'success');
const WeWalkedAway = H.terminal('WeWalkedAway', 'neutral');
const TheyWalkedAway = H.terminal('TheyWalkedAway', 'failure');
const Expired = H.terminal('Expired', 'failure');

const Negotiation = H.kind('Negotiation')
  .attributes(negotiationSchema)
  .states(NegotiationOpen, DraftingOffer, SendingOffer, AwaitingVendor, Countered, Agreed, WeWalkedAway, TheyWalkedAway, Expired)
  .key(negotiation => negotiation.negotiationId)
  .initial(NegotiationOpen);

const vendorMessage = z.object({ message: z.string() });
const vendorCountered = H.signal('vendorCountered').payload(vendorMessage);
const vendorAccepted = H.signal('vendorAccepted').payload(vendorMessage);
const vendorWalkedAway = H.signal('vendorWalkedAway').payload(vendorMessage);
const negotiationExpired = H.signal('negotiationExpired');

const negotiator = H.role('negotiator')
  .intents('read')
  .instructions('Draft the next offer toward the target price. Walk away when the vendor will not move within reach of it.');

const offerDrafter = H.agent('offer-drafter')
  .role(negotiator)
  .model(negotiationModel)
  .output(z.object({
    action: z.enum(['offer', 'walkAway']),
    offerUsd: z.number(),
    message: z.string(),
  }));

const sendOffer = H.command('send-offer')
  .input(z.object({ negotiationId: z.string(), offerUsd: z.number(), message: z.string() }))
  .argv(input => ['procurement', 'send-offer', input.negotiationId, String(input.offerUsd), input.message])
  .runner(opsRunner);

const negotiationRound = H.flow('negotiation-round')
  .input(negotiationSchema)
  .step('draft', offerDrafter, ctx => ({
    task: `Round ${ctx.unit.attributes.round + 1} with ${ctx.unit.attributes.vendor} for ${ctx.unit.attributes.item}. Target $${ctx.unit.attributes.targetPriceUsd}. Vendor's last message: ${ctx.unit.attributes.lastVendorMessage ?? 'none yet'}.`,
  }))
  .exit('walkAway', ctx => ctx.steps.draft.action === 'walkAway')
  .step('send', sendOffer, ctx => ({
    negotiationId: ctx.unit.attributes.negotiationId,
    offerUsd: ctx.steps.draft.offerUsd,
    message: ctx.steps.draft.message,
  }), { afterCrash: 'park' })
  .exit('offered');

const vendorReplies = webhook.json('vendor-replies', {
  port: H.slot.port(1),
  path: '/vendor-replies',
  secret: H.env('VENDOR_WEBHOOK_SECRET'),
  payload: z.object({
    negotiationId: z.string(),
    reply: z.enum(['counter', 'accept', 'walkAway']),
    message: z.string(),
  }),
});

const negotiations = H.lane('negotiations', Negotiation)
  .supply(H.operator)
  .supply(vendorReplies, (reply, to) =>
    reply.reply === 'accept'
      ? to.signal(vendorAccepted, reply.negotiationId, { message: reply.message })
      : reply.reply === 'walkAway'
        ? to.signal(vendorWalkedAway, reply.negotiationId, { message: reply.message })
        : to.signal(vendorCountered, reply.negotiationId, { message: reply.message }))
  .store(unitStore)
  .handler(negotiationRound, {
    exits: { walkAway: WeWalkedAway, offered: AwaitingVendor },
    during: { draft: DraftingOffer, send: SendingOffer },
  })
  .on(vendorCountered, {
    update: (attrs, reply) => ({ ...attrs, round: attrs.round + 1, lastVendorMessage: reply.message }),
    enter: Countered,
  })
  .on(vendorAccepted, { enter: Agreed })
  .on(vendorWalkedAway, { enter: TheyWalkedAway })
  .on(negotiationExpired, { enter: Expired });

const negotiationDeadline = H.trigger('negotiation-deadline')
  .on(H.when.timer(negotiations, { at: unit => new Date(unit.attributes.expiresAt) }))
  .signal(negotiationExpired, negotiations, event => ({ key: event.unit.key, payload: {} }));

const lifecycles = H.scheduler('lifecycles')
  .priority(negotiations, tenancies, experiments)
  .admit(experiments, ctx => {
    const record = ctx.metrics.outcomes({ of: experiments, window: { lastDays: 180 } });
    const inconclusiveShare = record.terminal === 0 ? 0 : record.byState.Inconclusive / record.terminal;
    return record.terminal < 10 || inconclusiveShare < 0.5 || ctx.count(experiments, 'active', 'waiting') < 2;
  });

const operations = claudeCode.supervisor('lifecycles-supervisor', {
  grants: [
    H.ops.workRead,
    H.ops.workCreate,
    H.ops.send(H.cancel, { lanes: [experiments] }),
    H.ops.send(upsellDecision, { lanes: [tenancies] }),
    H.ops.send(suspend, { lanes: [tenancies] }),
    H.ops.send(reinstate, { lanes: [tenancies] }),
    H.ops.send(churn, { lanes: [tenancies] }),
    H.ops.telemetryRead,
  ],
});

export const harness = H.harness('lifecycles')
  .ledger(sqlite.ledger({ path: 'state/ledger.sqlite' }))
  .pools(apiPool)
  .lanes(experiments, tenancies, negotiations)
  .triggers(negotiationDeadline)
  .scheduler(lifecycles)
  .clients(operations)
  .observers(markdown.board({ path: 'BOARD.md' }), markdown.telemetry({ path: 'TELEMETRY.md' }));

export const running = harness.start();
