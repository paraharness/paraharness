import { z } from 'zod';
import { H } from 'harness-dsl';
import { anthropic } from 'harness-dsl/anthropic';
import { http } from 'harness-dsl/http';
import { jsonl } from 'harness-dsl/jsonl';
import { local } from 'harness-dsl/local';
import { markdown } from 'harness-dsl/markdown';
import { sqlite } from 'harness-dsl/sqlite';
import { webhook } from 'harness-dsl/webhook';

const runner = local.runner('opsRunner');
const apiAccount = anthropic.account('businessApi', { apiKey: H.env('ANTHROPIC_API_KEY') });
const pool = H.pool('businessPool').accounts(apiAccount);
const sonnet = anthropic.model('sonnet', { id: 'claude-sonnet-4-5' });

const ExperimentAttributes = z.object({ experimentId: z.string(), hypothesis: z.string(), endsAt: z.string() });
const ExperimentScheduled = H.state('ExperimentScheduled', 'pending');
const Observing = H.state('Observing', 'active');
const AWins = H.terminal('AWins', 'success');
const BWins = H.terminal('BWins', 'success');
const Inconclusive = H.terminal('Inconclusive', 'neutral');
const ExperimentAborted = H.terminal('ExperimentAborted', 'failure');
const Experiment = H.kind('Experiment')
  .attributes(ExperimentAttributes)
  .states(ExperimentScheduled, Observing, AWins, BWins, Inconclusive, ExperimentAborted)
  .key(e => e.experimentId)
  .initial(ExperimentScheduled)
  .onAttemptFailed(ExperimentAborted);

const measure = H.command('measureExperiment')
  .input(z.object({ experimentId: z.string() }))
  .argv(input => ['experiment-metric', input.experimentId])
  .output(z.object({ conversionA: z.number(), conversionB: z.number() }))
  .runner(runner);

const decide = H.command('decideExperiment')
  .input(z.object({ experimentId: z.string() }))
  .argv(input => ['experiment-decide', input.experimentId])
  .output(z.object({ winner: z.enum(['A', 'B', 'none']), confidence: z.number() }))
  .runner(runner);

const hourMs = 3600000;

const experimentFlow = H.flow('experimentRun')
  .input(ExperimentAttributes)
  .loop(
    'observation',
    flow => flow
      .step('measure', measure, ctx => ({ experimentId: ctx.unit.attributes.experimentId }), {
        retry: H.retry({ maxAttempts: 3, backoff: 'exponential', initialDelayMs: 60000 }),
        afterCrash: 'rerun',
      })
      .wait('nextHour', { ms: hourMs }),
    { max: 400, until: ctx => ctx.now.getTime() >= new Date(ctx.unit.attributes.endsAt).getTime() },
  )
  .step('decide', decide, ctx => ({ experimentId: ctx.unit.attributes.experimentId }), { afterCrash: 'rerun' })
  .exit('aWins', ctx => ctx.steps.decide.winner === 'A')
  .exit('bWins', ctx => ctx.steps.decide.winner === 'B')
  .exit('inconclusive');

const experiments = H.lane('experiments', Experiment)
  .supply(H.operator)
  .store(sqlite.store({ path: 'state/units.db' }))
  .handler(experimentFlow, {
    exits: { aWins: AWins, bWins: BWins, inconclusive: Inconclusive },
    during: { observation: Observing },
  });

const TenancyAttributes = z.object({ customerId: z.string(), plan: z.string() });
const Customer = H.state('Customer', 'waiting');
const ReviewDue = H.state('ReviewDue', 'pending');
const UnderReview = H.state('UnderReview', 'active');
const Suspended = H.state('Suspended', 'waiting');
const Churned = H.terminal('Churned', 'neutral');
const Tenancy = H.kind('Tenancy')
  .attributes(TenancyAttributes)
  .states(Customer, ReviewDue, UnderReview, Suspended, Churned)
  .key(t => t.customerId)
  .initial(Customer)
  .onAttemptFailed(Customer);

const reviewDue = H.signal('reviewDue');
const suspend = H.signal('suspend');
const reinstate = H.signal('reinstate');
const churn = H.signal('churn');

const accountManager = H.role('accountManager')
  .intents('read')
  .instructions('Summarise the month of usage for a human deciding whether to propose an upsell.');
const usageSummarizer = H.agent('usageSummarizer').role(accountManager).model(sonnet).output(z.object({ summary: z.string() }));

const usageReview = H.command('usageReview')
  .input(z.object({ customerId: z.string() }))
  .argv(input => ['usage-report', '--customer', input.customerId, '--last-month'])
  .output(z.object({ seats: z.number(), usageUsd: z.number(), growth: z.number() }))
  .runner(runner);

const tenancyFlow = H.flow('monthlyTenancyReview')
  .input(TenancyAttributes)
  .step('usage', usageReview, ctx => ({ customerId: ctx.unit.attributes.customerId }), { afterCrash: 'rerun' })
  .step('summary', usageSummarizer, ctx => ({
    task: `Customer ${ctx.unit.attributes.customerId} on ${ctx.unit.attributes.plan}: ${ctx.steps.usage.seats} seats, $${ctx.steps.usage.usageUsd}, growth ${ctx.steps.usage.growth}.`,
  }))
  .halt('upsellDecision', {
    ask: ctx => `Propose an upsell to ${ctx.unit.attributes.customerId}?\n\n${ctx.steps.summary.summary}`,
    decision: z.object({ upsell: z.boolean(), note: z.string() }),
  })
  .exit('upsell', ctx => ctx.steps.upsellDecision.upsell)
  .exit('hold');

const BillingEvent = z.object({
  customerId: z.string(),
  plan: z.string(),
  event: z.enum(['signed', 'suspended', 'reinstated', 'churned']),
});

const tenancies = H.lane('tenancies', Tenancy)
  .supply(
    webhook.json('billingEvents', { port: H.slot.port(1), path: '/billing', secret: H.env('BILLING_WEBHOOK_SECRET'), payload: BillingEvent }),
    (event, to) =>
      event.event === 'signed'
        ? to.create({ customerId: event.customerId, plan: event.plan })
        : event.event === 'suspended'
          ? to.signal(suspend, event.customerId, {})
          : event.event === 'reinstated'
            ? to.signal(reinstate, event.customerId, {})
            : to.signal(churn, event.customerId, {}),
  )
  .supply(H.clock('monthlyTenancyClock').monthly(1, '08:00', { tz: 'Europe/Berlin' }), (_tick, to) =>
    to.signal(reviewDue, unit => unit.state === 'Customer', {}),
  )
  .store(sqlite.store({ path: 'state/units.db' }))
  .handler(tenancyFlow, {
    exits: { upsell: Customer, hold: Customer },
    during: { usage: UnderReview },
  })
  .on(reviewDue, { enter: ReviewDue })
  .on(suspend, { enter: Suspended })
  .on(reinstate, { enter: Customer })
  .on(churn, { enter: Churned });

const NegotiationAttributes = z.object({
  negotiationId: z.string(),
  vendor: z.string(),
  brief: z.string(),
  expiresAt: z.string(),
  lastVendorOffer: z.string().optional(),
});
const OurTurn = H.state('OurTurn', 'pending');
const DraftingOffer = H.state('DraftingOffer', 'active');
const TheirTurn = H.state('TheirTurn', 'waiting');
const Agreed = H.terminal('Agreed', 'success');
const WeWalkedAway = H.terminal('WeWalkedAway', 'neutral');
const TheyWalkedAway = H.terminal('TheyWalkedAway', 'failure');
const Expired = H.terminal('Expired', 'failure');
const Negotiation = H.kind('Negotiation')
  .attributes(NegotiationAttributes)
  .states(OurTurn, DraftingOffer, TheirTurn, Agreed, WeWalkedAway, TheyWalkedAway, Expired)
  .key(n => n.negotiationId)
  .initial(OurTurn)
  .onAttemptFailed(OurTurn);

const vendorReplied = H.signal('vendorReplied').payload(z.object({ offer: z.string() }));
const vendorWalkedAway = H.signal('vendorWalkedAway');
const negotiationExpired = H.signal('negotiationExpired');

const procurement = H.role('negotiator')
  .intents('read')
  .instructions('Propose the next move within the brief: counter, accept the vendor offer, or walk away.');
const negotiator = H.agent('negotiator')
  .role(procurement)
  .model(sonnet)
  .output(z.object({ move: z.enum(['counter', 'accept', 'walkAway']), offer: z.string(), rationale: z.string() }));

const sendOffer = H.command('sendOffer')
  .input(z.object({ negotiationId: z.string(), vendor: z.string(), offer: z.string() }))
  .argv(input => ['send-offer', '--negotiation', input.negotiationId, '--vendor', input.vendor, '--offer', input.offer])
  .runner(runner);

const roundFlow = H.flow('negotiationRound')
  .input(NegotiationAttributes)
  .step('draftOffer', negotiator, ctx => ({
    task: `Brief: ${ctx.unit.attributes.brief}\nVendor ${ctx.unit.attributes.vendor} last offered: ${ctx.unit.attributes.lastVendorOffer ?? 'nothing yet'}`,
  }))
  .exit('agreed', ctx => ctx.steps.draftOffer.move === 'accept')
  .exit('walkedAway', ctx => ctx.steps.draftOffer.move === 'walkAway')
  .step('sendOffer', sendOffer, ctx => ({
    negotiationId: ctx.unit.attributes.negotiationId,
    vendor: ctx.unit.attributes.vendor,
    offer: ctx.steps.draftOffer.offer,
  }), { afterCrash: 'park' })
  .exit('offerSent');

const VendorEvent = z.object({ negotiationId: z.string(), type: z.enum(['offer', 'walkedAway']), offer: z.string() });

const negotiations = H.lane('negotiations', Negotiation)
  .supply(H.operator)
  .supply(
    webhook.json('vendorReplies', { port: H.slot.port(2), path: '/vendor', secret: H.env('VENDOR_WEBHOOK_SECRET'), payload: VendorEvent }),
    (event, to) =>
      event.type === 'offer'
        ? to.signal(vendorReplied, event.negotiationId, { offer: event.offer })
        : to.signal(vendorWalkedAway, event.negotiationId, {}),
  )
  .store(sqlite.store({ path: 'state/units.db' }))
  .handler(roundFlow, {
    exits: { agreed: Agreed, walkedAway: WeWalkedAway, offerSent: TheirTurn },
    during: { draftOffer: DraftingOffer },
  })
  .on(vendorReplied, { update: (attributes, payload) => ({ ...attributes, lastVendorOffer: payload.offer }), restart: 'draftOffer' })
  .on(vendorWalkedAway, { enter: TheyWalkedAway })
  .on(negotiationExpired, { enter: Expired });

const negotiationExpiry = H.trigger('negotiationExpiry')
  .on(H.when.timer(negotiations, { at: unit => new Date(unit.attributes.expiresAt) }))
  .signal(negotiationExpired, negotiations, event => ({ key: event.unit.key, payload: {} }));

const businessExperience = H.journal('businessExperience', H.memory('businessLesson').trust('experience'))
  .store(jsonl.memoryStore({ path: 'memory/business.jsonl' }))
  .recall(H.recall('businessRecall', { by: 'specificity', limit: 10 }))
  .readBy(procurement, accountManager);

export const business = H.harness('business')
  .ledger(sqlite.ledger({ path: 'state/ledger.db' }))
  .pools(pool)
  .lanes(experiments, tenancies, negotiations)
  .journals(businessExperience)
  .triggers(negotiationExpiry)
  .scheduler(
    H.scheduler('businessScheduler')
      .priority(negotiations, tenancies, experiments)
      .wip(tenancies, 3)
      .admit(experiments, ctx => {
        const outcomes = ctx.metrics.outcomes({ of: experiments, window: { lastDays: 180 } });
        const inconclusiveShare = outcomes.terminal === 0 ? 0 : outcomes.byState.Inconclusive / outcomes.terminal;
        return outcomes.terminal < 10 || inconclusiveShare < 0.5 || ctx.active(experiments) < 2;
      }),
  )
  .clients(
    http.controlApi('businessControl', {
      port: H.slot.port(3),
      token: H.env('CONTROL_TOKEN'),
      grants: [H.ops.workRead, H.ops.workCreate, H.ops.workSignal, H.ops.workCancel, H.ops.blockersResolve, H.ops.telemetryRead],
    }),
  )
  .observers(markdown.board({ path: 'BOARD.md' }), markdown.telemetry({ path: 'TELEMETRY.md' }));
