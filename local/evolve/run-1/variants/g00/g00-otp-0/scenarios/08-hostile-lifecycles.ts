import { z } from 'zod';
import { H } from 'harness-dsl';
import { sqlite } from 'harness-dsl/sqlite';
import { anthropic } from 'harness-dsl/anthropic';
import { claudeCode } from 'harness-dsl/claude-code';
import { http } from 'harness-dsl/http';
import { shell } from 'harness-dsl/shell';
import { markdown } from 'harness-dsl/markdown';

const Cancelled = H.state('cancelled', 'cancelled');

const Measuring = H.state('measuring', 'runnable');
const Collecting = H.state('collecting', 'waiting');
const Concluding = H.state('concluding', 'runnable');
const AWins = H.state('a-wins', 'ended');
const BWins = H.state('b-wins', 'ended');
const Inconclusive = H.state('inconclusive', 'ended');

const observation = z.object({ at: z.string(), a: z.number(), b: z.number() });
const experimentData = z.object({
  id: z.string(),
  name: z.string(),
  endsAt: z.string(),
  observations: z.array(observation),
  recommendation: z.string().nullable(),
});
type ExperimentData = z.infer<typeof experimentData>;

const Experiment = H.kind('Experiment', { data: experimentData, key: (experiment) => experiment.id })
  .states([Measuring, Collecting, Concluding, AWins, BWins, Inconclusive, Cancelled], { initial: Measuring })
  .timeout(Collecting, H.time.every({ hours: 1 }), 'hourElapsed')
  .timeout(Collecting, H.time.deadline((experiment: ExperimentData) => new Date(experiment.endsAt)), 'periodEnded')
  .on('hourElapsed', { from: [Collecting], to: Measuring })
  .on('periodEnded', { from: [Collecting], to: Concluding })
  .on('cancel', { from: [Measuring, Collecting, Concluding], to: Cancelled, attempt: 'cancel' });

const Evaluating = H.state('evaluating', 'runnable');
const Active = H.state('active', 'waiting');
const Suspended = H.state('suspended', 'waiting');
const Churned = H.state('churned', 'ended');

const Tenancy = H.kind('Tenancy', {
  data: z.object({
    tenantId: z.string(),
    customer: z.string(),
    plan: z.string(),
    lastDecision: z.enum(['upsell', 'hold']).nullable(),
  }),
  key: (tenancy) => tenancy.tenantId,
})
  .states([Active, Evaluating, Suspended, Churned], { initial: Active })
  .messages({
    suspended: z.object({ reason: z.string() }),
    reinstated: z.object({ reason: z.string() }),
    churned: z.object({ reason: z.string() }),
  })
  .timeout(Active, H.time.monthly(1, '09:00'), 'monthlyReview')
  .on('monthlyReview', { from: [Active], to: Evaluating })
  .on('suspended', { from: [Active, Evaluating], to: Suspended, attempt: 'cancel' })
  .on('reinstated', { from: [Suspended], to: Active })
  .on('churned', { from: [Active, Evaluating, Suspended], to: Churned, attempt: 'cancel' });

const Drafting = H.state('drafting', 'runnable');
const AwaitingVendor = H.state('awaiting-vendor', 'waiting');
const Agreed = H.state('agreed', 'succeeded');
const WalkedAwayByUs = H.state('walked-away-by-us', 'ended');
const WalkedAwayByThem = H.state('walked-away-by-them', 'failed');
const Expired = H.state('expired', 'failed');

const historyEntry = z.object({ from: z.enum(['us', 'vendor']), text: z.string() });
const negotiationData = z.object({
  id: z.string(),
  vendor: z.string(),
  item: z.string(),
  expiresAt: z.string(),
  rounds: z.number(),
  history: z.array(historyEntry),
});
type NegotiationData = z.infer<typeof negotiationData>;

const Negotiation = H.kind('Negotiation', { data: negotiationData, key: (negotiation) => negotiation.id })
  .states([Drafting, AwaitingVendor, Agreed, WalkedAwayByUs, WalkedAwayByThem, Expired, Cancelled], { initial: Drafting })
  .messages({
    vendorReplied: z.object({ text: z.string() }),
    vendorAccepted: z.object({ text: z.string() }),
    vendorWalkedAway: z.object({ text: z.string() }),
  })
  .timeout([Drafting, AwaitingVendor], H.time.deadline((negotiation: NegotiationData) => new Date(negotiation.expiresAt)), 'expired')
  .on('vendorReplied', {
    from: [AwaitingVendor],
    to: Drafting,
    update: (negotiation, reply) => ({ ...negotiation, history: [...negotiation.history, { from: 'vendor', text: reply.text }] }),
  })
  .on('vendorAccepted', { from: [AwaitingVendor, Drafting], to: Agreed, attempt: 'cancel' })
  .on('vendorWalkedAway', { from: [AwaitingVendor, Drafting], to: WalkedAwayByThem, attempt: 'cancel' })
  .on('expired', { from: [Drafting, AwaitingVendor], to: Expired, attempt: 'cancel' })
  .on('cancel', { from: [Drafting, AwaitingVendor], to: Cancelled, attempt: 'cancel' });

const apiAccount = anthropic.apiKey('business-api', { key: H.env('ANTHROPIC_API_KEY') });
const businessPool = H.pool('business').accounts([{ account: apiAccount, share: 1 }]);
const sonnet = anthropic.model('claude-sonnet-4-5');
const local = shell.local({ slots: 4 });

const measure = H.command('measure-experiment', {
  input: z.object({ experiment: z.string() }),
  output: observation,
  argv: (input) => ['experiment-metric', input.experiment, '--json'],
  runner: local,
});

const analyse = H.command('analyse-experiment', {
  input: z.object({ observations: z.array(observation) }),
  output: z.object({ verdict: z.enum(['a', 'b', 'inconclusive']) }),
  argv: (input) => ['analyse-ab', '--json', JSON.stringify(input.observations)],
  runner: local,
});

const inconclusiveHistory = H.policy('inconclusive-history', (input: { days: number }, context) => {
  const outcomes = context.metrics.outcomes({ kind: Experiment, days: input.days });
  const inconclusive = outcomes.byState[Inconclusive.name] ?? 0;
  return {
    inconclusive,
    samples: outcomes.samples,
    recommendLonger: outcomes.samples >= 10 && inconclusive / outcomes.samples >= 0.3,
  };
});

const takeMeasurement = H.flow(
  'take-measurement',
  {
    input: z.object({ name: z.string(), observations: z.array(observation) }),
    writes: z.object({ observations: z.array(observation) }),
    exits: ['measured'],
  },
  async (ctx) => {
    const reading = await ctx.run('measure', measure, { experiment: ctx.input.name });
    return ctx.exit('measured', { observations: [...ctx.input.observations, reading] });
  },
);

const concludeExperiment = H.flow(
  'conclude-experiment',
  {
    input: z.object({ observations: z.array(observation) }),
    writes: z.object({ recommendation: z.string().nullable() }),
    exits: ['aWins', 'bWins', 'inconclusive'],
  },
  async (ctx) => {
    const result = await ctx.run('analyse', analyse, { observations: ctx.input.observations });
    if (result.verdict === 'a') return ctx.exit('aWins', { recommendation: null });
    if (result.verdict === 'b') return ctx.exit('bWins', { recommendation: null });
    const history = await ctx.decide('inconclusive-history', inconclusiveHistory, { days: 180 });
    return ctx.exit('inconclusive', {
      recommendation: history.recommendLonger
        ? `${history.inconclusive} of ${history.samples} recent experiments were inconclusive; run the next one for four weeks`
        : null,
    });
  },
);

const experimentLane = H.lane('experiments', Experiment)
  .supply(H.supply.operator(Experiment))
  .store(sqlite.store('business.db'))
  .handle(Measuring, takeMeasurement, { exits: { measured: Collecting } })
  .handle(Concluding, concludeExperiment, { exits: { aWins: AWins, bWins: BWins, inconclusive: Inconclusive } });

const tenantUsage = H.command('tenant-usage', {
  input: z.object({ tenantId: z.string() }),
  output: z.object({ seats: z.number(), trend: z.string() }),
  argv: (input) => ['tenant-usage', input.tenantId, '--json'],
  runner: local,
});

const proposeUpsell = H.command('propose-upsell', {
  input: z.object({ tenantId: z.string(), plan: z.string() }),
  argv: (input) => ['crm-upsell', input.tenantId, '--from', input.plan],
  runner: local,
});

const accountSummarizer = H.agent(
  'account-summarizer',
  H.role('account-summarizer', {
    prompt: 'Summarise the tenancy usage for the monthly upsell decision.',
    intents: [],
    input: z.object({ customer: z.string(), plan: z.string(), seats: z.number(), trend: z.string() }),
    output: z.object({ summary: z.string() }),
  }),
)
  .model(sonnet)
  .pool(businessPool);

const monthlyReview = H.flow(
  'monthly-review',
  {
    input: z.object({ tenantId: z.string(), customer: z.string(), plan: z.string() }),
    writes: z.object({ lastDecision: z.enum(['upsell', 'hold']) }),
    exits: ['reviewed'],
  },
  async (ctx) => {
    const usage = await ctx.run('usage', tenantUsage, { tenantId: ctx.input.tenantId });
    const summary = await ctx.run('summarize', accountSummarizer, {
      customer: ctx.input.customer,
      plan: ctx.input.plan,
      seats: usage.seats,
      trend: usage.trend,
    });
    const decision = await ctx.halt('upsell-decision', {
      question: `Upsell ${ctx.input.customer} this month?`,
      report: summary.summary,
      decision: z.object({ decision: z.enum(['upsell', 'hold']) }),
    });
    if (decision.decision === 'upsell') {
      await ctx.run('propose-upsell', proposeUpsell, { tenantId: ctx.input.tenantId, plan: ctx.input.plan });
    }
    return ctx.exit('reviewed', { lastDecision: decision.decision });
  },
);

const billingEvents = http
  .webhook({
    port: H.slot.port(0),
    path: '/billing',
    secret: H.env('BILLING_WEBHOOK_SECRET'),
    body: z.object({
      type: z.enum(['signed-up', 'suspended', 'reinstated', 'churned']),
      tenantId: z.string(),
      customer: z.string(),
      plan: z.string(),
      reason: z.string(),
    }),
  })
  .to(Tenancy, (event, unit) => {
    if (event.type === 'signed-up') {
      return unit.create({ tenantId: event.tenantId, customer: event.customer, plan: event.plan, lastDecision: null });
    }
    if (event.type === 'suspended') return unit.send(event.tenantId, 'suspended', { reason: event.reason });
    if (event.type === 'reinstated') return unit.send(event.tenantId, 'reinstated', { reason: event.reason });
    return unit.send(event.tenantId, 'churned', { reason: event.reason });
  });

const tenancyLane = H.lane('tenancies', Tenancy)
  .supply(billingEvents, H.supply.operator(Tenancy))
  .store(sqlite.store('business.db'))
  .handle(Evaluating, monthlyReview, { exits: { reviewed: Active } });

const offerDrafter = H.agent(
  'offer-drafter',
  H.role('offer-drafter', {
    prompt: 'Draft our next offer in the procurement negotiation, given the history so far.',
    intents: [],
    input: z.object({ vendor: z.string(), item: z.string(), history: z.array(historyEntry) }),
    output: z.object({ offer: z.string(), rationale: z.string() }),
  }),
)
  .model(sonnet)
  .pool(businessPool);

const sendOffer = H.command('send-offer', {
  input: z.object({ negotiationId: z.string(), vendor: z.string(), offer: z.string() }),
  argv: (input) => ['send-offer', '--negotiation', input.negotiationId, '--vendor', input.vendor, '--body', input.offer],
  runner: local,
});

const negotiationRound = H.flow(
  'negotiation-round',
  {
    input: negotiationData,
    writes: z.object({ rounds: z.number(), history: z.array(historyEntry) }),
    exits: ['sent', 'walkedAway'],
  },
  async (ctx) => {
    const draft = await ctx.run('draft-offer', offerDrafter, {
      vendor: ctx.input.vendor,
      item: ctx.input.item,
      history: ctx.input.history,
    });
    const review = await ctx.halt('approve-offer', {
      question: `Round ${ctx.input.rounds + 1} with ${ctx.input.vendor}: send this offer or walk away?`,
      report: `${draft.offer}\n\n${draft.rationale}`,
      decision: z.object({ action: z.enum(['send', 'walkAway']), editedOffer: z.string().nullable() }),
    });
    if (review.action === 'walkAway') {
      return ctx.exit('walkedAway');
    }
    const offer = review.editedOffer ?? draft.offer;
    await ctx.run('send-offer', sendOffer, { negotiationId: ctx.input.id, vendor: ctx.input.vendor, offer });
    return ctx.exit('sent', { rounds: ctx.input.rounds + 1, history: [...ctx.input.history, { from: 'us', text: offer }] });
  },
);

const vendorReplies = http
  .webhook({
    port: H.slot.port(1),
    path: '/vendor',
    secret: H.env('VENDOR_WEBHOOK_SECRET'),
    body: z.object({ negotiationId: z.string(), type: z.enum(['reply', 'accept', 'walkAway']), text: z.string() }),
  })
  .to(Negotiation, (message, unit) => {
    if (message.type === 'reply') return unit.send(message.negotiationId, 'vendorReplied', { text: message.text });
    if (message.type === 'accept') return unit.send(message.negotiationId, 'vendorAccepted', { text: message.text });
    return unit.send(message.negotiationId, 'vendorWalkedAway', { text: message.text });
  });

const negotiationLane = H.lane('negotiations', Negotiation)
  .supply(vendorReplies, H.supply.operator(Negotiation))
  .store(sqlite.store('business.db'))
  .handle(Drafting, negotiationRound, { exits: { sent: AwaitingVendor, walkedAway: WalkedAwayByUs } });

const scheduler = H.scheduler('oldest-first', (query) => ({
  order: [...query.pending].sort((a, b) => b.waitingSeconds - a.waitingSeconds),
}));

const supervisor = H.client('supervisor', claudeCode.session()).grant([
  H.ops.readWork,
  H.ops.writeWork,
  H.ops.resolveBlockers,
  H.ops.readTelemetry,
]);

export const harness = H.harness('long-lived-work')
  .ledger(sqlite.ledger('business-ledger.db'))
  .lanes([experimentLane, tenancyLane, negotiationLane])
  .scheduler(scheduler)
  .clients([supervisor])
  .observers([markdown.board('BOARD.md'), markdown.telemetry('TELEMETRY.md')]);
