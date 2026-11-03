import { H, type Model } from 'harness-dsl';
import { z } from 'zod';
import { claudeCode } from 'harness-dsl/claude-code';
import { anthropic } from 'harness-dsl/anthropic';
import { sqlite } from 'harness-dsl/sqlite';
import { jsonl } from 'harness-dsl/jsonl';
import { lancedb } from 'harness-dsl/lancedb';
import { manual } from 'harness-dsl/supply';
import { local } from 'harness-dsl/runners';
import { byApplicability, bySimilarity } from 'harness-dsl/policies';
import { board, telemetry } from 'harness-dsl/projections';

const Open = H.state('Open').pending();
const Researching = H.state('Researching').active();
const Delivered = H.state('Delivered').succeeded();
const Parked = H.state('Parked').ended();
const Failed = H.state('Failed').failed();
const Cancelled = H.state('Cancelled').cancelled();

const Topic = H.work('topic')
  .schema(z.object({ ref: z.string(), question: z.string(), tags: z.array(z.string()).default([]), findings: z.array(z.string()).default([]) }))
  .states(Open, Researching, Delivered, Parked, Failed, Cancelled)
  .key(d => d.ref);

const Finding = H.memory('report-finding').content(z.object({ question: z.string(), findings: z.array(z.string()) }));
const SourceLesson = H.memory('source-lesson').content(z.object({ action: z.string(), condition: z.string(), reason: z.string() }));

const findingsJournal = H.journal('report-findings')
  .of(Finding)
  .store(lancedb.memory({ uri: 'data/findings.lance', table: 'findings', embeddingModel: 'voyage-3', apiKey: H.env('VOYAGE_API_KEY') }))
  .recall(bySimilarity({ budgetTokens: 3000, minSimilarity: 0.72 }));

const sourceJournal = H.journal('source-lessons').of(SourceLesson).store(jsonl.memory('memory/sources.jsonl')).recall(byApplicability({ budgetTokens: 800 }));

const api = H.account('anthropic-api', anthropic.api({ apiKey: H.env('ANTHROPIC_API_KEY') }));
const haiku = H.model('haiku', api, 'claude-haiku-4-5').pricing(anthropic.pricing());
const opus = H.model('opus', api, 'claude-opus-4-1').pricing(anthropic.pricing());
const sonnet = H.model('sonnet', api, 'claude-sonnet-4-5').pricing(anthropic.pricing());

const byCitationPassRate = H.policy.pick<Model>('citation-pass-rate', ctx => {
  const rated = [opus, sonnet].map(model => ({
    model,
    stats: ctx.metrics.outcomes({ kind: Topic, model, step: 'citations', windowDays: 60 }),
  }));
  const unexplored = rated.filter(r => r.stats.samples < 15);
  if (unexplored.length > 0) return unexplored.map(r => r.model);
  return [...rated].sort((a, b) => (b.stats.successRate ?? 0) - (a.stats.successRate ?? 0)).map(r => r.model);
});

const synthesisModels = H.pool('synthesis-models', [opus, sonnet]).policy(byCitationPassRate);

const searcherRole = H.role('searcher').prompt('You search for sources on one slice of the question and extract sourced findings.').tools('search', 'fetch').recall(SourceLesson);
const synthesizerRole = H.role('synthesizer').prompt('You write a sourced report. Every claim cites a source URL.').tools().recall(Finding, SourceLesson).record(SourceLesson);

const sourceShape = z.object({ url: z.string(), title: z.string(), finding: z.string() });

const searchExtract = H.skill('search-extract')
  .input(z.object({ question: z.string(), slice: z.number(), of: z.number() }))
  .output(z.object({ sources: z.array(sourceShape) }))
  .prompt(i => `Question: ${i.question}\nCover slice ${i.slice + 1} of ${i.of} of the search space.`);

const synthesize = H.skill('synthesize')
  .input(z.object({ question: z.string(), sources: z.array(sourceShape) }))
  .output(z.object({ report: z.string(), citations: z.array(z.object({ claim: z.string(), url: z.string() })), findings: z.array(z.string()) }))
  .prompt(i => `Question: ${i.question}\nSources:\n${i.sources.map(s => `- ${s.title} (${s.url}): ${s.finding}`).join('\n')}`);

const searcher = H.agent('searcher').role(searcherRole).model(haiku);
const synthesizer = H.agent('synthesizer').role(synthesizerRole).model(synthesisModels);

const checker = local('checker').slots(2);

const checkCitations = H.command('check-citations')
  .input(z.object({ urls: z.array(z.string()) }))
  .runner(checker)
  .run(async ctx => {
    const unresolved: string[] = [];
    for (const url of ctx.input.urls) {
      const result = await ctx.exec('curl', ['-fsIL', '--max-time', '15', url], { allowFailure: true });
      if (result.exitCode !== 0) unresolved.push(url);
    }
    if (unresolved.length > 0) throw new Error(`Unresolved citations: ${unresolved.join(', ')}`);
  });

const searchSlices = 20;
const minimumSources = 5;

const topicFlow = H.flow('research')
  .of(Topic)
  .transition(Researching)
  .batch(
    'extract',
    searcher.perform(searchExtract),
    s => Array.from({ length: searchSlices }, (_unused, slice) => ({ question: s.unit.data.question, slice, of: searchSlices })),
    { deferred: true },
  )
  .when(
    s => new Set(s.steps.extract.flatMap(e => e.sources.map(src => src.url))).size < minimumSources,
    w => w.transition(Parked),
  )
  .step('synthesize', synthesizer.perform(synthesize), s => ({
    question: s.unit.data.question,
    sources: s.steps.extract.flatMap(e => e.sources),
  }))
  .step('citations', checkCitations, s => ({ urls: s.steps.synthesize.citations.map(c => c.url) }))
  .update(s => ({ findings: s.steps.synthesize.findings }))
  .transition(Delivered);

const topics = H.lane('topics')
  .of(Topic)
  .from(manual())
  .store(sqlite.store('.harness/topics.sqlite'))
  .handle(topicFlow)
  .maxUsdPerUnit(3);

const nextMondayMorning = (after: Date): Date => {
  const next = new Date(after);
  next.setUTCHours(6, 0, 0, 0);
  const daysAhead = (8 - next.getUTCDay()) % 7 || 7;
  next.setUTCDate(next.getUTCDate() + daysAhead);
  return next;
};

const weeklyReopen = H.trigger('weekly-reopen-recurring')
  .on(topics.deadline(u => (u.data.tags.includes('recurring') ? nextMondayMorning(u.updatedAt) : null), { during: [Delivered, Parked] }))
  .move(Open);

const deliveredFindings = H.trigger('delivered-findings-become-memory')
  .on(topics.enters(Delivered))
  .record(findingsJournal, e => ({ content: { question: e.unit.data.question, findings: e.unit.data.findings }, when: { kinds: [Topic] } }));

const dailyBudgetUsd = 40;
const topicCeilingUsd = 3;

const withinDailyBudget = H.policy.schedule('within-daily-budget', ctx => {
  const startOfDay = new Date(ctx.now);
  startOfDay.setUTCHours(0, 0, 0, 0);
  const spent = ctx.metrics.spend({ since: startOfDay }).usd;
  const projected = ctx.metrics.outcomes({ kind: Topic, windowDays: 30 }).meanCostUsdSucceeded ?? topicCeilingUsd;
  const committed = ctx.of(topics).running.reduce((sum, r) => sum + Math.max(0, projected - r.attempt.costUsd), 0);
  let remaining = dailyBudgetUsd - spent - committed;
  const start = [];
  for (const queued of [...ctx.of(topics).pending].sort((a, b) => a.queuedAt.getTime() - b.queuedAt.getTime())) {
    if (projected > remaining) break;
    start.push(queued);
    remaining -= projected;
  }
  return { start };
});

const supervisor = H.supervisor('research-desk')
  .endpoint(claudeCode.endpoint({ server: 'research' }))
  .grant(H.ops.work.read, H.ops.work.write, H.ops.memory.read, H.ops.memory.write, H.ops.telemetry.read);

export const research = H.harness('research-pipeline')
  .ledger(sqlite.ledger('.harness/ledger.sqlite'))
  .lanes(topics)
  .journals(findingsJournal, sourceJournal)
  .triggers(weeklyReopen, deliveredFindings)
  .scheduler(H.scheduler('research').concurrency(3).policy(withinDailyBudget))
  .supervisor(supervisor)
  .projections(board('BOARD.md'), telemetry('TELEMETRY.md'));

export const run = research.start();
