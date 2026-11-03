import { z } from 'zod';
import { H } from 'harness-dsl';
import type { Metric, SupplyOf } from 'harness-dsl';
import * as sqlite from 'harness-dsl/sqlite';
import * as jsonl from 'harness-dsl/jsonl';
import * as lancedb from 'harness-dsl/lancedb';
import * as claude from 'harness-dsl/claude-code';
import * as anthropic from 'harness-dsl/anthropic';
import * as markdown from 'harness-dsl/markdown';
import * as local from 'harness-dsl/local';

const TopicQueued = H.state('queued', 'pending');
const Researching = H.state('researching', 'active');
const Delivered = H.state('delivered', 'terminal', 'success');
const Parked = H.state('parked', 'terminal', 'neutral');
const Withdrawn = H.state('withdrawn', 'terminal', 'neutral');
const Failed = H.state('failed', 'terminal', 'failure');

const Topic = H.work('topic')
  .attributes({ slug: z.string(), title: z.string(), recurring: z.boolean() })
  .fields({ brief: z.string() })
  .states([TopicQueued, Researching, Delivered, Parked, Withdrawn, Failed])
  .events({ reopen: { at: z.number() }, withdraw: { reason: z.string() } })
  .key((u) => u.attributes.slug);

const PriorFindings = H.memory.experience('prior-findings');
const SourceExperience = H.memory.experience('source-experience');

const bySimilarity = H.policy.recall('most-similar', (c) =>
  [...c.candidates]
    .filter((x) => (x.similarity ?? 0) >= 0.75)
    .sort((a, b) => (b.similarity ?? 0) - (a.similarity ?? 0) || b.track.succeeded - a.track.succeeded)
    .slice(0, c.limit),
);

const bySpecificity = H.policy.recall('specificity-then-track-record', (c) =>
  [...c.candidates]
    .sort((a, b) => b.specificity - a.specificity || b.track.succeeded - a.track.succeeded)
    .slice(0, c.limit),
);

const findingsJournal = H.journal('prior-findings', PriorFindings)
  .store(lancedb.memory('./memory/findings', { embedding: 'text-embedding-3-small', table: 'findings' }))
  .recall(bySimilarity);

const sourceJournal = H.journal('source-experience', SourceExperience)
  .store(jsonl.memory('./memory/sources.jsonl'))
  .recall(bySpecificity);

const apiAccount = anthropic.account('research-api', { apiKey: H.env('ANTHROPIC_API_KEY') });
const haikuBatch = anthropic.model('claude-haiku-4-5', { batch: true });
const opus = anthropic.model('claude-opus-4-1');
const sonnet = anthropic.model('claude-sonnet-4-5');

const comparisonWindow = { days: 30 };
const minComparisonSamples = 15;

const synthesizerModel = H.policy.model('synthesizer-model', [opus, sonnet], (c) => {
  const first = c.metrics.read(citationPass, { kind: Topic, model: opus, window: comparisonWindow });
  const second = c.metrics.read(citationPass, { kind: Topic, model: sonnet, window: comparisonWindow });
  if (first.n < minComparisonSamples || second.n < minComparisonSamples) return first.n <= second.n ? opus : sonnet;
  return (first.rate ?? 0) >= (second.rate ?? 0) ? opus : sonnet;
});

const finding = z.object({ claim: z.string(), source: z.string(), confidence: z.number() });

const searcherRole = H.role('searcher')
  .intents(['search', 'browse'])
  .instructions('Search for sources on the topic from the given angle and extract sourced claims.')
  .input({ topic: z.string(), brief: z.string(), angle: z.number() })
  .output({ findings: z.array(finding) });

const synthesizerRole = H.role('synthesizer')
  .intents(['read', 'remember'])
  .instructions('Write a sourced report. Every claim cites a source URL.')
  .input({ topic: z.string(), brief: z.string(), batches: z.array(z.object({ findings: z.array(finding) })) })
  .output({ report: z.string(), summary: z.string(), citations: z.array(z.string()) });

const searcher = H.agent('searcher', searcherRole).model(haikuBatch).pool(apiAccount);

const synthesizer = H.agent('synthesizer', synthesizerRole)
  .model(synthesizerModel)
  .pool(apiAccount)
  .recalls([findingsJournal, sourceJournal])
  .records(sourceJournal);

const citationCheck = H.command('check-citations', ['./bin/check-citations', '--strict']);

const searchAngles = 20;
const minFindings = 8;

const researchFlow = H.flow('research')
  .requires({ title: z.string(), brief: z.string() })
  .mark('researching')
  .batch('extract', searcher, (c) =>
    Array.from({ length: searchAngles }, (_, angle) => ({ topic: c.input.title, brief: c.input.brief, angle })),
  )
  .exit('parked', (c) => c.out.extract.reduce((count, batch) => count + batch.findings.length, 0) < minFindings)
  .step('synthesize', synthesizer, (c) => ({
    topic: c.input.title,
    brief: c.input.brief,
    batches: [...c.out.extract],
  }))
  .step('cite', citationCheck, (c) => ({ stdin: JSON.stringify(c.out.synthesize.citations) }))
  .ends(['delivered'], () => 'delivered');

const citationPass: Metric = H.metric('citation-pass')
  .step(researchFlow, 'cite')
  .hit((_result, event) => event.status === 'succeeded');

const topicLane = H.lane('topics', Topic)
  .supply([
    H.supply.operator(),
    H.supply.schedule(Topic, H.time.weekly('mon', '06:00', 'UTC'), (c) =>
      c.units
        .filter((u) => u.attributes.recurring && u.position === 'terminal')
        .map((u): SupplyOf<typeof Topic> => ({ key: u.key, event: 'reopen', payload: { at: c.now } })),
    ),
  ])
  .store(sqlite.store(Topic, './.harness/topics.db'))
  .runner(local.shell({ slots: 2 }))
  .budget({ maxUsdPerUnit: 3, onExceed: 'halt' })
  .reaction('reopen', TopicQueued, { from: [Delivered, Parked] })
  .reaction('withdraw', Withdrawn, { from: [TopicQueued, Researching] })
  .handler(researchFlow, {
    states: { researching: Researching, parked: Parked, delivered: Delivered, failed: Failed },
  });

const deliveredReportsBecomeFindings = H.trigger(
  'delivered-reports-become-findings',
  H.on.transition(topicLane, { to: [Delivered] }),
).records(findingsJournal, (e) =>
  e.outputs.synthesize
    ? [
        {
          rule: `When researching a topic near "${e.unit.attributes.title}", start from this finding: ${e.outputs.synthesize.summary}`,
          because: `the report on "${e.unit.attributes.title}" delivered on ${new Date(e.unit.updatedAt).toISOString()} passed its citation check`,
          when: { kinds: [Topic], roles: [synthesizerRole] },
        },
      ]
    : [],
);

const dailyBudgetUsd = 40;
const fallbackProjectionUsd = 3;

const dailyBudget = H.policy.schedule('daily-budget', (c) => {
  const projected =
    c.metrics.cost({ kind: Topic, window: comparisonWindow, verdict: 'success' }).meanUsd ?? fallbackProjectionUsd;
  const inFlight = c.open.reduce((sum, attempt) => sum + Math.max(0, projected - attempt.costUsd), 0);
  let committed = c.metrics.spentUsd({ sinceMs: c.clock.startOfDay('UTC') }) + inFlight;
  const start: (typeof c.candidates)[number][] = [];
  for (const candidate of [...c.candidates].sort((a, b) => b.waitedMs - a.waitedMs)) {
    if (candidate.entry.reason === 'resume') {
      start.push(candidate);
    } else if (committed + projected <= dailyBudgetUsd) {
      committed += projected;
      start.push(candidate);
    }
  }
  return { start };
});

const researcherAccess = H.access('researcher').allows([
  H.ops.readWork,
  H.ops.createWork,
  H.ops.sendEvents,
  H.ops.resolveBlocks,
  H.ops.readMemory,
  H.ops.curateMemory,
  H.ops.readTelemetry,
]);

export const researchPipeline = H.harness('research-pipeline')
  .ledger(sqlite.ledger('./.harness/ledger.db'))
  .lanes([topicLane])
  .triggers([deliveredReportsBecomeFindings])
  .schedule(dailyBudget)
  .clients([claude.supervisor('research-supervisor', researcherAccess, { port: H.slot.port(0) })])
  .projections([markdown.board('./BOARD.md'), markdown.telemetry('./TELEMETRY.md')]);

export const running = researchPipeline.start();
