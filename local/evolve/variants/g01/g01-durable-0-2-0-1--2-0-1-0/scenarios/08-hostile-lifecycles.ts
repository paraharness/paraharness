import { z } from 'zod';
import { H } from 'harness-dsl';
import { sqlite } from 'harness-dsl/sqlite';
import { anthropic } from 'harness-dsl/anthropic';
import { local } from 'harness-dsl/local';
import { webhook } from 'harness-dsl/webhook';
import { http } from 'harness-dsl/http';
import { markdown } from 'harness-dsl/markdown';

const quota = sqlite.quota('lifecycles-quota', { path: './.harness/quota.sqlite' });
const api = anthropic.account('api', { apiKey: H.env('ANTHROPIC_API_KEY'), quota });
const sonnet = anthropic.model('sonnet', { id: 'claude-sonnet-4-5' });
const firstEligible = H.policy.account('first-eligible', ctx =>
  ctx.candidates.find(c => c.cooldownUntil === undefined || c.cooldownUntil <= ctx.now),
);
const pool = H.pool('api-pool').accounts(api).drain(firstEligible);
const runner = local.runner('local');
const unitStore = sqlite.store({ path: './.harness/units.sqlite' });

const ExperimentQueued = H.state('ExperimentQueued', 'pending');
const Measuring = H.state('Measuring', 'active');
const Observing = H.state('Observing', 'waiting');
const Analyzing = H.state('Analyzing', 'active');
const AWins = H.terminal('AWins', 'success');
const BWins = H.terminal('BWins', 'success');
const Inconclusive = H.terminal('Inconclusive', 'neutral');
const ExperimentAborted = H.terminal('ExperimentAborted', 'failure');

const Experiment = H.kind('Experiment')
  .attributes(z.object({ experimentId: z.string(), hypothesis: z.string() }))
  .states(ExperimentQueued, Measuring, Observing, Analyzing, AWins, BWins, Inconclusive, ExperimentAborted)
  .key(a => a.experimentId)
  .initial(ExperimentQueued);

const measure = H.command('measure-experiment')
  .input(z.object({ experimentId: z.string(), hour: z.number() }))
  .argv(i => ['./bin/measure', i.experimentId, String(i.hour)])
  .runner(runner);

const analyze = H.command('analyze-experiment')
  .input(z.object({ experimentId: z.string() }))
  .argv(i => ['./bin/analyze', i.experimentId])
  .output(z.object({ winner: z.enum(['a', 'b', 'none']) }))
  .runner(runner);

const hoursInTwoWeeks = 14 * 24;

const experimentFlow = H.flow('experiment')
  .input(z.object({ experimentId: z.string() }))
  .loop(
    'hourly',
    f =>
      f
        .step('measure', measure, ctx => ({ experimentId: ctx.unit.attributes.experimentId, hour: ctx.iteration }), {
          retry: { maxAttempts: 3, backoff: 'exponential', initialDelayMs: 30000 },
          afterCrash: 'rerun',
        })
        .wait('nextHour', { ms: 3600000 }),
    { max: hoursInTwoWeeks },
  )
  .step('analyze', analyze, ctx => ({ experimentId: ctx.unit.attributes.experimentId }))
  .exit('aWins', ctx => ctx.steps.analyze.winner === 'a')
  .exit('bWins', ctx => ctx.steps.analyze.winner === 'b')
  .exit('inconclusive');

const experiments = H.lane('experiments', Experiment)
  .supply(H.operator)
  .store(unitStore)
  .handler(experimentFlow, {
    exits: { aWins: AWins, bWins: BWins, inconclusive: Inconclusive },
    during: { measure: Measuring, nextHour: Observing, analyze: Analyzing },
  })
  .retry({ maxAttempts: 2, backoff: 'fixed', initialDelayMs: 600000, exhausted: ExperimentAborted });

const ReviewDue = H.state('ReviewDue', 'pending');
const Reviewing = H.state('Reviewing', 'active');
const AwaitingUpsellDecision = H.state('AwaitingUpsellDecision', 'waiting');
const Customer = H.state('Customer', 'waiting');
const Suspended = H.state('Suspended', 'waiting');
const Churned = H.terminal('Churned', 'neutral');

const Tenancy = H.kind('Tenancy')
  .attributes(z.object({ tenantId: z.string(), plan: z.string() }))
  .states(ReviewDue, Reviewing, AwaitingUpsellDecision, Customer, Suspended, Churned)
  .key(a => a.tenantId)
  .initial(Customer);

const monthlyReview = H.signal('monthly-review');
const suspend = H.signal('suspend');
const reinstate = H.signal('reinstate');
const churn = H.signal('churn');

const usageReport = H.command('usage-report')
  .input(z.object({ tenantId: z.string() }))
  .argv(i => ['./bin/usage', i.tenantId])
  .output(z.object({ seats: z.number(), usageUsd: z.number() }))
  .runner(runner);

const analystRole = H.role('account-analyst').intents('read').instructions('Summarize a tenant month for an upsell decision.');
const analyst = H.seat('account-analyst').role(analystRole).model(sonnet).pool(pool);
const upsellDecision = H.halt('upsell-decision').decision(z.object({ upsell: z.boolean(), note: z.string() }));

const tenancyReview = H.flow('tenancy-review')
  .input(z.object({ tenantId: z.string(), plan: z.string() }))
  .step('usage', usageReport, ctx => ({ tenantId: ctx.unit.attributes.tenantId }))
  .step('summary', analyst, ctx => ({
    task: `Tenant ${ctx.unit.attributes.tenantId} on ${ctx.unit.attributes.plan}: ${ctx.steps.usage.seats} seats, ${ctx.steps.usage.usageUsd} USD.`,
  }))
  .halt('decide', upsellDecision, { ask: ctx => ctx.steps.summary })
  .exit('upsell', ctx => ctx.steps.decide.upsell)
  .exit('hold');

const billing = webhook.json('billing', {
  port: H.slot.port(1),
  path: '/billing',
  secret: H.env('BILLING_SECRET'),
  payload: z.object({ event: z.enum(['signup', 'suspend', 'reinstate', 'churn']), tenantId: z.string(), plan: z.string() }),
});

const tenancies = H.lane('tenancies', Tenancy)
  .supply(billing, (e, to) => {
    switch (e.event) {
      case 'signup':
        return to.create({ tenantId: e.tenantId, plan: e.plan });
      case 'suspend':
        return to.signal(suspend, e.tenantId, {});
      case 'reinstate':
        return to.signal(reinstate, e.tenantId, {});
      case 'churn':
        return to.signal(churn, e.tenantId, {});
    }
  })
  .supply(H.clock('monthly-review').at('09:00', { on: 1, tz: 'UTC' }), (tick, to) =>
    to.signal(monthlyReview, unit => unit.state === 'Customer', {}),
  )
  .store(unitStore)
  .handler(tenancyReview, {
    exits: { upsell: Customer, hold: Customer },
    during: { usage: Reviewing, summary: Reviewing, decide: AwaitingUpsellDecision },
  })
  .retry({ maxAttempts: 3, backoff: 'exponential', initialDelayMs: 3600000, exhausted: Customer })
  .on(monthlyReview, { enter: ReviewDue })
  .on(suspend, { enter: Suspended })
  .on(reinstate, { enter: Customer })
  .on(churn, { enter: Churned });

const Opening = H.state('Opening', 'pending');
const Countering = H.state('Countering', 'pending');
const Drafting = H.state('Drafting', 'active');
const SendingOffer = H.state('SendingOffer', 'active');
const AwaitingVendor = H.state('AwaitingVendor', 'waiting');
const Stalled = H.state('Stalled', 'waiting');
const Agreed = H.terminal('Agreed', 'success');
const WeWalkedAway = H.terminal('WeWalkedAway', 'neutral');
const TheyWalkedAway = H.terminal('TheyWalkedAway', 'neutral');
const Expired = H.terminal('Expired', 'neutral');

const negotiationTerms = z.object({
  negotiationId: z.string(),
  vendor: z.string(),
  item: z.string(),
  ceilingUsd: z.number(),
  lastVendorOffer: z.number().optional(),
  lastVendorMessage: z.string().optional(),
});

const Negotiation = H.kind('Negotiation')
  .attributes(negotiationTerms.extend({ deadline: z.string() }))
  .states(Opening, Countering, Drafting, SendingOffer, AwaitingVendor, Stalled, Agreed, WeWalkedAway, TheyWalkedAway, Expired)
  .key(a => a.negotiationId)
  .initial(Opening);

const vendorCountered = H.signal('vendor-countered').payload(z.object({ offerUsd: z.number(), message: z.string() }));
const vendorAccepted = H.signal('vendor-accepted').payload(z.object({ offerUsd: z.number() }));
const vendorWalkedAway = H.signal('vendor-walked-away').payload(z.object({ message: z.string() }));
const expire = H.signal('expire');

const negotiatorRole = H.role('negotiator').intents('read').instructions('Draft the next procurement offer, or accept, or walk away.');
const negotiator = H.seat('negotiator')
  .role(negotiatorRole)
  .model(sonnet)
  .pool(pool)
  .output(z.object({ action: z.enum(['offer', 'accept', 'walkAway']), amountUsd: z.number(), message: z.string() }));

const sendToVendor = H.command('send-to-vendor')
  .input(z.object({ negotiationId: z.string(), message: z.string() }))
  .argv(i => ['./bin/send-vendor', i.negotiationId, i.message])
  .runner(runner);

const vendorMessageDelivered = H.command('vendor-message-delivered')
  .input(z.object({ negotiationId: z.string(), message: z.string() }))
  .argv(i => ['./bin/vendor-delivered', i.negotiationId])
  .output(z.boolean())
  .runner(runner);

const negotiationRound = H.flow('negotiation-round')
  .input(negotiationTerms)
  .step('draft', negotiator, ctx => ({
    task: `Negotiate ${ctx.unit.attributes.item} with ${ctx.unit.attributes.vendor}, ceiling ${ctx.unit.attributes.ceilingUsd} USD. Vendor last offered ${ctx.unit.attributes.lastVendorOffer ?? 'nothing'}: ${ctx.unit.attributes.lastVendorMessage ?? ''}`,
  }))
  .step('send', sendToVendor, ctx => ({ negotiationId: ctx.unit.attributes.negotiationId, message: ctx.steps.draft.message }), {
    afterCrash: 'park',
    alreadyDone: vendorMessageDelivered,
  })
  .exit('agreed', ctx => ctx.steps.draft.action === 'accept')
  .exit('walkedAway', ctx => ctx.steps.draft.action === 'walkAway')
  .exit('offered');

const vendorReplies = webhook.json('vendor-replies', {
  port: H.slot.port(2),
  path: '/vendor',
  secret: H.env('VENDOR_SECRET'),
  payload: z.object({
    negotiationId: z.string(),
    reply: z.enum(['counter', 'accept', 'walkAway']),
    offerUsd: z.number(),
    message: z.string(),
  }),
});

const negotiations = H.lane('negotiations', Negotiation)
  .supply(H.operator)
  .supply(vendorReplies, (r, to) => {
    switch (r.reply) {
      case 'counter':
        return to.signal(vendorCountered, r.negotiationId, { offerUsd: r.offerUsd, message: r.message });
      case 'accept':
        return to.signal(vendorAccepted, r.negotiationId, { offerUsd: r.offerUsd });
      case 'walkAway':
        return to.signal(vendorWalkedAway, r.negotiationId, { message: r.message });
    }
  })
  .store(unitStore)
  .handler(negotiationRound, {
    exits: { agreed: Agreed, walkedAway: WeWalkedAway, offered: AwaitingVendor },
    during: { draft: Drafting, send: SendingOffer },
  })
  .retry({ maxAttempts: 3, backoff: 'exponential', initialDelayMs: 600000, exhausted: Stalled })
  .on(vendorCountered, {
    update: (a, p) => ({ ...a, lastVendorOffer: p.offerUsd, lastVendorMessage: p.message }),
    enter: Countering,
  })
  .on(vendorAccepted, { update: (a, p) => ({ ...a, lastVendorOffer: p.offerUsd }), enter: Agreed })
  .on(vendorWalkedAway, { update: (a, p) => ({ ...a, lastVendorMessage: p.message }), enter: TheyWalkedAway })
  .on(expire, { enter: Expired });

const negotiationExpiry = H.trigger('negotiation-expiry')
  .on(H.when.timer(negotiations, { at: u => new Date(u.attributes.deadline) }))
  .signal(expire, negotiations, e => ({ key: e.unit.key, payload: {} }));

const scheduler = H.scheduler('lifecycles')
  .priority(negotiations, tenancies, experiments)
  .wip(experiments, 4)
  .wip(tenancies, 3)
  .wip(negotiations, 2)
  .admit(experiments, ctx => {
    const outcomes = ctx.metrics.outcomes({ of: experiments, window: { lastDays: 180 } });
    return outcomes.terminal < 10 || outcomes.byState.Inconclusive / outcomes.terminal < 0.5;
  });

void H.harness('lifecycles')
  .ledger(sqlite.ledger({ path: './.harness/ledger.sqlite' }))
  .lanes(experiments, tenancies, negotiations)
  .triggers(negotiationExpiry)
  .scheduler(scheduler)
  .clients(
    http.controlApi('operations', {
      port: H.slot.port(3),
      token: H.env('CONTROL_TOKEN'),
      grants: [H.ops.workRead, H.ops.workCreate, H.ops.workSignal, H.ops.telemetryRead, H.ops.resolve(upsellDecision)],
    }),
  )
  .observers(markdown.board({ path: './BOARD.md' }))
  .start();
