import { z } from 'zod';
import { H, type SupplyOf, type PendingView } from 'harness-dsl';
import * as claudeCode from 'harness-dsl/claude-code';
import * as anthropic from 'harness-dsl/anthropic';
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
  .data(
    z.object({
      title: z.string(),
      question: z.string(),
      tags: z.array(z.string()),
      report: z.string().optional(),
    })
  )
  .states(queued, reported, parked, withdrawn, failed);

const haiku = anthropic.model('claude-haiku-4-5');
const sonnet = anthropic.model('claude-sonnet-4-5');
const opus = anthropic.model('claude-opus-4-1');
const api = anthropic.account('research-api', { apiKey: H.env('ANTHROPIC_API_KEY'), serves: [haiku, sonnet, opus] });
const models = H.pool('models', [{ account: api, share: 1 }]);

const local = shell.local('local', { slots: 2 });

const searchPlan = H.command('search-plan')
  .input(z.object({ question: z.string() }))
  .output(z.object({ queries: z.array(z.string()) }))
  .argv(input => ['research-plan', '--count', '20', input.question])
  .on(local);

const citationCheck = H.command('citation-check')
  .input(z.object({ topic: z.string() }))
  .argv(input => ['citation-check', '--topic', input.topic])
  .on(local);

const priorFindings = H.memory('prior-findings', 'experience');
const sourceExperience = H.memory('source-experience', 'experience');

const bySimilarity = H.policy.recall('by-similarity', choice =>
  [...choice.candidates]
    .filter(candidate => (candidate.similarity ?? 0) >= 0.75)
    .sort((a, b) => (b.similarity ?? 0) - (a.similarity ?? 0) || b.specificity - a.specificity)
    .slice(0, choice.limit)
    .map(candidate => candidate.item)
);

const findingsJournal = H.journal(
  'report-findings',
  priorFindings,
  qdrant.memory({
    url: 'https://vectors.internal:6333',
    collection: 'report-findings',
    embedder: 'text-embedding-3-small',
    apiKey: H.env('QDRANT_API_KEY'),
  }),
  bySimilarity
);
const sourceJournal = H.journal('source-lessons', sourceExperience, jsonl.memory('memory/sources.jsonl'));

const finding = z.object({ claim: z.string(), source: z.string() });

const extracting = H.role('search-and-extract')
  .input(z.object({ question: z.string(), query: z.string() }))
  .output(z.object({ findings: z.array(finding) }))
  .prompt(input => `Search for "${input.query}" and extract sourced findings that answer: ${input.question}`)
  .intents(['browse']);

const synthesizing = H.role('synthesizer')
  .input(z.object({ question: z.string(), findings: z.array(finding) }))
  .output(z.object({ report: z.string(), lessons: z.array(z.string()) }))
  .prompt(
    input =>
      `Write a sourced report answering: ${input.question}\n\nFindings:\n${input.findings.map(item => `- ${item.claim} [${item.source}]`).join('\n')}`
  );

const synthesizerModel = H.policy.model('citation-pass-rate', [opus, sonnet], choice => {
  const byModel = choice.metrics.rateBy({
    days: 60,
    among: { entry: 'invocation', executable: citationCheck },
    count: { entry: 'invocation', executable: citationCheck, ok: true },
    by: { modelOf: choice.seat },
  });
  const first = byModel.of(opus);
  const second = byModel.of(sonnet);
  if (first.samples < 30) return opus;
  if (second.samples < 30) return sonnet;
  return (first.value ?? 0) >= (second.value ?? 0) ? opus : sonnet;
});

const extractor = H.seat('extractor', extracting).model(haiku).recalls(sourceJournal);
const synthesizer = H.seat('synthesizer', synthesizing)
  .model(synthesizerModel)
  .recalls(findingsJournal, sourceJournal)
  .records(sourceJournal);

const research = H.flow('research-topic')
  .for(topic)
  .does(async ctx => {
    const question = ctx.unit.data.question;
    const plan = await ctx.run(searchPlan, { question });
    if (plan.ok === false) return ctx.fail(plan.error);
    const extracts = await ctx.batch(
      extractor,
      plan.value.queries.map(query => ({ question, query }))
    );
    const findings = extracts.flatMap(result => (result.ok ? result.value.findings : []));
    if (new Set(findings.map(item => item.source)).size < 5) return 'parked';
    const synthesis = await ctx.run(synthesizer, { question, findings });
    if (synthesis.ok === false) return ctx.fail(synthesis.error);
    await ctx.update({ report: synthesis.value.report });
    const checked = await ctx.run(citationCheck, { topic: ctx.unit.key });
    if (checked.ok === false) return ctx.fail(`citation did not resolve: ${checked.error}`);
    for (const lesson of synthesis.value.lessons) {
      await ctx.remember(findingsJournal, {
        text: lesson,
        because: `the report on "${ctx.unit.data.title}" established it with resolving citations`,
        when: { kinds: [topic] },
      });
    }
    return 'reported';
  });

const weeklyRecurring = H.schedule(
  'weekly-recurring-topics',
  topic,
  { weekly: { day: 'mon', at: '06:00' } },
  tick =>
    tick.units
      .filter(unit => unit.data.tags.includes('recurring') && unit.position === 'terminal')
      .map((unit): SupplyOf<typeof topic> => ({ update: unit.key, state: 'queued' }))
);

const topics = H.lane('topics', topic)
  .handler(research)
  .retries(1, { backoff: { first: { minutes: 30 } }, exhausted: 'failed' })
  .suppliers(H.operator, weeklyRecurring)
  .store(sqlite.store(topic, '.harness/topics.db'))
  .maxUsdPerUnit(3);

const dailyBudgetUsd = 40;
const fallbackTopicCostUsd = 3;

const withinDailyBudget = H.policy.scheduler('within-daily-budget', view => {
  const dayStart = new Date(view.now);
  dayStart.setUTCHours(0, 0, 0, 0);
  const spent = view.metrics.sum({ of: 'costUsd', among: { entry: 'invocation' }, since: dayStart });
  const projected = view.metrics.mean({
    of: 'costUsd',
    among: { entry: 'attempt', kind: topic, outcome: 'succeeded' },
    days: 30,
  });
  const perTopic = projected.samples > 0 ? projected.value ?? fallbackTopicCostUsd : fallbackTopicCostUsd;
  let remaining = dailyBudgetUsd - (spent.value ?? 0);
  const start: PendingView[] = [];
  for (const unit of view.pending) {
    if (perTopic <= remaining) {
      start.push(unit);
      remaining -= perTopic;
    }
  }
  return { start };
});

const supervisor = claudeCode.supervisor({
  grants: [H.ops.readWork, H.ops.writeWork, H.ops.readMemory, H.ops.curateMemory, H.ops.readTelemetry, H.ops.resolveHalts],
});

export const harness = H.harness('research-pipeline')
  .ledger(sqlite.ledger('.harness/research.db'))
  .lanes(topics)
  .pools(models)
  .scheduler(withinDailyBudget)
  .clients(supervisor)
  .observers(markdown.board('BOARD.md'), markdown.telemetry('TELEMETRY.md'));

export const running = harness.start();
