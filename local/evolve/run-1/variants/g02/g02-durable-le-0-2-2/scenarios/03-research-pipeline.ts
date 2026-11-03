import { z } from 'zod';
import { H } from 'harness-dsl';
import { anthropic } from 'harness-dsl/anthropic';
import { claudeCode } from 'harness-dsl/claude-code';
import { sqlite } from 'harness-dsl/sqlite';
import { jsonl } from 'harness-dsl/jsonl';
import { pgvector } from 'harness-dsl/pgvector';
import { local } from 'harness-dsl/local';
import { markdown } from 'harness-dsl/markdown';

const TopicSchema = z.object({
  question: z.string(),
  tags: z.array(z.string()),
});

const Open = H.state('Open', 'pending');
const Reported = H.terminal('Reported', 'success');
const Parked = H.terminal('Parked', 'neutral');
const Cancelled = H.terminal('Cancelled', 'neutral');

const Topic = H.kind('Topic')
  .attributes(TopicSchema)
  .states(Open, Reported, Parked, Cancelled)
  .key(topic => topic.question)
  .initial(Open)
  .onCancelled(Cancelled);

const apiAccount = anthropic.account('research-api', { apiKey: H.env('ANTHROPIC_API_KEY') });
const haiku = anthropic.model('haiku', { id: 'claude-haiku-4-5' });
const sonnet = anthropic.model('sonnet', { id: 'claude-sonnet-4-5' });
const opus = anthropic.model('opus', { id: 'claude-opus-4-1' });

const researchPool = H.pool('research').accounts(apiAccount).serves(haiku, sonnet, opus);

const searcherRole = H.role('searcher')
  .intents('search', 'browse')
  .instructions('Find primary sources for the question from the given angle and extract one claim per source.');

const synthesizerRole = H.role('synthesizer')
  .intents('read', 'record')
  .instructions('Write a sourced report. Every claim cites a source URL from the gathered material.');

const citationPassRate = H.metric('citationPassRate', 'rate');

const synthesizerModel = H.policy.model('synthesizerModel', [opus, sonnet], ctx => {
  const window = { lastDays: 30 };
  const opusRecord = ctx.metrics.rate(citationPassRate, { group: opus.name, window });
  const sonnetRecord = ctx.metrics.rate(citationPassRate, { group: sonnet.name, window });
  if (opusRecord.samples < 15) return opus;
  if (sonnetRecord.samples < 15) return sonnet;
  return sonnetRecord.rate >= opusRecord.rate ? sonnet : opus;
});

const searcher = H.agent('searcher')
  .role(searcherRole)
  .model(haiku)
  .output(z.object({ sources: z.array(z.object({ url: z.string(), claim: z.string() })) }))
  .budgetTokens(30_000);

const synthesizer = H.agent('synthesizer')
  .role(synthesizerRole)
  .model(synthesizerModel)
  .output(z.object({ report: z.string(), findings: z.array(z.string()), citations: z.array(z.string()) }))
  .budgetTokens(120_000);

const citationCheck = H.command('citationCheck')
  .input(z.object({ citations: z.array(z.string()) }))
  .argv(input => ['./bin/check-citations', ...input.citations])
  .runner(local.runner('local').slots(2));

const searchAngles = [
  'definitions', 'history', 'current consensus', 'open disputes', 'quantitative results',
  'methodology critiques', 'replications', 'meta-analyses', 'industry practice', 'regulation',
  'economic impact', 'regional differences', 'recent preprints', 'review articles', 'dissenting experts',
  'failure cases', 'datasets', 'benchmarks', 'future directions', 'adjacent fields',
];

const researchFlow = H.flow('research')
  .input(TopicSchema)
  .step('search', searcher.batch(), ctx =>
    searchAngles.map(angle => ({ task: `From the angle of ${angle}, research: ${ctx.unit.attributes.question}` })))
  .exit('parked', ctx => ctx.steps.search.flatMap(result => result.sources).length < 8)
  .step('synthesize', synthesizer, ctx => ({
    task: `Answer with a sourced report: ${ctx.unit.attributes.question}\n\nGathered sources:\n${ctx.steps.search
      .flatMap(result => result.sources)
      .map(source => `- ${source.claim} (${source.url})`)
      .join('\n')}`,
  }))
  .step('citations', citationCheck, ctx => ({ citations: ctx.steps.synthesize.citations }))
  .exit('reported');

const topicStorePath = '.harness/topics.sqlite';

const topics = H.lane('topics', Topic)
  .supply(H.operator)
  .supply(
    sqlite.scan('recurringTopics', {
      path: topicStorePath,
      kind: 'Topic',
      schedule: H.clock('weekly').weekly('mon', '06:00', { tz: 'UTC' }),
    }),
    (stored, to) => {
      const topic = TopicSchema.safeParse(stored.attributes);
      return topic.success && topic.data.tags.includes('recurring') ? to.create(topic.data) : to.skip();
    },
  )
  .store(sqlite.store({ path: topicStorePath }))
  .handler(researchFlow, { exits: { parked: Parked, reported: Reported } })
  .ceiling({ maxUsd: 3, onExceed: 'fail' });

const citationPassRateByModel = citationPassRate.from(H.when.step(topics, 'citations'), event => [
  { group: event.models.synthesize ?? 'unknown', hit: event.ok },
]);

const topicSpendUsd = H.metric('topicSpendUsd', 'total').from(H.when.invocation({ lanes: [topics] }), event => [
  { group: event.lane, amount: event.costUsd },
]);

const Finding = H.memory('finding').trust('experience');
const SourceExperience = H.memory('sourceExperience')
  .body(z.object({ do: z.string(), when: z.string(), because: z.string() }))
  .trust('experience');

const priorFindings = H.journal('priorFindings', Finding)
  .store(pgvector.memoryStore({ url: H.env('FINDINGS_DATABASE_URL'), table: 'findings', embeddingModel: 'voyage-3' }))
  .recall(H.recall('similarFindings', { by: 'similarity', limit: 8, minScore: 0.75 }))
  .readBy(synthesizerRole);

const sourceExperience = H.journal('sourceExperience', SourceExperience)
  .store(jsonl.memoryStore({ path: '.harness/source-experience.jsonl' }))
  .recall(H.recall('mostSpecific', { by: 'specificity', limit: 10 }))
  .readBy(searcherRole, synthesizerRole)
  .recordedBy(synthesizerRole);

const findingsRemembered = H.trigger('reportFindingsRemembered', H.when.step(topics, 'citations', { if: event => event.ok }))
  .record(priorFindings, event => event.outputs.synthesize === undefined
    ? undefined
    : { body: { text: event.outputs.synthesize.findings.join('\n') }, when: { kinds: [Topic] } });

const scheduler = H.scheduler('dailyBudget').admit(topics, ctx => {
  const succeeded = ctx.metrics.meanCostUsd({ of: topics, verdict: 'success', window: { lastDays: 30 } });
  const spentToday = ctx.metrics.total(topicSpendUsd, { group: 'topics', window: { calendar: 'day', tz: 'UTC' } });
  const projectedUsd = succeeded.samples > 0 ? succeeded.meanUsd : 3;
  return spentToday.total + projectedUsd <= 40;
});

const supervisor = claudeCode.supervisor('researchOperator', {
  grants: [H.ops.workRead, H.ops.workCreate, H.ops.workCancel, H.ops.memoryRead, H.ops.memoryWrite, H.ops.telemetryRead],
});

export const researchPipeline = H.harness('researchPipeline')
  .ledger(sqlite.ledger({ path: '.harness/ledger.sqlite' }))
  .pools(researchPool)
  .lanes(topics)
  .journals(priorFindings, sourceExperience)
  .triggers(findingsRemembered)
  .metrics(citationPassRateByModel, topicSpendUsd)
  .scheduler(scheduler)
  .clients(supervisor)
  .observers(markdown.board({ path: 'BOARD.md' }), markdown.telemetry({ path: 'TELEMETRY.md' }));
