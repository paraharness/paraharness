import { H } from 'harness-dsl';
import type { Rate, SupplyOf } from 'harness-dsl';
import { z } from 'zod';
import * as anthropic from 'harness-dsl/anthropic';
import * as claude from 'harness-dsl/claude-code';
import * as sqlite from 'harness-dsl/sqlite';
import * as jsonl from 'harness-dsl/jsonl';
import * as qdrant from 'harness-dsl/qdrant';
import * as shell from 'harness-dsl/shell';
import * as markdown from 'harness-dsl/markdown';

const topicOpen = H.state('topic-open', 'pending');
const researching = H.state('topic-researching', 'active');
const reportDelivered = H.state('report-delivered', 'terminal', 'success');
const topicParked = H.state('topic-parked', 'terminal', 'neutral');
const topicCancelled = H.state('topic-cancelled', 'terminal', 'neutral');

const topicData = z.object({
  slug: z.string(),
  question: z.string(),
  tags: z.array(z.string()),
  report: z.string().nullable(),
});

export const Topic = H.kind('topic')
  .data(topicData)
  .states(topicOpen, researching, reportDelivered, topicParked, topicCancelled);

const finding = z.object({ claim: z.string(), sourceUrl: z.string() });

const extractorRole = H.role('search-extractor')
  .input(z.object({ question: z.string(), facet: z.number() }))
  .output(z.object({ findings: z.array(finding) }))
  .prompt((input) => `Search facet ${input.facet} of 20 for: ${input.question}. Extract sourced claims.`)
  .intents(['browse']);

const synthesizerRole = H.role('synthesizer')
  .input(z.object({ question: z.string(), findings: z.array(finding) }))
  .output(z.object({ report: z.string(), keyFindings: z.array(z.string()) }))
  .prompt((input) =>
    `Write a sourced report answering: ${input.question}\n\nFindings:\n${input.findings.map((item) => `- ${item.claim} (${item.sourceUrl})`).join('\n')}`);

const haiku = anthropic.model('claude-haiku-4-5');
const opus = anthropic.model('claude-opus-4-1');
const sonnet = anthropic.model('claude-sonnet-4-5');

const local = shell.local('local', { slots: 2 });

const citationCheck = H.command('citation-check')
  .input(z.object({ report: z.string() }))
  .argv((input) => ['citation-check', '--text', input.report])
  .on(local);

const noSamples: Rate = { value: null, hits: 0, samples: 0 };
const rateOf = (rates: Readonly<Record<string, Rate>>, key: string): Rate => rates[key] ?? noSamples;

const synthesizerModel = H.policy.model('synthesizer-model', ({ metrics }) => {
  const passByModel = metrics.rateBy({
    among: { entry: 'invocation', executable: citationCheck, status: 'ended' },
    count: { entry: 'invocation', executable: citationCheck, status: 'ended', ok: true },
    byTag: 'synthesizer',
    days: 30,
  });
  const first = rateOf(passByModel, opus.name);
  const second = rateOf(passByModel, sonnet.name);
  if (first.samples < 20 || second.samples < 20) return first.samples <= second.samples ? opus : sonnet;
  if (first.value === null || second.value === null) return opus;
  return first.value >= second.value ? opus : sonnet;
});

const priorFindings = H.library(
  'prior-findings',
  H.memory('report-findings', 'experience'),
  qdrant.memory({
    url: 'https://vectors.example.com',
    collection: 'report-findings',
    embedder: 'text-embedding-3-small',
    apiKey: H.env('QDRANT_API_KEY'),
  }),
);
const sourceExperience = H.library(
  'source-experience',
  H.memory('source-experience', 'experience'),
  jsonl.memory('.harness/source-experience.jsonl'),
);

const extractor = H.agent('search-extractor', extractorRole).model(haiku);
const synthesizer = H.agent('synthesizer', synthesizerRole)
  .model(synthesizerModel)
  .recalls(priorFindings, sourceExperience)
  .records(sourceExperience);

const research = H.flow('research').for(Topic).does(async (ctx) => {
  await ctx.move('topic-researching');
  const { question } = ctx.unit.data;
  const extracted = await ctx.batch(
    extractor,
    Array.from({ length: 20 }, (_, index) => ({ question, facet: index + 1 })),
  );
  const findings = extracted.flatMap((result) => (result.ok ? result.value.findings : []));
  if (findings.length < 5) return 'topic-parked';
  const synthesized = await ctx.run(synthesizer, { question, findings });
  if (!synthesized.ok) return ctx.fail(synthesized.error);
  ctx.tag({ synthesizer: synthesized.model ?? 'unknown' });
  const cited = await ctx.run(citationCheck, { report: synthesized.value.report });
  if (!cited.ok) return ctx.fail(`unresolved citation: ${cited.error}`);
  await ctx.update({ report: synthesized.value.report });
  for (const keyFinding of synthesized.value.keyFindings) {
    await ctx.remember(priorFindings, {
      text: `When researching ${question}, start from: ${keyFinding}`,
      because: `report ${ctx.unit.key} established it with resolved citations`,
      when: { kinds: [Topic.name] },
    });
  }
  return 'report-delivered';
});

const recurringTopics = H.clock('recurring-topics', Topic, { weekly: { day: 'mon', at: '06:00' } }, ({ now, units }) => {
  const openSlugs = new Set(units.filter((unit) => unit.position !== 'terminal').map((unit) => unit.data.slug));
  const reopen = new Map<string, z.infer<typeof topicData>>();
  for (const unit of units) {
    if (unit.position === 'terminal' && unit.data.tags.includes('recurring') && !openSlugs.has(unit.data.slug)) {
      reopen.set(unit.data.slug, unit.data);
    }
  }
  return [...reopen.values()].map((data): SupplyOf<typeof Topic> => ({
    create: { ...data, report: null },
    key: `${data.slug}@${now.toISOString().slice(0, 10)}`,
  }));
});

export const topics = H.lane('topics', Topic)
  .handler(research)
  .suppliers(H.operator, recurringTopics)
  .store(sqlite.store(Topic, '.harness/topics.db'))
  .maxUsdPerUnit(3);

const dailyBudgetUsd = 40;
const topicCeilingUsd = 3;

const withinDailyBudget = H.policy.scheduler('within-daily-budget', ({ now, pending, active, metrics }) => {
  const dayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const spentUsd = metrics.sum({ of: 'costUsd', among: { entry: 'invocation', kind: Topic, status: 'ended' }, since: dayStart }).value ?? 0;
  const projectedUsd = metrics.mean({
    of: 'costUsd',
    among: { entry: 'attempt', kind: Topic, status: 'ended', outcome: 'succeeded' },
    days: 30,
  }).value ?? topicCeilingUsd;
  const remainingUsd = dailyBudgetUsd - spentUsd - projectedUsd * active.length;
  const affordable = projectedUsd > 0 ? Math.max(0, Math.floor(remainingUsd / projectedUsd)) : pending.length;
  return { start: [...pending].sort((a, b) => b.waitedMs - a.waitedMs).slice(0, affordable) };
});

const apiAccount = anthropic.account('anthropic-api', { apiKey: H.env('ANTHROPIC_API_KEY') });

const operator = claude.supervisor({
  grants: [
    H.ops.readWork,
    H.ops.writeWork,
    H.ops.resolveHalts,
    H.ops.readMemory,
    H.ops.curateMemory,
    H.ops.readTelemetry,
  ],
});

export const researchPipeline = H.harness('research-pipeline')
  .ledger(sqlite.ledger('.harness/ledger.db'))
  .lanes(topics)
  .pools(H.pool('anthropic', [{ account: apiAccount, share: 1 }]))
  .scheduler(withinDailyBudget)
  .clients(operator)
  .observers(markdown.board('.harness/board.md'), markdown.telemetry('.harness/telemetry.md'));

export const running = researchPipeline.start();
