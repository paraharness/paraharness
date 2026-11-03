import { z } from 'zod';
import { H } from 'harness-dsl';
import type { Model, PendingView } from 'harness-dsl';
import type { ModelChoice } from 'harness-dsl/kernel';
import * as claude from 'harness-dsl/claude-code';
import * as anthropic from 'harness-dsl/anthropic';
import * as sqlite from 'harness-dsl/sqlite';
import * as jsonl from 'harness-dsl/jsonl';
import * as qdrant from 'harness-dsl/qdrant';
import * as shell from 'harness-dsl/shell';
import * as markdown from 'harness-dsl/markdown';

const topicCeilingUsd = 3;
const dailyBudgetUsd = 40;
const searchFanOut = 20;
const minimumSources = 5;

const queued = H.state('queued', 'pending');
const searching = H.state('searching', 'active');
const synthesizing = H.state('synthesizing', 'active');
const checking = H.state('checking', 'active');
const delivered = H.state('delivered', 'terminal', 'success');
const parked = H.state('parked', 'terminal', 'neutral');
const cancelled = H.state('cancelled', 'terminal', 'neutral');

const Topic = H.kind('topic')
  .data(z.object({ slug: z.string(), question: z.string(), tags: z.array(z.string()), report: z.string().optional() }))
  .states(queued, searching, synthesizing, checking, delivered, parked, cancelled);

const findings = H.memory('prior-findings', 'experience');
const sourceExperience = H.memory('source-experience', 'experience');
const findingsLibrary = H.library(
  'prior-findings',
  findings,
  qdrant.memory({
    url: 'https://vectors.example.com',
    collection: 'research-findings',
    embedder: 'text-embedding-3-small',
    apiKey: H.env('QDRANT_API_KEY'),
  })
);
const sourceLibrary = H.library('source-experience', sourceExperience, jsonl.memory('.harness/sources.jsonl'));

const apiAccount = anthropic.account('anthropic-api', { apiKey: H.env('ANTHROPIC_API_KEY') });
const pool = H.pool('anthropic', [{ account: apiAccount, share: 1 }]);

const cheapModel = anthropic.model('claude-haiku-4-5');
const strongModel = anthropic.model('claude-opus-4-1');
const challengerModel = anthropic.model('claude-sonnet-4-5');

const local = shell.local('local', { slots: 2 });

const searcherRole = H.role('searcher')
  .input(z.object({ question: z.string(), facet: z.number(), of: z.number() }))
  .output(z.object({ findings: z.array(z.object({ claim: z.string(), source: z.string() })) }))
  .prompt((input) => `Search facet ${input.facet} of ${input.of} for: ${input.question}. Extract claims with source URLs.`)
  .intents(['browse']);

const synthesizerRole = H.role('synthesizer')
  .input(z.object({ question: z.string(), findings: z.array(z.object({ claim: z.string(), source: z.string() })) }))
  .output(z.object({ report: z.string(), citations: z.array(z.string()), keyFindings: z.array(z.string()) }))
  .prompt((input) => `Write a sourced report on: ${input.question}\n${input.findings.map((f) => `- ${f.claim} (${f.source})`).join('\n')}`);

const searcher = H.agent('searcher', searcherRole).model(cheapModel);

const citationCheck = H.command('citation-check')
  .input(z.object({ citations: z.array(z.string()) }))
  .argv((input) => ['check-citations', ...input.citations])
  .on(local)
  .recovery('rerun');

const synthesizerModel = H.policy.model('synthesizer-model', (choice: ModelChoice): Model => {
  const passRates = choice.metrics.rateBy({
    among: { entry: 'invocation', status: 'ended', executable: citationCheck },
    count: { entry: 'invocation', status: 'ended', executable: citationCheck, ok: true },
    by: { modelOf: synthesizer },
    days: 30,
  });
  const incumbent = passRates.of(strongModel);
  const challenger = passRates.of(challengerModel);
  if (incumbent.samples < 20) return strongModel;
  if (challenger.samples < 20) return challengerModel;
  return (challenger.value ?? 0) > (incumbent.value ?? 0) ? challengerModel : strongModel;
});

const synthesizer = H.agent('synthesizer', synthesizerRole)
  .model(synthesizerModel)
  .recalls(findingsLibrary, sourceLibrary)
  .records(sourceLibrary);

const research = H.flow('research')
  .for(Topic)
  .phases('searching', 'synthesizing', 'checking')
  .exits('delivered', 'park')
  .does(async (ctx) => {
    const question = ctx.unit.data.question;
    await ctx.move('searching');
    const inputs = Array.from({ length: searchFanOut }, (_, index) => ({ question, facet: index + 1, of: searchFanOut }));
    const searched = await ctx.batch(searcher, inputs);
    const gathered = searched.flatMap((result) => (result.ok ? result.value.findings : []));
    const sources = new Set(gathered.map((finding) => finding.source));
    if (sources.size < minimumSources) return 'park';
    await ctx.move('synthesizing');
    const synthesis = await ctx.run(synthesizer, { question, findings: gathered });
    if (!synthesis.ok) return ctx.fail(synthesis.error);
    await ctx.move('checking');
    const checked = await ctx.run(citationCheck, { citations: synthesis.value.citations });
    if (!checked.ok) return ctx.fail(`a citation did not resolve: ${checked.error}`);
    await ctx.update({ report: synthesis.value.report });
    for (const finding of synthesis.value.keyFindings) {
      await ctx.remember(findingsLibrary, {
        text: `When researching questions like "${question}", start from: ${finding}`,
        because: 'a prior report established it with resolving citations',
        when: { roles: [synthesizerRole] },
        status: 'accepted',
      });
    }
    return 'delivered';
  });

const recurringTopics = H.clock('recurring-topics', Topic, { weekly: { day: 'mon', at: '06:00' } }, ({ now, units }) =>
  units
    .filter((unit) => unit.position === 'terminal' && unit.data.tags.includes('recurring'))
    .map((unit) => ({
      create: { slug: unit.data.slug, question: unit.data.question, tags: unit.data.tags },
      key: `${unit.data.slug}@${now.toISOString().slice(0, 10)}`,
    }))
);

const topics = H.lane('topics', Topic)
  .handler(research, { searching, synthesizing, checking, delivered, park: parked })
  .suppliers(H.operator, recurringTopics)
  .store(sqlite.store(Topic, '.harness/topics.db'))
  .maxUsdPerUnit(topicCeilingUsd);

const withinDailyBudget = H.policy.scheduler('daily-budget', ({ now, pending, active, metrics }) => {
  const dayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const spent = metrics.sum({ of: 'costUsd', among: { entry: 'invocation', status: 'ended' }, since: dayStart }).value ?? 0;
  const projected =
    metrics.mean({ of: 'costUsd', among: { entry: 'attempt', kind: Topic, outcome: 'succeeded' }, days: 30 }).value ??
    topicCeilingUsd;
  let committed = spent + active.length * projected;
  const start: PendingView[] = [];
  for (const unit of pending) {
    if (committed + projected > dailyBudgetUsd) break;
    start.push(unit);
    committed += projected;
  }
  return { start };
});

const supervisor = claude.supervisor({
  grants: [H.ops.readWork, H.ops.writeWork, H.ops.resolveHalts, H.ops.readMemory, H.ops.writeMemory, H.ops.readTelemetry],
});

export const researchPipeline = H.harness('research-pipeline')
  .ledger(sqlite.ledger('.harness/ledger.db'))
  .lanes(topics)
  .pools(pool)
  .scheduler(withinDailyBudget)
  .clients(supervisor)
  .observers(markdown.board('BOARD.md'), markdown.telemetry('TELEMETRY.md'));

export const running = researchPipeline.start();
