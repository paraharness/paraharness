import { z } from 'zod';
import { H, type SupplyOf } from 'harness-dsl';
import * as anthropic from 'harness-dsl/anthropic';
import * as http from 'harness-dsl/http';
import * as sqlite from 'harness-dsl/sqlite';
import * as shell from 'harness-dsl/shell';
import * as claudeCode from 'harness-dsl/claude-code';
import * as markdown from 'harness-dsl/markdown';

const local = shell.local('local', { slots: 4 });
const sonnet = anthropic.model('claude-sonnet-4-5');
const api = anthropic.account('anthropic-api', { apiKey: H.env('ANTHROPIC_API_KEY') });

const experimentData = z.object({
  hypothesis: z.string(),
  endsAt: z.string(),
  readingsA: z.array(z.number()),
  readingsB: z.array(z.number()),
});

const experimentQueued = H.state('experiment-queued', 'pending');
const experimentMeasuring = H.state('experiment-measuring', 'active');
const experimentSleeping = H.state('experiment-sleeping', 'waiting');
const experimentAWins = H.state('experiment-a-wins', 'terminal', 'success');
const experimentBWins = H.state('experiment-b-wins', 'terminal', 'success');
const experimentInconclusive = H.state('experiment-inconclusive', 'terminal', 'neutral');
const experimentBroken = H.state('experiment-broken', 'terminal', 'failure');

const experiment = H.kind('experiment')
  .data(experimentData)
  .states(experimentQueued, experimentMeasuring, experimentSleeping, experimentAWins, experimentBWins, experimentInconclusive, experimentBroken)
  .failsTo('experiment-broken');

const measureVariants = H.command('measure-variants')
  .input(z.object({ hypothesis: z.string() }))
  .output(z.object({ a: z.number(), b: z.number() }))
  .argv((e) => ['measure-experiment', '--hypothesis', e.hypothesis, '--json'])
  .on(local);

const mean = (values: readonly number[]) => values.reduce((sum, v) => sum + v, 0) / Math.max(values.length, 1);

const runExperiment = H.flow('run-experiment').for(experiment).does(async (ctx) => {
  const endsAt = new Date(ctx.unit.data.endsAt).getTime();
  const readingsA = [...ctx.unit.data.readingsA];
  const readingsB = [...ctx.unit.data.readingsB];
  while (ctx.now().getTime() < endsAt) {
    await ctx.move('experiment-measuring');
    const reading = await ctx.run(measureVariants, { hypothesis: ctx.unit.data.hypothesis });
    if (!reading.ok) return ctx.fail(reading.error);
    readingsA.push(reading.value.a);
    readingsB.push(reading.value.b);
    await ctx.update({ readingsA, readingsB });
    await ctx.wait('experiment-sleeping', { at: new Date(ctx.now().getTime() + 3_600_000) });
  }
  const meanA = mean(readingsA);
  const meanB = mean(readingsB);
  const scale = Math.max(Math.abs(meanA), Math.abs(meanB), 1e-9);
  if (readingsA.length < 24 || Math.abs(meanA - meanB) / scale < 0.02) return 'experiment-inconclusive';
  return meanA > meanB ? 'experiment-a-wins' : 'experiment-b-wins';
});

const experiments = H.lane('experiments', experiment)
  .handler(runExperiment)
  .suppliers(H.operator)
  .store(sqlite.store(experiment, 'lifecycles.db'));

const tenancyData = z.object({
  customer: z.string(),
  plan: z.string(),
  nextReviewAt: z.string(),
});

const tenancyDue = H.state('tenancy-due', 'pending');
const tenancyReviewing = H.state('tenancy-reviewing', 'active');
const tenancyCurrent = H.state('tenancy-current', 'waiting');
const tenancySuspended = H.state('tenancy-suspended', 'waiting');
const tenancyChurned = H.state('tenancy-churned', 'terminal', 'neutral');

const tenancy = H.kind('tenancy')
  .data(tenancyData)
  .states(tenancyDue, tenancyReviewing, tenancyCurrent, tenancySuspended, tenancyChurned);

const usageReport = H.command('usage-report')
  .input(z.object({ customer: z.string() }))
  .argv((t) => ['usage-report', '--customer', t.customer, '--last', '30d'])
  .on(local);

const sendUpsell = H.command('send-upsell')
  .input(z.object({ customer: z.string() }))
  .argv((t) => ['crm', 'open-upsell', '--customer', t.customer])
  .on(local);

const accountReviewRole = H.role('account-reviewer')
  .input(z.object({ customer: z.string(), plan: z.string(), usage: z.string() }))
  .output(z.object({ summary: z.string(), upsellCase: z.string() }))
  .prompt((t) => `Summarise this month for ${t.customer} on plan ${t.plan}, and state the case for an upsell.\n\n${t.usage}`)
  .intents(['read']);

const accountReviewer = H.agent('account-reviewer', accountReviewRole).model(sonnet);

const tenancyDecision = H.halt('tenancy-decision', z.object({
  action: z.enum(['upsell', 'keep', 'suspend', 'churn']),
  note: z.string(),
}));

const nextMonth = (from: Date) => new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth() + 1, from.getUTCDate()));

const reviewTenancy = H.flow('review-tenancy').for(tenancy).does(async (ctx) => {
  await ctx.move('tenancy-reviewing');
  const { customer, plan } = ctx.unit.data;
  const usage = await ctx.run(usageReport, { customer });
  if (!usage.ok) return ctx.fail(usage.error);
  const summary = await ctx.run(accountReviewer, { customer, plan, usage: usage.value });
  if (!summary.ok) return ctx.fail(summary.error);
  const decision = await ctx.halt(tenancyDecision, `${summary.value.summary}\n\nUpsell case: ${summary.value.upsellCase}`);
  await ctx.update({ nextReviewAt: nextMonth(ctx.now()).toISOString() });
  if (decision.action === 'churn') return 'tenancy-churned';
  if (decision.action === 'suspend') return 'tenancy-suspended';
  if (decision.action === 'upsell') {
    const offered = await ctx.run(sendUpsell, { customer });
    if (!offered.ok) return ctx.fail(offered.error);
  }
  return 'tenancy-current';
});

const dueForReview = (unit: { readonly key: string }): SupplyOf<typeof tenancy> => ({ update: unit.key, state: 'tenancy-due' });

const reviewCalendar = H.clock('tenancy-review-calendar', tenancy, { daily: '06:00' }, ({ now, units }) =>
  units
    .filter((u) => u.state === 'tenancy-current' && new Date(u.data.nextReviewAt).getTime() <= now.getTime())
    .map(dueForReview)
);

const tenancies = H.lane('tenancies', tenancy)
  .handler(reviewTenancy)
  .suppliers(reviewCalendar, H.operator)
  .store(sqlite.store(tenancy, 'lifecycles.db'));

const round = z.object({ from: z.enum(['us', 'them']), text: z.string() });
type Round = z.infer<typeof round>;

const negotiationData = z.object({
  vendor: z.string(),
  item: z.string(),
  expiresAt: z.string(),
  lastVendorMessage: z.string(),
  rounds: z.array(round),
});

const negotiationOurTurn = H.state('negotiation-our-turn', 'pending');
const negotiationDrafting = H.state('negotiation-drafting', 'active');
const negotiationTheirTurn = H.state('negotiation-their-turn', 'waiting');
const negotiationAgreed = H.state('negotiation-agreed', 'terminal', 'success');
const negotiationWeWalked = H.state('negotiation-we-walked', 'terminal', 'neutral');
const negotiationTheyWalked = H.state('negotiation-they-walked', 'terminal', 'failure');
const negotiationExpired = H.state('negotiation-expired', 'terminal', 'failure');

const negotiation = H.kind('negotiation')
  .data(negotiationData)
  .states(negotiationOurTurn, negotiationDrafting, negotiationTheirTurn, negotiationAgreed, negotiationWeWalked, negotiationTheyWalked, negotiationExpired);

const negotiatorRole = H.role('negotiator')
  .input(z.object({ vendor: z.string(), item: z.string(), rounds: z.array(round) }))
  .output(z.object({ action: z.enum(['offer', 'accept', 'walk-away']), message: z.string() }))
  .prompt((n) => `Negotiate ${n.item} with ${n.vendor}. Decide the next move.\n\n${n.rounds.map((r) => `${r.from}: ${r.text}`).join('\n')}`)
  .intents(['read']);

const negotiator = H.agent('negotiator', negotiatorRole).model(sonnet);

const sendToVendor = H.command('send-to-vendor')
  .input(z.object({ vendor: z.string(), action: z.enum(['offer', 'accept', 'walk-away']), message: z.string() }))
  .argv((m) => ['procurement', 'send', '--vendor', m.vendor, '--action', m.action, '--message', m.message])
  .on(local);

const negotiateRound = H.flow('negotiate-round').for(negotiation).does(async (ctx) => {
  await ctx.move('negotiation-drafting');
  const { vendor, item, lastVendorMessage } = ctx.unit.data;
  const history: Round[] = [...ctx.unit.data.rounds];
  if (lastVendorMessage !== '') history.push({ from: 'them', text: lastVendorMessage });
  const next = await ctx.run(negotiator, { vendor, item, rounds: history });
  if (!next.ok) return ctx.fail(next.error);
  const sent = await ctx.run(sendToVendor, { vendor, action: next.value.action, message: next.value.message });
  if (!sent.ok) return ctx.fail(sent.error);
  history.push({ from: 'us', text: next.value.message });
  await ctx.update({ rounds: history, lastVendorMessage: '' });
  if (next.value.action === 'accept') return 'negotiation-agreed';
  if (next.value.action === 'walk-away') return 'negotiation-we-walked';
  return 'negotiation-their-turn';
});

const vendorReply = z.object({
  negotiation: z.string(),
  kind: z.enum(['counter', 'accepted', 'walked-away']),
  message: z.string(),
});
type VendorReply = z.infer<typeof vendorReply>;

const fromVendor = (reply: VendorReply): SupplyOf<typeof negotiation> => {
  if (reply.kind === 'accepted') return { update: reply.negotiation, patch: { lastVendorMessage: reply.message }, state: 'negotiation-agreed' };
  if (reply.kind === 'walked-away') return { update: reply.negotiation, patch: { lastVendorMessage: reply.message }, state: 'negotiation-they-walked' };
  return { update: reply.negotiation, patch: { lastVendorMessage: reply.message }, state: 'negotiation-our-turn' };
};

const vendorReplies = http.webhook(negotiation, {
  path: '/vendor-replies',
  secret: H.env('VENDOR_WEBHOOK_SECRET'),
  body: vendorReply,
  read: fromVendor,
});

const negotiations = H.lane('negotiations', negotiation)
  .handler(negotiateRound)
  .suppliers(H.operator, vendorReplies)
  .store(sqlite.store(negotiation, 'lifecycles.db'));

const negotiationExpiry = H.trigger(
  'negotiation-expiry',
  H.on.deadline(negotiation, (n) => new Date(n.expiresAt), ['negotiation-our-turn', 'negotiation-drafting', 'negotiation-their-turn']),
  (_event, act) => act.move('negotiation-expired')
);

const lifecycleScheduler = H.policy.scheduler('lifecycles', ({ pending, active, metrics }) => {
  const inconclusive = metrics.rate({
    among: { entry: 'transition', kind: experiment, position: 'terminal' },
    count: { entry: 'transition', kind: experiment, state: experimentInconclusive },
    days: 180,
  });
  const experimentSlots = inconclusive.samples >= 10 && (inconclusive.value ?? 0) > 0.5 ? 1 : 3;
  const measuring = active.filter((u) => u.is(experiment)).length;
  const newExperiments = pending.filter((u) => u.is(experiment)).slice(0, Math.max(0, experimentSlots - measuring));
  const otherWork = pending.filter((u) => !u.is(experiment));
  return { start: [...otherWork, ...newExperiments] };
});

const pool = H.pool('anthropic', [{ account: api, share: 1 }]);

export const harness = H.harness('hostile-lifecycles')
  .ledger(sqlite.ledger('lifecycles-ledger.db'))
  .lanes(experiments, tenancies, negotiations)
  .pools(pool)
  .triggers(negotiationExpiry)
  .scheduler(lifecycleScheduler)
  .clients(claudeCode.supervisor({
    grants: [H.ops.readWork, H.ops.writeWork, H.ops.resolveHalts, H.ops.readTelemetry],
  }))
  .observers(markdown.board('BOARD.md'), markdown.telemetry('TELEMETRY.md'));
