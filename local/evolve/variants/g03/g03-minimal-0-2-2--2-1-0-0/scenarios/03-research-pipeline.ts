import { z } from 'zod';
import { H } from 'harness-dsl';
import * as anthropic from 'harness-dsl/anthropic';
import * as sqlite from 'harness-dsl/sqlite';
import * as jsonl from 'harness-dsl/jsonl';
import * as qdrant from 'harness-dsl/qdrant';
import * as shell from 'harness-dsl/shell';
import * as http from 'harness-dsl/http';
import * as markdown from 'harness-dsl/markdown';

const topic = H.kind('topic')
  .data(z.object({ question: z.string(), recurring: z.boolean() }))
  .states(
    H.state('open', 'pending'),
    H.state('reported', 'terminal', 'success'),
    H.state('parked', 'terminal', 'neutral'),
    H.state('withdrawn', 'terminal', 'neutral'),
    H.state('failed', 'terminal', 'failure')
  );

const haiku = anthropic.model('claude-haiku-4-5');
const sonnet = anthropic.model('claude-sonnet-4-5');
const opus = anthropic.model('claude-opus-4-1');

const researchPool = H.pool('research', [
  { account: anthropic.account('research-api', { apiKey: H.env('ANTHROPIC_API_KEY') }), share: 1 },
]).serves(haiku, sonnet, opus);

const findingsKind = H.memory('prior-finding', 'experience');
const sourceLessonsKind = H.memory('source-lesson', 'experience');

const bySimilarity = H.policy.recall('findings-by-similarity', choice =>
  choice.candidates
    .filter(ranked => (ranked.similarity ?? 0) >= 0.75)
    .sort((a, b) => (b.similarity ?? 0) - (a.similarity ?? 0) || b.specificity - a.specificity)
    .slice(0, choice.limit)
    .map(ranked => ranked.item)
);

const priorFindings = H.journal(
  'prior-findings',
  findingsKind,
  qdrant.memory({
    url: 'http://localhost:6333',
    collection: 'findings',
    embedder: 'text-embedding-3-small',
    apiKey: H.env('QDRANT_API_KEY'),
  }),
  bySimilarity
);
const sourceLessons = H.journal('source-lessons', sourceLessonsKind, jsonl.memory('.harness/source-lessons.jsonl'));

const local = shell.local('local', { slots: 2 });

const citationCheck = H.command('citation-check')
  .input(z.object({ report: z.string() }))
  .argv(input => ['check-citations', '--report', input.report])
  .on(local)
  .recovery('rerun');

const synthesizerModel = H.policy.model('synthesizer-by-citation-pass', [opus, sonnet], choice => {
  const byModel = choice.metrics.rateBy({
    among: { entry: 'invocation', executable: citationCheck, status: 'ended' },
    count: { entry: 'invocation', executable: citationCheck, status: 'ended', ok: true },
    by: { modelOf: choice.seat },
    days: 60,
  });
  const first = byModel.of(opus);
  const second = byModel.of(sonnet);
  if (first.samples < 20) return opus;
  if (second.samples < 20) return sonnet;
  return (first.value ?? 0) >= (second.value ?? 0) ? opus : sonnet;
});

const source = z.object({ url: z.string(), claim: z.string() });

const searcherRole = H.role('searcher')
  .input(z.object({ question: z.string(), angle: z.number() }))
  .output(z.object({ sources: z.array(source) }))
  .prompt(input => `Search angle ${input.angle} of 20 for: ${input.question}. Extract sourced claims.`)
  .intents(['browse']);

const synthesizerRole = H.role('synthesizer')
  .input(z.object({ question: z.string(), sources: z.array(source) }))
  .output(z.object({ report: z.string() }))
  .prompt(input =>
    `Write a sourced report on: ${input.question}\n\n${input.sources.map(item => `- ${item.claim} (${item.url})`).join('\n')}`
  );

const searcher = H.seat('searcher', searcherRole).model(haiku).recalls(sourceLessons);
const synthesizer = H.seat('synthesizer', synthesizerRole)
  .model(synthesizerModel)
  .recalls(priorFindings, sourceLessons)
  .records(priorFindings);

const research = H.flow('research-topic')
  .for(topic)
  .does(async ctx => {
    const extracts = await ctx.batch(
      searcher,
      Array.from({ length: 20 }, (_, angle) => ({ question: ctx.unit.data.question, angle }))
    );
    const sources = extracts.flatMap(result => (result.ok ? result.value.sources : []));
    if (sources.length < 5) return 'parked';
    const synthesized = await ctx.run(synthesizer, { question: ctx.unit.data.question, sources });
    if (!synthesized.ok) return ctx.fail(synthesized.error);
    const checked = await ctx.run(citationCheck, { report: synthesized.value.report });
    return checked.ok ? 'reported' : ctx.fail(`citation check failed: ${checked.error}`);
  });

const weeklyReopen = H.schedule('weekly-recurring', topic, { weekly: { day: 'mon', at: '06:00' } }, (tick, supply) =>
  tick.units
    .filter(unit => unit.data.recurring && unit.position === 'terminal')
    .map(unit => supply.create(unit.data, { key: unit.key }))
);

const topics = H.lane('topics', topic)
  .handler(research)
  .retries(1, { exhausted: 'failed' })
  .suppliers(H.operator, weeklyReopen)
  .store(sqlite.store(topic, '.harness/topics.db'))
  .maxUsdPerUnit(3);

const dailyBudgetUsd = 40;

const withinBudget = H.policy.scheduler('within-daily-budget', view => {
  const spent = view.metrics.sum({ of: 'costUsd', among: { entry: 'invocation' }, period: 'today' });
  const projected =
    view.metrics.mean({ of: 'costUsd', among: { entry: 'attempt', kind: topic, outcome: 'succeeded' }, days: 30 }).value ?? 3;
  let remaining = dailyBudgetUsd - (spent.value ?? 0) - projected * view.live.length;
  return {
    start: view
      .sorted(unit => -unit.waitedMs)
      .filter(() => {
        if (projected > remaining) return false;
        remaining -= projected;
        return true;
      }),
  };
});

export const researchPipeline = H.harness('research-pipeline')
  .ledger(sqlite.ledger('.harness/research-ledger.db'))
  .lanes(topics)
  .pools(researchPool)
  .scheduler(withinBudget)
  .clients(
    http.control({
      port: 7400,
      token: H.env('RESEARCH_CONTROL_TOKEN'),
      grants: [H.ops.readWork, H.ops.writeWork, H.ops.resolveHalts, H.ops.readMemory, H.ops.writeMemory, H.ops.readTelemetry],
    })
  )
  .observers(markdown.board('BOARD.md'), markdown.telemetry('TELEMETRY.md'));
