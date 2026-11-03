import { z } from 'zod';
import { H } from 'harness-dsl';
import type { PendingView } from 'harness-dsl';
import { sqlite } from 'harness-dsl/sqlite';
import { jsonl } from 'harness-dsl/jsonl';
import { qdrant } from 'harness-dsl/qdrant';
import { anthropic } from 'harness-dsl/anthropic';
import { openai } from 'harness-dsl/openai';
import { claudeCode } from 'harness-dsl/claude-code';
import { shell } from 'harness-dsl/shell';
import { markdown } from 'harness-dsl/markdown';

const Open = H.state('open', 'runnable');
const Delivered = H.state('delivered', 'succeeded');
const Parked = H.state('parked', 'ended');
const Failed = H.state('failed', 'failed');
const Cancelled = H.state('cancelled', 'cancelled');

const Topic = H.kind('Topic', {
  data: z.object({
    id: z.string(),
    question: z.string(),
    tags: z.array(z.string()),
    report: z.string().nullable(),
  }),
  key: (topic) => topic.id,
})
  .states([Open, Delivered, Parked, Failed, Cancelled], { initial: Open })
  .messages({ reopen: z.object({ at: z.string() }) })
  .on('reopen', { from: [Delivered, Parked], to: Open })
  .on('cancel', { from: [Open], to: Cancelled, attempt: 'cancel' });

const PriorFindings = H.memory('prior-findings', { authority: 'observed' });
const SourceExperience = H.memory('source-experience', { authority: 'observed' });

const findingsJournal = H.journal('report-findings', PriorFindings)
  .store(
    qdrant.store({
      url: H.env('QDRANT_URL'),
      collection: 'research-findings',
      embedder: openai.embedder('text-embedding-3-small', { key: H.env('OPENAI_API_KEY') }),
    }),
  )
  .recall(H.recall.bySimilarity({ limit: 8 }));

const sourcesJournal = H.journal('source-lessons', SourceExperience)
  .store(jsonl.store('memory/sources.jsonl'))
  .recall(H.recall.bySpecificity({ limit: 10 }));

const apiAccount = anthropic.apiKey('research-api', { key: H.env('ANTHROPIC_API_KEY') });
const researchPool = H.pool('research').accounts([{ account: apiAccount, share: 1 }]);

const batchedHaiku = anthropic.model('claude-haiku-4-5', { batch: true });
const opus = anthropic.model('claude-opus-4-1');
const sonnet = anthropic.model('claude-sonnet-4-5');

const source = z.object({ url: z.string(), claim: z.string() });

const searcherRole = H.role('searcher', {
  prompt: 'Search for sources on one facet of the question and extract their claims with URLs.',
  intents: ['search', 'browse'],
  input: z.object({ question: z.string(), facet: z.number() }),
  output: z.object({ sources: z.array(source) }),
});

const synthesizerRole = H.role('synthesizer', {
  prompt: 'Write a sourced report answering the question. Cite every claim by URL.',
  intents: [],
  input: z.object({ question: z.string(), sources: z.array(source) }),
  output: z.object({ report: z.string(), citations: z.array(z.string()) }),
});

const citationCheck = H.command('citation-check', {
  input: z.object({ citations: z.array(z.string()) }),
  argv: (input) => ['citation-check', ...input.citations],
  runner: shell.local({ slots: 2 }),
});

const citationPass = H.metric('citation-pass', {
  kind: Topic,
  sample: (sample) => {
    const check = sample.invocations.find((invocation) => invocation.step === 'cite');
    return check === undefined ? null : check.ok;
  },
  group: (sample) => sample.invocations.find((invocation) => invocation.step === 'synthesize')?.model ?? 'none',
});

const synthesizerModel = H.choose('synthesizer-model', [opus, sonnet], (query, context) => {
  const scored = query.models.map((model) => ({ model, rate: context.metrics.read(citationPass, { days: 30, group: model.name }) }));
  const unexplored = scored.find((entry) => entry.rate.samples < 30);
  if (unexplored !== undefined) {
    return unexplored.model;
  }
  return scored.reduce((best, entry) => ((entry.rate.value ?? 0) > (best.rate.value ?? 0) ? entry : best)).model;
});

const searcher = H.agent('searcher', searcherRole).model(batchedHaiku).pool(researchPool).recall(sourcesJournal);
const synthesizer = H.agent('synthesizer', synthesizerRole)
  .model(synthesizerModel)
  .pool(researchPool)
  .recall(findingsJournal, sourcesJournal)
  .record(findingsJournal);

const research = H.flow(
  'research',
  {
    input: z.object({ question: z.string() }),
    writes: z.object({ report: z.string() }),
    exits: ['delivered', 'parked', 'citationsFailed'],
  },
  async (ctx) => {
    const facets = Array.from({ length: 20 }, (_, facet) => ({ question: ctx.input.question, facet }));
    const found = await ctx.batch('search', searcher, facets);
    const sources = found.flatMap((result) => result.sources);
    if (sources.length < 5) {
      return ctx.exit('parked');
    }
    const draft = await ctx.run('synthesize', synthesizer, { question: ctx.input.question, sources });
    const check = await ctx.try('cite', citationCheck, { citations: draft.citations });
    return check.ok ? ctx.exit('delivered', { report: draft.report }) : ctx.exit('citationsFailed');
  },
);

const recurringTopics = H.supply.schedule(Topic, H.time.weekly('mon', '06:00'), async (tick, unit, registry) => {
  const finished = await registry.find(Topic, { states: [Delivered, Parked] });
  return finished
    .filter((topic) => topic.data.tags.includes('recurring'))
    .map((topic) => unit.send(topic.key, 'reopen', { at: tick.at.toISOString() }));
});

const topicLane = H.lane('topics', Topic)
  .supply(H.supply.operator(Topic), recurringTopics)
  .store(sqlite.store('research.db'))
  .handle(Open, research, {
    exits: { delivered: Delivered, parked: Parked, citationsFailed: Failed },
    crash: { retries: 1, then: Failed },
  })
  .limit({ wip: 3, maxUsdPerUnit: 3 });

const dailyBudgetUsd = 40;

const scheduler = H.scheduler('daily-budget', (query) => {
  const startOfDay = new Date(Date.UTC(query.now.getUTCFullYear(), query.now.getUTCMonth(), query.now.getUTCDate()));
  const projected = query.metrics.meanCostUsd({ kind: Topic, days: 30, outcome: 'succeeded' });
  const perTopic = projected.samples >= 5 && projected.value !== null ? projected.value : 3;
  let remaining = dailyBudgetUsd - query.metrics.spendUsd({ since: startOfDay }) - query.active.length * perTopic;
  const order: PendingView[] = [];
  for (const topic of [...query.pending].sort((a, b) => b.waitingSeconds - a.waitingSeconds)) {
    if (perTopic <= remaining) {
      order.push(topic);
      remaining -= perTopic;
    }
  }
  return { order };
});

const supervisor = H.client('supervisor', claudeCode.session()).grant([
  H.ops.readWork,
  H.ops.writeWork,
  H.ops.readMemory,
  H.ops.writeMemory,
  H.ops.curateMemory,
  H.ops.readTelemetry,
]);

export const harness = H.harness('research-pipeline')
  .ledger(sqlite.ledger('research-ledger.db'))
  .lanes([topicLane])
  .journals([findingsJournal, sourcesJournal])
  .scheduler(scheduler)
  .clients([supervisor])
  .observers([markdown.board('BOARD.md'), markdown.telemetry('TELEMETRY.md')]);
