import { z } from 'zod';
import { H } from 'harness-dsl';
import { anthropic } from 'harness-dsl/anthropic';
import { sqlite } from 'harness-dsl/sqlite';
import { http } from 'harness-dsl/http';
import { supply } from 'harness-dsl/supply';
import { observers } from 'harness-dsl/observers';

const local = H.runner.local('worker', { slots: 4 });
const unitStore = sqlite.store('.harness/units.db');

const apiAccount = H.account('anthropic-api', anthropic.api({ apiKey: H.env('ANTHROPIC_API_KEY') }));
const sonnet = H.model('claude-sonnet-4-5').pricing(anthropic.pricing());
const pool = H.pool('api', [apiAccount]).serves(sonnet);

const proposed = H.state('proposed').pending();
const observing = H.state('observing').active();
const aWins = H.state('a-wins').terminal('success');
const bWins = H.state('b-wins').terminal('success');
const inconclusive = H.state('inconclusive').terminal('neutral');
const abandoned = H.state('abandoned').terminal('failure');

const experimentSchema = z.object({ experimentId: z.string(), variantA: z.string(), variantB: z.string(), metric: z.string() });
const experiment = H.work('experiment').schema(experimentSchema).states(proposed, observing, aWins, bWins, inconclusive, abandoned);

const winnerOf = (text: string): 'a' | 'b' | 'none' => {
  const winner = text.trim();
  return winner === 'a' || winner === 'b' ? winner : 'none';
};

const twoWeekObservation = H.job('two-week-observation')
  .input(experimentSchema)
  .output(z.object({ winner: z.enum(['a', 'b', 'none']) }))
  .submit(async (i, ctx) => {
    const started = await ctx.sh(`experiments start ${i.experimentId} --a ${i.variantA} --b ${i.variantB} --days 14`);
    if (started.code !== 0) throw new Error(started.stderr);
    return i.experimentId;
  })
  .collect(async (ref, ctx) => {
    const sample = await ctx.sh(`experiments sample ${ref}`);
    if (sample.code !== 0) return { status: 'failed', reason: sample.stderr };
    const verdict = await ctx.sh(`experiments verdict ${ref}`);
    if (verdict.stdout.trim() === 'running') return { status: 'running' };
    return { status: 'done', output: { winner: winnerOf(verdict.stdout) } };
  })
  .poll('1h');

const runExperiment = H.flow('run-experiment')
  .input(experimentSchema)
  .step('observation', twoWeekObservation)
  .exit(s =>
    s.steps.observation.winner === 'a' ? 'a-wins' : s.steps.observation.winner === 'b' ? 'b-wins' : 'inconclusive',
  );

const experiments = H.lane('experiments')
  .of(experiment)
  .from(supply.manual(experimentSchema))
  .store(unitStore)
  .handle(runExperiment, {
    exits: { 'a-wins': aWins, 'b-wins': bWins, inconclusive },
    retry: { tries: 2, backoff: 'exponential', delaySeconds: 600, exhausted: abandoned },
  });

const reviewDue = H.state('review-due').pending();
const reviewing = H.state('reviewing').active();
const customer = H.state('customer').waiting();
const suspended = H.state('suspended').waiting();
const reviewStalled = H.state('review-stalled').waiting();
const churned = H.state('churned').terminal('neutral');

const tenancySchema = z.object({ tenantId: z.string(), plan: z.string() });
const tenancy = H.work('tenancy').schema(tenancySchema).states(reviewDue, reviewing, customer, suspended, reviewStalled, churned);

const usageReview = H.command('usage-review')
  .input(tenancySchema)
  .output(z.object({ seats: z.number(), monthlyUsd: z.number(), trend: z.string() }))
  .runner(local)
  .run(async (i, ctx) => {
    const result = await ctx.sh(`billing usage ${i.tenantId} --json`);
    const usage = z.object({ seats: z.number(), monthlyUsd: z.number(), trend: z.string() }).parse(JSON.parse(result.stdout));
    return usage;
  });

const offerUpsell = H.command('offer-upsell')
  .input(z.object({ tenantId: z.string(), note: z.string() }))
  .runner(local)
  .effect('unrepeatable')
  .run(async (i, ctx) => {
    const result = await ctx.sh(`crm upsell ${i.tenantId}`, { stdin: i.note });
    if (result.code !== 0) throw new Error(result.stderr);
  });

const summarizerRole = H.role('account-summarizer').prompt('Summarize a tenancy month for an account manager.');
const summarizeUsage = H.skill('summarize-usage')
  .input(z.object({ tenantId: z.string(), plan: z.string(), seats: z.number(), monthlyUsd: z.number(), trend: z.string() }))
  .output(z.object({ text: z.string() }))
  .prompt(i => `Tenant ${i.tenantId} on ${i.plan}: ${i.seats} seats, $${i.monthlyUsd}/month, trend ${i.trend}.`);
const summarizer = H.seat('account-summarizer').role(summarizerRole).models(sonnet);

const upsell = H.halt('upsell')
  .context(z.object({ tenantId: z.string(), summary: z.string() }))
  .ask(c => `Offer ${c.tenantId} an upsell?\n${c.summary}`)
  .decision(z.object({ upsell: z.boolean(), note: z.string() }));

const monthlyReview = H.flow('monthly-review')
  .input(tenancySchema)
  .step('usage', usageReview)
  .step('summary', summarizer.call(summarizeUsage), s => ({ ...s.input, ...s.steps.usage }))
  .halt('decision', upsell, s => ({ tenantId: s.input.tenantId, summary: s.steps.summary.text }))
  .when(
    s => s.steps.decision.upsell,
    f => f.step('offer', offerUpsell, s => ({ tenantId: s.input.tenantId, note: s.steps.decision.note })),
  )
  .exit('reviewed');

const tenancies = H.lane('tenancies')
  .of(tenancy)
  .from(supply.manual(tenancySchema))
  .store(unitStore)
  .deadline(unit =>
    unit.state === customer.name ? new Date(unit.updatedAt.getFullYear(), unit.updatedAt.getMonth() + 1, 1) : undefined,
  )
  .handle(monthlyReview, {
    exits: { reviewed: customer },
    retry: { tries: 3, backoff: 'exponential', delaySeconds: 3600, exhausted: reviewStalled },
  });

const roundDue = H.state('round-due').pending();
const drafting = H.state('drafting').active();
const awaitingVendor = H.state('awaiting-vendor').waiting();
const negotiationStalled = H.state('negotiation-stalled').waiting();
const agreed = H.state('agreed').terminal('success');
const weWalked = H.state('walked-away-by-us').terminal('neutral');
const theyWalked = H.state('walked-away-by-them').terminal('neutral');
const expired = H.state('expired').terminal('neutral');

const negotiationSchema = z.object({
  negotiationId: z.string(),
  vendor: z.string(),
  item: z.string(),
  ceilingUsd: z.number(),
  expiresAt: z.string(),
  lastVendorOffer: z.string().optional(),
  vendorWalkedAway: z.boolean().optional(),
});
const negotiation = H.work('negotiation')
  .schema(negotiationSchema)
  .states(roundDue, drafting, awaitingVendor, negotiationStalled, agreed, weWalked, theyWalked, expired);

const negotiatorRole = H.role('negotiator').prompt('Draft the next procurement offer within the ceiling.');
const draftOffer = H.skill('draft-offer')
  .input(z.object({ vendor: z.string(), item: z.string(), ceilingUsd: z.number(), lastVendorOffer: z.string() }))
  .output(z.object({ action: z.enum(['offer', 'accept', 'walk-away']), message: z.string() }))
  .prompt(i => `Vendor ${i.vendor}, item ${i.item}, ceiling $${i.ceilingUsd}. Their last offer: ${i.lastVendorOffer}`);
const negotiator = H.seat('negotiator').role(negotiatorRole).models(sonnet);

const vendorUrl = H.env('PROCUREMENT_API_URL');
const sendToVendor = H.command('send-to-vendor')
  .input(z.object({ negotiationId: z.string(), action: z.enum(['offer', 'accept', 'walk-away']), message: z.string() }))
  .output(z.object({ messageId: z.string() }))
  .runner(local)
  .effect('unrepeatable')
  .detect(async (i, ctx) => {
    const response = await fetch(`${ctx.resolve(vendorUrl)}/negotiations/${i.negotiationId}/messages?attempt=${ctx.attempt.id}`);
    const sent = z.object({ messageId: z.string().optional() }).parse(await response.json());
    return sent.messageId === undefined ? undefined : { messageId: sent.messageId };
  })
  .run(async (i, ctx) => {
    const response = await fetch(`${ctx.resolve(vendorUrl)}/negotiations/${i.negotiationId}/messages`, {
      method: 'POST',
      body: JSON.stringify({ action: i.action, message: i.message, attempt: ctx.attempt.id }),
    });
    return z.object({ messageId: z.string() }).parse(await response.json());
  });

const negotiationRound = H.flow('negotiation-round')
  .input(negotiationSchema)
  .when(s => s.input.vendorWalkedAway === true, f => f.exit('they-walked'))
  .step('draft', negotiator.call(draftOffer), s => ({
    vendor: s.input.vendor,
    item: s.input.item,
    ceilingUsd: s.input.ceilingUsd,
    lastVendorOffer: s.input.lastVendorOffer ?? 'none yet',
  }))
  .step('send', sendToVendor, s => ({ negotiationId: s.input.negotiationId, action: s.steps.draft.action, message: s.steps.draft.message }))
  .exit(s => (s.steps.draft.action === 'accept' ? 'agreed' : s.steps.draft.action === 'walk-away' ? 'we-walked' : 'offered'));

const vendorReplies = http
  .webhook({
    path: '/procurement/replies',
    schema: z.object({ negotiationId: z.string(), lastVendorOffer: z.string(), vendorWalkedAway: z.boolean() }),
    secret: H.env('PROCUREMENT_WEBHOOK_SECRET'),
  })
  .key(reply => reply.negotiationId)
  .updatesOnly();

const negotiations = H.lane('negotiations')
  .of(negotiation)
  .from(supply.manual(negotiationSchema).key(d => d.negotiationId), vendorReplies)
  .store(unitStore)
  .deadline(unit => (unit.position === 'terminal' ? undefined : new Date(unit.data.expiresAt)))
  .handle(negotiationRound, {
    exits: { 'they-walked': theyWalked, agreed, 'we-walked': weWalked, offered: awaitingVendor },
    retry: { tries: 2, backoff: 'exponential', delaySeconds: 300, exhausted: negotiationStalled },
  });

const monthlyReviewDue = H.trigger('monthly-review-due').on(H.due(tenancies)).do(H.move(tenancies, reviewDue));
const negotiationExpiry = H.trigger('negotiation-expiry').on(H.due(negotiations)).do(H.move(negotiations, expired));

const inconclusiveRate = H.metric('experiments-inconclusive-rate').rate(
  H.events.entered(inconclusive),
  H.events.entered(aWins, bWins, inconclusive),
);
const churnCount = H.metric('tenancies-churned').count(H.events.entered(churned));
const agreementRate = H.metric('negotiations-agreed-rate').rate(
  H.events.entered(agreed),
  H.events.entered(agreed, weWalked, theyWalked, expired),
);

const roundsBeforeExperiments = H.policy.schedule('rounds-reviews-experiments', ({ candidates, metrics }) => {
  const reading = metrics.read(inconclusiveRate, { window: '180d', where: { kind: experiment } });
  const experimentsLast = reading.samples >= 10 && (reading.value ?? 0) > 0.5;
  const rounds = candidates.filter(c => c.lane === negotiations);
  const reviews = candidates.filter(c => c.lane === tenancies);
  const tests = candidates.filter(c => c.lane === experiments);
  return experimentsLast ? [...rounds, ...reviews, ...tests] : [...rounds, ...tests, ...reviews];
});

export default H.harness('hostile-lifecycles')
  .ledger(sqlite.ledger('.harness/ledger.db'))
  .pools(pool)
  .lanes(experiments, tenancies, negotiations)
  .triggers(monthlyReviewDue, negotiationExpiry)
  .schedule(roundsBeforeExperiments)
  .grants(
    H.grant(
      http.client('account-desk', { port: 8080, token: H.env('ACCOUNT_DESK_TOKEN') }),
      H.ops.work.read,
      H.ops.work.write,
      H.ops.resolve(upsell),
      H.ops.telemetry.read,
    ),
  )
  .metrics(inconclusiveRate, churnCount, agreementRate)
  .observe(observers.board({ path: '.harness/board.md' }));
