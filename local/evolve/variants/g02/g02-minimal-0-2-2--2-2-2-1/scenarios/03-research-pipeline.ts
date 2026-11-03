import { z } from 'zod';
import { H } from 'harness-dsl';
import type { EntryFilter, Model, PendingView, Rate, SupplyOf } from 'harness-dsl';
import * as anthropic from 'harness-dsl/anthropic';
import * as claudeCode from 'harness-dsl/claude-code';
import * as sqlite from 'harness-dsl/sqlite';
import * as jsonl from 'harness-dsl/jsonl';
import * as qdrant from 'harness-dsl/qdrant';
import * as shell from 'harness-dsl/shell';
import * as markdown from 'harness-dsl/markdown';

const open = H.state('open', 'pending');
const delivered = H.state('delivered', 'terminal', 'success');
const shelved = H.state('shelved', 'terminal', 'neutral');
const cancelled = H.state('cancelled', 'terminal', 'neutral');
const failed = H.state('failed', 'terminal', 'failure');

export const topic = H.kind('topic')
  .data(z.object({ question: z.string(), recurring: z.boolean() }))
  .states(open, delivered, shelved, cancelled, failed);

type TopicSupply = SupplyOf<typeof topic>;

const source = z.object({ url: z.string(), claim: z.string() });

const searchRole = H.role('search-extract')
  .input(z.object({ question: z.string(), slice: z.number(), of: z.number() }))
  .output(z.object({ sources: z.array(source) }))
  .prompt(input => `Search angle ${input.slice} of ${input.of} for: ${input.question}. Extract sourced claims.`);

const synthesizeRole = H.role('synthesize')
  .input(z.object({ question: z.string(), sources: z.array(source) }))
  .output(z.object({ report: z.string(), citations: z.array(z.string()) }))
  .prompt(input => `Write a sourced report answering: ${input.question}\n\nSources:\n${input.sources.map(found => `${found.url}: ${found.claim}`).join('\n')}`);

const haiku = anthropic.model('claude-haiku-4-5');
const opus = anthropic.model('claude-opus-4-1');
const sonnet = anthropic.model('claude-sonnet-4-5');
const researchPool = H.pool('research-api', [{ account: anthropic.account('research-api', { apiKey: H.env('ANTHROPIC_API_KEY') }), share: 1 }]);

const priorFindings = H.journal(
  'prior-findings',
  H.memory('report-findings', 'experience'),
  qdrant.memory({ url: 'https://vectors.internal:6333', collection: 'findings', embedder: 'text-embedding-3-small', apiKey: H.env('QDRANT_API_KEY') })
);
const sourceLore = H.journal('source-lore', H.memory('source-experience', 'experience'), jsonl.memory('memory/source-experience.jsonl'));

const local = shell.local('local', { slots: 2 });

const citationCheck = H.command('citation-check')
  .input(z.object({ citations: z.array(z.string()) }))
  .argv(input => ['check-citations', ...input.citations])
  .on(local);

const citationRuns: EntryFilter = { entry: 'invocation', executable: citationCheck, status: 'ended' };

const synthesizerModel = H.policy.model('synthesizer-by-citation-pass', choice => {
  const rates = choice.metrics.rateBy({
    among: citationRuns,
    count: { ...citationRuns, ok: true },
    by: { modelOf: choice.seat },
    days: 30,
  });
  const rateOf = (model: Model): Rate => rates[model.name] ?? { value: null, hits: 0, samples: 0 };
  const opusRate = rateOf(opus);
  const sonnetRate = rateOf(sonnet);
  if (opusRate.samples < 20) return opus;
  if (sonnetRate.samples < 20) return sonnet;
  return (sonnetRate.value ?? 0) >= (opusRate.value ?? 0) ? sonnet : opus;
});

const searcher = H.seat('searcher', searchRole).model(haiku).recalls(sourceLore);
const synthesizer = H.seat('synthesizer', synthesizeRole).model(synthesizerModel).recalls(priorFindings, sourceLore);
const searchBatch = H.batch('search-batch', searcher);

const research = H.flow('research')
  .for(topic)
  .does(async ctx => {
    const question = ctx.unit.data.question;
    const searches = await ctx.call(
      searchBatch,
      Array.from({ length: 20 }, (_, index) => ({ question, slice: index + 1, of: 20 }))
    );
    if (!searches.ok) return ctx.fail(searches.error);
    const sources = searches.value.flatMap(item => (item.ok ? item.value.sources : []));
    if (sources.length < 5) return 'shelved';
    const synthesis = await ctx.call(synthesizer, { question, sources });
    if (!synthesis.ok) return ctx.fail(synthesis.error);
    const checked = await ctx.call(citationCheck, { citations: synthesis.value.citations });
    if (!checked.ok) return ctx.fail(`Unresolved citation: ${checked.error}`);
    await ctx.remember(priorFindings, {
      text: `When researching "${question}", start from these findings: ${synthesis.value.report.slice(0, 600)}`,
      because: 'they passed the citation check',
      when: { kinds: [topic] },
    });
    return 'delivered';
  })
  .maxUsdPerUnit(3);

const weeklyRecurring = H.clock('weekly-recurring-topics', topic, { weekly: { day: 'mon', at: '07:00' } }, tick =>
  tick.units
    .filter(unit => unit.data.recurring && unit.position === 'terminal')
    .map((unit): TopicSupply => ({ update: unit.key, state: 'open' }))
);

export const topics = H.lane('topics', topic)
  .handler(research)
  .suppliers(H.operator, weeklyRecurring)
  .store(sqlite.store(topic, 'topics.db'))
  .wip(4)
  .retry(H.retry('topic-retries', { retries: 1, backoff: { initialMs: 600_000 } }), 'failed');

const dailyBudgetUsd = 40;
const topicCeilingUsd = 3;

const withinDailyBudget = H.policy.scheduler('within-daily-budget', view => {
  const startOfDay = new Date(view.now);
  startOfDay.setUTCHours(0, 0, 0, 0);
  const spentToday = view.metrics.sum({ of: 'costUsd', among: { entry: 'invocation' }, since: startOfDay }).value ?? 0;
  const projected =
    view.metrics.mean({ of: 'costUsd', among: { entry: 'attempt', kind: topic, outcome: 'succeeded' }, days: 30 }).value ?? topicCeilingUsd;
  let remaining = dailyBudgetUsd - spentToday - projected * view.active.length;
  const start: PendingView[] = [];
  for (const unit of view.pending) {
    if (remaining < projected) break;
    start.push(unit);
    remaining -= projected;
  }
  return { start };
});

export const researchSpend = H.report('research-spend', metrics => ({
  meanSucceededTopicUsd: metrics.mean({ of: 'costUsd', among: { entry: 'attempt', kind: topic, outcome: 'succeeded' }, days: 30 }),
  batchUsdToday: metrics.sum({ of: 'costUsd', among: { entry: 'invocation', executable: searchBatch }, days: 1 }),
  citationPassBySynthesizerModel: metrics.rateBy({
    among: citationRuns,
    count: { ...citationRuns, ok: true },
    by: { modelOf: synthesizer },
    days: 30,
  }),
}));

const operator = claudeCode.supervisor({
  grants: [H.ops.readWork, H.ops.writeWork, H.ops.resolve(H.parked), H.ops.readMemory, H.ops.readTelemetry],
});

export const researchPipeline = H.harness('research-pipeline')
  .ledger(sqlite.ledger('research.db'))
  .lanes(topics)
  .pools(researchPool)
  .scheduler(withinDailyBudget)
  .reports(researchSpend)
  .clients(operator)
  .observers(markdown.board('BOARD.md'), markdown.telemetry('TELEMETRY.md'));
