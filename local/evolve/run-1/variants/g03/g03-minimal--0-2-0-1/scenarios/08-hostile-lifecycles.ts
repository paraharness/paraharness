import { H } from 'harness-dsl';
import type { Metrics } from 'harness-dsl';
import * as anthropic from 'harness-dsl/anthropic';
import * as cc from 'harness-dsl/claude-code';
import * as http from 'harness-dsl/http';
import * as sqlite from 'harness-dsl/sqlite';
import * as shell from 'harness-dsl/shell';
import * as markdown from 'harness-dsl/markdown';
import { z } from 'zod';

const local = shell.local('local', { slots: 4 });
const strong = anthropic.model('claude-sonnet-4-5');

const hourMs = 60 * 60 * 1000;
const twoWeeksMs = 14 * 24 * hourMs;

function firstOfNextMonth(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1, 9));
}

function mean(values: readonly number[]): number {
  return values.length === 0 ? 0 : values.reduce((sum, v) => sum + v, 0) / values.length;
}

const scheduled = H.state('scheduled', 'pending');
const measuring = H.state('measuring', 'active');
const collecting = H.state('collecting', 'waiting');
const aWins = H.state('a-wins', 'terminal', 'success');
const bWins = H.state('b-wins', 'terminal', 'success');
const inconclusive = H.state('inconclusive', 'terminal', 'neutral');

const Experiment = H.kind('experiment')
  .data(z.object({
    name: z.string(),
    startedAt: z.string().optional(),
    samplesA: z.array(z.number()),
    samplesB: z.array(z.number()),
  }))
  .states(scheduled, measuring, collecting, aWins, bWins, inconclusive);

type ExperimentResult = 'a' | 'b' | 'inconclusive';
interface Samples {
  readonly a: readonly number[];
  readonly b: readonly number[];
}

const experimentVerdict = H.policy.rule('experiment-verdict', (samples: Samples, metrics: Metrics): ExperimentResult => {
  const history = metrics.rate({
    among: { entry: 'transition', kind: Experiment, position: 'terminal' },
    count: { entry: 'transition', kind: Experiment, state: inconclusive },
    days: 365,
  });
  const oftenInconclusive = history.samples >= 10 && history.value !== null && history.value > 0.5;
  const margin = oftenInconclusive ? 0.02 : 0.05;
  const a = mean(samples.a);
  const b = mean(samples.b);
  const baseline = Math.max(Math.abs(a), Math.abs(b), 1e-9);
  if ((a - b) / baseline > margin) return 'a';
  if ((b - a) / baseline > margin) return 'b';
  return 'inconclusive';
});

const measure = H.command('measure-experiment')
  .input(z.object({ name: z.string() }))
  .output(z.object({ a: z.number(), b: z.number() }))
  .argv(e => ['experiment-metric', '--experiment', e.name, '--json'])
  .on(local)
  .recovers('rerun');

const experimentFlow = H.flow('hourly-measurement').for(Experiment).does(async ctx => {
  await ctx.move('measuring');
  const now = await ctx.now();
  const experiment = ctx.unit.data;
  const startedAt = experiment.startedAt ?? now.toISOString();
  const sample = await ctx.run(measure, { name: experiment.name });
  if (!sample.ok) return ctx.fail(sample.error);
  const samplesA = [...experiment.samplesA, sample.value.a];
  const samplesB = [...experiment.samplesB, sample.value.b];
  await ctx.update({ startedAt, samplesA, samplesB });
  if (now.getTime() - Date.parse(startedAt) < twoWeeksMs) {
    return ctx.wait('collecting', { at: new Date(now.getTime() + hourMs), then: 'scheduled' });
  }
  const result = await ctx.decide(experimentVerdict, { a: samplesA, b: samplesB });
  return result === 'a' ? 'a-wins' : result === 'b' ? 'b-wins' : 'inconclusive';
});

const reviewDue = H.state('review-due', 'pending');
const reviewing = H.state('reviewing', 'active');
const between = H.state('between-reviews', 'waiting');
const suspended = H.state('suspended', 'waiting');
const churned = H.state('churned', 'terminal', 'neutral');

const Tenancy = H.kind('tenancy')
  .data(z.object({ tenant: z.string(), lastReview: z.string().optional(), upsold: z.boolean().optional() }))
  .states(reviewDue, reviewing, between, suspended, churned);

const usageReport = H.command('usage-report')
  .input(z.object({ tenant: z.string() }))
  .argv(t => ['usage-report', '--tenant', t.tenant, '--last-month'])
  .on(local)
  .recovers('rerun');

const tenancySummaryRole = H.role('tenancy-summarizer')
  .input(z.object({ tenant: z.string(), usage: z.string() }))
  .output(z.object({ summary: z.string(), upsellCase: z.string() }))
  .prompt(t => `Summarise last month's usage for ${t.tenant} and state the case for or against an upsell:\n${t.usage}`);
const tenancySummarizer = H.agent('tenancy-summarizer', tenancySummaryRole).model(strong);

const upsellDecision = H.halt('upsell-decision', z.object({ upsell: z.boolean(), note: z.string() }));

const tenancyFlow = H.flow('monthly-tenancy-review').for(Tenancy).does(async ctx => {
  await ctx.move('reviewing');
  const tenancy = ctx.unit.data;
  const usage = await ctx.run(usageReport, { tenant: tenancy.tenant });
  if (!usage.ok) return ctx.fail(usage.error);
  const summary = await ctx.run(tenancySummarizer, { tenant: tenancy.tenant, usage: usage.value });
  if (!summary.ok) return ctx.fail(summary.error);
  const decision = await ctx.halt(upsellDecision, `${summary.value.summary}\n\n${summary.value.upsellCase}`);
  const now = await ctx.now();
  await ctx.update({ lastReview: now.toISOString(), upsold: decision.upsell });
  return ctx.wait('between-reviews', { at: firstOfNextMonth(now), then: 'review-due' });
});

const billingEvents = http.webhook(Tenancy, {
  path: '/billing',
  secret: H.env('BILLING_WEBHOOK_SECRET'),
  body: z.object({ tenant: z.string(), event: z.enum(['signed', 'suspended', 'reinstated', 'churned']) }),
  read: b =>
    b.event === 'signed'
      ? { create: { tenant: b.tenant }, key: b.tenant }
      : {
          update: b.tenant,
          state: b.event === 'suspended' ? 'suspended' : b.event === 'reinstated' ? 'review-due' : 'churned',
        },
});

const ourTurn = H.state('our-turn', 'pending');
const drafting = H.state('drafting', 'active');
const theirTurn = H.state('their-turn', 'waiting');
const agreed = H.state('agreed', 'terminal', 'success');
const walkedAwayUs = H.state('walked-away-by-us', 'terminal', 'neutral');
const walkedAwayThem = H.state('walked-away-by-them', 'terminal', 'failure');
const expired = H.state('expired', 'terminal', 'failure');

const negotiationData = z.object({
  vendor: z.string(),
  item: z.string(),
  expiresAt: z.string(),
  lastReply: z.string().optional(),
  history: z.array(z.object({ from: z.enum(['us', 'them']), text: z.string() })),
});
type NegotiationData = z.infer<typeof negotiationData>;

const Negotiation = H.kind('negotiation')
  .data(negotiationData)
  .states(ourTurn, drafting, theirTurn, agreed, walkedAwayUs, walkedAwayThem, expired);

const negotiatorRole = H.role('negotiator')
  .input(z.object({ vendor: z.string(), item: z.string(), history: z.array(z.object({ from: z.string(), text: z.string() })) }))
  .output(z.object({ offer: z.string(), walkAway: z.boolean() }))
  .prompt(n => `Draft our next offer to ${n.vendor} for ${n.item}, or walk away.\n${n.history.map(h => `${h.from}: ${h.text}`).join('\n')}`);
const negotiator = H.agent('negotiator', negotiatorRole).model(strong);

const sendOffer = H.command('send-offer')
  .input(z.object({ negotiation: z.string(), vendor: z.string(), offer: z.string() }))
  .argv(o => ['send-offer', '--negotiation', o.negotiation, '--vendor', o.vendor, '--text', o.offer])
  .on(local)
  .recovers('park');

const negotiationFlow = H.flow('negotiation-round').for(Negotiation).does(async ctx => {
  await ctx.move('drafting');
  const negotiation = ctx.unit.data;
  const history: NegotiationData['history'] = negotiation.lastReply
    ? [...negotiation.history, { from: 'them', text: negotiation.lastReply }]
    : negotiation.history;
  const next = await ctx.run(negotiator, { vendor: negotiation.vendor, item: negotiation.item, history });
  if (!next.ok) return ctx.fail(next.error);
  if (next.value.walkAway) {
    await ctx.update({ history, lastReply: undefined });
    return 'walked-away-by-us';
  }
  const sent = await ctx.run(sendOffer, { negotiation: ctx.unit.key, vendor: negotiation.vendor, offer: next.value.offer });
  if (!sent.ok) return ctx.fail(sent.error);
  const withOffer: NegotiationData['history'] = [...history, { from: 'us', text: next.value.offer }];
  await ctx.update({ history: withOffer, lastReply: undefined });
  return ctx.wait('their-turn', { then: 'our-turn' });
});

const vendorReplies = http.webhook(Negotiation, {
  path: '/vendor-replies',
  secret: H.env('VENDOR_WEBHOOK_SECRET'),
  body: z.object({ negotiation: z.string(), type: z.enum(['reply', 'accept', 'walk-away']), text: z.string() }),
  read: b =>
    b.type === 'reply'
      ? { update: b.negotiation, patch: { lastReply: b.text }, state: 'our-turn' }
      : { update: b.negotiation, state: b.type === 'accept' ? 'agreed' : 'walked-away-by-them' },
});

const negotiationExpires = H.trigger(
  'negotiation-expires',
  H.on.deadline(Negotiation, n => new Date(n.expiresAt), ['our-turn', 'drafting', 'their-turn']),
  (_event, act) => act.move('expired')
);

const experiments = H.lane('experiments', Experiment).handler(experimentFlow).suppliers(H.operator).store(sqlite.store(Experiment, './.harness/units.sqlite'));
const tenancies = H.lane('tenancies', Tenancy).handler(tenancyFlow).suppliers(H.operator, billingEvents).store(sqlite.store(Tenancy, './.harness/units.sqlite'));
const negotiations = H.lane('negotiations', Negotiation).handler(negotiationFlow).suppliers(H.operator, vendorReplies).store(sqlite.store(Negotiation, './.harness/units.sqlite'));

const pool = H.pool('anthropic', [{ account: anthropic.account('business', { apiKey: H.env('ANTHROPIC_API_KEY') }), share: 1 }]);

export const harness = H.harness('business-lifecycles')
  .ledger(sqlite.ledger('./.harness/ledger.sqlite'))
  .lanes(experiments, tenancies, negotiations)
  .pools(pool)
  .triggers(negotiationExpires)
  .scheduler(H.policy.scheduler('oldest-first', view => ({ start: [...view.pending].sort((x, y) => y.waitedMs - x.waitedMs) })))
  .clients(cc.supervisor({ grants: [H.ops.readWork, H.ops.writeWork, H.ops.resolveHalts, H.ops.readTelemetry] }))
  .observers(markdown.board('./BOARD.md'), markdown.telemetry('./TELEMETRY.md'));

export const running = harness.start();
