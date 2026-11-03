import { z } from 'zod';
import { H } from 'harness-dsl';
import * as anthropic from 'harness-dsl/anthropic';
import * as sqlite from 'harness-dsl/sqlite';
import * as local from 'harness-dsl/local';
import * as http from 'harness-dsl/http';
import * as claudeCode from 'harness-dsl/claude-code';
import * as markdown from 'harness-dsl/markdown';

const ExperimentScheduled = H.state('ExperimentScheduled', 'pending');
const ExperimentRunning = H.state('ExperimentRunning', 'active');
const VariantAWins = H.state('VariantAWins', 'terminal', 'success');
const VariantBWins = H.state('VariantBWins', 'terminal', 'success');
const Inconclusive = H.state('Inconclusive', 'terminal', 'neutral');

const Experiment = H.work('Experiment')
  .attributes({ experimentId: z.string(), durationHours: z.number() })
  .states([ExperimentScheduled, ExperimentRunning, VariantAWins, VariantBWins, Inconclusive])
  .key(u => u.attributes.experimentId);

const sampleExperiment = H.command('sample-experiment', ['scripts/sample-experiment.sh'])
  .parses({ a: z.number(), b: z.number() });
const judgeExperiment = H.command('judge-experiment', ['scripts/judge-experiment.sh'])
  .parses({ winner: z.enum(['A', 'B', 'inconclusive']) });

const experimentFlow = H.flow('run-experiment')
  .requires({ experimentId: z.string(), durationHours: z.number() })
  .loop(
    'hourly',
    { carry: {}, rounds: c => c.input.durationHours },
    round =>
      round
        .wait('tick', H.time.after({ hours: 1 }))
        .step('sample', sampleExperiment, c => ({ args: [c.input.experimentId] })),
    () => ({}),
  )
  .step('verdict', judgeExperiment, c => ({ args: [c.input.experimentId] }))
  .ends(['aWins', 'bWins', 'inconclusive'], c =>
    c.out.verdict.data.winner === 'A' ? 'aWins' : c.out.verdict.data.winner === 'B' ? 'bWins' : 'inconclusive',
  );

const Customer = H.state('Customer', 'waiting');
const ReviewDue = H.state('ReviewDue', 'pending');
const UnderReview = H.state('UnderReview', 'active');
const Suspended = H.state('Suspended', 'waiting');
const Churned = H.state('Churned', 'terminal', 'neutral');

const Tenancy = H.work('Tenancy')
  .attributes({ customerId: z.string(), plan: z.string() })
  .states([Customer, ReviewDue, UnderReview, Suspended, Churned])
  .events({ suspend: { reason: z.string() }, reinstate: {}, churn: {} })
  .timers(() => ({ monthlyReview: H.time.monthly(1, '09:00', 'UTC') }))
  .key(u => u.attributes.customerId);

const NegotiationOpen = H.state('NegotiationOpen', 'pending');
const DraftingOffer = H.state('DraftingOffer', 'active');
const AwaitingVendor = H.state('AwaitingVendor', 'waiting');
const Agreed = H.state('Agreed', 'terminal', 'success');
const WeWalkedAway = H.state('WeWalkedAway', 'terminal', 'neutral');
const TheyWalkedAway = H.state('TheyWalkedAway', 'terminal', 'failure');
const Expired = H.state('Expired', 'terminal', 'failure');

const Negotiation = H.work('Negotiation')
  .attributes({ negotiationId: z.string(), vendor: z.string(), expiresAt: z.number() })
  .fields({ brief: z.string() })
  .states([NegotiationOpen, DraftingOffer, AwaitingVendor, Agreed, WeWalkedAway, TheyWalkedAway, Expired])
  .events({ vendorReplied: { offer: z.string() }, vendorWalked: { reason: z.string() } })
  .timers(t => ({ expiry: t.attribute('expiresAt') }))
  .key(u => u.attributes.negotiationId);

const api = anthropic.account('operations-api', { apiKey: H.env('ANTHROPIC_API_KEY') });
const sonnet = anthropic.model('claude-sonnet-4-5');
const opus = anthropic.model('claude-opus-4-1');

const accountReviewerRole = H.role('account-reviewer')
  .intents(['read'])
  .instructions('Summarise the month\'s usage and recommend whether to propose an upsell.')
  .input({ customerId: z.string(), plan: z.string(), usage: z.string() })
  .output({ summary: z.string(), recommendation: z.enum(['upsell', 'hold']) });
const accountReviewer = H.agent('account-reviewer', accountReviewerRole).model(sonnet).pool(api);

const negotiatorRole = H.role('negotiator')
  .intents(['read'])
  .instructions('Draft our next move in the procurement negotiation within the brief.')
  .input({ vendor: z.string(), brief: z.string(), vendorOffers: z.array(z.string()) })
  .output({ move: z.enum(['counter', 'accept', 'walkAway']), message: z.string() });
const negotiator = H.agent('negotiator', negotiatorRole).model(opus).pool(api);

const usageReport = H.command('usage-report', ['scripts/usage-report.sh'])
  .parses({ seats: z.number(), usageUsd: z.number() });
const upsellDecision = H.decision('upsell-decision', { upsell: z.boolean(), note: z.string() });

const tenancyReview = H.flow('tenancy-review')
  .requires({ customerId: z.string(), plan: z.string() })
  .step('usage', usageReport, c => ({ args: [c.input.customerId] }))
  .step('summary', accountReviewer, c => ({
    customerId: c.input.customerId,
    plan: c.input.plan,
    usage: JSON.stringify(c.out.usage.data),
  }))
  .halt('upsell', upsellDecision, {
    ask: c => `Upsell ${c.input.customerId}? Recommendation: ${c.out.summary.recommendation}\n\n${c.out.summary.summary}`,
  })
  .ends(['reviewed'], () => 'reviewed');

const sendToVendor = H.command('send-to-vendor', ['scripts/send-to-vendor.sh']);

const negotiationRound = H.flow('negotiation-round')
  .requires({ vendor: z.string(), brief: z.string() })
  .events({ vendorReplied: { offer: z.string() } })
  .step('draft', negotiator, c => ({
    vendor: c.input.vendor,
    brief: c.input.brief,
    vendorOffers: c.events.vendorReplied.map(reply => reply.payload.offer),
  }))
  .step('send', sendToVendor, c => ({ args: [c.input.vendor], stdin: c.out.draft.message }))
  .ends(['countered', 'agreed', 'walkedAway'], c =>
    c.out.draft.move === 'accept' ? 'agreed' : c.out.draft.move === 'walkAway' ? 'walkedAway' : 'countered',
  );

const shell = local.shell({ slots: 4 });

const experiments = H.lane('experiments', Experiment)
  .supply([H.supply.operator()])
  .runner(shell)
  .handler(experimentFlow, { outcomes: { aWins: VariantAWins, bWins: VariantBWins, inconclusive: Inconclusive } });

const tenancies = H.lane('tenancies', Tenancy)
  .supply([
    H.supply.operator(),
    http.webhook(
      Tenancy,
      {
        path: '/billing',
        port: H.slot.port(1),
        secret: H.env('BILLING_WEBHOOK_SECRET'),
        body: z.object({ customerId: z.string(), type: z.enum(['suspend', 'reinstate', 'churn']), reason: z.string() }),
      },
      body => {
        if (body.type === 'suspend') return { key: body.customerId, event: 'suspend', payload: { reason: body.reason } };
        if (body.type === 'reinstate') return { key: body.customerId, event: 'reinstate' };
        return { key: body.customerId, event: 'churn' };
      },
    ),
  ])
  .runner(shell)
  .handler(tenancyReview, { outcomes: { reviewed: Customer } })
  .reacts({
    monthlyReview: H.reaction(ReviewDue).from([Customer]),
    suspend: H.reaction(Suspended).from([Customer, ReviewDue, UnderReview]),
    reinstate: H.reaction(Customer).from([Suspended]),
    churn: H.reaction(Churned).from([Customer, ReviewDue, UnderReview, Suspended]),
  });

const negotiations = H.lane('negotiations', Negotiation)
  .supply([
    H.supply.operator(),
    http.webhook(
      Negotiation,
      {
        path: '/vendor',
        port: H.slot.port(2),
        secret: H.env('VENDOR_WEBHOOK_SECRET'),
        body: z.object({ negotiationId: z.string(), type: z.enum(['reply', 'walk']), text: z.string() }),
      },
      body => {
        if (body.type === 'reply') return { key: body.negotiationId, event: 'vendorReplied', payload: { offer: body.text } };
        return { key: body.negotiationId, event: 'vendorWalked', payload: { reason: body.text } };
      },
    ),
  ])
  .store(sqlite.store(Negotiation, '.harness/negotiations.db'))
  .runner(shell)
  .handler(negotiationRound, {
    outcomes: { countered: AwaitingVendor, agreed: Agreed, walkedAway: WeWalkedAway },
  })
  .reacts({
    vendorReplied: H.reaction(NegotiationOpen).from([AwaitingVendor]),
    vendorWalked: H.reaction(TheyWalkedAway).from([NegotiationOpen, DraftingOffer, AwaitingVendor]),
    expiry: H.reaction(Expired).from([NegotiationOpen, DraftingOffer, AwaitingVendor]),
  });

const lifecycleSchedule = H.policy.schedule('cautious-experiments', c => {
  const inconclusive = c.metrics.outcomes({ kind: Experiment, window: { days: 180 } }).share(Inconclusive);
  const experimentLimit = inconclusive.n >= 10 && (inconclusive.rate ?? 0) > 0.5 ? 1 : 3;
  let experimentsActive = c.open.filter(o => o.unit.is(Experiment)).length;
  const start = c.candidates.filter(candidate => {
    if (!candidate.unit.is(Experiment)) return true;
    if (experimentsActive >= experimentLimit) return false;
    experimentsActive += 1;
    return true;
  });
  return { start };
});

const ownerAccess = H.access('owner').allows([
  H.ops.readWork,
  H.ops.createWork,
  H.ops.sendEvents,
  H.ops.resolveBlocks,
  H.ops.manageAttempts,
  H.ops.readTelemetry,
]);

export const harness = H.harness('lifecycles')
  .ledger(sqlite.ledger('.harness/lifecycles.db'))
  .lanes([experiments, tenancies, negotiations])
  .schedule(lifecycleSchedule)
  .projections([markdown.board('BOARD.md'), markdown.telemetry('TELEMETRY.md')]);

export const control = H.control('lifecycles-control', harness)
  .clients([claudeCode.supervisor('owner-desk', ownerAccess, { port: H.slot.port(0) })]);

export async function main(): Promise<void> {
  await harness.start();
  await control.serve();
}
