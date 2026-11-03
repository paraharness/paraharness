import { z } from 'zod';
import { H } from 'harness-dsl';
import type { Metrics, PendingUnit, State, SupplyEvent } from 'harness-dsl';
import { anthropic } from 'harness-dsl/anthropic';
import { claudeCode } from 'harness-dsl/claude-code';
import { sqlite } from 'harness-dsl/sqlite';
import { jsonl } from 'harness-dsl/jsonl';
import { manual, schedule, webhook } from 'harness-dsl/supply';
import { byApplicability } from 'harness-dsl/policies';
import { board, telemetry } from 'harness-dsl/observers';
import { local } from 'harness-dsl/local';

const experiment = z.object({
  hypothesis: z.string(),
  startedAt: z.date(),
  visitorsA: z.number(),
  conversionsA: z.number(),
  visitorsB: z.number(),
  conversionsB: z.number(),
});
type ExperimentData = z.infer<typeof experiment>;
type Totals = Pick<ExperimentData, 'visitorsA' | 'conversionsA' | 'visitorsB' | 'conversionsB'>;

const tenancy = z.object({
  customer: z.string(),
  plan: z.string(),
  lastReviewAt: z.date().nullable(),
  lastDecision: z.string().nullable(),
});
type TenancyData = z.infer<typeof tenancy>;

const negotiation = z.object({
  vendor: z.string(),
  item: z.string(),
  expiresAt: z.date(),
  round: z.number(),
  lastVendorMessage: z.string(),
  lastOffer: z.string(),
});
type NegotiationData = z.infer<typeof negotiation>;

const MeasurementDue = H.state('measurement-due').pending();
const ExperimentRunning = H.state('experiment-running').active();
const AWins = H.state('a-wins').succeeded();
const BWins = H.state('b-wins').succeeded();
const Inconclusive = H.state('inconclusive').ended();
const MeasurementFailed = H.state('measurement-failed').failed();

const ReviewDue = H.state('review-due').pending();
const TenancyActive = H.state('tenancy-active').active();
const UnderReview = H.state('under-review').active();
const Suspended = H.state('suspended').active();
const Churned = H.state('churned').ended();

const OurTurn = H.state('our-turn').pending();
const AwaitingVendor = H.state('awaiting-vendor').active();
const Agreed = H.state('agreed').succeeded();
const WalkedAwayByUs = H.state('walked-away-by-us').ended();
const WalkedAwayByThem = H.state('walked-away-by-them').ended();
const Expired = H.state('expired').ended();

const Experiment = H.work('experiment')
  .schema(experiment)
  .states(MeasurementDue, ExperimentRunning, AWins, BWins, Inconclusive, MeasurementFailed);
const Tenancy = H.work('tenancy')
  .schema(tenancy)
  .states(ReviewDue, TenancyActive, UnderReview, Suspended, Churned);
const Negotiation = H.work('negotiation')
  .schema(negotiation)
  .states(OurTurn, AwaitingVendor, Agreed, WalkedAwayByUs, WalkedAwayByThem, Expired);

const Experience = H.memory('experience').content(
  z.object({ do: z.string(), when: z.string(), because: z.string() }),
);
const experience = H.journal('experience')
  .of(Experience)
  .store(jsonl.store('.harness/experience.jsonl'))
  .recall(byApplicability({ budgetTokens: 1200 }));

const apiAccount = H.account('anthropic-api', anthropic.api({ apiKey: H.env('ANTHROPIC_API_KEY') }));
const sonnet = H.model('sonnet', apiAccount, 'claude-sonnet-4-5');

const accountManager = H.agent('account-manager')
  .role(H.role('account-manager').prompt('Summarise the tenancy usage and whether an upsell is warranted.').recall(Experience))
  .model(sonnet);
const negotiator = H.agent('negotiator')
  .role(
    H.role('negotiator')
      .prompt('Decide the next move in the procurement negotiation and draft the offer.')
      .recall(Experience)
      .record(Experience),
  )
  .model(sonnet);

const localRunner = H.runner('local', local()).slots(4);

const hourlyCounts = z.object({
  visitorsA: z.number(),
  conversionsA: z.number(),
  visitorsB: z.number(),
  conversionsB: z.number(),
});

const measure = H.command('measure-experiment')
  .input(z.object({ hypothesis: z.string() }))
  .output(hourlyCounts)
  .runner(localRunner)
  .run(async ({ input, exec }) => {
    const result = await exec(`experiment-metrics --last 1h ${JSON.stringify(input.hypothesis)}`);
    if (result.exitCode !== 0) {
      throw new Error(result.stderr);
    }
    return hourlyCounts.parse(JSON.parse(result.stdout));
  });

function verdict(totals: Totals): State {
  const visitors = totals.visitorsA + totals.visitorsB;
  if (totals.visitorsA === 0 || totals.visitorsB === 0 || visitors === 0) {
    return Inconclusive;
  }
  const rateA = totals.conversionsA / totals.visitorsA;
  const rateB = totals.conversionsB / totals.visitorsB;
  const pooled = (totals.conversionsA + totals.conversionsB) / visitors;
  const standardError = Math.sqrt(pooled * (1 - pooled) * (1 / totals.visitorsA + 1 / totals.visitorsB));
  if (!(standardError > 0)) {
    return Inconclusive;
  }
  const zScore = (rateA - rateB) / standardError;
  return zScore > 1.96 ? AWins : zScore < -1.96 ? BWins : Inconclusive;
}

const twoWeeksMs = 14 * 24 * 60 * 60 * 1000;

const measureExperiment = H.flow('measure-experiment')
  .for(Experiment)
  .step('measure', measure, { input: (_, ctx) => ({ hypothesis: ctx.unit.data.hypothesis }) })
  .map(
    (hour, ctx): Totals => ({
      visitorsA: ctx.unit.data.visitorsA + hour.visitorsA,
      conversionsA: ctx.unit.data.conversionsA + hour.conversionsA,
      visitorsB: ctx.unit.data.visitorsB + hour.visitorsB,
      conversionsB: ctx.unit.data.conversionsB + hour.conversionsB,
    }),
  )
  .patch(totals => totals)
  .transition((totals, ctx) =>
    ctx.now.getTime() - ctx.unit.data.startedAt.getTime() < twoWeeksMs ? ExperimentRunning : verdict(totals),
  )
  .onError(MeasurementFailed);

const usageReport = H.command('usage-report')
  .input(z.object({ customer: z.string() }))
  .output(z.object({ report: z.string() }))
  .runner(localRunner)
  .run(async ({ input, exec }) => {
    const result = await exec(`usage-report --customer ${JSON.stringify(input.customer)} --last 30d`);
    if (result.exitCode !== 0) {
      throw new Error(result.stderr);
    }
    return { report: result.stdout };
  });

const summarizeUsage = H.skill('summarize-usage')
  .input(z.object({ customer: z.string(), plan: z.string(), usage: z.string() }))
  .prompt(t => `Customer ${t.customer} on plan ${t.plan}.\n\nUsage:\n${t.usage}`);

const UpsellDecision = H.blocker('upsell-decision').resolution(
  z.object({ upsell: z.boolean(), note: z.string().optional() }),
);

const monthlyReview = H.flow('monthly-review')
  .for(Tenancy)
  .transition(UnderReview)
  .step('usage-review', usageReport, { input: (_, ctx) => ({ customer: ctx.unit.data.customer }) })
  .step('summarize', summarizeUsage.by(accountManager), {
    input: (usage, ctx) => ({ customer: ctx.unit.data.customer, plan: ctx.unit.data.plan, usage: usage.report }),
  })
  .halt(UpsellDecision, summary => summary)
  .patch((decided, ctx) => ({
    lastReviewAt: ctx.now,
    lastDecision: decided.resolution.upsell ? 'upsell' : 'stay',
  }))
  .transition(TenancyActive);

const nextMove = H.skill('next-move')
  .input(
    z.object({
      vendor: z.string(),
      item: z.string(),
      round: z.number(),
      lastVendorMessage: z.string(),
      lastOffer: z.string(),
    }),
  )
  .output(z.object({ action: z.enum(['offer', 'accept', 'walk-away']), offer: z.string() }))
  .prompt(
    n =>
      `Vendor ${n.vendor}, item ${n.item}, round ${n.round}.\nOur last offer: ${n.lastOffer}\nTheir reply: ${n.lastVendorMessage}`,
  );

const sendToVendor = H.command('send-to-vendor')
  .input(z.object({ vendor: z.string(), message: z.string() }))
  .output(z.object({ sent: z.string() }))
  .runner(localRunner)
  .run(async ({ input, exec }) => {
    const result = await exec(`vendor-mail --to ${JSON.stringify(input.vendor)}`, { stdin: input.message });
    if (result.exitCode !== 0) {
      throw new Error(result.stderr);
    }
    return { sent: input.message };
  });

const negotiationRound = H.flow('negotiation-round')
  .for(Negotiation)
  .step('next-move', nextMove.by(negotiator), {
    input: (_, ctx) => ({
      vendor: ctx.unit.data.vendor,
      item: ctx.unit.data.item,
      round: ctx.unit.data.round,
      lastVendorMessage: ctx.unit.data.lastVendorMessage,
      lastOffer: ctx.unit.data.lastOffer,
    }),
  })
  .when(
    move => move.action === 'walk-away',
    walk => walk.transition(WalkedAwayByUs),
  )
  .when(
    move => move.action === 'accept',
    accept =>
      accept
        .step('send-acceptance', sendToVendor, {
          input: (move, ctx) => ({ vendor: ctx.unit.data.vendor, message: move.offer }),
        })
        .transition(Agreed),
  )
  .step('send-offer', sendToVendor, {
    input: (move, ctx) => ({ vendor: ctx.unit.data.vendor, message: move.offer }),
  })
  .patch((sent, ctx) => ({ lastOffer: sent.sent, round: ctx.unit.data.round + 1 }))
  .transition(AwaitingVendor);

const experiments = H.lane('experiments')
  .of(Experiment)
  .from(
    manual<ExperimentData>(),
    schedule<ExperimentData>({ every: '1h' }, tick =>
      tick.units
        .filter(unit => unit.state.name === ExperimentRunning.name)
        .map(unit => ({ key: unit.key, patch: {}, state: MeasurementDue })),
    ),
  )
  .store(sqlite.store<ExperimentData>({ path: '.harness/units.db', table: 'experiments' }))
  .handle(measureExperiment);

const billingEvent = z.object({
  customer: z.string(),
  plan: z.string(),
  event: z.enum(['created', 'suspended', 'reinstated', 'churned']),
});
const fromBilling = (body: unknown): SupplyEvent<TenancyData> | null => {
  const parsed = billingEvent.safeParse(body);
  if (!parsed.success) {
    return null;
  }
  const { customer, plan, event } = parsed.data;
  if (event === 'created') {
    return { key: customer, data: { customer, plan, lastReviewAt: null, lastDecision: null }, state: TenancyActive };
  }
  return {
    key: customer,
    patch: { plan },
    state: event === 'suspended' ? Suspended : event === 'reinstated' ? TenancyActive : Churned,
  };
};

const tenancies = H.lane('tenancies')
  .of(Tenancy)
  .from(
    webhook<TenancyData>({ port: 8470, path: '/billing', secret: H.env('BILLING_WEBHOOK_SECRET'), map: fromBilling }),
    schedule<TenancyData>({ cron: '0 9 1 * *' }, tick =>
      tick.units
        .filter(unit => unit.state.name === TenancyActive.name)
        .map(unit => ({ key: unit.key, patch: {}, state: ReviewDue })),
    ),
  )
  .store(sqlite.store<TenancyData>({ path: '.harness/units.db', table: 'tenancies' }))
  .handle(monthlyReview);

const vendorReply = z.object({
  negotiation: z.string(),
  message: z.string(),
  stance: z.enum(['counter', 'accept', 'walk-away']),
});
const fromVendor = (body: unknown): SupplyEvent<NegotiationData> | null => {
  const parsed = vendorReply.safeParse(body);
  if (!parsed.success) {
    return null;
  }
  const { negotiation: key, message, stance } = parsed.data;
  return {
    key,
    patch: { lastVendorMessage: message },
    state: stance === 'counter' ? OurTurn : stance === 'accept' ? Agreed : WalkedAwayByThem,
  };
};

const negotiations = H.lane('negotiations')
  .of(Negotiation)
  .from(
    manual<NegotiationData>(),
    webhook<NegotiationData>({ port: 8471, path: '/vendor-replies', secret: H.env('VENDOR_WEBHOOK_SECRET'), map: fromVendor }),
  )
  .store(sqlite.store<NegotiationData>({ path: '.harness/units.db', table: 'negotiations' }))
  .handle(negotiationRound)
  .deadline(unit => unit.data.expiresAt);

const negotiationExpires = H.trigger('negotiation-expires').on(negotiations.overdue()).transition(Expired);

function experimentsMostlyInconclusive(metrics: Metrics): boolean {
  const stats = metrics.outcomes({ kind: Experiment.name, window: '180d' });
  const finished = stats.byOutcome.succeeded + stats.byOutcome.ended;
  const inconclusive = stats.byState[Inconclusive.name] ?? 0;
  return finished >= 10 && inconclusive / finished > 0.5;
}

const scheduler = H.scheduler('lifecycles')
  .concurrency(4)
  .policy(
    H.policy.schedule('negotiations-then-reviews-then-measurements', ctx => {
      const experimentRank = experimentsMostlyInconclusive(ctx.metrics) ? 3 : 1;
      const rank = (unit: PendingUnit): number =>
        unit.lane === negotiations.name ? 0 : unit.lane === experiments.name ? experimentRank : 2;
      return {
        start: [...ctx.pending].sort(
          (a, b) => rank(a) - rank(b) || a.enqueuedAt.getTime() - b.enqueuedAt.getTime(),
        ),
      };
    }),
  );

const supervisor = H.supervisor('owner')
  .client(claudeCode.client({ port: 7480 }))
  .grant(H.ops.work.read, H.ops.work.write, H.ops.blockers.resolve, H.ops.memory.write, H.ops.telemetry.read);

export const lifecycles = H.harness('hostile-lifecycles')
  .ledger(sqlite.ledger('.harness/ledger.db'))
  .lanes(experiments, tenancies, negotiations)
  .journals(experience)
  .triggers(negotiationExpires)
  .scheduler(scheduler)
  .supervisor(supervisor)
  .observe(board('BOARD.md'), telemetry('TELEMETRY.md'));

export const running = lifecycles.start();
