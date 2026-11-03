import { H, type Model, type SupplyOf } from 'harness-dsl';
import { z } from 'zod';
import * as claudeCode from 'harness-dsl/claude-code';
import * as anthropic from 'harness-dsl/anthropic';
import * as sqlite from 'harness-dsl/sqlite';
import * as jsonl from 'harness-dsl/jsonl';
import * as qdrant from 'harness-dsl/qdrant';
import * as shell from 'harness-dsl/shell';
import * as markdown from 'harness-dsl/markdown';

const Topic = H.kind('topic')
  .data(
    z.object({
      title: z.string(),
      question: z.string(),
      recurring: z.boolean(),
      report: z.string().optional(),
    })
  )
  .states(
    [
      H.state('topic-queued', 'pending'),
      H.state('researching', 'active'),
      H.state('reported', { terminal: 'success' }),
      H.state('parked', { terminal: 'neutral' }),
      H.state('topic-cancelled', { terminal: 'neutral' }),
      H.state('topic-failed', { terminal: 'failure' }),
    ],
    'topic-queued'
  )
  .failsTo('topic-failed');

const Findings = H.memory('prior-findings', 'fallible');
const SourceExperience = H.memory('source-experience', 'fallible');

const mostSimilar = H.policy.recall('most-similar-findings', (view) =>
  [...view.items]
    .filter((item) => item.status === 'accepted')
    .sort((a, b) => (b.similarity ?? 0) - (a.similarity ?? 0) || b.specificity - a.specificity)
    .slice(0, 8)
);

const specificThenProven = H.policy.recall('specific-then-proven', (view) =>
  [...view.items]
    .filter((item) => item.status === 'accepted')
    .sort((a, b) => b.specificity - a.specificity || (b.trackRecord.value ?? 0) - (a.trackRecord.value ?? 0))
    .slice(0, 10)
);

const priorFindings = H.library(
  'prior-findings',
  Findings,
  qdrant.memory({
    url: 'https://vectors.example.com',
    collection: 'research-findings',
    embedder: 'text-embedding-3-small',
    apiKey: H.env('QDRANT_API_KEY'),
  })
).recall(mostSimilar);

const sourceExperience = H.library('source-experience', SourceExperience, jsonl.memory('memory/sources.jsonl')).recall(
  specificThenProven
);

const haiku = anthropic.model('claude-haiku-4-5');
const opus = anthropic.model('claude-opus-4-1');
const sonnet = anthropic.model('claude-sonnet-4-5');

const local = shell.local('local', { slots: 4 });

const searchSources = H.command('search-sources')
  .input(z.object({ question: z.string() }))
  .output(z.object({ sources: z.array(z.string()) }))
  .argv((input) => ['research-search', '--limit', '20', input.question])
  .on(local)
  .restart('rerun');

const citationCheck = H.command('citation-check')
  .input(z.object({ report: z.string() }))
  .argv((input) => ['citation-check', '--report', input.report])
  .on(local)
  .restart('rerun');

const byCitationPassRate = H.policy.model('synthesizer-by-citation-pass-rate', (choice) => {
  const passRate = (model: Model) =>
    choice.metrics.rate({
      among: { entry: 'invocation', executable: citationCheck.name, status: 'ended', tags: { synthesizer: model.name } },
      count: { ok: true },
      days: 30,
    });
  const first = passRate(opus);
  const second = passRate(sonnet);
  if (first.samples < 30 || second.samples < 30) return first.samples <= second.samples ? opus : sonnet;
  return (first.value ?? 0) >= (second.value ?? 0) ? opus : sonnet;
});

const firstEligible = H.policy.account('first-eligible', (choice) => choice.accounts.find((view) => view.eligible)?.account ?? null);

const apiPool = H.pool(
  'api',
  [{ account: anthropic.account('research-api', { apiKey: H.env('ANTHROPIC_API_KEY') }), share: 1 }],
  firstEligible
);

const claim = z.object({ claim: z.string(), citation: z.string() });

const extractorRole = H.role('extractor')
  .input(z.object({ question: z.string(), source: z.string() }))
  .output(z.object({ claims: z.array(claim) }))
  .prompt((input) => `Read ${input.source} and extract every claim relevant to: ${input.question}. Cite each one.`)
  .intents(['browse']);

const synthesizerRole = H.role('synthesizer')
  .input(z.object({ question: z.string(), claims: z.array(claim) }))
  .output(z.object({ report: z.string(), findings: z.array(z.string()) }))
  .prompt((input) =>
    `Write a sourced report answering: ${input.question}\n\nClaims:\n${input.claims.map((c) => `- ${c.claim} [${c.citation}]`).join('\n')}`
  );

const extractor = H.agent('extractor', extractorRole).model(haiku).recalls(sourceExperience);
const synthesizer = H.agent('synthesizer', synthesizerRole).model(byCitationPassRate).recalls(priorFindings, sourceExperience);

const minimumSources = 5;
const minimumClaims = 10;

const researchFlow = H.flow('research').for(Topic).does(async (ctx) => {
  const { title, question } = ctx.unit.data;
  await ctx.move('researching');
  const searched = await ctx.run(searchSources, { question });
  if (!searched.ok) return ctx.fail(searched.error);
  const sources = searched.value.sources.slice(0, 20);
  if (sources.length < minimumSources) return 'parked';
  const extracted = await ctx.batch(
    extractor,
    sources.map((source) => ({ question, source }))
  );
  const claims = extracted.flatMap((result) => (result.ok ? result.value.claims : []));
  if (claims.length < minimumClaims) return 'parked';
  const synthesized = await ctx.run(synthesizer, { question, claims });
  if (!synthesized.ok) return ctx.fail(synthesized.error);
  ctx.tag({ synthesizer: synthesized.model ?? synthesizer.name });
  const checked = await ctx.run(citationCheck, { report: synthesized.value.report });
  if (!checked.ok) return ctx.fail(`a citation did not resolve: ${checked.error}`);
  await ctx.update({ report: synthesized.value.report });
  for (const finding of synthesized.value.findings) {
    await ctx.remember(priorFindings, {
      text: `When researching questions like "${question}", start from: ${finding}`,
      because: `it was sourced and citation-checked in the report on ${title}`,
      when: { kinds: [Topic] },
    });
  }
  return 'reported';
});

const weeklyRecurring = H.timetable('reopen-recurring-weekly', Topic, { weekly: { day: 'mon', at: '06:00' } }, (tick) =>
  tick.units
    .filter((unit) => unit.data.recurring && unit.position === 'terminal')
    .map((unit): SupplyOf<typeof Topic> => ({ update: unit.key, state: 'topic-queued' }))
);

const topicLane = H.lane('topics', Topic)
  .handler(researchFlow)
  .suppliers(H.operator, weeklyRecurring)
  .store(sqlite.store(Topic, '.harness/topics.sqlite'))
  .maxUsdPerUnit(3);

const dailyBudgetUsd = 40;
const topicCeilingUsd = 3;

const withinDailyBudget = H.policy.scheduler('within-daily-budget', (view) => {
  const midnight = new Date(view.now.getFullYear(), view.now.getMonth(), view.now.getDate());
  const spentToday = view.metrics.sum({ of: 'costUsd', among: { entry: 'invocation', status: 'ended' }, since: midnight });
  const projected = view.metrics.mean({
    of: 'costUsd',
    among: { entry: 'attempt', status: 'ended', outcome: 'succeeded', kind: Topic.name },
  });
  const perTopicUsd = projected.value ?? topicCeilingUsd;
  let remainingUsd = dailyBudgetUsd - (spentToday.value ?? 0) - perTopicUsd * view.active.length;
  const start = [...view.pending]
    .sort((a, b) => b.waitedMs - a.waitedMs)
    .filter(() => {
      if (perTopicUsd > remainingUsd) return false;
      remainingUsd -= perTopicUsd;
      return true;
    });
  return { start };
});

const supervisor = claudeCode.supervisor({
  grants: [H.ops.readWork, H.ops.writeWork, H.ops.resolveHalts, H.ops.readMemory, H.ops.writeMemory, H.ops.readTelemetry],
});

export const researchPipeline = H.harness('research-pipeline')
  .ledger(sqlite.ledger('.harness/research.sqlite'))
  .lanes(topicLane)
  .pools(apiPool)
  .scheduler(withinDailyBudget)
  .clients(supervisor)
  .observers(markdown.board('BOARD.md'), markdown.telemetry('TELEMETRY.md'));
