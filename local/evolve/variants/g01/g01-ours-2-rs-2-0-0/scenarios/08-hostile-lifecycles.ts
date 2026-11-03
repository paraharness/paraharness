import { z } from 'zod';
import { H } from 'harness-dsl';
import { anthropic } from 'harness-dsl/anthropic';
import { sqlite } from 'harness-dsl/sqlite';
import { http } from 'harness-dsl/http';
import { supply } from 'harness-dsl/supply';
import { claudeCode } from 'harness-dsl/claude-code';
import { observers } from 'harness-dsl/observers';

const hourMs = 3600 * 1000;
const store = sqlite.store('./ops/.harness/store.sqlite');
const local = H.runner.local('local', { slots: 4 });
const sonnet = H.model('claude-sonnet-4-5').pricing(anthropic.pricing());
const api = H.account('api', anthropic.api({ apiKey: H.env('ANTHROPIC_API_KEY') }));

const experimentSchema = z.object({ name: z.string(), tallyUrl: z.string(), endsAt: z.string() });
type Experiment = z.infer<typeof experimentSchema>;

const sampleDue = H.state('sample-due').pending();
const sampling = H.state('sampling').active();
const observing = H.state('observing').waiting();
const aWins = H.state('a-wins').terminal('neutral');
const bWins = H.state('b-wins').terminal('neutral');
const inconclusive = H.state('inconclusive').terminal('neutral');

const experiment = H.work('experiment')
  .schema(experimentSchema)
  .states(sampleDue, sampling, observing, aWins, bWins, inconclusive);

const tallySchema = z.object({ a: z.number(), b: z.number(), samples: z.number() });
type Tally = z.infer<typeof tallySchema>;

const sampleMetric = H.command('sample-experiment')
  .input(experimentSchema)
  .output(tallySchema)
  .runner(local)
  .effect('repeatable')
  .run(async input => tallySchema.parse(await (await fetch(input.tallyUrl)).json()));

type ExperimentExit = 'continue' | 'a' | 'b' | 'inconclusive';

const judge = (now: Date, input: Experiment, tally: Tally): ExperimentExit => {
  if (now.getTime() < Date.parse(input.endsAt)) return 'continue';
  if (tally.samples < 1000) return 'inconclusive';
  const lift = (tally.a - tally.b) / tally.samples;
  if (lift > 0.02) return 'a';
  if (lift < -0.02) return 'b';
  return 'inconclusive';
};

const sampleExperiment = H.flow('sample-experiment')
  .input(experimentSchema)
  .step('tally', sampleMetric)
  .exit(s => judge(s.now, s.input, s.steps.tally));

const experimentHandler = H.handler('sample-experiment')
  .of(experiment)
  .flow(sampleExperiment)
  .exits({ continue: observing, a: aWins, b: bWins, inconclusive })
  .retry({ tries: 2, backoff: 'linear', delaySeconds: 300, exhausted: observing });

const experiments = H.lane('experiments', experimentHandler).from(supply.manual()).store(store);

const hourlySample = H.trigger('experiment-hourly-sample')
  .on(experiments.due(u => (u.state === observing.name ? new Date(u.updatedAt.getTime() + hourMs) : undefined)))
  .do(experiments.move(sampleDue));

const tenancySchema = z.object({
  customerId: z.string(),
  plan: z.string(),
  status: z.enum(['active', 'suspended', 'churned']),
});

const reviewDue = H.state('review-due').pending();
const reviewing = H.state('reviewing').active();
const betweenReviews = H.state('between-reviews').waiting();
const suspended = H.state('suspended').waiting();
const churned = H.state('churned').terminal('neutral');

const tenancy = H.work('tenancy').schema(tenancySchema).states(reviewDue, reviewing, betweenReviews, suspended, churned);

const usageReport = H.command('usage-report')
  .input(tenancySchema)
  .output(z.object({ seats: z.number(), usageUsd: z.number(), trend: z.string() }))
  .runner(local)
  .effect('repeatable')
  .run(async (input, ctx) => {
    const result = await ctx.sh(`./bin/usage --customer ${input.customerId} --json`);
    if (result.code !== 0) throw new Error(result.stderr);
    return z.object({ seats: z.number(), usageUsd: z.number(), trend: z.string() }).parse(JSON.parse(result.stdout));
  });

const accountManager = H.role('account-manager').prompt('Summarise a customer month plainly for an upsell decision.').intents(['read']);

const summarizeMonth = H.skill('summarize-month')
  .input(z.object({ plan: z.string(), seats: z.number(), usageUsd: z.number(), trend: z.string() }))
  .output(z.object({ summary: z.string() }))
  .prompt(i => `Plan ${i.plan}; ${i.seats} seats; $${i.usageUsd}; trend ${i.trend}.`);

const summarizer = H.seat('tenancy-summarizer').role(accountManager).models(sonnet);

const upsell = H.halt('upsell')
  .context(z.object({ customerId: z.string(), summary: z.string() }))
  .ask(c => `Offer an upsell to ${c.customerId}?\n${c.summary}`)
  .decision(z.object({ upsell: z.boolean(), notes: z.string() }));

const proposeUpsell = H.command('propose-upsell')
  .input(z.object({ customerId: z.string(), notes: z.string() }))
  .runner(local)
  .effect('unrepeatable')
  .run(async (input, ctx) => {
    const result = await ctx.sh(`./bin/crm propose-upsell --customer ${input.customerId}`, { stdin: input.notes });
    if (result.code !== 0) throw new Error(result.stderr);
  });

const monthlyReview = H.flow('monthly-review')
  .input(tenancySchema)
  .step('usage', usageReport)
  .step('summary', summarizer.call(summarizeMonth), s => ({
    plan: s.input.plan,
    seats: s.steps.usage.seats,
    usageUsd: s.steps.usage.usageUsd,
    trend: s.steps.usage.trend,
  }))
  .halt('decision', upsell, s => ({ customerId: s.input.customerId, summary: s.steps.summary.summary }))
  .when(
    s => s.steps.decision.upsell,
    f => f.step('propose', proposeUpsell, s => ({ customerId: s.input.customerId, notes: s.steps.decision.notes })),
  )
  .exit('reviewed');

const tenancyHandler = H.handler('monthly-review')
  .of(tenancy)
  .flow(monthlyReview)
  .exits({ reviewed: betweenReviews })
  .retry({ tries: 2, backoff: 'exponential', delaySeconds: 600, exhausted: betweenReviews });

const tenancies = H.lane('tenancies', tenancyHandler)
  .from(http.webhook({ path: '/tenancies', schema: tenancySchema, secret: H.env('CRM_SECRET') }).key(d => d.customerId))
  .store(store);

const monthlyReviewDue = H.trigger('tenancy-monthly-review')
  .on(tenancies.due(u => (u.state === betweenReviews.name ? new Date(u.updatedAt.getTime() + 30 * 24 * hourMs) : undefined)))
  .do(tenancies.move(reviewDue));

const suspendTenancy = H.trigger('tenancy-suspended')
  .on(tenancies.updated())
  .when(p => p.unit.data.status === 'suspended' && p.previous.status !== 'suspended')
  .do(tenancies.move(suspended));

const reinstateTenancy = H.trigger('tenancy-reinstated')
  .on(tenancies.updated())
  .when(p => p.unit.data.status === 'active' && p.previous.status === 'suspended')
  .do(tenancies.move(betweenReviews));

const churnTenancy = H.trigger('tenancy-churned')
  .on(tenancies.updated())
  .when(p => p.unit.data.status === 'churned')
  .do(tenancies.move(churned));

const negotiationSchema = z.object({
  id: z.string(),
  vendor: z.string(),
  item: z.string(),
  ceilingUsd: z.number(),
  expiresAt: z.string(),
  lastReply: z.string(),
  vendorStatus: z.enum(['open', 'accepted', 'walked']),
});
type Negotiation = z.infer<typeof negotiationSchema>;

const ourTurn = H.state('our-turn').pending();
const drafting = H.state('drafting').active();
const theirTurn = H.state('their-turn').waiting();
const stalled = H.state('stalled').waiting();
const agreed = H.state('agreed').terminal('success');
const weWalked = H.state('we-walked-away').terminal('neutral');
const theyWalked = H.state('they-walked-away').terminal('failure');
const expired = H.state('expired').terminal('failure');

const negotiation = H.work('negotiation')
  .schema(negotiationSchema)
  .states(ourTurn, drafting, theirTurn, stalled, agreed, weWalked, theyWalked, expired);

const negotiatorRole = H.role('negotiator')
  .prompt('Draft the next offer. Never exceed the ceiling. Walk away when the vendor will not move.')
  .intents(['read']);

const nextOffer = H.skill('next-offer')
  .input(z.object({ vendor: z.string(), item: z.string(), ceilingUsd: z.number(), lastReply: z.string() }))
  .output(z.object({ action: z.enum(['offer', 'accept', 'walk-away']), message: z.string() }))
  .prompt(i => `Vendor ${i.vendor}, item ${i.item}, ceiling $${i.ceilingUsd}. Their last reply: ${i.lastReply}`);

const negotiator = H.seat('negotiator').role(negotiatorRole).models(sonnet);

const sendToVendor = H.command('send-to-vendor')
  .input(z.object({ negotiation: z.string(), vendor: z.string(), message: z.string() }))
  .runner(local)
  .effect('unrepeatable')
  .run(async (input, ctx) => {
    const result = await ctx.sh(`./bin/procurement send --negotiation ${input.negotiation} --vendor ${input.vendor}`, { stdin: input.message });
    if (result.code !== 0) throw new Error(result.stderr);
  });

const negotiationRound = H.flow('negotiation-round')
  .input(negotiationSchema)
  .step('draft', negotiator.call(nextOffer), s => ({
    vendor: s.input.vendor,
    item: s.input.item,
    ceilingUsd: s.input.ceilingUsd,
    lastReply: s.input.lastReply,
  }))
  .when(s => s.steps.draft.action === 'walk-away', f => f.exit('walked'))
  .when(
    s => s.steps.draft.action === 'accept',
    f => f.step('confirm', sendToVendor, s => ({ negotiation: s.input.id, vendor: s.input.vendor, message: s.steps.draft.message })).exit('agreed'),
  )
  .step('send', sendToVendor, s => ({ negotiation: s.input.id, vendor: s.input.vendor, message: s.steps.draft.message }))
  .exit('offered');

const negotiationHandler = H.handler('negotiation-round')
  .of(negotiation)
  .flow(negotiationRound)
  .exits({ walked: weWalked, agreed, offered: theirTurn })
  .retry({ tries: 2, backoff: 'exponential', delaySeconds: 300, exhausted: stalled });

const vendorReplies = http
  .webhook({
    path: '/vendor-replies',
    schema: z.object({ negotiationId: z.string(), message: z.string(), status: z.enum(['reply', 'accepted', 'walked']) }),
    secret: H.env('VENDOR_WEBHOOK_SECRET'),
  })
  .map((reply): Partial<Negotiation> & { readonly id: string } => ({
    id: reply.negotiationId,
    lastReply: reply.message,
    vendorStatus: reply.status === 'reply' ? 'open' : reply.status,
  }))
  .key(d => d.id)
  .updatesOnly();

const negotiations = H.lane('negotiations', negotiationHandler).from(supply.manual(), vendorReplies).store(store);

const vendorReplied = H.trigger('vendor-replied')
  .on(negotiations.updated())
  .when(p => p.unit.state === theirTurn.name && p.unit.data.vendorStatus === 'open' && p.unit.data.lastReply !== p.previous.lastReply)
  .do(negotiations.move(ourTurn));

const vendorAccepted = H.trigger('vendor-accepted')
  .on(negotiations.updated())
  .when(p => p.unit.data.vendorStatus === 'accepted' && p.previous.vendorStatus !== 'accepted')
  .do(negotiations.move(agreed));

const vendorWalked = H.trigger('vendor-walked-away')
  .on(negotiations.updated())
  .when(p => p.unit.data.vendorStatus === 'walked' && p.previous.vendorStatus !== 'walked')
  .do(negotiations.move(theyWalked));

const negotiationExpired = H.trigger('negotiation-expired')
  .on(negotiations.due(u => (u.position === 'terminal' ? undefined : new Date(u.data.expiresAt))))
  .do(negotiations.move(expired));

const inconclusiveRate = H.metric('experiment-inconclusive-rate').rate(
  H.events.entered(inconclusive),
  H.events.entered(aWins, bWins, inconclusive),
);

export const lifecycles = H.harness('lifecycles')
  .ledger(sqlite.ledger('./ops/.harness/ledger.sqlite'))
  .pools(H.pool('api', [api]).serves(sonnet))
  .lanes(experiments, tenancies, negotiations)
  .triggers(
    hourlySample,
    monthlyReviewDue,
    suspendTenancy,
    reinstateTenancy,
    churnTenancy,
    vendorReplied,
    vendorAccepted,
    vendorWalked,
    negotiationExpired,
  )
  .scheduler(
    H.scheduler().policy(
      H.policy.schedule('rounds-then-reviews-then-samples', input => {
        const reading = input.metrics.read(inconclusiveRate, { window: '30d', where: { kind: experiment } });
        const experimentsAreNoisy = reading.samples >= 10 && reading.value !== undefined && reading.value > 0.5;
        return experimentsAreNoisy
          ? [...input.of(negotiations), ...input.of(tenancies), ...input.of(experiments)]
          : [...input.of(negotiations), ...input.of(experiments), ...input.of(tenancies)];
      }),
    ),
  )
  .grants(
    H.grant(claudeCode.client('supervisor'), H.ops.resolve(upsell), H.ops.work.read, H.ops.work.write, H.ops.telemetry.read),
  )
  .metrics(inconclusiveRate)
  .observe(observers.board({ path: './ops/BOARD.md' }));
