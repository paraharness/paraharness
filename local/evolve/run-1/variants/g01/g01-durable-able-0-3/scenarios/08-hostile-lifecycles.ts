import { z } from 'zod';
import { H } from 'harness-dsl';
import { anthropic } from 'harness-dsl/anthropic';
import { sqlite } from 'harness-dsl/sqlite';
import { local } from 'harness-dsl/local';
import { webhook } from 'harness-dsl/webhook';
import { http } from 'harness-dsl/http';
import { markdown } from 'harness-dsl/markdown';

const apiAccount = anthropic.account('ops-api', { apiKey: H.env('ANTHROPIC_API_KEY') });
const sonnet = anthropic.model('sonnet', { id: 'claude-sonnet-4' });
const opus = anthropic.model('opus', { id: 'claude-opus-4' });
const runner = local.runner('local').slots(4);

const experimentAttrs = z.object({ name: z.string(), variantA: z.string(), variantB: z.string() });

const ExperimentQueued = H.state('queued', 'pending');
const Measuring = H.state('measuring', 'active');
const Collecting = H.state('collecting', 'waiting');
const Deciding = H.state('deciding', 'active');
const AWins = H.state('aWins', 'terminal', 'success');
const BWins = H.state('bWins', 'terminal', 'success');
const Inconclusive = H.state('inconclusive', 'terminal', 'neutral');
const ExperimentAborted = H.state('aborted', 'terminal', 'failure');
const ExperimentCancelled = H.state('cancelled', 'terminal', 'neutral');

const Experiment = H.kind('Experiment')
  .attributes(experimentAttrs)
  .states(ExperimentQueued, Measuring, Collecting, Deciding, AWins, BWins, Inconclusive, ExperimentAborted, ExperimentCancelled)
  .key((experiment) => experiment.name);

const measure = H.command('measure-experiment')
  .input(z.object({ name: z.string() }))
  .argv((input) => ['experiment', 'measure', input.name])
  .output(z.object({ a: z.number(), b: z.number() }))
  .runner(runner);

const decideExperiment = H.command('decide-experiment')
  .input(z.object({ name: z.string() }))
  .argv((input) => ['experiment', 'decide', input.name])
  .output(z.object({ result: z.enum(['a', 'b', 'inconclusive']) }))
  .runner(runner);

const twoWeeksMs = 14 * 24 * 60 * 60 * 1000;

const experimentFlow = H.flow('experiment')
  .input(experimentAttrs)
  .loop(
    'hours',
    (hour) => hour
      .step('measure', measure, (ctx) => ({ name: ctx.unit.attributes.name }), { retry: { retries: 2, backoff: 'exponential', initialDelayMs: 30000 } })
      .wait('nextHour', { ms: 60 * 60 * 1000 }),
    { max: 14 * 24, until: (ctx) => ctx.now.getTime() - ctx.unit.createdAt.getTime() >= twoWeeksMs },
  )
  .step('decide', decideExperiment, (ctx) => ({ name: ctx.unit.attributes.name }))
  .exit('aWins', (ctx) => ctx.steps.decide.result === 'a')
  .exit('bWins', (ctx) => ctx.steps.decide.result === 'b')
  .exit('inconclusive');

const experiments = H.lane('experiments', Experiment)
  .supply(H.operator)
  .handler(experimentFlow, {
    exits: { aWins: AWins, bWins: BWins, inconclusive: Inconclusive },
    waits: { nextHour: Collecting },
    during: { measure: Measuring, decide: Deciding },
    failure: ExperimentAborted,
  })
  .on(H.cancel, { enter: ExperimentCancelled });

const tenancyAttrs = z.object({ tenantId: z.string(), customer: z.string(), plan: z.string() });

const ReviewDue = H.state('reviewDue', 'pending');
const ReviewingUsage = H.state('reviewingUsage', 'active');
const AwaitingDecision = H.state('awaitingDecision', 'active');
const Between = H.state('between', 'waiting');
const Suspended = H.state('suspended', 'waiting');
const Churned = H.state('churned', 'terminal', 'neutral');

const Tenancy = H.kind('Tenancy')
  .attributes(tenancyAttrs)
  .states(ReviewDue, ReviewingUsage, AwaitingDecision, Between, Suspended, Churned)
  .key((tenancy) => tenancy.tenantId);

const monthlyReview = H.signal('monthlyReview');
const suspend = H.signal('suspend');
const reinstate = H.signal('reinstate');
const churn = H.signal('churn');

const usageReport = H.command('usage-report')
  .input(z.object({ tenantId: z.string() }))
  .argv((input) => ['usage', 'report', input.tenantId])
  .output(z.object({ seatsUsed: z.number(), seatsPaid: z.number(), trend: z.string() }))
  .runner(runner);

const accountManager = H.role('account-manager').intents('read').instructions('Summarise usage for a human deciding on an upsell.');
const usageSummarizer = H.agent('usage-summarizer').role(accountManager).model(sonnet).budgetTokens(20000);

const tenancyFlow = H.flow('tenancy-review')
  .input(tenancyAttrs)
  .step('usage', usageReport, (ctx) => ({ tenantId: ctx.unit.attributes.tenantId }))
  .step('summary', usageSummarizer, (ctx) => ({
    task: `Customer ${ctx.unit.attributes.customer} on ${ctx.unit.attributes.plan}: ${ctx.steps.usage.seatsUsed}/${ctx.steps.usage.seatsPaid} seats, trend ${ctx.steps.usage.trend}.`,
  }))
  .halt('upsell', {
    ask: (ctx) => `Upsell ${ctx.unit.attributes.customer}?\n\n${ctx.steps.summary}`,
    decision: z.object({ upsell: z.boolean(), note: z.string() }),
  })
  .exit('reviewed');

const billingEvents = webhook.json('billing-events', {
  port: H.slot.port(1),
  path: '/billing',
  secret: H.env('BILLING_WEBHOOK_SECRET'),
  payload: z.object({ tenantId: z.string(), event: z.enum(['suspended', 'reinstated', 'churned']) }),
});

const tenancies = H.lane('tenancies', Tenancy)
  .supply(H.operator)
  .supply(H.clock('first-of-month').monthly(1, '08:00', { tz: 'Europe/Berlin' }), (_tick, to) =>
    to.signal(monthlyReview, (unit) => unit.state === 'between', {}))
  .supply(billingEvents, (event, to) =>
    event.event === 'suspended'
      ? to.signal(suspend, event.tenantId, {})
      : event.event === 'reinstated'
        ? to.signal(reinstate, event.tenantId, {})
        : to.signal(churn, event.tenantId, {}))
  .handler(tenancyFlow, {
    exits: { reviewed: Between },
    during: { usage: ReviewingUsage, summary: ReviewingUsage, upsell: AwaitingDecision },
    failure: Between,
  })
  .on(monthlyReview, { enter: ReviewDue })
  .on(suspend, { enter: Suspended })
  .on(reinstate, { enter: Between })
  .on(churn, { enter: Churned })
  .on(H.cancel, { enter: Between });

const negotiationAttrs = z.object({
  vendor: z.string(),
  item: z.string(),
  targetUsd: z.number(),
  deadline: z.string(),
  lastVendorMessage: z.string(),
});

const NextRound = H.state('nextRound', 'pending');
const Composing = H.state('composing', 'active');
const ConfirmingWalkAway = H.state('confirmingWalkAway', 'active');
const AwaitingVendor = H.state('awaitingVendor', 'waiting');
const Stalled = H.state('stalled', 'waiting');
const Agreed = H.state('agreed', 'terminal', 'success');
const WalkedAwayByUs = H.state('walkedAwayByUs', 'terminal', 'neutral');
const WalkedAwayByThem = H.state('walkedAwayByThem', 'terminal', 'failure');
const Expired = H.state('expired', 'terminal', 'neutral');

const Negotiation = H.kind('Negotiation')
  .attributes(negotiationAttrs)
  .states(NextRound, Composing, ConfirmingWalkAway, AwaitingVendor, Stalled, Agreed, WalkedAwayByUs, WalkedAwayByThem, Expired)
  .key((negotiation) => `${negotiation.vendor}/${negotiation.item}`);

const vendorReplied = H.signal('vendorReplied').payload(z.object({ message: z.string() }));
const vendorAccepted = H.signal('vendorAccepted');
const vendorWalkedAway = H.signal('vendorWalkedAway');
const negotiationExpired = H.signal('negotiationExpired');

const negotiator = H.role('negotiator').intents('read').instructions('Draft the next move in a procurement negotiation.');
const offerDrafter = H.agent('offer-drafter')
  .role(negotiator)
  .model(opus)
  .output(z.object({ move: z.enum(['offer', 'accept', 'walkAway']), message: z.string() }))
  .budgetTokens(30000);

const sendToVendor = H.command('send-to-vendor')
  .input(z.object({ vendor: z.string(), message: z.string() }))
  .argv((input) => ['procurement', 'send', input.vendor, input.message])
  .runner(runner);

const negotiationFlow = H.flow('negotiation-round')
  .input(negotiationAttrs)
  .step('draft', offerDrafter, (ctx) => ({
    task: `Round ${ctx.unit.attempts + 1} with ${ctx.unit.attributes.vendor} for ${ctx.unit.attributes.item}, target $${ctx.unit.attributes.targetUsd}. Vendor said: ${ctx.unit.attributes.lastVendorMessage}`,
  }))
  .halt('confirmWalkAway', {
    ask: (ctx) => `The drafter proposes walking away from ${ctx.unit.attributes.vendor}: ${ctx.steps.draft.message}`,
    decision: z.object({ confirm: z.boolean() }),
    skip: (ctx) => (ctx.steps.draft.move === 'walkAway' ? undefined : { confirm: false }),
  })
  .exit('reconsider', (ctx) => ctx.steps.draft.move === 'walkAway' && !ctx.steps.confirmWalkAway.confirm)
  .step('send', sendToVendor, (ctx) => ({ vendor: ctx.unit.attributes.vendor, message: ctx.steps.draft.message }))
  .exit('walkedAway', (ctx) => ctx.steps.draft.move === 'walkAway')
  .exit('agreed', (ctx) => ctx.steps.draft.move === 'accept')
  .exit('offerSent');

const vendorReplies = webhook.json('vendor-replies', {
  port: H.slot.port(1),
  path: '/vendor',
  secret: H.env('VENDOR_WEBHOOK_SECRET'),
  payload: z.object({ negotiation: z.string(), kind: z.enum(['reply', 'accepted', 'walkedAway']), message: z.string() }),
});

const negotiations = H.lane('negotiations', Negotiation)
  .supply(H.operator)
  .supply(vendorReplies, (reply, to) =>
    reply.kind === 'reply'
      ? to.signal(vendorReplied, reply.negotiation, { message: reply.message })
      : reply.kind === 'accepted'
        ? to.signal(vendorAccepted, reply.negotiation, {})
        : to.signal(vendorWalkedAway, reply.negotiation, {}))
  .handler(negotiationFlow, {
    exits: { reconsider: Stalled, walkedAway: WalkedAwayByUs, agreed: Agreed, offerSent: AwaitingVendor },
    during: { draft: Composing, confirmWalkAway: ConfirmingWalkAway, send: Composing },
    failure: Stalled,
  })
  .on(vendorReplied, { update: (attrs, payload) => ({ ...attrs, lastVendorMessage: payload.message }), enter: NextRound })
  .on(vendorAccepted, { enter: Agreed })
  .on(vendorWalkedAway, { enter: WalkedAwayByThem })
  .on(negotiationExpired, { enter: Expired })
  .on(H.cancel, { enter: Stalled });

const negotiationDeadline = H.trigger('negotiation-deadline')
  .on(H.when.timer(negotiations, {
    at: (unit) => new Date(unit.attributes.deadline),
    if: (unit) => unit.position !== 'terminal',
  }))
  .signal(negotiationExpired, (event) => ({ unit: event.unit, payload: {} }));

const scheduler = H.scheduler('lifecycles-scheduler')
  .priority(negotiations, tenancies, experiments)
  .admit(experiments, (ctx) => {
    if (ctx.unit.attempts > 0) {
      return true;
    }
    const history = ctx.metrics.outcomes({ of: experiments, windowDays: 180 }).units;
    const inconclusiveShare = history.terminal === 0 ? 0 : history.byState.inconclusive / history.terminal;
    const concurrent = history.terminal >= 10 && inconclusiveShare > 0.5 ? 2 : 6;
    return ctx.count(experiments, ['active', 'waiting']) < concurrent;
  });

export const lifecycles = H.harness('lifecycles')
  .ledger(sqlite.ledger({ path: 'state/ledger.sqlite' }))
  .pool(H.pool('lifecycles-pool').accounts(apiAccount))
  .lanes(experiments, tenancies, negotiations)
  .triggers(negotiationDeadline)
  .scheduler(scheduler)
  .clients(http.controlApi('control', {
    port: H.slot.port(2),
    token: H.env('CONTROL_TOKEN'),
    grants: [H.ops.workRead, H.ops.workCreate, H.ops.workCancel, H.ops.workSignal, H.ops.blockersResolve, H.ops.telemetryRead],
  }))
  .observers(markdown.board({ path: 'board.md' }), markdown.telemetry({ path: 'telemetry.md' }));
