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

const topicSchema = z.object({ slug: z.string(), question: z.string(), recurring: z.boolean() });

const Queued = H.state('Queued', 'pending');
const Researching = H.state('Researching', 'active');
const Delivered = H.terminal('Delivered', 'success');
const Parked = H.terminal('Parked', 'neutral');
const Cancelled = H.terminal('Cancelled', 'neutral');
const Failed = H.terminal('Failed', 'failure');

const Topic = H.kind('Topic')
  .attributes(topicSchema)
  .states(Queued, Researching, Delivered, Parked, Cancelled, Failed)
  .key(a => a.slug);

const quota = sqlite.quota('research-accounts', { path: '.harness/quota.sqlite' });
const apiAccount = anthropic.account('anthropic-api', { apiKey: H.env('ANTHROPIC_API_KEY'), quota });
const haiku = anthropic.model('haiku', { id: 'claude-haiku-4-5' });
const opus = anthropic.model('opus', { id: 'claude-opus-4-1' });
const sonnet = anthropic.model('sonnet', { id: 'claude-sonnet-4-5' });
const pool = H.pool('research-pool').accounts(apiAccount);

const extractorRole = H.role('extractor').intents('search', 'browse').instructions('Find sources and extract claims with URLs.');
const synthesizerRole = H.role('synthesizer')
  .intents('read', 'record')
  .instructions('Write a sourced report; every claim cites a source.');

const findings = H.journal('prior-findings', H.memory('prior-findings', 'experience'))
  .store(
    pgvector.memoryStore({
      url: H.env('PGVECTOR_URL'),
      table: 'findings',
      embedder: voyage.embedder('voyage', { id: 'voyage-3', apiKey: H.env('VOYAGE_API_KEY') }),
    }),
  )
  .recall({ by: 'similarity', limit: 8 })
  .readBy(synthesizerRole)
  .recordedBy(synthesizerRole);

const sourceExperience = H.journal('source-experience', H.memory('source-experience', 'experience'))
  .store(jsonl.memoryStore({ path: '.harness/sources.jsonl' }))
  .recall({ by: 'specificity', limit: 10 })
  .readBy(extractorRole, synthesizerRole)
  .recordedBy(synthesizerRole);

const extractor = H.seat('extractor')
  .role(extractorRole)
  .model(haiku)
  .pool(pool)
  .output(z.object({ sources: z.array(z.object({ url: z.string(), claim: z.string() })) }));

const synthesizerModel = H.policy.model('synthesizer-model', [opus, sonnet], ctx => {
  const a = ctx.metrics.rate(citationPass, { by: { seat: ctx.seat, model: opus }, window: { lastDays: 30 } });
  const b = ctx.metrics.rate(citationPass, { by: { seat: ctx.seat, model: sonnet }, window: { lastDays: 30 } });
  if (a.samples < 30 || b.samples < 30) {
    return a.samples <= b.samples ? opus : sonnet;
  }
  return a.rate >= b.rate ? opus : sonnet;
});

const synthesizer = H.seat('synthesizer')
  .role(synthesizerRole)
  .model(synthesizerModel)
  .pool(pool)
  .output(z.object({ report: z.string(), citations: z.array(z.string()) }));

const localRunner = local.runner('local');

const planQueries = H.command('plan-queries')
  .input(z.object({ question: z.string(), count: z.number() }))
  .argv(i => ['./scripts/plan-queries', '--count', String(i.count), i.question])
  .output(z.object({ queries: z.array(z.string()) }))
  .runner(localRunner);

const citationCheck = H.command('citation-check')
  .input(z.object({ report: z.string(), citations: z.array(z.string()) }))
  .argv(i => ['./scripts/check-citations', '--report', i.report, ...i.citations])
  .runner(localRunner);

const research = H.flow('research')
  .input(topicSchema)
  .step('queries', planQueries, ctx => ({ question: ctx.unit.attributes.question, count: 20 }))
  .job('search', extractor.batch(), ctx =>
    ctx.steps.queries.queries.slice(0, 20).map(q => ({ task: `Search and extract for: ${q}` })),
  )
  .exit('notEnoughSources', ctx => ctx.steps.search.reduce((n, r) => n + r.sources.length, 0) < 5)
  .step('synthesize', synthesizer, ctx => ({
    task: `Question: ${ctx.unit.attributes.question}\n\nExtracted sources:\n${JSON.stringify(ctx.steps.search)}`,
  }))
  .step('citeCheck', citationCheck, ctx => ({
    report: ctx.steps.synthesize.report,
    citations: ctx.steps.synthesize.citations,
  }))
  .exit('delivered');

const topics = H.lane('topics', Topic)
  .supply(H.operator)
  .supply(
    sqlite.scan('recurring-topics', {
      path: '.harness/store.sqlite',
      kind: 'Topic',
      schedule: H.clock('weekly-recurring').at('06:00', { on: 'mon', tz: 'UTC' }),
    }),
    (stored, to) => {
      const question = stored.attributes['question'];
      return stored.attributes['recurring'] === true && typeof question === 'string'
        ? to.create({ slug: stored.key, question, recurring: true })
        : to.skip();
    },
  )
  .store(sqlite.store({ path: '.harness/store.sqlite' }))
  .handler(research, {
    exits: { notEnoughSources: Parked, delivered: Delivered },
    during: { queries: Researching, synthesize: Researching, citeCheck: Researching },
  })
  .retry({ maxAttempts: 2, backoff: 'exponential', initialDelayMs: 600_000, exhausted: Failed })
  .on(H.cancel, { enter: Cancelled })
  .ceiling({ maxUsd: 3, onExceed: 'fail' });

const citationPass = H.metric('citation-pass-rate', H.when.step(topics, 'citeCheck')).samples(e => [
  {
    hit: e.ok,
    by: { seat: e.invocations.synthesize?.seat, model: e.invocations.synthesize?.model },
  },
]);

const deliveredTopicCost = H.metric('delivered-topic-cost', H.when.transition(topics, Delivered)).amounts(e =>
  e.attempt === undefined ? [] : [{ amount: e.attempt.costUsd }],
);

const modelSpend = H.metric('model-spend', H.when.invocation(topics)).amounts(e => [{ amount: e.costUsd }]);

const scheduler = H.scheduler('research')
  .priority(topics)
  .wip(topics, 3)
  .admit(topics, ctx => {
    const delivered = ctx.metrics.total(deliveredTopicCost, { window: { lastDays: 30 } });
    const projectedUsd = delivered.samples > 0 ? delivered.total / delivered.samples : 3;
    const spentTodayUsd = ctx.metrics.total(modelSpend, { window: { calendar: 'day', tz: 'UTC' } }).total;
    return spentTodayUsd + projectedUsd <= 40;
  });

const operator = claudeCode.supervisor('research-lead').client('research-supervisor', {
  grants: [
    H.ops.workRead,
    H.ops.workCreate,
    H.ops.signal(H.cancel),
    H.ops.memoryRead,
    H.ops.memoryWrite,
    H.ops.telemetryRead,
  ],
});

export const researchPipeline = H.harness('research-pipeline')
  .ledger(sqlite.ledger({ path: '.harness/ledger.sqlite' }))
  .lanes(topics)
  .journals(findings, sourceExperience)
  .metrics(citationPass, deliveredTopicCost, modelSpend)
  .scheduler(scheduler)
  .clients(operator)
  .observers(markdown.board({ path: 'BOARD.md' }), markdown.telemetry({ path: 'TELEMETRY.md' }));
