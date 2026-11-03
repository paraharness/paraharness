import { z } from 'zod';
import { H } from 'harness-dsl';
import { anthropic } from 'harness-dsl/anthropic';
import { sqlite } from 'harness-dsl/sqlite';
import { jsonl } from 'harness-dsl/jsonl';
import { pgvector } from 'harness-dsl/pgvector';
import { voyage } from 'harness-dsl/voyage';
import { local } from 'harness-dsl/local';
import { http } from 'harness-dsl/http';
import { markdown } from 'harness-dsl/markdown';

const quota = sqlite.quota('research-quota', { path: '.harness/quota.sqlite' });
const apiAccount = anthropic.account('research-api', { apiKey: H.env('ANTHROPIC_API_KEY'), quota });
const apiPool = H.pool('research-api').accounts(apiAccount);
const haiku = anthropic.model('haiku', { id: 'claude-haiku-4-5' });
const opus = anthropic.model('opus', { id: 'claude-opus-4-1' });
const sonnet = anthropic.model('sonnet', { id: 'claude-sonnet-4-5' });

const localRunner = local.runner('local').slots(2);

const topicSchema = z.object({
  title: z.string(),
  question: z.string(),
  tags: z.array(z.string()),
  edition: z.string(),
});

const queued = H.state('queued', 'pending');
const delivered = H.terminal('delivered', 'success');
const parked = H.terminal('parked', 'neutral');
const cancelled = H.terminal('cancelled', 'neutral');
const failed = H.terminal('failed', 'failure');

const topic = H.kind('Topic')
  .attributes(topicSchema)
  .states(queued, delivered, parked, cancelled, failed)
  .initial(queued)
  .key(attrs => `${attrs.title}@${attrs.edition}`);

const searcherRole = H.role('searcher').intents('search', 'browse').instructions('Search one angle of the question and extract sourced findings.');
const synthesizerRole = H.role('synthesizer').intents('read', 'record').instructions('Write a sourced report. Every claim cites a source.');

const searcher = H.seat('searcher')
  .role(searcherRole)
  .model(haiku)
  .pool(apiPool)
  .output(z.object({ findings: z.array(z.string()), sources: z.array(z.string()) }));

const searchBatch = H.batch(searcher);

const synthesizerModel = H.policy.model('synthesizer-by-citation-pass', [opus, sonnet], ctx => {
  const opusRecord = ctx.metrics.rate(citationPass, { seat: ctx.seat, model: opus, window: { lastDays: 30 } });
  const sonnetRecord = ctx.metrics.rate(citationPass, { seat: ctx.seat, model: sonnet, window: { lastDays: 30 } });
  if (opusRecord.samples < 15) return opus;
  if (sonnetRecord.samples < 15) return sonnet;
  return sonnetRecord.rate >= opusRecord.rate ? sonnet : opus;
});

const synthesizer = H.seat('synthesizer')
  .role(synthesizerRole)
  .model(synthesizerModel)
  .pool(apiPool)
  .output(z.object({ report: z.string(), keyFindings: z.array(z.string()) }));

const citationCheck = H.command('check-citations')
  .input(z.object({ report: z.string() }))
  .argv(input => ['./bin/check-citations', '--report', input.report])
  .runner(localRunner);

const research = H.flow('research')
  .input(topicSchema)
  .job('search', searchBatch, ctx => Array.from({ length: 20 }, (_, index) => ({
    task: `Angle ${index + 1} of 20 on: ${ctx.unit.attributes.question}. Extract findings with source links.`,
  })))
  .exit('parked', ctx => ctx.steps.search.filter(result => result.sources.length > 0).length < 5)
  .step('synthesize', synthesizer, ctx => ({
    task: `Write a sourced report on ${ctx.unit.attributes.question}.\nFindings:\n${ctx.steps.search.map(result => `${result.findings.join('\n')}\nSources: ${result.sources.join(', ')}`).join('\n')}`,
  }), { afterCrash: 'askDriver' })
  .step('cite', citationCheck, ctx => ({ report: ctx.steps.synthesize.report }), { afterCrash: 'rerun' })
  .exit('delivered');

const weekly = H.clock('weekly-recurring').at('06:00', { on: 'mon', tz: 'UTC' });

const topicLane = H.lane('topics', topic)
  .supply(H.operator)
  .handler(research, { exits: { parked, delivered } })
  .store(sqlite.store({ path: '.harness/topics.sqlite' }))
  .retry({ maxAttempts: 2, backoff: 'exponential', initialDelayMs: 600000, exhausted: failed })
  .ceiling({ maxUsd: 3, onExceed: 'fail' })
  .on(H.cancel, { enter: cancelled });

const citationPass = H.metric('citation-pass', H.when.step(topicLane, 'cite')).samples(event => [{
  hit: event.ok,
  seat: synthesizer,
  model: event.modelOf(synthesizer),
}]);

const deliveredCost = H.metric('delivered-topic-cost', H.when.transition(topicLane, { to: delivered }))
  .amounts(event => [{ amount: event.attempt?.costUsd ?? 0 }]);

const topicSpend = H.metric('topic-spend', H.when.invocation({ lanes: [topicLane] }))
  .amounts(event => [{ amount: event.costUsd, model: event.model }]);

const recurringTopicsReopen = H.trigger('recurring-topics-reopen')
  .on(H.when.sweep(topicLane, { every: weekly, in: [delivered, parked] }))
  .create(topicLane, event => event.unit.attributes.tags.includes('recurring')
    ? { ...event.unit.attributes, edition: event.at.toISOString().slice(0, 10) }
    : undefined);

const findings = H.memory('report-findings', 'experience');
const sourceExperience = H.memory('source-experience', 'experience');

const findingsJournal = H.journal('report-findings', findings)
  .store(pgvector.memoryStore({
    url: H.env('FINDINGS_DATABASE_URL'),
    table: 'report_findings',
    embedder: voyage.embedder('findings-embedder', { id: 'voyage-3', apiKey: H.env('VOYAGE_API_KEY') }),
  }))
  .recall({ by: 'similarity', limit: 8 })
  .readBy(synthesizerRole);

const sourceJournal = H.journal('source-experience', sourceExperience)
  .store(jsonl.memoryStore({ path: 'memory/sources.jsonl' }))
  .recall({ by: 'specificity', limit: 10 })
  .readBy(searcherRole, synthesizerRole)
  .recordedBy(synthesizerRole);

const findingsRemembered = H.trigger('findings-remembered')
  .on(H.when.step(topicLane, 'synthesize', { if: event => event.ok }))
  .record(findingsJournal, event => event.output === undefined ? undefined : {
    text: `When researching ${event.unit.attributes.title}, start from these findings: ${event.output.keyFindings.join('; ')}, because a prior report established them`,
    when: { kinds: [topic], roles: [synthesizerRole] },
  });

const scheduler = H.scheduler('research')
  .standard(topicLane)
  .admit(topicLane, ctx => {
    const succeeded = ctx.metrics.total(deliveredCost, { window: { lastDays: 30 } });
    const projectedUsd = succeeded.samples === 0 ? 3 : succeeded.total / succeeded.samples;
    const spentToday = ctx.metrics.total(topicSpend, { window: { calendar: 'day', tz: 'UTC' } });
    return spentToday.total + projectedUsd <= 40;
  });

const researchDesk = http.controlApi('research-desk', {
  port: H.slot.port(0),
  token: H.env('RESEARCH_DESK_TOKEN'),
  grants: [H.ops.workRead, H.ops.workCreate, H.ops.workCancel, H.ops.memoryRead, H.ops.telemetryRead],
});

export const researchPipeline = H.harness('research-pipeline')
  .ledger(sqlite.ledger({ path: '.harness/ledger.sqlite' }))
  .lanes(topicLane)
  .journals(findingsJournal, sourceJournal)
  .triggers(recurringTopicsReopen, findingsRemembered)
  .metrics(citationPass, deliveredCost, topicSpend)
  .scheduler(scheduler)
  .clients(researchDesk)
  .observers(markdown.board({ path: 'BOARD.md' }), markdown.telemetry({ path: 'TELEMETRY.md' }));

void researchPipeline.start();
