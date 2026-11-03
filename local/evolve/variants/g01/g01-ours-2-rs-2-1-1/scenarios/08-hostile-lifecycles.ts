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

const local = runners.local({ name: 'local', slots: 4 });
const subscription = H.account('claude-max', claudeCode.driver({ configDir: '~/.claude' }));
const sonnet = H.model('claude-sonnet-4-5').pricing(anthropic.pricing());
const pool = H.pool('main', [subscription]).serves(sonnet).policy(policies.soonestReset());

const experimentSchema = z.object({ name: z.string(), variantA: z.string(), variantB: z.string(), metric: z.string() });
const scheduled = H.state('scheduled').pending();
const aWins = H.state('a-wins').terminal('neutral');
const bWins = H.state('b-wins').terminal('neutral');
const inconclusive = H.state('inconclusive').terminal('neutral');
const aborted = H.state('aborted').terminal('failure');
const experiment = H.work('Experiment').schema(experimentSchema).states(scheduled, aWins, bWins, inconclusive, aborted);

const observationResult = z.object({ meanA: z.number(), meanB: z.number(), pValue: z.number() });
const twoWeekObservation = H.job('two-week-observation')
  .input(experimentSchema)
  .output(observationResult)
  .submit(async (input, ctx) => {
    await ctx.exec(['experiment', 'start', input.name, input.variantA, input.variantB]);
    return `${input.name}@${ctx.now.toISOString()}`;
  })
  .collect(async (ref, ctx) => {
    const [name, startedAt] = ref.split('@');
    const sample = await ctx.exec(['experiment', 'sample', name, '--hourly']);
    if (sample.code !== 0) return { status: 'failed', reason: sample.stderr };
    const elapsedHours = (ctx.now.getTime() - Date.parse(startedAt)) / 3_600_000;
    if (elapsedHours < 24 * 14) return { status: 'pending' };
    const concluded = await ctx.exec(['experiment', 'conclude', name, '--json']);
    return { status: 'done', output: observationResult.parse(JSON.parse(concluded.stdout)) };
  }, '1h');

const runExperiment = H.flow('run-experiment')
  .input(experimentSchema)
  .step('observe', twoWeekObservation, s => s.input)
  .when(s => s.observe.pValue < 0.05 && s.observe.meanA > s.observe.meanB, f => f.exit('a'))
  .when(s => s.observe.pValue < 0.05 && s.observe.meanB > s.observe.meanA, f => f.exit('b'))
  .exit('inconclusive');

const experiments = H.lane('experiments').of(experiment)
  .from(manual('experimenters'))
  .store(sqlite.store('./.harness/experiments.sqlite'))
  .handle(runExperiment, { exits: { a: aWins, b: bWins, inconclusive }, retry: { retries: 1, exhausted: aborted } });

export const inconclusiveRate = H.metric('experiment-inconclusive-rate', H.events.transitions(experiments, { terminal: true }))
  .rate(e => e.to === inconclusive.name)
  .window('90d');

const tenancySchema = z.object({ customer: z.string(), plan: z.string(), status: z.enum(['active', 'suspended', 'churned']) });
const reviewDue = H.state('review-due').pending();
const customer = H.state('customer').waiting();
const suspended = H.state('suspended').waiting();
const churned = H.state('churned').terminal('neutral');
const tenancy = H.work('Tenancy').schema(tenancySchema).states(reviewDue, customer, suspended, churned);

const usageReport = H.command('usage-report')
  .input(tenancySchema)
  .output(z.object({ report: z.string() }))
  .runner(local)
  .effect('repeatable')
  .run(async (input, ctx) => {
    const result = await ctx.exec(['billing', 'usage', input.customer, '--last-month']);
    return { report: result.stdout };
  });

const accountManager = H.role('account-manager').prompt('Summarise the month of usage and say whether an upsell is warranted.');
const summarizeUsage = H.skill('summarize-usage').input(z.object({ customer: z.string(), usage: z.string() })).output(z.object({ summary: z.string() }));
const usageSummarizer = H.seat('usage-summarizer').role(accountManager).skill(summarizeUsage).models(sonnet);

const upsellDecision = H.halt('upsell-decision')
  .context(z.object({ customer: z.string(), summary: z.string() }))
  .decision(z.object({ upsell: z.boolean(), note: z.string() }))
  .ask(c => `Upsell ${c.customer}?`);

const openUpsellTask = H.command('open-upsell-task')
  .input(z.object({ customer: z.string(), note: z.string() }))
  .output(z.object({ task: z.string() }))
  .runner(local)
  .effect('repeatable')
  .run(async (input, ctx) => {
    const result = await ctx.exec(['crm', 'task', 'upsert', `upsell-${input.customer}-${ctx.now.getUTCFullYear()}-${ctx.now.getUTCMonth() + 1}`, input.note]);
    return { task: result.stdout.trim() };
  });

const monthlyReview = H.flow('monthly-review')
  .input(tenancySchema)
  .step('usage', usageReport, s => s.input)
  .step('summary', usageSummarizer, s => ({ customer: s.input.customer, usage: s.usage.report }))
  .halt('upsell', upsellDecision, s => ({ customer: s.input.customer, summary: s.summary.summary }))
  .when(s => s.upsell.upsell, f => f.step('upsell-task', openUpsellTask, s => ({ customer: s.input.customer, note: s.upsell.note })))
  .exit('reviewed');

const crmBody = z.object({ customerId: z.string(), plan: z.string(), status: z.enum(['active', 'suspended', 'churned']) });

const tenancies = H.lane('tenancies').of(tenancy)
  .from(http.webhook({
    name: 'crm-customers',
    path: '/crm/customers',
    port: H.slot.port(0),
    secret: H.env('CRM_WEBHOOK_SECRET'),
    body: crmBody,
    key: b => b.customerId,
    data: b => ({ customer: b.customerId, plan: b.plan, status: b.status }),
  }))
  .store(sqlite.store('./.harness/tenancies.sqlite'))
  .handle(monthlyReview, { exits: { reviewed: customer }, retry: { retries: 2, backoff: { initial: '1h', factor: 2 }, exhausted: customer } });

const replySchema = z.object({ kind: z.enum(['counter', 'accept', 'walk-away']), text: z.string() });
const negotiationSchema = z.object({ vendor: z.string(), item: z.string(), deadline: z.string(), lastReply: replySchema.nullable() });
type Negotiation = z.output<typeof negotiationSchema>;

const drafting = H.state('drafting').pending();
const awaitingVendor = H.state('awaiting-vendor').waiting();
const agreed = H.state('agreed').terminal('success');
const walkedAway = H.state('walked-away').terminal('neutral');
const vendorWalkedAway = H.state('vendor-walked-away').terminal('failure');
const expired = H.state('expired').terminal('failure');
const stalled = H.state('stalled').terminal('failure');
const negotiation = H.work('Negotiation').schema(negotiationSchema).states(drafting, awaitingVendor, agreed, walkedAway, vendorWalkedAway, expired, stalled);

const negotiatorRole = H.role('negotiator').prompt('Draft the next move: a counter-offer, an acceptance, or a walk-away.');
const nextMove = H.skill('next-move')
  .input(z.object({ vendor: z.string(), item: z.string(), lastReply: z.string() }))
  .output(z.object({ action: z.enum(['offer', 'accept', 'walk-away']), message: z.string() }));
const negotiator = H.seat('negotiator').role(negotiatorRole).skill(nextMove).models(sonnet);

const sendToVendor = H.command('send-to-vendor')
  .input(z.object({ vendor: z.string(), message: z.string() }))
  .output(z.object({ messageId: z.string() }))
  .runner(local)
  .effect('unrepeatable')
  .detect(async (input, ctx) => {
    const sent = await ctx.exec(['procurement', 'sent', input.vendor, '--attempt', ctx.attempt]);
    const id = sent.stdout.trim();
    return id === '' ? undefined : { messageId: id };
  })
  .run(async (input, ctx) => {
    const result = await ctx.exec(['procurement', 'send', input.vendor, '--attempt', ctx.attempt], { stdin: input.message });
    return { messageId: result.stdout.trim() };
  });

const negotiationRound = H.flow('negotiation-round')
  .input(negotiationSchema)
  .step('move', negotiator, s => ({ vendor: s.input.vendor, item: s.input.item, lastReply: s.input.lastReply?.text ?? 'no reply yet' }))
  .when(s => s.move.action === 'walk-away', f => f.step('notify', sendToVendor, s => ({ vendor: s.input.vendor, message: s.move.message })).exit('walked-away'))
  .step('send', sendToVendor, s => ({ vendor: s.input.vendor, message: s.move.message }))
  .when(s => s.move.action === 'accept', f => f.exit('agreed'))
  .exit('offered');

const vendorReply = z.object({ negotiationId: z.string(), kind: z.enum(['counter', 'accept', 'walk-away']), text: z.string() });

const negotiations = H.lane('negotiations').of(negotiation)
  .from(
    manual('procurement'),
    http.webhook({
      name: 'vendor-replies',
      path: '/vendor/replies',
      port: H.slot.port(1),
      secret: H.env('VENDOR_WEBHOOK_SECRET'),
      body: vendorReply,
      key: b => b.negotiationId,
      mode: 'update',
      data: (b, current: Negotiation) => ({ ...current, lastReply: { kind: b.kind, text: b.text } }),
    }),
  )
  .store(sqlite.store('./.harness/negotiations.sqlite'))
  .handle(negotiationRound, {
    exits: { 'walked-away': walkedAway, agreed, offered: awaitingVendor },
    retry: { retries: 2, backoff: { initial: '10m', factor: 3 }, exhausted: stalled },
  });

const vendorReplies = H.events.updates(negotiations);

const triggers = [
  H.trigger('monthly-tenancy-review').on(H.time.every('0 6 1 * *')).do(tenancies.move({ state: customer }, reviewDue)),
  H.trigger('tenancy-suspended').on(H.events.updates(tenancies).where(e => e.unit.data.status === 'suspended')).do(tenancies.move(e => e.unit.key, suspended)),
  H.trigger('tenancy-reinstated').on(H.events.updates(tenancies).where(e => e.unit.data.status === 'active' && e.previous.status === 'suspended')).do(tenancies.move(e => e.unit.key, customer)),
  H.trigger('tenancy-churned').on(H.events.updates(tenancies).where(e => e.unit.data.status === 'churned')).do(tenancies.move(e => e.unit.key, churned)),
  H.trigger('vendor-countered').on(vendorReplies.where(e => e.unit.data.lastReply?.kind === 'counter')).do(negotiations.move(e => e.unit.key, drafting)),
  H.trigger('vendor-accepted').on(vendorReplies.where(e => e.unit.data.lastReply?.kind === 'accept')).do(negotiations.move(e => e.unit.key, agreed)),
  H.trigger('vendor-walked-away').on(vendorReplies.where(e => e.unit.data.lastReply?.kind === 'walk-away')).do(negotiations.move(e => e.unit.key, vendorWalkedAway)),
  H.trigger('negotiation-expired').on(H.time.at(negotiations, d => new Date(d.deadline))).do(negotiations.move(e => e.unit.key, expired)),
];

const scheduling = H.policy.units('rounds-then-reviews-then-experiments', choice => {
  const share = choice.metrics.read(inconclusiveRate);
  const experimentsLast = share.samples >= 10 && (share.value ?? 0) > 0.5;
  const rank = (lane: string) => (lane === negotiations.name ? 0 : lane === tenancies.name ? 1 : experimentsLast ? 3 : 2);
  return [...choice.candidates].sort((a, b) => rank(a.lane) - rank(b.lane) || a.queuedAt.getTime() - b.queuedAt.getTime());
});

const supervisor = claudeCode.client({ name: 'operator' });

export const harness = H.harness('long-lived-work')
  .ledger(sqlite.ledger('./.harness/ledger.sqlite'))
  .pools(pool)
  .lanes(experiments, tenancies, negotiations)
  .triggers(...triggers)
  .scheduler(scheduling)
  .grants(H.grant(supervisor, H.ops.resolve(upsellDecision), H.ops.work.read, H.ops.work.write, H.ops.attempts.manage, H.ops.telemetry.read))
  .observe(observers.board({ path: './BOARD.md' }), observers.telemetry({ path: './TELEMETRY.md' }));
