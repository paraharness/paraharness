import { H } from 'harness-dsl';
import type { SupplyOf } from 'harness-dsl';
import { z } from 'zod';
import * as claudeCode from 'harness-dsl/claude-code';
import * as anthropic from 'harness-dsl/anthropic';
import * as sqlite from 'harness-dsl/sqlite';
import * as jsonl from 'harness-dsl/jsonl';
import * as qdrant from 'harness-dsl/qdrant';
import * as shell from 'harness-dsl/shell';
import * as markdown from 'harness-dsl/markdown';

const topicCeilingUsd = 3;
const dailyBudgetUsd = 40;
const searchFanOut = 20;
const minimumSources = 5;
const explorationSamples = 30;

const Topic = H.kind('Topic')
  .data(
    z.object({
      title: z.string(),
      question: z.string(),
      recurring: z.boolean(),
      report: z.string().optional(),
    })
  )
  .states(
    H.state('open', 'pending'),
    H.state('delivered', 'terminal', 'success'),
    H.state('parked', 'terminal', 'neutral'),
    H.state('cancelled', 'terminal', 'neutral'),
    H.state('failed', 'terminal', 'failure')
  )
  .failsTo('failed');

const findingsKind = H.memory('prior-findings', 'experience');
const sourceKind = H.memory('source-experience', 'experience');
const findingsArchive = H.archive(
  'findings-archive',
  findingsKind,
  qdrant.memory({
    url: 'https://vectors.example.com',
    collection: 'research-findings',
    embedder: 'text-embedding-3-small',
    apiKey: H.env('QDRANT_API_KEY'),
  })
);
const sourceArchive = H.archive('source-archive', sourceKind, jsonl.memory('memory/sources.jsonl'));

const bySimilarity = H.policy.recall('by-similarity', (view) =>
  [...view.items]
    .sort((a, b) => (b.similarity ?? 0) - (a.similarity ?? 0) || b.specificity - a.specificity)
    .slice(0, 12)
);

const synthesisBriefing = H.briefing('synthesis-briefing', [findingsArchive, sourceArchive], bySimilarity);
const searchBriefing = H.briefing('search-briefing', [sourceArchive]);

const haiku = anthropic.model('claude-haiku-4-5');
const opus = anthropic.model('claude-opus-4-1');
const sonnet = anthropic.model('claude-sonnet-4-5');

const api = H.pool('api', [{ account: anthropic.account('api', { apiKey: H.env('ANTHROPIC_API_KEY') }), share: 1 }]);

const local = shell.local('local', { slots: 2 });

const citationCheck = H.command('citation-check')
  .input(z.object({ citations: z.array(z.string()) }))
  .argv((input) => ['check-citations', ...input.citations])
  .on(local)
  .recovers('rerun');

const synthesisModel = H.facet('synthesis-model');

const citationPassRate = H.policy.model('synthesis-by-citation-pass', ({ metrics }) => {
  const byModel = metrics.rateBy({
    among: { entry: 'invocation', status: 'ended', executable: citationCheck },
    count: { entry: 'invocation', status: 'ended', executable: citationCheck, ok: true },
    by: synthesisModel,
    days: 30,
  });
  const opusRate = byModel[opus.name];
  const sonnetRate = byModel[sonnet.name];
  const opusSamples = opusRate?.samples ?? 0;
  const sonnetSamples = sonnetRate?.samples ?? 0;
  if (opusSamples < explorationSamples || sonnetSamples < explorationSamples) {
    return opusSamples <= sonnetSamples ? opus : sonnet;
  }
  return (opusRate?.value ?? 0) >= (sonnetRate?.value ?? 0) ? opus : sonnet;
});

const findingSchema = z.object({ claim: z.string(), url: z.string(), source: z.string() });

const search = H.role('search-and-extract')
  .input(z.object({ topic: z.string(), question: z.string(), slice: z.number(), slices: z.number() }))
  .output(z.object({ findings: z.array(findingSchema) }))
  .prompt(
    (input) =>
      `Research slice ${input.slice} of ${input.slices} on "${input.topic}": ${input.question}. Extract sourced claims.`
  )
  .intents(['browse']);

const synthesize = H.role('synthesize')
  .input(z.object({ question: z.string(), findings: z.array(findingSchema) }))
  .output(z.object({ report: z.string(), citations: z.array(z.string()), lessons: z.array(z.string()) }))
  .prompt(
    (input) =>
      `Write a sourced report answering: ${input.question}\n\nFindings:\n${input.findings
        .map((finding) => `- ${finding.claim} (${finding.url})`)
        .join('\n')}`
  )
  .intents(['read']);

const searcher = H.agent('searcher', search).model(haiku).recalls(searchBriefing);
const synthesizer = H.agent('synthesizer', synthesize).model(citationPassRate).recalls(synthesisBriefing);

const research = H.flow('research')
  .for(Topic)
  .does(async (ctx) => {
    const topic = ctx.unit.data;
    const searches = await ctx.batch(
      searcher,
      Array.from({ length: searchFanOut }, (_, index) => ({
        topic: topic.title,
        question: topic.question,
        slice: index + 1,
        slices: searchFanOut,
      }))
    );
    const findings = searches.flatMap((result) => (result.ok ? result.value.findings : []));
    const sources = new Set(findings.map((finding) => finding.url));
    if (sources.size < minimumSources) return 'parked';
    const synthesis = await ctx.run(synthesizer, { question: topic.question, findings });
    if (!synthesis.ok) return ctx.fail(synthesis.error);
    ctx.facet(synthesisModel, synthesis.model ?? 'unknown');
    const checked = await ctx.run(citationCheck, { citations: synthesis.value.citations });
    if (!checked.ok) return ctx.fail(`a citation did not resolve: ${checked.error}`);
    await ctx.update({ report: synthesis.value.report });
    for (const lesson of synthesis.value.lessons) {
      await ctx.remember(findingsArchive, { text: lesson, when: { kinds: [Topic] } });
    }
    return 'delivered';
  });

const weeklyReopen = H.clock('recurring-topics', Topic, { weekly: { day: 'mon', at: '06:00' } }, (tick) =>
  tick.units
    .filter((unit) => unit.data.recurring && unit.position === 'terminal')
    .map((unit): SupplyOf<typeof Topic> => ({ update: unit.key, state: 'open' }))
);

const topicRetry = H.policy.retry('topic-retry', ({ failures }) => (failures >= 2 ? 'stop' : { retryInMs: 10 * 60_000 }));

const topics = H.lane('topics', Topic)
  .handler(research)
  .suppliers(H.operator, weeklyReopen)
  .store(sqlite.store(Topic, '.harness/topics.db'))
  .maxUsdPerUnit(topicCeilingUsd)
  .retry(topicRetry);

const dailyBudget = H.policy.scheduler('daily-budget', (view) => {
  const dayStart = new Date(view.now);
  dayStart.setUTCHours(0, 0, 0, 0);
  const spent = view.metrics.sum({ of: 'costUsd', among: { entry: 'attempt', status: 'ended' }, since: dayStart });
  const projected = view.metrics.mean({
    of: 'costUsd',
    among: { entry: 'attempt', status: 'ended', kind: Topic, outcome: 'succeeded' },
    days: 30,
  });
  const perTopic = projected.value ?? topicCeilingUsd;
  let committed = spent.value + view.active.length * perTopic;
  const start = [];
  for (const unit of view.pending) {
    if (committed + perTopic > dailyBudgetUsd) break;
    start.push(unit);
    committed += perTopic;
  }
  return { start };
});

const operatorSession = claudeCode.supervisor({
  grants: [H.ops.readWork, H.ops.writeWork, H.ops.readMemory, H.ops.writeMemory, H.ops.curateMemory, H.ops.readTelemetry],
});

export const researchPipeline = H.harness('research-pipeline')
  .ledger(sqlite.ledger('.harness/ledger.db'))
  .lanes(topics)
  .pools(api)
  .scheduler(dailyBudget)
  .clients(operatorSession)
  .observers(markdown.board('BOARD.md'), markdown.telemetry('TELEMETRY.md'));
