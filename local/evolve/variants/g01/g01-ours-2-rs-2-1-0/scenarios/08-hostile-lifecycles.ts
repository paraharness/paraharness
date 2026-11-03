import { z } from 'zod';
import { H } from 'harness-dsl';
import { anthropic } from 'harness-dsl/anthropic';
import { claudeCode } from 'harness-dsl/claude-code';
import { sqlite } from 'harness-dsl/sqlite';
import { http } from 'harness-dsl/http';
import { manual } from 'harness-dsl/supply';
import { runners } from 'harness-dsl/runners';
import { observers } from 'harness-dsl/observers';

const local = runners.local({ name: 'local', slots: 4 });
const store = 'commercial.db';

const api = H.account('api', anthropic.api({ apiKey: H.env('ANTHROPIC_API_KEY') }));
const sonnet = H.model('claude-sonnet-4-5').pricing(anthropic.pricing());
const pool = H.pool('commercial', [api]).serves(sonnet);

const experimentData = z.object({ name: z.string(), platformId: z.string() });
const scheduled = H.state('scheduled').pending();
const observing = H.state('observing').waiting();
const aWins = H.state('a-wins').terminal('success');
const bWins = H.state('b-wins').terminal('success');
const inconclusive = H.state('inconclusive').terminal('neutral');
const experiment = H.work('Experiment').schema(experimentData).states(scheduled, observing, aWins, bWins, inconclusive);

const stats = z.object({ a: z.number(), b: z.number(), samples: z.number(), pValue: z.number() });
const measure = H.command('measure-experiment')
  .input(z.object({ platformId: z.string() }))
  .output(stats)
  .runner(local)
  .effect('repeatable')
  .run(async (input, ctx) => {
    const result = await ctx.exec(['./bin/experiment-stats', input.platformId]);
    return stats.parse(JSON.parse(result.stdout));
  });

const twoWeeksMs = 14 * 24 * 60 * 60 * 1000;

const runExperiment = H.flow('run-experiment')
  .input(experimentData)
  .step('measure', measure, state => ({ platformId: state.input.platformId }))
  .when((_state, ctx) => ctx.now.getTime() - ctx.unit.created.getTime() < twoWeeksMs, flow => flow.exit('continue'))
  .when(state => state.measure.pValue < 0.05 && state.measure.a > state.measure.b, flow => flow.exit('a-wins'))
  .when(state => state.measure.pValue < 0.05 && state.measure.b > state.measure.a, flow => flow.exit('b-wins'))
  .exit('inconclusive');

const experiments = H.lane('experiments')
  .of(experiment)
  .from(manual('operator-experiments'))
  .store(sqlite.store(store))
  .handle(runExperiment, {
    exits: { continue: observing, 'a-wins': aWins, 'b-wins': bWins, inconclusive },
    retry: { retries: 2, backoff: { initial: '5m', factor: 2 }, exhausted: observing },
  });

const tenancyData = z.object({ customer: z.string(), plan: z.string() });
const due = H.state('due').pending();
const current = H.state('current').waiting();
const suspended = H.state('suspended').waiting();
const churned = H.state('churned').terminal('neutral');
const tenancy = H.work('Tenancy').schema(tenancyData).states(due, current, suspended, churned);

const usageReview = H.command('usage-review')
  .input(z.object({ customer: z.string() }))
  .output(z.object({ report: z.string() }))
  .runner(local)
  .effect('repeatable')
  .run(async (input, ctx) => {
    const result = await ctx.exec(['./bin/usage-report', input.customer, '--last-month']);
    return { report: result.stdout };
  });

const summarizeUsage = H.skill('summarize-usage')
  .input(z.object({ customer: z.string(), plan: z.string(), report: z.string() }))
  .output(z.object({ summary: z.string(), upsellCase: z.string() }))
  .prompt(input => `Summarise last month's usage for ${input.customer} on ${input.plan}:\n${input.report}`);
const accountManager = H.role('account-manager').prompt('You write plain monthly account summaries for a human decision.');
const usageSummarizer = H.seat('usage-summarizer').role(accountManager).skill(summarizeUsage).models(sonnet);

const upsell = H.halt('upsell')
  .context(z.object({ customer: z.string(), summary: z.string(), upsellCase: z.string() }))
  .decision(z.object({ upsell: z.boolean(), note: z.string() }))
  .ask(context => `Upsell ${context.customer}? ${context.upsellCase}`);

const recordDecision = H.command('record-upsell-decision')
  .input(z.object({ customer: z.string(), upsell: z.boolean(), note: z.string() }))
  .output(z.object({ recorded: z.boolean() }))
  .runner(local)
  .effect('repeatable')
  .run(async (input, ctx) => {
    const result = await ctx.exec(['./bin/crm-note', input.customer, String(input.upsell), input.note]);
    return { recorded: result.code === 0 };
  });

const evaluateTenancy = H.flow('evaluate-tenancy')
  .input(tenancyData)
  .step('usage', usageReview, state => ({ customer: state.input.customer }))
  .step('summary', usageSummarizer, state => ({ customer: state.input.customer, plan: state.input.plan, report: state.usage.report }))
  .halt('upsell', upsell, state => ({ customer: state.input.customer, summary: state.summary.summary, upsellCase: state.summary.upsellCase }))
  .step('record', recordDecision, state => ({ customer: state.input.customer, upsell: state.upsell.upsell, note: state.upsell.note }))
  .exit('reviewed');

const tenancies = H.lane('tenancies')
  .of(tenancy)
  .from(manual('operator-tenancies'))
  .store(sqlite.store(store))
  .handle(evaluateTenancy, { exits: { reviewed: current }, retry: { retries: 3, backoff: { initial: '1h', factor: 2 }, exhausted: current } });

const negotiationRecord = z.object({
  id: z.string(),
  vendor: z.string(),
  deadline: z.string(),
  lastVendorMessage: z.string(),
  vendorStatus: z.enum(['open', 'walked']),
});
const ourTurn = H.state('our-turn').pending();
const awaitingVendor = H.state('awaiting-vendor').waiting();
const agreed = H.state('agreed').terminal('success');
const weWalked = H.state('we-walked-away').terminal('neutral');
const theyWalked = H.state('they-walked-away').terminal('neutral');
const expired = H.state('expired').terminal('failure');
const negotiation = H.work('Negotiation').schema(negotiationRecord).states(ourTurn, awaitingVendor, agreed, weWalked, theyWalked, expired);

const nextOffer = H.skill('next-offer')
  .input(z.object({ vendor: z.string(), lastVendorMessage: z.string() }))
  .output(z.object({ action: z.enum(['counter', 'accept', 'walk']), message: z.string() }))
  .prompt(input => `Vendor ${input.vendor} wrote:\n${input.lastVendorMessage}\n\nDraft our next move.`);
const negotiator = H.role('negotiator').promptFile('prompts/negotiator.md');
const offerDrafter = H.seat('offer-drafter').role(negotiator).skill(nextOffer).models(sonnet);

const sendToVendor = H.command('send-to-vendor')
  .input(z.object({ id: z.string(), message: z.string() }))
  .output(z.object({ messageId: z.string() }))
  .runner(local)
  .effect('unrepeatable')
  .detect(async (input, ctx) => {
    const found = await ctx.exec(['./bin/vendor-portal', 'find-sent', input.id, ctx.attempt]);
    return found.code === 0 ? { messageId: found.stdout.trim() } : undefined;
  })
  .run(async (input, ctx) => {
    const sent = await ctx.exec(['./bin/vendor-portal', 'send', input.id, ctx.attempt], { stdin: input.message });
    return { messageId: sent.stdout.trim() };
  });

const negotiateRound = H.flow('negotiate-round')
  .input(negotiationRecord)
  .step('offer', offerDrafter, state => ({ vendor: state.input.vendor, lastVendorMessage: state.input.lastVendorMessage }))
  .when(state => state.offer.action === 'walk', flow => flow.exit('walk-away'))
  .step('send', sendToVendor, state => ({ id: state.input.id, message: state.offer.message }))
  .when(state => state.offer.action === 'accept', flow => flow.exit('agreed'))
  .exit('sent');

const negotiations = H.lane('negotiations')
  .of(negotiation)
  .from(
    manual('operator-negotiations'),
    http.webhook({
      name: 'vendor-replies',
      path: '/vendor-replies',
      port: H.slot.port(0),
      secret: H.env('VENDOR_WEBHOOK_SECRET'),
      body: negotiationRecord,
      key: body => body.id,
      data: body => body,
      mode: 'update',
    }),
  )
  .store(sqlite.store(store))
  .handle(negotiateRound, {
    exits: { 'walk-away': weWalked, agreed, sent: awaitingVendor },
    retry: { retries: 2, backoff: { initial: '10m', factor: 2 }, exhausted: awaitingVendor },
  });

const hourlyMeasurement = H.trigger('experiment-hourly')
  .on(H.time.every('0 * * * *'))
  .do(experiments.move({ state: observing }, scheduled));

const monthlyEvaluation = H.trigger('tenancy-monthly')
  .on(H.time.every('0 9 1 * *'))
  .do(tenancies.move({ state: current }, due));

const vendorReplied = H.trigger('vendor-replied')
  .on(H.events.updates(negotiations).where(event => event.unit.data.vendorStatus === 'open'))
  .do(negotiations.move({ state: awaitingVendor, where: (data, event) => data.id === event.unit.data.id }, ourTurn));

const vendorWalked = H.trigger('vendor-walked')
  .on(H.events.updates(negotiations).where(event => event.unit.data.vendorStatus === 'walked'))
  .do(negotiations.move(event => event.unit.key, theyWalked));

const negotiationExpired = H.trigger('negotiation-expired')
  .on(H.time.at(negotiations, data => new Date(data.deadline)))
  .do(negotiations.move(event => event.unit.key, expired));

const experimentOutcomes = H.metric('experiment-outcomes', H.events.transitions(experiments, { terminal: true }))
  .count()
  .by('state')
  .window('365d');
const inconclusiveRate = H.metric('experiments-inconclusive', H.events.transitions(experiments, { terminal: true }))
  .rate(event => event.to === inconclusive.name)
  .window('365d');
const tenancyChurn = H.metric('tenancy-churn', H.events.transitions(tenancies, { to: churned }))
  .count()
  .window('calendarMonth');

const commercialOrder = H.policy.units('negotiations-then-tenancies-then-experiments', choice => {
  const inconclusiveOften = choice.metrics.read(inconclusiveRate);
  const experimentsLast = inconclusiveOften.samples >= 10 && (inconclusiveOften.value ?? 0) > 0.5;
  const rank = (lane: string): number =>
    lane === negotiations.name ? 0 : lane === tenancies.name ? 1 : experimentsLast ? 3 : 2;
  return [...choice.candidates].sort((a, b) => rank(a.lane) - rank(b.lane) || a.queuedAt.getTime() - b.queuedAt.getTime());
});

const supervisor = claudeCode.client({ name: 'supervisor' });

export const harness = H.harness('commercial')
  .ledger(sqlite.ledger('.harness/commercial-ledger.db'))
  .pools(pool)
  .lanes(experiments, tenancies, negotiations)
  .triggers(hourlyMeasurement, monthlyEvaluation, vendorReplied, vendorWalked, negotiationExpired)
  .metrics(experimentOutcomes, inconclusiveRate, tenancyChurn)
  .scheduler(commercialOrder)
  .grants(H.grant(
    supervisor,
    H.ops.work.read,
    H.ops.work.write,
    H.ops.work.move(current, suspended, due, awaitingVendor),
    H.ops.resolve(upsell),
    H.ops.telemetry.read,
  ))
  .observe(observers.board({ path: '.harness/board.md' }), observers.telemetry({ path: '.harness/telemetry.md' }));
