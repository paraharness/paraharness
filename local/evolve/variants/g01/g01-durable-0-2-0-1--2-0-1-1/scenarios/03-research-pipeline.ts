import { H } from 'harness-dsl';
import type { MetricRef } from 'harness-dsl';
import { z } from 'zod';
import { anthropic } from 'harness-dsl/anthropic';
import { claudeCode } from 'harness-dsl/claude-code';
import { sqlite } from 'harness-dsl/sqlite';
import { jsonl } from 'harness-dsl/jsonl';
import { pgvector } from 'harness-dsl/pgvector';
import { voyage } from 'harness-dsl/voyage';
import { local } from 'harness-dsl/local';
import { markdown } from 'harness-dsl/markdown';

const TopicAttributes = z.object({
  title: z.string(),
  question: z.string(),
  tags: z.array(z.string()),
});

const Queued = H.state('Queued', 'pending');
const Searching = H.state('Searching', 'waiting');
const Synthesizing = H.state('Synthesizing', 'active');
const Checking = H.state('Checking', 'active');
const Delivered = H.terminal('Delivered', 'success');
const Parked = H.terminal('Parked', 'neutral');
const Withdrawn = H.terminal('Withdrawn', 'neutral');
const Unsourced = H.terminal('Unsourced', 'failure');

const Topic = H.kind('Topic')
  .attributes(TopicAttributes)
  .states(Queued, Searching, Synthesizing, Checking, Delivered, Parked, Withdrawn, Unsourced)
  .key(topic => topic.title)
  .initial(Queued);

const topicCeilingUsd = 3;
const dailyBudgetUsd = 40;
const minimumSources = 8;

const apiAccount = anthropic.account('research-api', { apiKey: H.env('ANTHROPIC_API_KEY') });
const pool = H.pool('research').accounts(apiAccount);
const haiku = anthropic.model('haiku', { id: 'claude-haiku-4-5' });
const opus = anthropic.model('opus', { id: 'claude-opus-4-1' });
const sonnet = anthropic.model('sonnet', { id: 'claude-sonnet-4-5' });

const searcherRole = H.role('searcher').intents('search', 'browse').instructions('Find sources for one angle and extract claims with URLs.');
const synthesizerRole = H.role('synthesizer').intents('read').instructions('Write a sourced report. Cite every claim by URL.');

const synthesizerModel = H.policy.model('synthesizer-model', [opus, sonnet], ctx => {
  const first = ctx.metrics.rate(citationPass, { seat: ctx.seat, model: opus, window: { lastDays: 30 } });
  const second = ctx.metrics.rate(citationPass, { seat: ctx.seat, model: sonnet, window: { lastDays: 30 } });
  if (first.samples < 15) return opus;
  if (second.samples < 15) return sonnet;
  return first.rate >= second.rate ? opus : sonnet;
});

const searcher = H.seat('searcher')
  .role(searcherRole)
  .model(haiku)
  .pool(pool)
  .output(z.object({ sources: z.array(z.object({ url: z.string(), claim: z.string() })) }));

const synthesizer = H.seat('synthesizer')
  .role(synthesizerRole)
  .model(synthesizerModel)
  .pool(pool)
  .output(z.object({ report: z.string(), keyFinding: z.string() }));

const checkCitations = H.command('check-citations')
  .input(z.object({ report: z.string() }))
  .argv(input => ['check-citations', '--report', input.report])
  .runner(local.runner('research-box'));

const research = H.flow('research')
  .input(TopicAttributes)
  .step('search', searcher.batch(), ctx =>
    Array.from({ length: 20 }, (_, index) => ({
      task: `Search angle ${index + 1} of 20 for "${ctx.unit.attributes.question}". Extract claims with their source URLs.`,
    })),
  )
  .exit('parked', ctx => ctx.steps.search.reduce((count, result) => count + result.sources.length, 0) < minimumSources)
  .step('synthesize', synthesizer, ctx => ({
    task: `Answer "${ctx.unit.attributes.question}" from these sources:\n${ctx.steps.search
      .map(result => result.sources.map(source => `${source.claim} (${source.url})`).join('\n'))
      .join('\n')}`,
  }))
  .step('citations', checkCitations, ctx => ({ report: ctx.steps.synthesize.report }))
  .exit('delivered');

const store = sqlite.store({ path: './.harness/topics.db' });

const topics = H.lane('topics', Topic)
  .supply(H.operator)
  .supply(
    sqlite.scan('recurring-topics', {
      path: './.harness/topics.db',
      kind: 'Topic',
      schedule: H.clock('weekly-reopen').at('06:00', { on: 'mon', tz: 'Europe/Berlin' }),
    }),
    (stored, to) => {
      const parsed = TopicAttributes.safeParse(stored.attributes);
      return parsed.success && parsed.data.tags.includes('recurring') && (stored.state === 'Delivered' || stored.state === 'Parked')
        ? to.create(parsed.data)
        : to.skip();
    },
  )
  .store(store)
  .handler(research, {
    exits: { parked: Parked, delivered: Delivered },
    during: { search: Searching, synthesize: Synthesizing, citations: Checking },
    cancelled: Withdrawn,
  })
  .retry({ maxAttempts: 2, backoff: 'fixed', initialDelayMs: 600_000, exhausted: Unsourced })
  .ceiling({ maxUsd: topicCeilingUsd, onExceed: 'fail' });

const citationPass: MetricRef<'rate', never> = H.metric('citation-pass', H.when.step(topics, 'citations')).samples(event => [
  { hit: event.ok, seat: event.seats.synthesize?.seat, model: event.seats.synthesize?.model },
]);

const deliveredCost = H.metric('delivered-attempt-cost', H.when.transition(topics, { to: Delivered })).amounts(event => [
  { amount: event.attempt?.costUsd ?? 0 },
]);

const researchSpend = H.metric('research-spend', H.when.invocation({ lanes: [topics] })).amounts(event => [
  { amount: event.costUsd, seat: event.seat, model: event.model },
]);

const findings = H.journal('report-findings', H.memory('finding', 'experience'))
  .store(
    pgvector.memoryStore({
      url: H.env('FINDINGS_DATABASE_URL'),
      table: 'findings',
      embedder: voyage.embedder('voyage', { id: 'voyage-3', apiKey: H.env('VOYAGE_API_KEY') }),
    }),
  )
  .recall({ by: 'similarity', limit: 10 })
  .readBy(synthesizerRole);

const sourceExperience = H.journal('source-experience', H.memory('source-lesson', 'experience'))
  .store(jsonl.memoryStore({ path: './memory/sources.jsonl' }))
  .recall({ by: 'specificity', limit: 8 })
  .readBy(searcherRole, synthesizerRole)
  .recordedBy(synthesizerRole);

const findingsFromDeliveredReports = H.trigger('findings-from-delivered-reports')
  .on(H.when.step(topics, 'citations', { if: event => event.ok }))
  .record(findings, event =>
    event.outputs.synthesize === undefined
      ? undefined
      : {
          text: `When researching "${event.unit.attributes.title}", start from the prior finding: ${event.outputs.synthesize.keyFinding}, because it passed the citation check`,
          when: { kinds: [Topic] },
        },
  );

const scheduler = H.scheduler('research').admit(topics, ctx => {
  const spent = ctx.metrics.total(researchSpend, { window: { calendar: 'day', tz: 'Europe/Berlin' } });
  const succeeded = ctx.metrics.total(deliveredCost, { window: { lastDays: 30 } });
  const projected = succeeded.samples > 0 ? succeeded.total / succeeded.samples : topicCeilingUsd;
  return spent.total + projected <= dailyBudgetUsd;
});

const operatorDesk = H.client('research-desk', {
  transport: claudeCode.mcp('research-mcp'),
  grants: [H.ops.workRead, H.ops.workCreate, H.ops.workCancel, H.ops.attemptsRecover, H.ops.memoryRead, H.ops.memoryCurate, H.ops.telemetryRead],
});

export const researchPipeline = H.harness('research-pipeline')
  .ledger(sqlite.ledger({ path: './.harness/research-ledger.db' }))
  .lanes(topics)
  .journals(findings, sourceExperience)
  .triggers(findingsFromDeliveredReports)
  .metrics(citationPass, deliveredCost, researchSpend)
  .scheduler(scheduler)
  .clients(operatorDesk)
  .observers(markdown.board({ path: './BOARD.md' }), markdown.telemetry({ path: './TELEMETRY.md' }));
