import { z } from 'zod';
import { H, Candidate, Model, ModelChoice, PolicyEnv, SchedulingInput } from 'harness-dsl';
import * as anthropic from 'harness-dsl/anthropic';
import * as claude from 'harness-dsl/claude-code';
import * as sqlite from 'harness-dsl/sqlite';
import * as jsonl from 'harness-dsl/jsonl';
import * as qdrant from 'harness-dsl/qdrant';
import * as local from 'harness-dsl/local';
import * as markdown from 'harness-dsl/markdown';

const Queued = H.state('queued', 'pending');
const Searching = H.state('searching', 'active');
const Synthesizing = H.state('synthesizing', 'active');
const Checking = H.state('checking', 'active');
const Delivered = H.state('delivered', 'succeeded');
const Parked = H.state('parked', 'concluded');
const Unsourced = H.state('unsourced', 'failed');
const Withdrawn = H.state('withdrawn', 'cancelled');

const TopicSchema = z.object({ slug: z.string(), question: z.string(), recurring: z.boolean(), edition: z.string() });
type TopicData = z.infer<typeof TopicSchema>;

const Topic = H.work('Topic', TopicSchema)
  .states(Queued, Searching, Synthesizing, Checking, Delivered, Parked, Unsourced, Withdrawn)
  .key(topic => `${topic.slug}@${topic.edition}`);

const weeklyReopen = H.supply.schedule(Topic, { weekly: { on: 'mon', at: '06:00' } }).create(async tick => {
  const finished = await tick.units.list({ outcome: ['succeeded', 'concluded'], where: unit => unit.data.recurring });
  const latest = new Map<string, TopicData>();
  for (const unit of finished) {
    const seen = latest.get(unit.data.slug);
    if (seen === undefined || seen.edition < unit.data.edition) latest.set(unit.data.slug, unit.data);
  }
  const edition = tick.now.toISOString().slice(0, 10);
  return [...latest.values()].map(topic => ({ ...topic, edition }));
});

const apiAccount = anthropic.apiKey('research-api', { key: H.env('ANTHROPIC_API_KEY') });
const researchPool = H.pool('research').accounts(apiAccount);
const batchHaiku = anthropic.model('claude-haiku-4-5', { batch: true });
const opus = anthropic.model('claude-opus-4-1');
const sonnet = anthropic.model('claude-sonnet-4-5');

const citationPass = H.metric('citation-check-pass', {
  count: { step: 'cite-check', ok: true },
  of: { step: 'cite-check' },
});

const explorationSamples = 30;
const synthesizerModel = H.policy('synthesizer-model', (_choice: ModelChoice, env: PolicyEnv): Model => {
  const first = env.metrics.read(citationPass, { model: opus, sinceDays: 60 });
  const second = env.metrics.read(citationPass, { model: sonnet, sinceDays: 60 });
  if (first.samples < explorationSamples || second.samples < explorationSamples) {
    return first.samples <= second.samples ? opus : sonnet;
  }
  return (second.rate ?? 0) > (first.rate ?? 0) ? sonnet : opus;
});

const priorFindings = H.journal('prior-findings', H.memory.experience('prior-findings'))
  .store(qdrant.memory({ url: H.env('QDRANT_URL'), collection: 'findings', apiKey: H.env('QDRANT_API_KEY') }))
  .recall(H.policy.similarity({ limit: 8, minScore: 0.75, trackRecord: true }));
const sourceExperience = H.journal('source-experience', H.memory.experience('source-experience'))
  .store(jsonl.memory('.harness/source-experience.jsonl'))
  .recall(H.policy.specificity({ limit: 10, trackRecord: true }));

const searcherRole = H.role('searcher')
  .intents('search', 'browse')
  .instructions('Search for the query and extract claims with their source URL. Mark each claim relevant or not.');
const synthesizerRole = H.role('synthesizer')
  .intents('read')
  .instructions('Write a sourced report. Every claim carries a citation from the provided sources.');

const searcher = H.agent('searcher', searcherRole)
  .model(batchHaiku)
  .pool(researchPool)
  .recall(sourceExperience)
  .output(z.object({ sources: z.array(z.object({ url: z.string(), claim: z.string(), relevant: z.boolean() })) }));
const synthesizer = H.agent('synthesizer', synthesizerRole)
  .model(synthesizerModel)
  .pool(researchPool)
  .recall(priorFindings, sourceExperience)
  .output(
    z.object({
      report: z.string(),
      citations: z.array(z.string()),
      findings: z.array(z.object({ claim: z.string(), appliesWhen: z.string() })),
    }),
  );

const expandQueries = H.command('expand-queries')
  .run((input: { question: string }) => ['expand-queries', '--count', '20', input.question])
  .output(z.object({ queries: z.array(z.string()) }));
const citationCheck = H.command('citation-check').run((input: { citations: readonly string[] }) => [
  'check-citations',
  ...input.citations,
]);
const publishReport = H.command('publish-report').run((input: { slug: string; edition: string; report: string }) => [
  'publish-report',
  '--slug',
  input.slug,
  '--edition',
  input.edition,
  '--body',
  input.report,
]);

const minimumRelevantSources = 5;

const research = H.flow<TopicData>('research')
  .exits('delivered', 'parked', 'uncited')
  .call('plan', expandQueries, ctx => ({ question: ctx.unit.data.question }))
  .fanout('extract', searcher, ctx => ctx.steps.plan.queries.map(query => `Topic: ${ctx.unit.data.question}\nQuery: ${query}`), {
    mode: 'batch',
  })
  .exitWhen(ctx =>
    ctx.steps.extract.flatMap(result => result.sources).filter(source => source.relevant).length < minimumRelevantSources
      ? 'parked'
      : undefined,
  )
  .call('synthesize', synthesizer, ctx =>
    `Question: ${ctx.unit.data.question}\n\nSources:\n${JSON.stringify(
      ctx.steps.extract.flatMap(result => result.sources).filter(source => source.relevant),
    )}`,
  )
  .call('cite-check', citationCheck, ctx => ({ citations: ctx.steps.synthesize.citations }), {
    onFailure: { exit: 'uncited' },
  })
  .record(priorFindings, ctx =>
    ctx.steps.synthesize.findings.map(finding => ({
      do: `treat "${finding.claim}" as an established finding`,
      when: finding.appliesWhen,
      because: `report ${ctx.unit.data.slug} (${ctx.unit.data.edition}) sourced it and passed the citation check`,
    })),
  )
  .call('publish', publishReport, ctx => ({
    slug: ctx.unit.data.slug,
    edition: ctx.unit.data.edition,
    report: ctx.steps.synthesize.report,
  }))
  .exit('delivered');

const topicCeilingUsd = 3;
const dailyBudgetUsd = 40;

const topicLane = H.lane(Topic)
  .supply(H.supply.operator(), weeklyReopen)
  .store(sqlite.store(Topic, '.harness/topics.db'))
  .handler(research)
  .exits({ delivered: Delivered, parked: Parked, uncited: Unsourced, crashed: Unsourced })
  .phases({ plan: Searching, extract: Searching, synthesize: Synthesizing, 'cite-check': Checking })
  .costCeiling({ maxUsd: topicCeilingUsd, onBreach: 'halt' })
  .runner(local.runner('local'));

const withinDailyBudget = H.policy('within-daily-budget', (input: SchedulingInput, env: PolicyEnv): readonly Candidate[] => {
  const dayStart = new Date(env.now);
  dayStart.setHours(0, 0, 0, 0);
  const projected = env.metrics.meanCostUsd({ kind: Topic, outcome: 'succeeded', sinceDays: 30 });
  const perTopic = projected.mean ?? topicCeilingUsd;
  const remaining = dailyBudgetUsd - env.metrics.spentUsd({ since: dayStart }) - input.running.length * perTopic;
  if (perTopic > remaining) return [];
  return [...input.pending].sort((a, b) => b.waitingSeconds - a.waitingSeconds);
});

const operatorGrant = H.grant(
  'research-operator',
  H.op.readWork,
  H.op.createWork,
  H.op.cancelWork,
  H.op.readMemory,
  H.op.curateMemory,
  H.op.readTelemetry,
);

export const researchPipeline = H.harness('research-pipeline')
  .ledger(sqlite.ledger('.harness/ledger.db'))
  .lanes(topicLane)
  .scheduler(H.scheduler('research').order(withinDailyBudget))
  .clients(claude.supervisor({ grant: operatorGrant }))
  .observe(markdown.board({ path: 'BOARD.md' }), markdown.telemetry({ path: 'TELEMETRY.md' }));

void researchPipeline.start();
