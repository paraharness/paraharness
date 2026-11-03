import { z } from 'zod';
import { H } from 'harness-dsl';
import type { Model } from 'harness-dsl';
import * as anthropic from 'harness-dsl/anthropic';
import * as sqlite from 'harness-dsl/sqlite';
import * as jsonl from 'harness-dsl/jsonl';
import * as lancedb from 'harness-dsl/lancedb';
import * as local from 'harness-dsl/local';
import * as claudeCode from 'harness-dsl/claude-code';
import * as markdown from 'harness-dsl/markdown';

const dailyBudgetUsd = 40;
const minimumSources = 5;

const Queued = H.state('queued', 'pending');
const Researching = H.state('researching', 'active');
const Delivered = H.state('delivered', 'succeeded');
const Parked = H.state('parked', 'concluded');
const CancelledByOperator = H.state('cancelled by operator', 'cancelled');
const Failed = H.state('failed', 'failed');

const Topic = H.work('Topic')
  .attributes({ recurring: z.boolean() })
  .fields({ question: z.string() })
  .states([Queued, Researching, Delivered, Parked, CancelledByOperator, Failed])
  .signals({ reopen: {}, cancel: {} })
  .key(unit => unit.fields.question);

const apiAccount = anthropic.account('anthropic-api', { apiKey: H.env('ANTHROPIC_API_KEY') });
const haikuBatch = anthropic.model('claude-haiku-4-5', { batch: true });
const opus = anthropic.model('claude-opus-4-1');
const sonnet = anthropic.model('claude-sonnet-4-5');

const mostSimilar = H.policy.recall('most-similar', c =>
  [...c.candidates]
    .sort((a, b) => (b.similarity ?? 0) - (a.similarity ?? 0) || b.specificity - a.specificity)
    .slice(0, c.limit),
);
const specificFirst = H.policy.recall('specific-first', c =>
  [...c.candidates].sort((a, b) => b.specificity - a.specificity).slice(0, c.limit),
);

const ReportFindings = H.memory.experience('report-findings');
const SourceExperience = H.memory.experience('source-experience');
const findingsJournal = H.journal('findings-journal', ReportFindings)
  .store(lancedb.memory('memory/findings.lance', { embedding: 'voyage-3' }))
  .recall(mostSimilar);
const sourceJournal = H.journal('source-journal', SourceExperience)
  .store(jsonl.memory('memory/sources.jsonl'))
  .recall(specificFirst);

const synthesizerModel = H.policy.model('synthesizer-model', [opus, sonnet], (c): Model => {
  const first = c.metrics.read(citationPass, { lane: topicLane, model: opus, windowDays: 60 });
  const second = c.metrics.read(citationPass, { lane: topicLane, model: sonnet, windowDays: 60 });
  if (first.n < 15) return opus;
  if (second.n < 15) return sonnet;
  return (first.rate ?? 0) >= (second.rate ?? 0) ? opus : sonnet;
});

const searcherRole = H.role('searcher')
  .intents(['search', 'browse'])
  .instructions('Search for sources on the question from the given angle and extract sourced claims.')
  .input({ question: z.string(), angle: z.number() })
  .output({ sources: z.array(z.object({ url: z.string(), claim: z.string() })) });

const synthesizerRole = H.role('synthesizer')
  .intents(['read', 'remember'])
  .instructions('Write a sourced report. Every claim cites a url from the findings.')
  .input({ question: z.string(), findings: z.array(z.object({ url: z.string(), claim: z.string() })) })
  .output({ report: z.string(), citations: z.array(z.string()), headline: z.string() });

const searcher = H.agent('searcher', searcherRole).model(haikuBatch).pool(apiAccount).recalls([sourceJournal]);
const synthesizer = H.agent('synthesizer', synthesizerRole)
  .model(synthesizerModel)
  .pool(apiAccount)
  .recalls([findingsJournal, sourceJournal])
  .records(sourceJournal);

const citationCheck = H.command('citation-check', ['scripts/check-citations']);
const publishReport = H.command('publish-report', ['scripts/publish-report']);

const researchFlow = H.flow('research')
  .requires({ question: z.string() })
  .mark('researching')
  .batch('search', searcher, c => Array.from({ length: 20 }, (_, angle) => ({ question: c.input.question, angle })))
  .exit('parked', c => c.out.search.flatMap(result => result.sources).length < minimumSources)
  .step('synthesize', synthesizer, c => ({
    question: c.input.question,
    findings: c.out.search.flatMap(result => result.sources),
  }))
  .step('citations', citationCheck, c => ({ stdin: JSON.stringify(c.out.synthesize.citations) }))
  .step('publish', publishReport, c => ({ args: [c.input.question], stdin: c.out.synthesize.report }))
  .ends(['delivered'], () => 'delivered');

const topicLane = H.lane('topics', Topic)
  .supply([
    H.supply.operator(),
    H.supply.schedule(Topic, H.time.weekly('mon', '06:00', 'UTC'), c =>
      c.units
        .filter(unit => unit.attributes.recurring && (unit.outcome === 'succeeded' || unit.outcome === 'concluded'))
        .map(unit => ({ key: unit.key, signal: 'reopen', payload: {} })),
    ),
  ])
  .store(sqlite.store(Topic, 'research.db'))
  .runner(local.shell({ slots: 2 }))
  .handler(researchFlow, {
    states: { researching: Researching, parked: Parked, delivered: Delivered, failed: Failed },
  })
  .budget({ maxUsdPerUnit: 3, onExceed: 'fail' })
  .signals({
    reopen: H.move(Queued).from([Delivered, Parked]),
    cancel: H.move(CancelledByOperator).from([Queued, Researching]),
  });

const citationPass = H.metric('citation-pass').step(researchFlow, 'citations').hit(result => result.exitCode === 0);

const deliveredFindingsBecomeMemory = H.trigger('delivered-findings-become-memory', H.on.transition(topicLane, { to: [Delivered] }))
  .records(findingsJournal, event =>
    event.outputs.synthesize
      ? [{
          rule: `When researching a question near "${event.unit.key}", start from this finding: ${event.outputs.synthesize.headline}`,
          because: `the delivered report on "${event.unit.key}" established it with resolving citations`,
          when: { kinds: [Topic] },
        }]
      : [],
  );

const withinDailyBudget = H.policy.schedule('within-daily-budget', c => {
  const spentUsd = c.metrics.spentUsd({ sinceMs: c.clock.startOfDay('UTC') });
  const projectedUsd = c.metrics.cost({ lane: topicLane, outcome: 'succeeded', windowDays: 30 }).meanUsd ?? 3;
  let remainingUsd = dailyBudgetUsd - spentUsd;
  return {
    start: c.candidates.filter(candidate => {
      if (candidate.entry.reason !== 'start') return true;
      if (projectedUsd > remainingUsd) return false;
      remainingUsd -= projectedUsd;
      return true;
    }),
  };
});

const operatorAccess = H.access('research-operator').allows([
  H.ops.readWork,
  H.ops.createWork,
  H.ops.signalWork,
  H.ops.resolveBlocks,
  H.ops.readMemory,
  H.ops.writeMemory,
  H.ops.readTelemetry,
]);

export const researchPipeline = H.harness('research-pipeline')
  .ledger(sqlite.ledger('research-ledger.db'))
  .lanes([topicLane])
  .triggers([deliveredFindingsBecomeMemory])
  .schedule(withinDailyBudget)
  .clients([claudeCode.supervisor('research-supervisor', operatorAccess, { port: H.slot.port(0) })])
  .projections([markdown.board('BOARD.md'), markdown.telemetry('TELEMETRY.md')]);
