import { z } from 'zod';
import { H, PolicyCtx, Model } from 'harness-dsl';
import { anthropic } from 'harness-dsl/anthropic';
import { claudeCode } from 'harness-dsl/claude-code';
import { local } from 'harness-dsl/local';
import { sqlite } from 'harness-dsl/sqlite';
import { jsonl } from 'harness-dsl/jsonl';
import { pgvector } from 'harness-dsl/pgvector';
import { markdown } from 'harness-dsl/markdown';

const topic = z.object({
  topicId: z.string(),
  question: z.string(),
  tags: z.array(z.string()),
});

const Queued = H.state('Queued', 'pending');
const Searching = H.state('Searching', 'active');
const Synthesizing = H.state('Synthesizing', 'active');
const Checking = H.state('Checking', 'active');
const Delivered = H.state('Delivered', 'succeeded');
const Parked = H.state('Parked', 'ended');
const Failed = H.state('Failed', 'failed');
const Cancelled = H.state('Cancelled', 'cancelled');

const Topic = H.kind('Topic')
  .attributes(topic)
  .states(Queued, Searching, Synthesizing, Checking, Delivered, Parked, Failed, Cancelled)
  .key(a => a.topicId);

const reopen = H.signal('reopen');

const apiAccount = anthropic.account('anthropic-api', { apiKey: H.env('ANTHROPIC_API_KEY') });
const pool = H.pool('api-pool').accounts(apiAccount);
const haiku = anthropic.model('haiku', { id: 'claude-haiku-4-5', pool });
const opus = anthropic.model('opus', { id: 'claude-opus-4-1', pool });
const sonnet = anthropic.model('sonnet', { id: 'claude-sonnet-4-5', pool });

function chooseSynthesizer(ctx: PolicyCtx): Model {
  const first = ctx.metrics.rate(citationPass, { group: opus.name, windowDays: 30 });
  const second = ctx.metrics.rate(citationPass, { group: sonnet.name, windowDays: 30 });
  if (first.samples < 15) return opus;
  if (second.samples < 15) return sonnet;
  return first.rate >= second.rate ? opus : sonnet;
}

const searcherRole = H.role('searcher').intents('search', 'browse').instructions('Find sources and extract sourced claims.');
const synthesizerRole = H.role('synthesizer')
  .intents('record')
  .instructions('Write a report in which every claim cites a source.');

const searchAgent = H.agent('search-agent')
  .role(searcherRole)
  .model(haiku)
  .budgetTokens(20000)
  .output(z.object({ sources: z.array(z.object({ url: z.string(), claim: z.string() })) }));

const synthesizeAgent = H.agent('synthesize-agent')
  .role(synthesizerRole)
  .model(H.policy.model('synthesizer-model', [opus, sonnet], chooseSynthesizer))
  .budgetTokens(120000)
  .output(z.object({ report: z.string(), citations: z.array(z.string()) }));

const localRunner = local.runner('local').slots(2);

const checkCitations = H.command('check-citations')
  .input(z.object({ citations: z.array(z.string()) }))
  .argv(i => ['./bin/check-citations', ...i.citations])
  .runner(localRunner);

const publishReport = H.command('publish-report')
  .input(z.object({ topicId: z.string(), report: z.string() }))
  .argv(i => ['./bin/publish-report', i.topicId, '--body', i.report])
  .output(z.object({ url: z.string(), headline: z.string() }))
  .runner(localRunner);

const researchFlow = H.flow('research')
  .input(topic)
  .step('search', searchAgent.batch(), ctx =>
    Array.from({ length: 20 }, (_, index) => ({
      task: `Search angle ${index + 1} of 20 for: ${ctx.unit.attributes.question}. Extract claims with source URLs.`,
    })),
  )
  .exit('parked', ctx => ctx.steps.search.reduce((count, result) => count + result.sources.length, 0) < 5)
  .step('synthesize', synthesizeAgent, ctx => ({
    task: `Answer: ${ctx.unit.attributes.question}\n\nSources:\n${JSON.stringify(ctx.steps.search)}`,
    skills: ctx.unit.attributes.tags,
  }))
  .step('citations', checkCitations, ctx => ({ citations: ctx.steps.synthesize.citations }))
  .step('publish', publishReport, ctx => ({ topicId: ctx.unit.attributes.topicId, report: ctx.steps.synthesize.report }))
  .exit('delivered');

const topicLane = H.lane('topics', Topic)
  .supply(H.operator)
  .supply(H.clock('weekly-recurring').weekly('mon', '06:00', { tz: 'UTC' }), (tick, to) =>
    to.signal(reopen, unit => unit.attributes.tags.includes('recurring'), {}),
  )
  .store(sqlite.store({ path: '.harness/topics.db' }))
  .handler(researchFlow, {
    exits: { parked: Parked, delivered: Delivered },
    during: { search: Searching, synthesize: Synthesizing, citations: Checking },
    failure: Failed,
  })
  .on(reopen, { restart: 'search' })
  .ceiling({ maxUsd: 3, onExceed: 'fail' });

const citationPass = H.metric('citation-pass')
  .from(H.when.step(topicLane, 'citations'))
  .samples(e => [{ group: e.models['synthesize'], success: e.ok }]);

const dailyResearch = H.budget('research-daily').maxUsd(40).per('day', { tz: 'UTC' }).lanes(topicLane);

const finding = H.memory('finding')
  .body(z.object({ text: z.string(), topic: z.string(), url: z.string() }))
  .trust('experience');
const sourceExperience = H.memory('source-experience').trust('experience');

const findingsJournal = H.journal('prior-findings', finding)
  .store(pgvector.memoryStore({ url: H.env('VECTOR_DB_URL'), table: 'findings', embeddingModel: 'text-embedding-3-small' }))
  .recall(H.recall('similar-findings', { by: 'similarity', limit: 6, minScore: 0.75 }))
  .readBy(synthesizerRole);

const sourceJournal = H.journal('source-lessons', sourceExperience)
  .store(jsonl.memoryStore({ path: '.harness/source-lessons.jsonl' }))
  .recall(H.recall('most-specific', { by: 'specificity', limit: 8 }))
  .readBy(searcherRole, synthesizerRole)
  .writtenBy(synthesizerRole);

const publishedBecomesFinding = H.trigger('published-report-becomes-finding')
  .on(H.when.step(topicLane, 'publish', { if: e => e.ok }))
  .record(findingsJournal, e =>
    e.output === undefined
      ? undefined
      : {
          body: {
            text: `When researching "${e.unit.attributes.question}", start from: ${e.output.headline}`,
            topic: e.unit.attributes.topicId,
            url: e.output.url,
          },
          when: { kinds: [Topic], roles: [synthesizerRole], skills: e.unit.attributes.tags },
        },
  );

const scheduler = H.scheduler('budgeted')
  .priority(topicLane)
  .admit(topicLane, ctx => {
    const projected = ctx.metrics.meanCostUsd({ of: topicLane, outcome: 'succeeded', windowDays: 30 });
    return projected.meanUsd <= ctx.budget(dailyResearch).remainingUsd;
  });

const supervisor = claudeCode.supervisor('supervisor', {
  grants: [H.ops.workRead, H.ops.workCreate, H.ops.workCancel, H.ops.memoryRead, H.ops.memoryWrite, H.ops.telemetryRead],
});

export const research = H.harness('research-pipeline')
  .ledger(sqlite.ledger({ path: '.harness/ledger.db' }))
  .lanes(topicLane)
  .journals(findingsJournal, sourceJournal)
  .triggers(publishedBecomesFinding)
  .metrics(citationPass)
  .budgets(dailyResearch)
  .scheduler(scheduler)
  .clients(supervisor)
  .observers(markdown.board({ path: 'BOARD.md' }), markdown.telemetry({ path: 'TELEMETRY.md' }));

export const running = research.start();
