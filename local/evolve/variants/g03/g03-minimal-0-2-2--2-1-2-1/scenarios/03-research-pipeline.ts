import { z } from 'zod';
import { H } from 'harness-dsl';
import type { EntryFilter, PendingView, SupplyOf } from 'harness-dsl';
import * as anthropic from 'harness-dsl/anthropic';
import * as http from 'harness-dsl/http';
import * as sqlite from 'harness-dsl/sqlite';
import * as jsonl from 'harness-dsl/jsonl';
import * as qdrant from 'harness-dsl/qdrant';
import * as shell from 'harness-dsl/shell';
import * as markdown from 'harness-dsl/markdown';

const open = H.state('open', 'pending');
const delivered = H.state('delivered', 'terminal', 'success');
const parked = H.state('parked', 'terminal', 'neutral');
const withdrawn = H.state('withdrawn', 'terminal', 'neutral');

export const topic = H.kind('Topic')
  .data(z.object({ question: z.string(), tags: z.array(z.string()), report: z.string().optional() }))
  .states(open, delivered, parked, withdrawn);

const source = z.object({ url: z.string(), claim: z.string() });

const extracting = H.role('search-and-extract')
  .input(z.object({ question: z.string(), query: z.string() }))
  .output(z.object({ sources: z.array(source) }))
  .prompt(input => `Search for "${input.query}" in service of the question "${input.question}". Extract sourced claims.`)
  .intents(['browse']);

const synthesizing = H.role('synthesizer')
  .input(z.object({ question: z.string(), sources: z.array(source) }))
  .output(z.object({ report: z.string(), citations: z.array(z.string()), findings: z.array(z.string()) }))
  .prompt(input =>
    `Write a sourced report answering: ${input.question}\n\nSources:\n${input.sources.map(found => `- ${found.claim} (${found.url})`).join('\n')}`
  );

const findingsMemory = H.memory('prior-findings', 'experience');
const sourceExperienceMemory = H.memory('source-experience', 'experience');

const nearestFindings = H.policy.recall('nearest-accepted-findings', choice =>
  choice.candidates
    .filter(candidate => candidate.status === 'accepted' && (candidate.similarity ?? 0) >= 0.75)
    .sort((a, b) => (b.similarity ?? 0) - (a.similarity ?? 0) || b.specificity - a.specificity)
    .slice(0, choice.limit)
);

const findings = H.journal(
  'prior-findings',
  findingsMemory,
  qdrant.memory({
    url: 'https://vectors.example.com',
    collection: 'research-findings',
    embedder: 'text-embedding-3-small',
    apiKey: H.env('QDRANT_API_KEY'),
  })
).recall(nearestFindings);

const sourceExperience = H.journal('source-experience', sourceExperienceMemory, jsonl.memory('memory/sources.jsonl'));

const haiku = anthropic.model('claude-haiku-4-5');
const opus = anthropic.model('claude-opus-4-1');
const sonnet = anthropic.model('claude-sonnet-4-5');

const local = shell.local('local', { slots: 2 });

const searchPlan = H.command('plan-searches')
  .input(z.object({ question: z.string() }))
  .output(z.array(z.string()))
  .argv(input => ['scripts/plan-searches', '--count', '20', input.question])
  .on(local);

const citationCheck = H.command('citation-check')
  .input(z.object({ citations: z.array(z.string()) }))
  .argv(input => ['scripts/check-citations', ...input.citations])
  .on(local);

const comparisonMinSamples = 30;

const synthesizerModel = H.policy.model('synthesizer-by-citation-pass-rate', [opus, sonnet], choice => {
  const checks: EntryFilter = { entry: 'invocation', status: 'ended', executable: citationCheck };
  const byModel = choice.metrics.rateBy({ among: checks, count: { ...checks, ok: true }, by: { modelOf: choice.seat }, days: 30 });
  const opusRate = byModel.of(opus);
  const sonnetRate = byModel.of(sonnet);
  if (opusRate.samples < comparisonMinSamples || sonnetRate.samples < comparisonMinSamples) {
    return opusRate.samples <= sonnetRate.samples ? opus : sonnet;
  }
  return (opusRate.value ?? 0) >= (sonnetRate.value ?? 0) ? opus : sonnet;
});

const researchAccount = anthropic.account('anthropic-research', { apiKey: H.env('ANTHROPIC_API_KEY') });
const researchPool = H.pool('research', [{ account: researchAccount, share: 1 }]);

const extractor = H.seat('extractor', extracting).model(haiku).recalls(sourceExperience);
const synthesizer = H.seat('synthesizer', synthesizing).model(synthesizerModel).recalls(findings, sourceExperience);

const minimumSources = 5;

const research = H.flow('research')
  .for(topic)
  .does(async ctx => {
    const question = ctx.unit.data.question;
    const planned = await ctx.run(searchPlan, { question });
    if (!planned.ok) return ctx.fail(planned.error);
    const extracted = await ctx.batch(
      extractor,
      planned.value.slice(0, 20).map(query => ({ question, query }))
    );
    const sources = extracted.flatMap(result => (result.ok ? result.value.sources : []));
    if (sources.length < minimumSources) return 'parked';
    const synthesis = await ctx.run(synthesizer, { question, sources });
    if (!synthesis.ok) return ctx.fail(synthesis.error);
    const checked = await ctx.run(citationCheck, { citations: synthesis.value.citations });
    if (!checked.ok) return ctx.fail(`a citation did not resolve: ${checked.error}`);
    await ctx.update({ report: synthesis.value.report });
    for (const finding of synthesis.value.findings) {
      await ctx.remember(findings, {
        text: `When researching questions like "${question}", start from this finding: ${finding}`,
        because: 'it passed the citation check in a delivered report',
        when: { kinds: [topic] },
        status: 'accepted',
      });
    }
    return 'delivered';
  });

const reopen = (key: string): SupplyOf<typeof topic> => ({ update: key, state: 'open' });

const weeklyRecurring = H.clock('weekly-recurring-topics', topic, { weekly: { day: 'mon', at: '06:00' } }, tick =>
  tick.units
    .filter(unit => unit.position === 'terminal' && unit.data.tags.includes('recurring'))
    .map(unit => reopen(unit.key))
);

export const topicsLane = H.lane('topics', topic)
  .handler(research, { retries: 1, exhausted: H.halts.exhausted })
  .suppliers(H.operator, weeklyRecurring)
  .store(sqlite.store(topic, '.harness/topics.sqlite'))
  .maxUsdPerUnit(3);

const dailyBudgetUsd = 40;
const topicCeilingUsd = 3;

const withinDailyBudget = H.policy.scheduler('within-daily-budget', view => {
  const midnight = new Date(view.now.getTime());
  midnight.setHours(0, 0, 0, 0);
  const spent = view.metrics.sum({ of: 'costUsd', among: { entry: 'invocation', status: 'ended', kind: topic }, since: midnight });
  const projected = view.metrics.mean({
    of: 'costUsd',
    among: { entry: 'attempt', status: 'ended', kind: topic, outcome: 'succeeded' },
    days: 30,
  });
  const perTopic = projected.samples > 0 && projected.value !== null ? projected.value : topicCeilingUsd;
  const reserved = view.live.filter(unit => unit.position === 'active').length * perTopic;
  let remaining = dailyBudgetUsd - (spent.value ?? 0) - reserved;
  const start: PendingView[] = [];
  for (const unit of [...view.pending].sort((a, b) => b.waitedMs - a.waitedMs)) {
    if (remaining < perTopic) break;
    start.push(unit);
    remaining -= perTopic;
  }
  return { start };
});

const operatorConsole = http.control({
  port: 7400,
  token: H.env('RESEARCH_CONTROL_TOKEN'),
  grants: [
    H.ops.readWork,
    H.ops.writeWork,
    H.ops.readMemory,
    H.ops.writeMemory,
    H.ops.curateMemory,
    H.ops.readTelemetry,
    H.ops.resolve(H.halts.exhausted, H.halts.costCeiling, H.halts.interrupted, H.halts.definitionChanged),
  ],
});

export const researchPipeline = H.harness('research-pipeline')
  .ledger(sqlite.ledger('.harness/research.sqlite'))
  .lanes(topicsLane)
  .pools(researchPool)
  .scheduler(withinDailyBudget)
  .clients(operatorConsole)
  .observers(markdown.board('BOARD.md'), markdown.telemetry('TELEMETRY.md'));
