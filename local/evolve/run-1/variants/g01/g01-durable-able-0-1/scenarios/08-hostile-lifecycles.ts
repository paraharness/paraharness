import { z } from 'zod';
import { H } from 'harness-dsl';
import { sqlite } from 'harness-dsl/sqlite';
import { anthropic } from 'harness-dsl/anthropic';
import { claudeCode } from 'harness-dsl/claude-code';
import { webhook } from 'harness-dsl/webhook';
import { local } from 'harness-dsl/local';
import { markdown } from 'harness-dsl/markdown';

const box = local.runner('lifecycle-box').slots(4);
const apiAccount = anthropic.account('lifecycle-api', { apiKey: H.env('ANTHROPIC_API_KEY') });
const sonnet = anthropic.model('sonnet', { id: 'claude-sonnet-4-5' });

const ExperimentAttributes = z.object({ experimentId: z.string(), hypothesis: z.string() });

const Proposed = H.state('proposed', 'pending');
const Measuring = H.state('measuring', 'active');
const BetweenSamples = H.state('between-samples', 'waiting');
const Deciding = H.state('deciding', 'active');
const AWins = H.state('a-wins', 'terminal', 'success');
const BWins = H.state('b-wins', 'terminal', 'success');
const Inconclusive = H.state('inconclusive', 'terminal', 'neutral');
const ExperimentAborted = H.state('experiment-aborted', 'terminal', 'failure');
const ExperimentWithdrawn = H.state('experiment-withdrawn', 'terminal', 'neutral');

const Experiment = H.kind('Experiment')
  .attributes(ExperimentAttributes)
  .states(Proposed, Measuring, BetweenSamples, Deciding, AWins, BWins, Inconclusive, ExperimentAborted, ExperimentWithdrawn)
  .key(e => e.experimentId);

const measureVariants = H.command('measure-variants')
  .input(z.object({ experimentId: z.string(), hour: z.number() }))
  .argv(input => ['experiment-sample', input.experimentId, String(input.hour)])
  .output(z.object({ a: z.number(), b: z.number() }))
  .runner(box);

const decideWinner = H.command('decide-winner')
  .input(z.object({ experimentId: z.string() }))
  .argv(input => ['experiment-decide', input.experimentId])
  .output(z.object({ winner: z.enum(['a', 'b', 'none']) }))
  .runner(box);

const experimentFlow = H.flow('two-week-experiment')
  .input(ExperimentAttributes)
  .loop(
    'hourly',
    flow => flow
      .step('measure', measureVariants, ctx => ({ experimentId: ctx.unit.attributes.experimentId, hour: ctx.iteration }))
      .wait('untilNextHour', { ms: 3_600_000 }),
    { max: 14 * 24 },
  )
  .step('decide', decideWinner, ctx => ({ experimentId: ctx.unit.attributes.experimentId }))
  .exit('aWins', ctx => ctx.steps.decide.winner === 'a')
  .exit('bWins', ctx => ctx.steps.decide.winner === 'b')
  .exit('inconclusive');

const experiments = H.lane('experiments', Experiment)
  .supply(H.operator)
  .store(sqlite.store({ path: 'state/experiments.db' }))
  .handler(experimentFlow, {
    exits: { aWins: AWins, bWins: BWins, inconclusive: Inconclusive },
    during: { measure: Measuring, untilNextHour: BetweenSamples, decide: Deciding },
    failure: ExperimentAborted,
    cancelled: ExperimentWithdrawn,
  });

const TenancyAttributes = z.object({ customerId: z.string(), plan: z.string() });

const Customer = H.state('customer', 'waiting');
const UnderReview = H.state('under-review', 'active');
const AwaitingDecision = H.state('awaiting-decision', 'waiting');
const Suspended = H.state('suspended', 'waiting');
const Churned = H.state('churned', 'terminal', 'neutral');

const Tenancy = H.kind('Tenancy')
  .attributes(TenancyAttributes)
  .states(Customer, UnderReview, AwaitingDecision, Suspended, Churned)
  .key(t => t.customerId);

const MonthlyReview = H.signal('monthly-review').payload(z.object({ month: z.string() }));
const Suspend = H.signal('suspend').payload(z.object({ reason: z.string() }));
const Reinstate = H.signal('reinstate').payload(z.object({ reason: z.string() }));
const Churn = H.signal('churn').payload(z.object({ reason: z.string() }));

const usageReport = H.command('usage-report')
  .input(z.object({ customerId: z.string() }))
  .argv(input => ['usage-report', input.customerId])
  .output(z.object({ seatsUsed: z.number(), seatsPaid: z.number(), apiCalls: z.number() }))
  .runner(box);

const accountManager = H.role('account-manager')
  .intents('read')
  .instructions('Summarise the month of usage for the account owner: trend, headroom, and whether an upsell is warranted.');

const usageSummarizer = H.agent('usage-summarizer').role(accountManager).model(sonnet);

const tenancyReview = H.flow('monthly-tenancy-review')
  .input(TenancyAttributes)
  .step('usage', usageReport, ctx => ({ customerId: ctx.unit.attributes.customerId }))
  .step('summary', usageSummarizer, ctx => ({
    task: `Customer ${ctx.unit.attributes.customerId} on ${ctx.unit.attributes.plan}: ${ctx.steps.usage.seatsUsed}/${ctx.steps.usage.seatsPaid} seats, ${ctx.steps.usage.apiCalls} API calls this month.`,
  }))
  .halt('decision', {
    ask: ctx => `Upsell ${ctx.unit.attributes.customerId}?\n\n${ctx.steps.summary}`,
    decision: z.object({ upsell: z.boolean(), note: z.string() }),
  })
  .exit('reviewed');

const crmEvents = webhook.json('crm-events', {
  port: H.slot.port(1),
  path: '/crm',
  secret: H.env('CRM_WEBHOOK_SECRET'),
  payload: z.object({
    event: z.enum(['signed', 'suspended', 'reinstated', 'churned']),
    customerId: z.string(),
    plan: z.string(),
    reason: z.string(),
  }),
});

const tenancies = H.lane('tenancies', Tenancy)
  .supply(crmEvents, (event, to) => {
    if (event.event === 'signed') return to.create({ customerId: event.customerId, plan: event.plan });
    if (event.event === 'suspended') return to.signal(Suspend, event.customerId, { reason: event.reason });
    if (event.event === 'reinstated') return to.signal(Reinstate, event.customerId, { reason: event.reason });
    return to.signal(Churn, event.customerId, { reason: event.reason });
  })
  .supply(H.clock('monthly-review-clock').monthly(1, '09:00', { tz: 'Europe/London' }), (tick, to) =>
    to.signal(MonthlyReview, unit => unit.state === 'customer', { month: tick.at.toISOString().slice(0, 7) }),
  )
  .store(sqlite.store({ path: 'state/tenancies.db' }))
  .handler(tenancyReview, {
    exits: { reviewed: Customer },
    during: { usage: UnderReview, summary: UnderReview, decision: AwaitingDecision },
    failure: Customer,
  })
  .on(MonthlyReview, { restart: 'usage' })
  .on(Suspend, { enter: Suspended })
  .on(Reinstate, { enter: Customer })
  .on(Churn, { enter: Churned });

const NegotiationAttributes = z.object({
  negotiationId: z.string(),
  vendor: z.string(),
  item: z.string(),
  deadline: z.string(),
  round: z.number(),
  lastVendorMessage: z.string().optional(),
});

const Opening = H.state('opening', 'pending');
const Drafting = H.state('drafting', 'active');
const AwaitingVendor = H.state('awaiting-vendor', 'waiting');
const Agreed = H.state('agreed', 'terminal', 'success');
const WalkedAwayByUs = H.state('walked-away-by-us', 'terminal', 'neutral');
const WalkedAwayByThem = H.state('walked-away-by-them', 'terminal', 'failure');
const Expired = H.state('expired', 'terminal', 'failure');

const Negotiation = H.kind('Negotiation')
  .attributes(NegotiationAttributes)
  .states(Opening, Drafting, AwaitingVendor, Agreed, WalkedAwayByUs, WalkedAwayByThem, Expired)
  .key(n => n.negotiationId);

const VendorCountered = H.signal('vendor-countered').payload(z.object({ message: z.string() }));
const VendorAccepted = H.signal('vendor-accepted').payload(z.object({ message: z.string() }));
const VendorWalkedAway = H.signal('vendor-walked-away').payload(z.object({ message: z.string() }));
const NegotiationExpired = H.signal('negotiation-expired');

const negotiator = H.role('negotiator')
  .intents('read')
  .instructions('Draft our next move in the procurement negotiation: a counter-offer, acceptance, or a walk-away with reasons.');

const offerDrafter = H.agent('offer-drafter')
  .role(negotiator)
  .model(sonnet)
  .output(z.object({ action: z.enum(['offer', 'accept', 'walkAway']), message: z.string() }));

const sendToVendor = H.command('send-to-vendor')
  .input(z.object({ negotiationId: z.string(), action: z.string(), message: z.string() }))
  .argv(input => ['vendor-mail', input.negotiationId, input.action, input.message])
  .runner(box);

const negotiationRound = H.flow('negotiation-round')
  .input(NegotiationAttributes)
  .step('draftOffer', offerDrafter, ctx => ({
    task: `Round ${ctx.unit.attributes.round} with ${ctx.unit.attributes.vendor} for ${ctx.unit.attributes.item}. Vendor said: ${ctx.unit.attributes.lastVendorMessage ?? 'nothing yet'}.`,
  }))
  .step('send', sendToVendor, ctx => ({
    negotiationId: ctx.unit.attributes.negotiationId,
    action: ctx.steps.draftOffer.action,
    message: ctx.steps.draftOffer.message,
  }))
  .exit('weAccepted', ctx => ctx.steps.draftOffer.action === 'accept')
  .exit('weWalkedAway', ctx => ctx.steps.draftOffer.action === 'walkAway')
  .exit('offered');

const vendorReplies = webhook.json('vendor-replies', {
  port: H.slot.port(2),
  path: '/vendor',
  secret: H.env('VENDOR_WEBHOOK_SECRET'),
  payload: z.object({ negotiationId: z.string(), reply: z.enum(['counter', 'accepted', 'walkedAway']), message: z.string() }),
});

const negotiations = H.lane('negotiations', Negotiation)
  .supply(H.operator)
  .supply(vendorReplies, (reply, to) => {
    if (reply.reply === 'accepted') return to.signal(VendorAccepted, reply.negotiationId, { message: reply.message });
    if (reply.reply === 'walkedAway') return to.signal(VendorWalkedAway, reply.negotiationId, { message: reply.message });
    return to.signal(VendorCountered, reply.negotiationId, { message: reply.message });
  })
  .store(sqlite.store({ path: 'state/negotiations.db' }))
  .handler(negotiationRound, {
    exits: { weAccepted: Agreed, weWalkedAway: WalkedAwayByUs, offered: AwaitingVendor },
    during: { draftOffer: Drafting, send: Drafting },
    failure: AwaitingVendor,
  })
  .on(VendorCountered, {
    update: (attrs, reply) => ({ ...attrs, round: attrs.round + 1, lastVendorMessage: reply.message }),
    restart: 'draftOffer',
  })
  .on(VendorAccepted, { enter: Agreed })
  .on(VendorWalkedAway, { enter: WalkedAwayByThem })
  .on(NegotiationExpired, { enter: Expired });

const negotiationExpiry = H.trigger('negotiation-expiry')
  .on(H.when.timer(negotiations, { at: unit => new Date(unit.attributes.deadline), if: unit => unit.position !== 'terminal' }))
  .signal(negotiations, NegotiationExpired, event => ({ key: event.unit.key, payload: {} }));

export const lifecycles = H.harness('lifecycles')
  .ledger(sqlite.ledger({ path: 'state/ledger.db' }))
  .pools(H.pool('lifecycle-pool').accounts(apiAccount))
  .lanes(experiments, tenancies, negotiations)
  .triggers(negotiationExpiry)
  .scheduler(
    H.scheduler('lifecycle-scheduler')
      .priority(negotiations, tenancies, experiments)
      .admit(experiments, ctx => {
        const record = ctx.metrics.outcomes({ of: experiments, windowDays: 180 });
        const decided = record.byState['a-wins'] + record.byState['b-wins'] + record.byState.inconclusive;
        const inconclusiveShare = decided === 0 ? 0 : record.byState.inconclusive / decided;
        const concurrentExperiments = decided >= 10 && inconclusiveShare > 0.5 ? 1 : 4;
        return ctx.open(experiments) <= concurrentExperiments;
      }),
  )
  .clients(
    claudeCode.supervisor('lifecycle-supervisor', {
      grants: [H.ops.workRead, H.ops.workCreate, H.ops.workCancel, H.ops.workSignal, H.ops.blockersResolve, H.ops.telemetryRead],
    }),
  )
  .observers(markdown.board({ path: 'board.md' }));
