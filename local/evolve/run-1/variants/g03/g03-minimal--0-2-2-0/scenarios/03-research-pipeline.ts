import { H } from 'harness-dsl';
import type { ModelPolicy } from 'harness-dsl';
import { z } from 'zod';
import * as claudeCode from 'harness-dsl/claude-code';
import * as anthropic from 'harness-dsl/anthropic';
import * as sqlite from 'harness-dsl/sqlite';
import * as jsonl from 'harness-dsl/jsonl';
import * as qdrant from 'harness-dsl/qdrant';
import * as shell from 'harness-dsl/shell';
import * as markdown from 'harness-dsl/markdown';

const Topic = H.kind('topic')
  .data(z.object({
    question: z.string(),
    tags: z.array(z.string()),
    report: z.string().optional()
  }))
  .states(
    H.state('topic-queued', 'pending'),
    H.state('researching', 'active'),
    H.state('topic-reported', 'terminal', 'success'),
    H.state('topic-parked', 'terminal', 'neutral'),
    H.state('topic-cancelled', 'terminal', 'neutral')
  );

const findingsLibrary = H.library(
  'prior-report-findings',
  H.memory('report-findings', 'experience'),
  qdrant.memory({
    url: 'https://vectors.internal:6333',
    collection: 'report-findings',
    embedder: 'text-embedding-small',
    apiKey: H.env('VECTOR_STORE_KEY')
  })
);

const sourceLessons = H.library(
  'source-lessons',
  H.memory('source-experience', 'experience'),
  jsonl.memory('.harness/source-experience.jsonl')
);

const haiku = anthropic.model('claude-haiku-4-5');
const sonnet = anthropic.model('claude-sonnet-4-5');
const opus = anthropic.model('claude-opus-4-1');

const searchSlices = 20;
const minimumFindings = 5;

const searcherRole = H.role('searcher')
  .input(z.object({ question: z.string(), slice: z.number(), of: z.number() }))
  .output(z.object({ findings: z.array(z.object({ claim: z.string(), source: z.string() })) }))
  .prompt((input) => `Search angle ${input.slice + 1} of ${input.of} for: ${input.question}\nExtract sourced claims with resolvable URLs.`)
  .intents(['browse']);

const synthesizerRole = H.role('synthesizer')
  .input(z.object({
    question: z.string(),
    findings: z.array(z.object({ claim: z.string(), source: z.string() }))
  }))
  .output(z.object({ report: z.string(), headline: z.string(), citations: z.array(z.string()) }))
  .prompt((input) => `Write a sourced report answering: ${input.question}\n\nFindings:\n${input.findings.map((f) => `- ${f.claim} (${f.source})`).join('\n')}`);

const localShell = shell.local('local-shell', { slots: 2 });

const citationCheck = H.command('citation-check')
  .input(z.object({ citations: z.array(z.string()) }))
  .argv((input) => ['./tools/check-citations', ...input.citations])
  .on(localShell);

const synthesizerModel: ModelPolicy = H.policy.model('synthesizer-model', ({ metrics }) => {
  const passRate = metrics.rateBy({
    among: citationCheck.invocations(),
    count: citationCheck.invocations({ ok: true }),
    by: { model: synthesizer },
    days: 30
  });
  const sonnetRate = passRate.get(sonnet);
  const opusRate = passRate.get(opus);
  if (sonnetRate.samples < 20 || opusRate.samples < 20) {
    return sonnetRate.samples <= opusRate.samples ? sonnet : opus;
  }
  return (sonnetRate.value ?? 0) >= (opusRate.value ?? 0) ? sonnet : opus;
});

const searcher = H.agent('searcher', searcherRole).model(haiku).recalls(sourceLessons);
const synthesizer = H.agent('synthesizer', synthesizerRole)
  .model(synthesizerModel)
  .recalls(findingsLibrary, sourceLessons)
  .records(sourceLessons);

const research = H.flow('research')
  .for(Topic)
  .does(async (ctx) => {
    const question = ctx.unit.data.question;
    await ctx.move('researching');

    const searches = await ctx.batch(
      searcher,
      Array.from({ length: searchSlices }, (_, slice) => ({ question, slice, of: searchSlices }))
    );
    const findings = searches.flatMap((result) => (result.ok ? result.value.findings : []));
    if (findings.length < minimumFindings) return 'topic-parked';

    const synthesized = await ctx.run(synthesizer, { question, findings });
    if (!synthesized.ok) return ctx.fail(synthesized.error);

    const checked = await ctx.run(citationCheck, { citations: synthesized.value.citations });
    if (!checked.ok) return ctx.fail(`citation did not resolve: ${checked.error}`);

    await ctx.update({ report: synthesized.value.report });
    await ctx.remember(findingsLibrary, {
      text: `When researching a question like "${question}", start from: ${synthesized.value.headline}`,
      because: `report ${ctx.unit.key} established it with ${synthesized.value.citations.length} resolved citations`,
      when: { kinds: [Topic], roles: [synthesizerRole] },
      status: 'accepted'
    });
    return 'topic-reported';
  });

const recurringReopen = H.clock('recurring-topics', Topic, { weekly: { day: 'mon', at: '06:00' } }, ({ units }) =>
  units
    .filter((unit) => unit.position === 'terminal' && unit.data.tags.includes('recurring'))
    .map((unit) => Topic.update(unit.key, { state: 'topic-queued' })));

const topicCeilingUsd = 3;
const dailyBudgetUsd = 40;

const topicLane = H.lane('topics', Topic)
  .handler(research)
  .suppliers(H.operator, recurringReopen)
  .store(sqlite.store(Topic, '.harness/topics.db'))
  .maxUsdPerUnit(topicCeilingUsd);

const withinDailyBudget = H.policy.scheduler('daily-budget', ({ now, pending, active, metrics }) => {
  const midnight = new Date(now);
  midnight.setHours(0, 0, 0, 0);
  const spentToday = metrics.sum({ of: 'costUsd', among: Topic.attempts(), since: midnight }).value ?? 0;
  const succeededCost = metrics.mean({ of: 'costUsd', among: Topic.attempts({ outcome: 'succeeded' }), days: 30 });
  const projectedUsd = succeededCost.samples >= 5 && succeededCost.value !== null ? succeededCost.value : topicCeilingUsd;
  const remainingUsd = dailyBudgetUsd - spentToday - projectedUsd * active.length;
  const affordable = Math.max(0, Math.floor(remainingUsd / projectedUsd));
  return { start: pending.slice(0, affordable) };
});

const batchPool = H.pool('research-accounts', [
  { account: anthropic.account('research-api', { apiKey: H.env('ANTHROPIC_API_KEY') }), share: 1 }
]);

export default H.harness('research-pipeline')
  .ledger(sqlite.ledger('.harness/research.db'))
  .lanes(topicLane)
  .pools(batchPool)
  .scheduler(withinDailyBudget)
  .clients(claudeCode.supervisor({
    grants: [H.ops.readWork, H.ops.writeWork, H.ops.resolveHalts, H.ops.readMemory, H.ops.writeMemory, H.ops.readTelemetry]
  }))
  .observers(markdown.board('BOARD.md'), markdown.telemetry('TELEMETRY.md'));
