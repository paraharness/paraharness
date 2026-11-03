import { z } from 'zod';
import { H } from 'harness-dsl';
import type { Rate } from 'harness-dsl';
import * as claudeCode from 'harness-dsl/claude-code';
import * as anthropic from 'harness-dsl/anthropic';
import * as sqlite from 'harness-dsl/sqlite';
import * as jsonl from 'harness-dsl/jsonl';
import * as qdrant from 'harness-dsl/qdrant';
import * as shell from 'harness-dsl/shell';
import * as markdown from 'harness-dsl/markdown';

const Queued = H.state('queued', 'pending');
const Searching = H.state('searching', 'active');
const Synthesizing = H.state('synthesizing', 'active');
const Checking = H.state('checking', 'active');
const Delivered = H.state('delivered', 'terminal', 'success');
const Parked = H.state('parked', 'terminal', 'neutral');
const Cancelled = H.state('cancelled', 'terminal', 'neutral');
const Failed = H.state('failed', 'terminal', 'failure');

const Topic = H.kind('Topic')
  .data(z.object({
    question: z.string(),
    tags: z.array(z.string()),
    report: z.string().optional(),
  }))
  .states([Queued, Searching, Synthesizing, Checking, Delivered, Parked, Cancelled, Failed], {
    initial: 'queued',
    afterFailure: 'failed',
    afterCancel: 'cancelled',
  });

const sourceSchema = z.object({ url: z.string(), claim: z.string(), confidence: z.number() });

const searcherRole = H.role('searcher')
  .input(z.object({ question: z.string(), query: z.string() }))
  .output(z.object({ sources: z.array(sourceSchema) }))
  .prompt(input => `Research question: ${input.question}\n\nSearch for: ${input.query}\n\nReturn each source with its URL, the claim it supports and your confidence from 0 to 1.`)
  .intents(['browse']);

const synthesizerRole = H.role('synthesizer')
  .input(z.object({ question: z.string(), sources: z.array(sourceSchema) }))
  .output(z.object({ report: z.string(), findings: z.array(z.string()) }))
  .prompt(input => `Write a sourced report answering: ${input.question}\n\nCite every claim by URL.\n\nSources:\n${input.sources.map(s => `- ${s.url} (${s.confidence}): ${s.claim}`).join('\n')}`)
  .intents([]);

const priorFinding = H.memory('prior-finding', 'fallible');
const sourceExperience = H.memory('source-experience', 'fallible');

const mostSimilar = H.policy.recall('most-similar-accepted', view =>
  [...view.items]
    .filter(item => item.status === 'accepted' && (item.similarity ?? 0) >= 0.75)
    .sort((a, b) => (b.similarity ?? 0) - (a.similarity ?? 0) || b.specificity - a.specificity)
    .slice(0, 10));

const specificityThenRecord = H.policy.recall('specificity-then-record', view =>
  [...view.items]
    .filter(item => item.status === 'accepted')
    .sort((a, b) =>
      b.specificity - a.specificity || (b.trackRecord.value ?? 0) - (a.trackRecord.value ?? 0))
    .slice(0, 10));

const findings = H.library('prior-findings', priorFinding, qdrant.memory({
  url: 'https://vectors.example.com',
  collection: 'research-findings',
  embedder: 'text-embedding-3-small',
  apiKey: H.env('QDRANT_API_KEY'),
})).recall(mostSimilar);

const sourceLessons = H.library('source-lessons', sourceExperience, jsonl.memory('memory/sources.jsonl'))
  .recall(specificityThenRecord);

const haiku = anthropic.model('claude-haiku-4-5');
const opus = anthropic.model('claude-opus-4-1');
const sonnet = anthropic.model('claude-sonnet-4-5');

const unsampled: Rate = { value: null, hits: 0, samples: 0 };

const synthesizerModel = H.policy.model('citation-pass-rate', choice => {
  const byModel = choice.metrics.rateBy({
    among: { entry: 'invocation', executable: 'citation-check' },
    count: { entry: 'invocation', executable: 'citation-check', ok: true },
    by: { tag: 'synthModel' },
    days: 30,
  });
  const opusRate = byModel[opus.name] ?? unsampled;
  const sonnetRate = byModel[sonnet.name] ?? unsampled;
  if (opusRate.samples < 20) return opus;
  if (sonnetRate.samples < 20) return sonnet;
  return (sonnetRate.value ?? 0) > (opusRate.value ?? 0) ? sonnet : opus;
});

const searcher = H.agent('searcher', searcherRole)
  .model(haiku)
  .recalls(sourceLessons);

const synthesizer = H.agent('synthesizer', synthesizerRole)
  .model(synthesizerModel)
  .recalls(findings, sourceLessons);

const local = shell.local('local', { slots: 2 });

const planQueries = H.command('plan-queries')
  .input(z.object({ question: z.string() }))
  .output(z.array(z.string()))
  .argv(input => ['research-plan', '--count', '20', '--question', input.question])
  .on(local)
  .restart('rerun');

const citationCheck = H.command('citation-check')
  .input(z.object({ topic: z.string() }))
  .argv(input => ['citation-check', '--topic', input.topic])
  .on(local)
  .restart('rerun');

const minimumSources = 5;

const researchFlow = H.flow('research')
  .for(Topic)
  .does(async ctx => {
    const question = ctx.unit.data.question;
    await ctx.move('searching');
    const queries = await ctx.run(planQueries, { question });
    if (!queries.ok) return ctx.fail(queries.error);

    const extracted = await ctx.batch(searcher, queries.value.map(query => ({ question, query })));
    const sources = extracted.flatMap(result => result.ok ? result.value.sources : []);
    if (sources.length < minimumSources) return 'parked';

    await ctx.move('synthesizing');
    const synthesis = await ctx.run(synthesizer, { question, sources });
    if (!synthesis.ok) return ctx.fail(synthesis.error);
    ctx.tag({ synthModel: synthesis.model ?? 'unknown' });
    await ctx.update({ report: synthesis.value.report });

    await ctx.move('checking');
    const checked = await ctx.run(citationCheck, { topic: ctx.unit.key });
    if (!checked.ok) return ctx.fail(`a citation did not resolve: ${checked.error}`);

    for (const finding of synthesis.value.findings) {
      await ctx.remember(findings, {
        text: `When researching a question like "${question}", start from this finding: ${finding}`,
        because: 'it was a cited finding of a delivered report',
        when: { kinds: ['Topic'], roles: ['synthesizer'] },
      });
    }
    return 'delivered';
  });

const topics = H.lane('topics', Topic)
  .handler(researchFlow)
  .suppliers(H.operator)
  .store(sqlite.store(Topic, '.harness/topics.sqlite'))
  .maxUsdPerUnit(3);

const weeklyRecurring = H.trigger(
  'reopen-recurring-topics',
  H.on.clock({ weekly: { day: 'mon', at: '06:00' } }, Topic, ['delivered', 'parked']),
  (event, act) => event.unit.data.tags.includes('recurring') ? act.move('queued') : [],
);

const dailyBudgetUsd = 40;
const perTopicCeilingUsd = 3;

const withinDailyBudget = H.policy.scheduler('within-daily-budget', view => {
  const startOfDay = new Date(view.now.getFullYear(), view.now.getMonth(), view.now.getDate());
  const spent = view.metrics.sum({ of: 'costUsd', among: { entry: 'invocation' }, since: startOfDay });
  const projected = view.metrics.mean({
    of: 'costUsd',
    among: { entry: 'attempt', kind: Topic.name, outcome: 'succeeded' },
    days: 30,
  });
  const perTopic = projected.samples > 0 && projected.value !== null ? projected.value : perTopicCeilingUsd;
  let remaining = dailyBudgetUsd - (spent.value ?? 0);
  const start = [];
  for (const unit of [...view.pending].sort((a, b) => b.waitedMs - a.waitedMs)) {
    if (perTopic > remaining) break;
    remaining -= perTopic;
    start.push(unit);
  }
  return { start };
});

const apiPool = H.pool('anthropic', [
  { account: anthropic.account('research-api', { apiKey: H.env('ANTHROPIC_API_KEY') }), share: 1 },
], H.policy.account('first-eligible', choice => {
  const eligible = choice.accounts.find(view => view.eligible);
  return eligible ? eligible.account : null;
}));

const supervisor = claudeCode.supervisor({
  grants: [H.ops.readWork, H.ops.writeWork, H.ops.readMemory, H.ops.curateMemory, H.ops.readTelemetry],
});

export default H.harness('research')
  .ledger(sqlite.ledger('.harness/research-ledger.sqlite'))
  .lanes(topics)
  .pools(apiPool)
  .triggers(weeklyRecurring)
  .scheduler(withinDailyBudget)
  .clients(supervisor)
  .observers(markdown.board('BOARD.md'), markdown.telemetry('TELEMETRY.md'));
