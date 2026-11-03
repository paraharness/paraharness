import { H } from 'harness-dsl';
import type { Rate } from 'harness-dsl';
import { z } from 'zod';
import * as claudeCode from 'harness-dsl/claude-code';
import * as anthropic from 'harness-dsl/anthropic';
import * as sqlite from 'harness-dsl/sqlite';
import * as jsonl from 'harness-dsl/jsonl';
import * as qdrant from 'harness-dsl/qdrant';
import * as shell from 'harness-dsl/shell';
import * as markdown from 'harness-dsl/markdown';

const Requested = H.state('requested', 'pending');
const Researching = H.state('researching', 'active');
const Delivered = H.state('delivered', 'terminal', 'success');
const Parked = H.state('parked', 'terminal', 'neutral');
const Cancelled = H.state('cancelled', 'terminal', 'neutral');
const Failed = H.state('failed', 'terminal', 'failure');

const topicData = z.object({
  topic: z.string(),
  question: z.string(),
  tags: z.array(z.string()),
  report: z.string().optional(),
});

const Topic = H.kind('topic')
  .data(topicData)
  .states(Requested, Researching, Delivered, Parked, Cancelled, Failed)
  .onFailure('failed', { afterAttempts: 3 });

const findingsMemory = H.memory('report-finding', 'experience');
const sourceMemory = H.memory('source-experience', 'experience');
const findings = H.library('report-findings', findingsMemory, qdrant.memory({
  url: 'https://vectors.internal:6333',
  collection: 'report-findings',
  embedder: 'text-embedding-3-small',
  apiKey: H.env('QDRANT_API_KEY'),
}));
const sourceLessons = H.library('source-lessons', sourceMemory, jsonl.memory('memory/sources.jsonl'));

const haiku = anthropic.model('claude-haiku-4-5');
const opus = anthropic.model('claude-opus-4-1');
const sonnet = anthropic.model('claude-sonnet-4-5');
const accounts = H.pool('anthropic', [{ account: anthropic.account('api', { apiKey: H.env('ANTHROPIC_API_KEY') }), share: 1 }]);

const local = shell.local('local', { slots: 2 });

const citationCheck = H.command('citation-check')
  .input(z.object({ citations: z.array(z.string()) }))
  .argv(i => ['scripts/check-citations.sh', ...i.citations])
  .on(local)
  .recover('rerun');

const passRate = (rate: Rate | undefined) => ({
  samples: rate === undefined ? 0 : rate.samples,
  value: rate === undefined || rate.value === null ? 0 : rate.value,
});

const citationPassRate = H.policy.model('citation-pass-rate', choice => {
  const byModel = choice.metrics.rateBy({
    among: { entry: 'invocation', executable: citationCheck, status: 'ended' },
    count: { entry: 'invocation', executable: citationCheck, status: 'ended', ok: true },
    by: H.by.model(choice.agent),
    days: 30,
  });
  const first = passRate(byModel[opus.name]);
  const second = passRate(byModel[sonnet.name]);
  if (first.samples < 20) return opus;
  if (second.samples < 20) return sonnet;
  return first.value >= second.value ? opus : sonnet;
});

const similarFindingsFirst = H.policy.recall('similar-findings-first', view =>
  view.items
    .filter(item => item.library === sourceLessons.name || (item.similarity ?? 0) >= 0.7)
    .sort((a, b) =>
      (b.similarity ?? 0) - (a.similarity ?? 0) ||
      b.specificity - a.specificity ||
      (b.trackRecord.value ?? 0) - (a.trackRecord.value ?? 0))
    .slice(0, 12)
);

const finding = z.object({ claim: z.string(), source: z.string() });

const extractorRole = H.role('search-and-extract')
  .input(z.object({ question: z.string(), facet: z.number().int(), of: z.number().int() }))
  .output(z.object({ findings: z.array(finding) }))
  .prompt(i => `Search for sources on facet ${i.facet} of ${i.of} of this question and extract sourced claims.\n\n${i.question}`)
  .intents(['browse']);

const synthesizerRole = H.role('synthesizer')
  .input(z.object({ question: z.string(), findings: z.array(finding) }))
  .output(z.object({ report: z.string(), citations: z.array(z.string()), keyFindings: z.array(z.string()) }))
  .prompt(i => `Write a sourced report answering: ${i.question}\n\nFindings:\n${i.findings.map(f => `- ${f.claim} (${f.source})`).join('\n')}`);

const extractor = H.agent('extractor', extractorRole).model(haiku).recalls(sourceLessons);
const synthesizer = H.agent('synthesizer', synthesizerRole)
  .model(citationPassRate)
  .recalls(findings, sourceLessons)
  .recall(similarFindingsFirst);

const facets = 20;
const minimumSources = 5;

const researchFlow = H.flow('research-topic').for(Topic).does(async ctx => {
  const { topic, question } = ctx.unit.data;
  const extracted = await ctx.batch(
    extractor,
    Array.from({ length: facets }, (_, index) => ({ question, facet: index + 1, of: facets }))
  );
  const gathered = extracted.flatMap(result => (result.ok ? result.value.findings : []));
  if (new Set(gathered.map(f => f.source)).size < minimumSources) return 'parked';
  const synthesis = await ctx.run(synthesizer, { question, findings: gathered });
  if (synthesis.ok === false) return ctx.fail(synthesis.error);
  const checked = await ctx.run(citationCheck, { citations: synthesis.value.citations });
  if (checked.ok === false) return ctx.fail(`a citation did not resolve: ${checked.error}`);
  await ctx.update({ report: synthesis.value.report });
  const delivered = ctx.now().toISOString().slice(0, 10);
  for (const keyFinding of synthesis.value.keyFindings) {
    await ctx.remember(findings, {
      text: `When researching ${topic}, start from this established finding: ${keyFinding}`,
      because: `the report delivered on ${delivered} established it with resolving citations`,
      when: { kinds: [Topic.name] },
      status: 'accepted',
    });
  }
  return 'delivered';
});

const weeklyRecurring = H.clock('weekly-recurring-topics', Topic, { weekly: { day: 'mon', at: '06:00' } }, tick => {
  const open = new Set(tick.units.filter(u => u.position === 'terminal' ? false : true).map(u => u.data.topic));
  const recurring = new Map<string, z.infer<typeof topicData>>();
  for (const unit of tick.units) {
    if (unit.data.tags.includes('recurring') && open.has(unit.data.topic) === false) recurring.set(unit.data.topic, unit.data);
  }
  const week = tick.now.toISOString().slice(0, 10);
  return [...recurring.values()].map(data => ({
    create: { topic: data.topic, question: data.question, tags: data.tags },
    key: `${data.topic}@${week}`,
  }));
});

const topics = H.lane('topics', Topic)
  .handler(researchFlow)
  .suppliers(H.operator, weeklyRecurring)
  .store(sqlite.store(Topic, 'harness/topics.sqlite'))
  .maxUsdPerUnit(3);

const dailyBudgetUsd = 40;
const topicCeilingUsd = 3;

const withinDailyBudget = H.policy.scheduler('within-daily-budget', view => {
  const now = view.now;
  const startOfDay = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const spent = view.metrics.sum({ of: 'costUsd', among: { entry: 'invocation', kind: Topic, status: 'ended' }, since: startOfDay });
  const succeeded = view.metrics.mean({
    of: 'costUsd',
    among: { entry: 'attempt', kind: Topic, status: 'ended', outcome: 'succeeded' },
    days: 30,
  });
  const projected = succeeded.value === null ? topicCeilingUsd : succeeded.value;
  const reserved = view.active
    .filter(a => a.is(Topic))
    .reduce((total, a) => total + Math.max(0, projected - a.spentUsd), 0);
  let remaining = dailyBudgetUsd - (spent.value ?? 0) - reserved;
  const start = [...view.pending]
    .sort((a, b) => b.waitedMs - a.waitedMs)
    .filter(unit => {
      if (unit.is(Topic) && remaining < projected) return false;
      remaining -= projected;
      return true;
    });
  return { start };
});

const supervisor = claudeCode.supervisor({
  grants: [H.ops.readWork, H.ops.writeWork, H.ops.readMemory, H.ops.writeMemory, H.ops.readTelemetry],
});

export const researchPipeline = H.harness('research-pipeline')
  .ledger(sqlite.ledger('harness/research.sqlite'))
  .lanes(topics)
  .pools(accounts)
  .scheduler(withinDailyBudget)
  .clients(supervisor)
  .observers(markdown.board('BOARD.md'), markdown.telemetry('TELEMETRY.md'));
