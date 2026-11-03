import { z } from 'zod';
import { H } from 'harness-dsl';
import * as sqlite from 'harness-dsl/sqlite';
import * as anthropic from 'harness-dsl/anthropic';
import * as http from 'harness-dsl/http';
import * as local from 'harness-dsl/local';
import * as markdown from 'harness-dsl/markdown';

const shell = local.shell({ slots: 4 });
const businessApi = anthropic.account('business-api', { apiKey: H.env('ANTHROPIC_API_KEY') });
const sonnet = anthropic.model('claude-sonnet-4');

const ExperimentQueued = H.state('experiment-queued', 'pending');
const ExperimentRunning = H.state('experiment-running', 'active');
const AWins = H.state('a-wins', 'terminal', 'success');
const BWins = H.state('b-wins', 'terminal', 'success');
const Inconclusive = H.state('inconclusive', 'terminal', 'neutral');
const ExperimentBroken = H.state('experiment-broken', 'terminal', 'failure');

const Experiment = H.work('experiment')
  .attributes({ name: z.string(), hypothesis: z.string() })
  .states([ExperimentQueued, ExperimentRunning, AWins, BWins, Inconclusive, ExperimentBroken])
  .key(experiment => experiment.attributes.name);

const collectMetric = H.command('collect-experiment-metric', ['bin/experiment-collect']).parses({ samples: z.number() });
const analyzeExperiment = H.command('analyze-experiment', ['bin/experiment-analyze']).parses({
  winner: z.enum(['a', 'b', 'none']),
});

const abTest = H.flow('ab-test')
  .requires({ name: z.string() })
  .mark('running')
  .loop(
    'hourly',
    { carry: { samples: z.number() }, rounds: () => 24 * 14 },
    round =>
      round
        .wait('hour', H.time.after({ hours: 1 }))
        .step('collect', collectMetric, c => ({ args: [c.input.name, String(c.round)] }), {
          effect: 'repeatable',
          retry: H.retry.fixed({ maxRetries: 2, delayMs: 60000 }),
        }),
    last => ({ samples: last.collect.data.samples }),
  )
  .step('analyze', analyzeExperiment, c => ({ args: [c.input.name] }), { effect: 'repeatable' })
  .ends(['aWins', 'bWins', 'inconclusive'], c =>
    c.out.analyze.data.winner === 'a' ? 'aWins' : c.out.analyze.data.winner === 'b' ? 'bWins' : 'inconclusive',
  );

const experiments = H.lane('experiments', Experiment)
  .supply([H.supply.operator()])
  .store(sqlite.store(Experiment, 'state/experiments.db'))
  .runner(shell)
  .handler(abTest, {
    states: {
      running: ExperimentRunning,
      aWins: AWins,
      bWins: BWins,
      inconclusive: Inconclusive,
      failed: ExperimentBroken,
    },
  });

const Customer = H.state('customer', 'waiting');
const ReviewDue = H.state('review-due', 'pending');
const UnderReview = H.state('under-review', 'active');
const Suspended = H.state('suspended', 'waiting');
const Churned = H.state('churned', 'terminal', 'neutral');

const Tenancy = H.work('tenancy')
  .attributes({ customerId: z.string(), plan: z.string() })
  .states([Customer, ReviewDue, UnderReview, Suspended, Churned])
  .events({ suspend: { reason: z.string() }, reinstate: { note: z.string() }, churn: { reason: z.string() } })
  .timers(() => ({ monthlyReview: H.time.monthly(1, '09:00', 'Europe/Berlin') }))
  .key(tenancy => tenancy.attributes.customerId);

const usageReport = H.command('usage-report', ['bin/usage-report']);

const accountReviewer = H.role('account-reviewer')
  .intents(['read'])
  .instructions('Summarize the month of usage in plain language and say whether an upsell is warranted and why.');

const accountSummarizer = H.agent('account-summarizer', accountReviewer).model(sonnet).pool(businessApi);

const tenancyReview = H.flow('tenancy-review')
  .requires({ customerId: z.string(), plan: z.string() })
  .mark('reviewing')
  .step('usage', usageReport, c => ({ args: [c.input.customerId] }), { effect: 'repeatable' })
  .step('summary', accountSummarizer, c => ({
    task: `Customer ${c.input.customerId} on plan ${c.input.plan}. Usage:\n${c.out.usage.stdout}`,
  }))
  .halt('decision', {
    ask: c => `Upsell ${c.input.customerId}?\n\n${c.out.summary.text}`,
    decision: { upsell: z.boolean(), note: z.string() },
  })
  .ends(['upsold', 'kept'], c => (c.out.decision.upsell ? 'upsold' : 'kept'));

const tenancies = H.lane('tenancies', Tenancy)
  .supply([H.supply.operator()])
  .store(sqlite.store(Tenancy, 'state/tenancies.db'))
  .runner(shell)
  .handler(tenancyReview, {
    states: { reviewing: UnderReview, upsold: Customer, kept: Customer, failed: Customer },
  })
  .reaction('monthlyReview', ReviewDue, { from: [Customer] })
  .reaction('suspend', Suspended, { from: [Customer, ReviewDue, UnderReview] })
  .reaction('reinstate', Customer, { from: [Suspended] })
  .reaction('churn', Churned);

const OurMove = H.state('our-move', 'pending');
const DraftingOffer = H.state('drafting-offer', 'active');
const TheirMove = H.state('their-move', 'waiting');
const Stalled = H.state('stalled', 'waiting');
const Agreed = H.state('agreed', 'terminal', 'success');
const WalkedAwayByUs = H.state('walked-away-by-us', 'terminal', 'neutral');
const WalkedAwayByThem = H.state('walked-away-by-them', 'terminal', 'neutral');
const Expired = H.state('expired', 'terminal', 'neutral');

const Negotiation = H.work('negotiation')
  .attributes({ negotiationId: z.string(), vendor: z.string(), expiresAt: z.number(), lastVendorOffer: z.string() })
  .states([OurMove, DraftingOffer, TheirMove, Stalled, Agreed, WalkedAwayByUs, WalkedAwayByThem, Expired])
  .events({
    vendorReplied: { offer: z.string() },
    vendorAccepted: { terms: z.string() },
    vendorWalkedAway: { reason: z.string() },
    nudge: { note: z.string() },
  })
  .timers(t => ({ expiry: t.attribute('expiresAt') }))
  .key(negotiation => negotiation.attributes.negotiationId);

const negotiatorRole = H.role('negotiator')
  .intents(['read'])
  .instructions('Draft our next offer, or walk away when the vendor position is worse than our walk-away point.')
  .input({ vendor: z.string(), theirOffer: z.string(), round: z.number() })
  .output({ action: z.enum(['offer', 'walkAway']), offer: z.string() });

const negotiator = H.agent('negotiator', negotiatorRole).model(sonnet).pool(businessApi);
const sendOffer = H.command('send-offer', ['bin/send-offer']);

const negotiationRound = H.flow('negotiation-round')
  .requires({ negotiationId: z.string(), vendor: z.string(), lastVendorOffer: z.string() })
  .mark('drafting')
  .step('draft', negotiator, c => ({ vendor: c.input.vendor, theirOffer: c.input.lastVendorOffer, round: c.unit.attemptCount }))
  .exit('walkAway', c => c.out.draft.action === 'walkAway')
  .step('send', sendOffer, c => ({ args: [c.input.negotiationId], stdin: c.out.draft.offer }), { effect: 'unrepeatable' })
  .ends(['offerSent'], () => 'offerSent');

const VendorMessage = z.object({
  negotiationId: z.string(),
  type: z.enum(['offer', 'accept', 'walkAway']),
  text: z.string(),
});

const vendorReplies = http.webhook(Negotiation, { path: '/vendor-replies', port: H.slot.port(1), secret: H.env('VENDOR_WEBHOOK_SECRET') }, body => {
  const parsed = VendorMessage.safeParse(body);
  if (!parsed.success) return null;
  const message = parsed.data;
  if (message.type === 'accept') return { key: message.negotiationId, event: 'vendorAccepted', payload: { terms: message.text } };
  if (message.type === 'walkAway') return { key: message.negotiationId, event: 'vendorWalkedAway', payload: { reason: message.text } };
  return { key: message.negotiationId, event: 'vendorReplied', payload: { offer: message.text } };
});

const negotiations = H.lane('negotiations', Negotiation)
  .supply([H.supply.operator(), vendorReplies])
  .store(sqlite.store(Negotiation, 'state/negotiations.db'))
  .runner(shell)
  .handler(negotiationRound, {
    states: { drafting: DraftingOffer, walkAway: WalkedAwayByUs, offerSent: TheirMove, failed: Stalled },
  })
  .reaction('vendorReplied', OurMove, {
    from: [TheirMove, Stalled],
    sets: payload => ({ lastVendorOffer: payload.offer }),
  })
  .reaction('vendorAccepted', Agreed)
  .reaction('vendorWalkedAway', WalkedAwayByThem)
  .reaction('nudge', OurMove, { from: [Stalled] })
  .reaction('expiry', Expired);

const operatorAccess = H.access('operator').allows([
  H.ops.readWork,
  H.ops.createWork,
  H.ops.updateWork,
  H.ops.sendEvents,
  H.ops.resolveBlocks,
  H.ops.readTelemetry,
]);

export const harness = H.harness('business-lifecycles')
  .ledger(sqlite.ledger('state/ledger.db'))
  .lanes([experiments, tenancies, negotiations])
  .schedule(
    H.policy.schedule('one-experiment-at-a-time-while-mostly-inconclusive', c => {
      const inconclusive = c.metrics.outcomes({ lane: experiments, window: { days: 180 } }).share(Inconclusive);
      const throttle = inconclusive.n >= 10 && (inconclusive.rate ?? 0) > 0.5;
      const experimentOpen = c.open.some(attempt => c.inLane(attempt, experiments));
      return { start: c.candidates.filter(candidate => !(throttle && experimentOpen && candidate.is(experiments))) };
    }),
  )
  .clients([http.server('operator-api', operatorAccess, { port: H.slot.port(0), token: H.env('OPERATOR_TOKEN') })])
  .projections([markdown.board('BOARD.md'), markdown.telemetry('TELEMETRY.md')]);

export const running = harness.start();
