import { z } from 'zod';
import { H } from 'harness-dsl';
import { sqlite } from 'harness-dsl/sqlite';
import { jsonl } from 'harness-dsl/jsonl';
import { anthropic } from 'harness-dsl/anthropic';
import { claudeCode } from 'harness-dsl/claude-code';
import { local } from 'harness-dsl/local';
import { webhook } from 'harness-dsl/webhook';
import { markdown } from 'harness-dsl/markdown';

const apiAccount = anthropic.account('lifecycles-api', { apiKey: H.env('ANTHROPIC_API_KEY') });
const sonnet = anthropic.model('sonnet', { id: 'claude-sonnet-4' });
const apiPool = H.pool('lifecycles-api').accounts(apiAccount);
const harnessStore = sqlite.store({ path: '.harness/units.sqlite' });
const workers = local.runner('workers').slots(4);

const experimentAttributes = z.object({
  name: z.string(),
  hypothesis: z.string(),
  endsAt: z.string(),
});

const ExperimentProposed = H.state('ExperimentProposed', 'pending');
const Sampling = H.state('Sampling', 'active');
const Observing = H.state('Observing', 'waiting');
const Deciding = H.state('Deciding', 'active');
const AWins = H.state('AWins', 'terminal', 'success');
const BWins = H.state('BWins', 'terminal', 'success');
const Inconclusive = H.state('Inconclusive', 'terminal', 'neutral');

const Experiment = H.kind('Experiment')
  .attributes(experimentAttributes)
  .states(ExperimentProposed, Sampling, Observing, Deciding, AWins, BWins, Inconclusive)
  .key(experiment => experiment.name);

const sampleExperiment = H.command('sample-experiment')
  .input(z.object({ experiment: z.string() }))
  .argv(input => ['experiment-metric', 'sample', input.experiment])
  .output(z.object({ a: z.number(), b: z.number() }))
  .runner(workers);

const decideExperiment = H.command('decide-experiment')
  .input(z.object({ experiment: z.string() }))
  .argv(input => ['experiment-metric', 'decide', input.experiment])
  .output(z.object({ winner: z.enum(['a', 'b', 'none']) }))
  .runner(workers);

const experimentFlow = H.flow('experiment')
  .input(experimentAttributes)
  .loop('hourly', flow => flow
    .step('sample', sampleExperiment, ctx => ({ experiment: ctx.unit.attributes.name }), { restart: 'rerun' })
    .wait('nextHour', { ms: 3_600_000 }),
  {
    max: 24 * 14 + 1,
    until: ctx => ctx.now.getTime() >= Date.parse(ctx.unit.attributes.endsAt),
  })
  .step('decide', decideExperiment, ctx => ({ experiment: ctx.unit.attributes.name }), { restart: 'rerun' })
  .exit('aWins', ctx => ctx.steps.decide.winner === 'a')
  .exit('bWins', ctx => ctx.steps.decide.winner === 'b')
  .exit('inconclusive');

const experimentLane = H.lane('experiments', Experiment)
  .supply(H.operator)
  .store(harnessStore)
  .handler(experimentFlow, {
    exits: { aWins: AWins, bWins: BWins, inconclusive: Inconclusive },
    during: { sample: Sampling, nextHour: Observing, decide: Deciding },
  });

const tenancyAttributes = z.object({
  customerId: z.string(),
  plan: z.string(),
});

const Customer = H.state('Customer', 'waiting');
const UnderReview = H.state('UnderReview', 'active');
const AwaitingUpsellDecision = H.state('AwaitingUpsellDecision', 'waiting');
const Suspended = H.state('Suspended', 'waiting');
const Churned = H.state('Churned', 'terminal', 'neutral');

const Tenancy = H.kind('Tenancy')
  .attributes(tenancyAttributes)
  .states(Customer, UnderReview, AwaitingUpsellDecision, Suspended, Churned)
  .key(tenancy => tenancy.customerId);

const monthlyReview = H.signal('monthly-review');
const suspend = H.signal('suspend');
const reinstate = H.signal('reinstate');
const churn = H.signal('churn');

const usageReport = H.command('usage-report')
  .input(z.object({ customerId: z.string() }))
  .argv(input => ['usage-report', '--customer', input.customerId, '--json'])
  .output(z.object({ seats: z.number(), spendUsd: z.number(), trend: z.enum(['growing', 'flat', 'shrinking']) }))
  .runner(workers);

const accountManager = H.role('account-manager').intents('read').instructions('Summarise the month in plain language and state whether an upsell is warranted and why.');
const usageSummarizer = H.agent('usage-summarizer').role(accountManager).model(sonnet);

const tenancyFlow = H.flow('tenancy-review')
  .input(tenancyAttributes)
  .step('usage', usageReport, ctx => ({ customerId: ctx.unit.attributes.customerId }), { restart: 'rerun' })
  .step('summary', usageSummarizer, ctx => ({
    task: `Customer ${ctx.unit.attributes.customerId} on ${ctx.unit.attributes.plan}: ${ctx.steps.usage.seats} seats, ${ctx.steps.usage.spendUsd} USD, ${ctx.steps.usage.trend}.`,
  }), { restart: 'ask' })
  .halt('upsell', {
    ask: ctx => ctx.steps.summary,
    decision: z.object({ upsell: z.boolean(), notes: z.string() }),
  })
  .exit('upsold', ctx => ctx.steps.upsell.upsell)
  .exit('kept');

const billingEvents = webhook.json('billing-events', {
  port: H.slot.port(1),
  path: '/billing',
  secret: H.env('BILLING_WEBHOOK_SECRET'),
  payload: z.object({
    customerId: z.string(),
    plan: z.string(),
    event: z.enum(['signed', 'suspended', 'reinstated', 'churned']),
  }),
});

const tenancyLane = H.lane('tenancies', Tenancy)
  .supply(billingEvents, (event, to) => {
    if (event.event === 'signed') return to.create({ customerId: event.customerId, plan: event.plan });
    if (event.event === 'suspended') return to.signal(suspend, event.customerId, {});
    if (event.event === 'reinstated') return to.signal(reinstate, event.customerId, {});
    return to.signal(churn, event.customerId, {});
  })
  .supply(H.clock('monthly-review').monthly(1, '09:00', { tz: 'Europe/London' }), (_tick, to) =>
    to.signal(monthlyReview, unit => unit.state === 'Customer', {}))
  .store(harnessStore)
  .handler(tenancyFlow, {
    exits: { upsold: Customer, kept: Customer },
    during: { usage: UnderReview, summary: UnderReview, upsell: AwaitingUpsellDecision },
  })
  .on(monthlyReview, { restart: 'usage' })
  .on(suspend, { enter: Suspended })
  .on(reinstate, { enter: Customer })
  .on(churn, { enter: Churned });

const negotiationAttributes = z.object({
  negotiationId: z.string(),
  vendor: z.string(),
  item: z.string(),
  ceilingUsd: z.number(),
  lastVendorMessage: z.string(),
  rounds: z.number(),
  expiresAt: z.string(),
});

const NegotiationOpened = H.state('NegotiationOpened', 'pending');
const DraftingOffer = H.state('DraftingOffer', 'active');
const AwaitingVendor = H.state('AwaitingVendor', 'waiting');
const Agreed = H.state('Agreed', 'terminal', 'success');
const WalkedAwayByUs = H.state('WalkedAwayByUs', 'terminal', 'neutral');
const WalkedAwayByVendor = H.state('WalkedAwayByVendor', 'terminal', 'failure');
const Expired = H.state('Expired', 'terminal', 'failure');

const Negotiation = H.kind('Negotiation')
  .attributes(negotiationAttributes)
  .states(NegotiationOpened, DraftingOffer, AwaitingVendor, Agreed, WalkedAwayByUs, WalkedAwayByVendor, Expired)
  .key(negotiation => negotiation.negotiationId);

const vendorCountered = H.signal('vendor-countered').payload(z.object({ message: z.string() }));
const vendorAccepted = H.signal('vendor-accepted');
const vendorWithdrew = H.signal('vendor-withdrew');
const expire = H.signal('expire');

const negotiatorRole = H.role('negotiator').intents('read').instructions('Draft the next move. Never exceed the ceiling. Walk away when the vendor will not move below it.');
const negotiator = H.agent('negotiator')
  .role(negotiatorRole)
  .model(sonnet)
  .output(z.object({ move: z.enum(['counter', 'accept', 'walkAway']), message: z.string() }));

const sendToVendor = H.command('send-to-vendor')
  .input(z.object({ negotiationId: z.string(), move: z.enum(['counter', 'accept', 'walkAway']), message: z.string() }))
  .argv(input => ['procurement-mail', 'send', input.negotiationId, input.move])
  .runner(workers);

const negotiationFlow = H.flow('negotiation-round')
  .input(negotiationAttributes)
  .step('offer', negotiator, ctx => ({
    task: `Round ${ctx.unit.attributes.rounds + 1} with ${ctx.unit.attributes.vendor} for ${ctx.unit.attributes.item}. Ceiling ${ctx.unit.attributes.ceilingUsd} USD. Vendor said: ${ctx.unit.attributes.lastVendorMessage}`,
  }), { restart: 'ask' })
  .step('send', sendToVendor, ctx => ({
    negotiationId: ctx.unit.attributes.negotiationId,
    move: ctx.steps.offer.move,
    message: ctx.steps.offer.message,
  }), { restart: 'park' })
  .exit('agreed', ctx => ctx.steps.offer.move === 'accept')
  .exit('walkedAway', ctx => ctx.steps.offer.move === 'walkAway')
  .exit('offered');

const vendorReplies = webhook.json('vendor-replies', {
  port: H.slot.port(1),
  path: '/vendor',
  secret: H.env('VENDOR_WEBHOOK_SECRET'),
  payload: z.object({
    negotiationId: z.string(),
    type: z.enum(['counter', 'accept', 'withdraw']),
    message: z.string(),
  }),
});

const negotiationLane = H.lane('negotiations', Negotiation)
  .supply(H.operator)
  .supply(vendorReplies, (reply, to) => {
    if (reply.type === 'counter') return to.signal(vendorCountered, reply.negotiationId, { message: reply.message });
    if (reply.type === 'accept') return to.signal(vendorAccepted, reply.negotiationId, {});
    return to.signal(vendorWithdrew, reply.negotiationId, {});
  })
  .store(harnessStore)
  .handler(negotiationFlow, {
    exits: { agreed: Agreed, walkedAway: WalkedAwayByUs, offered: AwaitingVendor },
    during: { offer: DraftingOffer, send: DraftingOffer },
  })
  .on(vendorCountered, {
    update: (attrs, reply) => ({ ...attrs, lastVendorMessage: reply.message, rounds: attrs.rounds + 1 }),
    restart: 'offer',
  })
  .on(vendorAccepted, { enter: Agreed })
  .on(vendorWithdrew, { enter: WalkedAwayByVendor })
  .on(expire, { enter: Expired });

const negotiationExpiry = H.trigger('negotiation-expiry')
  .on(H.when.timer(negotiationLane, {
    at: unit => new Date(unit.attributes.expiresAt),
    if: unit => unit.position !== 'terminal',
  }))
  .signal(expire, () => ({}));

const negotiationLessons = H.memory('negotiation-lessons').trust('experience');
const negotiationPlaybook = H.playbook('negotiation-lessons', negotiationLessons)
  .store(jsonl.memoryStore({ path: '.harness/negotiation-lessons.jsonl' }))
  .recall(H.recall('negotiation-recall', { by: 'specificity', limit: 6 }))
  .readBy(negotiatorRole)
  .recordedBy(negotiatorRole);

const lifecycleScheduler = H.scheduler('lifecycles')
  .priority(negotiationLane, tenancyLane, experimentLane)
  .admit(experimentLane, ctx => {
    const finished = ctx.metrics.outcomes({ of: experimentLane, windowDays: 180 }).units;
    const inconclusiveShare = finished.terminal === 0 ? 0 : finished.byState.Inconclusive / finished.terminal;
    return finished.terminal < 10 || inconclusiveShare < 0.5 || ctx.open(experimentLane) < 2;
  });

export const harness = H.harness('hostile-lifecycles')
  .ledger(sqlite.ledger({ path: '.harness/ledger.sqlite' }))
  .pools(apiPool)
  .lanes(experimentLane, tenancyLane, negotiationLane)
  .playbooks(negotiationPlaybook)
  .triggers(negotiationExpiry)
  .scheduler(lifecycleScheduler)
  .clients(claudeCode.supervisor('owner-supervisor', {
    grants: [H.ops.workRead, H.ops.workCreate, H.ops.workSignal, H.ops.workCancel, H.ops.blockersResolve, H.ops.telemetryRead, H.ops.memoryCurate],
  }))
  .observers(markdown.board({ path: 'BOARD.md' }), markdown.telemetry({ path: 'TELEMETRY.md' }));

export const running = harness.start();
