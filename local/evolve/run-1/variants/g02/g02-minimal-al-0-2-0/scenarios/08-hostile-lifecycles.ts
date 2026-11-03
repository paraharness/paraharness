import { H } from 'harness-dsl';
import type { Metrics } from 'harness-dsl';
import { z } from 'zod';
import * as anthropic from 'harness-dsl/anthropic';
import * as claudeCode from 'harness-dsl/claude-code';
import * as http from 'harness-dsl/http';
import * as sqlite from 'harness-dsl/sqlite';
import * as shell from 'harness-dsl/shell';
import * as markdown from 'harness-dsl/markdown';

const local = shell.local('local', { slots: 4 });
const sonnet = anthropic.model('claude-sonnet-4');

const due = H.state('due', 'pending');
const resting = H.state('resting', 'waiting');
const aWins = H.state('aWins', 'terminal', 'neutral');
const bWins = H.state('bWins', 'terminal', 'neutral');
const inconclusive = H.state('inconclusive', 'terminal', 'neutral');

const Experiment = H.kind('Experiment')
  .data(z.object({
    name: z.string(),
    endsAt: z.string(),
    samplesA: z.array(z.number()),
    samplesB: z.array(z.number()),
  }))
  .states(due, resting, aWins, bWins, inconclusive);

const measure = H.command('measure-experiment')
  .input(z.object({ experiment: z.string() }))
  .output(z.object({ a: z.number(), b: z.number() }))
  .argv((i) => ['experiment-metric', '--name', i.experiment])
  .on(local)
  .recovers('rerun');

interface Samples {
  readonly samplesA: readonly number[];
  readonly samplesB: readonly number[];
}
type ExperimentOutcome = 'aWins' | 'bWins' | 'inconclusive';

const mean = (values: readonly number[]): number =>
  values.reduce((sum, v) => sum + v, 0) / Math.max(values.length, 1);

const judge = H.policy.rule('experiment-judge', (input: Samples, metrics: Metrics): ExperimentOutcome => {
  const history = metrics.rate({
    among: { entry: 'transition', kind: Experiment, position: 'terminal' },
    count: { entry: 'transition', state: inconclusive },
    days: 180,
  });
  const oftenInconclusive = history.samples >= 10 && (history.value ?? 0) > 0.5;
  const requiredLift = oftenInconclusive ? 0.03 : 0.05;
  const a = mean(input.samplesA);
  const b = mean(input.samplesB);
  const lift = (b - a) / Math.max(Math.abs(a), 1e-9);
  if (lift > requiredLift) return 'bWins';
  if (lift < -requiredLift) return 'aWins';
  return 'inconclusive';
});

const experimentFlow = H.flow('experiment').for(Experiment).does(async (ctx) => {
  const measured = await ctx.run(measure, { experiment: ctx.unit.data.name });
  if (!measured.ok) return ctx.fail(measured.error);
  const samplesA = [...ctx.unit.data.samplesA, measured.value.a];
  const samplesB = [...ctx.unit.data.samplesB, measured.value.b];
  await ctx.update({ samplesA, samplesB });
  const now = ctx.now();
  if (now.getTime() < Date.parse(ctx.unit.data.endsAt)) {
    return ctx.wait('resting', { at: new Date(now.getTime() + 3_600_000), then: 'due' });
  }
  return ctx.decide(judge, { samplesA, samplesB });
});

const experiments = H.lane('experiments', Experiment)
  .handler(experimentFlow)
  .suppliers(H.operator)
  .store(sqlite.store(Experiment, '.harness/experiments.db'));

const review = H.state('review', 'pending');
const current = H.state('current', 'waiting');
const suspended = H.state('suspended', 'waiting');
const churned = H.state('churned', 'terminal', 'neutral');

const Tenancy = H.kind('Tenancy')
  .data(z.object({
    tenantId: z.string(),
    customer: z.string(),
    lastSummary: z.string().optional(),
    upsellOffered: z.boolean(),
  }))
  .states(review, current, suspended, churned);

const usageReport = H.command('usage-report')
  .input(z.object({ tenantId: z.string() }))
  .argv((i) => ['usage-report', '--tenant', i.tenantId, '--period', 'last-month'])
  .on(local)
  .recovers('rerun');

const accountManagerRole = H.role('account-summarizer')
  .input(z.object({ customer: z.string(), usage: z.string(), previous: z.string() }))
  .output(z.object({ summary: z.string(), upsellCase: z.string() }))
  .prompt((i) => `Summarize ${i.customer}'s usage this month and whether an upsell is justified.\nUsage:\n${i.usage}\nLast month:\n${i.previous}`);

const accountSummarizer = H.agent('account-summarizer', accountManagerRole).model(sonnet);

const upsellDecision = H.halt('upsell-decision', z.object({ upsell: z.boolean(), note: z.string() }));

const firstOfNextMonth = (now: Date): Date => new Date(now.getFullYear(), now.getMonth() + 1, 1, 9);

const tenancyFlow = H.flow('tenancy-review').for(Tenancy).does(async (ctx) => {
  const tenancy = ctx.unit.data;
  const usage = await ctx.run(usageReport, { tenantId: tenancy.tenantId });
  if (!usage.ok) return ctx.fail(usage.error);
  const summary = await ctx.run(accountSummarizer, {
    customer: tenancy.customer,
    usage: usage.value,
    previous: tenancy.lastSummary ?? '',
  });
  if (!summary.ok) return ctx.fail(summary.error);
  const decision = await ctx.halt(upsellDecision, `${summary.value.summary}\n\nUpsell case: ${summary.value.upsellCase}`);
  await ctx.update({ lastSummary: summary.value.summary, upsellOffered: decision.upsell });
  return ctx.wait('current', { at: firstOfNextMonth(ctx.now()), then: 'review' });
});

const billingWebhook = http.webhook(Tenancy, {
  path: '/hooks/billing',
  secret: H.env('BILLING_WEBHOOK_SECRET'),
  body: z.object({
    event: z.enum(['signed-up', 'suspended', 'reinstated', 'churned']),
    tenantId: z.string(),
    customer: z.string(),
  }),
  read: (body) => {
    switch (body.event) {
      case 'signed-up':
        return { create: { tenantId: body.tenantId, customer: body.customer, upsellOffered: false }, key: body.tenantId };
      case 'suspended':
        return { update: body.tenantId, state: 'suspended' };
      case 'reinstated':
        return { update: body.tenantId, state: 'review' };
      case 'churned':
        return { update: body.tenantId, state: 'churned' };
    }
  },
});

const tenancies = H.lane('tenancies', Tenancy)
  .handler(tenancyFlow)
  .suppliers(billingWebhook)
  .store(sqlite.store(Tenancy, '.harness/tenancies.db'));

const drafting = H.state('drafting', 'pending');
const awaitingVendor = H.state('awaitingVendor', 'waiting');
const agreed = H.state('agreed', 'terminal', 'success');
const walkedAway = H.state('walkedAway', 'terminal', 'neutral');
const vendorWalked = H.state('vendorWalked', 'terminal', 'failure');
const expired = H.state('expired', 'terminal', 'failure');

const Negotiation = H.kind('Negotiation')
  .data(z.object({
    vendor: z.string(),
    vendorEmail: z.string(),
    item: z.string(),
    targetUsd: z.number(),
    expiresAt: z.string(),
    round: z.number().int(),
    lastOffer: z.string().optional(),
    lastVendorMessage: z.string().optional(),
  }))
  .states(drafting, awaitingVendor, agreed, walkedAway, vendorWalked, expired);

const negotiatorRole = H.role('negotiator')
  .input(z.object({
    item: z.string(),
    targetUsd: z.number(),
    round: z.number(),
    lastOffer: z.string(),
    vendorMessage: z.string(),
  }))
  .output(z.object({ move: z.enum(['offer', 'walk-away']), offer: z.string(), rationale: z.string() }))
  .prompt((i) => `Round ${i.round} buying ${i.item}, target $${i.targetUsd}.\nOur last offer: ${i.lastOffer}\nVendor said: ${i.vendorMessage}\nDraft the next offer or recommend walking away.`);

const negotiator = H.agent('negotiator', negotiatorRole).model(sonnet);

const confirmWalkAway = H.halt('confirm-walk-away', z.object({ walkAway: z.boolean() }));

const sendOffer = H.command('send-offer')
  .input(z.object({ to: z.string(), offer: z.string() }))
  .argv((i) => ['send-mail', '--to', i.to, '--body', i.offer])
  .on(local)
  .recovers('park');

const negotiationFlow = H.flow('negotiation-round').for(Negotiation).does(async (ctx) => {
  const n = ctx.unit.data;
  const proposal = await ctx.run(negotiator, {
    item: n.item,
    targetUsd: n.targetUsd,
    round: n.round,
    lastOffer: n.lastOffer ?? '',
    vendorMessage: n.lastVendorMessage ?? '',
  });
  if (!proposal.ok) return ctx.fail(proposal.error);
  if (proposal.value.move === 'walk-away') {
    const decision = await ctx.halt(confirmWalkAway, proposal.value.rationale);
    if (decision.walkAway) return 'walkedAway';
  }
  const sent = await ctx.run(sendOffer, { to: n.vendorEmail, offer: proposal.value.offer });
  if (!sent.ok) return ctx.fail(sent.error);
  await ctx.update({ round: n.round + 1, lastOffer: proposal.value.offer });
  return ctx.wait('awaitingVendor', { then: 'drafting' });
});

const vendorReplies = http.webhook(Negotiation, {
  path: '/hooks/vendor-reply',
  secret: H.env('VENDOR_WEBHOOK_SECRET'),
  body: z.object({
    negotiationId: z.string(),
    reply: z.enum(['counter', 'accept', 'walk-away']),
    message: z.string(),
  }),
  read: (body) => {
    if (body.reply === 'accept') return { update: body.negotiationId, patch: { lastVendorMessage: body.message }, state: 'agreed' };
    if (body.reply === 'walk-away') return { update: body.negotiationId, patch: { lastVendorMessage: body.message }, state: 'vendorWalked' };
    return { update: body.negotiationId, patch: { lastVendorMessage: body.message }, state: 'drafting' };
  },
});

const negotiations = H.lane('negotiations', Negotiation)
  .handler(negotiationFlow)
  .suppliers(H.operator, vendorReplies)
  .store(sqlite.store(Negotiation, '.harness/negotiations.db'));

const negotiationExpiry = H.trigger(
  'negotiation-expiry',
  H.on.deadline(Negotiation, (data) => new Date(data.expiresAt), ['drafting', 'awaitingVendor']),
  (_event, act) => act.move('expired')
);

const pool = H.pool('anthropic', [
  { account: anthropic.account('anthropic-api', { apiKey: H.env('ANTHROPIC_API_KEY') }), share: 1 },
]);

export const lifecycles = H.harness('hostile-lifecycles')
  .ledger(sqlite.ledger('.harness/ledger.db'))
  .lanes(experiments, tenancies, negotiations)
  .pools(pool)
  .triggers(negotiationExpiry)
  .clients(claudeCode.supervisor({ grants: [H.ops.readWork, H.ops.writeWork, H.ops.resolveHalts, H.ops.readTelemetry] }))
  .observers(markdown.board('BOARD.md'), markdown.telemetry('TELEMETRY.md'));
