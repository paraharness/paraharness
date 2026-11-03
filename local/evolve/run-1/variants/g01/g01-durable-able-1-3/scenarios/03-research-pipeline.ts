import { z } from 'zod';
import { H, type Metric } from 'harness-dsl';
import * as sqlite from 'harness-dsl/sqlite';
import * as jsonl from 'harness-dsl/jsonl';
import * as lancedb from 'harness-dsl/lancedb';
import * as claude from 'harness-dsl/claude-code';
import * as anthropic from 'harness-dsl/anthropic';
import * as markdown from 'harness-dsl/markdown';
import * as local from 'harness-dsl/local';

const ANGLES = 20;
const MIN_SOURCES = 5;
const TOPIC_CEILING_USD = 3;
const DAILY_BUDGET_USD = 40;

const Queued = H.state('queued', 'pending');
const Researching = H.state('researching', 'active');
const Delivered = H.state('delivered', 'terminal', 'success');
const Parked = H.state('parked', 'terminal', 'neutral');
const Withdrawn = H.state('withdrawn', 'terminal', 'neutral');
const Failed = H.state('failed', 'terminal', 'failure');

const Topic = H.work('Topic')
  .attributes({ slug: z.string(), question: z.string(), recurring: z.boolean() })
  .states([Queued, Researching, Delivered, Parked, Withdrawn, Failed])
  .signals({ withdraw: {} })
  .key((unit) => unit.attributes.slug);

const similarFirst = H.policy.recall('similar-then-specific', (c) =>
  [...c.candidates]
    .filter((candidate) => (candidate.similarity ?? 0) >= 0.75)
    .sort((a, b) => (b.similarity ?? 0) - (a.similarity ?? 0) || b.specificity - a.specificity)
    .slice(0, c.limit),
);

const specificFirst = H.policy.recall('specific-first', (c) =>
  [...c.candidates].sort((a, b) => b.specificity - a.specificity).slice(0, c.limit),
);

const findings = H.journal('findings', H.memory.experience('report-findings'))
  .store(lancedb.memory('memory/findings.lance', { embedding: 'text-embedding-3-small' }))
  .recall(similarFirst);

const sourceLessons = H.journal('source-lessons', H.memory.experience('source-lessons'))
  .store(jsonl.memory('memory/sources.jsonl'))
  .recall(specificFirst);

const api = anthropic.account('api', { apiKey: H.env('ANTHROPIC_API_KEY') });
const haikuBatch = anthropic.model('claude-haiku-4-5', { batch: true });
const opus = anthropic.model('claude-opus-4-1');
const sonnet = anthropic.model('claude-sonnet-4-5');

const citationCheck = H.command('citation-check', ['./tools/check-citations.sh']);

const synthesizerModel = H.policy.model('synthesizer-by-citation-pass', [opus, sonnet], (c, options) => {
  const readings = options.map((model) => ({
    model,
    pass: c.metrics.read(citationPass, { model, window: { days: 30 } }),
  }));
  const underSampled = readings.find((reading) => reading.pass.n < 30);
  if (underSampled) return underSampled.model;
  return readings.reduce((best, reading) =>
    (reading.pass.rate ?? 0) > (best.pass.rate ?? 0) ? reading : best,
  ).model;
});

const findingShape = z.object({ claim: z.string(), source: z.string() });

const extractorRole = H.role('extractor')
  .intents(['search', 'browse'])
  .instructions('Search for sources on the question from the given angle and extract sourced claims.')
  .input({ question: z.string(), angle: z.number() })
  .output({ findings: z.array(findingShape) });

const synthesizerRole = H.role('synthesizer')
  .intents(['read', 'remember'])
  .instructions('Write a sourced report. Every claim cites one of the given sources.')
  .input({ question: z.string(), findings: z.array(findingShape) })
  .output({ report: z.string(), keyFindings: z.array(z.string()) });

const extractor = H.agent('extractor', extractorRole).model(haikuBatch).pool(api).recalls([sourceLessons]);
const synthesizer = H.agent('synthesizer', synthesizerRole)
  .model(synthesizerModel)
  .pool(api)
  .recalls([findings, sourceLessons]);

const distinctSources = (extracts: readonly { findings: readonly { source: string }[] }[]): number =>
  new Set(extracts.flatMap((extract) => extract.findings.map((finding) => finding.source))).size;

const researchFlow = H.flow('research')
  .requires({ question: z.string() })
  .mark('researching')
  .batch('extract', extractor, (c) =>
    Array.from({ length: ANGLES }, (_, angle) => ({ question: c.input.question, angle })),
  )
  .exit('parked', (c) => distinctSources(c.out.extract) < MIN_SOURCES)
  .step('synthesize', synthesizer, (c) => ({
    question: c.input.question,
    findings: c.out.extract.flatMap((extract) => extract.findings),
  }))
  .step('citations', citationCheck, (c) => ({ stdin: c.out.synthesize.report }), { onRestart: 'rerun' })
  .ends(['delivered'], () => 'delivered');

const citationPass: Metric = H.metric('citation-pass')
  .step(researchFlow, 'citations')
  .hit((_output, event) => event.status === 'succeeded');

const topics = H.lane('topics', Topic)
  .supply([
    H.supply.operator(),
    H.supply.schedule(Topic, H.time.weekly('mon', '07:00', 'UTC'), (c) =>
      c.units
        .filter((unit) => unit.attributes.recurring && unit.position === 'terminal')
        .map((unit) => ({ create: { attributes: unit.attributes } })),
    ),
  ])
  .store(sqlite.store(Topic, '.harness/topics.sqlite'))
  .handler(researchFlow, {
    states: { researching: Researching, parked: Parked, delivered: Delivered, failed: Failed },
  })
  .runner(local.shell({ slots: 4 }))
  .budget({ maxUsdPerUnit: TOPIC_CEILING_USD, onExceed: 'fail' });

const withdrawByOperator = H.trigger('operator-withdraws-topic', H.on.signal(topics, 'withdraw')).moves(topics, {
  key: (event) => event.unit.key,
  to: Withdrawn,
});

const deliveredFindingsRemembered = H.trigger(
  'delivered-findings-remembered',
  H.on.transition(topics, { to: [Delivered] }),
).records(findings, (event) => {
  const keyFindings: readonly string[] = event.outputs.synthesize ? event.outputs.synthesize.keyFindings : [];
  return keyFindings.map((finding) => ({
    rule: `When researching a question like "${event.unit.attributes.question}", start from the finding: ${finding}`,
    because: `report ${event.unit.attributes.slug} established it with resolving citations`,
    when: { kinds: [Topic], roles: [synthesizerRole] },
  }));
});

const withinDailyBudget = H.policy.schedule('within-daily-budget', (c) => {
  const projected = c.metrics.cost({ lane: topics, verdict: 'success' }).meanUsd ?? TOPIC_CEILING_USD;
  const spent = c.metrics.spentUsd({ sinceMs: c.clock.startOfDay('UTC'), lane: topics });
  const committed = c.open.filter((attempt) => c.inLane(attempt, topics)).length * projected;
  let remaining = DAILY_BUDGET_USD - spent - committed;
  return {
    start: c.candidates.filter(() => {
      if (projected > remaining) return false;
      remaining -= projected;
      return true;
    }),
  };
});

const researcherAccess = H.access('researcher').allows([
  H.ops.readWork,
  H.ops.createWork,
  H.ops.signalWork,
  H.ops.readMemory,
  H.ops.curateMemory,
  H.ops.readTelemetry,
]);

export default H.harness('research-pipeline')
  .ledger(sqlite.ledger('.harness/research.sqlite'))
  .lanes([topics])
  .triggers([withdrawByOperator, deliveredFindingsRemembered])
  .schedule(withinDailyBudget)
  .clients([claude.supervisor('research-supervisor', researcherAccess, { port: H.slot.port(0) })])
  .projections([markdown.board('BOARD.md'), markdown.telemetry('TELEMETRY.md')]);
