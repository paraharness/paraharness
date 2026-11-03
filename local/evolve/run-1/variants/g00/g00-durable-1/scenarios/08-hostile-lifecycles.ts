import { z } from 'zod';
import { H } from 'harness-dsl';
import * as anthropic from 'harness-dsl/anthropic';
import * as sqlite from 'harness-dsl/sqlite';
import * as local from 'harness-dsl/local';
import * as http from 'harness-dsl/http';
import * as claudeCode from 'harness-dsl/claude-code';
import * as markdown from 'harness-dsl/markdown';

const apiAccount = anthropic.account('anthropic-api', { apiKey: H.env('ANTHROPIC_API_KEY') });
const sonnet = anthropic.model('claude-sonnet-4-5');
const opus = anthropic.model('claude-opus-4-1');
const shell = local.shell({ slots: 4 });

const ExperimentScheduled = H.state('experiment scheduled', 'pending');
const Collecting = H.state('collecting', 'active');
const AWins = H.state('a wins', 'concluded');
const BWins = H.state('b wins', 'concluded');
const Inconclusive = H.state('inconclusive', 'concluded');
const ExperimentFailed = H.state('experiment failed', 'failed');
const ExperimentCancelled = H.state('experiment cancelled', 'cancelled');

const Experiment = H.work('Experiment')
  .attributes({ experiment: z.string() })
  .states([ExperimentScheduled, Collecting, AWins, BWins, Inconclusive, ExperimentFailed, ExperimentCancelled])
  .signals({ cancel: {} })
  .key(unit => unit.attributes.experiment);

const sampleMetric = H.command('sample-experiment-metric', ['experiments/sample']);
const decideExperiment = H.command('decide-experiment', ['experiments/decide']).parses({
  winner: z.enum(['a', 'b', 'none']),
});

const experimentFlow = H.flow('experiment')
  .requires({ experiment: z.string() })
  .mark('collecting')
  .loop(
    'hours',
    { carry: {}, rounds: () => 14 * 24 },
    round => round
      .step('sample', sampleMetric, c => ({ args: [c.input.experiment, String(c.round)] }))
      .wait('pause', H.time.after({ hours: 1 })),
    () => ({}),
  )
  .step('decide', decideExperiment, c => ({ args: [c.input.experiment] }))
  .ends(['aWins', 'bWins', 'inconclusive'], c =>
    c.out.decide.data.winner === 'a' ? 'aWins' : c.out.decide.data.winner === 'b' ? 'bWins' : 'inconclusive',
  );

const experimentLane = H.lane('experiments', Experiment)
  .supply([H.supply.operator()])
  .runner(shell)
  .handler(experimentFlow, {
    states: { collecting: Collecting, aWins: AWins, bWins: BWins, inconclusive: Inconclusive, failed: ExperimentFailed },
  })
  .signals({ cancel: H.move(ExperimentCancelled).from([ExperimentScheduled, Collecting]) });

const Current = H.state('current', 'active');
const ReviewDue = H.state('review due', 'pending');
const Suspended = H.state('suspended', 'active');
const Churned = H.state('churned', 'concluded');

const Tenancy = H.work('Tenancy')
  .attributes({ customerId: z.string() })
  .states([Current, ReviewDue, Suspended, Churned])
  .signals({ suspend: {}, reinstate: {}, churn: {} })
  .timers(() => ({ monthlyReview: H.time.monthly(1, '09:00', 'UTC') }))
  .key(unit => unit.attributes.customerId);

const usageReport = H.command('usage-report', ['billing/usage-report']);

const accountReviewerRole = H.role('account-reviewer')
  .intents(['read'])
  .instructions('Summarise the month of usage and whether an upsell conversation is warranted.')
  .input({ customerId: z.string(), usage: z.string() })
  .output({ summary: z.string() });
const accountReviewer = H.agent('account-reviewer', accountReviewerRole).model(sonnet).pool(apiAccount);

const tenancyReviewFlow = H.flow('tenancy-review')
  .requires({ customerId: z.string() })
  .step('usage', usageReport, c => ({ args: [c.input.customerId] }))
  .step('summary', accountReviewer, c => ({ customerId: c.input.customerId, usage: c.out.usage.stdout }))
  .halt('decision', {
    ask: c => `Monthly review for ${c.input.customerId}:\n\n${c.out.summary.summary}\n\nUpsell?`,
    decision: { upsell: z.boolean(), note: z.string() },
  })
  .ends(['reviewed'], () => 'reviewed');

const billingEvent = z.object({
  customerId: z.string(),
  event: z.enum(['signup', 'suspend', 'reinstate', 'churn']),
});

const tenancyLane = H.lane('tenancies', Tenancy)
  .supply([
    H.supply.operator(),
    http.webhook(Tenancy, { path: '/billing', port: H.slot.port(0), secret: H.env('BILLING_WEBHOOK_SECRET') }, body => {
      const parsed = billingEvent.safeParse(body);
      if (!parsed.success) return null;
      const key = parsed.data.customerId;
      switch (parsed.data.event) {
        case 'signup':
          return { create: { attributes: { customerId: key } } };
        case 'suspend':
          return { key, signal: 'suspend', payload: {} };
        case 'reinstate':
          return { key, signal: 'reinstate', payload: {} };
        case 'churn':
          return { key, signal: 'churn', payload: {} };
      }
    }),
  ])
  .store(sqlite.store(Tenancy, 'tenancies.db'))
  .runner(shell)
  .handler(tenancyReviewFlow, { states: { reviewed: Current, failed: Current } })
  .signals({
    monthlyReview: H.move(ReviewDue).from([Current]),
    suspend: H.move(Suspended).from([Current, ReviewDue]),
    reinstate: H.move(Current).from([Suspended]),
    churn: H.move(Churned).from([Current, ReviewDue, Suspended]),
  });

const OurTurn = H.state('our turn', 'pending');
const AwaitingVendor = H.state('awaiting vendor', 'active');
const Agreed = H.state('agreed', 'succeeded');
const WeWalkedAway = H.state('we walked away', 'concluded');
const TheyWalkedAway = H.state('they walked away', 'concluded');
const Expired = H.state('expired', 'concluded');
const NegotiationFailed = H.state('negotiation failed', 'failed');

const Negotiation = H.work('Negotiation')
  .attributes({ vendor: z.string(), expiresAt: z.number() })
  .fields({ item: z.string(), targetPriceUsd: z.number() })
  .states([OurTurn, AwaitingVendor, Agreed, WeWalkedAway, TheyWalkedAway, Expired, NegotiationFailed])
  .signals({ vendorOffered: { offer: z.string() }, vendorWalkedAway: { reason: z.string() } })
  .timers(t => ({ expiry: t.attribute('expiresAt') }))
  .key(unit => `${unit.attributes.vendor}/${unit.fields.item}`);

const negotiatorRole = H.role('negotiator')
  .intents(['read'])
  .instructions('Decide the next move in the procurement negotiation and write the message to the vendor.')
  .input({ vendor: z.string(), item: z.string(), targetPriceUsd: z.number(), vendorOffer: z.string() })
  .output({ move: z.enum(['counter', 'accept', 'walkAway']), message: z.string() });
const negotiator = H.agent('negotiator', negotiatorRole).model(opus).pool(apiAccount);

const sendToVendor = H.command('send-to-vendor', ['procurement/send']);
const vendorOfferPayload = z.object({ offer: z.string() });

const negotiationRoundFlow = H.flow('negotiation-round')
  .requires({ vendor: z.string(), item: z.string(), targetPriceUsd: z.number() })
  .step('offer', negotiator, c => {
    const offers = c.signals
      .filter(signal => signal.name === 'vendorOffered')
      .flatMap(signal => {
        const parsed = vendorOfferPayload.safeParse(signal.payload);
        return parsed.success ? [parsed.data.offer] : [];
      });
    return {
      vendor: c.input.vendor,
      item: c.input.item,
      targetPriceUsd: c.input.targetPriceUsd,
      vendorOffer: offers.length > 0 ? offers[offers.length - 1] : 'no offer yet',
    };
  })
  .step('send', sendToVendor, c => ({ args: [c.input.vendor], stdin: c.out.offer.message }), {
    retry: H.retry.exponential({ maxRetries: 3, initialDelayMs: 30_000 }),
  })
  .ends(['awaitingVendor', 'agreed', 'walkedAway'], c =>
    c.out.offer.move === 'accept' ? 'agreed' : c.out.offer.move === 'walkAway' ? 'walkedAway' : 'awaitingVendor',
  );

const vendorReply = z.object({ negotiation: z.string(), walkAway: z.boolean(), message: z.string() });

const negotiationLane = H.lane('negotiations', Negotiation)
  .supply([
    H.supply.operator(),
    http.webhook(Negotiation, { path: '/vendor-replies', port: H.slot.port(1), secret: H.env('VENDOR_WEBHOOK_SECRET') }, body => {
      const parsed = vendorReply.safeParse(body);
      if (!parsed.success) return null;
      return parsed.data.walkAway
        ? { key: parsed.data.negotiation, signal: 'vendorWalkedAway', payload: { reason: parsed.data.message } }
        : { key: parsed.data.negotiation, signal: 'vendorOffered', payload: { offer: parsed.data.message } };
    }),
  ])
  .store(sqlite.store(Negotiation, 'negotiations.db'))
  .runner(shell)
  .handler(negotiationRoundFlow, {
    states: {
      awaitingVendor: AwaitingVendor,
      agreed: Agreed,
      walkedAway: WeWalkedAway,
      failed: NegotiationFailed,
    },
  })
  .signals({
    vendorOffered: H.move(OurTurn).from([AwaitingVendor]),
    vendorWalkedAway: H.move(TheyWalkedAway).from([OurTurn, AwaitingVendor]),
    expiry: H.move(Expired).from([OurTurn, AwaitingVendor]),
  });

const lifecycleOrder = H.policy.schedule('lifecycle-order', c => {
  const inconclusive = c.metrics.outcomes({ lane: experimentLane, windowDays: 365 }).share(Inconclusive);
  const experimentsOftenInconclusive = inconclusive.n >= 10 && inconclusive.rate !== null && inconclusive.rate > 0.5;
  const deferred = (candidate: { is: (typeof c.candidates)[number]['is'] }): number =>
    Number(experimentsOftenInconclusive && candidate.is(experimentLane));
  return { start: [...c.candidates].sort((a, b) => deferred(a) - deferred(b)) };
});

const ownerAccess = H.access('owner').allows([
  H.ops.readWork,
  H.ops.createWork,
  H.ops.signalWork,
  H.ops.resolveBlocks,
  H.ops.readTelemetry,
]);

export const lifecycles = H.harness('hostile-lifecycles')
  .ledger(sqlite.ledger('lifecycles-ledger.db'))
  .lanes([experimentLane, tenancyLane, negotiationLane])
  .schedule(lifecycleOrder)
  .clients([claudeCode.supervisor('owner-supervisor', ownerAccess, { port: H.slot.port(2) })])
  .projections([markdown.board('BOARD.md'), markdown.telemetry('TELEMETRY.md')]);
