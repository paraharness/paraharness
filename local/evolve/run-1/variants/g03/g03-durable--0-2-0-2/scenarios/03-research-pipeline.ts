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

const topicCeilingUsd = 3;
const dailyBudgetUsd = 40;
const searchFanOut = 20;
const minimumSources = 5;

const topicSchema = z.object({ title: z.string(), question: z.string(), tags: z.array(z.string()) });

const Queued = H.state('Queued', 'pending');
const Gathering = H.state('Gathering', 'waiting');
const Synthesizing = H.state('Synthesizing', 'active');
const CheckingCitations = H.state('CheckingCitations', 'active');
const Delivered = H.terminal('Delivered', 'success');
const Parked = H.terminal('Parked', 'neutral');
const Cancelled = H.terminal('Cancelled', 'neutral');
const Failed = H.terminal('Failed', 'failure');

const Topic = H.kind('Topic')
  .attributes(topicSchema)
  .states(Queued, Gathering, Synthesizing, CheckingCitations, Delivered, Parked, Cancelled, Failed)
  .key(attrs => attrs.title)
  .initial(Queued)
  .onAttemptFailed(Failed)
  .onCancelled(Cancelled);

const apiAccount = anthropic.account('anthropic-api', { apiKey: H.env('ANTHROPIC_API_KEY') });
const researchPool = H.pool('research-pool').accounts(apiAccount);

const cheapModel = anthropic.model('haiku', { id: 'claude-haiku-4-5' });
const opus = anthropic.model('opus', { id: 'claude-opus-4-1' });
const sonnet = anthropic.model('sonnet', { id: 'claude-sonnet-4-5' });

const searcherRole = H.role('searcher').intents('search', 'browse').instructions('Search for sources on one angle and extract claims with URLs.');
const synthesizerRole = H.role('synthesizer').intents('read', 'record').instructions('Write a sourced report. Cite every claim.');

const searchAngle = H.skill('search-angle');

const synthesizerModel = H.policy.model('synthesizer-model', [opus, sonnet], ctx => {
  const opusRecord = ctx.metrics.rate(citationPass, { group: opus.name, window: { lastDays: 30 } });
  const sonnetRecord = ctx.metrics.rate(citationPass, { group: sonnet.name, window: { lastDays: 30 } });
  if (opusRecord.samples < 15 || sonnetRecord.samples < 15) {
    return opusRecord.samples <= sonnetRecord.samples ? opus : sonnet;
  }
  return opusRecord.rate >= sonnetRecord.rate ? opus : sonnet;
});

const searcher = H.agent('searcher')
  .role(searcherRole)
  .model(cheapModel)
  .pool(researchPool)
  .output(z.object({ sources: z.array(z.object({ url: z.string(), claim: z.string() })) }));

const synthesizer = H.agent('synthesizer')
  .role(synthesizerRole)
  .model(synthesizerModel)
  .pool(researchPool)
  .output(z.object({ report: z.string(), headline: z.string(), citations: z.array(z.string()) }));

const citationCheck = H.command('citation-check')
  .input(z.object({ citations: z.array(z.string()) }))
  .argv(input => ['./scripts/check-citations.sh', ...input.citations])
  .runner(local.runner('local'));

const findings = H.corpus('report-findings', H.memory('finding', 'reference'))
  .store(pgvector.memoryStore({
    url: H.env('FINDINGS_DATABASE_URL'),
    table: 'findings',
    embedder: voyage.embedder('findings-embedder', { id: 'voyage-3', apiKey: H.env('VOYAGE_API_KEY') }),
  }))
  .recall({ by: 'similarity', limit: 10 })
  .readBy(synthesizerRole);

const sourceExperience = H.corpus('source-experience', H.memory('source-experience', 'experience'))
  .store(jsonl.memoryStore({ path: './.harness/memory/sources.jsonl' }))
  .recall({ by: 'specificity', limit: 8 })
  .readBy(searcherRole, synthesizerRole)
  .recordedBy(synthesizerRole);

const researchFlow = H.flow('research')
  .input(topicSchema)
  .batch('search', searcher, ctx =>
    Array.from({ length: searchFanOut }, (_unused, index) => ({
      task: `Angle ${index + 1} of ${searchFanOut} on: ${ctx.unit.attributes.question}`,
      skills: [searchAngle.of(String(index + 1))],
    })),
  )
  .exit('parked', ctx => ctx.steps.search.reduce((count, result) => count + result.sources.length, 0) < minimumSources)
  .step('synthesize', synthesizer, ctx => ({
    task: `Question: ${ctx.unit.attributes.question}\n\nGathered sources:\n${JSON.stringify(ctx.steps.search)}`,
  }))
  .step('citations', citationCheck, ctx => ({ citations: ctx.steps.synthesize.citations }))
  .exit('delivered');

const store = sqlite.store({ path: './.harness/topics.db' });

const topics = H.lane('topics', Topic)
  .supply(H.operator)
  .supply(
    sqlite.scan('recurring-topics', {
      path: './.harness/topics.db',
      kind: 'Topic',
      schedule: H.clock('weekly').at('06:00', { on: 'mon', tz: 'UTC' }),
    }),
    (stored, to) => {
      const parsed = topicSchema.safeParse(stored.attributes);
      const reopenable = stored.state === 'Delivered' || stored.state === 'Parked';
      return parsed.success && reopenable && parsed.data.tags.includes('recurring') ? to.create(parsed.data) : to.skip();
    },
  )
  .store(store)
  .handler(researchFlow, {
    exits: { parked: Parked, delivered: Delivered },
    during: { search: Gathering, synthesize: Synthesizing, citations: CheckingCitations },
  })
  .ceiling({ maxUsd: topicCeilingUsd, onExceed: 'fail' })
  .retry({ maxAttempts: 2, backoff: 'fixed', initialDelayMs: 600000 });

const citationPass: MetricRef<'rate'> = H.metric('citation-pass-rate', H.when.step(topics, 'citations'))
  .samples(event => [{ group: event.models.synthesize ?? 'unknown-model', hit: event.ok }]);

const topicSpend = H.metric('topic-spend', H.when.invocation({ lanes: [topics] }))
  .amounts(event => [{ group: 'topics', amount: event.costUsd }]);

const deliveredAttemptCost = H.metric('delivered-attempt-cost', H.when.transition(topics, { to: Delivered }))
  .amounts(event => (event.attempt === undefined ? [] : [{ group: 'topics', amount: event.attempt.costUsd }]));

const recordFindings = H.trigger('delivered-report-becomes-finding')
  .on(H.when.step(topics, 'citations', { if: event => event.ok }))
  .record(findings, event => {
    const synthesis = event.outputs.synthesize;
    if (synthesis === undefined) return undefined;
    return {
      text: `When researching questions like "${event.unit.attributes.question}", start from the established finding: ${synthesis.headline}`,
      status: 'active',
      when: { kinds: [Topic] },
    };
  });

const scheduler = H.scheduler('research')
  .priority(topics)
  .admit(topics, ctx => {
    const spentToday = ctx.metrics.total(topicSpend, { group: 'topics', window: { calendar: 'day', tz: 'UTC' } });
    const delivered = ctx.metrics.total(deliveredAttemptCost, { group: 'topics', window: { lastDays: 30 } });
    const projectedUsd = delivered.samples === 0 ? topicCeilingUsd : delivered.total / delivered.samples;
    return spentToday.total + projectedUsd <= dailyBudgetUsd;
  });

const supervisor = claudeCode.supervisor('research-supervisor', {
  grants: [H.ops.workRead, H.ops.workCreate, H.ops.workCancel, H.ops.memoryRead, H.ops.memoryCurate, H.ops.telemetryRead],
});

export const researchPipeline = H.harness('research-pipeline')
  .ledger(sqlite.ledger({ path: './.harness/ledger.db' }))
  .lanes(topics)
  .corpora(findings, sourceExperience)
  .triggers(recordFindings)
  .metrics(citationPass, topicSpend, deliveredAttemptCost)
  .scheduler(scheduler)
  .clients(supervisor)
  .observers(
    markdown.board({ path: './.harness/board.md' }),
    markdown.telemetry({ path: './.harness/telemetry.md' }),
  );
