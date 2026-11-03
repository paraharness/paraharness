import { z } from 'zod';
import { H } from 'harness-dsl';
import * as sqlite from 'harness-dsl/sqlite';
import * as anthropic from 'harness-dsl/anthropic';
import * as claudeCode from 'harness-dsl/claude-code';
import * as http from 'harness-dsl/http';
import * as local from 'harness-dsl/local';
import * as markdown from 'harness-dsl/markdown';

const account = anthropic.account('ops-api', { apiKey: H.env('ANTHROPIC_API_KEY') });
const sonnet = anthropic.model('claude-sonnet-4-5');
const shell = local.shell({ slots: 4 });

const Planned = H.state('Planned', 'pending');
const Measuring = H.state('Measuring', 'active');
const AWins = H.state('AWins', 'terminal', 'success');
const BWins = H.state('BWins', 'terminal', 'success');
const Inconclusive = H.state('Inconclusive', 'terminal', 'neutral');
const Aborted = H.state('Aborted', 'terminal', 'failure');

const Experiment = H.work('Experiment')
  .attributes({ slug: z.string(), metricName: z.string() })
  .states([Planned, Measuring, AWins, BWins, Inconclusive, Aborted])
  .key(u => u.attributes.slug);

const measure = H.command('measureExperiment', ['bin/experiment', 'measure']).parses({
  samplesA: z.number(),
  samplesB: z.number(),
});
const conclude = H.command('concludeExperiment', ['bin/experiment', 'conclude']).parses({
  winner: z.enum(['a', 'b', 'inconclusive']),
  pValue: z.number(),
});

const hoursInTwoWeeks = 14 * 24;

const experimentFlow = H.flow('abTest')
  .requires({ slug: z.string(), metricName: z.string() })
  .loop(
    'hourly',
    { carry: { samples: z.number() }, rounds: () => hoursInTwoWeeks },
    round => round
      .step('measure', measure, c => ({ args: [c.input.slug, c.input.metricName] }), {
        retry: H.retry.fixed({ maxRetries: 2, delayMs: 60000 }),
        restart: 'rerun',
      })
      .wait('nextHour', H.time.after({ hours: 1 })),
    last => ({ samples: last.measure.data.samplesA + last.measure.data.samplesB }),
  )
  .step('conclusion', conclude, c => ({ args: [c.input.slug] }), { restart: 'rerun' })
  .ends(['aWins', 'bWins', 'inconclusive'], c =>
    c.out.conclusion.data.winner === 'a' ? 'aWins' : c.out.conclusion.data.winner === 'b' ? 'bWins' : 'inconclusive');

const experiments = H.lane('experiments', Experiment)
  .supply([H.supply.operator()])
  .store(sqlite.store(Experiment, '.harness/experiments.sqlite'))
  .runner(shell)
  .wip(4)
  .handler(experimentFlow, {
    states: { aWins: AWins, bWins: BWins, inconclusive: Inconclusive, failed: Aborted },
  });

const Current = H.state('Current', 'waiting');
const DueForReview = H.state('DueForReview', 'pending');
const Reviewing = H.state('Reviewing', 'active');
const Suspended = H.state('Suspended', 'waiting');
const Churned = H.state('Churned', 'terminal', 'neutral');

const Tenancy = H.work('Tenancy')
  .attributes({ customerId: z.string(), plan: z.string() })
  .states([Current, DueForReview, Reviewing, Suspended, Churned])
  .events({
    suspended: { reason: z.string() },
    reinstated: { plan: z.string() },
    churned: { reason: z.string() },
  })
  .timers(() => ({ monthlyReview: H.time.monthly(1, '09:00', 'Europe/Berlin') }))
  .key(u => u.attributes.customerId);

const usageReport = H.command('usageReport', ['bin/usage-report', '--json']).parses({
  activeSeats: z.number(),
  monthlyUsd: z.number(),
  trend: z.string(),
});

const accountManagerRole = H.role('accountManager')
  .intents(['read'])
  .instructions('Summarise the month of usage in plain language and say whether an upsell conversation is warranted.')
  .input({ customerId: z.string(), plan: z.string(), activeSeats: z.number(), monthlyUsd: z.number(), trend: z.string() })
  .output({ summary: z.string(), suggestUpsell: z.boolean() });

const accountManager = H.agent('accountManager', accountManagerRole).model(sonnet).pool(account);

const upsellDecision = H.decision('upsellDecision', { upsell: z.boolean(), note: z.string() });

const tenancyReviewFlow = H.flow('tenancyReview')
  .requires({ customerId: z.string(), plan: z.string() })
  .step('usage', usageReport, c => ({ args: [c.input.customerId] }), { restart: 'rerun' })
  .step('summary', accountManager, c => ({
    customerId: c.input.customerId,
    plan: c.input.plan,
    activeSeats: c.out.usage.data.activeSeats,
    monthlyUsd: c.out.usage.data.monthlyUsd,
    trend: c.out.usage.data.trend,
  }))
  .halt('upsell', upsellDecision, {
    ask: c => `${c.input.customerId} on ${c.input.plan}: ${c.out.summary.summary} Suggest upsell: ${c.out.summary.suggestUpsell ? 'yes' : 'no'}.`,
  })
  .ends(['reviewed'], () => 'reviewed');

const billingBody = z.object({
  type: z.enum(['signup', 'suspended', 'reinstated', 'churned']),
  customerId: z.string(),
  plan: z.string(),
  reason: z.string(),
});

const tenancies = H.lane('tenancies', Tenancy)
  .supply([
    http.webhook(Tenancy, { path: '/billing', port: H.slot.port(1), secret: H.env('BILLING_WEBHOOK_SECRET'), body: billingBody }, b => {
      switch (b.type) {
        case 'signup':
          return { create: { attributes: { customerId: b.customerId, plan: b.plan } } };
        case 'suspended':
          return { key: b.customerId, event: 'suspended', payload: { reason: b.reason } };
        case 'reinstated':
          return { key: b.customerId, event: 'reinstated', payload: { plan: b.plan } };
        case 'churned':
          return { key: b.customerId, event: 'churned', payload: { reason: b.reason } };
      }
    }),
  ])
  .store(sqlite.store(Tenancy, '.harness/tenancies.sqlite'))
  .runner(shell)
  .wip(3)
  .reacts({
    monthlyReview: H.reaction(DueForReview).from([Current]),
    suspended: H.reaction(Suspended).from([Current, DueForReview, Reviewing]),
    reinstated: H.reaction(Current).from([Suspended]),
    churned: H.reaction(Churned).from([Current, DueForReview, Reviewing, Suspended]),
  })
  .handler(tenancyReviewFlow, { states: { reviewed: Current, failed: Current } });

const Drafting = H.state('Drafting', 'pending');
const Composing = H.state('Composing', 'active');
const AwaitingVendor = H.state('AwaitingVendor', 'waiting');
const Stalled = H.state('Stalled', 'waiting');
const Agreed = H.state('Agreed', 'terminal', 'success');
const WeWalkedAway = H.state('WeWalkedAway', 'terminal', 'neutral');
const TheyWalkedAway = H.state('TheyWalkedAway', 'terminal', 'failure');
const Expired = H.state('Expired', 'terminal', 'failure');

const vendorReply = { message: z.string(), priceUsd: z.number() };

const Negotiation = H.work('Negotiation')
  .attributes({ ref: z.string(), vendor: z.string(), item: z.string(), ceilingUsd: z.number(), expiresAt: z.number() })
  .states([Drafting, Composing, AwaitingVendor, Stalled, Agreed, WeWalkedAway, TheyWalkedAway, Expired])
  .events({
    vendorReplied: vendorReply,
    vendorAccepted: { priceUsd: z.number() },
    vendorWalkedAway: { message: z.string() },
    retryRound: { note: z.string() },
  })
  .timers(t => ({ expiry: t.attribute('expiresAt') }))
  .key(u => u.attributes.ref);

const negotiatorRole = H.role('negotiator')
  .intents(['read'])
  .instructions('Draft our next move. Never offer above the ceiling. Walk away when the vendor cannot meet it.')
  .input({
    item: z.string(),
    vendor: z.string(),
    ceilingUsd: z.number(),
    vendorMessages: z.array(z.object({ message: z.string(), priceUsd: z.number() })),
  })
  .output({ action: z.enum(['offer', 'accept', 'walkAway']), priceUsd: z.number(), message: z.string() });

const negotiator = H.agent('negotiator', negotiatorRole).model(sonnet).pool(account);

const sendToVendor = H.command('sendToVendor', ['bin/send-to-vendor']);

const negotiationRound = H.flow('negotiationRound')
  .requires({ ref: z.string(), vendor: z.string(), item: z.string(), ceilingUsd: z.number() })
  .events({ vendorReplied: vendorReply })
  .step('proposal', negotiator, c => ({
    item: c.input.item,
    vendor: c.input.vendor,
    ceilingUsd: c.input.ceilingUsd,
    vendorMessages: c.events.vendorReplied.map(reply => reply.payload),
  }))
  .step('delivery', sendToVendor, c => ({ args: [c.input.ref, c.out.proposal.action], stdin: c.out.proposal.message }))
  .ends(['offered', 'agreed', 'walkedAway'], c =>
    c.out.proposal.action === 'accept' ? 'agreed' : c.out.proposal.action === 'walkAway' ? 'walkedAway' : 'offered');

const vendorBody = z.object({
  type: z.enum(['reply', 'accept', 'walkAway']),
  ref: z.string(),
  message: z.string(),
  priceUsd: z.number(),
});

const negotiations = H.lane('negotiations', Negotiation)
  .supply([
    H.supply.operator(),
    http.webhook(Negotiation, { path: '/vendor', port: H.slot.port(2), secret: H.env('VENDOR_WEBHOOK_SECRET'), body: vendorBody }, b => {
      switch (b.type) {
        case 'reply':
          return { key: b.ref, event: 'vendorReplied', payload: { message: b.message, priceUsd: b.priceUsd } };
        case 'accept':
          return { key: b.ref, event: 'vendorAccepted', payload: { priceUsd: b.priceUsd } };
        case 'walkAway':
          return { key: b.ref, event: 'vendorWalkedAway', payload: { message: b.message } };
      }
    }),
  ])
  .store(sqlite.store(Negotiation, '.harness/negotiations.sqlite'))
  .runner(shell)
  .wip(5)
  .reacts({
    vendorReplied: H.reaction(Drafting).from([AwaitingVendor]),
    vendorAccepted: H.reaction(Agreed).from([AwaitingVendor]),
    vendorWalkedAway: H.reaction(TheyWalkedAway).from([Drafting, Composing, AwaitingVendor, Stalled]),
    retryRound: H.reaction(Drafting).from([Stalled]),
    expiry: H.reaction(Expired).from([Drafting, Composing, AwaitingVendor, Stalled]),
  })
  .handler(negotiationRound, {
    states: { offered: AwaitingVendor, agreed: Agreed, walkedAway: WeWalkedAway, failed: Stalled },
  });

const lifecyclePriorities = H.policy.schedule('lifecyclePriorities', c => {
  const inconclusive = c.metrics.outcomes({ kind: Experiment, window: { days: 180 } }).share(Inconclusive);
  const experimentsLast = inconclusive.n >= 10 && inconclusive.rate !== null && inconclusive.rate > 0.5;
  const tier = (x: (typeof c.candidates)[number]) =>
    x.is(negotiations) ? 0 : x.is(tenancies) ? 1 : experimentsLast ? 3 : 2;
  return { start: [...c.candidates].sort((a, b) => tier(a) - tier(b) || b.waitedMs - a.waitedMs) };
});

const operatorDesk = H.access('operatorDesk').allows([
  H.ops.readWork,
  H.ops.createWork,
  H.ops.sendEvents,
  H.ops.resolveBlocks,
  H.ops.manageAttempts,
  H.ops.readTelemetry,
]);

export const lifecycles = H.harness('lifecycles')
  .ledger(sqlite.ledger('.harness/lifecycles.sqlite'))
  .lanes([experiments, tenancies, negotiations])
  .schedule(lifecyclePriorities)
  .clients([claudeCode.supervisor('operator', operatorDesk, { port: H.slot.port(0) })])
  .projections([markdown.board('BOARD.md'), markdown.telemetry('TELEMETRY.md')]);
