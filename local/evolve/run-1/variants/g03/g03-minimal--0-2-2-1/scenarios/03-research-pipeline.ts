import { z } from 'zod';
import { H } from 'harness-dsl';
import type { PendingView } from 'harness-dsl';
import * as anthropic from 'harness-dsl/anthropic';
import * as claudeCode from 'harness-dsl/claude-code';
import * as sqlite from 'harness-dsl/sqlite';
import * as jsonl from 'harness-dsl/jsonl';
import * as qdrant from 'harness-dsl/qdrant';
import * as shell from 'harness-dsl/shell';
import * as markdown from 'harness-dsl/markdown';

const TopicData = z.object({
  slug: z.string(),
  question: z.string(),
  tags: z.array(z.string()),
  report: z.string().optional(),
});

const Extract = z.object({
  url: z.string(),
  claim: z.string(),
  quote: z.string(),
  relevant: z.boolean(),
});

const topicQueued = H.state('topic-queued', 'pending');
const researching = H.state('researching', 'active');
const delivered = H.state('delivered', 'terminal', 'success');
const parked = H.state('parked', 'terminal', 'neutral');
const topicCancelled = H.state('topic-cancelled', 'terminal', 'neutral');
const topicFailed = H.state('topic-failed', 'terminal', 'failure');

const Topic = H.kind('topic')
  .data(TopicData)
  .states(topicQueued, researching, delivered, parked, topicCancelled, topicFailed)
  .failsTo('topic-failed');

const extractRole = H.role('extractor')
  .input(z.object({ question: z.string(), url: z.string(), title: z.string() }))
  .output(Extract)
  .prompt((source) => `Read ${source.title} (${source.url}). Extract the single claim most relevant to: ${source.question}. Quote it verbatim.`)
  .intents(['browse']);

const synthesizeRole = H.role('synthesizer')
  .input(z.object({ question: z.string(), extracts: z.array(Extract) }))
  .output(z.object({ report: z.string(), citations: z.array(z.string()), findings: z.array(z.string()) }))
  .prompt((input) => `Write a sourced report answering: ${input.question}\n\nSources:\n${input.extracts.map((e) => `- ${e.url}: ${e.claim} "${e.quote}"`).join('\n')}`)
  .intents([]);

const priorFindings = H.memory('prior-findings', 'experience');
const sourceExperience = H.memory('source-experience', 'experience');

const findingsLibrary = H.library('findings-library', priorFindings, qdrant.memory({
  url: 'http://localhost:6333',
  collection: 'research-findings',
  embedder: 'text-embedding-3-small',
  apiKey: H.env('QDRANT_API_KEY'),
}));
const sourceLessons = H.library('source-lessons', sourceExperience, jsonl.memory('.harness/source-experience.jsonl'));

const haiku = anthropic.model('claude-haiku-4-5');
const opus = anthropic.model('claude-opus-4-1');
const sonnet = anthropic.model('claude-sonnet-4-5');

const api = anthropic.account('anthropic-api', { apiKey: H.env('ANTHROPIC_API_KEY') });
const apiPool = H.pool('api', [{ account: api, share: 1 }]);

const local = shell.local('local', { slots: 2 });

const searchSources = H.command('search-sources')
  .input(z.object({ question: z.string(), limit: z.number() }))
  .output(z.object({ sources: z.array(z.object({ url: z.string(), title: z.string() })) }))
  .argv((query) => ['research-search', '--limit', String(query.limit), '--key', H.env('SEARCH_API_KEY'), query.question])
  .on(local);

const citationCheck = H.command('citation-check')
  .input(z.object({ citations: z.array(z.string()) }))
  .argv((input) => ['check-citations', ...input.citations])
  .on(local);

const citationPassRate = H.policy.model('synthesizer-model', ({ agent, metrics }) => {
  const passRate = metrics.rateBy({
    among: { entry: 'invocation', executable: citationCheck, status: 'ended' },
    count: { entry: 'invocation', executable: citationCheck, status: 'ended', ok: true },
    by: { modelOf: agent },
    days: 30,
  });
  const onOpus = passRate.get(opus);
  const onSonnet = passRate.get(sonnet);
  if (onOpus.samples < 30) return opus;
  if (onSonnet.samples < 30) return sonnet;
  return (onOpus.value ?? 0) >= (onSonnet.value ?? 0) ? opus : sonnet;
});

const extractor = H.agent('extractor', extractRole).model(haiku).recalls(sourceLessons);
const synthesizer = H.agent('synthesizer', synthesizeRole)
  .model(citationPassRate)
  .recalls(findingsLibrary, sourceLessons)
  .records(sourceLessons);

const minimumSources = 5;

const researchTopic = H.flow('research-topic')
  .for(Topic)
  .does(async (ctx) => {
    await ctx.move('researching');
    const question = ctx.unit.data.question;
    const found = await ctx.run(searchSources, { question, limit: 20 });
    if (!found.ok) return ctx.fail(found.error);

    const extracts = await ctx.batch(extractor, found.value.sources.map((source) => ({ question, url: source.url, title: source.title })));
    const usable = extracts.flatMap((result) => (result.ok && result.value.relevant ? [result.value] : []));
    if (usable.length < minimumSources) return 'parked';

    const synthesis = await ctx.run(synthesizer, { question, extracts: usable }, { scope: { skills: ctx.unit.data.tags } });
    if (!synthesis.ok) return ctx.fail(synthesis.error);

    const checked = await ctx.run(citationCheck, { citations: synthesis.value.citations });
    if (!checked.ok) return ctx.fail(`citation does not resolve: ${checked.error}`);

    await ctx.update({ report: synthesis.value.report });
    for (const finding of synthesis.value.findings) {
      await ctx.remember(findingsLibrary, {
        text: `When researching ${ctx.unit.data.slug}, start from this finding: ${finding}`,
        because: `the report on "${question}" established it with resolving citations`,
        when: { kinds: [Topic], roles: [synthesizeRole], skills: ctx.unit.data.tags },
        status: 'accepted',
      });
    }
    return 'delivered';
  });

const reopenRecurring = H.clock('reopen-recurring', Topic, { weekly: { day: 'mon', at: '06:00' } }, ({ now, units }) => {
  const latest = new Map<string, { slug: string; question: string; tags: string[] }>();
  for (const unit of units) {
    if (unit.data.tags.includes('recurring')) {
      latest.set(unit.data.slug, { slug: unit.data.slug, question: unit.data.question, tags: unit.data.tags });
    }
  }
  const week = now.toISOString().slice(0, 10);
  return [...latest.values()].map((topic) => ({ create: topic, key: `${topic.slug}@${week}` }));
});

const topicCeilingUsd = 3;
const dailyBudgetUsd = 40;

const topicLane = H.lane('topics', Topic)
  .handler(researchTopic)
  .suppliers(H.operator, reopenRecurring)
  .store(sqlite.store(Topic, '.harness/topics.sqlite'))
  .maxUsdPerUnit(topicCeilingUsd);

const withinDailyBudget = H.policy.scheduler('within-daily-budget', ({ now, pending, active, metrics }) => {
  const since = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const spent = metrics.sum({ of: 'costUsd', among: { entry: 'invocation' }, since }).value ?? 0;
  const projected = metrics.mean({ of: 'costUsd', among: { entry: 'attempt', status: 'ended', kind: Topic, outcome: 'succeeded' }, days: 30 }).value ?? topicCeilingUsd;
  let remaining = dailyBudgetUsd - spent - active.length * projected;
  const start: PendingView[] = [];
  for (const unit of [...pending].sort((a, b) => b.waitedMs - a.waitedMs)) {
    if (projected > remaining) break;
    start.push(unit);
    remaining -= projected;
  }
  return { start };
});

const supervisor = claudeCode.supervisor({
  grants: [H.ops.readWork, H.ops.writeWork, H.ops.resolveHalts, H.ops.readMemory, H.ops.writeMemory, H.ops.curateMemory, H.ops.readTelemetry],
});

export const researchPipeline = H.harness('research-pipeline')
  .ledger(sqlite.ledger('.harness/research.sqlite'))
  .lanes(topicLane)
  .pools(apiPool)
  .scheduler(withinDailyBudget)
  .clients(supervisor)
  .observers(markdown.board('BOARD.md'), markdown.telemetry('TELEMETRY.md'));

export const running = researchPipeline.start();
