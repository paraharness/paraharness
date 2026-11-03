import { z } from 'zod';
import { H } from 'harness-dsl';
import * as sqlite from 'harness-dsl/sqlite';
import * as jsonl from 'harness-dsl/jsonl';
import * as lancedb from 'harness-dsl/lancedb';
import * as claudeCode from 'harness-dsl/claude-code';
import * as anthropic from 'harness-dsl/anthropic';
import * as markdown from 'harness-dsl/markdown';
import * as local from 'harness-dsl/local';

const Queued = H.state('Queued', 'pending');
const Searching = H.state('Searching', 'active');
const Synthesizing = H.state('Synthesizing', 'active');
const Checking = H.state('Checking', 'active');
const Delivered = H.state('Delivered', 'terminal', 'success');
const Parked = H.state('Parked', 'terminal', 'neutral');
const Cancelled = H.state('Cancelled', 'terminal', 'neutral');
const Failed = H.state('Failed', 'terminal', 'failure');

const Topic = H.work('Topic')
  .attributes({ slug: z.string(), question: z.string(), recurring: z.boolean() })
  .states([Queued, Searching, Synthesizing, Checking, Delivered, Parked, Cancelled, Failed])
  .failsTo(Failed)
  .events({ reopen: {}, cancel: { reason: z.string() } })
  .key(u => u.attributes.slug);

const apiAccount = anthropic.account('research-api', { apiKey: H.env('ANTHROPIC_API_KEY') });
const haikuBatch = anthropic.model('claude-haiku-4-5', { batch: true });
const opus = anthropic.model('claude-opus-4-1');
const sonnet = anthropic.model('claude-sonnet-4-5');

const citationCheck = H.command('citation-check', ['scripts/check-citations']);

const citationPass = H.metric('citation-check-pass').of(citationCheck).hit(out => out.exitCode === 0);

const synthesizerModel = H.policy.model('synthesizer-model', [opus, sonnet], c => {
  const first = c.metrics.read(citationPass, { model: opus, window: { days: 30 } });
  const second = c.metrics.read(citationPass, { model: sonnet, window: { days: 30 } });
  if (first.n < 10 || second.n < 10) return first.n <= second.n ? opus : sonnet;
  return (second.rate ?? 0) > (first.rate ?? 0) ? sonnet : opus;
});

const mostSimilar = H.policy.recall('most-similar', c =>
  [...c.candidates]
    .filter(x => (x.similarity ?? 0) >= 0.75)
    .sort((a, b) => (b.similarity ?? 0) - (a.similarity ?? 0) || b.specificity - a.specificity)
    .slice(0, c.limit),
);

const mostSpecific = H.policy.recall('most-specific', c =>
  [...c.candidates].sort((a, b) => b.specificity - a.specificity).slice(0, c.limit),
);

const findings = H.journal('findings', H.memory.experience('finding'))
  .store(lancedb.memory('memory/findings', { embedding: 'text-embedding-3-small', table: 'findings' }))
  .recall(mostSimilar);

const sourceLessons = H.journal('source-lessons', H.memory.experience('source-lesson'))
  .store(jsonl.memory('memory/source-lessons.jsonl'))
  .recall(mostSpecific);

const sourceShape = z.object({ url: z.string(), title: z.string(), excerpt: z.string() });

const searcherRole = H.role('searcher')
  .intents(['search', 'browse'])
  .instructions('Search one facet of the question and extract quotable sources.')
  .input({ question: z.string(), facet: z.number() })
  .output({ sources: z.array(sourceShape) });

const synthesizerRole = H.role('synthesizer')
  .intents(['read', 'remember'])
  .instructions('Write a sourced report. Cite every claim by URL.')
  .input({ question: z.string(), sources: z.array(sourceShape) })
  .output({ report: z.string(), citations: z.array(z.string()) });

const searcher = H.agent('searcher', searcherRole)
  .model(haikuBatch)
  .pool(apiAccount)
  .recalls([sourceLessons]);

const synthesizer = H.agent('synthesizer', synthesizerRole)
  .model(synthesizerModel)
  .pool(apiAccount)
  .recalls([findings, sourceLessons])
  .records(findings);

const researchFlow = H.flow('research')
  .requires({ question: z.string() })
  .batch('search', searcher, c =>
    Array.from({ length: 20 }, (_, facet) => ({ question: c.input.question, facet })),
  )
  .exit('thin', c => c.out.search.flatMap(r => r.sources).length < 5)
  .step('synthesize', synthesizer, c => ({
    question: c.input.question,
    sources: c.out.search.flatMap(r => r.sources),
  }))
  .step('check', citationCheck, c => ({ stdin: JSON.stringify(c.out.synthesize.citations) }))
  .ends(['delivered'], () => 'delivered');

const topics = H.lane('topics', Topic)
  .supply([
    H.supply.operator(),
    H.supply.schedule(Topic, H.time.weekly('mon', '06:00'), (c, supply) =>
      c.units
        .filter(u => u.attributes.recurring && u.position === 'terminal')
        .map(u => supply.event(u.key, 'reopen', {})),
    ),
  ])
  .store(sqlite.store(Topic, '.harness/topics.db'))
  .runner(local.shell({ slots: 4 }))
  .retry(H.retry.fixed({ maxRetries: 1, delayMs: 300_000 }))
  .budget({ maxUsdPerUnit: 3, onExceed: 'fail' })
  .handler(researchFlow, {
    states: {
      search: Searching,
      synthesize: Synthesizing,
      check: Checking,
      thin: Parked,
      delivered: Delivered,
    },
    opens: Searching,
  })
  .reacts({
    reopen: H.reaction(Queued).from([Delivered, Parked]),
    cancel: H.reaction(Cancelled).from([Queued, Searching, Synthesizing, Checking]).cancels(),
  });

const dailyBudgetUsd = 40;
const ceilingUsd = 3;

const withinDailyBudget = H.policy.schedule('within-daily-budget', c => {
  const spent = c.metrics.spentUsd({ sinceMs: c.clock.startOfDay() });
  const projected = c.metrics.cost({ kind: Topic, verdict: 'success', window: { days: 30 } });
  const perTopic = projected.n === 0 || projected.meanUsd === null ? ceilingUsd : projected.meanUsd;
  let remaining = dailyBudgetUsd - spent;
  return {
    start: c.order(x => x.enqueuedAt).filter(x => {
      if (x.reason === 'resume') return true;
      if (x.is(topics)) {
        if (perTopic > remaining) return false;
        remaining -= perTopic;
      }
      return true;
    }),
  };
});

const operatorAccess = H.access('operator').allows([
  H.ops.readWork,
  H.ops.createWork,
  H.ops.sendEvents,
  H.ops.resolveBlocks,
  H.ops.readMemory,
  H.ops.readTelemetry,
]);

export const harness = H.harness('research-pipeline')
  .ledger(sqlite.ledger('.harness/research.db'))
  .lanes([topics])
  .schedule(withinDailyBudget)
  .clients([claudeCode.supervisor('operator', operatorAccess, { port: H.slot.port(0) })])
  .projections([markdown.board('BOARD.md'), markdown.telemetry('TELEMETRY.md')]);
