import { H } from 'harness-dsl';
import { z } from 'zod';
import { sqlite } from 'harness-dsl/sqlite';
import { jsonl } from 'harness-dsl/jsonl';
import { pgvector } from 'harness-dsl/pgvector';
import { voyage } from 'harness-dsl/voyage';
import { anthropic } from 'harness-dsl/anthropic';
import { claudeCode } from 'harness-dsl/claude-code';
import { local } from 'harness-dsl/local';
import { markdown } from 'harness-dsl/markdown';

const topicSchema = z.object({
  slug: z.string(),
  title: z.string(),
  question: z.string(),
  tags: z.array(z.string()),
});

const Open = H.state('Open', 'pending');
const Delivered = H.terminal('Delivered', 'success');
const Parked = H.terminal('Parked', 'neutral');
const Withdrawn = H.terminal('Withdrawn', 'neutral');
const Failed = H.terminal('Failed', 'failure');

const Topic = H.kind('Topic')
  .attributes(topicSchema)
  .states(Open, Delivered, Parked, Withdrawn, Failed)
  .key(a => a.slug)
  .initial(Open);

const quota = sqlite.quota('research-quota', { path: './.harness/quota.sqlite' });
const api = anthropic.account('anthropic-api', { apiKey: H.env('ANTHROPIC_API_KEY'), quota });
const pool = H.pool('research').accounts(api);

const haiku = anthropic.model('haiku', { id: 'claude-haiku-4-5' });
const opus = anthropic.model('opus', { id: 'claude-opus-4-1' });
const sonnet = anthropic.model('sonnet', { id: 'claude-sonnet-4-5' });

const extractor = H.role('extractor').intents('search', 'browse').instructions('Search for the query and extract sourced claims.');
const synthesizer = H.role('synthesizer').intents('read', 'record').instructions('Write a sourced report; every claim carries a citation.');

const synthesizerModel = H.policy.model('synthesizer-model', [opus, sonnet], ctx => {
  const opusPass = ctx.metrics.rate(citationPass, { seat: ctx.seat, model: opus, window: { lastDays: 30 } });
  const sonnetPass = ctx.metrics.rate(citationPass, { seat: ctx.seat, model: sonnet, window: { lastDays: 30 } });
  if (opusPass.samples < 20) return opus;
  if (sonnetPass.samples < 20) return sonnet;
  return opusPass.rate >= sonnetPass.rate ? opus : sonnet;
});

const extractorSeat = H.seat('extractor').role(extractor).model(haiku).pool(pool);
const synthesizerSeat = H.seat('synthesizer').role(synthesizer).model(synthesizerModel).pool(pool);

const extractCall = H.call('search-and-extract', extractorSeat).output(
  z.object({ sources: z.array(z.object({ url: z.string(), claim: z.string() })) }),
);
const synthesizeCall = H.call('synthesize', synthesizerSeat).output(
  z.object({ report: z.string(), citations: z.array(z.string()), keyFinding: z.string() }),
);

const localRunner = local.runner('local');
const planQueries = H.command('plan-queries')
  .input(z.object({ question: z.string() }))
  .argv(i => ['research-plan', '--count', '20', i.question])
  .output(z.object({ queries: z.array(z.string()) }))
  .runner(localRunner);
const checkCitations = H.command('check-citations')
  .input(z.object({ citations: z.array(z.string()) }))
  .argv(i => ['check-citations', ...i.citations])
  .runner(localRunner);

const researchFlow = H.flow('research')
  .input(topicSchema)
  .step('plan', planQueries, ctx => ({ question: ctx.unit.attributes.question }))
  .job('extract', H.batch(extractCall), ctx =>
    ctx.steps.plan.queries.map(query => ({ text: `Search for "${query}" and extract claims with their source URLs.` })),
  )
  .exit('notEnoughSources', ctx => ctx.steps.extract.reduce((count, r) => count + r.sources.length, 0) < 5)
  .step('synthesize', synthesizeCall, ctx => ({
    text: `Answer: ${ctx.unit.attributes.question}\n\nSources:\n${JSON.stringify(ctx.steps.extract.flatMap(r => r.sources))}`,
  }))
  .step('cite', checkCitations, ctx => ({ citations: ctx.steps.synthesize.citations }))
  .exit('delivered');

const recurringClock = H.clock('weekly-recurring').at('06:00', { on: 'mon', tz: 'UTC' });

const topics = H.lane('topics', Topic)
  .supply(H.operator)
  .supply(sqlite.scan('recurring-topics', { path: './.harness/store.sqlite', kind: 'Topic', schedule: recurringClock }), (stored, to) => {
    const parsed = topicSchema.safeParse(stored.attributes);
    return parsed.success && parsed.data.tags.includes('recurring') ? to.create(parsed.data) : to.skip();
  })
  .handler(researchFlow, { exits: { notEnoughSources: Parked, delivered: Delivered } })
  .store(sqlite.store({ path: './.harness/store.sqlite' }))
  .retry({ maxAttempts: 2, backoff: 'exponential', initialDelayMs: 120_000, exhausted: Failed })
  .ceiling({ maxUsd: 3, onExceed: 'fail' })
  .on(H.cancel, { enter: Withdrawn });

const citationPass = H.metric('citation-pass', H.when.step(topics, 'cite')).samples(e => [
  { hit: e.ok, seat: synthesizerSeat, model: e.modelOf(synthesizerSeat) },
]);
const succeededTopicCost = H.metric('succeeded-topic-cost', H.when.transition(topics, { to: Delivered })).amounts(e =>
  e.attempt ? [{ amount: e.attempt.costUsd }] : [],
);
const topicSpend = H.metric('topic-spend', H.when.invocation({ lanes: [topics] })).amounts(e => [{ amount: e.costUsd }]);

const embedder = voyage.embedder('voyage-3', { id: 'voyage-3', apiKey: H.env('VOYAGE_API_KEY') });
const findingsKind = H.memory('report-findings', 'experience');
const sourceExperienceKind = H.memory('source-experience', 'experience');

const findings = H.journal('report-findings', findingsKind)
  .store(pgvector.memoryStore({ url: H.env('FINDINGS_DATABASE_URL'), table: 'findings', embedder }))
  .recall({ by: 'similarity', limit: 6 })
  .readBy(synthesizer);

const sourceExperience = H.journal('source-experience', sourceExperienceKind)
  .store(jsonl.memoryStore({ path: './memory/sources.jsonl' }))
  .recall({ by: 'specificity', limit: 8 })
  .readBy(extractor, synthesizer)
  .recordedBy(synthesizer);

const findingRecorded = H.trigger('synthesis-records-finding')
  .on(H.when.step(topics, 'synthesize', { if: e => e.ok }))
  .record(findings, e =>
    e.output
      ? {
          text: `When researching ${e.unit.attributes.title}, start from this finding: ${e.output.keyFinding}`,
          status: 'active',
          when: { kinds: [Topic] },
        }
      : undefined,
  );

const scheduler = H.scheduler('research')
  .standard(topics)
  .admit(topics, ctx => {
    const succeeded = ctx.metrics.total(succeededTopicCost, { window: { lastDays: 30 } });
    const projectedUsd = succeeded.samples === 0 ? 3 : succeeded.total / succeeded.samples;
    const spentToday = ctx.metrics.total(topicSpend, { window: { calendar: 'day', tz: 'UTC' } });
    return spentToday.total + projectedUsd <= 40;
  });

const operatorConsole = claudeCode.supervisor('research-console', {
  grants: [H.ops.workRead, H.ops.workCreate, H.ops.workCancel, H.ops.memoryRead, H.ops.telemetryRead],
});

const research = H.harness('research-pipeline')
  .ledger(sqlite.ledger({ path: './.harness/ledger.sqlite' }))
  .lanes(topics)
  .journals(findings, sourceExperience)
  .triggers(findingRecorded)
  .metrics(citationPass, succeededTopicCost, topicSpend)
  .scheduler(scheduler)
  .clients(operatorConsole)
  .observers(markdown.board({ path: './BOARD.md' }), markdown.telemetry({ path: './TELEMETRY.md' }));

void research.start();
