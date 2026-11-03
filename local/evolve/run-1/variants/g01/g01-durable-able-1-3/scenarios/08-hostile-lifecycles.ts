import { z } from 'zod';
import { H } from 'harness-dsl';
import * as anthropic from 'harness-dsl/anthropic';
import * as claude from 'harness-dsl/claude-code';
import * as sqlite from 'harness-dsl/sqlite';
import * as http from 'harness-dsl/http';
import * as local from 'harness-dsl/local';
import * as markdown from 'harness-dsl/markdown';

const apiAccount = anthropic.account('anthropic-api', { apiKey: H.env('ANTHROPIC_API_KEY') });
const strong = anthropic.model('claude-opus-4');
const cheap = anthropic.model('claude-sonnet-4');
const runner = local.shell({ slots: 4 });
const ledger = sqlite.ledger('lifecycles-ledger.sqlite');

const ExperimentQueued = H.state('ExperimentQueued', 'pending');
const Measuring = H.state('Measuring', 'active');
const AWins = H.state('AWins', 'terminal', 'success');
const BWins = H.state('BWins', 'terminal', 'success');
const Inconclusive = H.state('Inconclusive', 'terminal', 'neutral');
const ExperimentBroken = H.state('ExperimentBroken', 'terminal', 'failure');

const Experiment = H.work('Experiment')
  .attributes({ experimentId: z.string(), hypothesis: z.string() })
  .states([ExperimentQueued, Measuring, AWins, BWins, Inconclusive, ExperimentBroken])
  .key((unit) => unit.attributes.experimentId);

const measure = H.command('measure-experiment', ['node', 'scripts/measure.js']);
const decideWinner = H.command('decide-winner', ['node', 'scripts/decide.js']).parses({
  winner: z.enum(['a', 'b', 'none']),
});

const experimentFlow = H.flow('experiment')
  .requires({ experimentId: z.string() })
  .mark('measuring')
  .loop(
    'hours',
    { carry: { lastExit: z.number() }, rounds: () => 24 * 14 },
    (round) =>
      round
        .step('measure', measure, (c) => ({ args: [c.input.experimentId, String(c.round)] }), { onRestart: 'rerun' })
        .wait('nextHour', H.time.after({ hours: 1 })),
    (last) => ({ lastExit: last.measure.exitCode }),
  )
  .step('decide', decideWinner, (c) => ({ args: [c.input.experimentId] }), { onRestart: 'rerun' })
  .ends(['aWins', 'bWins', 'inconclusive'], (c) =>
    c.out.decide.data.winner === 'a' ? 'aWins' : c.out.decide.data.winner === 'b' ? 'bWins' : 'inconclusive',
  );

const experiments = H.lane('experiments', Experiment)
  .supply([H.supply.operator()])
  .store(sqlite.store(Experiment, 'lifecycles-store.sqlite'))
  .handler(experimentFlow, {
    states: {
      measuring: Measuring,
      aWins: AWins,
      bWins: BWins,
      inconclusive: Inconclusive,
      failed: ExperimentBroken,
    },
  })
  .runner(runner)
  .wip(3);

const DueReview = H.state('DueReview', 'pending');
const Reviewing = H.state('Reviewing', 'active');
const Customer = H.state('Customer', 'waiting');
const Suspended = H.state('Suspended', 'waiting');
const Churned = H.state('Churned', 'terminal', 'neutral');

const Tenancy = H.work('Tenancy')
  .attributes({ customerId: z.string(), plan: z.string() })
  .states([DueReview, Reviewing, Customer, Suspended, Churned])
  .signals({ churned: { reason: z.string() }, reinstated: { note: z.string() } })
  .timers(() => ({ monthlyReview: H.time.monthly(1, '09:00', 'Europe/Berlin') }))
  .key((unit) => unit.attributes.customerId);

const usageReport = H.command('usage-report', ['node', 'scripts/usage.js']).parses({
  seats: z.number(),
  usageUsd: z.number(),
});

const accountAnalyst = H.role('account-analyst')
  .intents(['read'])
  .instructions('Summarise the month for the account owner: usage trend, risk, upsell signal.')
  .input({ customerId: z.string(), plan: z.string(), seats: z.number(), usageUsd: z.number() })
  .output({ summary: z.string() });

const analyst = H.agent('account-analyst', accountAnalyst).model(cheap).pool(apiAccount);

const tenancyReview = H.flow('tenancy-review')
  .requires({ customerId: z.string(), plan: z.string() })
  .mark('reviewing')
  .step('usage', usageReport, (c) => ({ args: [c.input.customerId] }), { onRestart: 'rerun' })
  .step('summary', analyst, (c) => ({
    customerId: c.input.customerId,
    plan: c.input.plan,
    seats: c.out.usage.data.seats,
    usageUsd: c.out.usage.data.usageUsd,
  }))
  .halt('decision', {
    ask: (c) => c.out.summary.summary,
    decision: { action: z.enum(['upsell', 'keep', 'suspend']), note: z.string() },
  })
  .ends(['customer', 'suspended'], (c) => (c.out.decision.action === 'suspend' ? 'suspended' : 'customer'));

const customerEvent = z.object({
  customerId: z.string(),
  type: z.enum(['signedUp', 'churned']),
  plan: z.string(),
  reason: z.string(),
});

const tenancies = H.lane('tenancies', Tenancy)
  .supply([
    H.supply.operator(),
    http.webhook(Tenancy, { path: '/crm', port: H.slot.port(1), secret: H.env('CRM_SECRET') }, (body) => {
      const parsed = customerEvent.safeParse(body);
      if (!parsed.success) return null;
      if (parsed.data.type === 'signedUp') {
        return { create: { attributes: { customerId: parsed.data.customerId, plan: parsed.data.plan } } };
      }
      return { key: parsed.data.customerId, signal: 'churned', payload: { reason: parsed.data.reason } };
    }),
  ])
  .store(sqlite.store(Tenancy, 'lifecycles-store.sqlite'))
  .handler(tenancyReview, {
    states: { reviewing: Reviewing, customer: Customer, suspended: Suspended, failed: Customer },
  })
  .runner(runner);

const monthlyReview = H.trigger('tenancy-monthly-review', H.on.signal(tenancies, 'monthlyReview'))
  .moves(tenancies, { key: (e) => e.unit.key, to: DueReview, from: [Customer] });
const reinstate = H.trigger('tenancy-reinstate', H.on.signal(tenancies, 'reinstated'))
  .moves(tenancies, { key: (e) => e.unit.key, to: Customer, from: [Suspended] });
const churn = H.trigger('tenancy-churn', H.on.signal(tenancies, 'churned'))
  .moves(tenancies, { key: (e) => e.unit.key, to: Churned });

const Drafting = H.state('Drafting', 'pending');
const Offering = H.state('Offering', 'active');
const AwaitingVendor = H.state('AwaitingVendor', 'waiting');
const Stalled = H.state('Stalled', 'waiting');
const Agreed = H.state('Agreed', 'terminal', 'success');
const WalkedAwayByUs = H.state('WalkedAwayByUs', 'terminal', 'neutral');
const WalkedAwayByThem = H.state('WalkedAwayByThem', 'terminal', 'failure');
const Expired = H.state('Expired', 'terminal', 'failure');

const Negotiation = H.work('Negotiation')
  .attributes({
    negotiationId: z.string(),
    vendor: z.string(),
    item: z.string(),
    deadlineAt: z.number(),
    lastOffer: z.string(),
  })
  .fields({ vendorOffer: z.string() })
  .states([Drafting, Offering, AwaitingVendor, Stalled, Agreed, WalkedAwayByUs, WalkedAwayByThem, Expired])
  .signals({
    vendorReplied: { offer: z.string(), walkedAway: z.boolean() },
    resume: {},
  })
  .timers((t) => ({ expiry: t.attribute('deadlineAt') }))
  .key((unit) => unit.attributes.negotiationId);

const negotiatorRole = H.role('negotiator')
  .intents(['read'])
  .instructions('Decide the next move against the vendor offer: counter with an offer, accept, or walk away.')
  .input({ vendor: z.string(), item: z.string(), vendorOffer: z.string(), lastOffer: z.string() })
  .output({ action: z.enum(['counter', 'accept', 'walkAway']), offer: z.string() });

const negotiator = H.agent('negotiator', negotiatorRole).model(strong).pool(apiAccount);
const sendOffer = H.command('send-offer', ['node', 'scripts/send-offer.js']);
const offerSent = H.command('offer-sent', ['node', 'scripts/offer-sent.js']);

const negotiationRound = H.flow('negotiation-round')
  .requires({ vendor: z.string(), item: z.string(), vendorOffer: z.string(), lastOffer: z.string() })
  .mark('offering')
  .step('draft', negotiator, (c) => ({
    vendor: c.input.vendor,
    item: c.input.item,
    vendorOffer: c.input.vendorOffer,
    lastOffer: c.input.lastOffer,
  }))
  .exit('agreed', (c) => c.out.draft.action === 'accept')
  .exit('walkedAway', (c) => c.out.draft.action === 'walkAway')
  .sets({ lastOffer: z.string() }, (c) => ({ lastOffer: c.out.draft.offer }))
  .step('send', sendOffer, (c) => ({ args: [c.input.vendor], stdin: c.out.draft.offer }), {
    onRestart: 'park',
    confirm: offerSent,
  })
  .ends(['sent'], () => 'sent');

const vendorReply = z.object({ negotiationId: z.string(), offer: z.string(), walkedAway: z.boolean() });

const negotiations = H.lane('negotiations', Negotiation)
  .supply([
    H.supply.operator(),
    http.webhook(Negotiation, { path: '/vendor', port: H.slot.port(1), secret: H.env('VENDOR_SECRET') }, (body) => {
      const parsed = vendorReply.safeParse(body);
      if (!parsed.success) return null;
      return {
        key: parsed.data.negotiationId,
        signal: 'vendorReplied',
        payload: { offer: parsed.data.offer, walkedAway: parsed.data.walkedAway },
      };
    }),
  ])
  .store(sqlite.store(Negotiation, 'lifecycles-store.sqlite'))
  .handler(negotiationRound, {
    states: {
      offering: Offering,
      agreed: Agreed,
      walkedAway: WalkedAwayByUs,
      sent: AwaitingVendor,
      failed: Stalled,
    },
  })
  .runner(runner);

const vendorCountered = H.trigger('vendor-countered', H.on.signal(negotiations, 'vendorReplied'))
  .where((e) => !e.payload.walkedAway)
  .moves(negotiations, {
    key: (e) => e.unit.key,
    to: Drafting,
    from: [AwaitingVendor],
    update: (e) => ({ fields: { vendorOffer: e.payload.offer } }),
  });
const vendorWalkedAway = H.trigger('vendor-walked-away', H.on.signal(negotiations, 'vendorReplied'))
  .where((e) => e.payload.walkedAway)
  .moves(negotiations, { key: (e) => e.unit.key, to: WalkedAwayByThem });
const negotiationExpired = H.trigger('negotiation-expired', H.on.signal(negotiations, 'expiry'))
  .moves(negotiations, { key: (e) => e.unit.key, to: Expired });
const negotiationResumed = H.trigger('negotiation-resumed', H.on.signal(negotiations, 'resume'))
  .moves(negotiations, { key: (e) => e.unit.key, to: Drafting, from: [Stalled] });

const lifecycleSchedule = H.policy.schedule('lifecycle-order', (c) => {
  const inconclusive = c.metrics.outcomes({ kind: Experiment, window: { days: 90 } }).share(Inconclusive);
  const mostlyInconclusive = inconclusive.n >= 10 && inconclusive.rate !== null && inconclusive.rate > 0.5;
  const runningExperiments = c.open.filter((a) => c.inLane(a, experiments)).length;
  const rank = (x: (typeof c.candidates)[number]) => (x.is(negotiations) ? 0 : x.is(tenancies) ? 1 : 2);
  return {
    start: c.candidates
      .filter((x) => !(x.is(experiments) && mostlyInconclusive && runningExperiments > 0))
      .slice()
      .sort((a, b) => rank(a) - rank(b) || b.waitedMs - a.waitedMs),
  };
});

const operatorAccess = H.access('operator').allows([
  H.ops.readWork,
  H.ops.createWork,
  H.ops.updateWork,
  H.ops.signalWork,
  H.ops.resolveBlocks,
  H.ops.readTelemetry,
]);

export const lifecyclesHarness = H.harness('lifecycles')
  .ledger(ledger)
  .lanes([experiments, tenancies, negotiations])
  .triggers([monthlyReview, reinstate, churn, vendorCountered, vendorWalkedAway, negotiationExpired, negotiationResumed])
  .schedule(lifecycleSchedule)
  .clients([claude.supervisor('lifecycles-supervisor', operatorAccess, { port: H.slot.port(0) })])
  .projections([markdown.board('BOARD.md'), markdown.telemetry('TELEMETRY.md')]);
