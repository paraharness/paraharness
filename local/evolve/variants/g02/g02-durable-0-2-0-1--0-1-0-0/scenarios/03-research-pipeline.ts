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

const quota = sqlite.quota('research-quota', { path: '.harness/quota.db' });
const apiAccount = anthropic.account('research-api', { apiKey: H.env('ANTHROPIC_API_KEY'), quota });
const haiku = anthropic.model('haiku', { id: 'claude-haiku-4-5' });
const sonnet = anthropic.model('sonnet', { id: 'claude-sonnet-4-5' });
const opus = anthropic.model('opus', { id: 'claude-opus-4-1' });
const researchPool = H.pool('research').accounts(apiAccount);

const searcherRole = H.role('searcher').intents('search', 'browse').instructions('Find sources and extract sourced claims.');
const synthesizerRole = H.role('synthesizer')
  .intents('read', 'record')
  .instructions('Write a report whose every claim cites a source.');

const citationLeader = H.policy.model('citationLeader', ctx => {
  const scored = ctx.candidates.map(model => ({
    model,
    record: ctx.metrics.rate(citationPass, { by: { seat: ctx.seat, model }, window: { lastDays: 30 } }),
  }));
  const unexplored = scored.find(entry => entry.record.samples < 30);
  if (unexplored) return unexplored.model;
  return scored.reduce((best, entry) => (entry.record.rate > best.record.rate ? entry : best)).model;
});

const searcher = H.seat('searcher')
  .role(searcherRole)
  .model(haiku)
  .pool(researchPool)
  .output(
    z.object({
      sources: z.array(z.object({ url: z.string(), claim: z.string(), preprint: z.boolean() })),
    }),
  );

const synthesizer = H.seat('synthesizer')
  .role(synthesizerRole)
  .model(citationLeader, [opus, sonnet])
  .pool(researchPool)
  .output(z.object({ report: z.string(), findings: z.array(z.string()) }));

const citationCheck = H.command('citationCheck')
  .input(z.object({ report: z.string() }))
  .argv(input => ['./scripts/check-citations.sh', input.report])
  .runner(local.runner('local').slots(2));

const topicAttrs = z.object({ topic: z.string(), recurring: z.boolean() });

const Open = H.state('Open', 'pending');
const Delivered = H.terminal('Delivered', 'success');
const Parked = H.terminal('Parked', 'neutral');
const Cancelled = H.terminal('Cancelled', 'neutral');
const Failed = H.terminal('Failed', 'failure');

const Topic = H.kind('Topic')
  .attributes(topicAttrs)
  .states(Open, Delivered, Parked, Cancelled, Failed)
  .key(topic => topic.topic)
  .initial(Open);

const research = H.flow('research')
  .input(topicAttrs)
  .job('search', searcher.batch(), ctx =>
    Array.from({ length: 20 }, (_, index) => ({
      task: `Search angle ${index + 1} of 20 on "${ctx.unit.attributes.topic}" and extract sourced claims.`,
    })),
  )
  .exit('parked', ctx => ctx.steps.search.flatMap(result => result.sources).length < 8)
  .step(
    'synthesize',
    synthesizer,
    ctx => ({
      task: `Write a sourced report on "${ctx.unit.attributes.topic}" from these claims:\n${ctx.steps.search
        .flatMap(result => result.sources)
        .map(source => `${source.claim} (${source.url})`)
        .join('\n')}`,
    }),
    { afterCrash: 'askDriver' },
  )
  .step('cite', citationCheck, ctx => ({ report: ctx.steps.synthesize.report }), { afterCrash: 'rerun' })
  .exit('delivered');

const topicsDb = '.harness/topics.db';

const topics = H.lane('topics', Topic)
  .supply(H.operator)
  .supply(
    sqlite.scan('recurringTopics', {
      path: topicsDb,
      kind: 'Topic',
      schedule: H.clock('weekly').at('06:00', { on: 'mon', tz: 'Europe/Berlin' }),
    }),
    (stored, to) => {
      const topic = stored.attributes.topic;
      return stored.attributes.recurring === true && typeof topic === 'string'
        ? to.create({ topic, recurring: true })
        : to.skip();
    },
  )
  .store(sqlite.store({ path: topicsDb }))
  .handler(research, {
    ends: { parked: Parked, delivered: Delivered },
    retry: { maxAttempts: 2, backoff: 'exponential', initialDelayMs: 600000, exhausted: Failed },
    ceiling: { maxUsd: 3, onExceed: 'fail' },
  })
  .on(H.cancel, { enter: Cancelled });

const citationPass = H.metric('citationPass', H.when.step(topics, 'cite')).samples(event => [
  { hit: event.ok, by: { seat: synthesizer, model: event.invocations.synthesize?.model } },
]);

const deliveredCost = H.metric('deliveredCost', H.when.transition(topics, { to: Delivered })).amounts(event => [
  { amount: event.attempt?.costUsd ?? 0 },
]);

const topicSpend = H.metric('topicSpend', H.when.invocation({ lanes: [topics] })).amounts(event => [
  { amount: event.costUsd },
]);

const embedder = voyage.embedder('findings-embedder', { id: 'voyage-3', apiKey: H.env('VOYAGE_API_KEY') });

const findings = H.journal('findings', H.memory('findings', 'experience'))
  .store(pgvector.memoryStore({ url: H.env('FINDINGS_DATABASE_URL'), table: 'findings', embedder }))
  .recall({ by: 'similarity', limit: 10 })
  .readBy(synthesizerRole);

const sourceLessons = H.journal('sourceLessons', H.memory('sourceLessons', 'experience'))
  .store(jsonl.memoryStore({ path: 'memory/source-lessons.jsonl' }))
  .recall({ by: 'specificity', limit: 10 })
  .readBy(searcherRole, synthesizerRole)
  .recordedBy(synthesizerRole);

const findingCapture = H.trigger('findingCapture')
  .on(H.when.step(topics, 'cite', { if: event => event.ok }))
  .record(findings, event =>
    event.outputs.synthesize
      ? {
          text: `When researching ${event.unit.attributes.topic}, start from these findings, because a checked report established them: ${event.outputs.synthesize.findings.join('; ')}`,
          when: { kinds: [Topic], roles: [synthesizerRole] },
        }
      : undefined,
  );

const dailyBudgetUsd = 40;
const topicCeilingUsd = 3;

const scheduler = H.scheduler('research').admit(topics, ctx => {
  const delivered = ctx.metrics.total(deliveredCost, { window: { lastDays: 30 } });
  const projected = delivered.samples > 0 ? delivered.total / delivered.samples : topicCeilingUsd;
  const spentToday = ctx.metrics.total(topicSpend, { window: { calendar: 'day', tz: 'Europe/Berlin' } }).total;
  return spentToday + projected <= dailyBudgetUsd;
});

const operator = claudeCode.supervisor('researcher').client('research', {
  grants: [H.ops.workRead, H.ops.workCreate, H.ops.workCancel, H.ops.memoryRead, H.ops.memoryWrite, H.ops.telemetryRead],
});

export const researchPipeline = H.harness('research-pipeline')
  .ledger(sqlite.ledger({ path: '.harness/ledger.db' }))
  .lanes(topics)
  .journals(findings, sourceLessons)
  .triggers(findingCapture)
  .metrics(citationPass, deliveredCost, topicSpend)
  .scheduler(scheduler)
  .clients(operator)
  .observers(markdown.board({ path: 'BOARD.md' }), markdown.telemetry({ path: 'TELEMETRY.md' }));

void researchPipeline.start();
