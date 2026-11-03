import { z } from 'zod';
import { H, MetricRef } from 'harness-dsl';
import { sqlite } from 'harness-dsl/sqlite';
import { jsonl } from 'harness-dsl/jsonl';
import { pgvector } from 'harness-dsl/pgvector';
import { voyage } from 'harness-dsl/voyage';
import { anthropic } from 'harness-dsl/anthropic';
import { claudeCode } from 'harness-dsl/claude-code';
import { local } from 'harness-dsl/local';
import { markdown } from 'harness-dsl/markdown';

const TopicAttrs = z.object({ topicId: z.string(), question: z.string(), tags: z.array(z.string()) });

const Open = H.state('open', 'pending');
const Delivered = H.terminal('delivered', 'success');
const Parked = H.terminal('parked', 'neutral');
const Cancelled = H.terminal('cancelled', 'neutral');
const Failed = H.terminal('failed', 'failure');

const Topic = H.kind('Topic')
  .attributes(TopicAttrs)
  .states(Open, Delivered, Parked, Cancelled, Failed)
  .key(attrs => attrs.topicId)
  .initial(Open);

const quota = sqlite.quota('research-quota', { path: '.harness/quota.sqlite' });
const apiAccount = anthropic.account('research-api', { apiKey: H.env('ANTHROPIC_API_KEY'), quota });
const haiku = anthropic.model('haiku', { id: 'claude-haiku-4-5' });
const opus = anthropic.model('opus', { id: 'claude-opus-4-1' });
const sonnet = anthropic.model('sonnet', { id: 'claude-sonnet-4-5' });
const apiPool = H.pool('research-api').accounts(apiAccount);

const plannerRole = H.role('query-planner')
  .intents('read')
  .instructions('Write distinct, specific search queries.');
const extractorRole = H.role('extractor')
  .intents('search', 'browse')
  .instructions('Search, read sources and extract findings with their URLs.');
const synthesizerRole = H.role('synthesizer')
  .intents('read', 'record')
  .instructions('Write a sourced report; every claim carries a citation.');

const synthesizerChoice = H.policy.model('citation-pass-comparison', [opus, sonnet], ctx => {
  const reads = [opus, sonnet].map(model => ({
    model,
    pass: ctx.metrics.rate(citationPass, { seat: ctx.seat, model, window: { lastDays: 30 } }),
  }));
  const exploring = reads.find(read => read.pass.samples < 20);
  if (exploring !== undefined) return exploring.model;
  return reads.reduce((best, read) => (read.pass.rate > best.pass.rate ? read : best)).model;
});

const queryPlanner = H.seat('query-planner')
  .role(plannerRole)
  .model(haiku)
  .pool(apiPool)
  .output(z.object({ queries: z.array(z.string()) }));

const extractor = H.seat('extractor')
  .role(extractorRole)
  .model(haiku)
  .pool(apiPool)
  .output(z.object({ sources: z.array(z.object({ url: z.string(), finding: z.string() })) }));

const synthesizer = H.seat('synthesizer')
  .role(synthesizerRole)
  .model(synthesizerChoice)
  .pool(apiPool)
  .output(z.object({ report: z.string(), headline: z.string(), citations: z.array(z.string()) }));

const citationCheck = H.command('citation-check')
  .input(z.object({ citations: z.array(z.string()) }))
  .argv(input => ['./tools/check-citations', ...input.citations])
  .runner(local.runner('local'));

const research = H.flow('research')
  .input(TopicAttrs)
  .step('plan', queryPlanner, ctx => ({
    task: `Write 20 distinct search queries for: ${ctx.unit.attributes.question}`,
  }))
  .job('extract', H.batch(extractor), ctx =>
    ctx.steps.plan.queries.slice(0, 20).map(query => ({ task: `Search and extract sourced findings for: ${query}` })),
  )
  .exit('parked', ctx => ctx.steps.extract.flatMap(result => result.sources).length < 5)
  .step('synthesize', synthesizer, ctx => ({
    task: `Write a sourced report on "${ctx.unit.attributes.question}" from these findings:\n${ctx.steps.extract
      .flatMap(result => result.sources)
      .map(source => `- ${source.finding} (${source.url})`)
      .join('\n')}`,
  }))
  .step('check', citationCheck, ctx => ({ citations: ctx.steps.synthesize.citations }))
  .exit('delivered');

const topics = H.lane('topics', Topic)
  .supply(H.operator)
  .handler(research, { exits: { parked: Parked, delivered: Delivered } })
  .store(sqlite.store({ path: '.harness/topics.sqlite' }))
  .retry({ maxAttempts: 2, backoff: 'exponential', initialDelayMs: 300_000, exhausted: Failed })
  .ceiling({ maxUsd: 3, onExceed: 'fail' })
  .on(H.cancel, { enter: Cancelled });

const citationPass: MetricRef<'rate'> = H.metric('citation-check-pass', H.when.step(topics, 'check')).samples(
  event => [{ hit: event.ok, seat: synthesizer, model: event.seats.synthesize?.model }],
);

const modelSpend = H.metric('model-spend', H.when.invocation({ lanes: [topics] })).amounts(event => [
  { amount: event.costUsd },
]);

const deliveredAttemptCost = H.metric('delivered-attempt-cost', H.when.transition(topics, { to: Delivered })).amounts(
  event => (event.attempt === undefined ? [] : [{ amount: event.attempt.costUsd }]),
);

const reopenRecurringWeekly = H.trigger('reopen-recurring-weekly')
  .on(
    H.when.timer(topics, {
      at: unit =>
        unit.state === Delivered && unit.attributes.tags.includes('recurring')
          ? H.nextTime('06:00', { on: 'mon', after: unit.stateSince })
          : undefined,
    }),
  )
  .create(topics, event => event.unit.attributes);

const findings = H.journal('report-findings', H.memory('report-finding', 'experience'))
  .store(
    pgvector.memoryStore({
      url: H.env('FINDINGS_DATABASE_URL'),
      table: 'report_findings',
      embedder: voyage.embedder('findings-embedder', { id: 'voyage-3', apiKey: H.env('VOYAGE_API_KEY') }),
    }),
  )
  .recall({ by: 'similarity', limit: 8 })
  .readBy(synthesizerRole);

const sourceExperience = H.journal('source-experience', H.memory('source-experience', 'experience'))
  .store(jsonl.memoryStore({ path: '.harness/source-experience.jsonl' }))
  .recall({ by: 'specificity', limit: 10 })
  .readBy(extractorRole, synthesizerRole)
  .recordedBy(synthesizerRole);

const deliveredFindingsBecomeMemory = H.trigger('delivered-findings-become-memory')
  .on(H.when.step(topics, 'check', { if: event => event.ok }))
  .record(findings, event => {
    const synthesis = event.outputs.synthesize;
    return synthesis === undefined
      ? undefined
      : {
          text: `When researching "${event.unit.attributes.question}", start from "${synthesis.headline}" because the delivered report established it`,
          when: { kinds: [Topic] },
          status: 'active',
        };
  });

const scheduler = H.scheduler('research')
  .standard(topics)
  .admit(topics, ctx => {
    const spentToday = ctx.metrics.total(modelSpend, { window: { calendar: 'day' } });
    const delivered = ctx.metrics.total(deliveredAttemptCost, { window: { lastDays: 30 } });
    const projectedUsd = delivered.samples === 0 ? 3 : delivered.total / delivered.samples;
    return spentToday.total + projectedUsd <= 40;
  });

const supervisor = claudeCode.supervisor('research-supervisor', {
  port: H.slot.port(0),
  grants: [
    H.ops.workRead,
    H.ops.workCreate,
    H.ops.workCancel,
    H.ops.memoryRead,
    H.ops.memoryCurate,
    H.ops.telemetryRead,
  ],
});

export default H.harness('research-pipeline')
  .ledger(sqlite.ledger({ path: '.harness/ledger.sqlite' }))
  .lanes(topics)
  .journals(findings, sourceExperience)
  .triggers(reopenRecurringWeekly, deliveredFindingsBecomeMemory)
  .metrics(citationPass, modelSpend, deliveredAttemptCost)
  .scheduler(scheduler)
  .clients(supervisor)
  .observers(markdown.board({ path: 'BOARD.md' }), markdown.telemetry({ path: 'TELEMETRY.md' }));
