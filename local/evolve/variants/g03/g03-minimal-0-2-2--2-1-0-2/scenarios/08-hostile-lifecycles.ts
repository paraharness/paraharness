import { z } from 'zod';
import { H, type SupplyOf } from 'harness-dsl';
import * as anthropic from 'harness-dsl/anthropic';
import * as claudeCode from 'harness-dsl/claude-code';
import * as sqlite from 'harness-dsl/sqlite';
import * as shell from 'harness-dsl/shell';
import * as http from 'harness-dsl/http';
import * as markdown from 'harness-dsl/markdown';

const sonnet = anthropic.model('claude-sonnet-4-5');
const haiku = anthropic.model('claude-haiku-4-5');
const api = anthropic.account('lifecycles-api', { apiKey: H.env('ANTHROPIC_API_KEY'), serves: [sonnet, haiku] });

const local = shell.local('local', { slots: 4 });

const scheduled = H.state('scheduled', 'pending');
const observing = H.state('observing', 'waiting');
const aWins = H.state('a-wins', 'terminal', 'success');
const bWins = H.state('b-wins', 'terminal', 'success');
const inconclusive = H.state('inconclusive', 'terminal', 'neutral');
const aborted = H.state('aborted', 'terminal', 'failure');

const experiment = H.kind('experiment')
  .data(z.object({ name: z.string() }))
  .states(scheduled, observing, aWins, bWins, inconclusive, aborted);

const experimentLength = H.policy.rule('experiment-length-days', (input: { readonly name: string }, metrics) => {
  const inconclusiveShare = metrics.rate({
    among: { entry: 'transition', kind: experiment, position: 'terminal' },
    count: { entry: 'transition', kind: experiment, state: 'inconclusive' },
    days: 180,
  });
  return inconclusiveShare.samples >= 10 && inconclusiveShare.value !== null && inconclusiveShare.value > 0.3 ? 21 : 14;
});

const sampleMetric = H.command('sample-experiment-metric')
  .input(z.object({ name: z.string() }))
  .output(z.object({ a: z.number(), b: z.number() }))
  .argv(i => ['experiment-metric', '--name', i.name])
  .on(local);

const judgeExperiment = H.command('judge-experiment')
  .input(z.object({ name: z.string(), samples: z.array(z.object({ a: z.number(), b: z.number() })) }))
  .output(z.object({ winner: z.enum(['a', 'b', 'none']) }))
  .argv(i => ['experiment-judge', '--name', i.name, '--samples', JSON.stringify(i.samples)])
  .on(local);

const runExperiment = H.flow('run-experiment')
  .for(experiment)
  .does(async ctx => {
    const days = await ctx.decide(experimentLength, { name: ctx.unit.data.name });
    const started = ctx.now();
    const samples: { a: number; b: number }[] = [];
    for (let hour = 1; hour <= days * 24; hour++) {
      const sample = await ctx.run(sampleMetric, { name: ctx.unit.data.name });
      if (sample.ok) samples.push(sample.value);
      await ctx.suspend('observing', { at: new Date(started.getTime() + hour * 60 * 60 * 1000) });
    }
    const verdict = await ctx.run(judgeExperiment, { name: ctx.unit.data.name, samples });
    if (!verdict.ok) return ctx.fail(verdict.error);
    return verdict.value.winner === 'a' ? 'a-wins' : verdict.value.winner === 'b' ? 'b-wins' : 'inconclusive';
  });

const experiments = H.lane('experiments', experiment)
  .handler(runExperiment)
  .retries(1, { exhausted: 'aborted' })
  .suppliers(H.operator)
  .store(sqlite.store(experiment, '.harness/experiments.db'));

const reviewDue = H.state('review-due', 'pending');
const customer = H.state('customer', 'waiting');
const suspended = H.state('suspended', 'waiting');
const reviewStalled = H.state('review-stalled', 'waiting');
const churned = H.state('churned', 'terminal', 'neutral');

const tenancy = H.kind('tenancy')
  .data(z.object({ customer: z.string(), lastReview: z.string().optional(), upsellOffered: z.boolean().optional() }))
  .states(reviewDue, customer, suspended, reviewStalled, churned);

const usageReport = H.command('tenancy-usage-report')
  .input(z.object({ customer: z.string() }))
  .argv(i => ['usage-report', '--customer', i.customer, '--month', 'last'])
  .on(local);

const summarizeAccountRole = H.role('summarize-tenancy')
  .input(z.object({ customer: z.string(), usage: z.string() }))
  .output(z.object({ summary: z.string() }))
  .prompt(i => `Summarize last month's usage for ${i.customer}:\n${i.usage}`);

const tenancySummarizer = H.seat('tenancy-summarizer', summarizeAccountRole).model(haiku);

const upsell = H.halt('upsell-decision', z.object({ upsell: z.boolean(), note: z.string().optional() }))
  .about(z.object({ customer: z.string(), summary: z.string() }));

const reviewTenancy = H.flow('review-tenancy')
  .for(tenancy)
  .does(async ctx => {
    const usage = await ctx.run(usageReport, { customer: ctx.unit.data.customer });
    if (!usage.ok) return ctx.fail(usage.error);
    const summary = await ctx.run(tenancySummarizer, { customer: ctx.unit.data.customer, usage: usage.value });
    if (!summary.ok) return ctx.fail(summary.error);
    const decision = await ctx.halt(upsell, summary.value.summary, { customer: ctx.unit.data.customer, summary: summary.value.summary });
    await ctx.update({ lastReview: ctx.now().toISOString(), upsellOffered: decision.upsell });
    return 'customer';
  });

const monthlyReview = H.schedule('monthly-tenancy-review', tenancy, { daily: '06:00' }, tick =>
  tick.now.getDate() === 1
    ? tick.units
        .filter(u => u.state === 'customer')
        .map((u): SupplyOf<typeof tenancy> => ({ update: u.key, state: 'review-due' }))
    : []
);

const tenancies = H.lane('tenancies', tenancy)
  .handler(reviewTenancy)
  .retries(2, { backoff: { first: { hours: 1 }, factor: 2 }, exhausted: 'review-stalled' })
  .suppliers(H.operator, monthlyReview)
  .store(sqlite.store(tenancy, '.harness/tenancies.db'));

const ourTurn = H.state('our-turn', 'pending');
const theirTurn = H.state('their-turn', 'waiting');
const stalled = H.state('stalled', 'waiting');
const agreed = H.state('agreed', 'terminal', 'success');
const weWalked = H.state('we-walked', 'terminal', 'neutral');
const theyWalked = H.state('they-walked', 'terminal', 'failure');
const expired = H.state('expired', 'terminal', 'neutral');

const negotiation = H.kind('negotiation')
  .data(z.object({ vendor: z.string(), mandate: z.string(), expiresAt: z.string(), lastVendorMessage: z.string().optional() }))
  .states(ourTurn, theirTurn, stalled, agreed, weWalked, theyWalked, expired);

const negotiateRole = H.role('negotiate')
  .input(z.object({ vendor: z.string(), mandate: z.string(), lastVendorMessage: z.string() }))
  .output(z.object({ move: z.enum(['offer', 'accept', 'walk-away']), text: z.string() }))
  .prompt(i => `Mandate: ${i.mandate}\nVendor ${i.vendor} said: ${i.lastVendorMessage}\nDraft our next move.`);

const negotiator = H.seat('negotiator', negotiateRole).model(sonnet);

const sendToVendor = H.command('send-to-vendor')
  .input(z.object({ negotiation: z.string(), text: z.string() }))
  .argv(i => ['procurement-send', '--negotiation', i.negotiation, '--text', i.text])
  .on(local)
  .recovery('park');

const negotiationRound = H.flow('negotiation-round')
  .for(negotiation)
  .does(async ctx => {
    const next = await ctx.run(negotiator, {
      vendor: ctx.unit.data.vendor,
      mandate: ctx.unit.data.mandate,
      lastVendorMessage: ctx.unit.data.lastVendorMessage ?? '',
    });
    if (!next.ok) return ctx.fail(next.error);
    if (next.value.move === 'walk-away') return 'we-walked';
    const sent = await ctx.run(sendToVendor, { negotiation: ctx.unit.key, text: next.value.text });
    if (!sent.ok) return ctx.fail(sent.error);
    return next.value.move === 'accept' ? 'agreed' : 'their-turn';
  });

const vendorReplies = http.webhook(negotiation, {
  path: '/vendor-replies',
  secret: H.env('VENDOR_WEBHOOK_SECRET'),
  body: z.object({ negotiation: z.string(), event: z.enum(['reply', 'accept', 'walk-away']), message: z.string() }),
  read: body =>
    body.event === 'reply'
      ? { update: body.negotiation, patch: { lastVendorMessage: body.message }, state: 'our-turn' }
      : body.event === 'accept'
        ? { update: body.negotiation, patch: { lastVendorMessage: body.message }, state: 'agreed' }
        : { update: body.negotiation, patch: { lastVendorMessage: body.message }, state: 'they-walked' },
});

const negotiations = H.lane('negotiations', negotiation)
  .handler(negotiationRound)
  .retries(2, { backoff: { first: { minutes: 30 } }, exhausted: 'stalled' })
  .suppliers(H.operator, vendorReplies)
  .store(sqlite.store(negotiation, '.harness/negotiations.db'));

const negotiationExpiry = H.trigger(
  'negotiation-expiry',
  H.on.deadline(negotiation, d => new Date(d.expiresAt), ['our-turn', 'their-turn', 'stalled']),
  (_event, act) => act.move('expired')
);

export default H.harness('lifecycles')
  .ledger(sqlite.ledger('.harness/ledger.db'))
  .lanes(experiments, tenancies, negotiations)
  .pools(H.pool('lifecycles-api', [{ account: api, share: 1 }]))
  .triggers(negotiationExpiry)
  .clients(claudeCode.supervisor({ grants: [H.ops.readWork, H.ops.writeWork, H.ops.resolveHalts, H.ops.readTelemetry] }))
  .observers(markdown.board('.harness/board.md'), markdown.telemetry('.harness/telemetry.md'));
