import { z } from 'zod';
import { H } from 'harness-dsl';
import type { PendingView, SupplyOf } from 'harness-dsl';
import * as anthropic from 'harness-dsl/anthropic';
import * as cc from 'harness-dsl/claude-code';
import * as sqlite from 'harness-dsl/sqlite';
import * as jsonl from 'harness-dsl/jsonl';
import * as qdrant from 'harness-dsl/qdrant';
import * as shell from 'harness-dsl/shell';
import * as markdown from 'harness-dsl/markdown';

const dailyBudgetUsd = 40;
const topicCeilingUsd = 3;
const searchAngles = 20;
const minimumSources = 5;

const open = H.state('open', 'pending');
const reported = H.state('reported', 'terminal', 'success');
const parked = H.state('parked', 'terminal', 'neutral');
const cancelled = H.state('cancelled', 'terminal', 'neutral');
const failed = H.state('failed', 'terminal', 'failure');

const topic = H.kind('Topic')
  .data(z.object({ title: z.string(), question: z.string(), tags: z.array(z.string()) }))
  .states(open, reported, parked, cancelled, failed);

const priorFindings = H.memory('prior-findings', 'experience');
const sourceExperience = H.memory('source-experience', 'experience');
const findingsJournal = H.library(
  'prior-findings-journal',
  priorFindings,
  qdrant.memory({
    url: 'http://localhost:6333',
    collection: 'research-findings',
    embedder: 'text-embedding-3-small',
    apiKey: H.env('QDRANT_API_KEY'),
  })
);
const sourceJournal = H.library('source-experience-journal', sourceExperience, jsonl.memory('memory/sources.jsonl'));

const apiAccount = anthropic.account('research-api', { apiKey: H.env('ANTHROPIC_API_KEY') });
const pool = H.pool('research-models', [{ account: apiAccount, share: 1 }]);
const haiku = anthropic.model('claude-haiku-4-5');
const opus = anthropic.model('claude-opus-4-1');
const sonnet = anthropic.model('claude-sonnet-4-5');

const synthesisModels = z.enum(['claude-opus-4-1', 'claude-sonnet-4-5']);
const synthesisModel = H.facet('synthesis-model', synthesisModels);

const local = shell.local('local', { slots: 2 });

const citationCheck = H.command('citation-check')
  .input(z.object({ citations: z.array(z.string()) }))
  .argv(input => ['check-citations', ...input.citations])
  .on(local)
  .recovery('rerun');

const synthesizerModel = H.policy.model('synthesizer-by-citation-pass-rate', [opus, sonnet], choice => {
  const passRate = choice.metrics.rateBy({
    by: synthesisModel,
    among: { entry: 'invocation', executable: citationCheck, status: 'ended' },
    count: { ok: true },
    days: 60,
  });
  const first = passRate['claude-opus-4-1'];
  const second = passRate['claude-sonnet-4-5'];
  if (first === undefined || first.samples < 15) return opus;
  if (second === undefined || second.samples < 15) return sonnet;
  return (second.value ?? 0) > (first.value ?? 0) ? sonnet : opus;
});

const finding = z.object({ claim: z.string(), source: z.string() });
type Finding = z.infer<typeof finding>;

const extractorRole = H.role('search-and-extract')
  .input(z.object({ question: z.string(), angle: z.number(), angles: z.number() }))
  .output(z.object({ findings: z.array(finding) }))
  .prompt(input => `Search angle ${input.angle + 1} of ${input.angles} for: ${input.question}. Extract sourced claims.`)
  .intents(['browse']);

const synthesizerRole = H.role('synthesizer')
  .input(z.object({ question: z.string(), findings: z.array(finding) }))
  .output(z.object({ report: z.string(), headline: z.string(), citations: z.array(z.string()) }))
  .prompt(input => `Write a sourced report answering: ${input.question}\n\n${input.findings.map(f => `- ${f.claim} (${f.source})`).join('\n')}`);

const extractor = H.seat('extractor', extractorRole).model(haiku).recalls(sourceJournal).records(sourceJournal);
const synthesizer = H.seat('synthesizer', synthesizerRole).model(synthesizerModel).recalls(findingsJournal, sourceJournal);

const research = H.flow('research-topic')
  .for(topic)
  .does(async ctx => {
    const { question, title } = ctx.unit.data;
    const inputs = Array.from({ length: searchAngles }, (_, angle) => ({ question, angle, angles: searchAngles }));
    const extracted = await ctx.batch(extractor, inputs);
    const findings: Finding[] = [];
    for (const result of extracted) {
      if (result.ok) findings.push(...result.value.findings);
    }
    const sources = new Set(findings.map(f => f.source));
    if (sources.size < minimumSources) return 'parked';
    const synthesized = await ctx.run(synthesizer, { question, findings });
    if (!synthesized.ok) return ctx.fail(synthesized.error);
    const used = synthesisModels.safeParse(synthesized.model);
    if (used.success) ctx.tag(synthesisModel.of(used.data));
    const checked = await ctx.run(citationCheck, { citations: synthesized.value.citations });
    if (!checked.ok) return ctx.fail(`a citation did not resolve: ${checked.error}`);
    await ctx.remember(findingsJournal, {
      text: `When researching questions like "${question}", start from this finding: ${synthesized.value.headline}`,
      because: `the report on "${title}" established it with ${sources.size} sources`,
      when: { kinds: [topic], roles: [synthesizerRole] },
    });
    return 'reported';
  });

const weeklyRecurring = H.clock('weekly-recurring-topics', topic, { weekly: { day: 'mon', at: '06:00' } }, tick =>
  tick.units
    .filter(unit => unit.position === 'terminal' && unit.data.tags.includes('recurring'))
    .map((unit): SupplyOf<typeof topic> => ({
      create: unit.data,
      key: `${unit.key.split('@')[0]}@${tick.now.toISOString().slice(0, 10)}`,
    }))
);

const retryOnce = H.policy.attemptRetry('retry-once', view => (view.failedAttempts >= 2 ? 'stop' : { retryInMs: 10 * 60 * 1000 }));

const topics = H.lane('topics', topic)
  .handler(research)
  .suppliers(H.operator, weeklyRecurring)
  .store(sqlite.store(topic, '.harness/topics.sqlite'))
  .wip(3)
  .maxUsdPerUnit(topicCeilingUsd)
  .retry(retryOnce, 'failed');

const withinDailyBudget = H.policy.scheduler('within-daily-budget', view => {
  const startOfDay = new Date(view.now.getTime());
  startOfDay.setUTCHours(0, 0, 0, 0);
  const spent = view.metrics.sum({ of: 'costUsd', among: { entry: 'invocation' }, since: startOfDay });
  const projected = view.metrics.mean({
    of: 'costUsd',
    among: { entry: 'attempt', status: 'ended', kind: topic, outcome: 'succeeded' },
    days: 30,
  });
  const perTopic = projected.value ?? topicCeilingUsd;
  let committed = (spent.value ?? 0) + perTopic * view.live.length;
  const start: PendingView[] = [];
  for (const unit of view.pending) {
    if (committed + perTopic > dailyBudgetUsd) break;
    committed += perTopic;
    start.push(unit);
  }
  return { start };
});

const supervisor = cc.supervisor({
  grants: [H.ops.readWork, H.ops.writeWork, H.ops.readMemory, H.ops.writeMemory, H.ops.readTelemetry],
});

export const researchPipeline = H.harness('research-pipeline')
  .ledger(sqlite.ledger('.harness/research.sqlite'))
  .lanes(topics)
  .pools(pool)
  .scheduler(withinDailyBudget)
  .clients(supervisor)
  .observers(markdown.board('BOARD.md'), markdown.telemetry('TELEMETRY.md'));

export const running = researchPipeline.start();
