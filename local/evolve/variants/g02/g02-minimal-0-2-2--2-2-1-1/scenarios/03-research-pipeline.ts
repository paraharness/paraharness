import { z } from 'zod';
import { H, type PendingView, type EntryFilter } from 'harness-dsl';
import * as anthropic from 'harness-dsl/anthropic';
import * as claude from 'harness-dsl/claude-code';
import * as sqlite from 'harness-dsl/sqlite';
import * as jsonl from 'harness-dsl/jsonl';
import * as qdrant from 'harness-dsl/qdrant';
import * as voyage from 'harness-dsl/voyage';
import * as shell from 'harness-dsl/shell';
import * as markdown from 'harness-dsl/markdown';

const queued = H.state('queued', 'pending');
const delivered = H.state('delivered', 'terminal', 'success');
const parked = H.state('parked', 'terminal', 'neutral');
const cancelled = H.state('cancelled', 'terminal', 'neutral');
const failed = H.state('failed', 'terminal', 'failure');

const topic = H.kind('topic')
  .data(
    z.object({
      title: z.string(),
      question: z.string(),
      queries: z.array(z.string()),
      recurring: z.boolean(),
      report: z.string().optional(),
    })
  )
  .states(queued, delivered, parked, cancelled, failed);

const priorFindings = H.memory('prior-findings', 'experience');
const sourceExperience = H.memory('source-experience', 'experience');

const findingsLibrary = H.library(
  'findings',
  priorFindings,
  qdrant.memory({
    url: 'http://localhost:6333',
    collection: 'findings',
    embedder: voyage.embedder('voyage-3', { apiKey: H.env('VOYAGE_API_KEY') }),
    apiKey: H.env('QDRANT_API_KEY'),
  })
);
const sourceLibrary = H.library('sources', sourceExperience, jsonl.memory('.harness/sources.jsonl'));

const haiku = anthropic.model('claude-haiku-4-5');
const opus = anthropic.model('claude-opus-4-1');
const sonnet = anthropic.model('claude-sonnet-4-5');
const api = anthropic.account('anthropic-api', { apiKey: H.env('ANTHROPIC_API_KEY') });
const pool = H.pool('anthropic', [{ account: api, share: 1 }]);

const local = shell.local('local', { slots: 2 });

const source = z.object({ url: z.string(), claim: z.string() });

const searcherRole = H.role('search-and-extract')
  .input(z.object({ topic: z.string(), query: z.string() }))
  .output(z.object({ sources: z.array(source) }))
  .prompt(input => `Search for sources on "${input.topic}" answering: ${input.query}. Extract claims with URLs.`)
  .intents(['browse']);

const synthesizerRole = H.role('synthesizer')
  .input(z.object({ question: z.string(), findings: z.array(source) }))
  .output(z.object({ report: z.string(), citations: z.array(z.string()), lesson: z.string() }))
  .prompt(input => `Write a sourced report answering: ${input.question}\n\n${input.findings.map(f => `${f.claim} (${f.url})`).join('\n')}`);

const citationCheck = H.command('citation-check')
  .input(z.object({ citations: z.array(z.string()) }))
  .argv(input => ['./bin/check-citations', ...input.citations])
  .on(local)
  .recovery('rerun');

const citationRuns: EntryFilter = { entry: 'invocation', executable: citationCheck, status: 'ended' };

const synthesizerModel = H.policy.model('synthesizer-model', [opus, sonnet], choice => {
  const byModel = choice.metrics.rateBy({
    among: citationRuns,
    count: { ...citationRuns, ok: true },
    days: 60,
    by: { seat: choice.seat, models: [opus, sonnet] },
  });
  const first = byModel.get(opus);
  const second = byModel.get(sonnet);
  if (first.samples < 15) return opus;
  if (second.samples < 15) return sonnet;
  return (second.value ?? 0) > (first.value ?? 0) ? sonnet : opus;
});

const searcher = H.seat('searcher', searcherRole).model(haiku).recalls(sourceLibrary);
const synthesizer = H.seat('synthesizer', synthesizerRole).model(synthesizerModel).recalls(findingsLibrary, sourceLibrary);

const searchBatch = H.job('search-and-extract-batch').batch(searcher, { minutes: 5 });

const research = H.flow('research-topic')
  .for(topic)
  .does(async ctx => {
    const queries = ctx.unit.data.queries.slice(0, 20).map(query => ({ topic: ctx.unit.data.title, query }));
    const searched = await ctx.run(searchBatch, queries);
    if (!searched.ok) return ctx.fail(searched.error);
    const findings = searched.value.flatMap(result => (result.ok ? result.value.sources : []));
    if (findings.length < 5) return 'parked';
    const synthesis = await ctx.run(synthesizer, { question: ctx.unit.data.question, findings });
    if (!synthesis.ok) return ctx.fail(synthesis.error);
    const checked = await ctx.run(citationCheck, { citations: synthesis.value.citations });
    if (!checked.ok) return ctx.fail(`a citation did not resolve: ${checked.error}`);
    await ctx.update({ report: synthesis.value.report });
    await ctx.remember(findingsLibrary, { text: synthesis.value.lesson, when: { kinds: [topic] } });
    return 'delivered';
  });

const weeklyRecurring = H.clock('weekly-recurring-topics', topic, { weekly: { day: 'mon', at: '06:00' } }, tick =>
  tick.units
    .filter(unit => unit.data.recurring && unit.position === 'terminal')
    .map(unit => ({ create: unit.data, key: unit.key }))
);

const topics = H.lane('topics', topic)
  .handler(research)
  .retries(0, { exhausted: 'failed' })
  .suppliers(H.operator, weeklyRecurring)
  .store(sqlite.store(topic, '.harness/topics.sqlite'))
  .maxUsdPerUnit(3);

const dailyBudgetUsd = 40;
const fallbackTopicCostUsd = 3;

const withinDailyBudget = H.policy.scheduler('daily-research-budget', view => {
  const startOfDay = new Date(view.now);
  startOfDay.setUTCHours(0, 0, 0, 0);
  const spent = view.metrics.sum({ of: 'costUsd', among: { entry: 'attempt', kind: topic }, since: startOfDay });
  const projected = view.metrics.mean({
    of: 'costUsd',
    among: { entry: 'attempt', kind: topic, outcome: 'succeeded' },
    days: 30,
  });
  const perTopic = projected.samples >= 5 && projected.value !== null ? projected.value : fallbackTopicCostUsd;
  let remaining = dailyBudgetUsd - (spent.value ?? 0) - view.live.length * perTopic;
  const start: PendingView[] = [];
  for (const unit of view.pending) {
    if (perTopic > remaining) break;
    start.push(unit);
    remaining -= perTopic;
  }
  return { start };
});

const supervisor = claude.supervisor('research-supervisor', {
  grants: [
    H.ops.readWork,
    H.ops.writeWork,
    H.ops.resolve(H.halts.costCeiling),
    H.ops.readMemory,
    H.ops.writeMemory,
    H.ops.readTelemetry,
  ],
});

export const researchPipeline = H.harness('research-pipeline')
  .ledger(sqlite.ledger('.harness/ledger.sqlite'))
  .lanes(topics)
  .pools(pool)
  .scheduler(withinDailyBudget)
  .clients(supervisor)
  .observers(markdown.board('BOARD.md'), markdown.telemetry('TELEMETRY.md'));
