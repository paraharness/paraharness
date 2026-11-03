import { z } from 'zod';
import { H } from 'harness-dsl';
import * as sqlite from 'harness-dsl/sqlite';
import * as jsonl from 'harness-dsl/jsonl';
import * as lancedb from 'harness-dsl/lancedb';
import * as anthropic from 'harness-dsl/anthropic';
import * as claudeCode from 'harness-dsl/claude-code';
import * as local from 'harness-dsl/local';
import * as markdown from 'harness-dsl/markdown';

const Queued = H.state('Queued', 'pending');
const Researching = H.state('Researching', 'active');
const Delivered = H.state('Delivered', 'terminal', 'success');
const Parked = H.state('Parked', 'terminal', 'neutral');
const Cancelled = H.state('Cancelled', 'terminal', 'neutral');
const Failed = H.state('Failed', 'terminal', 'failure');

const Topic = H.work('Topic')
  .attributes({ topic: z.string(), recurring: z.boolean(), openedOn: z.string() })
  .states([Queued, Researching, Delivered, Parked, Cancelled, Failed])
  .events({ cancelled: { reason: z.string() } })
  .key(u => `${u.attributes.topic}@${u.attributes.openedOn}`);

const Findings = H.memory.experience('reportFindings');
const SourceExperience = H.memory.experience('sourceExperience');

const bySimilarity = H.policy.recall('bySimilarity', c =>
  [...c.candidates]
    .sort((a, b) => (b.similarity ?? 0) - (a.similarity ?? 0) || b.specificity - a.specificity)
    .slice(0, c.limit));

const bySpecificity = H.policy.recall('bySpecificity', c =>
  [...c.candidates]
    .sort((a, b) => b.specificity - a.specificity || b.track.succeeded - a.track.succeeded)
    .slice(0, c.limit));

const findings = H.journal('findings', Findings)
  .store(lancedb.memory('.harness/findings.lance', { embedding: 'text-embedding-3-small' }))
  .recall(bySimilarity);
const sources = H.journal('sources', SourceExperience)
  .store(jsonl.memory('.harness/sources.jsonl'))
  .recall(bySpecificity);

const apiAccount = anthropic.account('anthropicApi', { apiKey: H.env('ANTHROPIC_API_KEY') });
const haikuBatch = anthropic.model('claude-haiku-4-5', { batch: true });
const opus = anthropic.model('claude-opus-4-1');
const sonnet = anthropic.model('claude-sonnet-4-5');

const citationCheck = H.command('citationCheck', ['node', 'scripts/check-citations.mjs']);
const citationPass = H.metric('citationPass').of(citationCheck).hit(result => result.exitCode === 0);

const synthesizerModel = H.policy.model('synthesizerModel', [opus, sonnet], c => {
  const opusRecord = c.metrics.read(citationPass, { model: opus, window: { days: 30 } });
  const sonnetRecord = c.metrics.read(citationPass, { model: sonnet, window: { days: 30 } });
  if (opusRecord.n < 15 || sonnetRecord.n < 15) return opusRecord.n <= sonnetRecord.n ? opus : sonnet;
  return (opusRecord.rate ?? 0) >= (sonnetRecord.rate ?? 0) ? opus : sonnet;
});

const searcherRole = H.role('searcher')
  .intents(['search', 'browse'])
  .instructions('Search for sources on one angle of the topic and extract their claims.')
  .input({ topic: z.string(), angle: z.number() })
  .output({ sources: z.array(z.object({ url: z.string(), claim: z.string() })) });

const synthesizerRole = H.role('synthesizer')
  .intents(['read', 'remember'])
  .instructions('Write a sourced report. Every claim cites a source url.')
  .input({ topic: z.string(), findings: z.string() })
  .output({ report: z.string(), citations: z.array(z.string()), keyFindings: z.array(z.string()) });

const searcher = H.agent('searcher', searcherRole).model(haikuBatch).pool(apiAccount).recalls([sources]);
const synthesizer = H.agent('synthesizer', synthesizerRole)
  .model(synthesizerModel)
  .pool(apiAccount)
  .recalls([findings, sources])
  .records(sources);

const researchFlow = H.flow('research')
  .requires({ topic: z.string() })
  .batch('extract', searcher, c => Array.from({ length: 20 }, (_, angle) => ({ topic: c.input.topic, angle })))
  .exit('parked', c => c.out.extract.reduce((total, result) => total + result.sources.length, 0) < 5)
  .step('synthesize', synthesizer, c => ({
    topic: c.input.topic,
    findings: c.out.extract
      .flatMap(result => result.sources.map(source => `${source.claim} (${source.url})`))
      .join('\n'),
  }))
  .step('citations', citationCheck, c => ({ args: c.out.synthesize.citations }))
  .ends(['delivered'], () => 'delivered');

const weeklyRecurring = H.supply.schedule(Topic, H.time.weekly('mon', '06:00'), (c, supply) => {
  const openedOn = new Date(c.now).toISOString().slice(0, 10);
  const recurring = Array.from(new Set(c.units.filter(u => u.attributes.recurring).map(u => u.attributes.topic)));
  return recurring.map(topic => supply.create({ attributes: { topic, recurring: true, openedOn } }));
});

const topics = H.lane('topics', Topic)
  .supply([H.supply.operator(), weeklyRecurring])
  .store(sqlite.store(Topic, '.harness/topics.db'))
  .handler(researchFlow, { opens: Researching, ends: { parked: Parked, delivered: Delivered } })
  .runner(local.shell({ slots: 2 }))
  .retry(H.retry.fixed({ maxRetries: 1, delayMs: 600_000 }), { exhausted: Failed })
  .budget({ maxUsdPerUnit: 3, onExceed: 'fail' });

const operatorCancelled = H.trigger('operatorCancelled', H.on.event(topics, 'cancelled'))
  .moves(Cancelled, { from: [Queued, Researching], cancels: true });

const reportFindings = H.trigger('reportFindings', H.on.transition(topics, { to: [Delivered] }))
  .records(findings, e => (e.outputs.synthesize?.keyFindings ?? []).map(finding => ({
    rule: `When researching ${e.unit.attributes.topic}, start from this established finding: ${finding}`,
    because: `the delivered report on ${e.unit.attributes.topic} of ${e.unit.attributes.openedOn} established it`,
    when: { kinds: [Topic] },
  })));

const dailyBudgetUsd = 40;

const withinDailyBudget = H.policy.schedule('withinDailyBudget', c => {
  const projectedUsd = Math.max(c.metrics.cost({ kind: Topic, verdict: 'success', window: { days: 30 } }).meanUsd ?? 3, 0.01);
  const spentUsd = c.metrics.spentUsd({ sinceMs: c.clock.startOfDay() });
  const remainingUsd = dailyBudgetUsd - spentUsd - c.open.length * projectedUsd;
  const affordable = Math.max(0, Math.floor(remainingUsd / projectedUsd));
  return { start: c.order(k => k.enqueuedAt).slice(0, affordable) };
});

const operatorAccess = H.access('operator').allows([
  H.ops.readWork,
  H.ops.createWork,
  H.ops.sendEvents,
  H.ops.resolveBlocks,
  H.ops.readMemory,
  H.ops.readTelemetry,
]);

export const researchPipeline = H.harness('researchPipeline')
  .ledger(sqlite.ledger('.harness/research.db'))
  .lanes([topics])
  .triggers([operatorCancelled, reportFindings])
  .schedule(withinDailyBudget)
  .clients([claudeCode.supervisor('operator', operatorAccess, { port: H.slot.port(0) })])
  .projections([markdown.board('BOARD.md'), markdown.telemetry('TELEMETRY.md')]);
