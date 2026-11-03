import { z } from 'zod';
import { H, MetricRef, Model } from 'harness-dsl';
import { anthropic } from 'harness-dsl/anthropic';
import { sqlite } from 'harness-dsl/sqlite';
import { jsonl } from 'harness-dsl/jsonl';
import { pgvector } from 'harness-dsl/pgvector';
import { voyage } from 'harness-dsl/voyage';
import { local } from 'harness-dsl/local';
import { claudeCode } from 'harness-dsl/claude-code';
import { markdown } from 'harness-dsl/markdown';

const topicAttrs = z.object({ topic: z.string(), tags: z.array(z.string()) });

const queued = H.state('Queued', 'pending');
const gathering = H.state('Gathering', 'waiting');
const researching = H.state('Researching', 'active');
const delivered = H.terminal('Delivered', 'success');
const parked = H.terminal('Parked', 'neutral');
const cancelled = H.terminal('Cancelled', 'neutral');
const abandoned = H.terminal('Abandoned', 'failure');

const topic = H.kind('Topic')
  .attributes(topicAttrs)
  .states(queued, gathering, researching, delivered, parked, cancelled, abandoned)
  .key(a => a.topic)
  .initial(queued);

const quota = sqlite.quota('research-quota', { path: '.harness/quota.db' });
const api = anthropic.account('anthropic-api', { apiKey: H.env('ANTHROPIC_API_KEY'), quota });
const pool = H.pool('research').accounts(api);

const haiku = anthropic.model('haiku', { id: 'claude-haiku-4-5' });
const opus = anthropic.model('opus', { id: 'claude-opus-4-1' });
const sonnet = anthropic.model('sonnet', { id: 'claude-sonnet-4-5' });

const extractorRole = H.role('extractor').intents('search', 'browse').instructions('Search one angle of the topic and extract sourced claims.');
const synthesizerRole = H.role('synthesizer').intents('read', 'record').instructions('Write a sourced report. Every claim carries a resolvable citation.');

const findings = H.journal('prior-findings', H.memory('report-finding', 'experience'))
  .store(
    pgvector.memoryStore({
      url: H.env('FINDINGS_DATABASE_URL'),
      table: 'findings',
      embedder: voyage.embedder('voyage', { id: 'voyage-3', apiKey: H.env('VOYAGE_API_KEY') }),
    }),
  )
  .recall({ by: 'similarity', limit: 12 })
  .readBy(synthesizerRole)
  .recordedBy(synthesizerRole);

const sourceLessons = H.journal('source-lessons', H.memory('source-lessons', 'experience'))
  .store(jsonl.memoryStore({ path: 'memory/sources.jsonl' }))
  .recall({ by: 'specificity', limit: 8 })
  .readBy(extractorRole, synthesizerRole)
  .recordedBy(synthesizerRole);

const extractor = H.seat('extractor')
  .role(extractorRole)
  .model(haiku)
  .pool(pool)
  .output(z.object({ sources: z.array(z.object({ url: z.string(), claim: z.string() })) }));

const synthesizerModel = H.policy.model('synthesizer-by-citation-pass', [opus, sonnet], ctx => {
  const read = (model: Model) =>
    ctx.metrics.rate(citationPass, { by: { seat: ctx.seat, model }, window: { lastDays: 30 } });
  const forOpus = read(opus);
  const forSonnet = read(sonnet);
  if (forOpus.samples < 25) return opus;
  if (forSonnet.samples < 25) return sonnet;
  return forOpus.rate >= forSonnet.rate ? opus : sonnet;
});

const synthesizer = H.seat('synthesizer').role(synthesizerRole).model(synthesizerModel).pool(pool);

const citationCheck = H.command('citation-check')
  .input(z.object({ report: z.string() }))
  .argv(i => ['./bin/check-citations', '--report', i.report])
  .runner(local.runner('local'));

const searchAngles = (subject: string) =>
  Array.from({ length: 20 }, (_, i) => ({ task: `Search angle ${i + 1} of 20 on: ${subject}`, skills: ['search'] }));

const research = H.flow('research')
  .input(topicAttrs)
  .job('search', extractor.batch({ pollEveryMinutes: 10 }), ctx => searchAngles(ctx.unit.attributes.topic))
  .exit('parked', ctx => ctx.steps.search.flatMap(r => r.sources).length < 5)
  .step('synthesize', synthesizer, ctx => ({
    task: `Write a sourced report on ${ctx.unit.attributes.topic} from these extracts:\n${JSON.stringify(ctx.steps.search)}`,
    skills: ['synthesis'],
  }))
  .step('cite-check', citationCheck, ctx => ({ report: ctx.steps.synthesize }))
  .exit('delivered');

const store = sqlite.store({ path: '.harness/topics.db' });

const topics = H.lane('topics', topic)
  .supply(H.operator)
  .supply(
    sqlite.scan('recurring-topics', {
      path: '.harness/topics.db',
      kind: 'Topic',
      schedule: H.clock('weekly').at('06:00', { on: 'mon', tz: 'UTC' }),
    }),
    (stored, to) => {
      const parsed = topicAttrs.safeParse(stored.attributes);
      return parsed.success && parsed.data.tags.includes('recurring') ? to.create(parsed.data) : to.skip();
    },
  )
  .store(store)
  .handler(research, {
    exits: { parked, delivered },
    during: { search: gathering, synthesize: researching, 'cite-check': researching },
  })
  .retry({ maxAttempts: 2, backoff: 'exponential', initialDelayMs: 600000, exhausted: abandoned })
  .ceiling({ maxUsd: 3, onExceed: 'fail' })
  .on(H.cancel, { enter: cancelled });

const citationPass: MetricRef<'rate'> = H.metric('citation-check-pass', H.when.step(topics, 'cite-check')).samples(e => [
  { hit: e.ok, by: { seat: e.invocations.synthesize?.seat, model: e.invocations.synthesize?.model } },
]);

const deliveredCost = H.metric('delivered-attempt-cost', H.when.transition(topics, { to: delivered })).amounts(e =>
  e.attempt ? [{ amount: e.attempt.costUsd }] : [],
);

const modelSpend = H.metric('model-spend', H.when.invocation({ lanes: [topics] })).amounts(e => [{ amount: e.costUsd }]);

const scheduler = H.scheduler('research').admit(topics, ctx => {
  const won = ctx.metrics.total(deliveredCost, { window: { lastDays: 30 } });
  const projectedUsd = won.samples === 0 ? 3 : won.total / won.samples;
  const spentToday = ctx.metrics.total(modelSpend, { window: { calendar: 'day', tz: 'UTC' } });
  return spentToday.total + projectedUsd <= 40;
});

export const researchPipeline = H.harness('research-pipeline')
  .ledger(sqlite.ledger({ path: '.harness/research.db' }))
  .lanes(topics)
  .journals(findings, sourceLessons)
  .metrics(citationPass, deliveredCost, modelSpend)
  .scheduler(scheduler)
  .clients(
    claudeCode.supervisor('research-lead').client('research-console', {
      grants: [H.ops.workRead, H.ops.workCreate, H.ops.workCancel, H.ops.memoryRead, H.ops.memoryCurate, H.ops.telemetryRead],
    }),
  )
  .observers(markdown.board({ path: 'BOARD.md' }), markdown.telemetry({ path: 'TELEMETRY.md' }));

void researchPipeline.start();
