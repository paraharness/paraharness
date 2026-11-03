import { z } from 'zod';
import { H } from 'harness-dsl';
import { sqlite } from 'harness-dsl/sqlite';
import { jsonl } from 'harness-dsl/jsonl';
import { pgvector } from 'harness-dsl/pgvector';
import { voyage } from 'harness-dsl/voyage';
import { anthropic } from 'harness-dsl/anthropic';
import { http } from 'harness-dsl/http';
import { markdown } from 'harness-dsl/markdown';

const topicAttrs = z.object({ title: z.string(), question: z.string(), tags: z.array(z.string()) });

const Open = H.state('open', 'pending');
const Delivered = H.terminal('delivered', 'success');
const Parked = H.terminal('parked', 'neutral');
const Withdrawn = H.terminal('withdrawn', 'neutral');
const Unresolved = H.terminal('unresolved', 'failure');
const topicKind = H.kind('Topic')
  .attributes(topicAttrs)
  .states(Open, Delivered, Parked, Withdrawn, Unresolved)
  .key(a => a.title)
  .initial(Open);

const quota = sqlite.quota('research-quota', { path: '.harness/quota.db' });
const researchAccount = anthropic.account('research-api', { apiKey: H.env('ANTHROPIC_API_KEY'), quota });
const researchPool = H.pool('research').accounts(researchAccount);
const haiku = anthropic.model('haiku', { id: 'claude-haiku-4-5' });
const opus = anthropic.model('opus', { id: 'claude-opus-4-1' });
const sonnet = anthropic.model('sonnet', { id: 'claude-sonnet-4-5' });

const searcherRole = H.role('searcher').intents('search', 'browse').instructions('Find sources and extract claims with their URLs.');
const synthesizerRole = H.role('synthesizer').intents('read', 'record').instructions('Write a sourced report; record durable findings.');

const findings = H.journal('prior-findings', H.memory('report-finding', 'experience'))
  .store(pgvector.memoryStore({
    url: H.env('PGVECTOR_URL'),
    table: 'findings',
    embedder: voyage.embedder('voyage', { id: 'voyage-3', apiKey: H.env('VOYAGE_API_KEY') }),
  }))
  .recall({ by: 'similarity', limit: 6 })
  .readBy(synthesizerRole)
  .recordedBy(synthesizerRole);

const sourceLessons = H.journal('source-lessons', H.memory('source-experience', 'experience'))
  .store(jsonl.memoryStore({ path: '.harness/source-lessons.jsonl' }))
  .recall({ by: 'specificity', limit: 8 })
  .readBy(searcherRole, synthesizerRole)
  .recordedBy(synthesizerRole);

const searcher = H.seat('searcher')
  .role(searcherRole)
  .model(haiku)
  .pool(researchPool)
  .output(z.object({ sources: z.array(z.object({ url: z.string(), claim: z.string() })) }));

const searchBatch = H.batch(searcher);

const synthesizerModel = H.policy.model('synthesizer-model', [opus, sonnet], ctx => {
  const opusRate = ctx.metrics.rate(citationPass, { seat: ctx.seat, model: opus, window: { lastDays: 30 } });
  const sonnetRate = ctx.metrics.rate(citationPass, { seat: ctx.seat, model: sonnet, window: { lastDays: 30 } });
  if (opusRate.samples < 25 || sonnetRate.samples < 25) return opusRate.samples <= sonnetRate.samples ? opus : sonnet;
  return sonnetRate.rate >= opusRate.rate ? sonnet : opus;
});

const synthesizer = H.seat('synthesizer')
  .role(synthesizerRole)
  .model(synthesizerModel)
  .pool(researchPool)
  .output(z.object({ report: z.string(), citations: z.array(z.string()) }));

const planQueries = H.command('plan-queries')
  .input(topicAttrs)
  .argv(i => ['./bin/plan-queries', '--count', '20', i.question])
  .output(z.object({ queries: z.array(z.string()) }));

const checkCitations = H.command('check-citations')
  .input(z.object({ citations: z.array(z.string()) }))
  .argv(i => ['./bin/check-citations', ...i.citations]);

const research = H.flow('research')
  .input(topicAttrs)
  .step('plan', planQueries, ctx => ctx.unit.attributes)
  .job('search', searchBatch, ctx =>
    ctx.steps.plan.queries.map(query => ({ task: `Search and extract sourced claims for: ${query}` })))
  .exit('parked', ctx => ctx.steps.search.flatMap(result => result.sources).length < 5)
  .step('synthesize', synthesizer, ctx => ({
    task: [
      `Write a sourced report answering: ${ctx.unit.attributes.question}`,
      ...ctx.steps.search.flatMap(result => result.sources).map(source => `- ${source.url}: ${source.claim}`),
    ].join('\n'),
  }))
  .step('check', checkCitations, ctx => ({ citations: ctx.steps.synthesize.citations }))
  .exit('delivered');

const topicLane = H.lane('topics', topicKind)
  .supply(H.operator)
  .handler(research, { exits: { parked: Parked, delivered: Delivered } })
  .store(sqlite.store({ path: '.harness/topics.db' }))
  .retry({ maxAttempts: 2, backoff: 'fixed', initialDelayMs: 600000, exhausted: Unresolved })
  .ceiling({ maxUsd: 3, onExceed: 'fail' })
  .on(H.cancel, { enter: Withdrawn });

const citationPass = H.metric('citation-pass', H.when.step(topicLane, 'check'))
  .samples(e => [{ hit: e.ok, seat: synthesizer, model: e.modelOf(synthesizer) }]);

const deliveredCost = H.metric('delivered-attempt-cost', H.when.transition(topicLane, { to: Delivered }))
  .amounts(e => [{ amount: e.attempt?.costUsd ?? 0 }]);

const modelSpend = H.metric('model-spend', H.when.invocation({ lanes: [topicLane] }))
  .amounts(e => [{ amount: e.costUsd }]);

const reopenRecurring = H.trigger('reopen-recurring-topics')
  .on(H.when.sweep(topicLane, { every: H.clock('weekly').at('06:00', { on: 'mon', tz: 'UTC' }), in: [Delivered, Parked] }))
  .create(topicLane, e => (e.unit.attributes.tags.includes('recurring') ? e.unit.attributes : undefined));

const scheduler = H.scheduler('research')
  .standard(topicLane)
  .wip(topicLane, 3)
  .admit(topicLane, ctx => {
    const spentToday = ctx.metrics.total(modelSpend, { window: { calendar: 'day', tz: 'UTC' } });
    const delivered = ctx.metrics.total(deliveredCost, { window: { lastDays: 30 } });
    const projectedUsd = delivered.samples === 0 ? 3 : delivered.total / delivered.samples;
    return spentToday.total + projectedUsd <= 40;
  });

const operatorApi = http.controlApi('operator', {
  port: H.slot.port(0),
  token: H.env('RESEARCH_API_TOKEN'),
  grants: [H.ops.workCreate, H.ops.workCancel, H.ops.workRead, H.ops.memoryRead, H.ops.telemetryRead],
});

export default H.harness('research-pipeline')
  .ledger(sqlite.ledger({ path: '.harness/ledger.db' }))
  .lanes(topicLane)
  .journals(findings, sourceLessons)
  .triggers(reopenRecurring)
  .metrics(citationPass, deliveredCost, modelSpend)
  .scheduler(scheduler)
  .clients(operatorApi)
  .observers(markdown.board({ path: 'BOARD.md' }), markdown.telemetry({ path: 'TELEMETRY.md' }));
