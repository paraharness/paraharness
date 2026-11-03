import { H, type PendingView, type Rate, type Supply, type DataOf, type StateOf } from 'harness-dsl';
import * as cc from 'harness-dsl/claude-code';
import * as anthropic from 'harness-dsl/anthropic';
import * as sqlite from 'harness-dsl/sqlite';
import * as jsonl from 'harness-dsl/jsonl';
import * as qdrant from 'harness-dsl/qdrant';
import * as shell from 'harness-dsl/shell';
import * as markdown from 'harness-dsl/markdown';
import { z } from 'zod';

export const Topic = H.kind('Topic')
  .data(z.object({ title: z.string(), question: z.string(), tags: z.array(z.string()), report: z.string().optional() }))
  .states(
    [
      H.state('queued', 'pending'),
      H.state('researching', 'active'),
      H.state('delivered', 'terminal', 'success'),
      H.state('parked', 'terminal', 'neutral'),
      H.state('cancelled', 'terminal', 'neutral'),
      H.state('failed', 'terminal', 'failure'),
    ],
    { initial: 'queued', afterFailure: 'failed' }
  );

type TopicSupply = Supply<DataOf<typeof Topic>, StateOf<typeof Topic>>;

const searcherRole = H.role('search-and-extract')
  .input(z.object({ question: z.string(), angle: z.string() }))
  .output(z.object({ sources: z.array(z.object({ url: z.string(), claim: z.string() })) }))
  .prompt(i => `Find sources answering "${i.question}" from the angle: ${i.angle}. Extract one claim per source.`)
  .intents(['browse']);

const synthesizerRole = H.role('synthesizer')
  .input(z.object({ question: z.string(), sources: z.array(z.object({ url: z.string(), claim: z.string() })) }))
  .output(z.object({
    report: z.string(),
    citations: z.array(z.string()),
    findings: z.array(z.object({ statement: z.string(), confidence: z.number() })),
  }))
  .prompt(i => `Write a sourced report on "${i.question}".\n\n${i.sources.map(s => `${s.url}: ${s.claim}`).join('\n')}`);

const finding = H.memory('report-finding', 'fallible').data(z.object({ topic: z.string(), confidence: z.number() }));
const sourceExperience = H.memory('source-experience', 'fallible');

const mostSimilarFindings = H.policy.recall('most-similar-findings', view =>
  view.items
    .filter(item => (item.similarity ?? 0) >= 0.75)
    .sort((a, b) => (b.similarity ?? 0) - (a.similarity ?? 0))
    .slice(0, 8)
);

const mostSpecificFirst = H.policy.recall('most-specific-then-track-record', view =>
  [...view.items]
    .sort((a, b) => b.specificity - a.specificity || (b.trackRecord.value ?? 0) - (a.trackRecord.value ?? 0))
    .slice(0, 10)
);

const findingsLibrary = H.library(
  'prior-findings',
  finding,
  qdrant.memory({ url: 'https://vectors.example.com', collection: 'findings', embedder: 'text-embedding-3-small', apiKey: H.env('QDRANT_API_KEY') })
).recall(mostSimilarFindings);

const sourceLibrary = H.library('source-experience', sourceExperience, jsonl.memory('.harness/source-experience.jsonl')).recall(mostSpecificFirst);

const local = shell.local('local', { slots: 2 });

const citationCheck = H.command('citation-check')
  .input(z.object({ citations: z.array(z.string()) }))
  .argv(i => ['./scripts/check-citations.sh', ...i.citations])
  .on(local);

const haiku = anthropic.model('claude-haiku-4-5');
const opus = anthropic.model('claude-opus-4-1');
const sonnet = anthropic.model('claude-sonnet-4-5');

const unsampled: Rate = { value: null, hits: 0, samples: 0 };

const synthesizerModel = H.policy.model('higher-citation-pass-rate', choice => {
  const byModel = choice.metrics.rateBy({
    among: { entry: 'invocation', executable: citationCheck.name, phase: 'ended' },
    count: { entry: 'invocation', executable: citationCheck.name, phase: 'ended', ok: true },
    by: { tag: 'synthesizer' },
    days: 60,
  });
  const opusRate = byModel[opus.name] ?? unsampled;
  const sonnetRate = byModel[sonnet.name] ?? unsampled;
  if (opusRate.samples < 20 || sonnetRate.samples < 20) return opusRate.samples <= sonnetRate.samples ? opus : sonnet;
  return (sonnetRate.value ?? 0) > (opusRate.value ?? 0) ? sonnet : opus;
});

const searcher = H.agent('searcher', searcherRole).model(haiku).recalls(sourceLibrary);
const synthesizer = H.agent('synthesizer', synthesizerRole).model(synthesizerModel).recalls(findingsLibrary, sourceLibrary);

const searchAngles = Array.from({ length: 20 }, (_, index) => `perspective ${index + 1} of 20`);

const research = H.flow('research-topic')
  .for(Topic)
  .does(async ctx => {
    await ctx.move('researching');
    const { title, question } = ctx.unit.data;
    const extracted = await ctx.batch(searcher, searchAngles.map(angle => ({ question, angle })));
    const sources = extracted.flatMap(result => (result.ok ? result.value.sources : []));
    if (sources.length < 5) return 'parked';

    const synthesized = await ctx.run(synthesizer, { question, sources });
    if (!synthesized.ok) return ctx.fail(synthesized.error);
    ctx.tag({ synthesizer: synthesized.model ?? 'unknown' });

    const checked = await ctx.run(citationCheck, { citations: synthesized.value.citations });
    if (!checked.ok) return ctx.fail(`a citation did not resolve: ${checked.error}`);

    await ctx.update({ report: synthesized.value.report });
    for (const item of synthesized.value.findings) {
      await ctx.remember(findingsLibrary, {
        text: `when researching questions like "${question}", start from: ${item.statement}`,
        because: `the delivered report "${title}" established it`,
        when: { kinds: [Topic.name], roles: [synthesizerRole.name] },
        status: 'accepted',
        data: { topic: ctx.unit.key, confidence: item.confidence },
      });
    }
    return 'delivered';
  });

const recurringTopics = H.calendar('recurring-topics', Topic, { weekly: { day: 'mon', at: '06:00' } }, tick =>
  tick.units
    .filter(unit => unit.position === 'terminal' && unit.data.tags.includes('recurring'))
    .map((unit): TopicSupply => ({ update: unit.key, state: 'queued' }))
);

const topicCeilingUsd = 3;
const dailyBudgetUsd = 40;

const topicLane = H.lane('topics', Topic)
  .handler(research)
  .suppliers(H.operator, recurringTopics)
  .store(sqlite.store(Topic, '.harness/topics.db'))
  .maxUsdPerUnit(topicCeilingUsd);

const withinDailyBudget = H.policy.scheduler('within-daily-budget', view => {
  const dayStart = new Date(Date.UTC(view.now.getUTCFullYear(), view.now.getUTCMonth(), view.now.getUTCDate()));
  const spentToday = view.metrics.sum({ of: 'costUsd', among: { entry: 'invocation', phase: 'ended' }, since: dayStart });
  const projected = view.metrics.mean({ of: 'costUsd', among: { entry: 'attempt', kind: Topic.name, outcome: 'succeeded' }, days: 30 });
  const projectedPerTopic = projected.value ?? topicCeilingUsd;
  let remaining = dailyBudgetUsd - (spentToday.value ?? 0) - projectedPerTopic * view.active.length;
  const start: PendingView[] = [];
  for (const unit of [...view.pending].sort((a, b) => b.waitedMs - a.waitedMs)) {
    if (projectedPerTopic > remaining) break;
    start.push(unit);
    remaining -= projectedPerTopic;
  }
  return { start };
});

const apiAccount = anthropic.account('anthropic-api', { apiKey: H.env('ANTHROPIC_API_KEY') });
const firstEligible = H.policy.account('first-eligible', choice => choice.accounts.find(view => view.eligible)?.account ?? null);

export const researchPipeline = H.harness('research-pipeline')
  .ledger(sqlite.ledger('.harness/ledger.db'))
  .lanes(topicLane)
  .pools(H.pool('anthropic', [{ account: apiAccount, share: 1 }], firstEligible))
  .scheduler(withinDailyBudget)
  .clients(cc.supervisor({ grants: [H.ops.readWork, H.ops.writeWork, H.ops.readMemory, H.ops.curateMemory, H.ops.readTelemetry] }))
  .observers(markdown.board('BOARD.md'), markdown.telemetry('TELEMETRY.md'));
