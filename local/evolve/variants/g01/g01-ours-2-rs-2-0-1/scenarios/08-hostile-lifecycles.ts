import { z } from 'zod';
import { H } from 'harness-dsl';
import type { Candidate } from 'harness-dsl/kernel';
import { anthropic } from 'harness-dsl/anthropic';
import { sqlite } from 'harness-dsl/sqlite';
import { http } from 'harness-dsl/http';
import { supply } from 'harness-dsl/supply';
import { observers } from 'harness-dsl/observers';

const local = H.runner.local('local', { slots: 4 });
const api = H.account('anthropic-api', anthropic.api({ apiKey: H.env('ANTHROPIC_API_KEY') }));
const sonnet = H.model('claude-sonnet-4-5').pricing(anthropic.pricing());

const queued = H.state('queued').pending();
const running = H.state('running').active();

const twoWeeksMs = 14 * 24 * 3600 * 1000;

const observing = H.state('observing').waiting();
const aWins = H.state('a-wins').terminal('success');
const bWins = H.state('b-wins').terminal('success');
const inconclusive = H.state('inconclusive').terminal('neutral');
const experimentAborted = H.state('experiment-aborted').terminal('failure');

const experimentSchema = z.object({ name: z.string(), variantA: z.string(), variantB: z.string(), metric: z.string() });
type ExperimentData = z.infer<typeof experimentSchema>;
const experiment = H.work('experiment').schema(experimentSchema).states(queued, running, observing, aWins, bWins, inconclusive, experimentAborted);

const measureExperiment = H.command('measure-experiment')
  .input(z.object({ name: z.string(), metric: z.string() }))
  .output(z.object({ a: z.number(), b: z.number() }))
  .runner(local)
  .run(async (input, ctx) => {
    const result = await ctx.sh(`./scripts/measure.sh ${input.name} ${input.metric}`);
    if (result.code === 0) return z.object({ a: z.number(), b: z.number() }).parse(JSON.parse(result.stdout));
    throw new Error(result.stderr);
  });

const decideExperiment = H.command('decide-experiment')
  .input(z.object({ name: z.string() }))
  .output(z.object({ winner: z.enum(['a', 'b', 'none']) }))
  .runner(local)
  .run(async (input, ctx) => {
    const result = await ctx.sh(`./scripts/significance.sh ${input.name}`);
    if (result.code === 0) return z.object({ winner: z.enum(['a', 'b', 'none']) }).parse(JSON.parse(result.stdout));
    throw new Error(result.stderr);
  });

const experimentTick = H.flow('experiment-tick')
  .input(experimentSchema.extend({ startedAt: z.date() }))
  .step('measure', measureExperiment, s => ({ name: s.input.name, metric: s.input.metric }))
  .when(s => s.now.getTime() - s.input.startedAt.getTime() >= twoWeeksMs, f => f
    .step('decide', decideExperiment, s => ({ name: s.input.name }))
    .exit(s => (s.steps.decide.winner === 'a' ? 'aWins' : s.steps.decide.winner === 'b' ? 'bWins' : 'inconclusive')))
  .exit('observing');

const experiments = H.lane('experiments')
  .of(experiment)
  .from(
    supply.manual<ExperimentData>().key(d => d.name),
    supply.schedule<ExperimentData>({
      cron: '0 * * * *',
      units: (_now, _ctx, known) => known.filter(u => u.state === observing).map(u => u.data),
    }).key(d => d.name).updatesOnly(),
  )
  .store(sqlite.store('./ops/.harness/units.sqlite'))
  .handle(experimentTick, u => ({ ...u.data, startedAt: u.createdAt }))
  .exits({
    observing,
    aWins,
    bWins,
    inconclusive,
    failed: { tries: 3, backoff: 'exponential', delaySeconds: 300, then: experimentAborted },
  });

const customer = H.state('customer').waiting();
const suspended = H.state('suspended').waiting();
const churned = H.state('churned').terminal('neutral');

const tenancySchema = z.object({ tenant: z.string(), plan: z.string(), status: z.enum(['active', 'churned']) });
type TenancyData = z.infer<typeof tenancySchema>;
const tenancy = H.work('tenancy').schema(tenancySchema).states(queued, running, customer, suspended, churned);

const usageReview = H.command('usage-review')
  .input(z.object({ tenant: z.string() }))
  .output(z.object({ seats: z.number(), activeUsers: z.number(), spendUsd: z.number() }))
  .runner(local)
  .run(async (input, ctx) => {
    const result = await ctx.sh(`./scripts/usage.sh ${input.tenant}`);
    if (result.code === 0) return z.object({ seats: z.number(), activeUsers: z.number(), spendUsd: z.number() }).parse(JSON.parse(result.stdout));
    throw new Error(result.stderr);
  });

const sendUpsell = H.command('send-upsell')
  .input(z.object({ tenant: z.string(), plan: z.string() }))
  .runner(local)
  .effect('unrepeatable')
  .run(async (input, ctx) => {
    const result = await ctx.sh(`./scripts/upsell.sh ${input.tenant} ${input.plan}`);
    if (result.code === 0) return;
    throw new Error(result.stderr);
  });

const analystRole = H.role('account-analyst').prompt('You summarise a tenancy month for an account manager.').intents(['read']);
const analyst = H.seat('account-analyst').role(analystRole).models(sonnet);

const summarizeTenancy = H.skill('summarize-tenancy')
  .input(z.object({ tenant: z.string(), plan: z.string(), seats: z.number(), activeUsers: z.number(), spendUsd: z.number() }))
  .output(z.object({ summary: z.string() }))
  .prompt(i => `Tenant ${i.tenant} on ${i.plan}: ${i.activeUsers}/${i.seats} active seats, $${i.spendUsd} spent this month.`);

const upsellDecision = H.halt('upsell-decision')
  .context(z.object({ tenant: z.string(), summary: z.string() }))
  .ask(c => `Upsell ${c.tenant}?\n\n${c.summary}`)
  .decision(z.object({ upsell: z.boolean(), plan: z.string().optional() }));

const tenancyReview = H.flow('tenancy-review')
  .input(tenancySchema)
  .when(s => s.input.status === 'churned', f => f.exit('churned'))
  .step('usage', usageReview, s => ({ tenant: s.input.tenant }))
  .step('summary', analyst.call(summarizeTenancy), s => ({ tenant: s.input.tenant, plan: s.input.plan, ...s.steps.usage }))
  .halt('upsell', upsellDecision, s => ({ tenant: s.input.tenant, summary: s.steps.summary.summary }))
  .when(s => s.steps.upsell.upsell, f => f
    .step('offer', sendUpsell, s => ({ tenant: s.input.tenant, plan: s.steps.upsell.plan ?? s.input.plan })))
  .exit('customer');

const tenancies = H.lane('tenancies')
  .of(tenancy)
  .from(
    supply.manual<TenancyData>().key(d => d.tenant),
    supply.schedule<TenancyData>({
      cron: '0 9 1 * *',
      units: (_now, _ctx, known) => known.filter(u => u.state === customer).map(u => u.data),
    }).key(d => d.tenant).updatesOnly(),
    http.webhook({
      path: '/billing/churn',
      schema: z.object({ tenant: z.string(), status: z.literal('churned') }),
      secret: H.env('BILLING_WEBHOOK_SECRET'),
    }).key(d => d.tenant).updatesOnly(),
  )
  .store(sqlite.store('./ops/.harness/units.sqlite'))
  .handle(tenancyReview)
  .exits({
    churned,
    customer,
    failed: { tries: 2, backoff: 'linear', delaySeconds: 3600, then: customer },
  });

const awaitingVendor = H.state('awaiting-vendor').waiting();
const stalled = H.state('stalled').waiting();
const agreed = H.state('agreed').terminal('success');
const weWalkedAway = H.state('we-walked-away').terminal('neutral');
const theyWalkedAway = H.state('they-walked-away').terminal('failure');
const expired = H.state('expired').terminal('failure');

const negotiationSchema = z.object({
  negotiation: z.string(),
  vendor: z.string(),
  item: z.string(),
  targetUsd: z.number(),
  expiresAt: z.coerce.date(),
  vendorStatus: z.enum(['none', 'countered', 'accepted', 'withdrawn']),
  lastReply: z.string(),
});
type NegotiationData = z.infer<typeof negotiationSchema>;
const negotiation = H.work('negotiation').schema(negotiationSchema)
  .states(queued, running, awaitingVendor, stalled, agreed, weWalkedAway, theyWalkedAway, expired);

const negotiatorRole = H.role('negotiator').promptFile('./prompts/negotiator.md').intents(['read']);
const negotiator = H.seat('negotiator').role(negotiatorRole).models(sonnet);

const draftOffer = H.skill('draft-offer')
  .input(z.object({ vendor: z.string(), item: z.string(), targetUsd: z.number(), lastReply: z.string() }))
  .output(z.object({ action: z.enum(['offer', 'walkAway']), offerUsd: z.number(), message: z.string() }))
  .prompt(i => `Vendor ${i.vendor} on ${i.item}, target $${i.targetUsd}. Their last message:\n${i.lastReply}`);

const vendorMessage = (name: string) => H.command(name)
  .input(z.object({ negotiation: z.string(), message: z.string() }))
  .runner(local)
  .effect('unrepeatable')
  .run(async (input, ctx) => {
    const result = await ctx.sh(`./scripts/vendor-mail.sh ${input.negotiation}`, { stdin: input.message });
    if (result.code === 0) return;
    throw new Error(result.stderr);
  });

const sendOffer = vendorMessage('send-offer');
const sendWithdrawal = vendorMessage('send-withdrawal');
const confirmAgreement = vendorMessage('confirm-agreement');

const negotiationRound = H.flow('negotiation-round')
  .input(negotiationSchema)
  .when(s => s.input.vendorStatus === 'accepted', f => f
    .step('confirm', confirmAgreement, s => ({ negotiation: s.input.negotiation, message: 'We confirm the agreement.' }))
    .exit('agreed'))
  .when(s => s.input.vendorStatus === 'withdrawn', f => f.exit('theyWalkedAway'))
  .step('draft', negotiator.call(draftOffer), s => ({
    vendor: s.input.vendor, item: s.input.item, targetUsd: s.input.targetUsd, lastReply: s.input.lastReply,
  }))
  .when(s => s.steps.draft.action === 'walkAway', f => f
    .step('withdraw', sendWithdrawal, s => ({ negotiation: s.input.negotiation, message: s.steps.draft.message }))
    .exit('weWalkedAway'))
  .step('send', sendOffer, s => ({ negotiation: s.input.negotiation, message: s.steps.draft.message }))
  .exit('awaitingVendor');

const negotiations = H.lane('negotiations')
  .of(negotiation)
  .from(
    supply.manual<NegotiationData>().key(d => d.negotiation),
    http.webhook({
      path: '/vendor-replies',
      schema: z.object({
        negotiation: z.string(),
        vendorStatus: z.enum(['countered', 'accepted', 'withdrawn']),
        lastReply: z.string(),
      }),
      secret: H.env('VENDOR_WEBHOOK_SECRET'),
    }).key(d => d.negotiation).updatesOnly(),
  )
  .store(sqlite.store('./ops/.harness/units.sqlite'))
  .handle(negotiationRound)
  .exits({
    agreed,
    theyWalkedAway,
    weWalkedAway,
    awaitingVendor,
    failed: { tries: 2, backoff: 'exponential', delaySeconds: 600, then: stalled },
  })
  .deadline(u => u.data.expiresAt);

const negotiationExpiry = H.trigger('negotiation-expiry').on(negotiations.overdue()).do(negotiations.move(expired));

const inconclusiveRate = H.metric('experiments-inconclusive-rate').rate(H.events.entered(inconclusive), H.events.terminal());

const laneOrder = [negotiations, tenancies, experiments];

const schedule = H.policy.schedule('rounds-before-reviews-before-ticks', input => {
  const reading = input.metrics.read(inconclusiveRate, { window: '90d', where: { kind: experiment } });
  const holdNewExperiments = reading.samples >= 10 && (reading.value ?? 0) > 0.5;
  const isNewExperiment = (c: Candidate) => c.lane === experiments && c.unit.createdAt.getTime() === c.unit.updatedAt.getTime();
  const rank = (c: Candidate) => laneOrder.findIndex(l => l === c.lane);
  return input.candidates
    .filter(c => (holdNewExperiments ? isNewExperiment(c) === false : true))
    .slice()
    .sort((a, b) => rank(a) - rank(b) || b.waitingSeconds - a.waitingSeconds);
});

const operator = http.client('operator', { port: 8720, token: H.env('OPERATOR_TOKEN') });

export const harness = H.harness('lifecycles')
  .ledger(sqlite.ledger('./ops/.harness/ledger.sqlite'))
  .pools(H.pool('api', [api]).serves(sonnet))
  .lanes(experiments, tenancies, negotiations)
  .triggers(negotiationExpiry)
  .scheduler(H.scheduler().policy(schedule))
  .grants(H.grant(operator, H.ops.work.read, H.ops.work.write, H.ops.resolve(upsellDecision), H.ops.telemetry.read))
  .metrics(inconclusiveRate)
  .observe(observers.board({ path: './ops/BOARD.md' }), observers.telemetry({ path: './ops/TELEMETRY.md' }));
