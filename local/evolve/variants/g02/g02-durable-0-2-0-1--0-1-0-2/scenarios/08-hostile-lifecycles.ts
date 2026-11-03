import { z } from 'zod';
import { H } from 'harness-dsl';
import { sqlite } from 'harness-dsl/sqlite';
import { anthropic } from 'harness-dsl/anthropic';
import { local } from 'harness-dsl/local';
import { webhook } from 'harness-dsl/webhook';
import { http } from 'harness-dsl/http';
import { markdown } from 'harness-dsl/markdown';

const store = sqlite.store({ path: 'data/units.sqlite' });
const quota = sqlite.quota('business-quota', { path: 'data/quota.sqlite' });
const apiAccount = anthropic.account('api', { apiKey: H.env('ANTHROPIC_API_KEY'), quota });
const sonnet = anthropic.model('sonnet', { id: 'claude-sonnet-4-5' });
const pool = H.pool('api').accounts(apiAccount);
const shell = local.runner('local').slots(4);

const Scheduled = H.state('Scheduled', 'pending');
const Measuring = H.state('Measuring', 'active');
const BetweenSamples = H.state('BetweenSamples', 'waiting');
const AWins = H.terminal('AWins', 'success');
const BWins = H.terminal('BWins', 'success');
const Inconclusive = H.terminal('Inconclusive', 'neutral');
const MeasurementBroken = H.terminal('MeasurementBroken', 'failure');

const experimentAttributes = z.object({ name: z.string(), metric: z.string(), hours: z.number() });

const Experiment = H.kind('Experiment')
  .attributes(experimentAttributes)
  .states(Scheduled, Measuring, BetweenSamples, AWins, BWins, Inconclusive, MeasurementBroken)
  .key(a => a.name)
  .initial(Scheduled);

const measureVariants = H.command('measure-variants')
  .input(z.object({ experiment: z.string(), metric: z.string() }))
  .argv(i => ['experiment-sample', i.experiment, i.metric])
  .output(z.object({ a: z.number(), b: z.number() }))
  .runner(shell);

const analyzeExperiment = H.command('analyze-experiment')
  .input(z.object({ experiment: z.string() }))
  .argv(i => ['experiment-analyze', i.experiment])
  .output(z.object({ winner: z.enum(['a', 'b', 'none']) }))
  .runner(shell);

const runExperiment = H.flow('run-experiment')
  .input(experimentAttributes)
  .loop(
    'hourly',
    f =>
      f
        .step(
          'measure',
          measureVariants,
          ctx => ({ experiment: ctx.unit.attributes.name, metric: ctx.unit.attributes.metric }),
          { retry: { maxAttempts: 3, backoff: 'exponential', initialDelayMs: 30000 }, afterCrash: 'rerun' },
        )
        .wait('hour', { ms: 3600000 }),
    { max: ctx => ctx.unit.attributes.hours },
  )
  .step('analyze', analyzeExperiment, ctx => ({ experiment: ctx.unit.attributes.name }), { afterCrash: 'rerun' })
  .exit('aWins', ctx => ctx.steps.analyze.winner === 'a')
  .exit('bWins', ctx => ctx.steps.analyze.winner === 'b')
  .exit('inconclusive');

const experiments = H.lane('experiments', Experiment)
  .supply(H.operator)
  .store(store)
  .handler(runExperiment, {
    exits: { aWins: AWins, bWins: BWins, inconclusive: Inconclusive },
    during: { measure: Measuring, analyze: Measuring, hour: BetweenSamples },
  })
  .retry({ maxAttempts: 3, backoff: 'exponential', initialDelayMs: 600000, exhausted: MeasurementBroken });

const ReviewDue = H.state('ReviewDue', 'pending');
const Reviewing = H.state('Reviewing', 'active');
const AwaitingUpsellDecision = H.state('AwaitingUpsellDecision', 'waiting');
const Upsold = H.state('Upsold', 'waiting');
const Retained = H.state('Retained', 'waiting');
const ReviewStalled = H.state('ReviewStalled', 'waiting');
const Suspended = H.state('Suspended', 'waiting');
const Churned = H.terminal('Churned', 'neutral');

const tenancyAttributes = z.object({ customer: z.string(), plan: z.string() });

const Tenancy = H.kind('Tenancy')
  .attributes(tenancyAttributes)
  .states(ReviewDue, Reviewing, AwaitingUpsellDecision, Upsold, Retained, ReviewStalled, Suspended, Churned)
  .key(a => a.customer)
  .initial(ReviewDue);

const usageReport = H.command('usage-report')
  .input(z.object({ customer: z.string() }))
  .argv(i => ['billing-usage', '--customer', i.customer, '--last-month'])
  .output(z.object({ usageUsd: z.number(), activeSeats: z.number() }))
  .runner(shell);

const accountReviewerRole = H.role('account-reviewer')
  .intents('read')
  .instructions('Summarise the customer month for an upsell decision, in five sentences.');

const accountReviewer = H.seat('account-reviewer')
  .output(z.object({ summary: z.string() }))
  .role(accountReviewerRole)
  .model(sonnet)
  .pool(pool);

const upsellDecision = H.halt('upsell-decision').decision(z.object({ upsell: z.boolean(), note: z.string() }));

const reviewTenancy = H.flow('review-tenancy')
  .input(tenancyAttributes)
  .step('usage', usageReport, ctx => ({ customer: ctx.unit.attributes.customer }), { afterCrash: 'rerun' })
  .step('summary', accountReviewer, ctx => ({
    task: `Customer ${ctx.unit.attributes.customer} on ${ctx.unit.attributes.plan}: ${ctx.steps.usage.usageUsd} USD, ${ctx.steps.usage.activeSeats} active seats.`,
  }), { afterCrash: 'askDriver' })
  .halt('decision', upsellDecision, { ask: ctx => ctx.steps.summary.summary })
  .exit('upsell', ctx => ctx.steps.decision.upsell)
  .exit('hold');

const monthlyReview = H.signal('monthly-review');
const suspend = H.signal('suspend').payload(z.object({ reason: z.string() }));
const reinstate = H.signal('reinstate');
const churn = H.signal('churn');

const tenancies = H.lane('tenancies', Tenancy)
  .supply(H.operator)
  .supply(H.clock('monthly').at('08:00', { on: 1, tz: 'Europe/Berlin' }), (tick, to) =>
    to.signal(monthlyReview, { inState: [Upsold, Retained, ReviewStalled] }, {}),
  )
  .store(store)
  .handler(reviewTenancy, {
    exits: { upsell: Upsold, hold: Retained },
    during: { usage: Reviewing, summary: Reviewing, decision: AwaitingUpsellDecision },
  })
  .retry({ maxAttempts: 3, backoff: 'exponential', initialDelayMs: 3600000, exhausted: ReviewStalled })
  .on(monthlyReview, { enter: ReviewDue })
  .on(suspend, { enter: Suspended, interrupt: true })
  .on(reinstate, { enter: ReviewDue })
  .on(churn, { enter: Churned });

const Countering = H.state('Countering', 'pending');
const Drafting = H.state('Drafting', 'active');
const AwaitingVendor = H.state('AwaitingVendor', 'waiting');
const Agreed = H.terminal('Agreed', 'success');
const WalkedAwayByUs = H.terminal('WalkedAwayByUs', 'neutral');
const WalkedAwayByThem = H.terminal('WalkedAwayByThem', 'failure');
const Expired = H.terminal('Expired', 'failure');
const NegotiationBroken = H.terminal('NegotiationBroken', 'failure');

const negotiationAttributes = z.object({
  id: z.string(),
  vendor: z.string(),
  item: z.string(),
  ceilingUsd: z.number(),
  deadline: z.string(),
  theirOfferUsd: z.number().optional(),
  theirTerms: z.string().optional(),
});

const Negotiation = H.kind('Negotiation')
  .attributes(negotiationAttributes)
  .states(Countering, Drafting, AwaitingVendor, Agreed, WalkedAwayByUs, WalkedAwayByThem, Expired, NegotiationBroken)
  .key(a => a.id)
  .initial(Countering);

const negotiatorRole = H.role('negotiator')
  .intents('read')
  .instructions('Draft the next procurement move. Never exceed the ceiling. Accept or walk away when the numbers say so.');

const negotiator = H.seat('negotiator')
  .output(z.object({ action: z.enum(['offer', 'accept', 'walkAway']), amountUsd: z.number(), message: z.string() }))
  .role(negotiatorRole)
  .model(sonnet)
  .pool(pool);

const sendToVendor = H.command('send-to-vendor')
  .input(z.object({ negotiation: z.string(), vendor: z.string(), message: z.string() }))
  .argv(i => ['vendor-mail', '--thread', i.negotiation, '--to', i.vendor, '--body', i.message])
  .runner(shell);

const negotiationRound = H.flow('negotiation-round')
  .input(negotiationAttributes)
  .step('draft', negotiator, ctx => ({
    task: `Negotiate ${ctx.unit.attributes.item} with ${ctx.unit.attributes.vendor}. Ceiling ${ctx.unit.attributes.ceilingUsd} USD. Their last offer: ${ctx.unit.attributes.theirOfferUsd ?? 'none'} USD, terms: ${ctx.unit.attributes.theirTerms ?? 'none'}.`,
  }), { afterCrash: 'askDriver' })
  .step('send', sendToVendor, ctx => ({
    negotiation: ctx.unit.attributes.id,
    vendor: ctx.unit.attributes.vendor,
    message: ctx.steps.draft.message,
  }), { afterCrash: 'park' })
  .exit('agreed', ctx => ctx.steps.draft.action === 'accept')
  .exit('walkedAway', ctx => ctx.steps.draft.action === 'walkAway')
  .exit('offered');

const vendorCountered = H.signal('vendor-countered').payload(z.object({ amountUsd: z.number(), terms: z.string() }));
const vendorAccepted = H.signal('vendor-accepted');
const vendorWalkedAway = H.signal('vendor-walked-away');
const negotiationExpired = H.signal('negotiation-expired');

const vendorReplies = webhook.json('vendor-replies', {
  port: H.slot.port(1),
  path: '/vendor-replies',
  secret: H.env('VENDOR_WEBHOOK_SECRET'),
  payload: z.discriminatedUnion('reply', [
    z.object({ reply: z.literal('counter'), negotiationId: z.string(), amountUsd: z.number(), terms: z.string() }),
    z.object({ reply: z.literal('accept'), negotiationId: z.string() }),
    z.object({ reply: z.literal('walkAway'), negotiationId: z.string() }),
  ]),
});

const negotiations = H.lane('negotiations', Negotiation)
  .supply(H.operator)
  .supply(vendorReplies, (reply, to) =>
    reply.reply === 'counter'
      ? to.signal(vendorCountered, reply.negotiationId, { amountUsd: reply.amountUsd, terms: reply.terms })
      : reply.reply === 'accept'
        ? to.signal(vendorAccepted, reply.negotiationId, {})
        : to.signal(vendorWalkedAway, reply.negotiationId, {}),
  )
  .store(store)
  .handler(negotiationRound, {
    exits: { agreed: Agreed, walkedAway: WalkedAwayByUs, offered: AwaitingVendor },
    during: { draft: Drafting, send: Drafting },
  })
  .retry({ maxAttempts: 3, backoff: 'exponential', initialDelayMs: 900000, exhausted: NegotiationBroken })
  .on(vendorCountered, {
    update: (attrs, counter) => ({ ...attrs, theirOfferUsd: counter.amountUsd, theirTerms: counter.terms }),
    enter: Countering,
  })
  .on(vendorAccepted, { enter: Agreed })
  .on(vendorWalkedAway, { enter: WalkedAwayByThem })
  .on(negotiationExpired, { enter: Expired });

const expiry = H.trigger('negotiation-expiry')
  .on(H.when.timer(negotiations, { at: unit => new Date(unit.attributes.deadline) }))
  .signal(negotiationExpired, negotiations, fired => ({ key: fired.unit.key, payload: {} }));

const scheduler = H.scheduler('business-scheduler')
  .priority(negotiations, tenancies, experiments)
  .wip(negotiations, 3)
  .wip(tenancies, 2)
  .admit(experiments, ctx => {
    const ended = ctx.metrics.outcomes({ of: experiments, window: { lastDays: 180 } });
    const inconclusiveShare = ended.samples === 0 ? 0 : ended.byState.Inconclusive / ended.samples;
    return ended.samples < 10 || inconclusiveShare < 0.5 || ctx.count(experiments, 'active', 'waiting') === 0;
  });

const harness = H.harness('lifecycles')
  .ledger(sqlite.ledger({ path: 'data/ledger.sqlite' }))
  .lanes(experiments, tenancies, negotiations)
  .triggers(expiry)
  .scheduler(scheduler)
  .clients(
    http.controlApi('operations', {
      port: H.slot.port(2),
      token: H.env('CONTROL_API_TOKEN'),
      grants: [
        H.ops.workRead,
        H.ops.workCreate,
        H.ops.workSignal,
        H.ops.attemptsRecover,
        H.ops.resolve(upsellDecision),
        H.ops.telemetryRead,
      ],
    }),
  )
  .observers(markdown.board({ path: 'data/board.md' }), markdown.telemetry({ path: 'data/telemetry.md' }));

void harness.start();
