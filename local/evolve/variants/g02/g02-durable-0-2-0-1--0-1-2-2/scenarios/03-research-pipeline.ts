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

const topicCeilingUsd = 3;
const dailyBudgetUsd = 40;

const TopicOpen = H.state('TopicOpen', 'pending');
const Delivered = H.terminal('Delivered', 'success');
const Parked = H.terminal('Parked', 'neutral');
const Cancelled = H.terminal('Cancelled', 'neutral');
const Unresolved = H.terminal('Unresolved', 'failure');

const topicAttrs = z.object({ title: z.string(), question: z.string(), recurring: z.boolean() });

const topicKind = H.kind('Topic')
  .attributes(topicAttrs)
  .states(TopicOpen, Delivered, Parked, Cancelled, Unresolved)
  .key(a => a.title)
  .initial(TopicOpen);

const quota = sqlite.quota('anthropic-quota', { path: '.harness/quota.sqlite' });
const apiAccount = anthropic.account('research-api', { apiKey: H.env('ANTHROPIC_API_KEY'), quota });
const researchPool = H.pool('research').accounts(apiAccount);

const haiku = anthropic.model('haiku', { id: 'claude-haiku-4-5' });
const opus = anthropic.model('opus', { id: 'claude-opus-4-1' });
const sonnet = anthropic.model('sonnet', { id: 'claude-sonnet-4-5' });

const extractorRole = H.role('extractor').intents('search', 'browse', 'read').instructions('Find sources for the query and extract their claims.');
const synthesizerRole = H.role('synthesizer').intents('read').instructions('Write a sourced report; cite every claim by URL.');

const extractor = H.seat('extractor')
  .role(extractorRole)
  .model(haiku)
  .pool(researchPool)
  .output(z.object({ sources: z.array(z.object({ url: z.string(), claim: z.string() })) }));

const synthesizerModel = H.policy.model('synthesizer-model', [opus, sonnet], ctx => {
  const window = { lastDays: 30 };
  const onOpus = ctx.metrics.rate(citationPass, { seat: ctx.seat, model: opus, window });
  const onSonnet = ctx.metrics.rate(citationPass, { seat: ctx.seat, model: sonnet, window });
  if (onOpus.samples < 20) return opus;
  if (onSonnet.samples < 20) return sonnet;
  return onOpus.rate >= onSonnet.rate ? opus : sonnet;
});

const synthesizer = H.seat('synthesizer')
  .role(synthesizerRole)
  .model(synthesizerModel)
  .pool(researchPool)
  .output(z.object({ report: z.string(), keyFinding: z.string() }));

const findings = H.journal('prior-findings', H.memory('prior-findings', 'experience'))
  .store(pgvector.memoryStore({
    url: H.env('FINDINGS_DATABASE_URL'),
    table: 'findings',
    embedder: voyage.embedder('voyage', { id: 'voyage-3', apiKey: H.env('VOYAGE_API_KEY') }),
  }))
  .recall({ by: 'similarity', limit: 6 })
  .readBy(synthesizerRole);

const sourceExperience = H.journal('source-experience', H.memory('source-experience', 'experience'))
  .store(jsonl.memoryStore({ path: '.harness/memory/sources.jsonl' }))
  .recall({ by: 'specificity', limit: 8 })
  .readBy(extractorRole, synthesizerRole);

const localRunner = local.runner('local');

const searchQueries = H.command('search-queries')
  .input(z.object({ question: z.string() }))
  .argv(i => ['./bin/search-queries', '--count', '20', i.question])
  .output(z.object({ queries: z.array(z.string()) }))
  .runner(localRunner);

const citationCheck = H.command('citation-check')
  .input(z.object({ report: z.string() }))
  .argv(i => ['./bin/check-citations', i.report])
  .runner(localRunner);

const research = H.flow('research')
  .input(topicAttrs)
  .step('queries', searchQueries, ctx => ({ question: ctx.unit.attributes.question }))
  .job('extract', H.batch(extractor), ctx =>
    ctx.steps.queries.queries.slice(0, 20).map(query => ({ task: `Search and extract sources for: ${query}` })))
  .exit('parked', ctx => ctx.steps.extract.reduce((count, result) => count + result.sources.length, 0) < 10)
  .step('synthesize', synthesizer, ctx => ({
    task: `Write a sourced report answering: ${ctx.unit.attributes.question}\n\nExtracted sources:\n${JSON.stringify(ctx.steps.extract)}`,
  }), { afterCrash: 'askDriver' })
  .step('cite', citationCheck, ctx => ({ report: ctx.steps.synthesize.report }))
  .exit('delivered');

const topics = H.lane('topics', topicKind)
  .supply(H.operator)
  .handler(research, { exits: { delivered: Delivered, parked: Parked } })
  .store(sqlite.store({ path: '.harness/topics.sqlite' }))
  .retry({ maxAttempts: 2, backoff: 'fixed', initialDelayMs: 600_000, exhausted: Unresolved })
  .on(H.cancel, { enter: Cancelled })
  .ceiling({ maxUsd: topicCeilingUsd, onExceed: 'fail' });

const citationPass = H.metric('citation-pass', H.when.step(topics, 'cite'))
  .samples(e => [{ hit: e.ok, seat: synthesizer, model: e.modelOf(synthesizer) }]);

const deliveredCost = H.metric('delivered-topic-cost', H.when.transition(topics, { to: Delivered }))
  .amounts(e => [{ amount: e.attempt?.costUsd ?? 0 }]);

const researchSpend = H.metric('research-spend', H.when.invocation({ lanes: [topics] }))
  .amounts(e => [{ amount: e.costUsd }]);

const reopenRecurring = H.trigger('reopen-recurring-topics')
  .on(H.when.sweep(topics, {
    every: H.clock('weekly-research').at('06:00', { on: 'mon', tz: 'UTC' }),
    in: [Delivered, Parked],
  }))
  .create(topics, e => e.unit.attributes.recurring ? e.unit.attributes : undefined);

const recordFindings = H.trigger('record-report-findings')
  .on(H.when.step(topics, 'synthesize'))
  .record(findings, e => e.output === undefined
    ? undefined
    : {
        text: `When researching a topic like "${e.unit.attributes.title}", start from the finding that ${e.output.keyFinding}, because a prior sourced report established it.`,
        when: { kinds: [topicKind] },
        status: 'candidate',
      });

const scheduler = H.scheduler('research')
  .standard(topics)
  .admit(topics, ctx => {
    const delivered = ctx.metrics.total(deliveredCost, { window: { lastDays: 30 } });
    const projected = delivered.samples === 0 ? topicCeilingUsd : delivered.total / delivered.samples;
    const spent = ctx.metrics.total(researchSpend, { window: { calendar: 'day', tz: 'UTC' } });
    return spent.total + projected <= dailyBudgetUsd;
  });

const researchDesk = claudeCode.supervisor('research-desk', {
  grants: [H.ops.workRead, H.ops.workCreate, H.ops.workCancel, H.ops.memoryRead, H.ops.telemetryRead],
});

export const harness = H.harness('research-pipeline')
  .ledger(sqlite.ledger({ path: '.harness/ledger.sqlite' }))
  .lanes(topics)
  .journals(findings, sourceExperience)
  .triggers(reopenRecurring, recordFindings)
  .metrics(citationPass, deliveredCost, researchSpend)
  .scheduler(scheduler)
  .clients(researchDesk)
  .observers(markdown.board({ path: 'BOARD.md' }), markdown.telemetry({ path: 'TELEMETRY.md' }));

void harness.start();
