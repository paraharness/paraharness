import { z } from 'zod';
import { H } from 'harness-dsl';
import { anthropic } from 'harness-dsl/anthropic';
import { claudeCode } from 'harness-dsl/claude-code';
import { sqlite } from 'harness-dsl/sqlite';
import { webhook } from 'harness-dsl/webhook';
import { local } from 'harness-dsl/local';
import { markdown } from 'harness-dsl/markdown';

const apiAccount = anthropic.account('anthropic-api', { apiKey: H.env('ANTHROPIC_API_KEY') });
const sonnet = anthropic.model('sonnet', { id: 'claude-sonnet-4-5' });
const pool = H.pool('api').accounts(apiAccount);
const ops = local.runner('ops').slots(4);
const store = sqlite.store({ path: '.harness/units.sqlite' });

const experimentAttributes = z.object({ name: z.string(), variantA: z.string(), variantB: z.string() });

const scheduled = H.state('scheduled', 'pending');
const observing = H.state('observing', 'waiting');
const measuring = H.state('measuring', 'active');
const aWins = H.terminal('aWins', 'success');
const bWins = H.terminal('bWins', 'success');
const inconclusive = H.terminal('inconclusive', 'neutral');
const broken = H.terminal('broken', 'failure');
const stopped = H.terminal('stopped', 'neutral');

const experimentKind = H.kind('Experiment')
  .attributes(experimentAttributes)
  .states(scheduled, observing, measuring, aWins, bWins, inconclusive, broken, stopped)
  .key(a => a.name)
  .initial(scheduled);

const sampleExperiment = H.command('sample-experiment')
  .input(z.object({ experiment: z.string() }))
  .argv(i => ['ab-sample', i.experiment])
  .output(z.object({ conversionsA: z.number(), conversionsB: z.number() }))
  .runner(ops);

const decideWinner = H.command('decide-winner')
  .input(z.object({ experiment: z.string() }))
  .argv(i => ['ab-decide', i.experiment])
  .output(z.object({ winner: z.enum(['a', 'b', 'none']) }))
  .runner(ops);

const twoWeekExperiment = H.flow('two-week-experiment')
  .input(experimentAttributes)
  .loop(
    'hours',
    f =>
      f
        .wait('nextHour', { ms: 3600000 })
        .step('sample', sampleExperiment, ctx => ({ experiment: ctx.unit.attributes.name }), {
          retry: { maxAttempts: 3, backoff: 'exponential', initialDelayMs: 30000 },
          afterCrash: 'rerun',
        }),
    { max: 336 },
  )
  .step('decide', decideWinner, ctx => ({ experiment: ctx.unit.attributes.name }))
  .exit('aWon', ctx => ctx.steps.decide.winner === 'a')
  .exit('bWon', ctx => ctx.steps.decide.winner === 'b')
  .exit('noWinner');

const experiments = H.lane('experiments', experimentKind)
  .supply(H.operator)
  .store(store)
  .handler(twoWeekExperiment, {
    exits: { aWon: aWins, bWon: bWins, noWinner: inconclusive },
    during: { nextHour: observing, sample: measuring, decide: measuring },
    cancelled: stopped,
  })
  .retry({ maxAttempts: 2, backoff: 'fixed', initialDelayMs: 3600000, exhausted: broken });

const tenancyAttributes = z.object({ customerId: z.string(), plan: z.string() });

const due = H.state('due', 'pending');
const resting = H.state('resting', 'waiting');
const reviewing = H.state('reviewing', 'active');
const awaitingDecision = H.state('awaitingDecision', 'waiting');
const suspended = H.state('suspended', 'waiting');
const reviewStalled = H.state('reviewStalled', 'waiting');
const churned = H.terminal('churned', 'neutral');

const tenancyKind = H.kind('Tenancy')
  .attributes(tenancyAttributes)
  .states(due, resting, reviewing, awaitingDecision, suspended, reviewStalled, churned)
  .key(a => a.customerId)
  .initial(due);

const suspend = H.signal('suspend');
const reinstate = H.signal('reinstate');
const churn = H.signal('churn');

const usageReview = H.command('usage-review')
  .input(z.object({ customerId: z.string() }))
  .argv(i => ['usage-report', '--customer', i.customerId, '--days', '30'])
  .output(z.object({ seats: z.number(), spendUsd: z.number(), trend: z.string() }))
  .runner(ops);

const accountRole = H.role('account-reviewer').intents('read').instructions('Summarise a month of usage for the account owner in five sentences.');
const accountReviewer = H.seat('account-reviewer')
  .role(accountRole)
  .model(sonnet)
  .pool(pool)
  .output(z.object({ summary: z.string(), recommendUpsell: z.boolean() }));

const upsellDecision = H.halt('upsell').decision(z.object({ upsell: z.boolean(), note: z.string() }));

const monthlyReview = H.flow('monthly-review')
  .input(tenancyAttributes)
  .wait('untilReview', { ms: 30 * 24 * 3600000 })
  .step('usage', usageReview, ctx => ({ customerId: ctx.unit.attributes.customerId }), { afterCrash: 'rerun' })
  .step('summary', accountReviewer, ctx => ({
    task: `Customer ${ctx.unit.attributes.customerId} on ${ctx.unit.attributes.plan}: ${ctx.steps.usage.seats} seats, $${ctx.steps.usage.spendUsd}, trend ${ctx.steps.usage.trend}.`,
  }))
  .halt('upsell', upsellDecision, {
    ask: ctx => `Upsell ${ctx.unit.attributes.customerId}? ${ctx.steps.summary.summary} Recommendation: ${ctx.steps.summary.recommendUpsell ? 'upsell' : 'hold'}.`,
  })
  .exit('reviewed');

const billingEvents = webhook.json('billing-events', {
  port: H.slot.port(1),
  path: '/billing',
  secret: H.env('BILLING_WEBHOOK_SECRET'),
  payload: z.object({
    type: z.enum(['signedUp', 'suspended', 'reinstated', 'churned']),
    customerId: z.string(),
    plan: z.string(),
  }),
});

const tenancies = H.lane('tenancies', tenancyKind)
  .supply(billingEvents, (e, to) =>
    e.type === 'signedUp'
      ? to.create({ customerId: e.customerId, plan: e.plan })
      : e.type === 'suspended'
        ? to.signal(suspend, e.customerId, {})
        : e.type === 'reinstated'
          ? to.signal(reinstate, e.customerId, {})
          : to.signal(churn, e.customerId, {}),
  )
  .store(store)
  .handler(monthlyReview, {
    exits: { reviewed: due },
    during: { untilReview: resting, usage: reviewing, summary: reviewing, upsell: awaitingDecision },
  })
  .retry({ maxAttempts: 3, backoff: 'exponential', initialDelayMs: 3600000, exhausted: reviewStalled })
  .on(suspend, { enter: suspended })
  .on(reinstate, { enter: due })
  .on(churn, { enter: churned });

const negotiationAttributes = z.object({
  negotiationId: z.string(),
  vendor: z.string(),
  item: z.string(),
  expiresAt: z.string(),
  lastVendorMessage: z.string(),
});

const ourTurn = H.state('ourTurn', 'pending');
const drafting = H.state('drafting', 'active');
const sending = H.state('sending', 'active');
const theirTurn = H.state('theirTurn', 'waiting');
const needsOwner = H.state('needsOwner', 'waiting');
const agreed = H.terminal('agreed', 'success');
const walkedAwayByUs = H.terminal('walkedAwayByUs', 'neutral');
const walkedAwayByThem = H.terminal('walkedAwayByThem', 'failure');
const expired = H.terminal('expired', 'neutral');

const negotiationKind = H.kind('Negotiation')
  .attributes(negotiationAttributes)
  .states(ourTurn, drafting, sending, theirTurn, needsOwner, agreed, walkedAwayByUs, walkedAwayByThem, expired)
  .key(a => a.negotiationId)
  .initial(ourTurn);

const vendorReplied = H.signal('vendorReplied').payload(z.object({ message: z.string() }));
const vendorAccepted = H.signal('vendorAccepted');
const vendorWalkedAway = H.signal('vendorWalkedAway');
const expire = H.signal('expire');

const negotiatorRole = H.role('negotiator').intents('read').instructions('Draft the next procurement offer, or decide to accept or walk away.');
const negotiator = H.seat('negotiator')
  .role(negotiatorRole)
  .model(sonnet)
  .pool(pool)
  .output(z.object({ action: z.enum(['counter', 'accept', 'walkAway']), message: z.string() }));

const sendToVendor = H.command('send-to-vendor')
  .input(z.object({ negotiationId: z.string(), action: z.string(), message: z.string() }))
  .argv(i => ['procurement-send', i.negotiationId, i.action, i.message])
  .runner(ops);

const negotiationRound = H.flow('negotiation-round')
  .input(negotiationAttributes)
  .step('draft', negotiator, ctx => ({
    task: `Negotiating ${ctx.unit.attributes.item} with ${ctx.unit.attributes.vendor}. Their last message: ${ctx.unit.attributes.lastVendorMessage}`,
  }))
  .step('send', sendToVendor, ctx => ({
    negotiationId: ctx.unit.attributes.negotiationId,
    action: ctx.steps.draft.action,
    message: ctx.steps.draft.message,
  }), { afterCrash: 'park' })
  .exit('walkedAway', ctx => ctx.steps.draft.action === 'walkAway')
  .exit('accepted', ctx => ctx.steps.draft.action === 'accept')
  .exit('countered');

const vendorEvents = webhook.json('vendor-replies', {
  port: H.slot.port(2),
  path: '/vendors',
  secret: H.env('VENDOR_WEBHOOK_SECRET'),
  payload: z.object({ negotiationId: z.string(), type: z.enum(['reply', 'accept', 'walkAway']), message: z.string() }),
});

const negotiations = H.lane('negotiations', negotiationKind)
  .supply(H.operator)
  .supply(vendorEvents, (e, to) =>
    e.type === 'reply'
      ? to.signal(vendorReplied, e.negotiationId, { message: e.message })
      : e.type === 'accept'
        ? to.signal(vendorAccepted, e.negotiationId, {})
        : to.signal(vendorWalkedAway, e.negotiationId, {}),
  )
  .store(store)
  .handler(negotiationRound, {
    exits: { walkedAway: walkedAwayByUs, accepted: agreed, countered: theirTurn },
    during: { draft: drafting, send: sending },
  })
  .retry({ maxAttempts: 3, backoff: 'exponential', initialDelayMs: 60000, exhausted: needsOwner })
  .on(vendorReplied, { update: (a, p) => ({ ...a, lastVendorMessage: p.message }), enter: ourTurn })
  .on(vendorAccepted, { enter: agreed })
  .on(vendorWalkedAway, { enter: walkedAwayByThem })
  .on(expire, { enter: expired });

const negotiationExpiry = H.trigger('negotiation-expiry')
  .on(H.when.timer(negotiations, { at: unit => new Date(unit.attributes.expiresAt) }))
  .signal(expire, negotiations, e => ({ key: e.unit.key, payload: {} }));

const scheduler = H.scheduler('lifecycles')
  .priority(negotiations, tenancies, experiments)
  .admit(experiments, ctx => {
    const outcomes = ctx.metrics.outcomes({ of: experimentKind, window: { lastDays: 180 } });
    return outcomes.terminal < 10 || outcomes.byState.inconclusive / outcomes.terminal < 0.5;
  });

const supervisor = H.client('supervisor', {
  transport: claudeCode.mcp('supervisor-mcp', { port: H.slot.port(3) }),
  grants: [
    H.ops.workRead,
    H.ops.workCreate,
    H.ops.workSignal,
    H.ops.workCancel,
    H.ops.attemptsRecover,
    H.ops.telemetryRead,
    H.ops.resolve(upsellDecision),
  ],
});

export const harness = H.harness('lifecycles')
  .ledger(sqlite.ledger({ path: '.harness/ledger.sqlite' }))
  .lanes(experiments, tenancies, negotiations)
  .triggers(negotiationExpiry)
  .scheduler(scheduler)
  .clients(supervisor)
  .observers(markdown.board({ path: 'BOARD.md' }), markdown.telemetry({ path: 'TELEMETRY.md' }));
