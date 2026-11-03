import { z } from 'zod';
import { H, type PendingView, type SupplyOf } from 'harness-dsl';
import * as anthropic from 'harness-dsl/anthropic';
import * as claudeCode from 'harness-dsl/claude-code';
import * as sqlite from 'harness-dsl/sqlite';
import * as jsonl from 'harness-dsl/jsonl';
import * as qdrant from 'harness-dsl/qdrant';
import * as shell from 'harness-dsl/shell';
import * as markdown from 'harness-dsl/markdown';

const requested = H.state('requested', 'pending');
const reported = H.state('reported', 'terminal', 'success');
const parked = H.state('parked', 'terminal', 'neutral');
const withdrawn = H.state('withdrawn', 'terminal', 'neutral');
const unresolved = H.state('unresolved', 'terminal', 'failure');

const topic = H.kind('Topic')
  .data(z.object({
    title: z.string(),
    question: z.string(),
    tags: z.array(z.string()),
    report: z.string().optional(),
  }))
  .states(requested, reported, parked, withdrawn, unresolved);

const haiku = anthropic.model('claude-haiku-4-5');
const sonnet = anthropic.model('claude-sonnet-4-5');
const opus = anthropic.model('claude-opus-4-1');
const apiAccount = anthropic.account('researchApi', { apiKey: H.env('ANTHROPIC_API_KEY') });
const pool = H.pool('researchPool', [{ account: apiAccount, share: 1 }]);

const local = shell.local('local', { slots: 2 });

const similarFindings = H.policy.recall('similarFindingsFirst', choice =>
  [...choice.candidates]
    .filter(candidate => (candidate.similarity ?? 0) >= 0.75)
    .sort((a, b) => (b.similarity ?? 0) - (a.similarity ?? 0) || b.specificity - a.specificity)
    .slice(0, choice.limit)
    .map(candidate => candidate.item)
);

const findingsMemory = H.memory('priorFindings', 'experience');
const sourceMemory = H.memory('sourceLessons', 'experience');

const findingsJournal = H.journal(
  'findingsJournal',
  findingsMemory,
  qdrant.memory({
    url: 'https://vectors.example.com',
    collection: 'research-findings',
    embedder: 'text-embedding-3-small',
    apiKey: H.env('QDRANT_API_KEY'),
  }),
  similarFindings
);
const sourceJournal = H.journal('sourceJournal', sourceMemory, jsonl.memory('memory/sources.jsonl'));

const citationCheck = H.command('checkCitations')
  .input(z.object({ citations: z.array(z.string()) }))
  .argv(input => ['check-citations', ...input.citations])
  .on(local)
  .recovery('rerun');

const synthesizerModel = H.policy.model('citationPassRate', [opus, sonnet], choice => {
  const byModel = choice.metrics.rateBy({
    among: { entry: 'invocation', executable: citationCheck, status: 'ended' },
    count: { entry: 'invocation', executable: citationCheck, status: 'ended', ok: true },
    days: 30,
    by: { modelOf: choice.seat },
  });
  const first = byModel.of(opus);
  const second = byModel.of(sonnet);
  if (first.samples < 20) return opus;
  if (second.samples < 20) return sonnet;
  return (first.value ?? 0) >= (second.value ?? 0) ? opus : sonnet;
});

const sourceShape = z.object({ url: z.string(), claim: z.string() });

const searchRole = H.role('searchAndExtract')
  .input(z.object({ question: z.string(), angle: z.number() }))
  .output(z.object({ sources: z.array(sourceShape) }))
  .prompt(input => `Search angle ${input.angle} of 20 for: ${input.question}. Extract claims with their source URLs.`)
  .intents(['browse']);

const synthesisRole = H.role('synthesize')
  .input(z.object({ question: z.string(), sources: z.array(sourceShape) }))
  .output(z.object({ report: z.string(), citations: z.array(z.string()), findings: z.array(z.string()) }))
  .prompt(input => `Write a sourced report answering: ${input.question}\n\n${input.sources.map(s => `${s.url}: ${s.claim}`).join('\n')}`);

const searcher = H.seat('searcher', searchRole).model(haiku).recalls(sourceJournal);
const synthesizer = H.seat('synthesizer', synthesisRole)
  .model(synthesizerModel)
  .recalls(findingsJournal, sourceJournal)
  .records(sourceJournal);

const angles = Array.from({ length: 20 }, (_, index) => index + 1);

const research = H.flow('researchTopic')
  .for(topic)
  .does(async ctx => {
    const { title, question } = ctx.unit.data;
    const searched = await ctx.batch(searcher, angles.map(angle => ({ question, angle })));
    const sources = searched.flatMap(result => (result.ok ? result.value.sources : []));
    if (sources.length < 8) return 'parked';
    const synthesis = await ctx.run(synthesizer, { question, sources });
    if (!synthesis.ok) return ctx.fail(synthesis.error);
    const checked = await ctx.run(citationCheck, { citations: synthesis.value.citations });
    if (!checked.ok) return ctx.fail(`a citation did not resolve: ${checked.error}`);
    await ctx.update({ report: synthesis.value.report });
    for (const finding of synthesis.value.findings) {
      await ctx.remember(findingsJournal, {
        text: finding,
        because: `the report on "${title}" established it`,
        when: { kinds: [topic] },
      });
    }
    return 'reported';
  });

const recurring = H.schedule('recurringTopicsWeekly', topic, { weekly: { day: 'mon', at: '06:00' } }, tick =>
  tick.units
    .filter(unit => unit.position === 'terminal' && unit.data.tags.includes('recurring'))
    .map((unit): SupplyOf<typeof topic> => ({ update: unit.key, state: 'requested' }))
);

const topics = H.lane('topics', topic)
  .handler(research)
  .retries(1, { backoff: { first: { minutes: 30 } }, exhausted: 'unresolved' })
  .suppliers(H.operator, recurring)
  .store(sqlite.store(topic, '.harness/topics.db'))
  .maxUsdPerUnit(3);

const dailyBudgetUsd = 40;
const topicCeilingUsd = 3;

const dailyBudget = H.policy.scheduler('dailyBudget', view => {
  const startOfDay = new Date(view.now.getFullYear(), view.now.getMonth(), view.now.getDate());
  const spent = view.metrics.sum({ of: 'costUsd', among: { entry: 'invocation', status: 'ended', kind: topic }, since: startOfDay });
  const projected = view.metrics.mean({
    of: 'costUsd',
    among: { entry: 'attempt', status: 'ended', kind: topic, outcome: 'succeeded' },
    days: 30,
  });
  const perTopic = projected.samples > 0 && projected.value !== null ? projected.value : topicCeilingUsd;
  let remaining = dailyBudgetUsd - (spent.value ?? 0) - view.live.length * perTopic;
  const start: PendingView[] = [];
  for (const unit of [...view.pending].sort((a, b) => b.waitedMs - a.waitedMs)) {
    if (perTopic > remaining) break;
    start.push(unit);
    remaining -= perTopic;
  }
  return { start };
});

const supervisor = claudeCode.supervisor({
  grants: [H.ops.readWork, H.ops.writeWork, H.ops.resolveHalts, H.ops.readMemory, H.ops.curateMemory, H.ops.readTelemetry],
});

export const researchHarness = H.harness('researchPipeline')
  .ledger(sqlite.ledger('.harness/research.db'))
  .lanes(topics)
  .pools(pool)
  .scheduler(dailyBudget)
  .clients(supervisor)
  .observers(markdown.board('BOARD.md'), markdown.telemetry('TELEMETRY.md'));

export const running = researchHarness.start();
