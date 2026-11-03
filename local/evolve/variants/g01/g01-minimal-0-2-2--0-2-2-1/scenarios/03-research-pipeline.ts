import { z } from 'zod';
import { H } from 'harness-dsl';
import type { PendingView, Rate, SupplyOf } from 'harness-dsl';
import * as claudeCode from 'harness-dsl/claude-code';
import * as anthropic from 'harness-dsl/anthropic';
import * as sqlite from 'harness-dsl/sqlite';
import * as jsonl from 'harness-dsl/jsonl';
import * as qdrant from 'harness-dsl/qdrant';
import * as shell from 'harness-dsl/shell';
import * as markdown from 'harness-dsl/markdown';

const open = H.state('open', 'pending');
const delivered = H.state('delivered', 'terminal', 'success');
const parked = H.state('parked', 'terminal', 'neutral');
const withdrawn = H.state('withdrawn', 'terminal', 'neutral');
const unresolvable = H.state('unresolvable', 'terminal', 'failure');

const topic = H.kind('topic')
  .data(z.object({
    title: z.string(),
    question: z.string(),
    tags: z.array(z.string()),
    report: z.string().optional(),
  }))
  .states(open, delivered, parked, withdrawn, unresolvable);

const source = z.object({ url: z.string(), claim: z.string() });

const searcherRole = H.role('searcher')
  .input(z.object({ question: z.string(), angle: z.string() }))
  .output(z.object({ sources: z.array(source) }))
  .prompt(task => `Find and extract sources on: ${task.question}\nFocus: ${task.angle}`)
  .intents(['browse']);

const synthesizerRole = H.role('synthesizer')
  .input(z.object({ question: z.string(), sources: z.array(source) }))
  .output(z.object({ report: z.string(), findings: z.array(z.string()), citations: z.array(z.string()) }))
  .prompt(task => `Write a sourced report answering: ${task.question}\nSources:\n${task.sources.map(s => `${s.url}: ${s.claim}`).join('\n')}`)
  .intents(['read']);

const priorFindings = H.memory('prior-findings', 'experience');
const sourceExperience = H.memory('source-experience', 'experience');
const findingsLibrary = H.library('findings-library', priorFindings, qdrant.memory({
  url: 'https://vectors.example.com',
  collection: 'research-findings',
  embedder: 'text-embedding-3-small',
  apiKey: H.env('QDRANT_API_KEY'),
}));
const sourceJournal = H.library('source-journal', sourceExperience, jsonl.memory('.harness/sources.jsonl'));

const local = shell.local('local', { slots: 2 });

const citationCheck = H.command('citation-check')
  .input(z.object({ citations: z.array(z.string()) }))
  .argv(check => ['./scripts/check-citations', ...check.citations])
  .on(local)
  .recovery('rerun');

const haiku = anthropic.model('claude-haiku-4-5');
const opus = anthropic.model('claude-opus-4-1');
const sonnet = claudeCode.model('claude-sonnet-4-5');

const noSamples: Rate = { value: null, hits: 0, samples: 0 };
const checkRuns = { entry: 'invocation', executable: citationCheck, status: 'ended' } satisfies { entry: 'invocation'; executable: typeof citationCheck; status: string };

const synthesizerModel = H.policy.model('synthesizer-model', [opus, sonnet], choice => {
  const passRate = choice.metrics.rateBy({
    among: checkRuns,
    count: { ...checkRuns, ok: true },
    by: { modelOf: choice.seat },
    days: 30,
  });
  const opusRate = passRate[opus.name] ?? noSamples;
  const sonnetRate = passRate[sonnet.name] ?? noSamples;
  if (opusRate.samples < 15) return opus;
  if (sonnetRate.samples < 15) return sonnet;
  return (sonnetRate.value ?? 0) > (opusRate.value ?? 0) ? sonnet : opus;
});

const searcher = H.seat('searcher-agent', searcherRole).model(haiku).recalls(sourceJournal);
const synthesizer = H.seat('synthesizer-agent', synthesizerRole)
  .model(synthesizerModel)
  .recalls(findingsLibrary, sourceJournal);

const searchAngles = [
  'definitions', 'history', 'recent results', 'methods', 'datasets',
  'benchmarks', 'criticism', 'replications', 'surveys', 'industry use',
  'regulation', 'costs', 'open problems', 'competing approaches', 'case studies',
  'failure reports', 'theory', 'tooling', 'expert opinion', 'forecasts',
];

const researchTopic = H.flow('research-topic').for(topic).does(async ctx => {
  const { title, question } = ctx.unit.data;
  const searches = await ctx.batch(searcher, searchAngles.map(angle => ({ question, angle })));
  const sources = searches.flatMap(result => result.ok ? result.value.sources : []);
  if (sources.length < 5) return 'parked';
  const synthesis = await ctx.run(synthesizer, { question, sources });
  if (!synthesis.ok) return ctx.fail(synthesis.error);
  const check = await ctx.run(citationCheck, { citations: synthesis.value.citations });
  if (!check.ok) return ctx.fail(`a citation did not resolve: ${check.error}`);
  await ctx.update({ report: synthesis.value.report });
  for (const finding of synthesis.value.findings) {
    await ctx.remember(findingsLibrary, {
      text: `When researching a question like "${title}", start from this finding: ${finding}`,
      because: `the delivered report on "${title}" established it with resolving citations`,
      when: { kinds: [topic], roles: [synthesizerRole] },
    });
  }
  return 'delivered';
});

const recurringTopics = H.clock('recurring-topics', topic, { weekly: { day: 'mon', at: '06:00' } }, tick =>
  tick.units
    .filter(unit => unit.position === 'terminal' && unit.data.tags.includes('recurring'))
    .map((unit): SupplyOf<typeof topic> => ({ update: unit.key, state: 'open' })));

const topics = H.lane('topics', topic)
  .handler(researchTopic)
  .suppliers(H.operator, recurringTopics)
  .store(sqlite.store(topic, '.harness/topics.db'))
  .maxUsdPerUnit(3)
  .retries(2, { backoff: { first: { minutes: 30 }, factor: 2 }, exhausted: 'unresolvable' });

const dailyBudgetUsd = 40;
const topicCeilingUsd = 3;

const dailyBudget = H.policy.scheduler('daily-budget', view => {
  const midnight = new Date(view.now.getFullYear(), view.now.getMonth(), view.now.getDate());
  const spentToday = view.metrics.sum({ of: 'costUsd', among: { entry: 'invocation', status: 'ended' }, since: midnight }).value ?? 0;
  const projected = view.metrics.mean({
    of: 'costUsd',
    among: { entry: 'attempt', status: 'ended', kind: topic, outcome: 'succeeded' },
    days: 30,
  });
  const perTopic = projected.value ?? topicCeilingUsd;
  let remaining = dailyBudgetUsd - spentToday - view.live.length * perTopic;
  const start: PendingView[] = [];
  for (const unit of view.pending) {
    if (remaining < perTopic) break;
    start.push(unit);
    remaining -= perTopic;
  }
  return { start };
});

const apiAccount = anthropic.account('anthropic-api', { apiKey: H.env('ANTHROPIC_API_KEY') });
const subscription = claudeCode.subscription('claude-max-research', { token: H.env('CLAUDE_TOKEN') });
const researchPool = H.pool('research', [
  { account: apiAccount, share: 1 },
  { account: subscription, share: 0.8 },
]);

const operatorClient = claudeCode.supervisor({
  grants: [H.ops.readWork, H.ops.writeWork, H.ops.readMemory, H.ops.curateMemory, H.ops.readTelemetry],
});

export const researchPipeline = H.harness('research-pipeline')
  .ledger(sqlite.ledger('.harness/ledger.db'))
  .lanes(topics)
  .pools(researchPool)
  .scheduler(dailyBudget)
  .clients(operatorClient)
  .observers(markdown.board('BOARD.md'), markdown.telemetry('TELEMETRY.md'));
