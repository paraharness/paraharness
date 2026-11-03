import { z } from 'zod';
import { H } from 'harness-dsl';
import type { PendingView } from 'harness-dsl';
import * as claude from 'harness-dsl/claude-code';
import * as anthropic from 'harness-dsl/anthropic';
import * as sqlite from 'harness-dsl/sqlite';
import * as jsonl from 'harness-dsl/jsonl';
import * as qdrant from 'harness-dsl/qdrant';
import * as shell from 'harness-dsl/shell';
import * as markdown from 'harness-dsl/markdown';

const topic = H.kind('Topic')
  .data(z.object({ question: z.string(), tags: z.array(z.string()), report: z.string().optional() }))
  .states(
    H.state('queued', 'pending'),
    H.state('reported', 'terminal', 'success'),
    H.state('parked', 'terminal', 'neutral'),
    H.state('withdrawn', 'terminal', 'neutral'),
    H.state('unverified', 'terminal', 'failure')
  );

const finding = z.object({ claim: z.string(), source: z.string() });

const searchRole = H.role('search-and-extract')
  .input(z.object({ question: z.string(), page: z.number() }))
  .output(z.object({ findings: z.array(finding) }))
  .prompt(i => `Search result page ${i.page} for: ${i.question}. Extract sourced claims.`)
  .intents(['browse']);

const synthesisRole = H.role('synthesizer')
  .input(z.object({ question: z.string(), findings: z.array(finding) }))
  .output(z.object({ report: z.string(), citations: z.array(z.string()), keyFinding: z.string() }))
  .prompt(i => `Write a sourced report on: ${i.question}\n\n${i.findings.map(f => `- ${f.claim} (${f.source})`).join('\n')}`);

const local = shell.local('local', { slots: 2 });

const citationCheck = H.command('citation-check')
  .input(z.object({ citations: z.array(z.string()) }))
  .argv(i => ['./bin/check-citations', ...i.citations])
  .on(local)
  .recovery('rerun');

const haiku = anthropic.model('claude-haiku');
const opus = anthropic.model('claude-opus');
const sonnet = anthropic.model('claude-sonnet');

const synthesizerModel = H.policy.model('synthesizer-by-citation-pass-rate', [opus, sonnet], choice => {
  const rates = choice.metrics.rateBy({
    days: 60,
    among: { entry: 'invocation', status: 'ended', executable: citationCheck },
    count: { entry: 'invocation', status: 'ended', executable: citationCheck, ok: true },
    by: { modelOf: choice.seat },
  });
  const first = rates.of(opus);
  const second = rates.of(sonnet);
  if (first.samples < 30 || second.samples < 30) return first.samples <= second.samples ? opus : sonnet;
  return (first.value ?? 0) >= (second.value ?? 0) ? opus : sonnet;
});

const mostSimilar = H.policy.recall('most-similar', view =>
  view.candidates
    .filter(c => (c.similarity ?? 0) >= 0.75)
    .sort((a, b) => (b.similarity ?? 0) - (a.similarity ?? 0))
    .slice(0, 6)
);
const specificFirst = H.policy.recall('specific-first', view => view.ranked.slice(0, 8));

const priorFindings = H.journal(
  'prior-findings',
  H.memory('report-finding', 'experience'),
  qdrant.memory({ url: 'https://vectors.example.com', collection: 'findings', embedder: 'text-embedding', apiKey: H.env('QDRANT_API_KEY') }),
  mostSimilar
);
const sourceExperience = H.journal('source-experience', H.memory('source-experience', 'experience'), jsonl.memory('memory/sources.jsonl'), specificFirst);

const searcher = H.seat('searcher', searchRole).model(haiku).recalls(sourceExperience);
const synthesizer = H.seat('synthesizer', synthesisRole).model(synthesizerModel).recalls(priorFindings, sourceExperience);

const research = H.flow('research').for(topic).does(async ctx => {
  const { question } = ctx.unit.data;
  const searches = await ctx.batch(
    searcher,
    Array.from({ length: 20 }, (_, i) => ({ question, page: i + 1 }))
  );
  const findings = searches.flatMap(r => (r.ok ? r.value.findings : []));
  if (findings.length < 5) return 'parked';
  const synthesized = await ctx.run(synthesizer, { question, findings });
  if (!synthesized.ok) return ctx.fail(synthesized);
  const checked = await ctx.run(citationCheck, { citations: synthesized.value.citations });
  if (!checked.ok) return ctx.fail(checked);
  await ctx.update({ report: synthesized.value.report });
  await ctx.remember(priorFindings, {
    text: `When researching questions like "${question}", start from: ${synthesized.value.keyFinding}`,
    because: 'a cited report established it',
    when: { kinds: [topic], roles: [synthesisRole] },
  });
  return 'reported';
});

const weeklyRecurring = H.clock('weekly-recurring', topic, { weekly: { day: 'mon', at: '06:00' } }, tick =>
  tick.units
    .filter(u => u.position === 'terminal' && u.data.tags.includes('recurring'))
    .map(u => tick.update(u.key, { state: 'queued' }))
);

const topics = H.lane('topics', topic)
  .handler(research)
  .retries(1, 'unverified', { first: { minutes: 30 } })
  .suppliers(H.operator, weeklyRecurring)
  .store(sqlite.store(topic, '.harness/topics.db'))
  .maxUsdPerUnit(3);

const dailyBudget = H.policy.scheduler('daily-budget-40-usd', view => {
  const midnight = new Date(view.now);
  midnight.setUTCHours(0, 0, 0, 0);
  const spent = view.metrics.sum({ of: 'costUsd', among: { entry: 'invocation', status: 'ended' }, since: midnight }).value ?? 0;
  const projected = view.metrics.mean({
    of: 'costUsd',
    among: { entry: 'attempt', status: 'ended', kind: topic, outcome: 'succeeded' },
    days: 30,
  }).value ?? 3;
  let remaining = 40 - spent - view.live.length * projected;
  const start: PendingView[] = [];
  for (const unit of view.pending) {
    if (projected > remaining) break;
    start.push(unit);
    remaining -= projected;
  }
  return { start };
});

const operator = claude.supervisor({
  grants: [H.ops.readWork, H.ops.writeWork, H.ops.resolve(H.halts.costCeiling), H.ops.readMemory, H.ops.curateMemory, H.ops.readTelemetry],
});

export const harness = H.harness('research-pipeline')
  .ledger(sqlite.ledger('.harness/ledger.db'))
  .lanes(topics)
  .pools(H.pool('anthropic', [{ account: anthropic.account('anthropic-api', { apiKey: H.env('ANTHROPIC_API_KEY') }), share: 1 }]))
  .scheduler(dailyBudget)
  .clients(operator)
  .observers(markdown.board('BOARD.md'), markdown.telemetry('TELEMETRY.md'));
