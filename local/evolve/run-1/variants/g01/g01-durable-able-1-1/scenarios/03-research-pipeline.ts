import { z } from 'zod';
import { H } from 'harness-dsl';
import type { Metric } from 'harness-dsl';
import * as sqlite from 'harness-dsl/sqlite';
import * as jsonl from 'harness-dsl/jsonl';
import * as lancedb from 'harness-dsl/lancedb';
import * as anthropic from 'harness-dsl/anthropic';
import * as claudeCode from 'harness-dsl/claude-code';
import * as markdown from 'harness-dsl/markdown';
import * as local from 'harness-dsl/local';

const Queued = H.state.pending('Queued');
const Researching = H.state.active('Researching');
const Delivered = H.state.terminal('Delivered', 'success');
const Parked = H.state.terminal('Parked', 'neutral');
const Cancelled = H.state.terminal('Cancelled', 'neutral');
const Failed = H.state.terminal('Failed', 'failure');

export const Topic = H.work('Topic')
  .attributes({ title: z.string(), recurring: z.boolean() })
  .fields({ brief: z.string().optional() })
  .states([Queued, Researching, Delivered, Parked, Cancelled, Failed])
  .key(u => u.attributes.title);

const researchApi = anthropic.account('research-api', { apiKey: H.env('ANTHROPIC_API_KEY') });
const batchedHaiku = anthropic.model('claude-haiku-4-5', { batch: true });
const opus = anthropic.model('claude-opus-4-1');
const sonnet = anthropic.model('claude-sonnet-4-5');

const nearestThenSpecific = H.policy.recall('nearest-then-specific', c =>
  [...c.candidates]
    .sort((a, b) => (b.similarity ?? 0) - (a.similarity ?? 0) || b.specificity - a.specificity)
    .slice(0, c.limit),
);

const findingsJournal = H.journal('prior-findings', H.memory.experience('prior-findings'))
  .store(lancedb.memory('memory/findings.lance', { embedding: 'voyage-3', table: 'findings' }))
  .recall(nearestThenSpecific);

const sourcesJournal = H.journal('source-experience', H.memory.experience('source-experience'))
  .store(jsonl.memory('memory/sources.jsonl'))
  .recall(nearestThenSpecific);

const finding = z.object({ claim: z.string(), source: z.string() });

const extractorRole = H.role('extractor')
  .intents(['search', 'browse'])
  .instructions('Search for sources on the topic from the given angle and extract sourced claims.')
  .input({ topic: z.string(), angle: z.string() })
  .output({ relevant: z.boolean(), findings: z.array(finding) });

const synthesizerRole = H.role('synthesizer')
  .intents(['remember'])
  .instructions('Write a sourced report. Every claim carries a citation that resolves. List the durable findings separately.')
  .input({ topic: z.string(), findings: z.array(finding) })
  .output({ report: z.string(), findings: z.array(z.string()) });

const synthesizerModel = H.policy.model('synthesizer-by-citation-pass', [opus, sonnet], (c, options) => {
  const scored = options.map(model => ({
    model,
    pass: c.metrics.read(citationPass, { kind: Topic, model, window: { days: 30 } }),
  }));
  const underSampled = scored.find(s => s.pass.n < 15);
  if (underSampled) return underSampled.model;
  return scored.reduce((best, s) => ((s.pass.rate ?? 0) > (best.pass.rate ?? 0) ? s : best)).model;
});

const extractor = H.agent('extractor', extractorRole).model(batchedHaiku).pool(researchApi).recalls([sourcesJournal]);

const synthesizer = H.agent('synthesizer', synthesizerRole)
  .model(synthesizerModel)
  .pool(researchApi)
  .recalls([findingsJournal, sourcesJournal])
  .records(sourcesJournal);

const citationCheck = H.command('citation-check', ['./scripts/check-citations.sh']);

const facets = ['background', 'current evidence', 'open disputes', 'methods', 'recent developments'];
const sourceTypes = ['peer-reviewed journals', 'preprint servers', 'government data', 'industry reports'];
const angles = facets.flatMap(facet => sourceTypes.map(sourceType => `${facet} from ${sourceType}`));

const research = H.flow('research')
  .requires({ title: z.string() })
  .mark('researching')
  .batch('extract', extractor, c => angles.map(angle => ({ topic: c.input.title, angle })), { onRestart: 'reconcile' })
  .exit('parked', c => c.out.extract.filter(x => x.relevant).length < 5)
  .step(
    'synthesize',
    synthesizer,
    c => ({ topic: c.input.title, findings: c.out.extract.flatMap(x => x.findings) }),
    { onRestart: 'reconcile' },
  )
  .step('citations', citationCheck, c => ({ stdin: c.out.synthesize.report }), { onFailure: 'fail', onRestart: 'rerun' })
  .ends(['delivered'], () => 'delivered');

const citationPass: Metric = H.metric('citation-pass').step(research, 'citations').hit(result => result.exitCode === 0);

export const topics = H.lane('topics', Topic)
  .supply([
    H.supply.operator(),
    H.supply.schedule(Topic, H.time.weekly('mon', '06:00', 'UTC'), c =>
      c.units
        .filter(u => u.attributes.recurring && u.position === 'terminal')
        .map(u => ({ create: { attributes: { title: u.attributes.title, recurring: true } } })),
    ),
  ])
  .store(sqlite.store(Topic, '.harness/topics.db'))
  .handler(research, { states: { researching: Researching, parked: Parked, delivered: Delivered, failed: Failed } })
  .runner(local.shell({ slots: 2 }))
  .budget({ maxUsdPerUnit: 3, onExceed: 'fail' });

const findingsBecomeMemory = H.trigger('delivered-findings-become-memory', H.on.transition(topics, { to: [Delivered] }))
  .records(findingsJournal, e =>
    e.outputs.synthesize
      ? e.outputs.synthesize.findings.map(f => ({
          rule: `When researching a topic near "${e.unit.attributes.title}", start from this established finding: ${f}`,
          because: `the ${e.unit.attributes.title} report established it with citations that resolved`,
          when: { kinds: [Topic], roles: [synthesizerRole] },
        }))
      : [],
  );

const dailyBudgetUsd = 40;
const perTopicCeilingUsd = 3;

const withinDailyBudget = H.policy.schedule('within-daily-budget', c => {
  const projected = c.metrics.cost({ lane: topics, window: { days: 30 }, attempt: 'succeeded' }).meanUsd ?? perTopicCeilingUsd;
  const committed = c.open.filter(a => c.inLane(a, topics)).length * projected;
  let left = dailyBudgetUsd - c.metrics.spentUsd({ sinceMs: c.clock.startOfDay('UTC') }) - committed;
  return {
    start: [...c.candidates]
      .sort((a, b) => b.waitedMs - a.waitedMs)
      .filter(() => {
        if (left < projected) return false;
        left -= projected;
        return true;
      }),
  };
});

const researcherAccess = H.access('researcher').allows([
  H.ops.readWork,
  H.ops.createWork,
  H.ops.updateWork,
  H.ops.recoverAttempts,
  H.ops.readMemory,
  H.ops.curateMemory,
  H.ops.readTelemetry,
]);

export const researchPipeline = H.harness('research-pipeline')
  .ledger(sqlite.ledger('.harness/research.db'))
  .lanes([topics])
  .triggers([findingsBecomeMemory])
  .schedule(withinDailyBudget)
  .clients([claudeCode.supervisor('research-supervisor', researcherAccess, { port: H.slot.port(0) })])
  .projections([markdown.board('BOARD.md'), markdown.telemetry('TELEMETRY.md')]);
