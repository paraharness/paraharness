import { z } from 'zod';
import { H, type PendingView, type Model, type SupplyOf } from 'harness-dsl';
import * as claudeCode from 'harness-dsl/claude-code';
import * as anthropic from 'harness-dsl/anthropic';
import * as sqlite from 'harness-dsl/sqlite';
import * as jsonl from 'harness-dsl/jsonl';
import * as qdrant from 'harness-dsl/qdrant';
import * as shell from 'harness-dsl/shell';
import * as markdown from 'harness-dsl/markdown';

const open = H.state('open', 'pending');
const reported = H.state('reported', 'terminal', 'success');
const parked = H.state('parked', 'terminal', 'neutral');
const withdrawn = H.state('withdrawn', 'terminal', 'neutral');
const unsourced = H.state('unsourced', 'terminal', 'failure');

const topic = H.kind('topic')
  .data(z.object({ title: z.string(), question: z.string(), tags: z.array(z.string()) }))
  .states(open, reported, parked, withdrawn, unsourced);

const finding = z.object({ claim: z.string(), source: z.string() });

const searcherRole = H.role('search-extract')
  .input(z.object({ title: z.string(), question: z.string(), angle: z.number() }))
  .output(z.object({ findings: z.array(finding) }))
  .prompt(i => `Search angle ${i.angle} of 20 for "${i.title}": ${i.question}. Extract sourced claims.`)
  .intents(['browse']);

const synthesizerRole = H.role('synthesizer')
  .input(z.object({ title: z.string(), question: z.string(), findings: z.array(finding) }))
  .output(z.object({ report: z.string(), citations: z.array(z.string()), keyFindings: z.array(z.string()) }))
  .prompt(i => `Write a sourced report on "${i.title}" answering: ${i.question}\n${i.findings.map(f => `- ${f.claim} [${f.source}]`).join('\n')}`);

const priorFindings = H.journal(
  'prior-findings',
  H.memory('prior-findings', 'experience'),
  qdrant.memory({ url: 'https://vectors.internal', collection: 'findings', embedder: 'text-embedding', apiKey: H.env('QDRANT_API_KEY') })
);
const sourceLessons = H.journal('source-lessons', H.memory('source-lessons', 'experience'), jsonl.memory('memory/sources.jsonl'));

const api = anthropic.account('research-api', { apiKey: H.env('ANTHROPIC_API_KEY') });
const pool = H.pool('research', [{ account: api, share: 1 }]);

const haiku = anthropic.model('claude-haiku-4-5');
const opus = anthropic.model('claude-opus-4-1');
const sonnet = anthropic.model('claude-sonnet-4-5');

const citationPassRate = H.policy.model('citation-pass-rate', choice => {
  const pass = (model: Model) =>
    choice.metrics.rate({
      among: { entry: 'grade', seat: choice.seat, model },
      count: { entry: 'grade', seat: choice.seat, model, grade: 'accepted' },
      days: 60,
    });
  const a = pass(opus);
  const b = pass(sonnet);
  if (a.samples < 30 || b.samples < 30) return a.samples <= b.samples ? opus : sonnet;
  return (a.value ?? 0) >= (b.value ?? 0) ? opus : sonnet;
});

const searcher = H.seat('searcher', searcherRole).model(haiku).recalls(sourceLessons);
const synthesizer = H.seat('synthesizer', synthesizerRole)
  .model(citationPassRate)
  .recalls(priorFindings, sourceLessons)
  .records(sourceLessons);

const searchBatch = H.job('search-batch').batch(searcher);

const local = shell.local('local', { slots: 2 });
const citationCheck = H.command('citation-check')
  .input(z.object({ citations: z.array(z.string()) }))
  .argv(i => ['check-citations', ...i.citations])
  .on(local)
  .recovery('rerun');

const minimumFindings = 5;

const research = H.flow('research')
  .for(topic)
  .does(async ctx => {
    const { title, question } = ctx.unit.data;
    const angles = Array.from({ length: 20 }, (_, i) => ({ title, question, angle: i + 1 }));
    const searched = await ctx.run(searchBatch, angles);
    if (!searched.ok) return ctx.fail(searched.error);
    const findings: z.infer<typeof finding>[] = [];
    for (const item of searched.value) {
      if (item.ok) for (const f of item.value.findings) findings.push(f);
    }
    if (findings.length < minimumFindings) return 'parked';
    const synthesized = await ctx.run(synthesizer, { title, question, findings });
    if (!synthesized.ok) return ctx.fail(synthesized.error);
    const checked = await ctx.run(citationCheck, { citations: synthesized.value.citations });
    await ctx.grade(synthesized, checked.ok ? 'accepted' : 'rejected');
    if (!checked.ok) return ctx.fail(`a citation did not resolve: ${checked.error}`);
    for (const key of synthesized.value.keyFindings) {
      await ctx.remember(priorFindings, {
        text: `When researching questions like "${question}", start from: ${key}`,
        because: `the report on ${title} established it with resolving citations`,
        when: { kinds: [topic], roles: [synthesizerRole] },
        status: 'accepted',
      });
    }
    return 'reported';
  });

const reopenRecurring = H.clock('weekly-recurring', topic, { weekly: { day: 'mon', at: '06:00' } }, tick =>
  tick.units
    .filter(u => u.position === 'terminal' && u.data.tags.some(t => t === 'recurring'))
    .map((u): SupplyOf<typeof topic> => ({ update: u.key, state: 'open' }))
);

const topicCeilingUsd = 3;
const dailyBudgetUsd = 40;

const topicAllowance = H.allowance('topic-allowance', topic)
  .retry(H.policy.retry('topic-retry', { retries: 1, firstDelayMs: 900000 }), 'unsourced')
  .maxUsd(topicCeilingUsd);

const topics = H.lane('topics', topic)
  .handler(research)
  .suppliers(H.operator, reopenRecurring)
  .store(sqlite.store(topic, 'topics.db'))
  .allowance(topicAllowance);

const withinDailyBudget = H.policy.scheduler('within-daily-budget', view => {
  const dayStart = new Date(Date.UTC(view.now.getUTCFullYear(), view.now.getUTCMonth(), view.now.getUTCDate()));
  const spent = view.metrics.sum({ of: 'costUsd', among: { entry: 'invocation', kind: topic }, since: dayStart }).value ?? 0;
  const projected = view.metrics.mean({ of: 'costUsd', among: { entry: 'attempt', kind: topic, outcome: 'succeeded' }, days: 30 });
  const perTopic = projected.samples >= 5 && projected.value !== null ? projected.value : topicCeilingUsd;
  let remaining = dailyBudgetUsd - spent - view.active.length * perTopic;
  const start: PendingView[] = [];
  for (const unit of view.pending) {
    if (remaining < perTopic) break;
    start.push(unit);
    remaining -= perTopic;
  }
  return { start };
});

const researchSpend = H.report('research-spend', (metrics, now) => ({
  'batch spend today, at discount': metrics.sum({
    of: 'costUsd',
    among: { entry: 'invocation', kind: topic, batch: true },
    since: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())),
  }),
  'mean cost of succeeded topics, 30d': metrics.mean({
    of: 'costUsd',
    among: { entry: 'attempt', kind: topic, outcome: 'succeeded' },
    days: 30,
  }),
  'citation pass rate, 60d': metrics.rate({
    among: { entry: 'grade', seat: synthesizer },
    count: { entry: 'grade', seat: synthesizer, grade: 'accepted' },
    days: 60,
  }),
  'parked share of ended topics, 30d': metrics.rate({
    among: { entry: 'transition', kind: topic, position: 'terminal' },
    count: { entry: 'transition', kind: topic, state: parked },
    days: 30,
  }),
}));

const supervisor = claudeCode.supervisor({
  grants: [
    H.ops.readWork,
    H.ops.writeWork,
    H.ops.readMemory,
    H.ops.writeMemory,
    H.ops.readTelemetry,
    H.ops.resolve(H.halts.changed, H.halts.interrupted),
  ],
});

export const harness = H.harness('research-pipeline')
  .ledger(sqlite.ledger('ledger.db'))
  .lanes(topics)
  .pools(pool)
  .scheduler(withinDailyBudget)
  .reports(researchSpend)
  .clients(supervisor)
  .observers(markdown.board('BOARD.md'), markdown.telemetry('TELEMETRY.md'));

export const running = harness.start();
