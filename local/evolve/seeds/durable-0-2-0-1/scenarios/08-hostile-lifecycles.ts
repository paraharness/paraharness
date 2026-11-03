import { z } from 'zod';
import { H } from 'harness-dsl';
import { anthropic } from 'harness-dsl/anthropic';
import { claudeCode } from 'harness-dsl/claude-code';
import { sqlite } from 'harness-dsl/sqlite';
import { jsonl } from 'harness-dsl/jsonl';
import { local } from 'harness-dsl/local';
import { webhook } from 'harness-dsl/webhook';
import { markdown } from 'harness-dsl/markdown';

const hourMs = 3_600_000;
const dayMs = 24 * hourMs;

const monthAfter = (from: Date): string => {
  const next = new Date(from.getTime());
  next.setUTCMonth(next.getUTCMonth() + 1);
  return next.toISOString();
};

const runner = local.runner('ops-box');
const apiAccount = anthropic.account('anthropic-api', { apiKey: H.env('ANTHROPIC_API_KEY') });
const pool = H.pool('api-pool').accounts(apiAccount);
const sonnet = anthropic.model('sonnet', { id: 'claude-sonnet-4' });
const harnessStore = sqlite.store({ path: 'state/units.sqlite' });

const experimentAttrs = z.object({
  name: z.string(),
  metric: z.string(),
  variantA: z.string(),
  variantB: z.string(),
});

const Proposed = H.state('Proposed', 'pending');
const Sampling = H.state('Sampling', 'active');
const Collecting = H.state('Collecting', 'waiting');
const Analysing = H.state('Analysing', 'active');
const AWins = H.terminal('AWins', 'neutral');
const BWins = H.terminal('BWins', 'neutral');
const Inconclusive = H.terminal('Inconclusive', 'neutral');
const Withdrawn = H.terminal('Withdrawn', 'neutral');
const Aborted = H.terminal('Aborted', 'failure');

const Experiment = H.kind('Experiment')
  .attributes(experimentAttrs)
  .states(Proposed, Sampling, Collecting, Analysing, AWins, BWins, Inconclusive, Withdrawn, Aborted)
  .key(experiment => experiment.name)
  .initial(Proposed)
  .onCancelled(Withdrawn);

const sampleExperiment = H.command('sample-experiment')
  .input(z.object({ name: z.string(), metric: z.string() }))
  .argv(input => ['experiments', 'sample', input.name, '--metric', input.metric])
  .runner(runner);

const analyseExperiment = H.command('analyse-experiment')
  .input(z.object({ name: z.string() }))
  .argv(input => ['experiments', 'analyse', input.name, '--json'])
  .output(z.object({ winner: z.enum(['a', 'b', 'none']), pValue: z.number() }))
  .runner(runner);

const runExperiment = H.flow('run-experiment')
  .input(experimentAttrs)
  .loop(
    'hourly',
    flow => flow
      .step(
        'sample',
        sampleExperiment,
        ctx => ({ name: ctx.unit.attributes.name, metric: ctx.unit.attributes.metric }),
        { retry: { maxAttempts: 3, backoff: 'exponential', initialDelayMs: 30_000 }, afterCrash: 'rerun' },
      )
      .wait('nextHour', { ms: hourMs }),
    {
      max: 14 * 24 + 1,
      until: ctx => ctx.now.getTime() - (ctx.unit.attempt?.startedAt ?? ctx.unit.createdAt).getTime() >= 14 * dayMs,
    },
  )
  .step('analyse', analyseExperiment, ctx => ({ name: ctx.unit.attributes.name }))
  .exit('aWins', ctx => ctx.steps.analyse.winner === 'a')
  .exit('bWins', ctx => ctx.steps.analyse.winner === 'b')
  .exit('inconclusive');

const experiments = H.lane('experiments', Experiment)
  .supply(H.operator)
  .store(harnessStore)
  .handler(runExperiment, {
    exits: { aWins: AWins, bWins: BWins, inconclusive: Inconclusive },
    during: { sample: Sampling, nextHour: Collecting, analyse: Analysing },
  })
  .retry({ maxAttempts: 2, backoff: 'fixed', initialDelayMs: hourMs, exhausted: Aborted });

const tenancyAttrs = z.object({
  customerId: z.string(),
  plan: z.string(),
  nextReviewAt: z.string(),
});

const Customer = H.state('Customer', 'waiting');
const ReviewDue = H.state('ReviewDue', 'pending');
const ReviewingUsage = H.state('ReviewingUsage', 'active');
const AwaitingUpsellDecision = H.state('AwaitingUpsellDecision', 'waiting');
const Suspended = H.state('Suspended', 'waiting');
const ReviewStalled = H.state('ReviewStalled', 'waiting');
const Churned = H.terminal('Churned', 'neutral');

const Tenancy = H.kind('Tenancy')
  .attributes(tenancyAttrs)
  .states(Customer, ReviewDue, ReviewingUsage, AwaitingUpsellDecision, Suspended, ReviewStalled, Churned)
  .key(tenancy => tenancy.customerId)
  .initial(Customer);

const reviewDue = H.signal('review-due').payload(z.object({ nextReviewAt: z.string() }));
const suspend = H.signal('suspend');
const reinstate = H.signal('reinstate').payload(z.object({ nextReviewAt: z.string() }));
const churn = H.signal('churn');

const accountManager = H.role('account-manager')
  .intents('read')
  .instructions('Summarise the month of usage for the account team: trend, risk, upsell fit.');

const usageSummarizer = H.agent('usage-summarizer').role(accountManager).model(sonnet).pool(pool);

const usageReport = H.command('usage-report')
  .input(z.object({ customerId: z.string() }))
  .argv(input => ['billing', 'usage', input.customerId, '--last-month', '--json'])
  .output(z.object({ seats: z.number(), activeUsers: z.number(), trend: z.string() }))
  .runner(runner);

const recordAccountDecision = H.command('record-account-decision')
  .input(z.object({ customerId: z.string(), upsell: z.boolean(), note: z.string() }))
  .argv(input => ['crm', 'record-decision', input.customerId, input.upsell ? 'upsell' : 'hold', input.note])
  .runner(runner);

const reviewTenancy = H.flow('review-tenancy')
  .input(tenancyAttrs)
  .step('usage', usageReport, ctx => ({ customerId: ctx.unit.attributes.customerId }))
  .step('summary', usageSummarizer, ctx => ({
    task: `Customer ${ctx.unit.attributes.customerId} on ${ctx.unit.attributes.plan}. Usage: ${JSON.stringify(ctx.steps.usage)}`,
    skills: [ctx.unit.attributes.plan],
  }))
  .halt('decision', {
    ask: ctx => `Upsell ${ctx.unit.attributes.customerId}?\n\n${ctx.steps.summary}`,
    decision: z.object({ upsell: z.boolean(), note: z.string() }),
  })
  .step('recordDecision', recordAccountDecision, ctx => ({
    customerId: ctx.unit.attributes.customerId,
    upsell: ctx.steps.decision.upsell,
    note: ctx.steps.decision.note,
  }))
  .exit('reviewed');

const billingEvents = webhook.json('billing-events', {
  port: H.slot.port(1),
  path: '/billing',
  secret: H.env('BILLING_WEBHOOK_SECRET'),
  payload: z.object({
    customerId: z.string(),
    plan: z.string(),
    event: z.enum(['signedUp', 'suspended', 'reinstated', 'churned']),
    at: z.string(),
  }),
});

const tenancies = H.lane('tenancies', Tenancy)
  .supply(billingEvents, (event, to) => {
    switch (event.event) {
      case 'signedUp':
        return to.create({ customerId: event.customerId, plan: event.plan, nextReviewAt: monthAfter(new Date(event.at)) });
      case 'suspended':
        return to.signal(suspend, event.customerId, {});
      case 'reinstated':
        return to.signal(reinstate, event.customerId, { nextReviewAt: monthAfter(new Date(event.at)) });
      case 'churned':
        return to.signal(churn, event.customerId, {});
    }
  })
  .store(harnessStore)
  .handler(reviewTenancy, {
    exits: { reviewed: Customer },
    during: { usage: ReviewingUsage, summary: ReviewingUsage, decision: AwaitingUpsellDecision },
  })
  .retry({ maxAttempts: 3, backoff: 'exponential', initialDelayMs: hourMs, exhausted: ReviewStalled })
  .on(reviewDue, { update: (attrs, payload) => ({ ...attrs, nextReviewAt: payload.nextReviewAt }), enter: ReviewDue })
  .on(suspend, { enter: Suspended })
  .on(reinstate, { update: (attrs, payload) => ({ ...attrs, nextReviewAt: payload.nextReviewAt }), enter: Customer })
  .on(churn, { enter: Churned });

const monthlyTenancyReview = H.trigger('monthly-tenancy-review')
  .on(H.when.timer(tenancies, { at: unit => new Date(unit.attributes.nextReviewAt) }))
  .signal(reviewDue, tenancies, event =>
    event.unit.state === 'Suspended'
      ? undefined
      : { key: event.unit.key, payload: { nextReviewAt: monthAfter(event.at) } });

const negotiationAttrs = z.object({
  vendor: z.string(),
  item: z.string(),
  ourLimitUsd: z.number(),
  expiresAt: z.string(),
  lastVendorOffer: z.string(),
  round: z.number(),
});

const OurMove = H.state('OurMove', 'pending');
const Drafting = H.state('Drafting', 'active');
const TheirMove = H.state('TheirMove', 'waiting');
const NeedsNegotiator = H.state('NeedsNegotiator', 'waiting');
const Agreed = H.terminal('Agreed', 'success');
const WeWalkedAway = H.terminal('WeWalkedAway', 'neutral');
const TheyWalkedAway = H.terminal('TheyWalkedAway', 'failure');
const Expired = H.terminal('Expired', 'neutral');

const Negotiation = H.kind('Negotiation')
  .attributes(negotiationAttrs)
  .states(OurMove, Drafting, TheirMove, NeedsNegotiator, Agreed, WeWalkedAway, TheyWalkedAway, Expired)
  .key(negotiation => `${negotiation.vendor}:${negotiation.item}`)
  .initial(OurMove);

const vendorCountered = H.signal('vendor-countered').payload(z.object({ offer: z.string() }));
const vendorAccepted = H.signal('vendor-accepted');
const vendorWalkedAway = H.signal('vendor-walked-away');
const negotiationExpired = H.signal('negotiation-expired');

const negotiatorRole = H.role('negotiator')
  .intents('read')
  .instructions('Draft the next move within our limit. Walk away when the vendor cannot meet it.');

const negotiator = H.agent('negotiator')
  .role(negotiatorRole)
  .model(sonnet)
  .pool(pool)
  .output(z.object({
    move: z.enum(['counter', 'accept', 'walkAway']),
    offer: z.string(),
    rationale: z.string(),
  }));

const sendToVendor = H.command('send-to-vendor')
  .input(z.object({ vendor: z.string(), move: z.string(), offer: z.string() }))
  .argv(input => ['procurement', 'send', input.vendor, input.move, input.offer])
  .runner(runner);

const negotiationRound = H.flow('negotiation-round')
  .input(negotiationAttrs)
  .step('draft', negotiator, ctx => ({
    task: `Round ${ctx.unit.attributes.round} with ${ctx.unit.attributes.vendor} for ${ctx.unit.attributes.item}. `
      + `Their last offer: ${ctx.unit.attributes.lastVendorOffer}. Our limit: ${ctx.unit.attributes.ourLimitUsd} USD.`,
    skills: [ctx.unit.attributes.vendor],
  }))
  .step(
    'send',
    sendToVendor,
    ctx => ({ vendor: ctx.unit.attributes.vendor, move: ctx.steps.draft.move, offer: ctx.steps.draft.offer }),
    { afterCrash: 'park' },
  )
  .exit('agreed', ctx => ctx.steps.draft.move === 'accept')
  .exit('walkedAway', ctx => ctx.steps.draft.move === 'walkAway')
  .exit('offered');

const vendorReplies = webhook.json('vendor-replies', {
  port: H.slot.port(1),
  path: '/vendors',
  secret: H.env('VENDOR_WEBHOOK_SECRET'),
  payload: z.object({
    negotiation: z.string(),
    reply: z.enum(['counter', 'accepted', 'walkedAway']),
    offer: z.string(),
  }),
});

const negotiations = H.lane('negotiations', Negotiation)
  .supply(H.operator)
  .supply(vendorReplies, (reply, to) => {
    switch (reply.reply) {
      case 'counter':
        return to.signal(vendorCountered, reply.negotiation, { offer: reply.offer });
      case 'accepted':
        return to.signal(vendorAccepted, reply.negotiation, {});
      case 'walkedAway':
        return to.signal(vendorWalkedAway, reply.negotiation, {});
    }
  })
  .store(harnessStore)
  .handler(negotiationRound, {
    exits: { agreed: Agreed, walkedAway: WeWalkedAway, offered: TheirMove },
    during: { draft: Drafting, send: Drafting },
  })
  .retry({ maxAttempts: 2, backoff: 'fixed', initialDelayMs: 600_000, exhausted: NeedsNegotiator })
  .on(vendorCountered, {
    update: (attrs, payload) => ({ ...attrs, lastVendorOffer: payload.offer, round: attrs.round + 1 }),
    enter: OurMove,
  })
  .on(vendorAccepted, { enter: Agreed })
  .on(vendorWalkedAway, { enter: TheyWalkedAway })
  .on(negotiationExpired, { enter: Expired });

const negotiationExpiry = H.trigger('negotiation-expiry')
  .on(H.when.timer(negotiations, { at: unit => new Date(unit.attributes.expiresAt) }))
  .signal(negotiationExpired, negotiations, event => ({ key: event.unit.key, payload: {} }));

const accountNotes = H.journal('account-notes', H.memory('account-lesson', 'experience'))
  .store(jsonl.memoryStore({ path: 'memory/accounts.jsonl' }))
  .recall({ by: 'specificity', limit: 6 })
  .readBy(accountManager, negotiatorRole);

const scheduler = H.scheduler('lifecycles')
  .priority(negotiations, tenancies, experiments)
  .admit(experiments, ctx => {
    const outcomes = ctx.metrics.outcomes({ of: experiments, window: { lastDays: 180 } });
    return outcomes.terminal < 10 || outcomes.byState.Inconclusive / outcomes.terminal < 0.5;
  });

export const lifecycles = H.harness('lifecycles')
  .ledger(sqlite.ledger({ path: 'state/ledger.sqlite' }))
  .lanes(experiments, tenancies, negotiations)
  .journals(accountNotes)
  .triggers(monthlyTenancyReview, negotiationExpiry)
  .scheduler(scheduler)
  .clients(claudeCode.supervisor('operations-desk', {
    grants: [
      H.ops.workRead,
      H.ops.workCreate,
      H.ops.workSignal,
      H.ops.workCancel,
      H.ops.blockersResolve,
      H.ops.telemetryRead,
    ],
  }))
  .observers(markdown.board({ path: 'BOARD.md' }), markdown.telemetry({ path: 'TELEMETRY.md' }));
