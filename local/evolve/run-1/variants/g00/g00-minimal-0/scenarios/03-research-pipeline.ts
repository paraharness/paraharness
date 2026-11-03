import { z } from 'zod';
import { H, Metrics, Model, Supply, DataOf, StateOf } from 'harness-dsl';
import * as anthropic from 'harness-dsl/anthropic';
import * as sqlite from 'harness-dsl/sqlite';
import * as jsonl from 'harness-dsl/jsonl';
import * as qdrant from 'harness-dsl/qdrant';
import * as shell from 'harness-dsl/shell';
import * as claudeCode from 'harness-dsl/claude-code';
import * as markdown from 'harness-dsl/markdown';

const Topic = H.kind('Topic').data(z.object({
  title: z.string(),
  question: z.string(),
  tags: z.array(z.string()),
})).states({
  queued: 'pending',
  researching: 'active',
  delivered: 'succeeded',
  failed: 'failed',
  parked: 'ended',
  cancelled: 'cancelled',
}, 'queued');

type TopicSupply = Supply<DataOf<typeof Topic>, StateOf<typeof Topic>>;

const Findings = H.memory('report-findings', 'fallible');
const SourceExperience = H.memory('source-experience', 'fallible');

const nearestFindings = H.policy.recall('nearest-findings', view =>
  [...view.items]
    .filter(item => (item.similarity ?? 0) >= 0.7)
    .sort((a, b) => (b.similarity ?? 0) - (a.similarity ?? 0) || b.specificity - a.specificity)
    .slice(0, 8));

const findings = H.library('findings', Findings, qdrant.memory({
  url: 'https://vectors.example.com',
  collection: 'findings',
  embedder: 'text-embedding-small',
  apiKey: H.env('QDRANT_API_KEY'),
})).recall(nearestFindings);
const sourceExperience = H.library('source-experience', SourceExperience, jsonl.memory('memory/sources.jsonl'));

const haiku = anthropic.model('claude-haiku');
const opus = anthropic.model('claude-opus');
const sonnet = anthropic.model('claude-sonnet');

const source = z.object({ url: z.string(), claim: z.string() });

const searcherRole = H.role('search-and-extract')
  .input(z.object({ question: z.string(), facet: z.number() }))
  .output(z.object({ sources: z.array(source) }))
  .prompt(input => `Search angle ${input.facet} of 20 for: ${input.question}. Extract claims with source URLs.`)
  .intents(['browse']);

const synthesizerRole = H.role('synthesizer')
  .input(z.object({ question: z.string(), sources: z.array(source) }))
  .output(z.object({ report: z.string(), citations: z.array(z.string()) }))
  .prompt(input => `Write a sourced report answering: ${input.question}\n\nSources:\n${input.sources.map(s => `${s.url}: ${s.claim}`).join('\n')}`);

const local = shell.local('local', { slots: 4 });
const citationCheck = H.command('citation-check')
  .input(z.object({ citations: z.array(z.string()) }))
  .argv(input => ['check-citations', ...input.citations])
  .on(local);

const citationPassRate = (metrics: Metrics, model: Model) => metrics.rate({
  among: { entry: 'invocation', executable: citationCheck.name, tags: { synthModel: model.name } },
  count: { entry: 'invocation', executable: citationCheck.name, tags: { synthModel: model.name }, ok: true },
  days: 60,
});

const synthesizerModel = H.policy.model('synthesizer-by-citation-pass', choice => {
  const a = citationPassRate(choice.metrics, opus);
  const b = citationPassRate(choice.metrics, sonnet);
  if (a.samples < 15 || b.samples < 15) return a.samples <= b.samples ? opus : sonnet;
  return (a.value ?? 0) >= (b.value ?? 0) ? opus : sonnet;
});

const searcher = H.agent('searcher', searcherRole).model(haiku).recalls(sourceExperience);
const synthesizer = H.agent('synthesizer', synthesizerRole)
  .model(synthesizerModel)
  .recalls(findings, sourceExperience)
  .records(sourceExperience);

const minimumSources = 5;

const researchFlow = H.flow('research')
  .for(Topic)
  .does(async ctx => {
    const { title, question } = ctx.unit.data;
    await ctx.move('researching');
    const searches = Array.from({ length: 20 }, (_, facet) => ({ question, facet }));
    const results = await ctx.batch(searcher, searches);
    const sources = results.flatMap(result => result.ok ? result.value.sources : []);
    if (sources.length < minimumSources) return 'parked';
    const synthesis = await ctx.run(synthesizer, { question, sources });
    if (!synthesis.ok) return 'failed';
    ctx.tag({ synthModel: synthesis.model ?? 'unknown' });
    const checked = await ctx.run(citationCheck, { citations: synthesis.value.citations });
    if (!checked.ok) return 'failed';
    await ctx.remember(findings, {
      text: `When researching questions like "${question}", start from the conclusions of the "${title}" report`,
      because: synthesis.value.report.slice(0, 500),
      when: { kinds: [Topic.name] },
    });
    return 'delivered';
  });

const reopen = (key: string): TopicSupply => ({ update: key, state: 'queued' });
const terminal = new Set(['succeeded', 'failed', 'ended', 'cancelled']);

const topicLane = H.lane('topics', Topic)
  .handler(researchFlow)
  .suppliers(
    H.operator,
    H.schedule('weekly-recurring', Topic, { weekly: { day: 'mon', at: '06:00' } }, tick =>
      tick.units
        .filter(unit => unit.data.tags.includes('recurring') && terminal.has(unit.outcome))
        .map(unit => reopen(unit.key))),
  )
  .store(sqlite.store(Topic, '.harness/topics.db'))
  .maxUsdPerUnit(3);

const dailyBudgetUsd = 40;
const topicCeilingUsd = 3;

const budgetScheduler = H.policy.schedule('daily-budget', view => {
  const startOfDay = new Date(Date.UTC(view.now.getUTCFullYear(), view.now.getUTCMonth(), view.now.getUTCDate()));
  const spent = view.metrics.sum({ of: 'costUsd', among: { entry: 'invocation' }, since: startOfDay }).value ?? 0;
  const projected = view.metrics.mean({
    of: 'costUsd',
    among: { entry: 'attempt', kind: Topic.name, outcome: 'succeeded' },
    days: 30,
  }).value ?? topicCeilingUsd;
  let remaining = dailyBudgetUsd - spent;
  const start = [...view.pending].sort((a, b) => b.waitedMs - a.waitedMs).filter(() => {
    if (projected > remaining) return false;
    remaining -= projected;
    return true;
  });
  return { start };
});

const pool = H.pool('anthropic', [
  { account: anthropic.account('research-api', { apiKey: H.env('ANTHROPIC_API_KEY') }), share: 1 },
], H.policy.account('first-eligible', choice => choice.accounts.find(view => view.eligible)?.account ?? null));

export const harness = H.harness('research-pipeline')
  .ledger(sqlite.ledger('.harness/ledger.db'))
  .lanes(topicLane)
  .pools(pool)
  .scheduler(budgetScheduler)
  .clients(claudeCode.supervisor({
    grants: [H.ops.readWork, H.ops.writeWork, H.ops.readMemory, H.ops.writeMemory, H.ops.readTelemetry],
  }))
  .observers(markdown.board('BOARD.md'), markdown.telemetry('TELEMETRY.md'));
