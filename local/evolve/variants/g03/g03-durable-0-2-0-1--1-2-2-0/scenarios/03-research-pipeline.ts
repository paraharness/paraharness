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

const Queued = H.state('queued', 'pending');
const Delivered = H.terminal('delivered', 'success');
const Parked = H.terminal('parked', 'neutral');
const Cancelled = H.terminal('cancelled', 'neutral');
const Failed = H.terminal('failed', 'failure');

const topic = z.object({ topic: z.string(), tags: z.array(z.string()), requestedBy: z.string() });

const Topic = H.kind('topic').attributes(topic).states(Queued, Delivered, Parked, Cancelled, Failed).key(a => a.topic).initial(Queued);

const searcherRole = H.role('searcher').intents('search', 'browse').instructions('Find sources and extract claims with their citations.');
const synthesizerRole = H.role('synthesizer').intents('read').instructions('Write a sourced report; cite every claim.');

const findings = H.journal('prior-findings', H.memory('finding', 'experience'))
  .store(
    pgvector.memoryStore({
      url: H.env('FINDINGS_DATABASE_URL'),
      table: 'findings',
      embedder: voyage.embedder('findings-embedder', { id: 'voyage-3', apiKey: H.env('VOYAGE_API_KEY') }),
    }),
  )
  .recall({ by: 'similarity', limit: 6 })
  .readBy(synthesizerRole);

const sourceExperience = H.journal('source-experience', H.memory('source-lessons', 'experience'))
  .store(jsonl.memoryStore({ path: 'memory/sources.jsonl' }))
  .recall({ by: 'specificity', limit: 8 })
  .readBy(searcherRole, synthesizerRole);

const apiAccount = anthropic.account('anthropic-api', {
  apiKey: H.env('ANTHROPIC_API_KEY'),
  quota: sqlite.quota('research-quota', { path: '.harness/quota.db' }),
});
const researchPool = H.pool('research').accounts(apiAccount);

const haiku = anthropic.model('haiku', { id: 'claude-haiku-4-5' });
const opus = anthropic.model('opus', { id: 'claude-opus-4-1' });
const sonnet = anthropic.model('sonnet', { id: 'claude-sonnet-4-5' });

const synthesizerModel = H.policy.model('synthesizer-model', [opus, sonnet], ctx => {
  const window = { lastDays: 30 };
  const first = ctx.metrics.rate(citationPass, { model: opus, window });
  const second = ctx.metrics.rate(citationPass, { model: sonnet, window });
  if (first.samples < 30) return opus;
  if (second.samples < 30) return sonnet;
  return first.rate >= second.rate ? opus : sonnet;
});

const searcher = H.seat('searcher')
  .role(searcherRole)
  .model(haiku)
  .pool(researchPool)
  .output(z.object({ sources: z.array(z.object({ url: z.string(), claim: z.string() })) }));

const synthesizer = H.seat('synthesizer')
  .role(synthesizerRole)
  .model(synthesizerModel)
  .pool(researchPool)
  .output(z.object({ report: z.string(), headline: z.string(), citations: z.array(z.string()) }));

const workstation = local.runner('workstation');

const planQueries = H.command('plan-queries')
  .input(z.object({ topic: z.string() }))
  .argv(input => ['research-plan', '--count', '20', input.topic])
  .output(z.object({ queries: z.array(z.string()) }))
  .runner(workstation);

const checkCitations = H.command('check-citations')
  .input(z.object({ citations: z.array(z.string()) }))
  .argv(input => ['check-citations', ...input.citations])
  .runner(workstation);

const deliverReport = H.command('deliver-report')
  .input(z.object({ topic: z.string(), report: z.string() }))
  .argv(input => ['deliver-report', '--topic', input.topic, '--body', input.report])
  .runner(workstation);

const research = H.flow('research')
  .input(topic)
  .step('plan', planQueries, ctx => ({ topic: ctx.unit.attributes.topic }))
  .job('search', H.batch(searcher), ctx =>
    ctx.steps.plan.queries.slice(0, 20).map(query => ({ task: `Search for and extract sourced claims: ${query}` })),
  )
  .exit('parked', ctx => ctx.steps.search.flatMap(result => result.sources).length < 5)
  .step('synthesize', synthesizer, ctx => ({
    task: `Write a report on "${ctx.unit.attributes.topic}" from these sources:\n${JSON.stringify(ctx.steps.search.flatMap(result => result.sources))}`,
  }))
  .step('citeCheck', checkCitations, ctx => ({ citations: ctx.steps.synthesize.citations }))
  .step('deliver', deliverReport, ctx => ({ topic: ctx.unit.attributes.topic, report: ctx.steps.synthesize.report }), {
    afterCrash: 'park',
  })
  .exit('delivered');

const topics = H.lane('topics', Topic)
  .supply(H.operator)
  .handler(research, { exits: { parked: Parked, delivered: Delivered } })
  .store(sqlite.store({ path: '.harness/topics.db' }))
  .retry({ maxAttempts: 2, backoff: 'exponential', initialDelayMs: 600_000, exhausted: Failed })
  .on(H.cancel, { enter: Cancelled })
  .ceiling({ maxUsd: 3, onExceed: 'fail' });

const citationPass = H.metric('citation-check-pass', H.when.step(topics, 'citeCheck')).samples(event => [
  { hit: event.ok, model: event.modelOf(synthesizer) },
]);

const topicCost = H.metric('succeeded-topic-cost', H.when.transition(topics, { to: [Delivered, Parked] })).amounts(event =>
  event.attempt === undefined ? [] : [{ amount: event.attempt.costUsd }],
);

const dailySpend = H.metric('research-spend', H.when.invocation({ lanes: [topics] })).amounts(event => [{ amount: event.costUsd }]);

const reopenRecurring = H.trigger('reopen-recurring-topics')
  .on(H.when.sweep(topics, { every: H.clock('weekly-recurring').at('06:00', { on: 'mon', tz: 'UTC' }), in: [Delivered, Parked] }))
  .create(topics, event => (event.unit.attributes.tags.includes('recurring') ? event.unit.attributes : undefined));

const recordFinding = H.trigger('record-finding')
  .on(H.when.step(topics, 'synthesize', { if: event => event.ok }))
  .record(findings, event =>
    event.output === undefined
      ? undefined
      : {
          text: `When researching ${event.unit.attributes.topic}, start from the finding "${event.output.headline}", because a prior cited report established it.`,
          when: { kinds: [Topic] },
        },
  );

const scheduler = H.scheduler('research')
  .standard(topics)
  .admit(topics, ctx => {
    const succeeded = ctx.metrics.total(topicCost, { window: { lastDays: 30 } });
    const projectedUsd = succeeded.samples === 0 ? 3 : succeeded.total / succeeded.samples;
    const spentTodayUsd = ctx.metrics.total(dailySpend, { window: { calendar: 'day', tz: 'UTC' } }).total;
    return spentTodayUsd + projectedUsd <= 40;
  });

const supervisor = claudeCode.supervisor('research-supervisor', {
  grants: [H.ops.workRead, H.ops.workCreate, H.ops.workCancel, H.ops.memoryRead, H.ops.telemetryRead],
});

export const researchPipeline = H.harness('research-pipeline')
  .ledger(sqlite.ledger({ path: '.harness/ledger.db' }))
  .lanes(topics)
  .journals(findings, sourceExperience)
  .triggers(reopenRecurring, recordFinding)
  .metrics(citationPass, topicCost, dailySpend)
  .scheduler(scheduler)
  .clients(supervisor)
  .observers(markdown.board({ path: 'BOARD.md' }), markdown.telemetry({ path: 'TELEMETRY.md' }));

void researchPipeline.start();
