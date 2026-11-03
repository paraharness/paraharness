import { z } from 'zod';
import { H } from 'harness-dsl';
import { sqlite } from 'harness-dsl/sqlite';
import { jsonl } from 'harness-dsl/jsonl';
import { pgvector } from 'harness-dsl/pgvector';
import { anthropic } from 'harness-dsl/anthropic';
import { claudeCode } from 'harness-dsl/claude-code';
import { local } from 'harness-dsl/local';
import { markdown } from 'harness-dsl/markdown';

const TopicSchema = z.object({
  title: z.string(),
  question: z.string(),
  tags: z.array(z.string()),
});

const Queued = H.state('Queued', 'pending');
const Searching = H.state('Searching', 'active');
const Synthesizing = H.state('Synthesizing', 'active');
const Checking = H.state('Checking', 'active');
const Delivered = H.terminal('Delivered', 'success');
const Parked = H.terminal('Parked', 'neutral');
const Cancelled = H.terminal('Cancelled', 'neutral');
const Failed = H.terminal('Failed', 'failure');

const Topic = H.kind('Topic')
  .attributes(TopicSchema)
  .states(Queued, Searching, Synthesizing, Checking, Delivered, Parked, Cancelled, Failed)
  .key(a => a.title)
  .initial(Queued)
  .onAttemptFailed(Failed)
  .onCancelled(Cancelled);

const researchAccount = anthropic.account('research-api', { apiKey: H.env('ANTHROPIC_API_KEY') });
const researchPool = H.pool('research').accounts(researchAccount);

const haiku = anthropic.model('haiku', { id: 'claude-haiku-4-5' });
const opus = anthropic.model('opus', { id: 'claude-opus-4-1' });
const sonnet = anthropic.model('sonnet', { id: 'claude-sonnet-4-5' });

const plannerRole = H.role('queryPlanner').instructions('Write twenty distinct search angles for the topic.');
const searcherRole = H.role('searcher').intents('search', 'browse').instructions('Search, read, and extract sourced claims.');
const synthesizerRole = H.role('synthesizer').instructions('Write a sourced report. Every claim cites a URL from the extracts.');

const synthesizerModel = H.policy.model('synthesizerModel', [opus, sonnet], ctx => {
  const window = { lastDays: 30 };
  const opusRecord = ctx.metrics.rate(citationPassRate, { group: opus.name, window });
  const sonnetRecord = ctx.metrics.rate(citationPassRate, { group: sonnet.name, window });
  if (opusRecord.samples < 15) return opus;
  if (sonnetRecord.samples < 15) return sonnet;
  return opusRecord.rate >= sonnetRecord.rate ? opus : sonnet;
});

const queryPlanner = H.agent('queryPlanner')
  .role(plannerRole)
  .model(haiku)
  .output(z.object({ queries: z.array(z.string()).length(20) }));

const searcher = H.agent('searcher')
  .role(searcherRole)
  .model(haiku)
  .output(z.object({
    sources: z.array(z.object({ url: z.string(), claim: z.string() })),
  }));

const synthesizer = H.agent('synthesizer')
  .role(synthesizerRole)
  .model(synthesizerModel)
  .output(z.object({ report: z.string(), findings: z.array(z.string()) }));

const citationCheck = H.command('citationCheck')
  .input(z.object({ report: z.string() }))
  .argv(i => ['citecheck', '--report-text', i.report])
  .runner(local.runner('local'));

const Finding = H.memory('priorFinding').trust('experience');
const SourceExperience = H.memory('sourceExperience').trust('experience');

const findingsJournal = H.journal('priorFindings', Finding)
  .store(pgvector.memoryStore({ url: H.env('FINDINGS_DATABASE_URL'), table: 'findings', embeddingModel: 'text-embedding-3-small' }))
  .recall(H.recall('bySimilarity', { by: 'similarity', limit: 10, minScore: 0.75 }))
  .readBy(synthesizerRole);

const sourceJournal = H.journal('sourceExperience', SourceExperience)
  .store(jsonl.memoryStore({ path: '.harness/memory/sources.jsonl' }))
  .recall(H.recall('bySpecificity', { by: 'specificity', limit: 8 }))
  .readBy(searcherRole, synthesizerRole);

const researchFlow = H.flow('research')
  .input(TopicSchema)
  .step('plan', queryPlanner, ctx => ({ task: `${ctx.unit.attributes.title}: ${ctx.unit.attributes.question}` }))
  .step('search', searcher.batch(), ctx => ctx.steps.plan.queries.map(query => ({
    task: `Search and extract sourced claims for: ${query}`,
  })))
  .exit('parked', ctx => ctx.steps.search.flatMap(r => r.sources).length < 5)
  .step('synthesize', synthesizer, ctx => ({
    task: `Answer "${ctx.unit.attributes.question}" from these extracts:\n${JSON.stringify(ctx.steps.search.flatMap(r => r.sources))}`,
    skills: ctx.unit.attributes.tags,
  }))
  .step('citationCheck', citationCheck, ctx => ({ report: ctx.steps.synthesize.report }), { afterCrash: 'rerun' })
  .exit('delivered');

const topicStorePath = '.harness/topics.sqlite';

const topics = H.lane('topics', Topic)
  .supply(H.operator)
  .supply(
    sqlite.scan('recurringTopics', {
      path: topicStorePath,
      kind: 'Topic',
      schedule: H.clock('weekly').weekly('mon', '06:00', { tz: 'UTC' }),
    }),
    (row, to) => {
      const parsed = TopicSchema.safeParse(row.attributes);
      return parsed.success && parsed.data.tags.includes('recurring') && (row.state === 'Delivered' || row.state === 'Parked')
        ? to.create(parsed.data)
        : to.skip();
    },
  )
  .store(sqlite.store({ path: topicStorePath }))
  .handler(researchFlow, {
    exits: { parked: Parked, delivered: Delivered },
    during: { plan: Searching, search: Searching, synthesize: Synthesizing, citationCheck: Checking },
  })
  .ceiling({ maxUsd: 3, onExceed: 'fail' });

const citationPassRate = H.metric('citationPassRate')
  .from(H.when.step(topics, 'citationCheck'))
  .samples(e => [{ group: e.models.synthesize ?? 'unknown', hit: e.ok }]);

const researchSpend = H.metric('researchSpend')
  .from(H.when.invocation({ lanes: [topics] }))
  .amounts(e => [{ group: 'all', amount: e.costUsd }]);

const findingsRemembered = H.trigger('findingsRemembered')
  .on(H.when.step(topics, 'synthesize'))
  .record(findingsJournal, e => e.output === undefined
    ? undefined
    : {
        body: {
          text: `When researching "${e.unit.attributes.title}", start from these findings, because the report of ${e.at.toISOString().slice(0, 10)} established them: ${e.output.findings.join('; ')}`,
        },
        when: { kinds: [Topic], skills: e.unit.attributes.tags },
      });

const dailyBudgetUsd = 40;
const topicCeilingUsd = 3;

const scheduler = H.scheduler('research')
  .admit(topics, ctx => {
    const spent = ctx.metrics.total(researchSpend, { group: 'all', window: { calendar: 'day', tz: 'UTC' } });
    const typical = ctx.metrics.meanCostUsd({ of: topics, verdict: 'success', window: { lastDays: 30 } });
    const projected = typical.samples === 0 ? topicCeilingUsd : typical.meanUsd;
    return spent.total + projected <= dailyBudgetUsd;
  });

const supervisor = claudeCode.supervisor('researchSupervisor', {
  grants: [H.ops.workRead, H.ops.workCreate, H.ops.workCancel, H.ops.memoryRead, H.ops.memoryWrite, H.ops.telemetryRead],
});

export const harness = H.harness('research-pipeline')
  .ledger(sqlite.ledger({ path: '.harness/ledger.sqlite' }))
  .pools(researchPool)
  .lanes(topics)
  .journals(findingsJournal, sourceJournal)
  .metrics(citationPassRate, researchSpend)
  .triggers(findingsRemembered)
  .scheduler(scheduler)
  .clients(supervisor)
  .observers(
    markdown.board({ path: '.harness/board.md' }),
    markdown.telemetry({ path: '.harness/telemetry.md' }),
  );

export const running = harness.start();
