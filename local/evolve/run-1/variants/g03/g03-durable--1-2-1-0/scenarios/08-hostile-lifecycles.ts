import { z } from 'zod';
import { H } from 'harness-dsl';
import * as anthropic from 'harness-dsl/anthropic';
import * as sqlite from 'harness-dsl/sqlite';
import * as http from 'harness-dsl/http';
import * as local from 'harness-dsl/local';
import * as markdown from 'harness-dsl/markdown';

const twoWeeksMs = 14 * 24 * 60 * 60 * 1000;
const stalled = H.state('stalled', 'waiting');

const apiAccount = anthropic.account('api', { apiKey: H.env('ANTHROPIC_API_KEY') });
const sonnet = anthropic.model('claude-sonnet-4-5');
const shell = local.shell({ slots: 4 });

const due = H.state('due', 'pending');
const measuring = H.state('measuring', 'active');
const observing = H.state('observing', 'waiting');
const aWins = H.state('aWins', 'terminal', 'success');
const bWins = H.state('bWins', 'terminal', 'success');
const inconclusive = H.state('inconclusive', 'terminal', 'neutral');

const Experiment = H.work('experiment')
  .attributes({ name: z.string(), variantA: z.string(), variantB: z.string() })
  .states([due, measuring, observing, aWins, bWins, inconclusive])
  .timers(() => ({ hourly: H.time.every({ hours: 1 }) }))
  .key((u) => u.attributes.name);

const sampleMetric = H.command('sample-experiment', ['node', 'ops/sample-experiment.js']);
const analyzeExperiment = H.command('analyze-experiment', ['node', 'ops/analyze-experiment.js']).parses({
  winner: z.enum(['a', 'b', 'none']),
});

const experimentRound = H.flow('experiment-round')
  .requires({ name: z.string() })
  .step('sample', sampleMetric, (c) => ({ args: [c.input.name] }), { restart: 'rerun' })
  .exit('observing', (c) => c.attempt.startedAt - c.unit.createdAt < twoWeeksMs)
  .step('analyze', analyzeExperiment, (c) => ({ args: [c.input.name] }), { restart: 'rerun' })
  .ends(['aWins', 'bWins', 'inconclusive'], (c) =>
    c.out.analyze.data.winner === 'a' ? 'aWins' : c.out.analyze.data.winner === 'b' ? 'bWins' : 'inconclusive',
  );

const experiments = H.lane('experiments', Experiment)
  .supply([H.supply.operator()])
  .store(sqlite.store(Experiment, 'data/units.sqlite'))
  .runner(shell)
  .reacts({ hourly: H.reaction(due).from([observing]) })
  .handler(experimentRound, {
    opens: measuring,
    ends: { observing, aWins, bWins, inconclusive },
    exhausted: observing,
  });

const reviewDue = H.state('reviewDue', 'pending');
const reviewing = H.state('reviewing', 'active');
const customer = H.state('customer', 'waiting');
const suspended = H.state('suspended', 'waiting');
const churned = H.state('churned', 'terminal', 'neutral');

const Tenancy = H.work('tenancy')
  .attributes({ customerId: z.string(), plan: z.string() })
  .states([reviewDue, reviewing, customer, suspended, churned])
  .events({ suspend: { reason: z.string() }, reinstate: {}, churn: {} })
  .timers(() => ({ monthly: H.time.monthly(1, '09:00', 'Europe/Berlin') }))
  .key((u) => u.attributes.customerId);

const usageReport = H.command('usage-report', ['node', 'ops/usage-report.js']);
const accountReviewer = H.agent(
  'account-reviewer',
  H.role('account-reviewer').intents(['read']).instructions('Summarise the month of usage and whether an upsell fits.'),
)
  .model(sonnet)
  .pool(apiAccount);
const upsellDecision = H.decision('upsell', { upsell: z.boolean(), note: z.string() });

const monthlyReview = H.flow('monthly-review')
  .requires({ customerId: z.string(), plan: z.string() })
  .step('usage', usageReport, (c) => ({ args: [c.input.customerId] }), { restart: 'rerun' })
  .step('summary', accountReviewer, (c) => ({ task: `Plan ${c.input.plan}. Usage:\n${c.out.usage.stdout}` }))
  .halt('decision', upsellDecision, { ask: (c) => c.out.summary.text })
  .ends(['upsell', 'keep'], (c) => (c.out.decision.upsell ? 'upsell' : 'keep'));

const billingSecret = H.env('BILLING_WEBHOOK_SECRET');

const tenancies = H.lane('tenancies', Tenancy)
  .supply([
    H.supply.operator(),
    http.webhook(
      Tenancy,
      {
        path: '/billing',
        port: H.slot.port(1),
        secret: billingSecret,
        body: z.object({
          customerId: z.string(),
          type: z.enum(['suspend', 'reinstate', 'churn']),
          reason: z.string(),
        }),
      },
      (body, supply) =>
        body.type === 'suspend'
          ? supply.event(body.customerId, 'suspend', { reason: body.reason })
          : body.type === 'reinstate'
            ? supply.event(body.customerId, 'reinstate', {})
            : supply.event(body.customerId, 'churn', {}),
    ),
  ])
  .store(sqlite.store(Tenancy, 'data/units.sqlite'))
  .runner(shell)
  .reacts({
    monthly: H.reaction(reviewDue).from([customer]),
    suspend: H.reaction(suspended).from([customer, reviewDue, reviewing]).cancels(),
    reinstate: H.reaction(customer).from([suspended]),
    churn: H.reaction(churned).from([customer, reviewDue, reviewing, suspended]).cancels(),
  })
  .handler(monthlyReview, { opens: reviewing, ends: { upsell: customer, keep: customer }, exhausted: customer });

const opening = H.state('opening', 'pending');
const drafting = H.state('drafting', 'active');
const awaitingVendor = H.state('awaitingVendor', 'waiting');
const roundDue = H.state('roundDue', 'pending');
const agreed = H.state('agreed', 'terminal', 'success');
const walkedAwayUs = H.state('walkedAwayUs', 'terminal', 'neutral');
const walkedAwayThem = H.state('walkedAwayThem', 'terminal', 'failure');
const expired = H.state('expired', 'terminal', 'failure');

const Negotiation = H.work('negotiation')
  .attributes({
    negotiationId: z.string(),
    vendor: z.string(),
    item: z.string(),
    ceilingUsd: z.number(),
    expiresAt: z.number(),
  })
  .states([opening, drafting, awaitingVendor, roundDue, agreed, walkedAwayUs, walkedAwayThem, expired, stalled])
  .events({
    vendorReplied: { offer: z.string() },
    vendorAccepted: { terms: z.string() },
    vendorWalkedAway: { reason: z.string() },
  })
  .timers((t) => ({ expiry: t.attribute('expiresAt') }))
  .key((u) => u.attributes.negotiationId);

const negotiator = H.agent(
  'negotiator',
  H.role('negotiator')
    .intents(['read'])
    .instructions('Draft our next move. Never exceed the ceiling. Walk away when no deal under the ceiling is plausible.')
    .input({ vendor: z.string(), item: z.string(), ceilingUsd: z.number(), replies: z.array(z.string()) })
    .output({ action: z.enum(['offer', 'accept', 'walkAway']), message: z.string() }),
)
  .model(sonnet)
  .pool(apiAccount);

const sendToVendor = H.command('send-to-vendor', ['node', 'ops/send-to-vendor.js']);

const negotiationRound = H.flow('negotiation-round')
  .requires({ vendor: z.string(), item: z.string(), ceilingUsd: z.number() })
  .events({ vendorReplied: { offer: z.string() } })
  .step('draft', negotiator, (c) => ({
    vendor: c.input.vendor,
    item: c.input.item,
    ceilingUsd: c.input.ceilingUsd,
    replies: c.events.vendorReplied.map((r) => r.payload.offer),
  }))
  .step('send', sendToVendor, (c) => ({ args: [c.input.vendor], stdin: JSON.stringify(c.out.draft) }), {
    restart: 'escalate',
  })
  .ends(['sent', 'agreed', 'walkedAway'], (c) =>
    c.out.draft.action === 'accept' ? 'agreed' : c.out.draft.action === 'walkAway' ? 'walkedAway' : 'sent',
  );

const negotiations = H.lane('negotiations', Negotiation)
  .supply([
    H.supply.operator(),
    http.webhook(
      Negotiation,
      {
        path: '/vendor',
        port: H.slot.port(1),
        secret: H.env('VENDOR_WEBHOOK_SECRET'),
        body: z.object({
          negotiationId: z.string(),
          type: z.enum(['reply', 'accept', 'walkAway']),
          text: z.string(),
        }),
      },
      (body, supply) =>
        body.type === 'reply'
          ? supply.event(body.negotiationId, 'vendorReplied', { offer: body.text })
          : body.type === 'accept'
            ? supply.event(body.negotiationId, 'vendorAccepted', { terms: body.text })
            : supply.event(body.negotiationId, 'vendorWalkedAway', { reason: body.text }),
    ),
  ])
  .store(sqlite.store(Negotiation, 'data/units.sqlite'))
  .runner(shell)
  .reacts({
    vendorReplied: H.reaction(roundDue).from([awaitingVendor]),
    vendorAccepted: H.reaction(agreed).from([awaitingVendor, roundDue]),
    vendorWalkedAway: H.reaction(walkedAwayThem).from([opening, awaitingVendor, roundDue]),
    expiry: H.reaction(expired).from([opening, drafting, awaitingVendor, roundDue, stalled]).cancels(),
  })
  .handler(negotiationRound, {
    opens: drafting,
    ends: { sent: awaitingVendor, agreed, walkedAway: walkedAwayUs },
    exhausted: stalled,
  });

const schedule = H.policy.schedule('negotiations-tenancies-experiments', (c) => {
  const inconclusiveShare = c.metrics.outcomes({ kind: Experiment, window: { days: 180 } }).share(inconclusive);
  const experimentsMostlyInconclusive = inconclusiveShare.n >= 10 && (inconclusiveShare.rate ?? 0) > 0.5;
  return {
    start: c.order(
      (x) => (x.is(negotiations) ? 0 : x.is(tenancies) ? 1 : experimentsMostlyInconclusive ? 3 : 2),
      (x) => x.enqueuedAt,
    ),
  };
});

const operatorAccess = H.access('operator').allows([
  H.ops.readWork,
  H.ops.createWork,
  H.ops.updateWork,
  H.ops.sendEvents,
  H.ops.resolveBlocks,
  H.ops.manageAttempts,
  H.ops.readTelemetry,
]);

export const lifecycles = H.harness('lifecycles')
  .ledger(sqlite.ledger('data/ledger.sqlite'))
  .lanes([experiments, tenancies, negotiations])
  .schedule(schedule)
  .clients([http.server('operator', operatorAccess, { port: H.slot.port(0), token: H.env('CONTROL_TOKEN') })])
  .projections([markdown.board('board.md'), markdown.telemetry('telemetry.md')]);
