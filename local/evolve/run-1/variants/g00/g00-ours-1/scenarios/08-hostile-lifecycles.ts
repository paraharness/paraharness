import { H, type Json } from 'harness-dsl';
import { z } from 'zod';
import { claudeCode } from 'harness-dsl/claude-code';
import { anthropic } from 'harness-dsl/anthropic';
import { sqlite } from 'harness-dsl/sqlite';
import { webhook } from 'harness-dsl/webhook';
import { manual } from 'harness-dsl/supply';
import { local } from 'harness-dsl/runners';
import { board, telemetry } from 'harness-dsl/projections';

const Failed = H.state('Failed').failed();
const Cancelled = H.state('Cancelled').cancelled();

const SampleDue = H.state('SampleDue').pending();
const Measuring = H.state('Measuring').active();
const BetweenSamples = H.state('BetweenSamples').dormant();
const AWins = H.state('AWins').ended();
const BWins = H.state('BWins').ended();
const Inconclusive = H.state('Inconclusive').ended();

const ReviewDue = H.state('ReviewDue').pending();
const Reviewing = H.state('Reviewing').active();
const Current = H.state('Current').dormant();
const Suspended = H.state('Suspended').dormant();
const Churned = H.state('Churned').ended();

const OurTurn = H.state('OurTurn').pending();
const DraftingOffer = H.state('DraftingOffer').active();
const AwaitingVendor = H.state('AwaitingVendor').dormant();
const Agreed = H.state('Agreed').succeeded();
const WeWalkedAway = H.state('WeWalkedAway').ended();
const TheyWalkedAway = H.state('TheyWalkedAway').ended();
const Expired = H.state('Expired').ended();

const sampleShape = z.object({ a: z.number(), b: z.number(), at: z.string() });
type Sample = z.infer<typeof sampleShape>;

const Experiment = H.work('experiment')
  .schema(z.object({ name: z.string(), startedAt: z.string(), samples: z.array(sampleShape).default([]) }))
  .states(SampleDue, Measuring, BetweenSamples, AWins, BWins, Inconclusive, Failed, Cancelled)
  .key(d => d.name);

const Tenancy = H.work('tenancy')
  .schema(
    z.object({
      customerId: z.string(),
      plan: z.string(),
      billingStatus: z.enum(['active', 'suspended', 'churned']),
      lastReviewedAt: z.string(),
      lastDecision: z.enum(['upsell', 'hold']).nullable(),
    }),
  )
  .states(ReviewDue, Reviewing, Current, Suspended, Churned, Failed)
  .key(d => d.customerId);

const negotiationSchema = z.object({
  ref: z.string(),
  vendor: z.string(),
  item: z.string(),
  targetUsd: z.number(),
  expiresAt: z.string(),
  vendorMessage: z.string().nullable(),
  vendorStatus: z.enum(['open', 'walked-away']),
});
type NegotiationData = z.infer<typeof negotiationSchema>;

const Negotiation = H.work('negotiation')
  .schema(negotiationSchema)
  .states(OurTurn, DraftingOffer, AwaitingVendor, Agreed, WeWalkedAway, TheyWalkedAway, Expired, Failed, Cancelled)
  .key(d => d.ref);

const api = H.account('anthropic-api', anthropic.api({ apiKey: H.env('ANTHROPIC_API_KEY') }));
const sonnet = H.model('sonnet', api, 'claude-sonnet-4-5').pricing(anthropic.pricing());

const analystRole = H.role('account-analyst').prompt('You summarise a customer tenancy month for an account manager.').tools();
const negotiatorRole = H.role('negotiator').prompt('You negotiate procurement on our behalf within the target price.').tools();

const summarizeUsage = H.skill('summarize-usage')
  .input(z.object({ customerId: z.string(), plan: z.string(), usage: z.string() }))
  .prompt(i => `Customer ${i.customerId} on ${i.plan}. Usage this month:\n${i.usage}`);

const nextMove = H.skill('next-move')
  .input(z.object({ item: z.string(), targetUsd: z.number(), vendorMessage: z.string().nullable() }))
  .output(z.object({ move: z.enum(['offer', 'accept', 'walk-away']), message: z.string() }))
  .prompt(i => `Item: ${i.item}. Target: $${i.targetUsd}.\nVendor said: ${i.vendorMessage ?? '(opening round)'}`);

const analyst = H.agent('account-analyst').role(analystRole).model(sonnet);
const negotiator = H.agent('negotiator').role(negotiatorRole).model(sonnet);

const worker = local('worker').slots(4);

const collectSample = H.command('collect-experiment-sample')
  .input(z.object({ experiment: z.string() }))
  .output(z.object({ a: z.number(), b: z.number() }))
  .runner(worker)
  .run(async ctx => {
    const result = await ctx.exec('experiment-metric', [ctx.input.experiment]);
    const [a, b] = result.stdout.trim().split(/\s+/).map(Number);
    return { a: a ?? 0, b: b ?? 0 };
  });

const usageReport = H.command('usage-report')
  .input(z.object({ customerId: z.string() }))
  .output(z.object({ report: z.string() }))
  .runner(worker)
  .run(async ctx => {
    const result = await ctx.exec('usage-report', [ctx.input.customerId, '--days', '30']);
    return { report: result.stdout };
  });

const sendToVendor = H.command('send-to-vendor')
  .input(z.object({ vendor: z.string(), message: z.string() }))
  .runner(worker)
  .env({ PROCUREMENT_TOKEN: H.env('PROCUREMENT_TOKEN') })
  .run(async ctx => {
    await ctx.exec('procurement-send', [ctx.input.vendor], { stdin: ctx.input.message });
  });

const experimentLengthMs = 14 * 24 * 60 * 60 * 1000;
const decisiveLift = 0.05;

const mean = (values: readonly number[]): number => (values.length === 0 ? 0 : values.reduce((s, v) => s + v, 0) / values.length);

const experimentVerdict = (startedAt: string, samples: readonly Sample[], now: Date) => {
  if (now.getTime() - Date.parse(startedAt) < experimentLengthMs) return BetweenSamples;
  const a = mean(samples.map(s => s.a));
  const b = mean(samples.map(s => s.b));
  const lift = a === 0 ? 0 : (b - a) / a;
  return lift > decisiveLift ? BWins : lift < -decisiveLift ? AWins : Inconclusive;
};

const experimentFlow = H.flow('experiment-sample')
  .of(Experiment)
  .transition(Measuring)
  .step('sample', collectSample, s => ({ experiment: s.unit.data.name }))
  .update(s => ({ samples: [...s.unit.data.samples, { a: s.steps.sample.a, b: s.steps.sample.b, at: s.now.toISOString() }] }))
  .transition(s =>
    experimentVerdict(s.unit.data.startedAt, [...s.unit.data.samples, { a: s.steps.sample.a, b: s.steps.sample.b, at: s.now.toISOString() }], s.now),
  );

const tenancyFlow = H.flow('tenancy-review')
  .of(Tenancy)
  .transition(Reviewing)
  .step('usage', usageReport, s => ({ customerId: s.unit.data.customerId }))
  .step('summary', analyst.perform(summarizeUsage), s => ({ customerId: s.unit.data.customerId, plan: s.unit.data.plan, usage: s.steps.usage.report }))
  .halt('decision', {
    ask: s => `Monthly review of ${s.unit.data.customerId}:\n\n${s.steps.summary}\n\nUpsell?`,
    decision: z.object({ upsell: z.boolean(), note: z.string() }),
  })
  .update(s => ({ lastReviewedAt: s.now.toISOString(), lastDecision: s.steps.decision.upsell ? 'upsell' : 'hold' }))
  .transition(Current);

const negotiationFlow = H.flow('negotiation-round')
  .of(Negotiation)
  .transition(DraftingOffer)
  .step('move', negotiator.perform(nextMove), s => ({ item: s.unit.data.item, targetUsd: s.unit.data.targetUsd, vendorMessage: s.unit.data.vendorMessage }))
  .step('send', sendToVendor, s => ({ vendor: s.unit.data.vendor, message: s.steps.move.message }))
  .transition(s => (s.steps.move.move === 'accept' ? Agreed : s.steps.move.move === 'walk-away' ? WeWalkedAway : AwaitingVendor));

const billingEvent = z.object({ customer_id: z.string(), status: z.enum(['active', 'suspended', 'churned']) });
const vendorReply = z.object({ negotiation: z.string(), message: z.string(), walked_away: z.boolean() });

const billingPatch = (body: Json) => {
  const parsed = billingEvent.safeParse(body);
  return parsed.success ? { key: parsed.data.customer_id, patch: { billingStatus: parsed.data.status } } : null;
};

const vendorPatch = (body: Json): { readonly key: string; readonly patch: Partial<NegotiationData> } | null => {
  const parsed = vendorReply.safeParse(body);
  if (!parsed.success) return null;
  return {
    key: parsed.data.negotiation,
    patch: { vendorMessage: parsed.data.message, vendorStatus: parsed.data.walked_away ? 'walked-away' : 'open' },
  };
};

const store = sqlite.store('.harness/units.sqlite');

const experiments = H.lane('experiments').of(Experiment).from(manual()).store(store).handle(experimentFlow);

const tenancies = H.lane('tenancies')
  .of(Tenancy)
  .from(manual(), webhook.update({ kind: Tenancy, path: '/billing/events', secret: H.env('BILLING_WEBHOOK_SECRET'), map: billingPatch }))
  .store(store)
  .handle(tenancyFlow);

const negotiations = H.lane('negotiations')
  .of(Negotiation)
  .from(manual(), webhook.update({ kind: Negotiation, path: '/vendors/replies', secret: H.env('VENDOR_WEBHOOK_SECRET'), map: vendorPatch }))
  .store(store)
  .handle(negotiationFlow)
  .maxUsdPerUnit(5);

const hourMs = 60 * 60 * 1000;

const hourlySample = H.trigger('hourly-experiment-sample')
  .on(experiments.deadline(u => new Date(u.updatedAt.getTime() + hourMs), { during: [BetweenSamples] }))
  .move(SampleDue);

const addDays = (iso: string, days: number): Date => new Date(Date.parse(iso) + days * 24 * hourMs);

const monthlyReview = H.trigger('monthly-tenancy-review')
  .on(tenancies.deadline(u => addDays(u.data.lastReviewedAt, 30), { during: [Current] }))
  .move(ReviewDue);

const tenancySuspended = H.trigger('tenancy-suspended')
  .on(tenancies.updated())
  .where(e => e.unit.data.billingStatus === 'suspended' && e.previous.billingStatus !== 'suspended')
  .move(Suspended);

const tenancyReinstated = H.trigger('tenancy-reinstated')
  .on(tenancies.updated())
  .where(e => e.unit.data.billingStatus === 'active' && e.unit.state === 'Suspended')
  .move(Current);

const tenancyChurned = H.trigger('tenancy-churned')
  .on(tenancies.updated())
  .where(e => e.unit.data.billingStatus === 'churned')
  .move(Churned);

const vendorReplied = H.trigger('vendor-replied')
  .on(negotiations.updated())
  .where(e => e.unit.state === 'AwaitingVendor' && e.unit.data.vendorStatus === 'open' && e.unit.data.vendorMessage !== e.previous.vendorMessage)
  .move(OurTurn);

const vendorWalkedAway = H.trigger('vendor-walked-away')
  .on(negotiations.updated())
  .where(e => e.unit.data.vendorStatus === 'walked-away')
  .move(TheyWalkedAway);

const negotiationExpires = H.trigger('negotiation-expires')
  .on(negotiations.deadline(u => new Date(u.data.expiresAt), { during: [OurTurn, DraftingOffer, AwaitingVendor] }))
  .move(Expired);

const roundsBeforeLongRunners = H.policy.schedule('negotiations-first-experiments-by-signal', ctx => {
  const experimentStats = ctx.metrics.outcomes({ kind: Experiment, windowDays: 365 });
  const inconclusiveRate = experimentStats.samples < 10 ? null : (experimentStats.byState['Inconclusive'] ?? 0) / experimentStats.samples;
  const experimentSamples = ctx.of(experiments).pending;
  const deferExperiments = inconclusiveRate !== null && inconclusiveRate > 0.5;
  return {
    start: [
      ...ctx.of(negotiations).pending,
      ...(deferExperiments ? [] : experimentSamples),
      ...ctx.of(tenancies).pending,
      ...(deferExperiments ? experimentSamples : []),
    ],
  };
});

const supervisor = H.supervisor('operator')
  .endpoint(claudeCode.endpoint({ server: 'long-lived-work' }))
  .grant(H.ops.work.read, H.ops.work.write, H.ops.blockers.resolve, H.ops.telemetry.read);

export const longLived = H.harness('long-lived-work')
  .ledger(sqlite.ledger('.harness/ledger.sqlite'))
  .lanes(experiments, tenancies, negotiations)
  .triggers(hourlySample, monthlyReview, tenancySuspended, tenancyReinstated, tenancyChurned, vendorReplied, vendorWalkedAway, negotiationExpires)
  .scheduler(H.scheduler('long-lived').concurrency(4).policy(roundsBeforeLongRunners))
  .supervisor(supervisor)
  .projections(board('BOARD.md'), telemetry('TELEMETRY.md'));

export const run = longLived.start();
