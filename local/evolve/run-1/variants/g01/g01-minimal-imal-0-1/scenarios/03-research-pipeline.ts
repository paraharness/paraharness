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

const Topic = H.kind('Topic')
  .data(z.object({ question: z.string(), recurring: z.boolean() }))
  .states(
    [
      H.state('queued', 'pending'),
      H.state('researching', 'active'),
      H.state('synthesizing', 'active'),
      H.state('checking', 'active'),
      H.state('delivered', 'terminal', 'success'),
      H.state('parked', 'terminal', 'neutral'),
      H.state('cancelled', 'terminal', 'neutral'),
      H.state('failed', 'terminal', 'failure'),
    ],
    { initial: 'queued', afterFailure: 'failed' }
  );

const findings = H.memory('report-findings', 'experience');
const sourceLessons = H.memory('source-lessons', 'experience');

const nearestFindings = H.policy.recall('nearest-findings', view =>
  view.items
    .filter(item => item.status === 'accepted')
    .sort(
      (a, b) =>
        (b.similarity ?? 0) - (a.similarity ?? 0) || b.specificity - a.specificity || a.id.localeCompare(b.id)
    )
    .slice(0, 8)
);

const specificThenProven = H.policy.recall('specific-then-proven', view =>
  view.items
    .filter(item => item.status === 'accepted')
    .sort((a, b) => b.specificity - a.specificity || (b.trackRecord.value ?? 0) - (a.trackRecord.value ?? 0))
    .slice(0, 8)
);

const findingsLibrary = H.library(
  'prior-findings',
  findings,
  qdrant.memory({
    url: 'https://vectors.example.com',
    collection: 'research-findings',
    embedder: 'text-embedding-3-small',
    apiKey: H.env('QDRANT_API_KEY'),
  })
).recall(nearestFindings);

const sourceLibrary = H.library('source-lessons', sourceLessons, jsonl.memory('memory/sources.jsonl')).recall(specificThenProven);

const api = anthropic.account('anthropic-api', { apiKey: H.env('ANTHROPIC_API_KEY') });
const haiku = anthropic.model('claude-haiku-4-5');
const opus = anthropic.model('claude-opus-4-1');
const sonnet = anthropic.model('claude-sonnet-4-5');

const firstEligible = H.policy.account('first-eligible', choice => {
  const open = choice.accounts.find(view => view.eligible);
  return open === undefined ? null : open.account;
});
const apiPool = H.pool('api', [{ account: api, share: 1 }], firstEligible);

const local = shell.local('local', { slots: 2 });

const planSearches = H.command('plan-searches')
  .input(z.object({ question: z.string() }))
  .output(z.object({ queries: z.array(z.string()) }))
  .argv(input => ['./bin/plan-searches', input.question])
  .on(local)
  .ifInterrupted('rerun');

const citationCheck = H.command('citation-check')
  .input(z.object({ citations: z.array(z.string()) }))
  .argv(input => ['./bin/check-citations', ...input.citations])
  .on(local)
  .ifInterrupted('rerun');

const samplesOf = (rate: Rate | undefined) => (rate === undefined ? 0 : rate.samples);
const valueOf = (rate: Rate | undefined) => (rate === undefined || rate.value === null ? 0 : rate.value);

const citationPassRate = H.policy.model('synthesizer-by-citation-pass', choice => {
  const byModel = choice.metrics.rateBy({
    among: { entry: 'invocation', executable: citationCheck.name },
    count: { entry: 'invocation', executable: citationCheck.name, ok: true },
    by: { tag: 'synthesizerModel' },
    days: 30,
  });
  const forOpus = byModel[opus.name];
  const forSonnet = byModel[sonnet.name];
  if (samplesOf(forOpus) < 20) return opus;
  if (samplesOf(forSonnet) < 20) return sonnet;
  return valueOf(forSonnet) > valueOf(forOpus) ? sonnet : opus;
});

const extractRole = H.role('search-and-extract')
  .input(z.object({ question: z.string(), query: z.string() }))
  .output(z.object({ sources: z.array(z.object({ url: z.string(), claim: z.string() })) }))
  .prompt(input => `Question: ${input.question}\nSearch: ${input.query}\nReturn sources with the claim each supports.`)
  .intents(['browse']);

const synthesizeRole = H.role('synthesizer')
  .input(z.object({ question: z.string(), sources: z.array(z.object({ url: z.string(), claim: z.string() })) }))
  .output(z.object({ report: z.string(), citations: z.array(z.string()), findings: z.array(z.string()) }))
  .prompt(
    input =>
      `Write a sourced report on: ${input.question}\n\n${input.sources.map(source => `${source.url}: ${source.claim}`).join('\n')}`
  );

const extractor = H.agent('extractor', extractRole).model(haiku);
const synthesizer = H.agent('synthesizer', synthesizeRole)
  .model(citationPassRate)
  .recalls(findingsLibrary, sourceLibrary)
  .records(sourceLibrary);

const minimumSources = 5;

const researchFlow = H.flow('research')
  .for(Topic)
  .does(async ctx => {
    const question = ctx.unit.data.question;
    await ctx.move('researching');
    const planned = await ctx.run(planSearches, { question });
    if (planned.ok === false) return ctx.fail(planned.error);
    const extracted = await ctx.batch(
      extractor,
      planned.value.queries.slice(0, 20).map(query => ({ question, query }))
    );
    const sources = extracted.flatMap(result => (result.ok ? result.value.sources : []));
    if (sources.length < minimumSources) return 'parked';

    await ctx.move('synthesizing');
    const synthesized = await ctx.run(synthesizer, { question, sources });
    if (synthesized.ok === false) return ctx.fail(synthesized.error);
    ctx.tag({ synthesizerModel: synthesized.model ?? 'unknown' });

    await ctx.move('checking');
    const checked = await ctx.run(citationCheck, { citations: synthesized.value.citations });
    if (checked.ok === false) return ctx.fail(`citation did not resolve: ${checked.error}`);

    for (const finding of synthesized.value.findings) {
      await ctx.remember(findingsLibrary, { text: finding, when: { kinds: [Topic], roles: [synthesizeRole] } });
    }
    return 'delivered';
  });

const weeklyReopen = H.calendar('reopen-recurring-weekly', Topic, { weekly: { day: 'mon', at: '07:00' } }, tick =>
  tick.units
    .filter(unit => unit.data.recurring && (unit.state === 'delivered' || unit.state === 'parked'))
    .map<SupplyOf<typeof Topic>>(unit => ({ update: unit.key, state: 'queued' }))
);

const topicCeilingUsd = 3;
const dailyBudgetUsd = 40;

const topics = H.lane('topics', Topic)
  .handler(researchFlow)
  .suppliers(H.operator, weeklyReopen)
  .store(sqlite.store(Topic, 'topics.db'))
  .maxUsdPerUnit(topicCeilingUsd);

const withinDailyBudget = H.policy.scheduler('within-daily-budget', view => {
  const midnight = new Date(Date.UTC(view.now.getUTCFullYear(), view.now.getUTCMonth(), view.now.getUTCDate()));
  const spent = view.metrics.sum({ of: 'costUsd', among: { entry: 'invocation' }, since: midnight });
  const mean = view.metrics.mean({
    of: 'costUsd',
    among: { entry: 'attempt', kind: Topic.name, outcome: 'succeeded' },
    days: 30,
  });
  const projected = mean.value === null ? topicCeilingUsd : mean.value;
  const committed = view.active
    .filter(unit => unit.kind === Topic.name)
    .reduce((total, unit) => total + Math.max(0, projected - unit.spentUsd), 0);
  let remaining = dailyBudgetUsd - (spent.value ?? 0) - committed;
  const start: PendingView[] = [];
  for (const unit of view.pending.slice().sort((a, b) => b.waitedMs - a.waitedMs)) {
    if (projected <= remaining) {
      start.push(unit);
      remaining -= projected;
    }
  }
  return { start };
});

const supervisor = claudeCode.supervisor({
  grants: [H.ops.readWork, H.ops.writeWork, H.ops.readMemory, H.ops.curateMemory, H.ops.readTelemetry],
});

export const research = H.harness('research-pipeline')
  .ledger(sqlite.ledger('research.db'))
  .lanes(topics)
  .pools(apiPool)
  .scheduler(withinDailyBudget)
  .clients(supervisor)
  .observers(markdown.board('BOARD.md'), markdown.telemetry('TELEMETRY.md'));
