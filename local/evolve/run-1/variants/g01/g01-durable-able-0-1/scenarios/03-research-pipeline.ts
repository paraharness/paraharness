import { z } from 'zod';
import { H, type MetricRef } from 'harness-dsl';
import { sqlite } from 'harness-dsl/sqlite';
import { jsonl } from 'harness-dsl/jsonl';
import { pgvector } from 'harness-dsl/pgvector';
import { anthropic } from 'harness-dsl/anthropic';
import { claudeCode } from 'harness-dsl/claude-code';
import { local } from 'harness-dsl/local';
import { markdown } from 'harness-dsl/markdown';

const topicAttributes = z.object({ slug: z.string(), question: z.string(), tags: z.array(z.string()) });

const queued = H.state('Queued', 'pending');
const searching = H.state('Searching', 'active');
const synthesizing = H.state('Synthesizing', 'active');
const checking = H.state('CheckingCitations', 'active');
const delivered = H.state('Delivered', 'terminal', 'success');
const parked = H.state('Parked', 'terminal', 'neutral');
const failed = H.state('Failed', 'terminal', 'failure');
const cancelled = H.state('Cancelled', 'terminal', 'neutral');

const Topic = H.kind('Topic')
  .attributes(topicAttributes)
  .states(queued, searching, synthesizing, checking, delivered, parked, failed, cancelled)
  .key(attrs => attrs.slug);

const reopen = H.signal('reopen');

const apiAccount = anthropic.account('research-api', { apiKey: H.env('ANTHROPIC_API_KEY') });
const haiku = anthropic.model('haiku', { id: 'claude-haiku-4-5' });
const sonnet = anthropic.model('sonnet', { id: 'claude-sonnet-4-5' });
const opus = anthropic.model('opus', { id: 'claude-opus-4-1' });
const researchPool = H.pool('research-pool').accounts(apiAccount);

const synthesisModel = H.policy.model('synthesis-model-by-citation-pass', [opus, sonnet], ctx => {
  const opusRecord = ctx.metrics.rate(citationPassRate, { group: opus.name, windowDays: 30 });
  const sonnetRecord = ctx.metrics.rate(citationPassRate, { group: sonnet.name, windowDays: 30 });
  if (opusRecord.samples < 25 || sonnetRecord.samples < 25) {
    return opusRecord.samples <= sonnetRecord.samples ? opus : sonnet;
  }
  return opusRecord.rate >= sonnetRecord.rate ? opus : sonnet;
});

const searcherRole = H.role('searcher')
  .intents('search', 'browse')
  .instructions('Find sources for one angle of the question and extract their claims with a confidence.');
const synthesizerRole = H.role('synthesizer')
  .intents('read', 'record')
  .instructions('Write a sourced report. Every claim cites a source URL. Record lessons about sources.');

const searcher = H.agent('searcher-agent')
  .role(searcherRole)
  .model(haiku)
  .output(z.object({
    sources: z.array(z.object({ url: z.string(), claim: z.string(), confidence: z.number() })),
  }));
const searchBatch = searcher.batch();

const synthesizer = H.agent('synthesizer-agent')
  .role(synthesizerRole)
  .model(synthesisModel)
  .output(z.object({ report: z.string(), citations: z.array(z.string()), forwardFinding: z.string() }));

const citationCheck = H.command('citation-check')
  .input(z.object({ citations: z.array(z.string()) }))
  .argv(input => ['citecheck', '--strict', ...input.citations])
  .runner(local.runner('research-runner'));

const priorFindings = H.memory('prior-findings', 'experience');
const sourceExperience = H.memory('source-experience', 'experience');

const findingsJournal = H.journal('findings-journal', priorFindings)
  .store(pgvector.memoryStore({ url: H.env('RESEARCH_PG_URL'), table: 'prior_findings', embeddingModel: 'text-embedding-3-small' }))
  .recall(H.recall('by-similarity', { by: 'similarity', limit: 8 }))
  .readBy(synthesizerRole);
const sourceJournal = H.journal('source-journal', sourceExperience)
  .store(jsonl.memoryStore({ path: '.harness/memory/sources.jsonl' }))
  .recall(H.recall('by-scope', { by: 'specificity', limit: 10 }))
  .readBy(searcherRole, synthesizerRole)
  .writtenBy(synthesizerRole);

const researchTopic = H.flow('research-topic')
  .input(topicAttributes)
  .step('search', searchBatch, ctx =>
    Array.from({ length: 20 }, (_, index) => ({
      task: `Angle ${index + 1} of 20 on: ${ctx.unit.attributes.question}`,
      skills: ['search', ...ctx.unit.attributes.tags],
    })),
  )
  .exit('insufficientSources', ctx => ctx.steps.search.reduce((count, result) => count + result.sources.length, 0) < 5)
  .step('synthesize', synthesizer, ctx => ({
    task: `Answer "${ctx.unit.attributes.question}" from these extracts:\n${JSON.stringify(ctx.steps.search)}`,
    skills: ctx.unit.attributes.tags,
  }))
  .step('citations', citationCheck, ctx => ({ citations: ctx.steps.synthesize.citations }), { onCrash: 'rerun' })
  .exit('delivered');

const topicLane = H.lane('topics', Topic)
  .supply(H.operator)
  .supply(H.clock('weekly-recurring').weekly('mon', '06:00', { tz: 'UTC' }), (tick, to) =>
    to.signal(reopen, unit => unit.position === 'terminal' && unit.attributes.tags.includes('recurring'), {}),
  )
  .store(sqlite.store({ path: '.harness/topics.db' }))
  .handler(researchTopic, {
    exits: { insufficientSources: parked, delivered },
    during: { search: searching, synthesize: synthesizing, citations: checking },
    failure: failed,
    cancelled,
  })
  .on(reopen, { enter: queued })
  .ceiling({ maxUsd: 3, onExceed: 'fail' });

const citationPassRate: MetricRef = H.metric('citation-pass-rate')
  .from(H.when.step(topicLane, 'citations'))
  .samples(event => [{ group: event.models.synthesize ?? 'unknown', hit: event.ok }]);

const findingsFromDeliveredReports = H.trigger('findings-from-delivered-reports')
  .on(H.when.step(topicLane, 'citations', { if: event => event.ok }))
  .record(findingsJournal, event => {
    const synthesis = event.steps.synthesize;
    return synthesis
      ? { text: synthesis.forwardFinding, when: { kinds: [Topic], skills: event.unit.attributes.tags }, status: 'active' }
      : undefined;
  });

const researchScheduler = H.scheduler('research-scheduler')
  .priority(topicLane)
  .admit(topicLane, ctx => {
    const mean = ctx.metrics.meanCostUsd({ of: topicLane, windowDays: 30 });
    const projectedUsd = mean.samples > 0 ? mean.meanUsd : 3;
    const startOfDay = new Date(Date.UTC(ctx.now.getUTCFullYear(), ctx.now.getUTCMonth(), ctx.now.getUTCDate()));
    return ctx.spentUsd([topicLane], startOfDay) + projectedUsd <= 40;
  });

const operator = claudeCode.supervisor('research-supervisor', {
  grants: [H.ops.workRead, H.ops.workCreate, H.ops.workCancel, H.ops.memoryRead, H.ops.memoryCurate, H.ops.telemetryRead],
});

export const researchPipeline = H.harness('research-pipeline')
  .ledger(sqlite.ledger({ path: '.harness/research-ledger.db' }))
  .pools(researchPool)
  .lanes(topicLane)
  .journals(findingsJournal, sourceJournal)
  .triggers(findingsFromDeliveredReports)
  .metrics(citationPassRate)
  .scheduler(researchScheduler)
  .clients(operator)
  .observers(markdown.board({ path: 'BOARD.md' }), markdown.telemetry({ path: 'TELEMETRY.md' }));
