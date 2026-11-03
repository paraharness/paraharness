import { z } from 'zod';
import { H } from 'harness-dsl';
import * as sqlite from 'harness-dsl/sqlite';
import * as anthropic from 'harness-dsl/anthropic';
import * as claudeCode from 'harness-dsl/claude-code';
import * as http from 'harness-dsl/http';
import * as markdown from 'harness-dsl/markdown';
import * as local from 'harness-dsl/local';

const shell = local.shell({ slots: 4 });
const apiAccount = anthropic.account('operations-api', { apiKey: H.env('ANTHROPIC_API_KEY') });
const writerModel = anthropic.model('claude-sonnet-4-5');

const SampleDue = H.state('SampleDue', 'pending');
const Sampling = H.state('Sampling', 'active');
const Observing = H.state('Observing', 'waiting');
const AWins = H.state('AWins', 'terminal', 'success');
const BWins = H.state('BWins', 'terminal', 'success');
const Inconclusive = H.state('Inconclusive', 'terminal', 'neutral');

const Experiment = H.work('Experiment')
  .attributes({ experimentId: z.string(), metric: z.string() })
  .states([SampleDue, Sampling, Observing, AWins, BWins, Inconclusive])
  .timers(() => ({ hourly: H.time.every({ hours: 1 }) }))
  .key(u => u.attributes.experimentId);

const measure = H.command('measure-experiment', ['scripts/measure-experiment.sh']).parses({
  elapsedHours: z.number(),
  aRate: z.number(),
  bRate: z.number(),
  pValue: z.number(),
});

function conclude(sample: { elapsedHours: number; aRate: number; bRate: number; pValue: number }): 'observing' | 'aWins' | 'bWins' | 'inconclusive' {
  if (sample.elapsedHours < 14 * 24) return 'observing';
  if (sample.pValue >= 0.05) return 'inconclusive';
  return sample.aRate > sample.bRate ? 'aWins' : 'bWins';
}

const sampleExperiment = H.flow('sample-experiment')
  .requires({ experimentId: z.string(), metric: z.string() })
  .step('sample', measure, c => ({ args: [c.input.experimentId, c.input.metric, String(c.unit.createdAt)] }), { restart: 'rerun' })
  .ends(['observing', 'aWins', 'bWins', 'inconclusive'], c => conclude(c.out.sample.data));

const experiments = H.lane('experiments', Experiment)
  .supply([H.supply.operator()])
  .runner(shell)
  .handler(sampleExperiment, {
    states: { observing: Observing, aWins: AWins, bWins: BWins, inconclusive: Inconclusive },
    opens: Sampling,
  })
  .reacts({ hourly: H.reaction(SampleDue).from([Observing]) });

const Customer = H.state('Customer', 'waiting');
const ReviewDue = H.state('ReviewDue', 'pending');
const Reviewing = H.state('Reviewing', 'active');
const Suspended = H.state('Suspended', 'waiting');
const Churned = H.state('Churned', 'terminal', 'neutral');

const Tenancy = H.work('Tenancy')
  .attributes({ customerId: z.string(), plan: z.string() })
  .states([Customer, ReviewDue, Reviewing, Suspended, Churned])
  .events({ suspended: {}, reinstated: {}, churned: {} })
  .timers(() => ({ monthlyReview: H.time.monthly(1, '09:00', 'Europe/London') }))
  .key(u => u.attributes.customerId);

const usage = H.command('tenancy-usage', ['scripts/tenancy-usage.sh']).parses({
  seats: z.number(),
  spendUsd: z.number(),
  trend: z.string(),
});

const accountReviewer = H.role('account-reviewer')
  .intents(['read'])
  .input({ customerId: z.string(), plan: z.string(), seats: z.number(), spendUsd: z.number(), trend: z.string() })
  .output({ summary: z.string(), upsellCase: z.string() });
const tenancySummarizer = H.agent('tenancy-summarizer', accountReviewer).model(writerModel).pool(apiAccount);

const upsell = H.decision('upsell', { upsell: z.boolean(), note: z.string() });

const reviewTenancy = H.flow('review-tenancy')
  .requires({ customerId: z.string(), plan: z.string() })
  .step('usage', usage, c => ({ args: [c.input.customerId] }), { restart: 'rerun' })
  .step('summary', tenancySummarizer, c => ({
    customerId: c.input.customerId,
    plan: c.input.plan,
    seats: c.out.usage.data.seats,
    spendUsd: c.out.usage.data.spendUsd,
    trend: c.out.usage.data.trend,
  }))
  .halt('upsell', upsell, { ask: c => `${c.input.customerId} on ${c.input.plan}\n${c.out.summary.summary}\nCase: ${c.out.summary.upsellCase}\nUpsell?` })
  .ends(['reviewed'], () => 'reviewed');

const billingEvent = z.object({
  customerId: z.string(),
  plan: z.string(),
  type: z.enum(['signed', 'suspended', 'reinstated', 'churned']),
});

const tenancies = H.lane('tenancies', Tenancy)
  .supply([
    H.supply.operator(),
    http.webhook(Tenancy, { path: '/billing', port: H.slot.port(1), secret: H.env('BILLING_WEBHOOK_SECRET'), body: billingEvent }, (body, supply) =>
      body.type === 'signed'
        ? supply.create({ attributes: { customerId: body.customerId, plan: body.plan } })
        : supply.event(body.customerId, body.type, {})),
  ])
  .runner(shell)
  .handler(reviewTenancy, { states: { reviewed: Customer }, opens: Reviewing })
  .reacts({
    monthlyReview: H.reaction(ReviewDue).from([Customer]),
    suspended: H.reaction(Suspended).from([Customer, ReviewDue, Reviewing]).cancels(),
    reinstated: H.reaction(Customer).from([Suspended]),
    churned: H.reaction(Churned).from([Customer, ReviewDue, Reviewing, Suspended]).cancels(),
  });

const RoundDue = H.state('RoundDue', 'pending');
const Drafting = H.state('Drafting', 'active');
const AwaitingVendor = H.state('AwaitingVendor', 'waiting');
const Agreed = H.state('Agreed', 'terminal', 'success');
const WalkedAway = H.state('WalkedAway', 'terminal', 'neutral');
const VendorWalkedAway = H.state('VendorWalkedAway', 'terminal', 'failure');
const Expired = H.state('Expired', 'terminal', 'failure');

const Negotiation = H.work('Negotiation')
  .attributes({ negotiationId: z.string(), vendor: z.string(), item: z.string(), targetUsd: z.number(), expiresAt: z.number() })
  .states([RoundDue, Drafting, AwaitingVendor, Agreed, WalkedAway, VendorWalkedAway, Expired])
  .events({
    vendorReplied: { amountUsd: z.number(), message: z.string() },
    vendorAccepted: { amountUsd: z.number() },
    vendorWalkedAway: { reason: z.string() },
  })
  .timers(t => ({ expires: t.attribute('expiresAt') }))
  .key(u => u.attributes.negotiationId);

const negotiatorRole = H.role('negotiator')
  .intents(['read'])
  .input({ vendor: z.string(), item: z.string(), targetUsd: z.number(), round: z.number(), replies: z.array(z.string()) })
  .output({ action: z.enum(['offer', 'walkAway']), amountUsd: z.number(), message: z.string() });
const negotiator = H.agent('negotiator', negotiatorRole).model(writerModel).pool(apiAccount);

const sendOffer = H.command('send-offer', ['scripts/send-offer.sh']);

const negotiationRound = H.flow('negotiation-round')
  .requires({ negotiationId: z.string(), vendor: z.string(), item: z.string(), targetUsd: z.number() })
  .events({ vendorReplied: { amountUsd: z.number(), message: z.string() } })
  .step('offer', negotiator, c => ({
    vendor: c.input.vendor,
    item: c.input.item,
    targetUsd: c.input.targetUsd,
    round: c.attempt.number,
    replies: c.events.vendorReplied.map(reply => `${reply.payload.amountUsd} USD: ${reply.payload.message}`),
  }))
  .exit('walkedAway', c => c.out.offer.action === 'walkAway')
  .step('send', sendOffer, c => ({ args: [c.input.negotiationId, String(c.out.offer.amountUsd)], stdin: c.out.offer.message }), { restart: 'escalate' })
  .ends(['awaitingVendor'], () => 'awaitingVendor');

const vendorMessage = z.object({
  negotiationId: z.string(),
  type: z.enum(['offer', 'accept', 'walkaway']),
  amountUsd: z.number(),
  message: z.string(),
});

const negotiations = H.lane('negotiations', Negotiation)
  .supply([
    H.supply.operator(),
    http.webhook(Negotiation, { path: '/vendor', port: H.slot.port(1), secret: H.env('VENDOR_WEBHOOK_SECRET'), body: vendorMessage }, (body, supply) =>
      body.type === 'offer'
        ? supply.event(body.negotiationId, 'vendorReplied', { amountUsd: body.amountUsd, message: body.message })
        : body.type === 'accept'
          ? supply.event(body.negotiationId, 'vendorAccepted', { amountUsd: body.amountUsd })
          : supply.event(body.negotiationId, 'vendorWalkedAway', { reason: body.message })),
  ])
  .runner(shell)
  .handler(negotiationRound, { states: { walkedAway: WalkedAway, awaitingVendor: AwaitingVendor }, opens: Drafting })
  .reacts({
    vendorReplied: H.reaction(RoundDue).from([AwaitingVendor]),
    vendorAccepted: H.reaction(Agreed).from([AwaitingVendor, RoundDue, Drafting]).cancels(),
    vendorWalkedAway: H.reaction(VendorWalkedAway).from([AwaitingVendor, RoundDue, Drafting]).cancels(),
    expires: H.reaction(Expired).from([AwaitingVendor, RoundDue, Drafting]).cancels(),
  });

const schedule = H.policy.schedule('rounds-reviews-then-experiments', c => {
  const inconclusive = c.metrics.outcomes({ kind: Experiment, window: { days: 180 } }).share(Inconclusive);
  const experimentsLast = inconclusive.n >= 10 && inconclusive.rate !== null && inconclusive.rate > 0.5;
  return {
    start: c.order(
      x => (x.is(negotiations) ? 0 : x.is(tenancies) ? 1 : experimentsLast ? 3 : 2),
      x => x.enqueuedAt,
    ),
  };
});

const desk = H.access('commercial-desk').allows([
  H.ops.readWork,
  H.ops.createWork,
  H.ops.sendEvents,
  H.ops.resolveBlocks,
  H.ops.manageAttempts,
  H.ops.readTelemetry,
]);

export const lifecycles = H.harness('lifecycles')
  .ledger(sqlite.ledger('.harness/ledger.sqlite'))
  .lanes([experiments, tenancies, negotiations])
  .schedule(schedule)
  .clients([claudeCode.supervisor('commercial-supervisor', desk, { port: H.slot.port(0) })])
  .projections([markdown.board('BOARD.md'), markdown.telemetry('TELEMETRY.md')]);
