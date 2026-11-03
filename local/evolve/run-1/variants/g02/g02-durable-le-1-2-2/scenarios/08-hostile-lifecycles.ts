import { z } from 'zod';
import { H } from 'harness-dsl';
import * as anthropic from 'harness-dsl/anthropic';
import * as sqlite from 'harness-dsl/sqlite';
import * as http from 'harness-dsl/http';
import * as markdown from 'harness-dsl/markdown';
import * as local from 'harness-dsl/local';

const api = anthropic.account('lifecycles-api', { apiKey: H.env('ANTHROPIC_API_KEY') });
const sonnet = anthropic.model('claude-sonnet-4-5');
const runner = local.shell({ slots: 4 });
const store = (path: string) => path;

const Scheduled = H.state('Scheduled', 'pending');
const Collecting = H.state('Collecting', 'active');
const AWins = H.state('AWins', 'terminal', 'success');
const BWins = H.state('BWins', 'terminal', 'success');
const Inconclusive = H.state('Inconclusive', 'terminal', 'success');
const Aborted = H.state('Aborted', 'terminal', 'failure');

const Experiment = H.work('Experiment')
  .attributes({ experimentId: z.string() })
  .fields({ hypothesis: z.string() })
  .states([Scheduled, Collecting, AWins, BWins, Inconclusive, Aborted])
  .fails(Aborted)
  .key((u) => u.attributes.experimentId);

const collectMetric = H.command('collect-experiment-metric', ['./bin/collect-metric', '--json']).parses({ samples: z.number() });
const analyzeExperiment = H.command('analyze-experiment', ['./bin/analyze-experiment', '--json']).parses({
  winner: z.enum(['a', 'b', 'none']),
});

const runExperiment = H.flow('run-experiment')
  .requires({ experimentId: z.string() })
  .loop(
    'hours',
    { carry: { samples: z.number() }, rounds: () => 14 * 24 },
    (round) =>
      round
        .wait('nextHour', H.time.after({ hours: 1 }))
        .step('collect', collectMetric, (c) => ({ args: [c.input.experimentId, String(c.round)] }), {
          retry: H.retry.fixed({ maxRetries: 2, delayMs: 60000 }),
        }),
    (last) => ({ samples: last.collect.data.samples }),
  )
  .step('analyze', analyzeExperiment, (c) => ({ args: [c.input.experimentId] }))
  .ends(['aWins', 'bWins', 'inconclusive'], (c) =>
    c.out.analyze.data.winner === 'a' ? 'aWins' : c.out.analyze.data.winner === 'b' ? 'bWins' : 'inconclusive',
  );

const experiments = H.lane('experiments', Experiment)
  .supply([H.supply.operator()])
  .store(sqlite.store(Experiment, store('.harness/work.sqlite')))
  .runner(runner)
  .wip(5)
  .handler(runExperiment, { ends: { aWins: AWins, bWins: BWins, inconclusive: Inconclusive } });

const Current = H.state('Current', 'waiting');
const DueReview = H.state('DueReview', 'pending');
const Reviewing = H.state('Reviewing', 'active');
const Suspended = H.state('Suspended', 'waiting');
const Churned = H.state('Churned', 'terminal', 'neutral');

const Tenancy = H.work('Tenancy')
  .attributes({ tenantId: z.string(), plan: z.string() })
  .fields({ company: z.string() })
  .states([Current, DueReview, Reviewing, Suspended, Churned])
  .events({ suspended: { reason: z.string() }, reinstated: {}, churned: { reason: z.string() } })
  .timers(() => ({ monthlyReview: H.time.monthly(1, '09:00', 'Europe/London') }))
  .key((u) => u.attributes.tenantId);

const usageReport = H.command('tenant-usage', ['./bin/tenant-usage']);

const accountSummaryRole = H.role('account-summarizer')
  .intents(['read'])
  .instructions('Summarize the tenant\'s month in plain language: usage trend, risks, and whether an upsell is plausible.')
  .input({ company: z.string(), plan: z.string(), usage: z.string() })
  .output({ summary: z.string() });

const accountSummarizer = H.agent('account-summarizer', accountSummaryRole).model(sonnet).pool(api);

const upsellDecision = H.decision('upsell-decision', { upsell: z.boolean(), note: z.string() });

const reviewTenancy = H.flow('review-tenancy')
  .requires({ tenantId: z.string(), plan: z.string(), company: z.string() })
  .step('usage', usageReport, (c) => ({ args: [c.input.tenantId] }))
  .step('summary', accountSummarizer, (c) => ({ company: c.input.company, plan: c.input.plan, usage: c.out.usage.stdout }))
  .halt('upsell', upsellDecision, { ask: (c) => `${c.input.company} (${c.input.plan}): ${c.out.summary.summary}` })
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
          type: z.enum(['signup', 'suspended', 'reinstated', 'churned']),
          tenantId: z.string(),
          plan: z.string(),
          company: z.string(),
          reason: z.string(),
        }),
      },
      (b, to) =>
        b.type === 'signup'
          ? to.create({ attributes: { tenantId: b.tenantId, plan: b.plan }, fields: { company: b.company } })
          : b.type === 'reinstated'
            ? to.event(b.tenantId, 'reinstated', {})
            : to.event(b.tenantId, b.type, { reason: b.reason }),
    ),
  ])
  .store(sqlite.store(Tenancy, store('.harness/work.sqlite')))
  .runner(runner)
  .reacts({
    monthlyReview: H.reaction(DueReview).from([Current]),
    suspended: H.reaction(Suspended).from([Current, DueReview, Reviewing]).cancels(),
    reinstated: H.reaction(Current).from([Suspended]),
    churned: H.reaction(Churned).from([Current, DueReview, Reviewing, Suspended]).cancels(),
  })
  .handler(reviewTenancy, { ends: { reviewed: Current } });

const Opening = H.state('Opening', 'pending');
const DraftingOffer = H.state('DraftingOffer', 'active');
const AwaitingVendor = H.state('AwaitingVendor', 'waiting');
const VendorReplied = H.state('VendorReplied', 'pending');
const Agreed = H.state('Agreed', 'terminal', 'success');
const WalkedAwayByUs = H.state('WalkedAwayByUs', 'terminal', 'neutral');
const WalkedAwayByThem = H.state('WalkedAwayByThem', 'terminal', 'failure');
const Expired = H.state('Expired', 'terminal', 'failure');

const Negotiation = H.work('Negotiation')
  .attributes({ negotiationId: z.string(), vendor: z.string(), deadline: z.number() })
  .fields({ brief: z.string() })
  .states([Opening, DraftingOffer, AwaitingVendor, VendorReplied, Agreed, WalkedAwayByUs, WalkedAwayByThem, Expired])
  .events({
    vendorCountered: { message: z.string() },
    vendorAccepted: { message: z.string() },
    vendorWalkedAway: { message: z.string() },
  })
  .timers((t) => ({ expiry: t.attribute('deadline') }))
  .key((u) => u.attributes.negotiationId);

const negotiatorRole = H.role('negotiator')
  .intents(['read'])
  .instructions('Decide our next move in the procurement negotiation within the brief: make an offer, accept their last counter, or walk away.')
  .input({ vendor: z.string(), brief: z.string(), lastVendorMessage: z.string() })
  .output({ move: z.enum(['offer', 'accept', 'walkAway']), message: z.string() });

const negotiator = H.agent('negotiator', negotiatorRole).model(sonnet).pool(api);
const sendMove = H.command('send-negotiation-move', ['./bin/send-negotiation-move']);

const negotiateRound = H.flow('negotiate-round')
  .requires({ negotiationId: z.string(), vendor: z.string(), brief: z.string() })
  .events({ vendorCountered: { message: z.string() } })
  .step('draft', negotiator, (c) => ({
    vendor: c.input.vendor,
    brief: c.input.brief,
    lastVendorMessage: c.events.vendorCountered.reduce((_previous, received) => received.payload.message, ''),
  }))
  .step('send', sendMove, (c) => ({ args: [c.input.negotiationId, c.out.draft.move], stdin: c.out.draft.message }), {
    restart: 'park',
  })
  .ends(['offered', 'agreed', 'walkedAway'], (c) =>
    c.out.draft.move === 'accept' ? 'agreed' : c.out.draft.move === 'walkAway' ? 'walkedAway' : 'offered',
  );

const negotiations = H.lane('negotiations', Negotiation)
  .supply([
    H.supply.operator(),
    http.webhook(
      Negotiation,
      {
        path: '/vendor-replies',
        port: H.slot.port(2),
        secret: H.env('VENDOR_WEBHOOK_SECRET'),
        body: z.object({ negotiationId: z.string(), reply: z.enum(['counter', 'accept', 'walkAway']), message: z.string() }),
      },
      (b, to) =>
        to.event(
          b.negotiationId,
          b.reply === 'counter' ? 'vendorCountered' : b.reply === 'accept' ? 'vendorAccepted' : 'vendorWalkedAway',
          { message: b.message },
        ),
    ),
  ])
  .store(sqlite.store(Negotiation, store('.harness/work.sqlite')))
  .runner(runner)
  .reacts({
    vendorCountered: H.reaction(VendorReplied).from([AwaitingVendor]),
    vendorAccepted: H.reaction(Agreed).from([AwaitingVendor]),
    vendorWalkedAway: H.reaction(WalkedAwayByThem).from([Opening, DraftingOffer, AwaitingVendor, VendorReplied]).cancels(),
    expiry: H.reaction(Expired).from([Opening, DraftingOffer, AwaitingVendor, VendorReplied]).cancels(),
  })
  .handler(negotiateRound, { ends: { offered: AwaitingVendor, agreed: Agreed, walkedAway: WalkedAwayByUs } });

const holdExperimentsWhenInconclusive = H.policy.schedule('hold-experiments-when-inconclusive', (c) => {
  const inconclusive = c.metrics.outcomes({ kind: Experiment, window: { days: 90 } }).share(Inconclusive);
  const hold = inconclusive.n >= 10 && inconclusive.rate !== null && inconclusive.rate > 0.5;
  return { start: c.candidates.filter((x) => !(hold && x.is(experiments))) };
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
  .ledger(sqlite.ledger('.harness/ledger.sqlite'))
  .lanes([experiments, tenancies, negotiations])
  .schedule(holdExperimentsWhenInconclusive)
  .clients([http.server('operator-api', operatorAccess, { port: H.slot.port(0), token: H.env('OPERATOR_TOKEN') })])
  .projections([markdown.board('.harness/board.md'), markdown.telemetry('.harness/telemetry.md')]);
