import { z } from 'zod';
import { H, MetricRef } from 'harness-dsl';
import { sqlite } from 'harness-dsl/sqlite';
import { jsonl } from 'harness-dsl/jsonl';
import { pgvector } from 'harness-dsl/pgvector';
import { anthropic } from 'harness-dsl/anthropic';
import { local } from 'harness-dsl/local';
import { http } from 'harness-dsl/http';
import { markdown } from 'harness-dsl/markdown';

const apiAccount = anthropic.account('apiAccount', { apiKey: H.env('ANTHROPIC_API_KEY') });
const haiku = anthropic.model('haiku', { id: 'claude-haiku-4-5' });
const opus = anthropic.model('opus', { id: 'claude-opus-4-1' });
const sonnet = anthropic.model('sonnet', { id: 'claude-sonnet-4-5' });
const apiPool = H.pool('api').accounts(apiAccount).serves(haiku, opus, sonnet);

const searcherRole = H.role('searcher')
  .intents('search', 'browse')
  .instructions('Search for sources on the angle given and extract findings with their URLs.');
const synthesizerRole = H.role('synthesizer')
  .intents('read', 'record')
  .instructions('Write a sourced report. Every claim cites a URL from the gathered sources.');

const citationPass: MetricRef<'rate'> = H.metric('citationPass')
  .from(H.when.step(topicLane(), 'citations'))
  .samples(event => {
    const model = event.models.synthesize;
    return model === undefined ? [] : [{ group: model, hit: event.ok }];
  });

const synthesizerModel = H.policy.model('synthesizerModel', [opus, sonnet], ctx => {
  const window = { lastDays: 30 };
  const a = ctx.metrics.rate(citationPass, { group: opus.name, window });
  const b = ctx.metrics.rate(citationPass, { group: sonnet.name, window });
  if (a.samples < 20 || b.samples < 20) return a.samples <= b.samples ? opus : sonnet;
  return a.rate >= b.rate ? opus : sonnet;
});

const searcher = H.agent('searcher')
  .role(searcherRole)
  .model(haiku)
  .output(z.object({ sources: z.array(z.object({ url: z.string(), finding: z.string() })) }));

const synthesizer = H.agent('synthesizer')
  .role(synthesizerRole)
  .model(synthesizerModel)
  .output(z.object({ report: z.string(), findings: z.array(z.string()), citations: z.array(z.string()) }));

const Findings = H.memory('Findings').trust('experience');
const SourceExperience = H.memory('SourceExperience').trust('experience');

const findings = H.journal('findings', Findings)
  .store(pgvector.memoryStore({ url: H.env('RESEARCH_DB_URL'), table: 'findings', embeddingModel: 'text-embedding-3-small' }))
  .recall(H.recall('similarFindings', { by: 'similarity', limit: 8, minScore: 0.75 }))
  .readBy(synthesizerRole);

const sourceExperience = H.journal('sourceExperience', SourceExperience)
  .store(jsonl.memoryStore({ path: '.harness/source-experience.jsonl' }))
  .recall(H.recall('byScope', { by: 'specificity', limit: 10 }))
  .readBy(searcherRole, synthesizerRole)
  .recordedBy(synthesizerRole);

const Queued = H.state('Queued', 'pending');
const Searching = H.state('Searching', 'waiting');
const Synthesizing = H.state('Synthesizing', 'active');
const CheckingCitations = H.state('CheckingCitations', 'active');
const Delivered = H.terminal('Delivered', 'success');
const Parked = H.terminal('Parked', 'neutral');
const Cancelled = H.terminal('Cancelled', 'neutral');
const Failed = H.terminal('Failed', 'failure');

const topicSchema = z.object({ id: z.string(), question: z.string(), tags: z.array(z.string()) });

const Topic = H.kind('Topic')
  .attributes(topicSchema)
  .states(Queued, Searching, Synthesizing, CheckingCitations, Delivered, Parked, Cancelled, Failed)
  .key(a => a.id)
  .initial(Queued)
  .onAttemptFailed(Failed)
  .onCancelled(Cancelled);

const citationCheck = H.command('citationCheck')
  .input(z.object({ citations: z.array(z.string()) }))
  .argv(input => ['citecheck', ...input.citations])
  .runner(local.runner('local'));

const researchFlow = H.flow('research')
  .input(z.object({ question: z.string() }))
  .batch('search', searcher, ctx =>
    Array.from({ length: 20 }, (_, index) => ({
      task: `Search angle ${index + 1} of 20 for the question: ${ctx.unit.attributes.question}`,
    })),
  )
  .exit('insufficient', ctx => new Set(ctx.steps.search.flatMap(result => result.sources.map(s => s.url))).size < 5)
  .step('synthesize', synthesizer, ctx => ({
    task: `Answer: ${ctx.unit.attributes.question}\n\nSources:\n${ctx.steps.search
      .flatMap(result => result.sources)
      .map(s => `- ${s.finding} (${s.url})`)
      .join('\n')}`,
  }))
  .step('citations', citationCheck, ctx => ({ citations: ctx.steps.synthesize.citations }))
  .exit('delivered');

const researchStore = sqlite.store({ path: '.harness/topics.db' });

const topicsLane = H.lane('topics', Topic)
  .supply(H.operator)
  .supply(
    sqlite.scan('recurringTopics', {
      path: '.harness/topics.db',
      kind: 'Topic',
      schedule: H.clock('weeklyMonday').weekly('mon', '06:00', { tz: 'Europe/Berlin' }),
    }),
    (stored, to) => {
      const parsed = topicSchema.safeParse(stored.attributes);
      return parsed.success && parsed.data.tags.includes('recurring') ? to.create(parsed.data) : to.skip();
    },
  )
  .store(researchStore)
  .handler(researchFlow, {
    exits: { insufficient: Parked, delivered: Delivered },
    during: { search: Searching, synthesize: Synthesizing, citations: CheckingCitations },
  })
  .retry(H.retry({ maxAttempts: 2, backoff: 'fixed', initialDelayMs: 600000 }))
  .ceiling({ maxUsd: 3, onExceed: 'fail' });

function topicLane(): typeof topicsLane {
  return topicsLane;
}

const dailySpend = H.metric('dailySpend')
  .from(H.when.invocation())
  .amounts(event => [{ group: 'all', amount: event.costUsd }]);

const captureFindings = H.trigger('captureFindings')
  .on(H.when.step(topicsLane, 'citations', { if: event => event.ok }))
  .record(findings, event => {
    const synthesis = event.outputs.synthesize;
    if (synthesis === undefined) return undefined;
    return {
      body: {
        text: `when researching "${event.unit.attributes.question}", start from these findings: ${synthesis.findings.join('; ')}, because they passed the citation check`,
      },
      when: { kinds: [Topic] },
    };
  });

const scheduler = H.scheduler('researchScheduler')
  .priority(topicsLane)
  .admit(topicsLane, ctx => {
    const spent = ctx.metrics.total(dailySpend, { group: 'all', window: { calendar: 'day', tz: 'Europe/Berlin' } });
    const projected = ctx.metrics.meanCostUsd({ of: topicsLane, verdict: 'success', window: { lastDays: 30 } });
    const nextCost = projected.samples >= 5 ? projected.meanUsd : 3;
    return spent.total + nextCost <= 40;
  });

const operatorApi = http.controlApi('operatorApi', {
  port: H.slot.port(0),
  token: H.env('RESEARCH_API_TOKEN'),
  grants: [
    H.ops.workRead,
    H.ops.workCreate,
    H.ops.send(H.cancel, { lanes: [topicsLane] }),
    H.ops.memoryRead,
    H.ops.telemetryRead,
  ],
});

export const researchPipeline = H.harness('researchPipeline')
  .ledger(sqlite.ledger({ path: '.harness/ledger.db' }))
  .pools(apiPool)
  .lanes(topicsLane)
  .journals(findings, sourceExperience)
  .triggers(captureFindings)
  .metrics(citationPass, dailySpend)
  .scheduler(scheduler)
  .clients(operatorApi)
  .observers(markdown.board({ path: 'BOARD.md' }), markdown.telemetry({ path: 'TELEMETRY.md' }));
