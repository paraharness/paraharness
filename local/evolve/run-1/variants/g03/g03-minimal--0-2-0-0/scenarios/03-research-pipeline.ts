import { H } from 'harness-dsl';
import type { Metrics, PendingView } from 'harness-dsl';
import { z } from 'zod';
import * as anthropic from 'harness-dsl/anthropic';
import * as cc from 'harness-dsl/claude-code';
import * as sqlite from 'harness-dsl/sqlite';
import * as jsonl from 'harness-dsl/jsonl';
import * as qdrant from 'harness-dsl/qdrant';
import * as shell from 'harness-dsl/shell';
import * as markdown from 'harness-dsl/markdown';

const open = H.state('open', 'pending');
const delivered = H.state('delivered', 'terminal', 'success');
const parked = H.state('parked', 'terminal', 'neutral');
const cancelled = H.state('cancelled', 'terminal', 'neutral');
const abandoned = H.state('abandoned', 'terminal', 'failure');

const Topic = H.kind('Topic')
  .data(
    z.object({
      question: z.string(),
      tags: z.array(z.string()),
      recurring: z.boolean(),
      report: z.string().optional(),
    })
  )
  .states(open, delivered, parked, cancelled, abandoned)
  .failsTo('abandoned');

const priorFindings = H.memory('prior-findings', 'experience');
const sourceExperience = H.memory('source-experience', 'experience');
const findingsArchive = H.archive(
  'findings',
  priorFindings,
  qdrant.memory({
    url: 'https://vectors.internal:6333',
    collection: 'prior-findings',
    embedder: 'text-embedding-3-small',
    apiKey: H.env('QDRANT_API_KEY'),
  })
);
const sourcesArchive = H.archive('sources', sourceExperience, jsonl.memory('memory/sources.jsonl'));

const mostSimilar = H.policy.recall('most-similar-findings', (view) =>
  [...view.items]
    .filter((item) => (item.similarity ?? 0) >= 0.75)
    .sort((a, b) => (b.similarity ?? 0) - (a.similarity ?? 0) || b.specificity - a.specificity)
    .slice(0, 8)
);
const synthesizerBriefing = H.briefing('synthesizer-briefing', [findingsArchive, sourcesArchive], mostSimilar);
const extractorBriefing = H.briefing('extractor-briefing', [sourcesArchive]);

const localRunner = shell.local('local', { slots: 4 });

const search = H.command('search-sources')
  .input(z.object({ question: z.string(), limit: z.number() }))
  .output(z.object({ sources: z.array(z.object({ url: z.string(), title: z.string() })) }))
  .argv((input) => ['research-search', '--limit', String(input.limit), input.question])
  .on(localRunner)
  .recovers('rerun');

const citationCheck = H.command('citation-check')
  .input(z.object({ citations: z.array(z.string()) }))
  .argv((input) => ['cite-check', ...input.citations])
  .on(localRunner)
  .recovers('rerun');

const haiku = anthropic.model('claude-haiku-4-5');
const opus = anthropic.model('claude-opus-4-1');
const sonnet = anthropic.model('claude-sonnet-4-5');

const synthesisModelTag = H.tag('synthesis-model');

const citationPassRate = (metrics: Metrics) =>
  metrics.rateBy({
    among: { entry: 'invocation', executable: citationCheck },
    count: { entry: 'invocation', executable: citationCheck, ok: true },
    by: synthesisModelTag,
    days: 30,
  });

const synthesizerModel = H.policy.model('synthesizer-by-citation-pass-rate', (choice) => {
  const rates = citationPassRate(choice.metrics);
  const first = rates.of(opus);
  const second = rates.of(sonnet);
  if (first.samples < 20) return opus;
  if (second.samples < 20) return sonnet;
  return (first.value ?? 0) >= (second.value ?? 0) ? opus : sonnet;
});

const extractSchema = z.object({
  url: z.string(),
  claims: z.array(z.string()),
  confidence: z.enum(['low', 'medium', 'high']),
});

const extractorRole = H.role('extractor')
  .input(z.object({ question: z.string(), url: z.string(), title: z.string() }))
  .output(extractSchema)
  .prompt((input) => `Extract claims relevant to "${input.question}" from ${input.title} (${input.url}).`)
  .intents(['browse']);

const synthesizerRole = H.role('synthesizer')
  .input(z.object({ question: z.string(), extracts: z.array(extractSchema) }))
  .output(z.object({ report: z.string(), citations: z.array(z.string()), findings: z.array(z.string()) }))
  .prompt(
    (input) =>
      `Write a sourced report answering "${input.question}" from ${input.extracts.length} extracts. Phrase each finding as "when X, do Y because Z".`
  )
  .intents([]);

const extractor = H.agent('extractor', extractorRole).model(haiku).recalls(extractorBriefing);
const synthesizer = H.agent('synthesizer', synthesizerRole).model(synthesizerModel).recalls(synthesizerBriefing);

const minimumSources = 5;

const research = H.flow('research')
  .for(Topic)
  .does(async (ctx) => {
    const { question } = ctx.unit.data;
    const found = await ctx.run(search, { question, limit: 20 });
    if (found.ok === false) return ctx.fail(found.error);
    const extracts = await ctx.batch(
      extractor,
      found.value.sources.map((source) => ({ question, url: source.url, title: source.title }))
    );
    const usable = extracts.flatMap((result) => (result.ok ? [result.value] : []));
    if (usable.length < minimumSources) return 'parked';
    const synthesis = await ctx.run(synthesizer, { question, extracts: usable });
    if (synthesis.ok === false) return ctx.fail(synthesis.error);
    ctx.tag(synthesisModelTag, synthesis.model);
    const checked = await ctx.run(citationCheck, { citations: synthesis.value.citations });
    if (checked.ok === false) return ctx.fail(`citation did not resolve: ${checked.error}`);
    await ctx.update({ report: synthesis.value.report });
    for (const finding of synthesis.value.findings) {
      await ctx.remember(findingsArchive, {
        text: finding,
        because: `delivered in the report on "${question}"`,
        when: { kinds: [Topic] },
      });
    }
    return 'delivered';
  });

const weeklyRecurring = H.clock('weekly-recurring', Topic, { weekly: { day: 'mon', at: '06:00' } }, (tick) =>
  tick.units
    .filter((unit) => unit.data.recurring && unit.position === 'terminal')
    .map((unit) => ({ create: { question: unit.data.question, tags: unit.data.tags, recurring: true }, key: unit.key }))
);

const topicCeilingUsd = 3;
const dailyBudgetUsd = 40;

const twoTries = H.policy.retry('two-tries', (view) =>
  view.failures >= 2 ? 'stop' : { retryInMs: 10 * 60_000 }
);

const topics = H.lane('topics', Topic)
  .handler(research)
  .suppliers(H.operator, weeklyRecurring)
  .store(sqlite.store(Topic, '.harness/topics.db'))
  .maxUsdPerUnit(topicCeilingUsd)
  .retry(twoTries);

const withinDailyBudget = H.policy.scheduler('within-daily-budget', (view) => {
  const dayStart = new Date(Date.UTC(view.now.getUTCFullYear(), view.now.getUTCMonth(), view.now.getUTCDate()));
  const spent = view.metrics.sum({
    of: 'costUsd',
    among: { entry: 'attempt', status: 'ended', lane: topics },
    since: dayStart,
  });
  const projected = view.metrics.mean({
    of: 'costUsd',
    among: { entry: 'attempt', kind: Topic, outcome: 'succeeded' },
    days: 30,
  });
  const perTopic = projected.value ?? topicCeilingUsd;
  let remaining = dailyBudgetUsd - spent.value - view.active.length * perTopic;
  const start: PendingView[] = [];
  for (const unit of [...view.pending].sort((a, b) => b.waitedMs - a.waitedMs)) {
    if (perTopic > remaining) break;
    start.push(unit);
    remaining -= perTopic;
  }
  return { start };
});

const researchPool = H.pool('research', [
  { account: anthropic.account('research-api', { apiKey: H.env('ANTHROPIC_API_KEY') }), share: 1 },
]);

const supervisor = cc.supervisor({
  grants: [H.ops.readWork, H.ops.writeWork, H.ops.readMemory, H.ops.writeMemory, H.ops.readTelemetry],
});

export const researchPipeline = H.harness('research-pipeline')
  .ledger(sqlite.ledger('.harness/ledger.db'))
  .lanes(topics)
  .pools(researchPool)
  .scheduler(withinDailyBudget)
  .clients(supervisor)
  .observers(markdown.board('BOARD.md'), markdown.telemetry('TELEMETRY.md'));
