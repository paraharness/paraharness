import { z } from 'zod';
import { H } from 'harness-dsl';
import type { PendingView, SupplyOf } from 'harness-dsl';
import * as claudeCode from 'harness-dsl/claude-code';
import * as anthropic from 'harness-dsl/anthropic';
import * as sqlite from 'harness-dsl/sqlite';
import * as jsonl from 'harness-dsl/jsonl';
import * as qdrant from 'harness-dsl/qdrant';
import * as shell from 'harness-dsl/shell';
import * as markdown from 'harness-dsl/markdown';

const queued = H.state('queued', 'pending');
const delivered = H.state('delivered', 'terminal', 'success');
const parked = H.state('parked', 'terminal', 'neutral');
const cancelled = H.state('cancelled', 'terminal', 'neutral');
const failed = H.state('failed', 'terminal', 'failure');

const Topic = H.kind('Topic')
  .data(z.object({ title: z.string(), question: z.string(), tags: z.array(z.string()) }))
  .states(queued, delivered, parked, cancelled, failed);

const source = z.object({ url: z.string(), claim: z.string() });

const searchRole = H.role('searchAndExtract')
  .input(z.object({ question: z.string(), angle: z.number().int() }))
  .output(z.object({ sources: z.array(source) }))
  .prompt(input => `Search angle ${input.angle} of 20 for: ${input.question}. Extract each source URL with the claim it supports.`)
  .intents(['browse']);

const synthesisRole = H.role('synthesizer')
  .input(z.object({ question: z.string(), sources: z.array(source) }))
  .output(z.object({ report: z.string(), citations: z.array(z.string()), keyFinding: z.string() }))
  .prompt(input => `Write a sourced report answering: ${input.question}\n\nSources:\n${input.sources.map(s => `${s.url}: ${s.claim}`).join('\n')}`);

const haiku = anthropic.model('claude-haiku-4-5');
const sonnet = anthropic.model('claude-sonnet-4-5');
const opus = anthropic.model('claude-opus-4-1');

const apiAccount = anthropic.account('anthropic-api', { apiKey: H.env('ANTHROPIC_API_KEY') });
const pool = H.pool('anthropic', [{ account: apiAccount, share: 1, serves: [haiku, sonnet, opus] }]);

const similarFindings = H.policy.recall('similarFindings', choice =>
  choice.candidates
    .filter(candidate => (candidate.similarity ?? 0) >= 0.75)
    .sort((a, b) => (b.similarity ?? 0) - (a.similarity ?? 0) || b.specificity - a.specificity)
    .slice(0, choice.limit)
    .map(candidate => candidate.item));

const findings = H.journal(
  'priorFindings',
  H.memory('priorFindings', 'experience'),
  qdrant.memory({
    url: 'https://vectors.example.com',
    collection: 'findings',
    embedder: 'text-embedding-3-small',
    apiKey: H.env('QDRANT_API_KEY'),
  }),
  similarFindings,
);
const sourceLessons = H.journal('sourceLessons', H.memory('sourceLessons', 'experience'), jsonl.memory('memory/sources.jsonl'));

const local = shell.local('local', { slots: 2 });

const citationCheck = H.command('citationCheck')
  .input(z.object({ urls: z.array(z.string()) }))
  .argv(input => ['cite-check', ...input.urls])
  .on(local)
  .recovery('rerun');

const synthesizerModel = H.policy.model('citationPassRate', [opus, sonnet], choice => {
  const checks = { entry: 'invocation', status: 'ended', executable: citationCheck } as const;
  const passRate = choice.metrics.rateBy({
    among: checks,
    count: { ...checks, ok: true },
    by: { modelOf: choice.seat },
    days: 30,
  });
  const first = passRate.of(opus);
  const second = passRate.of(sonnet);
  if (first.samples < 20) return opus;
  if (second.samples < 20) return sonnet;
  return (first.value ?? 0) >= (second.value ?? 0) ? opus : sonnet;
});

const searcher = H.seat('searcher', searchRole).model(haiku).recalls(sourceLessons).batched();
const synthesizer = H.seat('synthesizer', synthesisRole).model(synthesizerModel).recalls(findings, sourceLessons);

const research = H.flow('research')
  .for(Topic)
  .does(async ctx => {
    const question = ctx.unit.data.question;
    const angles = Array.from({ length: 20 }, (_, angle) => ({ question, angle }));
    const extracted = await ctx.batch(searcher, angles);
    const sources = extracted.flatMap(result => result.ok ? result.value.sources : []);
    if (sources.length < 5) return 'parked';
    const report = await ctx.run(synthesizer, { question, sources });
    if (!report.ok) return ctx.fail(report.error);
    const check = await ctx.run(citationCheck, { urls: report.value.citations });
    if (!check.ok) return ctx.fail(`a citation does not resolve: ${check.error}`);
    await ctx.remember(findings, {
      text: `When researching "${ctx.unit.data.title}", start from this finding: ${report.value.keyFinding}`,
      because: `the report delivered on ${ctx.now().toISOString()} established it with resolving citations`,
      when: { kinds: [Topic], roles: [synthesisRole] },
    });
    return 'delivered';
  });

const weeklyRecurring = H.schedule('weeklyRecurring', Topic, { weekly: { day: 'mon', at: '06:00' } }, tick =>
  tick.units
    .filter(unit => unit.position === 'terminal' && unit.data.tags.includes('recurring'))
    .map((unit): SupplyOf<typeof Topic> => ({ update: unit.key, state: 'queued' })));

const topics = H.lane('topics', Topic)
  .handler(research)
  .attempts(2, { backoff: { first: { minutes: 30 } }, exhausted: 'failed' })
  .suppliers(H.operator, weeklyRecurring)
  .store(sqlite.store(Topic, '.harness/topics.sqlite'))
  .maxUsdPerUnit(3);

const dailyBudgetUsd = 40;

const dailyBudget = H.policy.scheduler('dailyBudget', view => {
  const midnight = new Date(view.now.getTime());
  midnight.setHours(0, 0, 0, 0);
  const spent = view.metrics.sum({ of: 'costUsd', among: { entry: 'invocation' }, since: midnight });
  const projected = view.metrics.mean({ of: 'costUsd', among: { entry: 'attempt', kind: Topic, outcome: 'succeeded' }, days: 30 });
  const perTopic = projected.value ?? 3;
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
    H.ops.resolve(H.halts.costCeiling),
    H.ops.readMemory,
    H.ops.writeMemory,
    H.ops.readTelemetry,
  ],
});

export const researchPipeline = H.harness('research-pipeline')
  .ledger(sqlite.ledger('.harness/ledger.sqlite'))
  .lanes(topics)
  .pools(pool)
  .scheduler(dailyBudget)
  .clients(supervisor)
  .observers(markdown.board('BOARD.md'), markdown.telemetry('TELEMETRY.md'));
