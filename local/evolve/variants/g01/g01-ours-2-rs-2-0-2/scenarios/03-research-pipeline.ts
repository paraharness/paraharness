import { z } from 'zod';
import { H } from 'harness-dsl';
import type { Metric, Seat } from 'harness-dsl';
import type { Candidate } from 'harness-dsl/kernel';
import { claudeCode } from 'harness-dsl/claude-code';
import { anthropic } from 'harness-dsl/anthropic';
import { sqlite } from 'harness-dsl/sqlite';
import { jsonl } from 'harness-dsl/jsonl';
import { pgvector } from 'harness-dsl/pgvector';
import { supply } from 'harness-dsl/supply';
import { policies } from 'harness-dsl/policies';
import { observers } from 'harness-dsl/observers';

const proposed = H.state('proposed').pending();
const researching = H.state('researching').active();
const reported = H.state('reported').terminal('success');
const parked = H.state('parked').terminal('neutral');
const cancelled = H.state('cancelled').terminal('neutral');
const failed = H.state('failed').terminal('failure');

const topicSchema = z.object({ title: z.string(), question: z.string(), tags: z.array(z.string()) });
const Topic = H.work('Topic').schema(topicSchema).states(proposed, researching, reported, parked, cancelled, failed);

const topicStorePath = '.harness/topics.db';
const topicStore = sqlite.store(topicStorePath);
const weeklyRecurring = sqlite.reopen({
  path: topicStorePath,
  cron: '0 6 * * 1',
  schema: topicSchema,
  where: topic => topic.tags.includes('recurring'),
});

const priorFinding = H.memory('priorFinding').content(z.object({ finding: z.string(), topic: z.string() })).trust('experience');
const sourceLesson = H.memory('sourceLesson').content(z.object({ lesson: z.string() })).trust('experience');

const findingsJournal = H.journal('findings')
  .of(priorFinding)
  .store(pgvector.store({
    url: H.env('FINDINGS_DATABASE_URL'),
    table: 'prior_findings',
    embeddingModel: 'voyage-3',
    embeddingKey: H.env('EMBEDDING_API_KEY'),
  }))
  .recall(policies.similarity({ limit: 6, minSimilarity: 0.75 }));

const sourceJournal = H.journal('sourceLessons')
  .of(sourceLesson)
  .store(jsonl.store('memory/source-lessons.jsonl'))
  .recall(policies.specificity({ limit: 8 }));

const apiAccount = H.account('api', anthropic.api({ apiKey: H.env('ANTHROPIC_API_KEY') }));
const subscription = H.account('subscription', claudeCode.driver({ configDir: H.env('CLAUDE_CONFIG') }));
const haiku = H.model('claude-haiku-4-5').pricing(anthropic.pricing());
const opus = H.model('claude-opus-4-1', { effort: 'high' }).pricing(anthropic.pricing());
const sonnet = H.model('claude-sonnet-4-5', { effort: 'high' }).pricing(anthropic.pricing());
const pool = H.pool('research', [apiAccount]).serves(haiku, opus, sonnet).fallback(subscription);

const searcherRole = H.role('searcher')
  .prompt('You search for sources on one angle of a question and extract claims with quotes.')
  .intents(['web'])
  .recall(sourceLesson);

const synthesizerRole = H.role('synthesizer')
  .prompt('You write a sourced report. Every claim carries a citation that resolves.')
  .intents([])
  .recall(priorFinding, sourceLesson)
  .record(sourceLesson);

const sourceSchema = z.object({ url: z.string(), claim: z.string(), quote: z.string() });
type Source = z.infer<typeof sourceSchema>;
const citationSchema = z.object({ url: z.string(), claim: z.string() });

const extractSkill = H.skill('searchAndExtract')
  .input(z.object({ topic: z.string(), query: z.string() }))
  .output(z.object({ sources: z.array(sourceSchema) }))
  .prompt(i => `Topic: ${i.topic}\nSearch: ${i.query}\nReturn the sources you found with the claims they support.`);

const synthSkill = H.skill('synthesize')
  .input(z.object({ question: z.string(), sources: z.array(sourceSchema) }))
  .output(z.object({ report: z.string(), citations: z.array(citationSchema), findings: z.array(z.string()) }))
  .prompt(i => `Question: ${i.question}\n\nSources:\n${i.sources.map(s => `- ${s.url}: ${s.claim}`).join('\n')}`);

const angles = [
  'definitions', 'history', 'current consensus', 'open disputes', 'key datasets',
  'methodology', 'replications', 'criticisms', 'industry practice', 'regulation',
  'costs', 'risks', 'benchmarks', 'case studies', 'recent preprints',
  'review articles', 'adjacent fields', 'failed approaches', 'expert forecasts', 'unanswered questions',
];

const expandQueries = H.command('expandQueries')
  .input(topicSchema)
  .output(z.object({ queries: z.array(z.string()) }))
  .run(async input => ({ queries: angles.map(angle => `${input.question} ${angle}`) }));

const citationCheck = H.command('citationCheck')
  .input(z.object({ citations: z.array(citationSchema) }))
  .run(async input => {
    const unresolved: string[] = [];
    for (const citation of input.citations) {
      const response = await fetch(citation.url, { method: 'HEAD', redirect: 'follow' }).catch(() => undefined);
      if (response === undefined || !response.ok) unresolved.push(citation.url);
    }
    if (unresolved.length > 0) throw new Error(`Unresolved citations: ${unresolved.join(', ')}`);
  });

const fileFindings = H.command('fileFindings')
  .input(z.object({ title: z.string(), findings: z.array(z.string()) }))
  .run(async (input, ctx) => {
    for (const finding of input.findings) {
      await ctx.record(findingsJournal, {
        content: {
          finding: `When researching questions near "${input.title}", start from this finding: ${finding}, because the delivered report on it confirmed it`,
          topic: input.title,
        },
        when: { kinds: [Topic] },
      });
    }
  });

const deliverReport = H.command('deliverReport')
  .input(z.object({ title: z.string(), report: z.string() }))
  .run(async (input, ctx) => {
    const slug = input.title.toLowerCase().replace(/[^a-z0-9]+/g, '-');
    const result = await ctx.sh(`mkdir -p reports && cat > reports/${slug}.md`, { stdin: input.report });
    if (result.code !== 0) throw new Error(result.stderr);
  });

const gathered = (extracts: readonly { readonly sources: Source[] }[]): Source[] =>
  extracts.reduce<Source[]>((all, extract) => all.concat(extract.sources), []);

const searcher = H.seat('searcher').role(searcherRole).models(haiku);

const citationPassLeader = H.policy.seat('citationPassLeader', ({ candidates, seat, metrics }) => {
  const scored = candidates.map(model => ({ model, reading: metrics.read(citationPass, { window: '30d', where: { seat, model } }) }));
  const unexplored = scored.filter(entry => entry.reading.samples < 15);
  if (unexplored.length > 0) {
    return [...unexplored, ...scored.filter(entry => entry.reading.samples >= 15)].map(entry => entry.model);
  }
  return [...scored].sort((a, b) => (b.reading.value ?? 0) - (a.reading.value ?? 0)).map(entry => entry.model);
});

const synthesizer: Seat = H.seat('synthesizer').role(synthesizerRole).models(opus, sonnet).policy(citationPassLeader);

const research = H.flow('research')
  .input(topicSchema)
  .step('queries', expandQueries)
  .step('extract', searcher.batch(extractSkill), s => s.steps.queries.queries.map(query => ({ topic: s.input.title, query })))
  .when(s => gathered(s.steps.extract).length < 5, f => f.exit('tooFewSources'))
  .step('synthesis', synthesizer.call(synthSkill), s => ({ question: s.input.question, sources: gathered(s.steps.extract) }))
  .step('citations', citationCheck, s => ({ citations: s.steps.synthesis.citations }))
  .step('findings', fileFindings, s => ({ title: s.input.title, findings: s.steps.synthesis.findings }))
  .step('deliver', deliverReport, s => ({ title: s.input.title, report: s.steps.synthesis.report }))
  .exit('reported');

const citationPass: Metric = H.metric('citationPass').rate(
  H.events.steps(research, 'citations', { outcome: 'succeeded' }),
  H.events.steps(research, 'citations'),
);
const meanSucceededCost: Metric = H.metric('meanSucceededCost').mean(H.events.attempts({ outcome: 'succeeded' }), 'costUsd');
const modelSpend: Metric = H.metric('modelSpend').sum(H.events.invocations(), 'costUsd');

const topics = H.lane('topics')
  .of(Topic)
  .from(supply.manual(), weeklyRecurring)
  .store(topicStore)
  .handle(research, {
    exits: { reported, tooFewSources: parked },
    retry: { tries: 1, backoff: 'none', exhausted: failed },
  })
  .ceiling({ maxUsd: 3, onExceed: 'fail' })
  .wip(4);

const dailyBudgetUsd = 40;
const topicCeilingUsd = 3;

const withinDailyBudget = H.policy.schedule('withinDailyBudget', ({ candidates, metrics, now }) => {
  const midnight = new Date(now);
  midnight.setUTCHours(0, 0, 0, 0);
  const spentUsd = metrics.read(modelSpend, { window: { since: midnight } }).value ?? 0;
  const projection = metrics.read(meanSucceededCost, { window: '30d', where: { kind: Topic } });
  const projectedUsd = projection.samples >= 5 && projection.value !== undefined ? projection.value : topicCeilingUsd;
  const admitted: Candidate[] = [];
  let remainingUsd = dailyBudgetUsd - spentUsd;
  for (const candidate of candidates) {
    if (candidate.resuming) {
      admitted.push(candidate);
    } else if (projectedUsd <= remainingUsd) {
      admitted.push(candidate);
      remainingUsd -= projectedUsd;
    }
  }
  return admitted;
});

const operator = claudeCode.client('operator');

const operatorGrant = H.grant(
  operator,
  H.ops.work.read,
  H.ops.work.write,
  H.ops.memory.curate(findingsJournal, sourceJournal),
  H.ops.telemetry.read,
);

export default H.harness('research-pipeline')
  .ledger(sqlite.ledger('.harness/ledger.db'))
  .pools(pool)
  .lanes(topics)
  .journals(findingsJournal, sourceJournal)
  .schedule(withinDailyBudget)
  .grants(operatorGrant)
  .metrics(citationPass, meanSucceededCost, modelSpend)
  .observe(observers.board({ path: 'BOARD.md' }), observers.telemetry({ path: 'TELEMETRY.md' }));
