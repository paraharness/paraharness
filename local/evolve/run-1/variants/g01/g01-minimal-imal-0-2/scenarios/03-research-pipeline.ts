import { z } from 'zod';
import { H, type PendingView, type EntryFilter } from 'harness-dsl';
import * as anthropic from 'harness-dsl/anthropic';
import * as cc from 'harness-dsl/claude-code';
import * as sqlite from 'harness-dsl/sqlite';
import * as jsonl from 'harness-dsl/jsonl';
import * as qdrant from 'harness-dsl/qdrant';
import * as shell from 'harness-dsl/shell';
import * as markdown from 'harness-dsl/markdown';

const Queued = H.state('queued', 'pending');
const Researching = H.state('researching', 'active');
const Reported = H.state('reported', 'terminal', 'success');
const Parked = H.state('parked', 'terminal', 'neutral');
const Cancelled = H.state('cancelled', 'terminal', 'neutral');
const Abandoned = H.state('abandoned', 'terminal', 'failure');

const Topic = H.kind('topic')
  .data(z.object({
    title: z.string(),
    question: z.string(),
    tags: z.array(z.string()),
    recurring: z.boolean(),
    report: z.string().optional(),
  }))
  .states(Queued, Researching, Reported, Parked, Cancelled, Abandoned);

const finding = z.object({ claim: z.string(), quote: z.string(), url: z.string() });
type Finding = z.infer<typeof finding>;

const extractorRole = H.role('extractor')
  .input(z.object({ question: z.string(), url: z.string(), title: z.string() }))
  .output(z.object({ findings: z.array(finding) }))
  .prompt(i => `Read "${i.title}" at ${i.url} and extract findings relevant to: ${i.question}`)
  .intents(['browse']);

const synthesizerRole = H.role('synthesizer')
  .input(z.object({ question: z.string(), findings: z.array(finding) }))
  .output(z.object({ report: z.string(), summary: z.string(), citations: z.array(z.string()) }))
  .prompt(i => `Write a sourced report answering: ${i.question}\n\nFindings:\n${i.findings.map(f => `- ${f.claim} (${f.url})`).join('\n')}`);

const priorFindings = H.memory('prior-findings', 'experience');
const sourceExperience = H.memory('source-experience', 'experience');

const findingsLibrary = H.library('prior-findings', priorFindings, qdrant.memory({
  url: 'https://vectors.example.com',
  collection: 'research-findings',
  embedder: 'text-embedding-3-small',
  apiKey: H.env('QDRANT_API_KEY'),
}));
const sourceLibrary = H.library('source-lessons', sourceExperience, jsonl.memory('memory/sources.jsonl'));

const haiku = anthropic.model('claude-haiku-4-5');
const opus = anthropic.model('claude-opus-4-1');
const sonnet = anthropic.model('claude-sonnet-4-5');

const citationChecks: EntryFilter = { entry: 'invocation', executable: 'citation-check', status: 'ended' };

const synthesizerModel = H.policy.model('citation-pass-rate', choice => {
  const rates = choice.metrics.rateBy({
    among: citationChecks,
    count: { ...citationChecks, ok: true },
    byTag: 'synthesizer',
    days: 60,
  });
  const opusRate = rates[opus.name];
  const sonnetRate = rates[sonnet.name];
  const opusSamples = opusRate?.samples ?? 0;
  const sonnetSamples = sonnetRate?.samples ?? 0;
  if (opusSamples < 20 || sonnetSamples < 20) return opusSamples <= sonnetSamples ? opus : sonnet;
  return (opusRate?.value ?? 0) >= (sonnetRate?.value ?? 0) ? opus : sonnet;
});

const extractor = H.agent('extractor', extractorRole).model(haiku);
const synthesizer = H.agent('synthesizer', synthesizerRole)
  .model(synthesizerModel)
  .recalls(findingsLibrary, sourceLibrary)
  .records(sourceLibrary);

const local = shell.local('local', { slots: 2 });

const searchSources = H.command('search-sources')
  .input(z.object({ question: z.string(), limit: z.number().int() }))
  .output(z.object({ sources: z.array(z.object({ url: z.string(), title: z.string() })) }))
  .argv(i => ['research-search', '--limit', String(i.limit), i.question])
  .on(local)
  .recovery('rerun');

const citationCheck = H.command('citation-check')
  .input(z.object({ citations: z.array(z.string()) }))
  .argv(i => ['check-citations', ...i.citations])
  .on(local)
  .recovery('rerun');

const researchFlow = H.flow('research').for(Topic).does(async ctx => {
  if (ctx.unit.failures >= 3) return 'abandoned';
  const topic = ctx.unit.data;
  await ctx.move('researching');

  const found = await ctx.run(searchSources, { question: topic.question, limit: 20 });
  if (!found.ok) return ctx.fail(found.error);

  const extracts = await ctx.batch(
    extractor,
    found.value.sources.map(s => ({ question: topic.question, url: s.url, title: s.title })),
  );
  const findings: Finding[] = [];
  for (const extract of extracts) {
    if (extract.ok) findings.push(...extract.value.findings);
  }
  if (findings.length < 5) return 'parked';

  const synthesis = await ctx.run(
    synthesizer,
    { question: topic.question, findings },
    { scope: { skills: topic.tags } },
  );
  if (!synthesis.ok) return ctx.fail(synthesis.error);
  ctx.tag({ synthesizer: synthesis.model ?? 'unknown' });

  const checked = await ctx.run(citationCheck, { citations: synthesis.value.citations });
  if (!checked.ok) return ctx.fail(`a citation did not resolve: ${checked.error}`);

  await ctx.update({ report: synthesis.value.report });
  await ctx.remember(findingsLibrary, {
    text: `When researching "${topic.question}", start from this prior finding: ${synthesis.value.summary}`,
    because: `the report of ${ctx.now().toISOString()} passed citation check with ${synthesis.value.citations.length} citations`,
    when: { kinds: [Topic.name], skills: topic.tags },
  });
  return 'reported';
});

const recurringTopics = H.clock('recurring-topics', Topic, { weekly: { day: 'mon', at: '06:00' } }, tick =>
  tick.units
    .filter(unit => unit.position === 'terminal' && unit.data.recurring)
    .map(unit => ({ create: { ...unit.data, report: undefined }, key: unit.key })));

const topics = H.lane('topics', Topic)
  .handler(researchFlow)
  .suppliers(H.operator, recurringTopics)
  .store(sqlite.store(Topic, '.harness/topics.db'))
  .maxUsdPerUnit(3);

const dailyBudgetUsd = 40;

const startOfDay = (now: Date): Date => new Date(now.getFullYear(), now.getMonth(), now.getDate());

const withinDailyBudget = H.policy.scheduler('within-daily-budget', view => {
  const projected = view.metrics.mean({
    of: 'costUsd',
    among: { entry: 'attempt', kind: Topic.name, status: 'ended', outcome: 'succeeded' },
    days: 30,
  });
  const perTopicUsd = projected.samples > 0 && projected.value !== null ? projected.value : 3;
  const spentToday = view.metrics.sum({
    of: 'costUsd',
    among: { entry: 'invocation', status: 'ended' },
    since: startOfDay(view.now),
  });
  let remainingUsd = dailyBudgetUsd - (spentToday.value ?? 0) - perTopicUsd * view.active.length;
  const start: PendingView[] = [];
  for (const unit of [...view.pending].sort((a, b) => b.waitedMs - a.waitedMs)) {
    if (remainingUsd < perTopicUsd) break;
    start.push(unit);
    remainingUsd -= perTopicUsd;
  }
  return { start };
});

const api = H.pool('anthropic', [
  { account: anthropic.account('research-api', { apiKey: H.env('ANTHROPIC_API_KEY') }), share: 1 },
]);

export const harness = H.harness('research-pipeline')
  .ledger(sqlite.ledger('.harness/research-ledger.db'))
  .lanes(topics)
  .pools(api)
  .scheduler(withinDailyBudget)
  .clients(cc.supervisor({
    grants: [H.ops.readWork, H.ops.writeWork, H.ops.readMemory, H.ops.writeMemory, H.ops.readTelemetry],
  }))
  .observers(markdown.board('BOARD.md'), markdown.telemetry('TELEMETRY.md'));
