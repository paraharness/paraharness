import { z } from 'zod';
import { H } from 'harness-dsl';
import { anthropic } from 'harness-dsl/anthropic';
import { claudeCode } from 'harness-dsl/claude-code';
import { webhook } from 'harness-dsl/webhook';
import { local } from 'harness-dsl/local';
import { sqlite } from 'harness-dsl/sqlite';
import { markdown } from 'harness-dsl/markdown';

const Cancelled = H.state('Cancelled', 'cancelled');
const Failed = H.state('Failed', 'failed');

const experiment = z.object({ experimentId: z.string(), hypothesis: z.string(), endsAtMs: z.number() });

const Scheduled = H.state('Scheduled', 'pending');
const Measuring = H.state('Measuring', 'active');
const Deciding = H.state('Deciding', 'active');
const AWins = H.state('AWins', 'ended');
const BWins = H.state('BWins', 'ended');
const Inconclusive = H.state('Inconclusive', 'ended');

const Experiment = H.kind('Experiment')
  .attributes(experiment)
  .states(Scheduled, Measuring, Deciding, AWins, BWins, Inconclusive, Failed, Cancelled)
  .key(a => a.experimentId);

const tenancy = z.object({ tenantId: z.string(), customer: z.string(), plan: z.string() });

const Onboarding = H.state('Onboarding', 'pending');
const Reviewing = H.state('Reviewing', 'active');
const AwaitingDecision = H.state('AwaitingDecision', 'active');
const Customer = H.state('Customer', 'active');
const Suspended = H.state('Suspended', 'active');
const Churned = H.state('Churned', 'ended');

const Tenancy = H.kind('Tenancy')
  .attributes(tenancy)
  .states(Onboarding, Reviewing, AwaitingDecision, Customer, Suspended, Churned, Failed, Cancelled)
  .key(a => a.tenantId);

const negotiation = z.object({
  negotiationId: z.string(),
  vendor: z.string(),
  item: z.string(),
  deadlineMs: z.number(),
  lastVendorMessage: z.string(),
});

const Opening = H.state('Opening', 'pending');
const Drafting = H.state('Drafting', 'active');
const AwaitingOurApproval = H.state('AwaitingOurApproval', 'active');
const AwaitingVendor = H.state('AwaitingVendor', 'active');
const Agreed = H.state('Agreed', 'succeeded');
const WeWalkedAway = H.state('WeWalkedAway', 'ended');
const TheyWalkedAway = H.state('TheyWalkedAway', 'ended');
const Expired = H.state('Expired', 'ended');

const Negotiation = H.kind('Negotiation')
  .attributes(negotiation)
  .states(Opening, Drafting, AwaitingOurApproval, AwaitingVendor, Agreed, WeWalkedAway, TheyWalkedAway, Expired, Failed, Cancelled)
  .key(a => a.negotiationId);

const review = H.signal('monthly-review');
const suspend = H.signal('suspend');
const reinstate = H.signal('reinstate');
const vendorOffered = H.signal('vendor-offered').payload(z.object({ message: z.string() }));
const vendorAccepted = H.signal('vendor-accepted');
const vendorWalkedAway = H.signal('vendor-walked-away');
const deadlinePassed = H.signal('deadline-passed');

const apiAccount = anthropic.account('anthropic-api', { apiKey: H.env('ANTHROPIC_API_KEY') });
const pool = H.pool('api-pool').accounts(apiAccount);
const sonnet = anthropic.model('sonnet', { id: 'claude-sonnet-4-5', pool });

const analystRole = H.role('account-analyst').instructions('Summarise tenant usage and the case for or against an upsell.');
const negotiatorRole = H.role('negotiator').instructions('Draft our next offer, or recommend walking away.');

const summaryAgent = H.agent('usage-summary-agent').role(analystRole).model(sonnet).budgetTokens(15000);
const negotiateAgent = H.agent('negotiate-agent')
  .role(negotiatorRole)
  .model(sonnet)
  .budgetTokens(20000)
  .output(z.object({ recommendation: z.enum(['offer', 'walkAway']), offer: z.string(), rationale: z.string() }));

const localRunner = local.runner('local').slots(4);

const measure = H.command('measure-experiment')
  .input(z.object({ experimentId: z.string() }))
  .argv(i => ['./bin/experiment-measure', i.experimentId])
  .runner(localRunner);

const decide = H.command('decide-experiment')
  .input(z.object({ experimentId: z.string() }))
  .argv(i => ['./bin/experiment-decide', i.experimentId])
  .output(z.object({ winner: z.enum(['a', 'b', 'none']) }))
  .runner(localRunner);

const usageReport = H.command('tenant-usage')
  .input(z.object({ tenantId: z.string() }))
  .argv(i => ['./bin/tenant-usage', i.tenantId])
  .output(z.object({ seats: z.number(), monthlyUsageUsd: z.number() }))
  .runner(localRunner);

const sendOffer = H.command('send-offer')
  .input(z.object({ negotiationId: z.string(), offer: z.string() }))
  .argv(i => ['./bin/send-offer', i.negotiationId, i.offer])
  .runner(localRunner);

const experimentFlow = H.flow('experiment')
  .input(experiment)
  .loop(
    'hourly',
    f => f
      .step('measure', measure, ctx => ({ experimentId: ctx.unit.attributes.experimentId }), {
        retry: H.retry({ maxAttempts: 3, backoff: 'exponential', initialDelayMs: 10000 }),
      })
      .wait('nextHour', { ms: 3600000 }),
    { max: 400, until: ctx => ctx.now.getTime() >= ctx.unit.attributes.endsAtMs },
  )
  .step('decide', decide, ctx => ({ experimentId: ctx.unit.attributes.experimentId }))
  .exit('aWins', ctx => ctx.steps.decide.winner === 'a')
  .exit('bWins', ctx => ctx.steps.decide.winner === 'b')
  .exit('inconclusive');

const experimentLane = H.lane('experiments', Experiment)
  .supply(H.operator)
  .store(sqlite.store({ path: '.harness/units.db' }))
  .handler(experimentFlow, {
    exits: { aWins: AWins, bWins: BWins, inconclusive: Inconclusive },
    during: { measure: Measuring, nextHour: Measuring, decide: Deciding },
    failure: Failed,
  });

const tenancyFlow = H.flow('tenancy-review')
  .input(tenancy)
  .step('usage', usageReport, ctx => ({ tenantId: ctx.unit.attributes.tenantId }))
  .step('summary', summaryAgent, ctx => ({
    task: `Summarise ${ctx.unit.attributes.customer} on plan ${ctx.unit.attributes.plan}: ${ctx.steps.usage.seats} seats, $${ctx.steps.usage.monthlyUsageUsd} this month.`,
    resources: [ctx.unit.attributes.tenantId],
  }))
  .halt('decision', {
    ask: ctx => `Monthly review of ${ctx.unit.attributes.customer}:\n\n${ctx.steps.summary}`,
    decision: z.object({ action: z.enum(['upsell', 'keep', 'suspend', 'churn']), note: z.string() }),
  })
  .exit('churned', ctx => ctx.steps.decision.action === 'churn')
  .exit('suspended', ctx => ctx.steps.decision.action === 'suspend')
  .exit('upsold', ctx => ctx.steps.decision.action === 'upsell')
  .exit('kept');

const tenancyLane = H.lane('tenancies', Tenancy)
  .supply(H.operator)
  .supply(H.clock('monthly-review').monthly(1, '09:00', { tz: 'UTC' }), (tick, to) =>
    to.signal(review, unit => unit.outcome === 'active' && unit.attempt === undefined, {}),
  )
  .store(sqlite.store({ path: '.harness/units.db' }))
  .handler(tenancyFlow, {
    exits: { churned: Churned, suspended: Suspended, upsold: Customer, kept: Customer },
    during: { usage: Reviewing, summary: Reviewing, decision: AwaitingDecision },
    failure: Customer,
  })
  .on(review, { restart: 'usage' })
  .on(suspend, { enter: Suspended })
  .on(reinstate, { enter: Customer });

const negotiationFlow = H.flow('negotiation-round')
  .input(negotiation)
  .step('draft', negotiateAgent, ctx => ({
    task: `Negotiating ${ctx.unit.attributes.item} with ${ctx.unit.attributes.vendor}. Their last message: ${ctx.unit.attributes.lastVendorMessage}`,
    resources: [ctx.unit.attributes.vendor],
  }))
  .halt('approve', {
    ask: ctx => `Recommendation: ${ctx.steps.draft.recommendation}\nOffer: ${ctx.steps.draft.offer}\n\n${ctx.steps.draft.rationale}`,
    decision: z.object({ action: z.enum(['send', 'walkAway']), offer: z.string() }),
  })
  .exit('walkedAway', ctx => ctx.steps.approve.action === 'walkAway')
  .step('send', sendOffer, ctx => ({ negotiationId: ctx.unit.attributes.negotiationId, offer: ctx.steps.approve.offer }), {
    retry: H.retry({ maxAttempts: 3, backoff: 'exponential', initialDelayMs: 5000 }),
  })
  .exit('offered');

const vendorReplies = webhook.json('vendor-replies', {
  port: H.slot.port(0),
  path: '/vendors/replies',
  secret: H.env('VENDOR_WEBHOOK_SECRET'),
  payload: z.object({ negotiationId: z.string(), reply: z.enum(['offer', 'accept', 'walkAway']), message: z.string() }),
});

const negotiationLane = H.lane('negotiations', Negotiation)
  .supply(H.operator)
  .supply(vendorReplies, (event, to) =>
    event.reply === 'accept'
      ? to.signal(vendorAccepted, event.negotiationId, {})
      : event.reply === 'walkAway'
        ? to.signal(vendorWalkedAway, event.negotiationId, {})
        : to.signal(vendorOffered, event.negotiationId, { message: event.message }),
  )
  .store(sqlite.store({ path: '.harness/units.db' }))
  .handler(negotiationFlow, {
    exits: { walkedAway: WeWalkedAway, offered: AwaitingVendor },
    during: { draft: Drafting, approve: AwaitingOurApproval, send: Drafting },
    failure: Failed,
  })
  .on(vendorOffered, {
    update: (attrs, payload) => ({ ...attrs, lastVendorMessage: payload.message }),
    restart: 'draft',
  })
  .on(vendorAccepted, { enter: Agreed })
  .on(vendorWalkedAway, { enter: TheyWalkedAway })
  .on(deadlinePassed, { enter: Expired });

const negotiationExpires = H.trigger('negotiation-expires')
  .on(H.when.timer(negotiationLane, {
    at: unit => new Date(unit.attributes.deadlineMs),
    if: unit => unit.outcome === 'pending' || unit.outcome === 'active',
  }))
  .signal(deadlinePassed, () => ({}));

const scheduler = H.scheduler('lifecycles')
  .priority(negotiationLane, tenancyLane, experimentLane)
  .admit(experimentLane, ctx => {
    const history = ctx.metrics.outcomes({ of: experimentLane, windowDays: 180 });
    const concluded = history.succeeded + history.failed + history.ended;
    return concluded < 10 || history.byState['Inconclusive'] / concluded < 0.5 || ctx.active(experimentLane) === 0;
  });

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

export const lifecycles = H.harness('hostile-lifecycles')
  .ledger(sqlite.ledger({ path: '.harness/ledger.db' }))
  .lanes(negotiationLane, tenancyLane, experimentLane)
  .triggers(negotiationExpires)
  .scheduler(scheduler)
  .clients(supervisor)
  .observers(markdown.board({ path: 'BOARD.md' }), markdown.telemetry({ path: 'TELEMETRY.md' }));

export const running = lifecycles.start();
