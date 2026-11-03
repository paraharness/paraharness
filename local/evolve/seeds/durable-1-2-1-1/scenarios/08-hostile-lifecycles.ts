import { z } from 'zod';
import { H } from 'harness-dsl';
import * as sqlite from 'harness-dsl/sqlite';
import * as anthropic from 'harness-dsl/anthropic';
import * as claudeCode from 'harness-dsl/claude-code';
import * as http from 'harness-dsl/http';
import * as local from 'harness-dsl/local';
import * as markdown from 'harness-dsl/markdown';

const api = anthropic.account('lifecycles-api', { apiKey: H.env('ANTHROPIC_API_KEY') });
const sonnet = anthropic.model('claude-sonnet-4-5');
const shell = local.shell({ slots: 4 });

const ExperimentDue = H.state('ExperimentDue', 'pending');
const Measuring = H.state('Measuring', 'active');
const Observing = H.state('Observing', 'waiting');
const VariantAWins = H.state('VariantAWins', 'terminal', 'success');
const VariantBWins = H.state('VariantBWins', 'terminal', 'success');
const Inconclusive = H.state('Inconclusive', 'terminal', 'neutral');

const Experiment = H.work('Experiment')
  .attributes({ slug: z.string(), variantA: z.string(), variantB: z.string(), endsAt: z.number() })
  .states([ExperimentDue, Measuring, Observing, VariantAWins, VariantBWins, Inconclusive])
  .timers(() => ({ hourly: H.time.every({ hours: 1 }) }))
  .key((u) => u.attributes.slug);

const measure = H.command('measure-experiment', ['scripts/measure.sh']).parses({
  verdict: z.enum(['continue', 'a', 'b', 'none']),
  lift: z.number(),
  samples: z.number(),
});

const hourlyMeasurement = H.flow('hourly-measurement')
  .requires({ slug: z.string(), endsAt: z.number() })
  .step('measure', measure, (c) => ({ args: [c.input.slug, String(c.input.endsAt)] }))
  .ends(['continue', 'a', 'b', 'none'], (c) => c.out.measure.data.verdict);

const experiments = H.lane('experiments', Experiment)
  .supply([H.supply.operator()])
  .store(sqlite.store(Experiment, 'state/experiments.sqlite'))
  .runner(shell)
  .handler(hourlyMeasurement, {
    opens: Measuring,
    states: { measure: Measuring, continue: Observing, a: VariantAWins, b: VariantBWins, none: Inconclusive },
  })
  .reacts({ hourly: H.reaction(ExperimentDue).from([Observing]) });

const ReviewDue = H.state('ReviewDue', 'pending');
const UsageReview = H.state('UsageReview', 'active');
const AwaitingUpsellCall = H.state('AwaitingUpsellCall', 'waiting');
const Current = H.state('Current', 'waiting');
const Suspended = H.state('Suspended', 'waiting');
const Churned = H.state('Churned', 'terminal', 'neutral');

const Tenancy = H.work('Tenancy')
  .attributes({ customer: z.string(), plan: z.string() })
  .states([ReviewDue, UsageReview, AwaitingUpsellCall, Current, Suspended, Churned])
  .events({
    suspended: { reason: z.string() },
    reinstated: { reason: z.string() },
    churned: { reason: z.string() },
  })
  .timers(() => ({ monthly: H.time.monthly(1, '09:00', 'Europe/London') }))
  .key((u) => u.attributes.customer);

const usageReport = H.command('usage-report', ['scripts/usage.sh']).parses({
  seats: z.number(),
  monthlyUsd: z.number(),
  trend: z.string(),
});

const tenancySummarizer = H.agent(
  'tenancy-summarizer',
  H.role('account-summarizer')
    .intents(['read'])
    .instructions('Summarise the month of usage and state the case for or against an upsell.')
    .input({ customer: z.string(), plan: z.string(), seats: z.number(), monthlyUsd: z.number(), trend: z.string() })
    .output({ summary: z.string(), upsellCase: z.string() }),
)
  .model(sonnet)
  .pool(api);

const upsellCall = H.decision('upsell-call', { upsell: z.boolean(), note: z.string() });

const monthlyReview = H.flow('monthly-review')
  .requires({ customer: z.string(), plan: z.string() })
  .step('usage', usageReport, (c) => ({ args: [c.input.customer] }))
  .step('summary', tenancySummarizer, (c) => ({
    customer: c.input.customer,
    plan: c.input.plan,
    seats: c.out.usage.data.seats,
    monthlyUsd: c.out.usage.data.monthlyUsd,
    trend: c.out.usage.data.trend,
  }))
  .halt('upsell', upsellCall, {
    ask: (c) => `Upsell ${c.input.customer}?\n\n${c.out.summary.summary}\n\n${c.out.summary.upsellCase}`,
  })
  .ends(['reviewed'], () => 'reviewed');

const tenancies = H.lane('tenancies', Tenancy)
  .supply([
    H.supply.operator(),
    http.webhook(
      Tenancy,
      {
        path: '/billing',
        port: H.slot.port(1),
        secret: H.env('BILLING_WEBHOOK_SECRET'),
        body: z.object({
          type: z.enum(['signed', 'suspended', 'reinstated', 'churned']),
          customer: z.string(),
          plan: z.string(),
          reason: z.string(),
        }),
      },
      (body, s) =>
        body.type === 'signed'
          ? s.create({ attributes: { customer: body.customer, plan: body.plan } })
          : body.type === 'suspended'
            ? s.event(body.customer, 'suspended', { reason: body.reason })
            : body.type === 'reinstated'
              ? s.event(body.customer, 'reinstated', { reason: body.reason })
              : s.event(body.customer, 'churned', { reason: body.reason }),
    ),
  ])
  .store(sqlite.store(Tenancy, 'state/tenancies.sqlite'))
  .runner(shell)
  .handler(monthlyReview, {
    opens: UsageReview,
    states: { usage: UsageReview, upsell: AwaitingUpsellCall, reviewed: Current },
  })
  .reacts({
    monthly: H.reaction(ReviewDue).from([Current]),
    suspended: H.reaction(Suspended).from([Current, ReviewDue, UsageReview, AwaitingUpsellCall]).cancels(),
    reinstated: H.reaction(Current).from([Suspended]),
    churned: H.reaction(Churned).from([ReviewDue, UsageReview, AwaitingUpsellCall, Current, Suspended]).cancels(),
  });

const Opening = H.state('Opening', 'pending');
const RoundDue = H.state('RoundDue', 'pending');
const DraftingOffer = H.state('DraftingOffer', 'active');
const AwaitingVendor = H.state('AwaitingVendor', 'waiting');
const Agreed = H.state('Agreed', 'terminal', 'success');
const WalkedAwayUs = H.state('WalkedAwayUs', 'terminal', 'neutral');
const WalkedAwayThem = H.state('WalkedAwayThem', 'terminal', 'failure');
const Expired = H.state('Expired', 'terminal', 'failure');

const Negotiation = H.work('Negotiation')
  .attributes({ reference: z.string(), vendor: z.string(), target: z.string(), expiresAt: z.number() })
  .states([Opening, RoundDue, DraftingOffer, AwaitingVendor, Agreed, WalkedAwayUs, WalkedAwayThem, Expired])
  .events({
    vendorReplied: { message: z.string() },
    vendorAccepted: { message: z.string() },
    vendorWalkedAway: { message: z.string() },
  })
  .timers((t) => ({ expiry: t.attribute('expiresAt') }))
  .key((u) => u.attributes.reference);

const negotiator = H.agent(
  'negotiator',
  H.role('negotiation-drafter')
    .intents(['read'])
    .instructions('Draft the next offer toward the target, or accept, or walk away when the target cannot be met.')
    .input({ vendor: z.string(), target: z.string(), history: z.array(z.string()) })
    .output({ offer: z.string(), move: z.enum(['offer', 'accept', 'walkAway']) }),
)
  .model(sonnet)
  .pool(api);

const sendOffer = H.command('send-offer', ['scripts/send-offer.sh']);

const negotiationRound = H.flow('negotiation-round')
  .requires({ reference: z.string(), vendor: z.string(), target: z.string() })
  .events({ vendorReplied: { message: z.string() } })
  .step('draft', negotiator, (c) => ({
    vendor: c.input.vendor,
    target: c.input.target,
    history: c.events.vendorReplied.map((reply) => reply.payload.message),
  }))
  .step('send', sendOffer, (c) => ({ args: [c.input.reference], stdin: JSON.stringify(c.out.draft) }))
  .ends(['sent', 'agreed', 'walkedAway'], (c) =>
    c.out.draft.move === 'offer' ? 'sent' : c.out.draft.move === 'accept' ? 'agreed' : 'walkedAway',
  );

const negotiations = H.lane('negotiations', Negotiation)
  .supply([
    H.supply.operator(),
    http.webhook(
      Negotiation,
      {
        path: '/vendor-replies',
        port: H.slot.port(1),
        secret: H.env('VENDOR_WEBHOOK_SECRET'),
        body: z.object({ reference: z.string(), type: z.enum(['reply', 'accept', 'walkAway']), message: z.string() }),
      },
      (body, s) =>
        body.type === 'reply'
          ? s.event(body.reference, 'vendorReplied', { message: body.message })
          : body.type === 'accept'
            ? s.event(body.reference, 'vendorAccepted', { message: body.message })
            : s.event(body.reference, 'vendorWalkedAway', { message: body.message }),
    ),
  ])
  .store(sqlite.store(Negotiation, 'state/negotiations.sqlite'))
  .runner(shell)
  .handler(negotiationRound, {
    opens: DraftingOffer,
    states: { draft: DraftingOffer, sent: AwaitingVendor, agreed: Agreed, walkedAway: WalkedAwayUs },
  })
  .reacts({
    vendorReplied: H.reaction(RoundDue).from([AwaitingVendor]),
    vendorAccepted: H.reaction(Agreed).from([AwaitingVendor, RoundDue]),
    vendorWalkedAway: H.reaction(WalkedAwayThem).from([Opening, AwaitingVendor, RoundDue]),
    expiry: H.reaction(Expired).from([Opening, RoundDue, DraftingOffer, AwaitingVendor]).cancels(),
  });

const lifecycleSchedule = H.policy.schedule('rounds-reviews-experiments', (c) => {
  const inconclusive = c.metrics.outcomes({ kind: Experiment, window: { days: 180 } }).share(Inconclusive);
  const experimentsLast = inconclusive.n >= 10 && inconclusive.rate !== null && inconclusive.rate > 0.5;
  return {
    start: c.order(
      (x) => (x.is(negotiations) ? 0 : x.is(tenancies) ? 1 : experimentsLast ? 3 : 2),
      (x) => -x.waitedMs,
    ),
  };
});

const operatorAccess = H.access('operator').allows([
  H.ops.readWork,
  H.ops.createWork,
  H.ops.sendEvents,
  H.ops.resolveBlocks,
  H.ops.readTelemetry,
]);

export const lifecycles = H.harness('lifecycles')
  .ledger(sqlite.ledger('state/lifecycles.sqlite'))
  .lanes([experiments, tenancies, negotiations])
  .schedule(lifecycleSchedule)
  .clients([claudeCode.supervisor('lifecycle-supervisor', operatorAccess, { port: H.slot.port(0) })])
  .projections([markdown.board('BOARD.md'), markdown.telemetry('TELEMETRY.md')]);

export const running = lifecycles.start();
