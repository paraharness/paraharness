import { z } from 'zod';
import { H } from 'harness-dsl';
import { sqlite } from 'harness-dsl/sqlite';
import { jsonl } from 'harness-dsl/jsonl';
import { pgvector } from 'harness-dsl/pgvector';
import { voyage } from 'harness-dsl/voyage';
import { anthropic } from 'harness-dsl/anthropic';
import { claudeCode } from 'harness-dsl/claude-code';
import { local } from 'harness-dsl/local';
import { markdown } from 'harness-dsl/markdown';

const quota = sqlite.quota('research-quota', { path: './state/quota.sqlite' });
const apiAccount = anthropic.account('research-api', { apiKey: H.env('ANTHROPIC_API_KEY'), quota });
const researchPool = H.pool('research-api').accounts(apiAccount);

const haiku = anthropic.model('haiku', { id: 'claude-haiku-4-5' });
const opus = anthropic.model('opus', { id: 'claude-opus-4-1' });
const sonnet = anthropic.model('sonnet', { id: 'claude-sonnet-4-5' });

const Topic = z.object({ topic: z.string(), tags: z.array(z.string()) });

const Open = H.state('Open', 'pending');
const Delivered = H.terminal('Delivered', 'success');
const Parked = H.terminal('Parked', 'neutral');
const CancelledByOperator = H.terminal('CancelledByOperator', 'neutral');
const Failed = H.terminal('Failed', 'failure');

const topicKind = H.kind('Topic')
  .attributes(Topic)
  .states(Open, Delivered, Parked, CancelledByOperator, Failed)
  .key(attrs => attrs.topic)
  .initial(Open);

const extractorRole = H.role('extractor').intents('search', 'browse', 'read').instructions('Find sources and extract sourced claims.');
const synthesizerRole = H.role('synthesizer')
  .intents('read', 'record')
  .instructions('Write a sourced report. Record findings and source lessons that will hold next time.');

const extractor = H.seat('extractor')
  .role(extractorRole)
  .model(haiku)
  .pool(researchPool)
  .output(z.object({ sources: z.array(z.object({ url: z.string(), finding: z.string() })) }));

const synthesizerModel = H.policy.model('synthesizer-model', [opus, sonnet], ctx => {
  const opusRecord = ctx.metrics.rate(citationPass, { seat: ctx.seat, model: opus, window: { lastDays: 30 } });
  const sonnetRecord = ctx.metrics.rate(citationPass, { seat: ctx.seat, model: sonnet, window: { lastDays: 30 } });
  if (opusRecord.samples < 10) return opus;
  if (sonnetRecord.samples < 10) return sonnet;
  return opusRecord.rate >= sonnetRecord.rate ? opus : sonnet;
});

const synthesizer = H.seat('synthesizer')
  .role(synthesizerRole)
  .model(synthesizerModel)
  .pool(researchPool)
  .output(z.object({ report: z.string(), citations: z.array(z.string()) }));

const extractBatch = extractor.batch();

const localRunner = local.runner('local').slots(2);
const citationCheck = H.command('citation-check')
  .input(z.object({ report: z.string(), citations: z.array(z.string()) }))
  .argv(input => ['./bin/check-citations', '--report', input.report, ...input.citations])
  .runner(localRunner);

const research = H.flow('research')
  .input(Topic)
  .job('extract', extractBatch, ctx =>
    Array.from({ length: 20 }, (_, index) => ({
      task: `Search angle ${index + 1} of 20 on "${ctx.unit.attributes.topic}": find sources and extract sourced claims.`,
      skills: ['search'],
    })),
  )
  .exit('parked', ctx => ctx.steps.extract.flatMap(result => result.sources).length < 5)
  .step('synthesize', synthesizer, ctx => ({
    task: `Write a sourced report on "${ctx.unit.attributes.topic}" from these extracts:\n${JSON.stringify(ctx.steps.extract)}`,
  }))
  .step('citations', citationCheck, ctx => ({
    report: ctx.steps.synthesize.report,
    citations: ctx.steps.synthesize.citations,
  }))
  .exit('delivered');

const topicLane = H.lane('topics', topicKind)
  .handler(research, { exits: { parked: Parked, delivered: Delivered } })
  .store(sqlite.store({ path: './state/topics.sqlite' }))
  .retry({ maxAttempts: 2, backoff: 'exponential', initialDelayMs: 300_000, exhausted: Failed })
  .ceiling({ maxUsd: 3, onExceed: 'fail' })
  .on(H.cancel, { enter: CancelledByOperator })
  .supply(H.operator)
  .supply(
    sqlite.scan('recurring-topics', {
      path: './state/topics.sqlite',
      kind: 'Topic',
      schedule: H.clock('weekly-reopen').at('06:00', { on: 'mon', tz: 'UTC' }),
    }),
    (stored, to) => {
      const topic = Topic.parse(stored.attributes);
      return topic.tags.includes('recurring') ? to.create(topic) : to.skip();
    },
  );

const citationPass = H.metric('citation-pass', H.when.step(topicLane, 'citations')).samples(event => [
  { hit: event.ok, seat: synthesizer, model: event.seats.synthesize?.model },
]);

const researchSpend = H.metric('research-spend', H.when.invocation({ lanes: [topicLane] })).amounts(event => [
  { amount: event.costUsd, seat: event.seat, model: event.model },
]);

const deliveredAttemptCost = H.metric('delivered-attempt-cost', H.when.transition(topicLane, { to: Delivered })).amounts(
  event => (event.attempt ? [{ amount: event.attempt.costUsd }] : []),
);

const findings = H.journal('report-findings', H.memory('report-findings', 'experience'))
  .store(
    pgvector.memoryStore({
      url: H.env('FINDINGS_DATABASE_URL'),
      table: 'findings',
      embedder: voyage.embedder('findings-embedder', { id: 'voyage-3', apiKey: H.env('VOYAGE_API_KEY') }),
    }),
  )
  .recall({ by: 'similarity', limit: 6 })
  .readBy(synthesizerRole)
  .recordedBy(synthesizerRole);

const sourceExperience = H.journal('source-experience', H.memory('source-experience', 'experience'))
  .store(jsonl.memoryStore({ path: './memory/sources.jsonl' }))
  .recall({ by: 'specificity', limit: 8 })
  .readBy(extractorRole, synthesizerRole)
  .recordedBy(synthesizerRole);

const scheduler = H.scheduler('research')
  .standard(topicLane)
  .wip(topicLane, 3)
  .admit(topicLane, ctx => {
    const spentToday = ctx.metrics.total(researchSpend, { window: { calendar: 'day', tz: 'UTC' } });
    const delivered = ctx.metrics.total(deliveredAttemptCost, { window: { lastDays: 30 } });
    const projected = delivered.samples === 0 ? 3 : delivered.total / delivered.samples;
    return spentToday.total + projected <= 40;
  });

const supervisor = claudeCode.supervisor('research-operator', {
  port: H.slot.port(0),
  grants: [
    H.ops.workRead,
    H.ops.workCreate,
    H.ops.workCancel,
    H.ops.attemptsRecover,
    H.ops.memoryRead,
    H.ops.memoryWrite,
    H.ops.telemetryRead,
  ],
});

export default H.harness('research-pipeline')
  .ledger(sqlite.ledger({ path: './state/ledger.sqlite' }))
  .lanes(topicLane)
  .journals(findings, sourceExperience)
  .metrics(citationPass, researchSpend, deliveredAttemptCost)
  .scheduler(scheduler)
  .clients(supervisor)
  .observers(markdown.board({ path: './BOARD.md' }), markdown.telemetry({ path: './TELEMETRY.md' }));
