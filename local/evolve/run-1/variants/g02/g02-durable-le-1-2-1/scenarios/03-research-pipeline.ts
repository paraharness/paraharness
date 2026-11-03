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
const Researching = H.state('Researching', 'active');
const ReportDelivered = H.state('ReportDelivered', 'terminal', 'success');
const InsufficientSources = H.state('InsufficientSources', 'terminal', 'neutral');
const Withdrawn = H.state('Withdrawn', 'terminal', 'neutral');

const topicKind = H.work('Topic')
  .attributes({ slug: z.string(), recurring: z.boolean() })
  .fields({ question: z.string() })
  .states([Queued, Researching, ReportDelivered, InsufficientSources, Withdrawn])
  .events({ reopened: {}, withdrawn: {} })
  .key(unit => unit.attributes.slug);

const apiAccount = anthropic.account('anthropic-api', { apiKey: H.env('ANTHROPIC_API_KEY') });
const haikuBatch = anthropic.model('claude-haiku-4-5', { batch: true });
const opus = anthropic.model('claude-opus-4-1');
const sonnet = anthropic.model('claude-sonnet-4-5');

const planQueries = H.command('planQueries', ['./bin/plan-queries', '--count', '20'])
  .parses({ queries: z.array(z.string()) });
const citationCheck = H.command('checkCitations', ['./bin/check-citations']);
const publishReport = H.command('publishReport', ['./bin/publish-report']);

const citationPass = H.metric('citationPass').of(citationCheck).hit(result => result.exitCode === 0);

const synthesizerModel = H.policy.model('synthesizerByCitationPass', [opus, sonnet], c => {
  const first = c.metrics.read(citationPass, { model: opus, window: { days: 30 } });
  const second = c.metrics.read(citationPass, { model: sonnet, window: { days: 30 } });
  if (first.n < 15) return opus;
  if (second.n < 15) return sonnet;
  return (second.rate ?? 0) > (first.rate ?? 0) ? sonnet : opus;
});

const bySimilarity = H.policy.recall('bySimilarity', c =>
  [...c.candidates]
    .sort((a, b) => (b.similarity ?? 0) - (a.similarity ?? 0) || b.specificity - a.specificity)
    .slice(0, c.limit));

const bySpecificityAndTrack = H.policy.recall('bySpecificityAndTrack', c =>
  [...c.candidates]
    .sort((a, b) =>
      b.specificity - a.specificity ||
      b.track.succeeded / Math.max(1, b.track.present) - a.track.succeeded / Math.max(1, a.track.present))
    .slice(0, c.limit));

const findingsJournal = H.journal('findingsJournal', H.memory.experience('priorFindings'))
  .store(lancedb.memory('research/findings.lance', { embedding: 'text-embedding-3-small', table: 'findings' }))
  .recall(bySimilarity);

const sourceJournal = H.journal('sourceJournal', H.memory.experience('sourceLessons'))
  .store(jsonl.memory('research/sources.jsonl'))
  .recall(bySpecificityAndTrack);

const extractorRole = H.role('extractor')
  .intents(['read', 'search', 'browse'])
  .instructions('Search for the query and extract sourced claims relevant to the question.')
  .input({ question: z.string(), query: z.string() })
  .output({ findings: z.array(z.object({ claim: z.string(), source: z.string() })) });

const synthesizerRole = H.role('synthesizer')
  .intents(['read', 'remember'])
  .instructions('Write a sourced report answering the question. Cite every claim.')
  .input({ question: z.string(), notes: z.string() })
  .output({ report: z.string(), citations: z.array(z.string()) });

const extractor = H.agent('extractor', extractorRole)
  .model(haikuBatch)
  .pool(apiAccount)
  .recalls([sourceJournal]);

const synthesizer = H.agent('synthesizer', synthesizerRole)
  .model(synthesizerModel)
  .pool(apiAccount)
  .recalls([findingsJournal, sourceJournal])
  .records(findingsJournal);

const researchFlow = H.flow('research')
  .requires({ slug: z.string(), question: z.string() })
  .step('queries', planQueries, c => ({ stdin: c.input.question }), { restart: 'rerun' })
  .batch('extract', extractor, c => c.out.queries.data.queries.map(query => ({ question: c.input.question, query })))
  .exit('insufficientSources', c => c.out.extract.filter(result => result.findings.length > 0).length < 5)
  .step('synthesize', synthesizer, c => ({
    question: c.input.question,
    notes: c.out.extract
      .map(result => result.findings.map(finding => `- ${finding.claim} (${finding.source})`).join('\n'))
      .join('\n'),
  }))
  .step('citations', citationCheck, c => ({ stdin: c.out.synthesize.citations.join('\n') }), { restart: 'rerun' })
  .step('publish', publishReport, c => ({ args: [c.input.slug], stdin: c.out.synthesize.report }), { restart: 'rerun' })
  .ends(['delivered'], () => 'delivered');

const topics = H.lane('topics', topicKind)
  .supply([
    H.supply.operator(),
    H.supply.schedule(topicKind, H.time.weekly('mon', '06:00'), (c, supply) =>
      c.units
        .filter(unit => unit.attributes.recurring && unit.position === 'terminal')
        .map(unit => supply.event(unit.key, 'reopened', {}))),
  ])
  .store(sqlite.store(topicKind, 'research/topics.db'))
  .handler(researchFlow, {
    states: { insufficientSources: InsufficientSources, delivered: ReportDelivered },
    opens: Researching,
  })
  .runner(local.shell({ slots: 2 }))
  .budget({ maxUsdPerUnit: 3, onExceed: 'halt' })
  .retry(H.retry.fixed({ maxRetries: 1, delayMs: 600000 }))
  .reacts({
    reopened: H.reaction(Queued).from([ReportDelivered, InsufficientSources]),
    withdrawn: H.reaction(Withdrawn).from([Queued, Researching]).cancels(),
  });

const dailyBudgetUsd = 40;

const withinDailyBudget = H.policy.schedule('withinDailyBudget', c => {
  const projectedUsd = c.metrics.cost({ kind: topicKind, verdict: 'success', window: { days: 30 } }).meanUsd ?? 3;
  const remainingUsd = dailyBudgetUsd - c.metrics.spentUsd({ sinceMs: c.clock.startOfDay() });
  const affordable = Math.max(0, Math.floor(remainingUsd / Math.max(projectedUsd, 0.01)));
  return { start: c.order(candidate => candidate.enqueuedAt).slice(0, affordable) };
});

const researcherAccess = H.access('researcher').allows([
  H.ops.readWork,
  H.ops.createWork,
  H.ops.updateWork,
  H.ops.sendEvents,
  H.ops.resolveBlocks,
  H.ops.readMemory,
  H.ops.writeMemory,
  H.ops.readTelemetry,
]);

export const researchPipeline = H.harness('research-pipeline')
  .ledger(sqlite.ledger('research/ledger.db'))
  .lanes([topics])
  .schedule(withinDailyBudget)
  .clients([claudeCode.supervisor('research-supervisor', researcherAccess, { port: H.slot.port(0) })])
  .projections([markdown.board('research/BOARD.md'), markdown.telemetry('research/TELEMETRY.md')]);
