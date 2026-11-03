import { z } from 'zod';
import { H } from 'harness-dsl';
import type { SupplyOf } from 'harness-dsl';
import * as claude from 'harness-dsl/claude-code';
import * as anthropic from 'harness-dsl/anthropic';
import * as sqlite from 'harness-dsl/sqlite';
import * as shell from 'harness-dsl/shell';
import * as http from 'harness-dsl/http';
import * as markdown from 'harness-dsl/markdown';

const local = shell.local('local', { slots: 4 });
const sonnet = anthropic.model('claude-sonnet-4-5');
const apiAccount = anthropic.account('anthropic-api', { apiKey: H.env('ANTHROPIC_API_KEY') });

const experiment = H.kind('experiment')
  .data(z.object({ hypothesis: z.string(), metric: z.string() }))
  .states(
    H.state('proposed', 'pending'),
    H.state('collecting', 'waiting'),
    H.state('a-wins', 'terminal', 'success'),
    H.state('b-wins', 'terminal', 'success'),
    H.state('inconclusive', 'terminal', 'neutral')
  );

const readingSchema = z.object({ a: z.number(), b: z.number() });

const readExperimentMetric = H.command('read-experiment-metric')
  .input(z.object({ experiment: z.string(), metric: z.string() }))
  .output(readingSchema)
  .argv((input) => ['experiment-metric', '--experiment', input.experiment, '--metric', input.metric])
  .on(local)
  .retries(2, { first: { minutes: 1 } });

const judgeExperiment = H.command('judge-experiment')
  .input(z.object({ readings: z.array(readingSchema) }))
  .output(z.enum(['a-wins', 'b-wins', 'inconclusive']))
  .argv((input) => ['experiment-judge', '--readings', JSON.stringify(input.readings)])
  .on(local);

const experimentFlow = H.flow('run-experiment').for(experiment).does(async (ctx) => {
  const readings: { a: number; b: number }[] = [];
  for (let hour = 0; hour < 14 * 24; hour += 1) {
    const reading = await ctx.run(readExperimentMetric, { experiment: ctx.unit.key, metric: ctx.unit.data.metric });
    if (reading.ok) readings.push(reading.value);
    await ctx.suspend('collecting', { at: new Date(ctx.now().getTime() + 3_600_000) });
  }
  const verdict = await ctx.run(judgeExperiment, { readings });
  if (!verdict.ok) return ctx.fail(verdict.error);
  return verdict.value;
});

const tenancy = H.kind('tenancy')
  .data(z.object({ tenant: z.string(), plan: z.string(), nextReviewAt: z.string(), upsellOffered: z.boolean().optional() }))
  .states(
    H.state('review-due', 'pending'),
    H.state('current', 'waiting'),
    H.state('suspended', 'waiting'),
    H.state('churned', 'terminal', 'neutral')
  );

const usageReport = H.command('usage-report')
  .input(z.object({ tenant: z.string() }))
  .argv((input) => ['usage-report', '--tenant', input.tenant, '--days', '30'])
  .on(local);

const openUpsellOpportunity = H.command('open-upsell-opportunity')
  .input(z.object({ tenant: z.string(), note: z.string() }))
  .argv((input) => ['crm', 'opportunity', 'create', '--tenant', input.tenant, '--note', input.note])
  .on(local)
  .recovery('park');

const accountReviewer = H.role('account-reviewer')
  .input(z.object({ tenant: z.string(), plan: z.string(), usage: z.string() }))
  .output(z.object({ summary: z.string() }))
  .prompt((input) => `Summarise the month for ${input.tenant} on ${input.plan}. Usage:\n${input.usage}`);

const reviewer = H.seat('account-reviewer', accountReviewer).model(sonnet);

const upsellDecision = H.halt('upsell-decision', z.object({ upsell: z.boolean(), note: z.string() })).about(
  z.object({ tenant: z.string(), summary: z.string() })
);

const tenancyFlow = H.flow('monthly-review').for(tenancy).does(async (ctx) => {
  const { tenant, plan } = ctx.unit.data;
  const usage = await ctx.run(usageReport, { tenant });
  if (!usage.ok) return ctx.fail(usage.error);
  const summary = await ctx.run(reviewer, { tenant, plan, usage: usage.value });
  if (!summary.ok) return ctx.fail(summary.error);
  const decision = await ctx.halt(upsellDecision, summary.value.summary, { tenant, summary: summary.value.summary });
  if (decision.upsell) {
    const opened = await ctx.run(openUpsellOpportunity, { tenant, note: decision.note });
    if (!opened.ok) return ctx.fail(opened.error);
  }
  await ctx.update({
    nextReviewAt: new Date(ctx.now().getTime() + 30 * 86_400_000).toISOString(),
    upsellOffered: decision.upsell,
  });
  return 'current';
});

const monthlyReviewClock = H.clock('monthly-tenancy-review', tenancy, { daily: '03:00' }, (tick) =>
  tick.units
    .filter((unit) => unit.state === 'current' && new Date(unit.data.nextReviewAt).getTime() <= tick.now.getTime())
    .map((unit): SupplyOf<typeof tenancy> => ({ update: unit.key, state: 'review-due' }))
);

const billingEvents = http.webhook(tenancy, {
  path: '/billing/events',
  secret: H.env('BILLING_WEBHOOK_SECRET'),
  body: z.object({ tenant: z.string(), event: z.enum(['suspended', 'reinstated', 'churned']) }),
  read: (body) => ({
    update: body.tenant,
    state: body.event === 'suspended' ? 'suspended' : body.event === 'reinstated' ? 'current' : 'churned',
  }),
});

const negotiation = H.kind('negotiation')
  .data(
    z.object({
      vendor: z.string(),
      item: z.string(),
      targetUsd: z.number(),
      expiresAt: z.string(),
      round: z.number(),
      lastVendorMessage: z.string(),
    })
  )
  .states(
    H.state('drafting', 'pending'),
    H.state('awaiting-vendor', 'waiting'),
    H.state('agreed', 'terminal', 'success'),
    H.state('walked-away-us', 'terminal', 'neutral'),
    H.state('walked-away-them', 'terminal', 'neutral'),
    H.state('expired', 'terminal', 'neutral')
  );

const negotiatorRole = H.role('negotiator')
  .input(z.object({ vendor: z.string(), item: z.string(), targetUsd: z.number(), round: z.number(), lastVendorMessage: z.string() }))
  .output(z.object({ action: z.enum(['offer', 'accept', 'walk-away']), message: z.string() }))
  .prompt(
    (input) =>
      `Round ${input.round} with ${input.vendor} for ${input.item}, target $${input.targetUsd}. They said:\n${input.lastVendorMessage}`
  );

const negotiator = H.seat('negotiator', negotiatorRole).model(sonnet);

const sendToVendor = H.command('send-to-vendor')
  .input(z.object({ negotiation: z.string(), vendor: z.string(), message: z.string() }))
  .argv((input) => ['procurement', 'send', '--negotiation', input.negotiation, '--vendor', input.vendor, '--message', input.message])
  .on(local)
  .recovery('park');

const negotiationRound = H.flow('negotiation-round').for(negotiation).does(async (ctx) => {
  const data = ctx.unit.data;
  const move = await ctx.run(negotiator, {
    vendor: data.vendor,
    item: data.item,
    targetUsd: data.targetUsd,
    round: data.round,
    lastVendorMessage: data.lastVendorMessage,
  });
  if (!move.ok) return ctx.fail(move.error);
  const sent = await ctx.run(sendToVendor, { negotiation: ctx.unit.key, vendor: data.vendor, message: move.value.message });
  if (!sent.ok) return ctx.fail(sent.error);
  if (move.value.action === 'accept') return 'agreed';
  if (move.value.action === 'walk-away') return 'walked-away-us';
  await ctx.update({ round: data.round + 1 });
  return 'awaiting-vendor';
});

const vendorReplies = http.webhook(negotiation, {
  path: '/procurement/replies',
  secret: H.env('PROCUREMENT_WEBHOOK_SECRET'),
  body: z.object({ negotiation: z.string(), reply: z.enum(['counter', 'accept', 'walk-away']), message: z.string() }),
  read: (body) => ({
    update: body.negotiation,
    patch: { lastVendorMessage: body.message },
    state: body.reply === 'counter' ? 'drafting' : body.reply === 'accept' ? 'agreed' : 'walked-away-them',
  }),
});

const negotiationExpiry = H.trigger(
  'negotiation-expiry',
  H.on.deadline(negotiation, (data) => new Date(data.expiresAt), ['drafting', 'awaiting-vendor']),
  (_, act) => act.move('expired')
);

const experimentLane = H.lane('experiments', experiment)
  .handler(experimentFlow, { exhausted: H.halts.exhausted })
  .suppliers(H.operator)
  .store(sqlite.store(experiment, '/srv/biz/.harness/experiments.sqlite'));

const tenancyLane = H.lane('tenancies', tenancy)
  .handler(tenancyFlow, { retries: 2, backoff: { first: { hours: 1 }, factor: 2 }, exhausted: H.halts.exhausted })
  .suppliers(H.operator, monthlyReviewClock, billingEvents)
  .store(sqlite.store(tenancy, '/srv/biz/.harness/tenancies.sqlite'));

const negotiationLane = H.lane('negotiations', negotiation)
  .handler(negotiationRound, { retries: 1, exhausted: H.halts.exhausted })
  .suppliers(H.operator, vendorReplies)
  .store(sqlite.store(negotiation, '/srv/biz/.harness/negotiations.sqlite'));

const holdExperimentsWhenInconclusive = H.policy.scheduler('hold-experiments-when-inconclusive', (view) => {
  const inconclusive = view.metrics.rate({
    among: { entry: 'transition', kind: experiment, position: 'terminal' },
    count: { entry: 'transition', kind: experiment, state: 'inconclusive' },
    days: 90,
  });
  const hold = inconclusive.samples >= 10 && inconclusive.value !== null && inconclusive.value > 0.5;
  return { start: view.pending.filter((unit) => !(hold && unit.is(experiment))) };
});

export const businessHarness = H.harness('business-lifecycles')
  .ledger(sqlite.ledger('/srv/biz/.harness/ledger.sqlite'))
  .lanes(experimentLane, tenancyLane, negotiationLane)
  .pools(H.pool('api', [{ account: apiAccount, share: 1 }]))
  .triggers(negotiationExpiry)
  .scheduler(holdExperimentsWhenInconclusive)
  .clients(
    claude.supervisor({
      grants: [
        H.ops.readWork,
        H.ops.writeWork,
        H.ops.readTelemetry,
        H.ops.resolve(upsellDecision, H.halts.exhausted, H.halts.interrupted, H.halts.definitionChanged),
      ],
    })
  )
  .observers(markdown.board('/srv/biz/.harness/board.md'), markdown.telemetry('/srv/biz/.harness/telemetry.md'));
