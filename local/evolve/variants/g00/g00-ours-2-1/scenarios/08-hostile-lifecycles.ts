import { z } from 'zod';
import { H } from 'harness-dsl';
import { claudeCode } from 'harness-dsl/claude-code';
import { anthropic } from 'harness-dsl/anthropic';
import { sqlite } from 'harness-dsl/sqlite';
import { http } from 'harness-dsl/http';
import { manual } from 'harness-dsl/supply';
import { runners } from 'harness-dsl/runners';
import { policies } from 'harness-dsl/policies';
import { observers } from 'harness-dsl/observers';

const api = H.account('anthropic-api', anthropic.api({ apiKey: H.env('ANTHROPIC_API_KEY') }));
const haiku = H.model('claude-haiku-4-5').pricing(anthropic.pricing());
const sonnet = H.model('claude-sonnet-4-5').pricing(anthropic.pricing());
const pool = H.pool('api', [api]).serves(haiku, sonnet).policy(policies.soonestReset());

const local = runners.local({ name: 'local', slots: 4 }).env({ ANALYTICS_TOKEN: H.env('ANALYTICS_TOKEN') });

const due = H.state('due').pending();
const sampling = H.state('sampling').active();
const measuring = H.state('measuring').waiting();
const aWon = H.state('a-won').terminal('neutral');
const bWon = H.state('b-won').terminal('neutral');
const inconclusive = H.state('inconclusive').terminal('neutral');

const experimentSchema = z.object({ name: z.string(), metric: z.string() });
const experiment = H.work('Experiment').schema(experimentSchema).states(due, sampling, measuring, aWon, bWon, inconclusive);

const collectSample = H.command('collect-sample')
  .input(z.object({ experiment: z.string(), metric: z.string() }))
  .output(z.object({ a: z.number(), b: z.number() }))
  .runner(local)
  .effect('repeatable')
  .run(async (input, ctx) => {
    const result = await ctx.exec(['abctl', 'sample', input.experiment, input.metric]);
    const [a, b] = result.stdout.trim().split(' ').map(Number);
    return { a: a ?? 0, b: b ?? 0 };
  });

const decideExperiment = H.command('decide-experiment')
  .input(z.object({ experiment: z.string() }))
  .output(z.object({ winner: z.enum(['A', 'B', 'none']) }))
  .runner(local)
  .effect('repeatable')
  .run(async (input, ctx) => {
    const result = await ctx.exec(['abctl', 'verdict', input.experiment]);
    const verdict = result.stdout.trim();
    return { winner: verdict === 'A' ? 'A' : verdict === 'B' ? 'B' : 'none' };
  });

const experimentHour = H.flow('experiment-hour')
  .input(experimentSchema)
  .step('sample', collectSample, s => ({ experiment: s.input.name, metric: s.input.metric }))
  .when((_, ctx) => ctx.now.getTime() - ctx.unit.created.getTime() < 14 * 86_400_000, f => f.exit('measured'))
  .step('verdict', decideExperiment, s => ({ experiment: s.input.name }))
  .when(s => s.verdict.winner === 'A', f => f.exit('aWins'))
  .when(s => s.verdict.winner === 'B', f => f.exit('bWins'))
  .exit('inconclusive');

const experiments = H.lane('experiments')
  .of(experiment)
  .from(manual('operator-experiments'))
  .store(sqlite.store('./lifecycles/experiments.sqlite'))
  .handle(experimentHour, {
    exits: { measured: measuring, aWins: aWon, bWins: bWon, inconclusive },
    retry: { retries: 2, backoff: { initial: '1m', factor: 2 }, exhausted: measuring },
  });

const reviewDue = H.state('review-due').pending();
const reviewing = H.state('reviewing').active();
const customer = H.state('customer').waiting();
const suspended = H.state('suspended').waiting();
const churned = H.state('churned').terminal('neutral');

const tenancySchema = z.object({
  customer: z.string(),
  plan: z.string(),
  billing: z.enum(['active', 'suspended', 'churned']),
});
const tenancy = H.work('Tenancy').schema(tenancySchema).states(reviewDue, reviewing, customer, suspended, churned);

const usageReview = H.command('usage-review')
  .input(z.object({ customer: z.string() }))
  .output(z.object({ report: z.string() }))
  .runner(local)
  .effect('repeatable')
  .run(async (input, ctx) => {
    const result = await ctx.exec(['usage-report', '--customer', input.customer, '--last', '30d']);
    return { report: result.stdout };
  });

const accountManagerRole = H.role('account-manager').prompt('Summarise a customer month for an upsell decision.').intents(['read']);
const summarySkill = H.skill('tenancy-summary')
  .input(z.object({ customer: z.string(), plan: z.string(), usage: z.string() }))
  .output(z.object({ summary: z.string() }))
  .prompt(i => `Customer ${i.customer} on ${i.plan}. Usage:\n${i.usage}`);
const summarizer = H.seat('tenancy-summarizer').role(accountManagerRole).skill(summarySkill).models(haiku);

const upsellDecision = H.halt('upsell-decision')
  .context(z.object({ customer: z.string(), summary: z.string() }))
  .decision(z.object({ upsell: z.boolean(), plan: z.string() }))
  .ask(c => `Upsell ${c.customer}?\n${c.summary}`);

const openUpsellTask = H.command('open-upsell-task')
  .input(z.object({ customer: z.string(), plan: z.string() }))
  .output(z.object({ task: z.string() }))
  .runner(local)
  .effect('unrepeatable')
  .detect(async (input, ctx) => {
    const found = await ctx.exec(['crm', 'find-task', '--customer', input.customer, '--plan', input.plan]);
    return found.code === 0 && found.stdout.trim() ? { task: found.stdout.trim() } : undefined;
  })
  .run(async (input, ctx) => {
    const created = await ctx.exec(['crm', 'create-task', '--customer', input.customer, '--plan', input.plan]);
    return { task: created.stdout.trim() };
  });

const monthlyReview = H.flow('monthly-tenancy-review')
  .input(tenancySchema)
  .step('usage', usageReview, s => ({ customer: s.input.customer }))
  .step('summary', summarizer, s => ({ customer: s.input.customer, plan: s.input.plan, usage: s.usage.report }))
  .halt('upsell', upsellDecision, s => ({ customer: s.input.customer, summary: s.summary.summary }))
  .when(s => s.upsell.upsell, f => f.step('proposal', openUpsellTask, s => ({ customer: s.input.customer, plan: s.upsell.plan })))
  .exit('reviewed');

const tenancies = H.lane('tenancies')
  .of(tenancy)
  .from(
    http.webhook({
      name: 'billing-events',
      path: '/billing',
      port: H.slot.port(0),
      secret: H.env('BILLING_WEBHOOK_SECRET'),
      body: tenancySchema,
      key: b => b.customer,
      data: b => b,
      mode: 'upsert',
    }),
  )
  .store(sqlite.store('./lifecycles/tenancies.sqlite'))
  .handle(monthlyReview, {
    exits: { reviewed: customer },
    retry: { retries: 2, backoff: { initial: '1h', factor: 2 }, exhausted: customer },
  });

const negotiating = H.state('negotiating').pending();
const drafting = H.state('drafting').active();
const awaitingVendor = H.state('awaiting-vendor').waiting();
const stalled = H.state('stalled').waiting();
const agreed = H.state('agreed').terminal('success');
const walkedAwayByUs = H.state('walked-away-by-us').terminal('neutral');
const walkedAwayByThem = H.state('walked-away-by-them').terminal('neutral');
const expired = H.state('expired').terminal('neutral');

const negotiationSchema = z.object({
  negotiationId: z.string(),
  vendor: z.string(),
  item: z.string(),
  ceilingUsd: z.number(),
  expiresAt: z.string(),
  lastVendorMessage: z.string(),
  vendorStatus: z.enum(['negotiating', 'accepted', 'walkedAway']),
});
const negotiation = H.work('Negotiation')
  .schema(negotiationSchema)
  .states(negotiating, drafting, awaitingVendor, stalled, agreed, walkedAwayByUs, walkedAwayByThem, expired);

const negotiatorRole = H.role('negotiator').prompt('Draft the next procurement offer within the ceiling.').intents(['read']);
const offerSkill = H.skill('next-offer')
  .input(z.object({ vendor: z.string(), item: z.string(), ceilingUsd: z.number(), lastVendorMessage: z.string() }))
  .output(z.object({ action: z.enum(['offer', 'accept', 'walkAway']), offerUsd: z.number(), message: z.string() }))
  .prompt(i => `Vendor ${i.vendor} for ${i.item}, ceiling $${i.ceilingUsd}. They said: ${i.lastVendorMessage}`);
const negotiator = H.seat('negotiator').role(negotiatorRole).skill(offerSkill).models(sonnet);

const confirmWalkAway = H.halt('confirm-walk-away')
  .context(z.object({ vendor: z.string(), reason: z.string() }))
  .decision(z.object({ confirmed: z.boolean() }))
  .ask(c => `Walk away from ${c.vendor}? ${c.reason}`);

const messageKind = z.enum(['offer', 'accept', 'withdraw']);

const vendorMessage = H.command('vendor-message')
  .input(z.object({ negotiationId: z.string(), kind: messageKind, message: z.string(), offerUsd: z.number() }))
  .output(z.object({ messageId: z.string() }))
  .runner(local)
  .effect('unrepeatable')
  .detect(async (input, ctx) => {
    const found = await ctx.exec(['procure', 'find-message', input.negotiationId, ctx.attempt]);
    return found.code === 0 && found.stdout.trim() ? { messageId: found.stdout.trim() } : undefined;
  })
  .run(async (input, ctx) => {
    const sent = await ctx.exec(['procure', 'send', input.negotiationId, input.kind, String(input.offerUsd), '--ref', ctx.attempt], { stdin: input.message });
    return { messageId: sent.stdout.trim() };
  });

const negotiationRound = H.flow('negotiation-round')
  .input(negotiationSchema)
  .step('draft', negotiator, s => ({
    vendor: s.input.vendor,
    item: s.input.item,
    ceilingUsd: s.input.ceilingUsd,
    lastVendorMessage: s.input.lastVendorMessage,
  }))
  .when(s => s.draft.action === 'accept', f =>
    f
      .step('accept', vendorMessage, s => ({ negotiationId: s.input.negotiationId, kind: messageKind.enum.accept, message: s.draft.message, offerUsd: s.draft.offerUsd }))
      .exit('agreed'),
  )
  .when(s => s.draft.action === 'walkAway', f =>
    f
      .halt('confirmWalkAway', confirmWalkAway, s => ({ vendor: s.input.vendor, reason: s.draft.message }))
      .when(s => s.confirmWalkAway.confirmed, g =>
        g
          .step('withdraw', vendorMessage, s => ({ negotiationId: s.input.negotiationId, kind: messageKind.enum.withdraw, message: s.draft.message, offerUsd: 0 }))
          .exit('walkedAway'),
      ),
  )
  .step('offer', vendorMessage, s => ({ negotiationId: s.input.negotiationId, kind: messageKind.enum.offer, message: s.draft.message, offerUsd: s.draft.offerUsd }))
  .exit('offered');

const negotiations = H.lane('negotiations')
  .of(negotiation)
  .from(
    manual('operator-negotiations'),
    http.webhook({
      name: 'vendor-replies',
      path: '/vendor-replies',
      port: H.slot.port(0),
      secret: H.env('VENDOR_WEBHOOK_SECRET'),
      body: negotiationSchema,
      key: b => b.negotiationId,
      data: b => b,
      mode: 'update',
    }),
  )
  .store(sqlite.store('./lifecycles/negotiations.sqlite'))
  .handle(negotiationRound, {
    exits: { agreed, walkedAway: walkedAwayByUs, offered: awaitingVendor },
    retry: { retries: 2, backoff: { initial: '10m', factor: 2 }, exhausted: stalled },
  })
  .wip(3);

const vendorUpdates = H.events.updates(negotiations);

const triggers = [
  H.trigger('experiment-hourly').on(H.time.every('0 * * * *')).do(experiments.move({ state: measuring }, due)),
  H.trigger('tenancy-monthly').on(H.time.every('0 9 1 * *')).do(tenancies.move({ state: customer }, reviewDue)),
  H.trigger('tenancy-suspended')
    .on(H.events.updates(tenancies).where(e => e.unit.data.billing === 'suspended' && e.previous.billing !== 'suspended'))
    .do(tenancies.move(e => e.unit.key, suspended)),
  H.trigger('tenancy-reinstated')
    .on(H.events.updates(tenancies).where(e => e.unit.data.billing === 'active' && e.previous.billing === 'suspended'))
    .do(tenancies.move(e => e.unit.key, customer)),
  H.trigger('tenancy-churned')
    .on(H.events.updates(tenancies).where(e => e.unit.data.billing === 'churned'))
    .do(tenancies.move(e => e.unit.key, churned)),
  H.trigger('vendor-replied')
    .on(vendorUpdates.where(e => e.unit.data.vendorStatus === 'negotiating' && e.unit.state === awaitingVendor.name))
    .do(negotiations.move(e => e.unit.key, negotiating)),
  H.trigger('vendor-accepted')
    .on(vendorUpdates.where(e => e.unit.data.vendorStatus === 'accepted'))
    .do(negotiations.move(e => e.unit.key, agreed)),
  H.trigger('vendor-walked-away')
    .on(vendorUpdates.where(e => e.unit.data.vendorStatus === 'walkedAway'))
    .do(negotiations.move(e => e.unit.key, walkedAwayByThem)),
  H.trigger('negotiation-expiry')
    .on(H.time.at(negotiations, d => new Date(d.expiresAt)))
    .do(negotiations.move(e => e.unit.key, expired)),
];

export const inconclusiveRate = H.metric('experiment-inconclusive-rate', H.events.transitions(experiments, { terminal: true }))
  .rate(e => e.to === inconclusive.name)
  .window('90d');

export const experimentOutcomes = H.metric('experiment-outcomes', H.events.transitions(experiments, { terminal: true }))
  .count()
  .by('state')
  .window('90d');

const order = H.policy.units('tenancies-negotiations-experiments', ({ candidates, metrics }) => {
  const inconclusiveReading = metrics.read(inconclusiveRate);
  const experimentsUnreliable = inconclusiveReading.samples >= 10 && (inconclusiveReading.value ?? 0) > 0.5;
  const rank = (lane: string) =>
    lane === tenancies.name ? 0 : lane === negotiations.name ? 1 : experimentsUnreliable ? 3 : 2;
  return [...candidates].sort((a, b) => rank(a.lane) - rank(b.lane) || a.queuedAt.getTime() - b.queuedAt.getTime());
});

export const harness = H.harness('lifecycles')
  .ledger(sqlite.ledger('./lifecycles/ledger.sqlite'))
  .pools(pool)
  .lanes(experiments, tenancies, negotiations)
  .triggers(...triggers)
  .scheduler(order)
  .grants(
    H.grant(
      claudeCode.client({ name: 'operator' }),
      H.ops.work.read,
      H.ops.work.write,
      H.ops.resolve(upsellDecision),
      H.ops.resolve(confirmWalkAway),
      H.ops.telemetry.read,
      H.ops.attempts.manage,
    ),
  )
  .observe(observers.board({ path: './lifecycles/BOARD.md' }), observers.telemetry({ path: './lifecycles/TELEMETRY.md' }));

export const running = harness.start();
