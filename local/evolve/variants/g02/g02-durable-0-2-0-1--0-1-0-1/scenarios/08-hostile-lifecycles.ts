import { z } from 'zod';
import { H } from 'harness-dsl';
import { sqlite } from 'harness-dsl/sqlite';
import { anthropic } from 'harness-dsl/anthropic';
import { local } from 'harness-dsl/local';
import { http } from 'harness-dsl/http';
import { webhook } from 'harness-dsl/webhook';
import { markdown } from 'harness-dsl/markdown';

const quota = sqlite.quota('procurement-quota', { path: '.harness/quota.sqlite' });
const apiAccount = anthropic.account('api', { apiKey: H.env('ANTHROPIC_API_KEY'), quota });
const sonnet = anthropic.model('sonnet', { id: 'claude-sonnet-4-5' });
const pool = H.pool('api').accounts(apiAccount);
const runner = local.runner('local').slots(4);
const harnessStore = sqlite.store({ path: '.harness/units.sqlite' });
const resume = H.signal('resume');
const Withdrawn = H.terminal('withdrawn', 'neutral');

const experimentAttrs = z.object({ experimentId: z.string(), hypothesis: z.string(), metric: z.string() });
const ExperimentProposed = H.state('experiment-proposed', 'pending');
const Measuring = H.state('measuring', 'active');
const Collecting = H.state('collecting', 'waiting');
const Analysing = H.state('analysing', 'active');
const ExperimentStalled = H.state('experiment-stalled', 'waiting');
const AWon = H.terminal('a-won', 'success');
const BWon = H.terminal('b-won', 'success');
const Inconclusive = H.terminal('inconclusive', 'neutral');

const Experiment = H.kind('Experiment')
  .attributes(experimentAttrs)
  .states(ExperimentProposed, Measuring, Collecting, Analysing, ExperimentStalled, AWon, BWon, Inconclusive, Withdrawn)
  .key(a => a.experimentId);

const measure = H.command('measure-experiment')
  .input(z.object({ experimentId: z.string(), metric: z.string() }))
  .argv(i => ['./scripts/measure', i.experimentId, i.metric])
  .output(z.object({ a: z.number(), b: z.number() }))
  .runner(runner);

const analyse = H.command('analyse-experiment')
  .input(z.object({ experimentId: z.string() }))
  .argv(i => ['./scripts/analyse', i.experimentId])
  .output(z.object({ winner: z.enum(['a', 'b', 'none']) }))
  .runner(runner);

const runExperiment = H.flow('run-experiment')
  .input(experimentAttrs)
  .loop(
    'hours',
    hour =>
      hour
        .step('measure', measure, ctx => ({ experimentId: ctx.unit.attributes.experimentId, metric: ctx.unit.attributes.metric }))
        .wait('next-hour', { ms: 3_600_000 }),
    { max: 14 * 24 },
  )
  .step('analyse', analyse, ctx => ({ experimentId: ctx.unit.attributes.experimentId }))
  .exit('aWins', ctx => ctx.steps.analyse.winner === 'a')
  .exit('bWins', ctx => ctx.steps.analyse.winner === 'b')
  .exit('inconclusive');

const experimentLane = H.lane('experiments', Experiment)
  .supply(H.operator)
  .store(harnessStore)
  .handler(runExperiment, {
    exits: { aWins: AWon, bWins: BWon, inconclusive: Inconclusive },
    during: { measure: Measuring, 'next-hour': Collecting, analyse: Analysing },
  })
  .retry({ maxAttempts: 3, backoff: 'exponential', initialDelayMs: 600_000, exhausted: ExperimentStalled })
  .on(resume, { enter: ExperimentProposed })
  .on(H.cancel, { enter: Withdrawn });

const tenancyAttrs = z.object({ customerId: z.string(), plan: z.string() });
const Customer = H.state('customer', 'waiting');
const ReviewDue = H.state('review-due', 'pending');
const Reviewing = H.state('reviewing', 'active');
const AwaitingUpsellDecision = H.state('awaiting-upsell-decision', 'waiting');
const Upsold = H.state('upsold', 'waiting');
const Suspended = H.state('suspended', 'waiting');
const ReviewFailed = H.state('review-failed', 'waiting');
const Churned = H.terminal('churned', 'neutral');

const Tenancy = H.kind('Tenancy')
  .attributes(tenancyAttrs)
  .states(Customer, ReviewDue, Reviewing, AwaitingUpsellDecision, Upsold, Suspended, ReviewFailed, Churned)
  .key(a => a.customerId);

const monthlyReview = H.signal('monthly-review');
const suspend = H.signal('suspend');
const reinstate = H.signal('reinstate');
const churn = H.signal('churn');

const usageReport = H.command('usage-report')
  .input(z.object({ customerId: z.string() }))
  .argv(i => ['./scripts/usage', i.customerId])
  .output(z.object({ seats: z.number(), usageUsd: z.number(), trend: z.string() }))
  .runner(runner);

const accountManager = H.role('account-manager').intents('read').instructions('Summarise a customer month for an upsell decision.');
const tenancySummarizer = H.seat('tenancy-summarizer').role(accountManager).model(sonnet).pool(pool);
const upsellDecision = H.halt('upsell-decision').decision(z.object({ action: z.enum(['upsell', 'hold']), note: z.string() }));

const monthlyReviewFlow = H.flow('monthly-review')
  .input(tenancyAttrs)
  .step('usage', usageReport, ctx => ({ customerId: ctx.unit.attributes.customerId }))
  .step('summary', tenancySummarizer, ctx => ({
    task: `Summarise the month for ${ctx.unit.attributes.customerId} on ${ctx.unit.attributes.plan}: ${ctx.steps.usage.seats} seats, $${ctx.steps.usage.usageUsd}, trend ${ctx.steps.usage.trend}.`,
  }))
  .halt('decide', upsellDecision, { ask: ctx => `Upsell ${ctx.unit.attributes.customerId}?\n${ctx.steps.summary}` })
  .exit('upsell', ctx => ctx.steps.decide.action === 'upsell')
  .exit('hold');

const tenancyLane = H.lane('tenancies', Tenancy)
  .supply(H.operator)
  .supply(H.clock('first-of-month').at('09:00', { on: 1, tz: 'Europe/Berlin' }), (_, to) =>
    to.signal(monthlyReview, { states: [Customer, Upsold, ReviewFailed] }, {}),
  )
  .store(harnessStore)
  .handler(monthlyReviewFlow, {
    exits: { upsell: Upsold, hold: Customer },
    during: { usage: Reviewing, summary: Reviewing, decide: AwaitingUpsellDecision },
  })
  .retry({ maxAttempts: 3, backoff: 'exponential', initialDelayMs: 3_600_000, exhausted: ReviewFailed })
  .on(monthlyReview, { enter: ReviewDue })
  .on(suspend, { enter: Suspended })
  .on(reinstate, { enter: Customer })
  .on(churn, { enter: Churned });

const negotiationAttrs = z.object({
  negotiationId: z.string(),
  vendor: z.string(),
  item: z.string(),
  targetUsd: z.number(),
  expiresAt: z.string(),
  vendorMessages: z.array(z.string()),
});
const OurMove = H.state('our-move', 'pending');
const Composing = H.state('composing', 'active');
const Sending = H.state('sending', 'active');
const TheirMove = H.state('their-move', 'waiting');
const NegotiationStalled = H.state('negotiation-stalled', 'waiting');
const Agreed = H.terminal('agreed', 'success');
const WeWalkedAway = H.terminal('we-walked-away', 'neutral');
const TheyWalkedAway = H.terminal('they-walked-away', 'neutral');
const Expired = H.terminal('expired', 'neutral');

const Negotiation = H.kind('Negotiation')
  .attributes(negotiationAttrs)
  .states(OurMove, Composing, Sending, TheirMove, NegotiationStalled, Agreed, WeWalkedAway, TheyWalkedAway, Expired, Withdrawn)
  .key(a => a.negotiationId);

const vendorCountered = H.signal('vendor-countered').payload(z.object({ message: z.string() }));
const vendorAccepted = H.signal('vendor-accepted');
const vendorWalkedAway = H.signal('vendor-walked-away');
const expire = H.signal('expire');

const vendorReplies = webhook.json('vendor-replies', {
  port: H.slot.port(2),
  path: '/vendor-replies',
  secret: H.env('VENDOR_WEBHOOK_SECRET'),
  payload: z.object({ negotiationId: z.string(), reply: z.enum(['counter', 'accept', 'walkAway']), message: z.string() }),
});

const negotiatorRole = H.role('negotiator').intents('read').instructions('Draft the next procurement move; walk away when the deal cannot meet target.');
const negotiator = H.seat('negotiator')
  .role(negotiatorRole)
  .model(sonnet)
  .pool(pool)
  .output(z.object({ move: z.enum(['offer', 'walkAway']), offerUsd: z.number(), message: z.string() }));

const sendOffer = H.command('send-offer')
  .input(z.object({ vendor: z.string(), message: z.string() }))
  .argv(i => ['./scripts/send-offer', i.vendor, i.message])
  .runner(runner);

const negotiationRound = H.flow('negotiation-round')
  .input(negotiationAttrs)
  .step('draft', negotiator, ctx => ({
    task: `Next move with ${ctx.unit.attributes.vendor} for ${ctx.unit.attributes.item}, target $${ctx.unit.attributes.targetUsd}. Vendor so far: ${ctx.unit.attributes.vendorMessages.join(' | ') || 'nothing yet'}`,
  }))
  .exit('walkAway', ctx => ctx.steps.draft.move === 'walkAway')
  .step('send', sendOffer, ctx => ({ vendor: ctx.unit.attributes.vendor, message: ctx.steps.draft.message }), { afterCrash: 'park' })
  .exit('offered');

const negotiationLane = H.lane('negotiations', Negotiation)
  .supply(H.operator)
  .supply(vendorReplies, (reply, to) =>
    reply.reply === 'accept'
      ? to.signal(vendorAccepted, reply.negotiationId, {})
      : reply.reply === 'walkAway'
        ? to.signal(vendorWalkedAway, reply.negotiationId, {})
        : to.signal(vendorCountered, reply.negotiationId, { message: reply.message }),
  )
  .store(harnessStore)
  .handler(negotiationRound, { exits: { walkAway: WeWalkedAway, offered: TheirMove }, during: { draft: Composing, send: Sending } })
  .retry({ maxAttempts: 3, backoff: 'exponential', initialDelayMs: 300_000, exhausted: NegotiationStalled })
  .on(vendorCountered, { update: (a, p) => ({ ...a, vendorMessages: [...a.vendorMessages, p.message] }), enter: OurMove })
  .on(vendorAccepted, { enter: Agreed })
  .on(vendorWalkedAway, { enter: TheyWalkedAway })
  .on(expire, { enter: Expired })
  .on(resume, { enter: OurMove })
  .on(H.cancel, { enter: Withdrawn });

const negotiationExpiry = H.trigger('negotiation-expiry')
  .on(H.when.timer(negotiationLane, u => new Date(u.attributes.expiresAt)))
  .signal(expire, negotiationLane, e => ({ key: e.unit.key, payload: {} }));

const operations = http.controlApi('operations', {
  port: H.slot.port(1),
  token: H.env('CONTROL_API_TOKEN'),
  grants: [
    H.ops.workRead,
    H.ops.workCreate,
    H.ops.resolve(upsellDecision),
    H.ops.signal(suspend),
    H.ops.signal(reinstate),
    H.ops.signal(churn),
    H.ops.signal(resume),
    H.ops.signal(H.cancel),
    H.ops.telemetryRead,
  ],
});

export const harness = H.harness('business')
  .ledger(sqlite.ledger({ path: '.harness/ledger.sqlite' }))
  .lanes(experimentLane, tenancyLane, negotiationLane)
  .triggers(negotiationExpiry)
  .scheduler(
    H.scheduler('business-scheduler')
      .priority(negotiationLane, tenancyLane, experimentLane)
      .admit(experimentLane, ({ metrics }) => {
        const outcomes = metrics.outcomes({ of: Experiment, window: { lastDays: 180 } });
        return outcomes.terminal < 10 || outcomes.byState.inconclusive / outcomes.terminal < 0.6;
      }),
  )
  .clients(operations)
  .observers(markdown.board({ path: 'BOARD.md' }), markdown.telemetry({ path: 'TELEMETRY.md' }));

void harness.start();
