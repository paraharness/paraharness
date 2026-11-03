import { z } from 'zod';
import { H } from 'harness-dsl';
import type { Metrics } from 'harness-dsl';
import * as anthropic from 'harness-dsl/anthropic';
import * as claudeCode from 'harness-dsl/claude-code';
import * as http from 'harness-dsl/http';
import * as shell from 'harness-dsl/shell';
import * as sqlite from 'harness-dsl/sqlite';
import * as markdown from 'harness-dsl/markdown';

const hourMs = 60 * 60 * 1000;
const opsBox = shell.local('ops-box', { slots: 4 });

const experimentScheduled = H.state('experiment-scheduled', 'pending');
const experimentSleeping = H.state('experiment-sleeping', 'waiting');
const aWins = H.state('a-wins', { terminal: 'success' });
const bWins = H.state('b-wins', { terminal: 'success' });
const inconclusive = H.state('inconclusive', { terminal: 'neutral' });

const Experiment = H.kind('experiment')
  .data(z.object({ name: z.string(), endsAt: z.string(), a: z.array(z.number()), b: z.array(z.number()) }))
  .states([experimentScheduled, experimentSleeping, aWins, bWins, inconclusive], 'experiment-scheduled');

const measureExperiment = H.command('measure-experiment')
  .input(z.object({ name: z.string() }))
  .output(z.object({ a: z.number(), b: z.number() }))
  .argv(input => ['experiment-metric', input.name])
  .on(opsBox)
  .restart('rerun');

type ExperimentVerdict = 'a-wins' | 'b-wins' | 'inconclusive';

function average(values: readonly number[]): number {
  return values.length === 0 ? 0 : values.reduce((sum, v) => sum + v, 0) / values.length;
}

const experimentVerdict = H.policy.rule(
  'experiment-verdict',
  (input: { readonly a: readonly number[]; readonly b: readonly number[] }, metrics: Metrics): ExperimentVerdict => {
    const inconclusiveShare = metrics.rate({
      among: { entry: 'transition', kind: 'experiment', position: 'terminal' },
      count: { entry: 'transition', kind: 'experiment', state: 'inconclusive' },
      days: 365,
    });
    const margin = inconclusiveShare.samples >= 10 && (inconclusiveShare.value ?? 0) > 0.5 ? 0.02 : 0.05;
    const meanA = average(input.a);
    const meanB = average(input.b);
    const base = Math.max(Math.abs(meanA), Math.abs(meanB), 1e-9);
    if ((meanA - meanB) / base > margin) return 'a-wins';
    if ((meanB - meanA) / base > margin) return 'b-wins';
    return 'inconclusive';
  },
);

const runExperimentHour = H.flow('run-experiment-hour').for(Experiment).does(async ctx => {
  const experiment = ctx.unit.data;
  const measured = await ctx.run(measureExperiment, { name: experiment.name });
  if (measured.ok === false) return ctx.fail(measured.error);
  const a = [...experiment.a, measured.value.a];
  const b = [...experiment.b, measured.value.b];
  await ctx.update({ a, b });
  const now = ctx.now();
  if (now.getTime() < Date.parse(experiment.endsAt)) {
    return ctx.until('experiment-sleeping', { at: new Date(now.getTime() + hourMs), then: 'experiment-scheduled' });
  }
  return ctx.decide(experimentVerdict, { a, b });
});

const experiments = H.lane('experiments', Experiment)
  .handler(runExperimentHour)
  .suppliers(H.operator)
  .store(sqlite.store(Experiment, 'lifecycles.db'));

const reviewDue = H.state('review-due', 'pending');
const betweenReviews = H.state('between-reviews', 'waiting');
const suspended = H.state('suspended', 'waiting');
const churned = H.state('churned', { terminal: 'neutral' });

const Tenancy = H.kind('tenancy')
  .data(z.object({
    tenant: z.string(),
    plan: z.string(),
    lastReview: z.string(),
    lastDecision: z.enum(['none', 'upsell', 'hold']),
  }))
  .states([reviewDue, betweenReviews, suspended, churned], 'review-due');

const usageReport = H.command('usage-report')
  .input(z.object({ tenant: z.string() }))
  .output(z.object({ report: z.string() }))
  .argv(input => ['usage-report', '--tenant', input.tenant, '--days', '31'])
  .on(opsBox)
  .restart('rerun');

const accountSummaryRole = H.role('account-summarizer')
  .input(z.object({ tenant: z.string(), plan: z.string(), usage: z.string() }))
  .output(z.object({ summary: z.string() }))
  .prompt(t => `Summarise this month's usage for ${t.tenant} on plan ${t.plan} and say whether an upsell is plausible.\n\n${t.usage}`);

const accountSummarizer = H.agent('account-summarizer', accountSummaryRole).model(anthropic.model('claude-sonnet-4-5'));

const reviewTenancy = H.flow('review-tenancy').for(Tenancy).does(async ctx => {
  const tenancy = ctx.unit.data;
  const usage = await ctx.run(usageReport, { tenant: tenancy.tenant });
  if (usage.ok === false) return ctx.fail(usage.error);
  const summary = await ctx.run(accountSummarizer, { tenant: tenancy.tenant, plan: tenancy.plan, usage: usage.value.report });
  if (summary.ok === false) return ctx.fail(summary.error);
  const decision = await ctx.halt({
    name: 'upsell-decision',
    show: summary.value.summary,
    decision: z.object({ upsell: z.boolean(), note: z.string() }),
  });
  const now = ctx.now();
  await ctx.update({ lastReview: now.toISOString(), lastDecision: decision.upsell ? 'upsell' : 'hold' });
  return ctx.until('between-reviews', { at: new Date(now.getFullYear(), now.getMonth() + 1, 1), then: 'review-due' });
});

const billingEvents = http.webhook(Tenancy, {
  path: '/hooks/billing',
  secret: H.env('BILLING_WEBHOOK_SECRET'),
  body: z.object({ tenantId: z.string(), event: z.enum(['suspended', 'reinstated', 'churned']) }),
  read: body => ({
    update: body.tenantId,
    state: body.event === 'churned' ? 'churned' : body.event === 'suspended' ? 'suspended' : 'review-due',
  }),
});

const tenancies = H.lane('tenancies', Tenancy)
  .handler(reviewTenancy)
  .suppliers(H.operator, billingEvents)
  .store(sqlite.store(Tenancy, 'lifecycles.db'));

const ourTurn = H.state('our-turn', 'pending');
const awaitingVendor = H.state('awaiting-vendor', 'waiting');
const agreed = H.state('agreed', { terminal: 'success' });
const weWalked = H.state('we-walked', { terminal: 'neutral' });
const theyWalked = H.state('they-walked', { terminal: 'neutral' });
const expired = H.state('expired', { terminal: 'neutral' });

const exchangeSchema = z.object({ from: z.enum(['us', 'them']), text: z.string() });
type Exchange = z.infer<typeof exchangeSchema>;

const Negotiation = H.kind('negotiation')
  .data(z.object({
    vendor: z.string(),
    item: z.string(),
    expiresAt: z.string(),
    history: z.array(exchangeSchema),
    lastReply: z.string(),
  }))
  .states([ourTurn, awaitingVendor, agreed, weWalked, theyWalked, expired], 'our-turn');

const negotiatorRole = H.role('negotiator')
  .input(z.object({ vendor: z.string(), item: z.string(), history: z.array(exchangeSchema) }))
  .output(z.object({ move: z.enum(['offer', 'accept', 'walk-away']), message: z.string() }))
  .prompt(n => `Negotiate the purchase of ${n.item} from ${n.vendor}. Decide the next move.\n\n${n.history.map(e => `${e.from}: ${e.text}`).join('\n')}`);

const negotiator = H.agent('negotiator', negotiatorRole).model(anthropic.model('claude-opus-4-1'));

const sendToVendor = H.command('send-to-vendor')
  .input(z.object({ vendor: z.string(), text: z.string() }))
  .argv(input => ['procurement-mail', '--to', input.vendor, '--body', input.text])
  .on(opsBox);

const negotiateRound = H.flow('negotiate-round').for(Negotiation).does(async ctx => {
  const negotiation = ctx.unit.data;
  const history: Exchange[] = negotiation.lastReply === ''
    ? negotiation.history
    : [...negotiation.history, { from: 'them', text: negotiation.lastReply }];
  const next = await ctx.run(negotiator, { vendor: negotiation.vendor, item: negotiation.item, history });
  if (next.ok === false) return ctx.fail(next.error);
  const sent = await ctx.run(sendToVendor, { vendor: negotiation.vendor, text: next.value.message });
  if (sent.ok === false) return ctx.fail(sent.error);
  const updated: Exchange[] = [...history, { from: 'us', text: next.value.message }];
  await ctx.update({ history: updated, lastReply: '' });
  if (next.value.move === 'walk-away') return 'we-walked';
  if (next.value.move === 'accept') return 'agreed';
  return 'awaiting-vendor';
});

const vendorReplies = http.webhook(Negotiation, {
  path: '/hooks/vendor-reply',
  secret: H.env('VENDOR_WEBHOOK_SECRET'),
  body: z.object({ negotiationId: z.string(), text: z.string(), walkedAway: z.boolean() }),
  read: body => ({
    update: body.negotiationId,
    patch: { lastReply: body.text },
    state: body.walkedAway ? 'they-walked' : 'our-turn',
  }),
});

const negotiations = H.lane('negotiations', Negotiation)
  .handler(negotiateRound)
  .suppliers(H.operator, vendorReplies)
  .store(sqlite.store(Negotiation, 'lifecycles.db'));

const negotiationExpiry = H.trigger(
  'negotiation-expiry',
  H.on.deadline(Negotiation, data => new Date(data.expiresAt), ['our-turn', 'awaiting-vendor']),
  (_event, act) => act.move('expired'),
);

const apiAccount = anthropic.account('lifecycles-api', { apiKey: H.env('ANTHROPIC_API_KEY') });

const firstEligible = H.policy.account('first-eligible', choice => {
  const [first] = choice.accounts.filter(view => view.eligible);
  return first ? first.account : null;
});

const oldestFirst = H.policy.scheduler('oldest-first', view => ({
  start: [...view.pending].sort((x, y) => y.waitedMs - x.waitedMs),
}));

export const lifecycles = H.harness('lifecycles')
  .ledger(sqlite.ledger('lifecycles-ledger.db'))
  .lanes(experiments, tenancies, negotiations)
  .pools(H.pool('lifecycles-api', [{ account: apiAccount, share: 1 }], firstEligible))
  .triggers(negotiationExpiry)
  .scheduler(oldestFirst)
  .clients(claudeCode.supervisor({ grants: [H.ops.readWork, H.ops.writeWork, H.ops.resolveHalts, H.ops.readTelemetry] }))
  .observers(markdown.board('BOARD.md'), markdown.telemetry('TELEMETRY.md'));
