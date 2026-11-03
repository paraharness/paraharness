import { H, type PendingView, type Rate, type SupplyOf } from 'harness-dsl';
import * as claudeCode from 'harness-dsl/claude-code';
import * as anthropic from 'harness-dsl/anthropic';
import * as sqlite from 'harness-dsl/sqlite';
import * as jsonl from 'harness-dsl/jsonl';
import * as qdrant from 'harness-dsl/qdrant';
import * as shell from 'harness-dsl/shell';
import * as markdown from 'harness-dsl/markdown';
import { z } from 'zod';

const open = H.state('open', 'pending');
const delivered = H.state('delivered', 'terminal', 'success');
const parked = H.state('parked', 'terminal', 'neutral');
const cancelled = H.state('cancelled', 'terminal', 'neutral');

const topic = H.kind('topic')
  .data(z.object({ question: z.string(), tags: z.array(z.string()) }))
  .states(open, delivered, parked, cancelled);

const extractRole = H.role('extractor')
  .input(z.object({ question: z.string(), url: z.string() }))
  .output(z.object({ claims: z.array(z.object({ claim: z.string(), quote: z.string() })) }))
  .prompt((i) => `Read ${i.url} and extract claims relevant to: ${i.question}. Quote the source for each.`)
  .intents(['browse']);
const synthRole = H.role('synthesizer')
  .input(z.object({
    question: z.string(),
    findings: z.array(z.object({ url: z.string(), claim: z.string(), quote: z.string() })),
  }))
  .output(z.object({ report: z.string(), citations: z.array(z.string()) }))
  .prompt((i) => `Write a sourced report on: ${i.question}\n\nFindings:\n${i.findings.map((f) => `- ${f.claim} (${f.url})`).join('\n')}`);

const priorFindings = H.journal(
  'prior-findings',
  H.memory('report-findings', 'experience'),
  qdrant.memory({ url: 'http://localhost:6333', collection: 'findings', embedder: 'text-embedding-3-small', apiKey: H.env('QDRANT_API_KEY') })
);
const sourceExperience = H.journal('source-experience', H.memory('source-experience', 'experience'), jsonl.memory('memory/sources.jsonl'));

const local = shell.local('local', { slots: 4 });

const findSources = H.command('find-sources')
  .input(z.object({ question: z.string() }))
  .output(z.object({ urls: z.array(z.string()) }))
  .argv((i) => ['search-sources', '--json', i.question])
  .on(local)
  .retry(H.retry({ times: 2 }));
const citationCheck = H.command('citation-check')
  .input(z.object({ citations: z.array(z.string()) }))
  .argv((i) => ['check-citations', ...i.citations])
  .on(local);

const cheap = anthropic.model('claude-haiku-4-5');
const strongA = anthropic.model('claude-opus-4-1');
const strongB = anthropic.model('claude-sonnet-4-5');
const noData: Rate = { value: null, hits: 0, samples: 0 };

const citationAb = H.policy.model('citation-pass-rate-ab', (choice) => {
  const rates = choice.metrics.rateBy({
    among: { entry: 'invocation', executable: citationCheck },
    count: { entry: 'invocation', executable: citationCheck, ok: true },
    by: { modelOf: choice.seat },
    days: 30,
  });
  const a = rates[strongA.name] ?? noData;
  const b = rates[strongB.name] ?? noData;
  if (a.samples < 20 || b.samples < 20) return a.samples <= b.samples ? strongA : strongB;
  return (a.value ?? 0) >= (b.value ?? 0) ? strongA : strongB;
});

const extractor = H.seat('extractor', extractRole).model(cheap).recalls(sourceExperience);
const synthesizer = H.seat('synthesizer', synthRole).model(citationAb).recalls(priorFindings, sourceExperience).records(priorFindings);
const extractAll = H.job('extract-all').batch(extractor);

const minimumSources = 5;
const research = H.flow('research')
  .for(topic)
  .does(async (ctx) => {
    const question = ctx.unit.data.question;
    const sources = await ctx.run(findSources, { question });
    if (!sources.ok) return ctx.fail(sources.error);
    const urls = sources.value.urls.slice(0, 20);
    if (urls.length < minimumSources) return 'parked';
    const extracted = await ctx.run(extractAll, urls.map((url) => ({ question, url })));
    if (!extracted.ok) return ctx.fail(extracted.error);
    const findings: { url: string; claim: string; quote: string }[] = [];
    extracted.value.forEach((result, index) => {
      if (result.ok) {
        for (const c of result.value.claims) findings.push({ url: urls[index] ?? '', claim: c.claim, quote: c.quote });
      }
    });
    if (findings.length === 0) return 'parked';
    const synthesis = await ctx.run(synthesizer, { question, findings });
    if (!synthesis.ok) return ctx.fail(synthesis.error);
    const checked = await ctx.run(citationCheck, { citations: synthesis.value.citations });
    if (!checked.ok) return ctx.fail(`unresolved citation: ${checked.error}`);
    return 'delivered';
  });

const reopenRecurring = H.clock('weekly-recurring', topic, { weekly: { day: 'mon', at: '06:00' } }, (tick) =>
  tick.units
    .filter((u) => u.data.tags.includes('recurring') && (u.state === 'delivered' || u.state === 'parked'))
    .map((u): SupplyOf<typeof topic> => ({ update: u.key, state: 'open' }))
);

const topicCeilingUsd = 3;
const dailyBudgetUsd = 40;

const topics = H.lane('topics', topic)
  .handler(research)
  .suppliers(H.operator, reopenRecurring)
  .store(sqlite.store(topic, 'harness/topics.db'))
  .maxUsdPerUnit(topicCeilingUsd)
  .retry(H.retry({ times: 1 }), 'parked');

const withinDailyBudget = H.policy.scheduler('daily-budget', (view) => {
  const now = view.now;
  const dayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const spent = view.metrics.sum({ of: 'costUsd', among: { entry: 'invocation', status: 'ended' }, since: dayStart }).value ?? 0;
  const projected =
    view.metrics.mean({ of: 'costUsd', among: { entry: 'attempt', kind: topic, outcome: 'succeeded' }, days: 30 }).value ??
    topicCeilingUsd;
  let remaining = dailyBudgetUsd - spent - view.active.length * projected;
  const start: PendingView[] = [];
  for (const unit of view.pending) {
    if (remaining < projected) break;
    start.push(unit);
    remaining -= projected;
  }
  return { start };
});

const research_report = H.report('research', (metrics) => ({
  'topic success (30d)': metrics.successRate({ kind: topic, days: 30 }),
  'parked topics (30d)': metrics.count({ of: { entry: 'transition', kind: topic, state: parked }, days: 30 }),
  'mean cost per delivered topic (30d)': metrics.mean({ of: 'costUsd', among: { entry: 'attempt', kind: topic, outcome: 'succeeded' }, days: 30 }),
  'batch extraction spend at discount (30d)': metrics.sum({ of: 'costUsd', among: { entry: 'invocation', mode: 'job' }, days: 30 }),
  'citation check pass rate (30d)': metrics.rate({
    among: { entry: 'invocation', executable: citationCheck },
    count: { entry: 'invocation', executable: citationCheck, ok: true },
    days: 30,
  }),
}));

const api = anthropic.account('api', { apiKey: H.env('ANTHROPIC_API_KEY') });

export default H.harness('research-pipeline')
  .ledger(sqlite.ledger('harness/ledger.db'))
  .lanes(topics)
  .pools(H.pool('api', [{ account: api, share: 1 }]))
  .scheduler(withinDailyBudget)
  .reports(research_report)
  .clients(
    claudeCode.supervisor({
      grants: [H.ops.readWork, H.ops.writeWork, H.ops.readMemory, H.ops.writeMemory, H.ops.readTelemetry],
    })
  )
  .observers(markdown.board('BOARD.md'), markdown.telemetry('TELEMETRY.md'));
