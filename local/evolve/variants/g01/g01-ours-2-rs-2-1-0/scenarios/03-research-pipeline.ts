import { z } from 'zod';
import { H } from 'harness-dsl';
import type { Policy } from 'harness-dsl';
import type { Candidate, StepEvent } from 'harness-dsl/kernel';
import { claudeCode } from 'harness-dsl/claude-code';
import { anthropic } from 'harness-dsl/anthropic';
import { sqlite } from 'harness-dsl/sqlite';
import { jsonl } from 'harness-dsl/jsonl';
import { pgvector } from 'harness-dsl/pgvector';
import { manual } from 'harness-dsl/supply';
import { runners } from 'harness-dsl/runners';
import { policies } from 'harness-dsl/policies';
import { observers } from 'harness-dsl/observers';

const queued = H.state('queued').pending();
const delivered = H.state('delivered').terminal('success');
const parked = H.state('parked').terminal('neutral');
const cancelled = H.state('cancelled').terminal('neutral');
const failed = H.state('failed').terminal('failure');

const topicSchema = z.object({ title: z.string(), question: z.string(), recurring: z.boolean() });
type Topic = z.infer<typeof topicSchema>;

const topic = H.work('topic').schema(topicSchema).states(queued, delivered, parked, cancelled, failed);

const finding = H.memory('report-finding').content(z.object({ rule: z.string() })).trust('experience');
const sourceLesson = H.memory('source-lesson').content(z.object({ rule: z.string() })).trust('experience');

const findingsLog = H.journal('report-findings')
  .of(finding)
  .store(
    pgvector.memory({
      url: H.env('FINDINGS_DATABASE_URL'),
      table: 'findings',
      embeddingModel: 'voyage-3',
      embeddingKey: H.env('VOYAGE_API_KEY'),
      dimensions: 1024,
    }),
  )
  .recall(policies.similarity({ minimum: 0.75, limit: 6 }));
const sourceLessons = H.journal('source-lessons')
  .of(sourceLesson)
  .store(jsonl.memory('memory/source-lessons.jsonl'))
  .recall(policies.specificity({ limit: 8 }));

const quotaEvents = sqlite.quota('.harness/quota.sqlite');
const apiAccount = H.account('api', anthropic.api({ apiKey: H.env('ANTHROPIC_API_KEY') })).quota(quotaEvents);
const haiku = H.model('claude-haiku-4-5').pricing(anthropic.pricing());
const opus = H.model('claude-opus-4-1').pricing(anthropic.pricing());
const sonnet = H.model('claude-sonnet-4-5').pricing(anthropic.pricing());
const apiPool = H.pool('research-api', [apiAccount]).serves(haiku, opus, sonnet).policy(policies.soonestReset());

const searcherRole = H.role('searcher').promptFile('prompts/searcher.md').intents(['web']).recall(sourceLesson);
const synthesizerRole = H.role('synthesizer').promptFile('prompts/synthesizer.md').recall(finding, sourceLesson);

const searchSkill = H.skill('search-and-extract')
  .input(z.object({ query: z.string() }))
  .output(z.object({ extract: z.string(), sources: z.array(z.string()) }))
  .prompt(i => `Search and extract: ${i.query}`);
const synthesisSkill = H.skill('synthesize-report')
  .input(z.object({ question: z.string(), extracts: z.array(z.string()) }))
  .output(z.object({ report: z.string(), citations: z.array(z.string()), findings: z.array(z.string()) }))
  .prompt(i => `Question: ${i.question}\n\n${i.extracts.join('\n\n')}`);

const synthesizerModels: Policy<'models'> = H.policy.models('citation-pass-comparison', choice => {
  const readings = choice.candidates.map(model => ({ model, reading: choice.metrics.read(citationPass, model) }));
  const unexplored = readings.filter(r => r.reading.samples < 30);
  if (unexplored.length > 0) return [...unexplored].sort((a, b) => a.reading.samples - b.reading.samples).map(r => r.model);
  return [...readings].sort((a, b) => (b.reading.value ?? 0) - (a.reading.value ?? 0)).map(r => r.model);
});

const searcher = H.seat('searcher').role(searcherRole).skill(searchSkill).models(haiku);
const synthesizer = H.seat('synthesizer').role(synthesizerRole).skill(synthesisSkill).models(opus, sonnet).policy(synthesizerModels);
const searchBatch = H.job('search-extract-batch').batch(searcher);

const local = runners.local({ name: 'local', slots: 4 });

const planQueries = H.command('plan-queries')
  .input(z.object({ title: z.string(), question: z.string() }))
  .output(z.object({ queries: z.array(z.string()) }))
  .runner(local)
  .effect('repeatable')
  .run(async input => {
    const angles = ['overview', 'evidence', 'criticism', 'methods', 'datasets', 'recent results', 'history', 'open problems', 'reviews', 'replications'];
    return { queries: angles.flatMap(angle => [`${input.title} ${angle}`, `${input.question} ${angle}`]) };
  });

const citationCheck = H.command('citation-check')
  .input(z.object({ citations: z.array(z.string()), findings: z.array(z.string()) }))
  .output(z.object({ resolved: z.number(), findings: z.array(z.string()) }))
  .runner(local)
  .effect('repeatable')
  .run(async input => {
    const unresolved: string[] = [];
    for (const citation of input.citations) {
      const response = await fetch(citation, { method: 'HEAD' });
      if (!response.ok) unresolved.push(citation);
    }
    if (unresolved.length > 0) throw new Error(`Unresolved citations: ${unresolved.join(', ')}`);
    return { resolved: input.citations.length, findings: input.findings };
  });

const citationPass = H.metric('citation-pass', H.events.steps(citationCheck).credit([synthesizer], e => e.outcome === 'completed'))
  .rate(e => e.credited)
  .by('model')
  .window('60d');

const topicBudget = H.halt('topic-budget')
  .context(z.object({ topic: z.string(), spentUsd: z.number() }))
  .decision(
    z.discriminatedUnion('action', [
      z.object({ action: z.literal('raise'), extraUsd: z.number() }),
      z.object({ action: z.literal('stop') }),
    ]),
  )
  .ask(c => `Topic ${c.topic} has spent $${c.spentUsd.toFixed(2)} of $3. Raise or stop?`);

const research = H.flow('research')
  .input(topicSchema)
  .step('plan', planQueries, s => ({ title: s.input.title, question: s.input.question }))
  .step('search', searchBatch, s => s.plan.queries.map(query => ({ query })))
  .when(s => s.search.filter(r => r.sources.length > 0).length < 5, f => f.exit('parked'))
  .step('synthesize', synthesizer, s => ({ question: s.input.question, extracts: s.search.map(r => r.extract) }))
  .step('citations', citationCheck, s => ({ citations: s.synthesize.citations, findings: s.synthesize.findings }))
  .exit('delivered');

const topics = H.lane('topics')
  .of(topic)
  .from(manual<Topic>('operator-topics'))
  .store(sqlite.store<Topic>('.harness/topics.sqlite'))
  .handle(research, {
    exits: { delivered, parked },
    retry: { retries: 1, backoff: { initial: '15m', factor: 2 }, exhausted: failed },
  })
  .ceiling({
    maxUsd: 3,
    onExceed: topicBudget,
    context: spent => ({ topic: spent.unit.key, spentUsd: spent.spentUsd }),
    stopped: cancelled,
  });

const reopenRecurring = H.trigger('weekly-reopen-recurring')
  .on(H.time.every('0 6 * * 1'))
  .do(
    topics.move({ state: delivered, where: (d: Topic) => d.recurring }, queued),
    topics.move({ state: parked, where: (d: Topic) => d.recurring }, queued),
  );

type CitationStep = StepEvent<{ resolved: number; findings: string[] }>;

const recordFindings = H.trigger('verified-findings-recorded')
  .on(H.events.steps(citationCheck).where(e => e.outcome === 'completed'))
  .do(
    findingsLog.record((e: CitationStep) => ({
      content: { rule: `when researching near ${e.unit.key}, start from these verified findings: ${(e.output?.findings ?? []).join('; ')}` },
      when: { kinds: [topic] },
    })),
  );

const dailySpend = H.metric('daily-model-spend', H.events.invocations()).sum(e => e.costUsd).window('calendarDay');
const topicCost = H.metric('succeeded-topic-cost', H.events.attempts(topics).where(e => e.outcome === 'succeeded'))
  .mean(e => e.costUsd)
  .by('kind')
  .window('30d');

const withinDailyBudget = H.policy.units('within-daily-budget', choice => {
  const spent = choice.metrics.read(dailySpend).value ?? 0;
  const mean = choice.metrics.read(topicCost, topic);
  const projected = mean.samples >= 5 && mean.value !== undefined ? mean.value : 3;
  let committed = spent + choice.active.length * projected;
  const admitted: Candidate[] = [];
  for (const candidate of [...choice.candidates].sort((a, b) => a.queuedAt.getTime() - b.queuedAt.getTime())) {
    if (committed + projected > 40) break;
    admitted.push(candidate);
    committed += projected;
  }
  return admitted;
});

const operator = claudeCode.client({ name: 'research-operator' });

export const researchPipeline = H.harness('research-pipeline')
  .ledger(sqlite.ledger('.harness/ledger.sqlite'))
  .pools(apiPool)
  .lanes(topics)
  .journals(findingsLog, sourceLessons)
  .triggers(reopenRecurring, recordFindings)
  .scheduler(withinDailyBudget)
  .grants(
    H.grant(
      operator,
      H.ops.work.read,
      H.ops.work.write,
      H.ops.attempts.manage,
      H.ops.resolve(topicBudget),
      H.ops.memory.write(sourceLesson),
      H.ops.telemetry.read,
    ),
  )
  .observe(observers.board({ path: 'BOARD.md' }), observers.telemetry({ path: 'TELEMETRY.md' }));
