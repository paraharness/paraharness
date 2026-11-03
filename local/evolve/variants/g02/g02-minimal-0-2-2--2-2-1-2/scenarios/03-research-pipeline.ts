import { z } from 'zod';
import { H } from 'harness-dsl';
import type { PendingView, SupplyOf } from 'harness-dsl';
import * as anthropic from 'harness-dsl/anthropic';
import * as claudeCode from 'harness-dsl/claude-code';
import * as sqlite from 'harness-dsl/sqlite';
import * as jsonl from 'harness-dsl/jsonl';
import * as qdrant from 'harness-dsl/qdrant';
import * as shell from 'harness-dsl/shell';
import * as markdown from 'harness-dsl/markdown';

const queued = H.state('queued', 'pending');
const reported = H.state('reported', 'terminal', 'success');
const parked = H.state('parked', 'terminal', 'neutral');
const withdrawn = H.state('withdrawn', 'terminal', 'neutral');
const failed = H.state('failed', 'terminal', 'failure');

const topic = H.kind('topic')
  .data(z.object({ title: z.string(), question: z.string(), tags: z.array(z.string()) }))
  .states(queued, reported, parked, withdrawn, failed);

const topicStore = sqlite.store(topic, '.harness/topics.db');

const recurringTopics = H.clock('recurring-topics', topic, { weekly: { day: 'mon', at: '06:00' } }, tick =>
  tick.units
    .filter(unit => unit.position === 'terminal' && unit.data.tags.includes('recurring'))
    .map((unit): SupplyOf<typeof topic> => ({ update: unit.key, state: 'queued' }))
);

const local = shell.local('local', { slots: 4 });

const haiku = anthropic.model('claude-haiku-4-5');
const opus = anthropic.model('claude-opus-4-1');
const sonnet = anthropic.model('claude-sonnet-4-5');
const api = anthropic.account('anthropic-api', { apiKey: H.env('ANTHROPIC_API_KEY') });
const anthropicPool = H.pool('anthropic', [{ account: api, share: 1 }]);

const priorFindings = H.library(
  'prior-findings',
  H.memory('report-finding', 'experience'),
  qdrant.memory({
    url: 'https://vectors.example.com',
    collection: 'report-findings',
    embedder: 'text-embedding-3-small',
    apiKey: H.env('QDRANT_API_KEY'),
  })
);
const sourceLessons = H.library(
  'source-lessons',
  H.memory('source-experience', 'experience'),
  jsonl.memory('.harness/source-experience.jsonl')
);

const expandQueries = H.command('expand-queries')
  .input(z.object({ question: z.string() }))
  .output(z.object({ queries: z.array(z.string()) }))
  .argv(input => ['research-tools', 'expand', '--count', '20', input.question])
  .on(local);

const citationCheck = H.command('citation-check')
  .input(z.object({ report: z.string() }))
  .argv(input => ['research-tools', 'check-citations', '--report', input.report])
  .on(local);

const source = z.object({ url: z.string(), claim: z.string() });

const extractRole = H.role('search-and-extract')
  .input(z.object({ question: z.string(), query: z.string() }))
  .output(z.object({ sources: z.array(source) }))
  .prompt(input => `Search for "${input.query}" to answer: ${input.question}. Extract each claim with its source URL.`);

const synthesizeRole = H.role('synthesizer')
  .input(z.object({ question: z.string(), findings: z.array(source) }))
  .output(z.object({ report: z.string(), keyFindings: z.array(z.string()) }))
  .prompt(input =>
    `Write a sourced report answering: ${input.question}\n\n${input.findings.map(f => `- ${f.claim} [${f.url}]`).join('\n')}`
  );

const synthesizerModel = H.policy.model('synthesizer-model', [opus, sonnet], choice => {
  const rates = choice.metrics.rateBy({
    among: { entry: 'invocation', executable: citationCheck, status: 'ended' },
    count: { entry: 'invocation', executable: citationCheck, status: 'ended', ok: true },
    by: { modelOf: choice.seat },
    days: 60,
  });
  const first = rates.of(opus);
  const second = rates.of(sonnet);
  if (first.samples < 20) return opus;
  if (second.samples < 20) return sonnet;
  return (second.value ?? 0) > (first.value ?? 0) ? sonnet : opus;
});

const extractor = H.seat('extractor', extractRole).model(haiku).recalls(sourceLessons);
const synthesizer = H.seat('synthesizer', synthesizeRole).model(synthesizerModel).recalls(priorFindings, sourceLessons);

const minimumSources = 5;

const research = H.flow('research').for(topic).does(async ctx => {
  const { title, question } = ctx.unit.data;
  const planned = await ctx.run(expandQueries, { question });
  if (!planned.ok) return ctx.fail(planned.error);
  const extracted = await ctx.batch(
    extractor,
    planned.value.queries.slice(0, 20).map(query => ({ question, query }))
  );
  const sources = extracted.flatMap(result => (result.ok ? result.value.sources : []));
  if (sources.length < minimumSources) return 'parked';
  const synthesis = await ctx.run(synthesizer, { question, findings: sources });
  if (!synthesis.ok) return ctx.fail(synthesis.error);
  const checked = await ctx.run(citationCheck, { report: synthesis.value.report });
  if (!checked.ok) return ctx.fail(`a citation does not resolve: ${checked.error}`);
  for (const finding of synthesis.value.keyFindings) {
    await ctx.remember(priorFindings, {
      text: `When researching a topic like "${title}", start from this finding: ${finding}`,
      because: `the report on "${title}" established it with resolving citations`,
      when: { kinds: [topic] },
    });
  }
  return 'reported';
});

const topicCeilingUsd = 3;
const dailyBudgetUsd = 40;

const topics = H.lane('topics', topic)
  .handler(research, { retries: 1, exhausted: 'failed' })
  .suppliers(H.operator, recurringTopics)
  .store(topicStore)
  .maxUsdPerUnit(topicCeilingUsd);

const dailyBudget = H.policy.scheduler('daily-budget', view => {
  const midnight = new Date(view.now);
  midnight.setUTCHours(0, 0, 0, 0);
  const spent = view.metrics.sum({ of: 'costUsd', among: { entry: 'attempt', status: 'ended', kind: topic }, since: midnight });
  const projected = view.metrics.mean({
    of: 'costUsd',
    among: { entry: 'attempt', status: 'ended', kind: topic, outcome: 'succeeded' },
    days: 30,
  });
  const perTopic = projected.value ?? topicCeilingUsd;
  let remaining = dailyBudgetUsd - (spent.value ?? 0) - view.live.length * perTopic;
  const start: PendingView[] = [];
  for (const unit of view.pending) {
    if (remaining < perTopic) break;
    start.push(unit);
    remaining -= perTopic;
  }
  return { start };
});

const supervisor = claudeCode.supervisor({
  grants: [
    H.ops.readWork,
    H.ops.writeWork,
    H.ops.readMemory,
    H.ops.readTelemetry,
    H.ops.resolve(H.halts.costCeiling, H.halts.interrupted, H.halts.definitionChanged),
  ],
});

export const researchPipeline = H.harness('research-pipeline')
  .ledger(sqlite.ledger('.harness/ledger.db'))
  .lanes(topics)
  .pools(anthropicPool)
  .scheduler(dailyBudget)
  .clients(supervisor)
  .observers(markdown.board('BOARD.md'), markdown.telemetry('TELEMETRY.md'));
