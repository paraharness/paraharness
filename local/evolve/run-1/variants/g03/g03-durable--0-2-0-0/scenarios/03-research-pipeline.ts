import { H } from 'harness-dsl';
import { z } from 'zod';
import { sqlite } from 'harness-dsl/sqlite';
import { jsonl } from 'harness-dsl/jsonl';
import { pgvector } from 'harness-dsl/pgvector';
import { voyage } from 'harness-dsl/voyage';
import { claudeCode } from 'harness-dsl/claude-code';
import { anthropic } from 'harness-dsl/anthropic';
import { local } from 'harness-dsl/local';
import { markdown } from 'harness-dsl/markdown';

const Queued = H.state('Queued', 'pending');
const Searching = H.state('Searching', 'waiting');
const Synthesizing = H.state('Synthesizing', 'active');
const Checking = H.state('Checking', 'active');
const Delivered = H.terminal('Delivered', 'success');
const Parked = H.terminal('Parked', 'neutral');
const Cancelled = H.terminal('Cancelled', 'neutral');
const Failed = H.terminal('Failed', 'failure');

const topicSchema = z.object({
  title: z.string(),
  question: z.string(),
  tags: z.array(z.string()),
});

const Topic = H.kind('Topic')
  .attributes(topicSchema)
  .states(Queued, Searching, Synthesizing, Checking, Delivered, Parked, Cancelled, Failed)
  .key(a => a.title)
  .initial(Queued)
  .onCancelled(Cancelled);

const apiAccount = anthropic.account('research-api', { apiKey: H.env('ANTHROPIC_API_KEY') });
const pool = H.pool('research').accounts(apiAccount);

const haiku = anthropic.model('haiku', { id: 'claude-haiku-4-5' });
const opus = anthropic.model('opus', { id: 'claude-opus-4-1' });
const sonnet = anthropic.model('sonnet', { id: 'claude-sonnet-4-5' });

const citationPass = H.metric.rate('citationPass');
const dailySpend = H.metric.total('dailySpend');
const deliveredCost = H.metric.total('deliveredCost');

const synthesizerModel = H.policy.model('synthesizerModel', [opus, sonnet], ctx => {
  const first = ctx.metrics.rate(citationPass, { group: opus.name, window: { lastDays: 30 } });
  const second = ctx.metrics.rate(citationPass, { group: sonnet.name, window: { lastDays: 30 } });
  if (first.samples < 15 || second.samples < 15) {
    return first.samples <= second.samples ? opus : sonnet;
  }
  return first.rate >= second.rate ? opus : sonnet;
});

const searcherRole = H.role('searcher')
  .intents('search', 'browse', 'read')
  .instructions('Search for sources on one angle of the question and extract cited findings.');

const synthesizerRole = H.role('synthesizer')
  .intents('read', 'record')
  .instructions('Write a sourced report from the findings. Every claim cites a resolvable source.');

const searcher = H.agent('searcher')
  .role(searcherRole)
  .model(haiku)
  .pool(pool)
  .output(z.object({
    findings: z.array(z.object({ claim: z.string(), source: z.string() })),
  }));

const synthesizer = H.agent('synthesizer')
  .role(synthesizerRole)
  .model(synthesizerModel)
  .pool(pool)
  .output(z.object({
    report: z.string(),
    citations: z.array(z.string()),
    enoughSources: z.boolean(),
  }));

const embedder = voyage.embedder('voyage', { apiKey: H.env('VOYAGE_API_KEY'), id: 'voyage-3' });

const findings = H.journal('findings', H.memory('reportFindings', 'experience'))
  .store(pgvector.memoryStore({ url: H.env('FINDINGS_DATABASE_URL'), table: 'findings', embedder }))
  .recall({ by: 'similarity', limit: 8 })
  .readBy(synthesizerRole)
  .recordedBy(synthesizerRole);

const sourceExperience = H.journal('sourceExperience', H.memory('sourceExperience', 'experience'))
  .store(jsonl.memoryStore({ path: '.harness/sources.jsonl' }))
  .recall({ by: 'specificity', limit: 10 })
  .readBy(searcherRole, synthesizerRole)
  .recordedBy(synthesizerRole);

const citationCheck = H.command('citationCheck')
  .input(z.object({ citations: z.array(z.string()) }))
  .argv(i => ['check-citations', ...i.citations])
  .runner(local.runner('local'));

const researchFlow = H.flow('research')
  .input(topicSchema)
  .step('search', searcher.batch(), ctx => Array.from({ length: 20 }, (_, i) => ({
    task: `Angle ${i + 1} of 20 on "${ctx.unit.attributes.question}": find sources and extract findings with their URLs.`,
  })))
  .step('synthesize', synthesizer, ctx => ({
    task: `Write a report answering "${ctx.unit.attributes.question}" from these findings:\n${ctx.steps.search
      .flatMap(r => r.findings)
      .map(f => `- ${f.claim} (${f.source})`)
      .join('\n')}`,
  }))
  .exit('parked', ctx => !ctx.steps.synthesize.enoughSources)
  .step('citations', citationCheck, ctx => ({ citations: ctx.steps.synthesize.citations }))
  .exit('delivered');

const topics = H.lane('topics', Topic)
  .supply(H.operator)
  .supply(
    sqlite.scan('recurringTopics', {
      path: '.harness/store.db',
      kind: 'Topic',
      schedule: H.clock('weekly').at('06:00', { on: 'mon', tz: 'UTC' }),
    }),
    (stored, to) => {
      const parsed = topicSchema.safeParse(stored.attributes);
      return parsed.success && parsed.data.tags.includes('recurring') && (stored.state === 'Delivered' || stored.state === 'Parked')
        ? to.create(parsed.data)
        : to.skip();
    },
  )
  .store(sqlite.store({ path: '.harness/store.db' }))
  .handler(researchFlow, {
    exits: { parked: Parked, delivered: Delivered },
    during: { search: Searching, synthesize: Synthesizing, citations: Checking },
  })
  .retry({ maxAttempts: 2, initialDelayMs: 1800000, exhausted: Failed })
  .ceiling({ maxUsd: 3, onExceed: 'fail' });

const spendMeasure = H.measure(
  dailySpend,
  H.when.invocation({ lanes: [topics] }),
  e => [{ group: 'topics', amount: e.costUsd }],
);

const deliveredCostMeasure = H.measure(
  deliveredCost,
  H.when.transition(topics, { to: Delivered }),
  e => e.attempt === undefined ? [] : [{ group: 'topics', amount: e.attempt.costUsd }],
);

const citationMeasure = H.measure(
  citationPass,
  H.when.step(topics, 'citations'),
  e => [{ group: e.models.synthesize ?? 'unknown', hit: e.ok }],
);

const scheduler = H.scheduler('research')
  .priority(topics)
  .admit(topics, ctx => {
    const spent = ctx.metrics.total(dailySpend, { window: { calendar: 'day', tz: 'UTC' } });
    const delivered = ctx.metrics.total(deliveredCost, { window: { lastDays: 30 } });
    const projectedUsd = delivered.samples > 0 ? delivered.total / delivered.samples : 3;
    return spent.total + projectedUsd <= 40;
  });

const supervisor = claudeCode.supervisor('operator', {
  grants: [
    H.ops.workRead,
    H.ops.workCreate,
    H.ops.workCancel,
    H.ops.memoryRead,
    H.ops.memoryCurate,
    H.ops.telemetryRead,
  ],
});

export const research = H.harness('research')
  .ledger(sqlite.ledger({ path: '.harness/ledger.db' }))
  .lanes(topics)
  .journals(findings, sourceExperience)
  .measurements(spendMeasure, deliveredCostMeasure, citationMeasure)
  .scheduler(scheduler)
  .clients(supervisor)
  .observers(
    markdown.board({ path: '.harness/board.md' }),
    markdown.telemetry({ path: '.harness/telemetry.md' }),
  );

void research.start();
