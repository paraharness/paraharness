import { z } from 'zod';
import { H } from 'harness-dsl';
import type { Metrics, PendingView, SupplyOf } from 'harness-dsl';
import * as anthropic from 'harness-dsl/anthropic';
import * as sqlite from 'harness-dsl/sqlite';
import * as shell from 'harness-dsl/shell';
import * as http from 'harness-dsl/http';
import * as markdown from 'harness-dsl/markdown';
import * as claude from 'harness-dsl/claude-code';

const local = shell.local('local', { slots: 4 });
const ledger = sqlite.ledger('lifecycles.db');
const haiku = anthropic.model('claude-haiku-4-5');
const sonnet = anthropic.model('claude-sonnet-4-5');

const hourMs = 3_600_000;
const plusHours = (from: Date, hours: number): Date => new Date(from.getTime() + hours * hourMs);
const firstOfNextMonth = (from: Date): Date => new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth() + 1, 1, 9));

const sampleSchema = z.object({ at: z.string(), a: z.number(), b: z.number() });
type Sample = z.infer<typeof sampleSchema>;

const Experiment = H.kind('experiment')
  .data(z.object({ name: z.string(), endsAt: z.string(), samples: z.array(sampleSchema) }))
  .states([
    H.state('sample-due', 'pending'),
    H.state('sampling', 'active'),
    H.state('collecting', 'waiting'),
    H.state('a-wins', 'terminal', 'success'),
    H.state('b-wins', 'terminal', 'success'),
    H.state('inconclusive', 'terminal', 'neutral'),
    H.state('withdrawn', 'terminal', 'neutral'),
  ], { initial: 'sample-due', afterFailure: 'sample-due' });

const measure = H.command('measure-experiment')
  .input(z.object({ name: z.string() }))
  .output(z.object({ a: z.number(), b: z.number() }))
  .argv(i => ['./scripts/measure', i.name])
  .on(local)
  .ifInterrupted('rerun');

const experimentVerdict = H.policy.rule(
  'experiment-verdict',
  (input: { readonly samples: readonly Sample[] }, _metrics: Metrics): 'a-wins' | 'b-wins' | 'inconclusive' => {
    const n = input.samples.length;
    if (n < 100) return 'inconclusive';
    const meanA = input.samples.reduce((sum, s) => sum + s.a, 0) / n;
    const meanB = input.samples.reduce((sum, s) => sum + s.b, 0) / n;
    const lift = (meanB - meanA) / Math.max(Math.abs(meanA), 1e-9);
    if (lift > 0.05) return 'b-wins';
    if (lift < -0.05) return 'a-wins';
    return 'inconclusive';
  }
);

const experimentFlow = H.flow('experiment').for(Experiment).does(async ctx => {
  const e = ctx.unit.data;
  await ctx.move('sampling');
  const sample = await ctx.run(measure, { name: e.name }, { timeoutMs: 120_000 });
  if (!sample.ok) return ctx.fail(sample.error);
  const now = ctx.now();
  const samples = [...e.samples, { at: now.toISOString(), a: sample.value.a, b: sample.value.b }];
  await ctx.update({ samples });
  if (now.getTime() >= new Date(e.endsAt).getTime()) return ctx.decide(experimentVerdict, { samples });
  return ctx.wait('collecting', { at: plusHours(now, 1), then: 'sample-due' });
});

const experiments = H.lane('experiments', Experiment)
  .handler(experimentFlow)
  .suppliers(H.operator)
  .store(sqlite.store(Experiment, 'experiments.db'));

const Tenancy = H.kind('tenancy')
  .data(z.object({ customerId: z.string(), plan: z.string(), lastDecision: z.string().optional() }))
  .states([
    H.state('review-due', 'pending'),
    H.state('reviewing', 'active'),
    H.state('current', 'waiting'),
    H.state('suspended', 'waiting'),
    H.state('needs-attention', 'waiting'),
    H.state('churned', 'terminal', 'neutral'),
  ], { initial: 'review-due', afterFailure: 'needs-attention' });

const usageReview = H.command('usage-review')
  .input(z.object({ customerId: z.string() }))
  .output(z.object({ seats: z.number(), usageUsd: z.number(), trend: z.string() }))
  .argv(i => ['./scripts/usage-review', i.customerId])
  .on(local)
  .ifInterrupted('rerun');

const accountSummaryRole = H.role('account-summarizer')
  .input(z.object({ customerId: z.string(), plan: z.string(), seats: z.number(), usageUsd: z.number(), trend: z.string() }))
  .output(z.object({ summary: z.string(), upsellCase: z.string() }))
  .prompt(i => `Summarize the month for ${i.customerId} on ${i.plan}: ${i.seats} seats, $${i.usageUsd}, trend ${i.trend}.`);

const accountSummarizer = H.agent('account-summarizer', accountSummaryRole).model(sonnet);

const tenancyFlow = H.flow('tenancy-review').for(Tenancy).does(async ctx => {
  const t = ctx.unit.data;
  await ctx.move('reviewing');
  const usage = await ctx.run(usageReview, { customerId: t.customerId });
  if (!usage.ok) return ctx.fail(usage.error);
  const summary = await ctx.run(accountSummarizer, { customerId: t.customerId, plan: t.plan, ...usage.value });
  if (!summary.ok) return ctx.fail(summary.error);
  const decision = await ctx.halt({
    name: 'upsell-decision',
    show: `${summary.value.summary}\n\nUpsell case: ${summary.value.upsellCase}`,
    decision: z.object({ upsell: z.boolean(), notes: z.string() }),
  });
  await ctx.update({ lastDecision: decision.upsell ? `upsell: ${decision.notes}` : `hold: ${decision.notes}` });
  return ctx.wait('current', { at: firstOfNextMonth(ctx.now()), then: 'review-due' });
});

const billingWebhook = http.webhook(Tenancy, {
  path: '/hooks/billing',
  secret: H.env('BILLING_WEBHOOK_SECRET'),
  body: z.object({
    event: z.enum(['signed-up', 'suspended', 'reinstated', 'churned']),
    customerId: z.string(),
    plan: z.string(),
  }),
  read: (b): SupplyOf<typeof Tenancy> => {
    if (b.event === 'signed-up') return { create: { customerId: b.customerId, plan: b.plan }, key: `tenancy:${b.customerId}` };
    if (b.event === 'suspended') return { update: `tenancy:${b.customerId}`, state: 'suspended' };
    if (b.event === 'reinstated') return { update: `tenancy:${b.customerId}`, patch: { plan: b.plan }, state: 'review-due' };
    return { update: `tenancy:${b.customerId}`, state: 'churned' };
  },
});

const tenancies = H.lane('tenancies', Tenancy)
  .handler(tenancyFlow)
  .suppliers(billingWebhook)
  .store(sqlite.store(Tenancy, 'tenancies.db'));

const Negotiation = H.kind('negotiation')
  .data(z.object({
    vendor: z.string(),
    item: z.string(),
    targetUsd: z.number(),
    walkAwayAboveUsd: z.number(),
    expiresAt: z.string(),
    vendorMessage: z.string(),
    history: z.array(z.string()),
  }))
  .states([
    H.state('our-move', 'pending'),
    H.state('drafting', 'active'),
    H.state('their-move', 'waiting'),
    H.state('stalled', 'waiting'),
    H.state('agreed', 'terminal', 'success'),
    H.state('we-walked', 'terminal', 'neutral'),
    H.state('they-walked', 'terminal', 'failure'),
    H.state('expired', 'terminal', 'neutral'),
  ], { initial: 'our-move', afterFailure: 'stalled' });

const negotiatorRole = H.role('negotiator')
  .input(z.object({ item: z.string(), targetUsd: z.number(), walkAwayAboveUsd: z.number(), history: z.array(z.string()) }))
  .output(z.object({ action: z.enum(['offer', 'accept', 'walk-away']), message: z.string(), rationale: z.string() }))
  .prompt(i => `Negotiate ${i.item}. Target $${i.targetUsd}, walk away above $${i.walkAwayAboveUsd}.\n\n${i.history.join('\n')}`)
  .intents(['halt']);

const negotiator = H.agent('negotiator', negotiatorRole).model(sonnet);

const offerInput = z.object({ vendor: z.string(), message: z.string() });
const offerWasSent = H.command('offer-was-sent')
  .input(offerInput)
  .output(z.boolean())
  .argv(i => ['./scripts/vendor-outbox', 'contains', i.vendor, i.message]);
const sendOffer = H.command('send-offer')
  .input(offerInput)
  .argv(i => ['./scripts/vendor-outbox', 'send', i.vendor, i.message])
  .on(local)
  .ifInterrupted('ask', offerWasSent);

const negotiationFlow = H.flow('negotiation-round').for(Negotiation).does(async ctx => {
  const n = ctx.unit.data;
  await ctx.move('drafting');
  const history = n.vendorMessage === '' ? n.history : [...n.history, `them: ${n.vendorMessage}`];
  const next = await ctx.run(negotiator, { item: n.item, targetUsd: n.targetUsd, walkAwayAboveUsd: n.walkAwayAboveUsd, history });
  if (!next.ok) return ctx.fail(next.error);
  if (next.value.action === 'walk-away') {
    const confirm = await ctx.halt({
      name: 'confirm-walk-away',
      show: next.value.rationale,
      decision: z.object({ walkAway: z.boolean() }),
    });
    if (confirm.walkAway) return 'we-walked';
  }
  const sent = await ctx.run(sendOffer, { vendor: n.vendor, message: next.value.message });
  if (!sent.ok) return ctx.fail(sent.error);
  await ctx.update({ history: [...history, `us: ${next.value.message}`], vendorMessage: '' });
  return next.value.action === 'accept' ? 'agreed' : 'their-move';
});

const vendorReplies = http.webhook(Negotiation, {
  path: '/hooks/vendor',
  secret: H.env('VENDOR_WEBHOOK_SECRET'),
  body: z.object({ negotiationId: z.string(), reply: z.enum(['counter', 'accept', 'walk-away']), message: z.string() }),
  read: (b): SupplyOf<typeof Negotiation> => {
    if (b.reply === 'accept') return { update: b.negotiationId, patch: { vendorMessage: b.message }, state: 'agreed' };
    if (b.reply === 'walk-away') return { update: b.negotiationId, patch: { vendorMessage: b.message }, state: 'they-walked' };
    return { update: b.negotiationId, patch: { vendorMessage: b.message }, state: 'our-move' };
  },
});

const negotiations = H.lane('negotiations', Negotiation)
  .handler(negotiationFlow)
  .suppliers(H.operator, vendorReplies)
  .store(sqlite.store(Negotiation, 'negotiations.db'));

const negotiationExpires = H.trigger(
  'negotiation-expires',
  H.on.deadline(Negotiation, n => new Date(n.expiresAt), ['our-move', 'drafting', 'their-move', 'stalled']),
  (_event, act) => act.move('expired')
);

const api = anthropic.account('api', { apiKey: H.env('ANTHROPIC_API_KEY') });

const scheduler = H.policy.scheduler('rounds-before-experiments', view => {
  const inconclusive = view.metrics.rate({
    among: { entry: 'transition', kind: Experiment.name, position: 'terminal' },
    count: { entry: 'transition', kind: Experiment.name, state: 'inconclusive' },
    days: 90,
  });
  const experimentsMostlyInconclusive = inconclusive.samples >= 10 && inconclusive.value !== null && inconclusive.value > 0.5;
  const rank = (u: PendingView): number => {
    if (u.is(Negotiation)) return 0;
    if (u.is(Tenancy)) return 1;
    return experimentsMostlyInconclusive ? 3 : 2;
  };
  return { start: [...view.pending].sort((a, b) => rank(a) - rank(b) || b.waitedMs - a.waitedMs) };
});

export const lifecycles = H.harness('lifecycles')
  .ledger(ledger)
  .lanes(experiments, tenancies, negotiations)
  .pools(H.pool('models', [{ account: api, share: 1 }], H.policy.account('api-only', c => c.accounts.find(a => a.eligible)?.account ?? null)))
  .triggers(negotiationExpires)
  .scheduler(scheduler)
  .clients(claude.supervisor({ grants: [H.ops.readWork, H.ops.writeWork, H.ops.resolveHalts, H.ops.readTelemetry] }))
  .observers(markdown.board('board.md'));

export const unusedModel = haiku;
