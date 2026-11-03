import { z } from 'zod';
import { H } from 'harness-dsl';
import { anthropic } from 'harness-dsl/anthropic';
import { claudeCode } from 'harness-dsl/claude-code';
import { sqlite } from 'harness-dsl/sqlite';
import { http } from 'harness-dsl/http';
import { manual } from 'harness-dsl/supply';
import { policies } from 'harness-dsl/policies';
import { observers } from 'harness-dsl/observers';

const store = './.harness/units.sqlite';
const api = H.account('anthropic-api', anthropic.api({ apiKey: H.env('ANTHROPIC_API_KEY') }));
const haiku = H.model('claude-haiku-4-5').pricing(anthropic.pricing());
const sonnet = H.model('claude-sonnet-4-5').pricing(anthropic.pricing());

const experimentSchema = z.object({ name: z.string(), metricQuery: z.string() });
const scheduledExperiment = H.state('scheduled').pending();
const aWins = H.state('a-wins').terminal('neutral');
const bWins = H.state('b-wins').terminal('neutral');
const inconclusive = H.state('inconclusive').terminal('neutral');
const experimentAbandoned = H.state('experiment-abandoned').terminal('failure');
const experiment = H.work('Experiment').schema(experimentSchema).states(scheduledExperiment, aWins, bWins, inconclusive, experimentAbandoned);

const measurement = z.object({ status: z.enum(['running', 'A', 'B', 'inconclusive']), samples: z.number() });

const twoWeekRun = H.job('two-week-run')
  .input(z.object({ name: z.string(), metricQuery: z.string() }))
  .output(z.object({ winner: z.enum(['A', 'B', 'inconclusive']), samples: z.number() }))
  .submit(async (input, ctx) => {
    const started = await ctx.exec(['experiments', 'start', input.name, '--duration', '14d', '--metric', input.metricQuery]);
    return started.stdout.trim();
  })
  .collect(async (ref, ctx) => {
    const measured = await ctx.exec(['experiments', 'measure', ref, '--json']);
    if (measured.code !== 0) return { status: 'failed', reason: measured.stderr };
    const m = measurement.parse(JSON.parse(measured.stdout));
    if (m.status === 'running') return { status: 'pending' };
    return { status: 'done', output: { winner: m.status, samples: m.samples } };
  })
  .every('1h');

const experimentFlow = H.flow('experiment')
  .input(experimentSchema)
  .step('run', twoWeekRun, s => ({ name: s.input.name, metricQuery: s.input.metricQuery }))
  .when(s => s.run.winner === 'A', f => f.exit('aWins'))
  .when(s => s.run.winner === 'B', f => f.exit('bWins'))
  .exit('inconclusive');

const experiments = H.lane('experiments')
  .of(experiment)
  .from(manual('operator-experiments'))
  .store(sqlite.store(store))
  .handle(experimentFlow, {
    exits: { aWins, bWins, inconclusive },
    retry: { retries: 1, backoff: { initial: '1h', factor: 2 }, exhausted: experimentAbandoned },
  });

const inconclusiveShare = H.metric('experiments-inconclusive', H.events.transitions(experiments, { terminal: true }))
  .rate(e => e.to === inconclusive.name)
  .window('365d');

const tenancySchema = z.object({
  customer: z.string(),
  plan: z.string(),
  billing: z.enum(['paid', 'overdue']),
  churned: z.boolean(),
});
const reviewDue = H.state('review-due').pending();
const current = H.state('current').waiting();
const suspended = H.state('suspended').waiting();
const reviewFailed = H.state('review-failed').waiting();
const churned = H.state('churned').terminal('neutral');
const tenancy = H.work('Tenancy').schema(tenancySchema).states(reviewDue, current, suspended, reviewFailed, churned);

const usageReview = H.command('usage-review')
  .input(z.object({ customer: z.string() }))
  .output(z.object({ usage: z.string() }))
  .run(async (input, ctx) => {
    const report = await ctx.exec(['billing', 'usage', input.customer, '--last', '30d']);
    return { usage: report.stdout };
  });
const accountManager = H.role('account-manager').promptFile('./prompts/account-manager.md');
const summarizeTenancy = H.skill('summarize-tenancy')
  .input(z.object({ customer: z.string(), plan: z.string(), usage: z.string() }))
  .output(z.object({ summary: z.string() }))
  .prompt(i => `Customer ${i.customer} on ${i.plan}. Usage:\n${i.usage}\nSummarize for an upsell decision.`);
const tenancySummarizer = H.seat('tenancy-summarizer').role(accountManager).skill(summarizeTenancy).models(sonnet);
const upsellDecision = H.halt('upsell-decision')
  .context(z.object({ customer: z.string(), summary: z.string() }))
  .decision(z.object({ action: z.enum(['upsell', 'keep']) }));
const proposeUpsell = H.command('propose-upsell')
  .input(z.object({ customer: z.string(), plan: z.string() }))
  .output(z.object({ proposal: z.string() }))
  .effect('unrepeatable')
  .run(async (input, ctx) => {
    const created = await ctx.exec(['crm', 'propose-upsell', input.customer, input.plan]);
    return { proposal: created.stdout.trim() };
  });

const tenancyReview = H.flow('tenancy-review')
  .input(tenancySchema)
  .step('usage', usageReview, s => ({ customer: s.input.customer }))
  .step('summary', tenancySummarizer, s => ({ customer: s.input.customer, plan: s.input.plan, usage: s.usage.usage }))
  .halt('decision', upsellDecision, s => ({ customer: s.input.customer, summary: s.summary.summary }))
  .when(s => s.decision.action === 'upsell', f => f.step('upsell', proposeUpsell, s => ({ customer: s.input.customer, plan: s.input.plan })))
  .exit('reviewed');

const billingFeed = http.webhook({
  name: 'billing-feed',
  path: '/billing',
  port: H.slot.port(0),
  secret: H.env('BILLING_SECRET'),
  body: tenancySchema.extend({ tenancyId: z.string() }),
  key: b => b.tenancyId,
  data: b => ({ customer: b.customer, plan: b.plan, billing: b.billing, churned: b.churned }),
  mode: 'upsert',
});

const tenancies = H.lane('tenancies')
  .of(tenancy)
  .from(billingFeed)
  .store(sqlite.store(store))
  .handle(tenancyReview, {
    exits: { reviewed: current },
    retry: { retries: 2, backoff: { initial: '1h', factor: 2 }, exhausted: reviewFailed },
  });

const negotiationSchema = z.object({
  vendor: z.string(),
  item: z.string(),
  targetUsd: z.number(),
  expiresAt: z.string(),
  vendorMessage: z.string(),
  vendorStatus: z.enum(['opened', 'countered', 'accepted', 'walkedAway']),
});
const ourTurn = H.state('our-turn').pending();
const theirTurn = H.state('their-turn').waiting();
const agreed = H.state('agreed').terminal('success');
const weWalkedAway = H.state('we-walked-away').terminal('neutral');
const theyWalkedAway = H.state('they-walked-away').terminal('failure');
const expired = H.state('expired').terminal('failure');
const negotiationAbandoned = H.state('negotiation-abandoned').terminal('failure');
const negotiation = H.work('Negotiation').schema(negotiationSchema).states(ourTurn, theirTurn, agreed, weWalkedAway, theyWalkedAway, expired, negotiationAbandoned);

const negotiator = H.role('negotiator').promptFile('./prompts/negotiator.md');
const nextOffer = H.skill('next-offer')
  .input(z.object({ vendor: z.string(), item: z.string(), targetUsd: z.number(), vendorMessage: z.string() }))
  .output(z.object({ action: z.enum(['offer', 'walkAway']), offerUsd: z.number(), message: z.string() }))
  .prompt(i => `Vendor ${i.vendor} on ${i.item} (target $${i.targetUsd}) said:\n${i.vendorMessage}\nDraft our next move.`);
const negotiatorSeat = H.seat('negotiator').role(negotiator).skill(nextOffer).models(sonnet);
const sendOffer = H.command('send-offer')
  .input(z.object({ vendor: z.string(), offerUsd: z.number(), message: z.string() }))
  .output(z.object({ messageId: z.string() }))
  .effect('unrepeatable')
  .run(async (input, ctx) => {
    const sent = await ctx.exec(['procurement', 'send', input.vendor, String(input.offerUsd)], { stdin: input.message });
    return { messageId: sent.stdout.trim() };
  });

const negotiationRound = H.flow('negotiation-round')
  .input(negotiationSchema)
  .step('draft', negotiatorSeat, s => ({ vendor: s.input.vendor, item: s.input.item, targetUsd: s.input.targetUsd, vendorMessage: s.input.vendorMessage }))
  .when(s => s.draft.action === 'walkAway', f => f.exit('walkedAway'))
  .step('send', sendOffer, s => ({ vendor: s.input.vendor, offerUsd: s.draft.offerUsd, message: s.draft.message }))
  .exit('offered');

const vendorReplies = http.webhook({
  name: 'vendor-replies',
  path: '/vendor-replies',
  port: H.slot.port(0),
  secret: H.env('VENDOR_PORTAL_SECRET'),
  body: negotiationSchema.extend({ negotiationId: z.string() }),
  key: b => b.negotiationId,
  data: b => ({ vendor: b.vendor, item: b.item, targetUsd: b.targetUsd, expiresAt: b.expiresAt, vendorMessage: b.vendorMessage, vendorStatus: b.vendorStatus }),
  mode: 'update',
});

const negotiations = H.lane('negotiations')
  .of(negotiation)
  .from(manual('procurement-desk'), vendorReplies)
  .store(sqlite.store(store))
  .handle(negotiationRound, {
    exits: { offered: theirTurn, walkedAway: weWalkedAway },
    retry: { retries: 2, backoff: { initial: '10m', factor: 2 }, exhausted: negotiationAbandoned },
  })
  .wip(3);

const tenancyUpdates = H.events.updates(tenancies);
const vendorUpdates = H.events.updates(negotiations).where(e => e.unit.state === theirTurn.name);

const triggers = [
  H.trigger('monthly-tenancy-review')
    .on(H.time.every('0 9 1 * *'))
    .do(tenancies.move({ state: current }, reviewDue), tenancies.move({ state: reviewFailed }, reviewDue)),
  H.trigger('suspend-overdue-tenancy')
    .on(tenancyUpdates.where(e => e.unit.data.billing === 'overdue' && e.previous.billing === 'paid' && !e.unit.data.churned))
    .do(tenancies.move(e => e.unit.key, suspended)),
  H.trigger('reinstate-paid-tenancy')
    .on(tenancyUpdates.where(e => e.unit.data.billing === 'paid' && e.previous.billing === 'overdue' && e.unit.state === suspended.name))
    .do(tenancies.move(e => e.unit.key, current)),
  H.trigger('tenancy-churn')
    .on(tenancyUpdates.where(e => e.unit.data.churned))
    .do(tenancies.cancel(e => e.unit.key, churned)),
  H.trigger('vendor-countered')
    .on(vendorUpdates.where(e => e.unit.data.vendorStatus === 'countered'))
    .do(negotiations.move(e => e.unit.key, ourTurn)),
  H.trigger('vendor-accepted')
    .on(vendorUpdates.where(e => e.unit.data.vendorStatus === 'accepted'))
    .do(negotiations.move(e => e.unit.key, agreed)),
  H.trigger('vendor-walked-away')
    .on(vendorUpdates.where(e => e.unit.data.vendorStatus === 'walkedAway'))
    .do(negotiations.move(e => e.unit.key, theyWalkedAway)),
  H.trigger('negotiation-expiry')
    .on(H.time.at(negotiations, d => new Date(d.expiresAt)))
    .do(negotiations.cancel(e => e.unit.key, expired)),
];

const lifecycleOrder = H.policy.units('lifecycle-order', c => {
  const inconclusiveReading = c.metrics.read(inconclusiveShare);
  const experimentsLast = inconclusiveReading.samples >= 10 && (inconclusiveReading.value ?? 0) > 0.5;
  const waitingExperiments = c.candidates.filter(experiments.holds);
  const others = c.candidates.filter(x => !experiments.holds(x));
  return experimentsLast ? [...others, ...waitingExperiments] : [...waitingExperiments, ...others];
});

const pool = H.pool('api', [api]).serves(haiku, sonnet).policy(policies.soonestReset());

export const lifecycles = H.harness('lifecycles')
  .ledger(sqlite.ledger('./.harness/ledger.sqlite'))
  .pools(pool)
  .lanes(experiments, tenancies, negotiations)
  .triggers(...triggers)
  .scheduler(lifecycleOrder)
  .grants(H.grant(claudeCode.client({ name: 'owner' }), H.ops.work.read, H.ops.work.write, H.ops.resolve(upsellDecision), H.ops.telemetry.read, H.ops.attempts.manage))
  .observe(observers.board({ path: './BOARD.md' }), observers.telemetry({ path: './TELEMETRY.md' }));
