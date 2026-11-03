import { z } from 'zod';
import { H } from 'harness-dsl';
import type { MemoryItem, Pending, RecallContext } from 'harness-dsl';
import { anthropic } from 'harness-dsl/anthropic';
import { claudeCode } from 'harness-dsl/claude-code';
import { sqlite } from 'harness-dsl/sqlite';
import { jsonl } from 'harness-dsl/jsonl';
import { lancedb } from 'harness-dsl/lancedb';
import { shell } from 'harness-dsl/shell';
import { markdown } from 'harness-dsl/markdown';

const Topic = H.kind('Topic', {
  data: z.object({ question: z.string(), recurring: z.boolean() }),
  states: {
    proposed: 'pending',
    searching: 'active',
    synthesizing: 'active',
    checking: 'active',
    delivered: 'succeeded',
    parked: 'concluded',
    failed: 'failed',
    cancelled: 'cancelled',
  },
  initial: 'proposed',
  tags: (topic) => (topic.recurring ? ['recurring'] : []),
});

const topicStore = sqlite.store(Topic, { path: '.harness/topics.sqlite' });

const weeklyReopen = H.every(Topic, { cron: '0 6 * * 1', tz: 'UTC' }, async (tick) =>
  (await tick.units({ tags: ['recurring'], states: ['delivered', 'parked'] })).map((unit) => ({
    key: unit.key,
    mode: 'update',
    patch: {},
    reopen: true,
  })),
);

const api = anthropic.account({ name: 'research-api', key: H.env('ANTHROPIC_API_KEY') });
const haiku = anthropic.model({
  name: 'haiku',
  id: 'claude-haiku-4-5',
  account: api,
  price: { inputUsdPerMTok: 1, outputUsdPerMTok: 5 },
  batchFactor: 0.5,
});
const opus = anthropic.model({
  name: 'opus',
  id: 'claude-opus-4-1',
  account: api,
  price: { inputUsdPerMTok: 15, outputUsdPerMTok: 75 },
  batchFactor: 0.5,
});
const sonnet = anthropic.model({
  name: 'sonnet',
  id: 'claude-sonnet-4-5',
  account: api,
  price: { inputUsdPerMTok: 3, outputUsdPerMTok: 15 },
  batchFactor: 0.5,
});

const searcher = H.role('searcher', { instructions: 'Search one angle of the question and extract claims with their source URLs.', intents: ['browse'] });
const synthesizer = H.role('synthesizer', {
  instructions: 'Write a sourced report. Every claim carries a citation. Record durable findings.',
  intents: ['read', 'record'],
});

const Extract = z.object({ claims: z.array(z.string()), sources: z.array(z.string().url()) });
const Report = z.object({ report: z.string(), findings: z.array(z.string()), citations: z.array(z.string().url()) });

const citationPass = H.metric('citation-check-pass', {
  on: 'step',
  select: z.object({ step: z.literal('citations'), ok: z.boolean(), cast: z.object({ synthesizer: z.string() }) }),
  success: (event) => event.ok,
  key: (event) => event.cast.synthesizer,
});

const synthesizerModel = H.policy.pick('synthesizer-by-citation-pass', [opus, sonnet], (ctx) => {
  const rated = ctx.candidates
    .filter((c) => c.eligible)
    .map((c) => ({ model: c.value, rate: ctx.metrics.rate(citationPass, { key: c.value.name, sinceDays: 30 }) }));
  const underSampled = [...rated].filter((r) => r.rate.samples < 30).sort((a, b) => a.rate.samples - b.rate.samples)[0];
  if (underSampled !== undefined) return underSampled.model;
  const best = [...rated].sort((a, b) => b.rate.value - a.rate.value)[0];
  return best === undefined ? opus : best.model;
});

const minimumSourcedSearches = 5;

const researchFlow = H.flow('research', { kinds: [Topic] })
  .mark('searching')
  .step('search', (ctx) =>
    H.batch(searcher, {
      prompts: Array.from(
        { length: 20 },
        (_, index) => `Angle ${index + 1} of 20 on "${ctx.unit.data.question}": search, then extract claims with source URLs.`,
      ),
      output: Extract,
    }),
  )
  .end((ctx) => (ctx.out.search.filter((r) => r.sources.length > 0).length < minimumSourcedSearches ? 'parked' : undefined), {
    note: () => `fewer than ${minimumSourcedSearches} searches returned sources`,
  })
  .mark('synthesizing')
  .step('synthesize', (ctx) =>
    H.ask(synthesizer, {
      prompt: `Question: ${ctx.unit.data.question}\n\nExtracts:\n${JSON.stringify(ctx.out.search)}`,
      output: Report,
      budgetTokens: 40000,
    }),
  )
  .mark('checking')
  .step('citations', (ctx) => H.command('check-citations', { argv: ['bin/check-citations', ...ctx.out.synthesize.citations], timeoutSeconds: 300 }))
  .step('deliver', (ctx) =>
    H.command('deliver-report', { argv: ['bin/deliver-report', ctx.unit.key], env: { REPORT: ctx.out.synthesize.report } }),
  )
  .end('delivered');

const topicCeilingUsd = 3;
const dailyBudgetUsd = 40;

const topicLane = H.lane(Topic)
  .from(H.operator, weeklyReopen)
  .store(topicStore)
  .handle(researchFlow)
  .cast({ searcher: haiku, synthesizer: synthesizerModel })
  .states({
    searching: 'searching',
    synthesizing: 'synthesizing',
    checking: 'checking',
    delivered: 'delivered',
    parked: 'parked',
    failed: 'failed',
    cancelled: 'cancelled',
  })
  .maxUsd(topicCeilingUsd, { onExceed: 'fail' })
  .runOn(shell.local({ name: 'research', slots: 3 }));

const Finding = H.memory('finding', { stance: 'experience' });
const SourceExperience = H.memory('source-experience', { stance: 'experience' });

const findingsJournal = H.journal(
  'report-findings',
  Finding,
  lancedb.memory({
    uri: '.harness/findings.lance',
    table: 'findings',
    embedding: { provider: 'openai', model: 'text-embedding-3-small', apiKey: H.env('OPENAI_API_KEY') },
  }),
)
  .recall(
    H.policy.recall('nearest-findings', async (ctx) =>
      (await ctx.similar(ctx.query, ctx.limit * 2))
        .filter((hit) => hit.item.status === 'active' && hit.score >= 0.75)
        .sort((a, b) => b.score - a.score || ctx.specificity(b.item) - ctx.specificity(a.item))
        .slice(0, ctx.limit)
        .map((hit) => hit.item),
    ),
  )
  .recalledBy(synthesizer)
  .recordedBy(synthesizer);

const within = (allowed: readonly string[] | undefined, present: readonly string[]) =>
  allowed === undefined || allowed.length === 0 || allowed.some((entry) => present.includes(entry));

const applies = (item: MemoryItem, ctx: RecallContext) =>
  item.status === 'active' && within(item.when.roles, [ctx.scope.role]) && within(item.when.resources, ctx.scope.resources);

const sourceJournal = H.journal('source-experience', SourceExperience, jsonl.memory({ path: '.harness/sources.jsonl' }))
  .recall(
    H.policy.recall('sources-specific-then-proven', async (ctx) =>
      (await ctx.items())
        .filter((item) => applies(item, ctx))
        .sort((a, b) => ctx.specificity(b) - ctx.specificity(a) || ctx.trackRecord(b).value - ctx.trackRecord(a).value)
        .slice(0, ctx.limit),
    ),
  )
  .recalledBy(searcher, synthesizer)
  .recordedBy(synthesizer, H.operator);

const withinDailyBudget = H.policy.order('within-daily-budget', (ctx) => {
  const startOfDay = new Date(Date.UTC(ctx.now.getUTCFullYear(), ctx.now.getUTCMonth(), ctx.now.getUTCDate()));
  const mean = ctx.metrics.meanCostUsd({ kind: Topic, outcome: 'succeeded', sinceDays: 30 });
  const projectedUsd = mean.samples >= 5 ? mean.value : topicCeilingUsd;
  const inFlightUsd = ctx.active
    .filter((a) => a.kind === Topic.name)
    .reduce((sum, a) => sum + Math.max(projectedUsd - a.costUsd, 0), 0);
  let remainingUsd = dailyBudgetUsd - ctx.metrics.spentUsd({ since: startOfDay }) - inFlightUsd;
  const order: Pending[] = [];
  for (const unit of [...ctx.pending].sort((a, b) => b.waitingSeconds - a.waitingSeconds)) {
    if (projectedUsd <= remainingUsd) {
      order.push(unit);
      remainingUsd -= projectedUsd;
    }
  }
  return { order };
});

const projections = H.trigger('projections', H.when.transition(), (then) => [
  then.run(markdown.board({ path: 'BOARD.md' })),
  then.run(markdown.telemetry({ path: 'TELEMETRY.md', sinceDays: 30 })),
]);

const operatorConsole = claudeCode.supervisor({
  name: 'research-supervisor',
  endpoint: H.slot.port(7403),
  grants: [H.op.readWork, H.op.createWork, H.op.writeWork, H.op.cancelWork, H.op.readMemory, H.op.writeMemory, H.op.readTelemetry],
});

export const research = H.harness('research-pipeline')
  .ledger(sqlite.ledger({ path: '.harness/ledger.sqlite' }))
  .lanes(topicLane)
  .journals(findingsJournal, sourceJournal)
  .triggers(projections)
  .metrics(citationPass)
  .scheduler(withinDailyBudget)
  .clients(operatorConsole);

export const running = research.start();
