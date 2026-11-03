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

const open = H.state('open', 'pending');
const delivered = H.state('delivered', 'terminal', 'success');
const parked = H.state('parked', 'terminal', 'neutral');
const withdrawn = H.state('withdrawn', 'terminal', 'neutral');
const failed = H.state('failed', 'terminal', 'failure');

const topic = H.kind('Topic')
  .data(z.object({ question: z.string(), tags: z.array(z.string()) }))
  .states(open, delivered, parked, withdrawn, failed);

const source = z.object({ url: z.string(), claim: z.string() });

const searcherRole = H.role('searcher')
  .input(z.object({ question: z.string(), angle: z.number().int() }))
  .output(z.object({ sources: z.array(source) }))
  .prompt(input => `Find and extract sources for: ${input.question}\nUse search lens ${input.angle} of 20.`)
  .intents(['browse']);

const synthesizerRole = H.role('synthesizer')
  .input(z.object({ question: z.string(), findings: z.array(source) }))
  .output(z.object({ report: z.string(), citations: z.array(z.string()) }))
  .prompt(input => `Write a sourced report on: ${input.question}\n\n${input.findings.map(item => `- ${item.claim} (${item.url})`).join('\n')}`);

const findings = H.memory('prior-findings', 'experience');
const sourceExperience = H.memory('source-experience', 'experience');

const bySimilarity = H.policy.recall('by-similarity', view =>
  [...view.candidates]
    .filter(candidate => candidate.item.status === 'accepted')
    .sort((a, b) => (b.similarity ?? 0) - (a.similarity ?? 0) || b.specificity - a.specificity)
    .slice(0, view.limit)
    .map(candidate => candidate.item));

const findingsJournal = H.journal('prior-findings', findings, qdrant.memory({
  url: 'https://vectors.example.com',
  collection: 'research-findings',
  embedder: 'text-embedding-3-small',
  apiKey: H.env('QDRANT_API_KEY'),
})).recall(bySimilarity);

const sourceJournal = H.journal('source-experience', sourceExperience, jsonl.memory('./memory/sources.jsonl'));

const apiAccount = anthropic.account('research-api', { apiKey: H.env('ANTHROPIC_API_KEY') });
const pool = H.pool('anthropic', [{ account: apiAccount, share: 1 }]);

const haiku = anthropic.model('claude-haiku-4-5');
const opus = anthropic.model('claude-opus-4-1');
const sonnet = anthropic.model('claude-sonnet-4-5');

const local = shell.local('local', { slots: 2 });

const citationCheck = H.command('citation-check')
  .input(z.object({ citations: z.array(z.string()) }))
  .argv(input => ['citecheck', '--strict', ...input.citations])
  .on(local)
  .recovery('rerun');

const synthesizerModel = H.policy.model('synthesizer-by-citation-pass-rate', [opus, sonnet], choice => {
  const rates = choice.metrics.rateBy({
    by: { modelOf: choice.seat },
    among: { entry: 'invocation', executable: citationCheck, status: 'ended' },
    count: { entry: 'invocation', executable: citationCheck, status: 'ended', ok: true },
    days: 60,
  });
  const opusRate = rates.of(opus);
  const sonnetRate = rates.of(sonnet);
  if (opusRate.samples < 20) return opus;
  if (sonnetRate.samples < 20) return sonnet;
  return (opusRate.value ?? 0) >= (sonnetRate.value ?? 0) ? opus : sonnet;
});

const searcher = H.seat('searcher', searcherRole).model(haiku).recalls(sourceJournal);
const synthesizer = H.seat('synthesizer', synthesizerRole)
  .model(synthesizerModel)
  .recalls(findingsJournal, sourceJournal)
  .records(findingsJournal);

const angles = Array.from({ length: 20 }, (_, index) => index + 1);

const research = H.flow('research-topic')
  .for(topic)
  .does(async ctx => {
    const { question } = ctx.unit.data;
    const searches = await ctx.batch(searcher, angles.map(angle => ({ question, angle })));
    const gathered = searches.flatMap(result => result.ok ? result.value.sources : []);
    if (gathered.length < 5) return 'parked';
    const synthesis = await ctx.run(synthesizer, { question, findings: gathered });
    if (!synthesis.ok) return ctx.fail(synthesis.error);
    const check = await ctx.run(citationCheck, { citations: synthesis.value.citations });
    if (!check.ok) return ctx.fail(check.error);
    return 'delivered';
  });

const weeklyRecurring = H.clock('weekly-recurring-topics', topic, { weekly: { day: 'mon', at: '07:00' } }, tick =>
  tick.units
    .filter(unit => unit.position === 'terminal' && unit.data.tags.includes('recurring'))
    .map(unit => ({ create: unit.data, key: unit.key })));

const topics = H.lane('topics', topic)
  .handler(research)
  .retry({ times: 1, backoff: { first: { minutes: 30 } }, exhausted: 'failed' })
  .suppliers(H.operator, weeklyRecurring)
  .store(sqlite.store(topic, './.harness/topics.sqlite'))
  .maxUsdPerUnit(3);

const dailyBudgetUsd = 40;
const topicCeilingUsd = 3;

const withinDailyBudget = H.policy.scheduler('daily-budget', view => {
  const dayStart = new Date(view.now.getTime());
  dayStart.setUTCHours(0, 0, 0, 0);
  const spent = view.metrics.sum({ of: 'costUsd', among: { entry: 'invocation' }, since: dayStart });
  const projected = view.metrics.mean({
    of: 'costUsd',
    among: { entry: 'attempt', status: 'ended', kind: topic, outcome: 'succeeded' },
    days: 30,
  });
  const perTopic = projected.value ?? topicCeilingUsd;
  let remaining = dailyBudgetUsd - (spent.value ?? 0);
  const start: PendingView[] = [];
  for (const unit of view.pending) {
    if (perTopic > remaining) break;
    start.push(unit);
    remaining -= perTopic;
  }
  return { start };
});

const supervisor = claudeCode.supervisor({
  grants: [
    H.ops.readWork,
    H.ops.writeWork,
    H.ops.resolve(H.halts.costCeiling, H.halts.interrupted, H.halts.definitionChanged),
    H.ops.readMemory,
    H.ops.curateMemory,
    H.ops.readTelemetry,
  ],
});

const harness = H.harness('research-pipeline')
  .ledger(sqlite.ledger('./.harness/research.sqlite'))
  .lanes(topics)
  .pools(pool)
  .scheduler(withinDailyBudget)
  .clients(supervisor)
  .observers(markdown.board('./BOARD.md'), markdown.telemetry('./TELEMETRY.md'));

export const running = harness.start();
