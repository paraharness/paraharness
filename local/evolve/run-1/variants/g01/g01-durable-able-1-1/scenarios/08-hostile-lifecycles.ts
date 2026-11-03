import { z } from 'zod';
import { H } from 'harness-dsl';
import * as sqlite from 'harness-dsl/sqlite';
import * as anthropic from 'harness-dsl/anthropic';
import * as claudeCode from 'harness-dsl/claude-code';
import * as http from 'harness-dsl/http';
import * as markdown from 'harness-dsl/markdown';
import * as local from 'harness-dsl/local';

const api = anthropic.account('lifecycle-api', { apiKey: H.env('ANTHROPIC_API_KEY') });
const sonnet = anthropic.model('claude-sonnet-4-5');
const shell = local.shell({ slots: 4 });

const ExperimentScheduled = H.state.pending('ExperimentScheduled');
const ExperimentRunning = H.state.active('ExperimentRunning');
const AWins = H.state.terminal('AWins', 'success');
const BWins = H.state.terminal('BWins', 'success');
const Inconclusive = H.state.terminal('Inconclusive', 'neutral');
const ExperimentBroken = H.state.terminal('ExperimentBroken', 'failure');

const Experiment = H.work('Experiment')
  .attributes({ experimentId: z.string(), metric: z.string() })
  .states([ExperimentScheduled, ExperimentRunning, AWins, BWins, Inconclusive, ExperimentBroken])
  .key(experiment => experiment.attributes.experimentId);

const sampleMetric = H.command('sample-experiment-metric', ['./bin/sample-metric']);
const decideExperiment = H.command('decide-experiment', ['./bin/decide-experiment']).parses({
  winner: z.enum(['a', 'b', 'none']),
});

const experimentFlow = H.flow('two-week-experiment')
  .requires({ experimentId: z.string(), metric: z.string() })
  .mark('running')
  .loop(
    'hourly',
    { carry: {}, rounds: () => 24 * 14 },
    round =>
      round
        .step('sample', sampleMetric, c => ({ args: [c.input.experimentId, c.input.metric] }), {
          onRestart: 'rerun',
          retry: H.retry.fixed({ maxRetries: 2, delayMs: 60000 }),
        })
        .wait('nextHour', H.time.after({ hours: 1 })),
    () => ({}),
  )
  .step('decide', decideExperiment, c => ({ args: [c.input.experimentId] }), { onRestart: 'rerun' })
  .ends(['aWins', 'bWins', 'inconclusive'], c =>
    c.out.decide.data.winner === 'a' ? 'aWins' : c.out.decide.data.winner === 'b' ? 'bWins' : 'inconclusive',
  );

const experiments = H.lane('experiments', Experiment)
  .supply([H.supply.operator()])
  .store(sqlite.store(Experiment, '.harness/lifecycles.sqlite'))
  .runner(shell)
  .handler(experimentFlow, {
    states: { running: ExperimentRunning, aWins: AWins, bWins: BWins, inconclusive: Inconclusive, failed: ExperimentBroken },
  });

const Customer = H.state.waiting('Customer');
const ReviewDue = H.state.pending('ReviewDue');
const UnderReview = H.state.active('UnderReview');
const Suspended = H.state.waiting('Suspended');
const ReviewStuck = H.state.waiting('ReviewStuck');
const Churned = H.state.terminal('Churned', 'neutral');

const Tenancy = H.work('Tenancy')
  .attributes({ tenantId: z.string(), plan: z.string() })
  .states([Customer, ReviewDue, UnderReview, Suspended, ReviewStuck, Churned])
  .events({ suspend: { reason: z.string() }, reinstate: {}, churn: { reason: z.string() } })
  .timers(() => ({ monthlyReview: H.time.monthly(1, '09:00', 'UTC') }))
  .key(tenancy => tenancy.attributes.tenantId);

const usageReport = H.command('usage-report', ['./bin/usage-report']);

const accountReviewer = H.role('account-reviewer')
  .intents(['read'])
  .instructions('Summarise the month of usage for the account owner in five plain sentences, ending with an upsell opinion.')
  .input({ tenantId: z.string(), plan: z.string(), usage: z.string() })
  .output({ summary: z.string() });

const accountSummarizer = H.agent('account-summarizer', accountReviewer).model(sonnet).pool(api);

const tenancyReview = H.flow('monthly-tenancy-review')
  .requires({ tenantId: z.string(), plan: z.string() })
  .mark('reviewing')
  .step('usage', usageReport, c => ({ args: [c.input.tenantId] }), { onRestart: 'rerun' })
  .step('summary', accountSummarizer, c => ({ tenantId: c.input.tenantId, plan: c.input.plan, usage: c.out.usage.stdout }), { onRestart: 'reconcile' })
  .halt('upsellDecision', {
    ask: c => `Upsell ${c.input.tenantId} from ${c.input.plan}?\n\n${c.out.summary.summary}`,
    decision: { upsell: z.boolean(), note: z.string() },
  })
  .ends(['reviewed'], () => 'reviewed');

const billingEvent = z.object({
  type: z.enum(['signup', 'suspended', 'reinstated', 'churned']),
  tenantId: z.string(),
  plan: z.string(),
  reason: z.string(),
});

const tenancies = H.lane('tenancies', Tenancy)
  .supply([
    H.supply.operator(),
    http.webhook(Tenancy, { path: '/billing', port: H.slot.port(0), secret: H.env('BILLING_WEBHOOK_SECRET') }, body => {
      const parsed = billingEvent.safeParse(body);
      if (!parsed.success) return null;
      const billing = parsed.data;
      if (billing.type === 'signup') return { create: { attributes: { tenantId: billing.tenantId, plan: billing.plan } } };
      if (billing.type === 'suspended') return { key: billing.tenantId, event: 'suspend', payload: { reason: billing.reason } };
      if (billing.type === 'reinstated') return { key: billing.tenantId, event: 'reinstate', payload: {} };
      return { key: billing.tenantId, event: 'churn', payload: { reason: billing.reason } };
    }),
  ])
  .runner(shell)
  .handler(tenancyReview, { states: { reviewing: UnderReview, reviewed: Customer, failed: ReviewStuck } })
  .reacts({
    monthlyReview: r => r.to(ReviewDue).from([Customer]),
    suspend: r => r.to(Suspended).from([Customer, ReviewDue, UnderReview, ReviewStuck]),
    reinstate: r => r.to(Customer).from([Suspended]),
    churn: r => r.to(Churned).from([Customer, ReviewDue, UnderReview, Suspended, ReviewStuck]),
  });

const NextOfferDue = H.state.pending('NextOfferDue');
const Offering = H.state.active('Offering');
const AwaitingVendor = H.state.waiting('AwaitingVendor');
const NegotiationStalled = H.state.waiting('NegotiationStalled');
const Agreed = H.state.terminal('Agreed', 'success');
const WeWalkedAway = H.state.terminal('WeWalkedAway', 'neutral');
const VendorWalkedAway = H.state.terminal('VendorWalkedAway', 'failure');
const NegotiationExpired = H.state.terminal('NegotiationExpired', 'failure');

const Negotiation = H.work('Negotiation')
  .attributes({
    negotiationId: z.string(),
    vendor: z.string(),
    targetPriceUsd: z.number(),
    vendorPriceUsd: z.number(),
    expiresAt: z.number(),
  })
  .fields({ lastReply: z.string() })
  .states([NextOfferDue, Offering, AwaitingVendor, NegotiationStalled, Agreed, WeWalkedAway, VendorWalkedAway, NegotiationExpired])
  .events({
    vendorReplied: { body: z.string(), priceUsd: z.number() },
    vendorWalkedAway: { body: z.string() },
  })
  .timers(t => ({ expiry: t.attribute('expiresAt') }))
  .key(negotiation => negotiation.attributes.negotiationId);

const negotiatorRole = H.role('negotiator')
  .intents(['read'])
  .instructions('Draft the next move in the procurement negotiation. Offer, accept, or walk away when the vendor will not meet the target.')
  .input({ vendor: z.string(), targetPriceUsd: z.number(), vendorPriceUsd: z.number(), lastReply: z.string() })
  .output({ action: z.enum(['offer', 'accept', 'walkAway']), message: z.string(), priceUsd: z.number() });

const negotiator = H.agent('negotiator', negotiatorRole).model(sonnet).pool(api);
const sendToVendor = H.command('send-to-vendor', ['./bin/send-to-vendor']);

const negotiationRound = H.flow('negotiation-round')
  .requires({ vendor: z.string(), targetPriceUsd: z.number(), vendorPriceUsd: z.number(), lastReply: z.string() })
  .mark('offering')
  .step('draftMove', negotiator, c => ({
    vendor: c.input.vendor,
    targetPriceUsd: c.input.targetPriceUsd,
    vendorPriceUsd: c.input.vendorPriceUsd,
    lastReply: c.input.lastReply,
  }), { onRestart: 'reconcile' })
  .step('send', sendToVendor, c => ({ args: [c.input.vendor], stdin: c.out.draftMove.message }), { onRestart: 'park' })
  .ends(['offered', 'agreed', 'walkedAway'], c =>
    c.out.draftMove.action === 'offer' ? 'offered' : c.out.draftMove.action === 'accept' ? 'agreed' : 'walkedAway',
  );

const vendorMessage = z.object({
  negotiationId: z.string(),
  type: z.enum(['reply', 'walkAway']),
  body: z.string(),
  priceUsd: z.number(),
});

const negotiations = H.lane('negotiations', Negotiation)
  .supply([
    H.supply.operator(),
    http.webhook(Negotiation, { path: '/vendor-replies', port: H.slot.port(1), secret: H.env('VENDOR_WEBHOOK_SECRET') }, body => {
      const parsed = vendorMessage.safeParse(body);
      if (!parsed.success) return null;
      const message = parsed.data;
      if (message.type === 'walkAway') return { key: message.negotiationId, event: 'vendorWalkedAway', payload: { body: message.body } };
      return { key: message.negotiationId, event: 'vendorReplied', payload: { body: message.body, priceUsd: message.priceUsd } };
    }),
  ])
  .store(sqlite.store(Negotiation, '.harness/lifecycles.sqlite'))
  .runner(shell)
  .handler(negotiationRound, {
    states: { offering: Offering, offered: AwaitingVendor, agreed: Agreed, walkedAway: WeWalkedAway, failed: NegotiationStalled },
  })
  .reacts({
    vendorReplied: r =>
      r.to(NextOfferDue)
        .from([AwaitingVendor, NegotiationStalled])
        .updates(reply => ({ lastReply: reply.body, vendorPriceUsd: reply.priceUsd })),
    vendorWalkedAway: r => r.to(VendorWalkedAway).from([NextOfferDue, Offering, AwaitingVendor, NegotiationStalled]),
    expiry: r => r.to(NegotiationExpired).from([NextOfferDue, Offering, AwaitingVendor, NegotiationStalled]),
  });

const cautiousWithExperiments = H.policy.schedule('cautious-with-experiments', c => {
  const inconclusive = c.metrics.outcomes({ kind: Experiment, window: { days: 180 } }).share(Inconclusive);
  const mostlyInconclusive = inconclusive.n >= 10 && inconclusive.rate !== null && inconclusive.rate > 0.5;
  const experimentsRunning = c.open.filter(attempt => c.inLane(attempt, experiments)).length;
  const holdExperiments = mostlyInconclusive && experimentsRunning > 0;
  return {
    start: [...c.candidates]
      .sort((a, b) => b.waitedMs - a.waitedMs)
      .filter(candidate => !(holdExperiments && candidate.is(experiments))),
  };
});

const operations = H.access('operations').allows([
  H.ops.readWork,
  H.ops.createWork,
  H.ops.deliverEvents,
  H.ops.resolveBlocks,
  H.ops.recoverAttempts,
  H.ops.readTelemetry,
]);

export const lifecycles = H.harness('lifecycles')
  .ledger(sqlite.ledger('.harness/ledger.sqlite'))
  .lanes([experiments, tenancies, negotiations])
  .schedule(cautiousWithExperiments)
  .clients([claudeCode.supervisor('lifecycle-supervisor', operations, { port: H.slot.port(2) })])
  .projections([markdown.board('.harness/board.md'), markdown.telemetry('.harness/telemetry.md')]);
