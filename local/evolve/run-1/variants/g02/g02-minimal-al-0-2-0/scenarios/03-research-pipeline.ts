import { H, type PendingView, type Model, type Rate } from 'harness-dsl';
import { z } from 'zod';
import * as anthropic from 'harness-dsl/anthropic';
import * as sqlite from 'harness-dsl/sqlite';
import * as jsonl from 'harness-dsl/jsonl';
import * as qdrant from 'harness-dsl/qdrant';
import * as shell from 'harness-dsl/shell';
import * as cc from 'harness-dsl/claude-code';
import * as markdown from 'harness-dsl/markdown';

export const open = H.state('open', 'pending');
export const researching = H.state('researching', 'active');
export const reported = H.state('reported', 'terminal', 'success');
export const parked = H.state('parked', 'terminal', 'neutral');
export const withdrawn = H.state('withdrawn', 'terminal', 'neutral');
export const unsourced = H.state('unsourced', 'terminal', 'failure');

export const Topic = H.kind('Topic')
  .data(z.object({
    question: z.string(),
    tags: z.array(z.string()),
    report: z.string().optional(),
  }))
  .states(open, researching, reported, parked, withdrawn, unsourced)
  .failsTo('unsourced');

const finding = z.object({ claim: z.string(), source: z.string() });
type Finding = z.infer<typeof finding>;

export const extractorRole = H.role('search-and-extract')
  .input(z.object({ question: z.string(), slice: z.number(), of: z.number() }))
  .output(z.object({ findings: z.array(finding) }))
  .prompt((input) => `Search angle ${input.slice + 1} of ${input.of} for: ${input.question}. Extract sourced claims.`)
  .intents(['browse']);

export const synthesizerRole = H.role('synthesizer')
  .input(z.object({ question: z.string(), findings: z.array(finding) }))
  .output(z.object({ report: z.string(), headline: z.string() }))
  .prompt((input) => `Write a sourced report answering: ${input.question}\n\n${input.findings.map((f) => `- ${f.claim} [${f.source}]`).join('\n')}`);

export const priorFindings = H.memory('prior-findings', 'experience');
export const sourceExperience = H.memory('source-experience', 'experience');

export const findingsArchive = H.archive('prior-findings', priorFindings, qdrant.memory({
  url: 'https://vectors.internal:6333',
  collection: 'prior-findings',
  embedder: 'text-embedding-small',
  apiKey: H.env('QDRANT_API_KEY'),
}));
export const sourceArchive = H.archive('source-experience', sourceExperience, jsonl.memory('.harness/sources.jsonl'));

export const similarFirst = H.policy.recall('similar-findings-first', (view) =>
  [...view.items]
    .filter((item) => item.memory === sourceExperience.name || (item.similarity ?? 0) >= 0.75)
    .sort((a, b) => (b.similarity ?? 0) - (a.similarity ?? 0) || b.specificity - a.specificity)
    .slice(0, 12));

export const synthesizerBriefing = H.briefing('synthesizer-briefing', [findingsArchive, sourceArchive], similarFirst);

export const apiAccount = anthropic.account('anthropic-api', { apiKey: H.env('ANTHROPIC_API_KEY') });
export const researchPool = H.pool('research', [{ account: apiAccount, share: 1 }]);

export const cheapModel = anthropic.model('claude-haiku');
export const opus = anthropic.model('claude-opus');
export const sonnet = anthropic.model('claude-sonnet');

export const synthesisModel = H.tag('synthesis-model');

export const local = shell.local('local', { slots: 2 });

export const citationCheck = H.command('citation-check')
  .input(z.object({ report: z.string() }))
  .argv((input) => ['cite-check', '--report', input.report])
  .on(local)
  .recovers('rerun');

export const citationPassRate = (metrics: { rate: (q: { readonly among: object; readonly count: object; readonly days: number }) => Rate }, model: Model): Rate =>
  metrics.rate({
    among: { entry: 'invocation', executable: citationCheck, tags: [synthesisModel.is(model.name)] },
    count: { entry: 'invocation', executable: citationCheck, ok: true, tags: [synthesisModel.is(model.name)] },
    days: 30,
  });

export const synthesizerChoice = H.policy.model('citation-pass-rate', (choice) => {
  const byModel = (model: Model): Rate => choice.metrics.rate({
    among: { entry: 'invocation', executable: citationCheck, tags: [synthesisModel.is(model.name)] },
    count: { entry: 'invocation', executable: citationCheck, ok: true, tags: [synthesisModel.is(model.name)] },
    days: 30,
  });
  const forOpus = byModel(opus);
  const forSonnet = byModel(sonnet);
  if (forOpus.samples < 30 || forSonnet.samples < 30) return forOpus.samples <= forSonnet.samples ? opus : sonnet;
  return (forOpus.value ?? 0) >= (forSonnet.value ?? 0) ? opus : sonnet;
});

export const extractor = H.agent('extractor', extractorRole).model(cheapModel);
export const synthesizer = H.agent('synthesizer', synthesizerRole)
  .model(synthesizerChoice)
  .recalls(synthesizerBriefing)
  .records(sourceArchive);

const searchFanOut = 20;
const minimumFindings = 5;

export const researchFlow = H.flow('research-topic')
  .for(Topic)
  .does(async (ctx) => {
    await ctx.move('researching');
    const { question } = ctx.unit.data;
    const slices = Array.from({ length: searchFanOut }, (_, slice) => ({ question, slice, of: searchFanOut }));
    const extracted = await ctx.batch(extractor, slices);
    const findings: Finding[] = [];
    for (const result of extracted) {
      if (result.ok) findings.push(...result.value.findings);
    }
    if (findings.length < minimumFindings) return 'parked';
    const synthesis = await ctx.run(synthesizer, { question, findings });
    if (synthesis.ok === false) return ctx.fail(synthesis.error);
    ctx.tag(synthesisModel, synthesis.model ?? sonnet.name);
    const checked = await ctx.run(citationCheck, { report: synthesis.value.report });
    if (checked.ok === false) return ctx.fail(`a citation did not resolve: ${checked.error}`);
    await ctx.update({ report: synthesis.value.report });
    await ctx.remember(findingsArchive, {
      text: `When researching "${question}", start from the finding: ${synthesis.value.headline}`,
      because: 'a prior report with resolving citations established it',
      when: { kinds: [Topic.name], roles: [synthesizerRole.name] },
    });
    return 'reported';
  });

export const recurringReopen = H.clock('weekly-recurring', Topic, { weekly: { day: 'mon', at: '06:00' } }, (tick) =>
  tick.units
    .filter((unit) => unit.position === 'terminal' && unit.data.tags.includes('recurring'))
    .map((unit) => ({ create: { question: unit.data.question, tags: unit.data.tags }, key: unit.key })));

export const citationRetry = H.policy.retry('two-tries-then-unsourced', (view) =>
  view.failures < 2 ? { retryInMs: 10 * 60_000 } : 'stop');

const topicCeilingUsd = 3;
const dailyBudgetUsd = 40;

export const topicLane = H.lane('topics', Topic)
  .handler(researchFlow)
  .suppliers(H.operator, recurringReopen)
  .store(sqlite.store(Topic, '.harness/topics.db'))
  .maxUsdPerUnit(topicCeilingUsd)
  .retry(citationRetry);

export const dailyBudget = H.policy.scheduler('daily-budget', (view) => {
  const midnight = new Date(view.now);
  midnight.setHours(0, 0, 0, 0);
  const spentUsd = view.metrics.sum({ of: 'costUsd', among: { entry: 'invocation' }, since: midnight }).value ?? 0;
  const projected = view.metrics.mean({
    of: 'costUsd',
    among: { entry: 'attempt', status: 'ended', kind: Topic, outcome: 'succeeded' },
    days: 30,
  });
  const perTopicUsd = projected.value ?? topicCeilingUsd;
  let remainingUsd = dailyBudgetUsd - spentUsd - view.active.length * perTopicUsd;
  const start: PendingView[] = [];
  for (const unit of view.pending) {
    if (remainingUsd < perTopicUsd) break;
    start.push(unit);
    remainingUsd -= perTopicUsd;
  }
  return { start };
});

export const supervisor = cc.supervisor({
  grants: [H.ops.readWork, H.ops.writeWork, H.ops.readMemory, H.ops.curateMemory, H.ops.readTelemetry],
});

export const researchPipeline = H.harness('research-pipeline')
  .ledger(sqlite.ledger('.harness/ledger.db'))
  .lanes(topicLane)
  .pools(researchPool)
  .scheduler(dailyBudget)
  .clients(supervisor)
  .observers(markdown.board('BOARD.md'), markdown.telemetry('TELEMETRY.md'));
