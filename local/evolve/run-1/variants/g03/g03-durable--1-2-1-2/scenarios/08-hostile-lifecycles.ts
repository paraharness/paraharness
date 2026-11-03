import { z } from 'zod';
import { H } from 'harness-dsl';
import * as sqlite from 'harness-dsl/sqlite';
import * as anthropic from 'harness-dsl/anthropic';
import * as claudeCode from 'harness-dsl/claude-code';
import * as http from 'harness-dsl/http';
import * as local from 'harness-dsl/local';
import * as markdown from 'harness-dsl/markdown';

const Dropped = H.state('dropped', 'terminal', 'failure');
const apiAccount = anthropic.account('api', { apiKey: H.env('ANTHROPIC_API_KEY') });
const sonnet = anthropic.model('claude-sonnet-4-5');
const runner = local.shell({ slots: 4 });
const retryThrice = H.retry.exponential({ maxRetries: 3, initialDelayMs: 300_000 });

const SampleDue = H.state('sampleDue', 'pending');
const Sampling = H.state('sampling', 'active');
const Observing = H.state('observing', 'waiting');
const AWins = H.state('aWins', 'terminal', 'success');
const BWins = H.state('bWins', 'terminal', 'success');
const Inconclusive = H.state('inconclusive', 'terminal', 'neutral');

const Experiment = H.work('Experiment')
  .attributes({ experimentId: z.string(), endsAt: z.number() })
  .states([SampleDue, Sampling, Observing, AWins, BWins, Inconclusive, Dropped])
  .timers(() => ({ hourly: H.time.every({ hours: 1 }) }))
  .key(unit => unit.attributes.experimentId);

const sampleMetric = H.command('sampleExperiment', ['./bin/experiment', 'sample']);
const analyze = H.command('analyzeExperiment', ['./bin/experiment', 'analyze']).parses({
  winner: z.enum(['a', 'b', 'none']),
});

const experimentFlow = H.flow('experimentRound')
  .requires({ experimentId: z.string(), endsAt: z.number() })
  .step('sample', sampleMetric, c => ({ args: [c.input.experimentId] }), { restart: 'rerun' })
  .exit('continue', c => c.attempt.startedAt < c.input.endsAt)
  .step('analyze', analyze, c => ({ args: [c.input.experimentId] }), { restart: 'rerun' })
  .ends(['aWins', 'bWins', 'inconclusive'], c =>
    c.out.analyze.data.winner === 'a' ? 'aWins' : c.out.analyze.data.winner === 'b' ? 'bWins' : 'inconclusive',
  );

const experiments = H.lane('experiments', Experiment)
  .supply([H.supply.operator()])
  .runner(runner)
  .handler(experimentFlow, {
    opens: Sampling,
    ends: { continue: Observing, aWins: AWins, bWins: BWins, inconclusive: Inconclusive },
  })
  .retry(retryThrice, { exhausted: Dropped });

const sampleWhenDue = H.trigger('experimentSampleDue', H.on.event(experiments, 'hourly')).moves(SampleDue, { from: [Observing] });

const Customer = H.state('customer', 'waiting');
const EvaluationDue = H.state('evaluationDue', 'pending');
const Evaluating = H.state('evaluating', 'active');
const AwaitingDecision = H.state('awaitingDecision', 'waiting');
const Suspended = H.state('suspended', 'waiting');
const Churned = H.state('churned', 'terminal', 'neutral');

const Tenancy = H.work('Tenancy')
  .attributes({ tenantId: z.string(), plan: z.string() })
  .states([EvaluationDue, Customer, Evaluating, AwaitingDecision, Suspended, Churned])
  .events({ suspended: { reason: z.string() }, reinstated: {}, churned: { reason: z.string() } })
  .timers(() => ({ monthlyReview: H.time.monthly(1, '09:00', 'Europe/London') }))
  .key(unit => unit.attributes.tenantId);

const usageReport = H.command('usageReport', ['./bin/usage', 'report']).parses({ seats: z.number(), usageUsd: z.number() });
const summaryRole = H.role('accountSummarizer')
  .intents(['read'])
  .instructions('Summarise the tenant month in five sentences for an upsell decision.')
  .input({ tenantId: z.string(), plan: z.string(), seats: z.number(), usageUsd: z.number() })
  .output({ summary: z.string() });
const summarizer = H.agent('accountSummarizer', summaryRole).model(sonnet).pool(apiAccount);
const upsellDecision = H.decision('upsell', { upsell: z.boolean(), note: z.string() });

const tenancyFlow = H.flow('monthlyEvaluation')
  .requires({ tenantId: z.string(), plan: z.string() })
  .step('usage', usageReport, c => ({ args: [c.input.tenantId] }), { restart: 'rerun' })
  .step('summary', summarizer, c => ({
    tenantId: c.input.tenantId,
    plan: c.input.plan,
    seats: c.out.usage.data.seats,
    usageUsd: c.out.usage.data.usageUsd,
  }))
  .halt('decide', upsellDecision, { ask: c => `Upsell ${c.input.tenantId}?\n${c.out.summary.summary}` })
  .ends(['evaluated'], () => 'evaluated');

const tenancies = H.lane('tenancies', Tenancy)
  .supply([H.supply.operator()])
  .runner(runner)
  .handler(tenancyFlow, { opens: Evaluating, halts: { decide: AwaitingDecision }, ends: { evaluated: Customer } })
  .retry(retryThrice, { exhausted: Customer });

const monthlyReview = H.trigger('tenancyReviewDue', H.on.event(tenancies, 'monthlyReview')).moves(EvaluationDue, { from: [Customer] });
const suspend = H.trigger('tenancySuspended', H.on.event(tenancies, 'suspended'))
  .moves(Suspended, { from: [Customer, EvaluationDue, Evaluating, AwaitingDecision], cancels: true });
const reinstate = H.trigger('tenancyReinstated', H.on.event(tenancies, 'reinstated')).moves(Customer, { from: [Suspended] });
const churn = H.trigger('tenancyChurned', H.on.event(tenancies, 'churned'))
  .moves(Churned, { from: [Customer, EvaluationDue, Evaluating, AwaitingDecision, Suspended], cancels: true });

const Opening = H.state('opening', 'pending');
const RoundDue = H.state('roundDue', 'pending');
const Drafting = H.state('drafting', 'active');
const AwaitingVendor = H.state('awaitingVendor', 'waiting');
const Agreed = H.state('agreed', 'terminal', 'success');
const WalkedAwayByUs = H.state('walkedAwayByUs', 'terminal', 'neutral');
const WalkedAwayByThem = H.state('walkedAwayByThem', 'terminal', 'neutral');
const Expired = H.state('expired', 'terminal', 'neutral');

const Negotiation = H.work('Negotiation')
  .attributes({ negotiationId: z.string(), vendor: z.string(), deadline: z.number() })
  .fields({ brief: z.string() })
  .states([Opening, RoundDue, Drafting, AwaitingVendor, Agreed, WalkedAwayByUs, WalkedAwayByThem, Expired, Dropped])
  .events({ vendorReplied: { text: z.string() }, vendorAccepted: { text: z.string() }, vendorWalked: { reason: z.string() } })
  .timers(t => ({ expiry: t.attribute('deadline') }))
  .key(unit => unit.attributes.negotiationId);

const negotiatorRole = H.role('negotiator')
  .intents(['read'])
  .instructions('Draft our next offer within the brief, accept a reply that meets it, or walk away.')
  .input({ vendor: z.string(), brief: z.string(), replies: z.array(z.string()) })
  .output({ action: z.enum(['offer', 'accept', 'walkAway']), offer: z.string() });
const negotiator = H.agent('negotiator', negotiatorRole).model(sonnet).pool(apiAccount);
const sendOffer = H.command('sendOffer', ['./bin/procurement', 'send-offer']);

const roundFlow = H.flow('negotiationRound')
  .requires({ negotiationId: z.string(), vendor: z.string(), brief: z.string() })
  .events({ vendorReplied: { text: z.string() } })
  .step('draft', negotiator, c => ({
    vendor: c.input.vendor,
    brief: c.input.brief,
    replies: c.events.vendorReplied.map(reply => reply.payload.text),
  }))
  .exit('agreed', c => c.out.draft.action === 'accept')
  .exit('walkedAway', c => c.out.draft.action === 'walkAway')
  .step('send', sendOffer, c => ({ args: [c.input.negotiationId], stdin: c.out.draft.offer }))
  .ends(['offered'], () => 'offered');

const negotiations = H.lane('negotiations', Negotiation)
  .supply([
    H.supply.operator(),
    http.webhook(
      Negotiation,
      {
        path: '/vendor',
        port: H.slot.port(1),
        secret: H.env('VENDOR_WEBHOOK_SECRET'),
        body: z.object({ negotiationId: z.string(), type: z.enum(['reply', 'accept', 'walk']), text: z.string() }),
      },
      (body, supply) =>
        body.type === 'reply'
          ? supply.event(body.negotiationId, 'vendorReplied', { text: body.text })
          : body.type === 'accept'
            ? supply.event(body.negotiationId, 'vendorAccepted', { text: body.text })
            : supply.event(body.negotiationId, 'vendorWalked', { reason: body.text }),
    ),
  ])
  .runner(runner)
  .handler(roundFlow, {
    opens: Drafting,
    ends: { offered: AwaitingVendor, agreed: Agreed, walkedAway: WalkedAwayByUs },
  })
  .retry(retryThrice, { exhausted: Dropped });

const openNegotiations = [Opening, RoundDue, Drafting, AwaitingVendor];
const vendorReplied = H.trigger('vendorReplied', H.on.event(negotiations, 'vendorReplied')).moves(RoundDue, { from: [AwaitingVendor] });
const vendorAccepted = H.trigger('vendorAccepted', H.on.event(negotiations, 'vendorAccepted'))
  .moves(Agreed, { from: openNegotiations, cancels: true });
const vendorWalked = H.trigger('vendorWalked', H.on.event(negotiations, 'vendorWalked'))
  .moves(WalkedAwayByThem, { from: openNegotiations, cancels: true });
const negotiationExpired = H.trigger('negotiationExpired', H.on.event(negotiations, 'expiry'))
  .moves(Expired, { from: openNegotiations, cancels: true });

const lifecycleSchedule = H.policy.schedule('lifecycleSchedule', c => {
  const inconclusive = c.metrics.outcomes({ lane: experiments, window: { days: 90 } }).share(Inconclusive);
  const deferExperiments = inconclusive.n >= 10 && (inconclusive.rate ?? 0) > 0.5;
  return {
    start: c.order(
      candidate => (candidate.is(negotiations) ? 0 : candidate.is(experiments) && deferExperiments ? 2 : 1),
      candidate => candidate.enqueuedAt,
    ),
  };
});

const operatorAccess = H.access('operator').allows([
  H.ops.readWork,
  H.ops.createWork,
  H.ops.sendEvents,
  H.ops.resolveBlocks,
  H.ops.manageAttempts,
  H.ops.readTelemetry,
]);

const harness = H.harness('lifecycles')
  .ledger(sqlite.ledger('.harness/ledger.sqlite'))
  .lanes([experiments, tenancies, negotiations])
  .triggers([
    sampleWhenDue,
    monthlyReview,
    suspend,
    reinstate,
    churn,
    vendorReplied,
    vendorAccepted,
    vendorWalked,
    negotiationExpired,
  ])
  .schedule(lifecycleSchedule)
  .clients([claudeCode.supervisor('operator', operatorAccess, { port: H.slot.port(0) })])
  .projections([markdown.board('BOARD.md'), markdown.telemetry('TELEMETRY.md')]);

void harness.start();
