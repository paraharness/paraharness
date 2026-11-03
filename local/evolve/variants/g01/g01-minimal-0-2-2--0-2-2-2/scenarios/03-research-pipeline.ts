import { z } from 'zod';
import { H } from 'harness-dsl';
import type { PendingView, SupplyOf } from 'harness-dsl';
import * as anthropic from 'harness-dsl/anthropic';
import * as claude from 'harness-dsl/claude-code';
import * as sqlite from 'harness-dsl/sqlite';
import * as jsonl from 'harness-dsl/jsonl';
import * as qdrant from 'harness-dsl/qdrant';
import * as shell from 'harness-dsl/shell';
import * as markdown from 'harness-dsl/markdown';

const open = H.state('open', 'pending');
const reported = H.state('reported', 'terminal', 'success');
const parked = H.state('parked', 'terminal', 'neutral');
const cancelled = H.state('cancelled', 'terminal', 'neutral');

const Topic = H.kind('Topic')
  .data(z.object({ question: z.string(), tags: z.array(z.string()), report: z.string().optional() }))
  .states(open, reported, parked, cancelled);

const findings = H.memory('findings', 'experience');
const sourceLessons = H.memory('source-lessons', 'experience');
const findingsJournal = H.journal('findings', findings, qdrant.memory({
  url: 'http://localhost:6333',
  collection: 'findings',
  embedder: 'text-embedding-3-small',
  apiKey: H.env('QDRANT_API_KEY'),
}));
const sourceJournal = H.journal('source-lessons', sourceLessons, jsonl.memory('.harness/sources.jsonl'));

const local = shell.local('local', { slots: 4 });

const expandQueries = H.command('expand-queries')
  .input(z.object({ question: z.string() }))
  .output(z.array(z.string()))
  .argv(input => ['research-queries', '--count', '20', input.question])
  .on(local)
  .recovery('rerun');

const citationCheck = H.command('citation-check')
  .input(z.object({ report: z.string() }))
  .argv(input => ['check-citations', '--report', input.report])
  .on(local)
  .recovery('rerun');

const haiku = anthropic.model('claude-haiku-4-5');
const opus = anthropic.model('claude-opus-4-1');
const sonnet = anthropic.model('claude-sonnet-4-5');

const synthesizerModel = H.policy.model('synthesizer-citation-pass-rate', choice => {
  const among = { entry: 'invocation' as const, executable: citationCheck, status: 'ended' };
  const byModel = choice.metrics.rateBy({ among, count: { ...among, ok: true }, by: { modelOf: choice.seat }, days: 30 });
  const opusRate = byModel[opus.name];
  const sonnetRate = byModel[sonnet.name];
  if (!opusRate || opusRate.samples < 15) return opus;
  if (!sonnetRate || sonnetRate.samples < 15) return sonnet;
  return (sonnetRate.value ?? 0) > (opusRate.value ?? 0) ? sonnet : opus;
});

const searcherRole = H.role('searcher')
  .input(z.object({ question: z.string(), query: z.string() }))
  .output(z.object({ sources: z.array(z.object({ url: z.string(), claim: z.string() })) }))
  .prompt(input => `Search for "${input.query}" in service of: ${input.question}. Extract sourced claims.`)
  .intents(['browse']);

const synthesizerRole = H.role('synthesizer')
  .input(z.object({ question: z.string(), sources: z.array(z.object({ url: z.string(), claim: z.string() })) }))
  .output(z.object({ report: z.string() }))
  .prompt(input => `Write a sourced report on: ${input.question}\n\n${input.sources.map(s => `- ${s.claim} (${s.url})`).join('\n')}`);

const searcher = H.seat('searcher', searcherRole).model(haiku).recalls(sourceJournal);
const synthesizer = H.seat('synthesizer', synthesizerRole)
  .model(synthesizerModel)
  .recalls(findingsJournal, sourceJournal)
  .records(findingsJournal);

const minimumSources = 8;

const research = H.flow('research')
  .for(Topic)
  .does(async ctx => {
    const question = ctx.unit.data.question;
    const queries = await ctx.run(expandQueries, { question });
    if (!queries.ok) return ctx.fail(queries.error);
    const searches = await ctx.batch(searcher, queries.value.map(query => ({ question, query })));
    const sources = searches.flatMap(result => (result.ok ? result.value.sources : []));
    if (sources.length < minimumSources) return 'parked';
    const synthesis = await ctx.run(synthesizer, { question, sources });
    if (!synthesis.ok) return ctx.fail(synthesis.error);
    const checked = await ctx.run(citationCheck, { report: synthesis.value.report });
    if (!checked.ok) return ctx.fail(`citation did not resolve: ${checked.error}`);
    await ctx.update({ report: synthesis.value.report });
    return 'reported';
  });

const weeklyRecurring = H.clock('weekly-recurring', Topic, { weekly: { day: 'mon', at: '06:00' } }, tick =>
  tick.units
    .filter(unit => unit.data.tags.includes('recurring') && unit.state === 'reported')
    .map((unit): SupplyOf<typeof Topic> => ({ update: unit.key, state: 'open' }))
);

const topics = H.lane('topics', Topic)
  .handler(research)
  .suppliers(H.operator, weeklyRecurring)
  .store(sqlite.store(Topic, '.harness/topics.db'))
  .maxUsdPerUnit(3);

const dailyBudgetUsd = 40;
const topicCeilingUsd = 3;

const dailyBudget = H.policy.scheduler('daily-budget', view => {
  const startOfDay = new Date(view.now.getTime());
  startOfDay.setHours(0, 0, 0, 0);
  const spent = view.metrics.sum({ of: 'costUsd', among: { entry: 'invocation', kind: Topic }, since: startOfDay });
  const meanSucceeded = view.metrics.mean({
    of: 'costUsd',
    among: { entry: 'attempt', kind: Topic, status: 'ended', outcome: 'succeeded' },
    days: 30,
  });
  const projected = meanSucceeded.value ?? topicCeilingUsd;
  let remaining = dailyBudgetUsd - (spent.value ?? 0) - projected * view.active.length;
  const start: PendingView[] = [];
  for (const unit of view.pending) {
    if (projected > remaining) break;
    start.push(unit);
    remaining -= projected;
  }
  return { start };
});

const operatorSession = claude.supervisor({
  grants: [H.ops.readWork, H.ops.writeWork, H.ops.readMemory, H.ops.curateMemory, H.ops.readTelemetry],
});

export const harness = H.harness('research-pipeline')
  .ledger(sqlite.ledger('.harness/ledger.db'))
  .lanes(topics)
  .pools(H.pool('anthropic', [{ account: anthropic.account('api', { apiKey: H.env('ANTHROPIC_API_KEY') }), share: 1 }]))
  .scheduler(dailyBudget)
  .clients(operatorSession)
  .observers(markdown.board('.harness/board.md'), markdown.telemetry('.harness/telemetry.md'));

export const running = harness.start();
