import { z } from 'zod';
import { H } from 'harness-dsl';
import { claudeCode } from 'harness-dsl/claude-code';
import { anthropic } from 'harness-dsl/anthropic';
import { sqlite } from 'harness-dsl/sqlite';
import { jsonl } from 'harness-dsl/jsonl';
import { pgvector } from 'harness-dsl/pgvector';
import { supply } from 'harness-dsl/supply';
import { policies } from 'harness-dsl/policies';
import { observers } from 'harness-dsl/observers';

const topicSchema = z.object({
  title: z.string(),
  question: z.string(),
  tags: z.array(z.string()),
  edition: z.string(),
});

const queued = H.state('queued').pending();
const researching = H.state('researching').active();
const delivered = H.state('delivered').terminal('success');
const parked = H.state('parked').terminal('neutral');
const cancelled = H.state('cancelled').terminal('neutral');
const failed = H.state('failed').terminal('failure');

const topic = H.work('Topic').schema(topicSchema).states(queued, researching, delivered, parked, cancelled, failed);

const ruleSchema = z.object({ action: z.string(), condition: z.string(), reason: z.string() });
const findings = H.memory('findings').content(ruleSchema).trust('experience');
const sourceExperience = H.memory('source-experience').content(ruleSchema).trust('experience');

const findingsJournal = H.journal('findings')
  .of(findings)
  .store(pgvector.store({
    url: H.env('VECTOR_DB_URL'),
    table: 'findings',
    embeddingModel: 'text-embedding-3-small',
    embeddingKey: H.env('EMBEDDING_API_KEY'),
  }))
  .recall(policies.similarity({ limit: 8, minSimilarity: 0.75 }));
const sourceJournal = H.journal('source-experience')
  .of(sourceExperience)
  .store(jsonl.store('memory/sources.jsonl'))
  .recall(policies.specificity({ limit: 10 }));

const apiAccount = H.account('research-api', anthropic.api({ apiKey: H.env('ANTHROPIC_API_KEY') }));
const haiku = H.model('claude-haiku-4-5').pricing(anthropic.pricing());
const sonnet = H.model('claude-sonnet-4-5').pricing(anthropic.pricing());
const opus = H.model('claude-opus-4-1').pricing(anthropic.pricing());
const pool = H.pool('research', [apiAccount]).serves(haiku, sonnet, opus);

const extractorRole = H.role('extractor').promptFile('prompts/extractor.md').intents(['web']).recall(sourceExperience);
const synthesizerRole = H.role('synthesizer').promptFile('prompts/synthesizer.md').intents(['read']).recall(findings, sourceExperience);

const findingSchema = z.object({ url: z.string(), title: z.string(), finding: z.string() });
type Finding = z.infer<typeof findingSchema>;
const extractionSchema = z.object({ sources: z.array(findingSchema) });
const citationSchema = z.object({ url: z.string(), claim: z.string() });

const searchExtract = H.skill('search-and-extract')
  .input(z.object({ question: z.string(), angle: z.string() }))
  .output(extractionSchema)
  .prompt(i => `Search for sources on "${i.question}" from the angle of ${i.angle}, and extract one finding per source.`);

const synthesize = H.skill('synthesize')
  .input(z.object({ question: z.string(), sources: z.array(findingSchema) }))
  .output(z.object({ report: z.string(), citations: z.array(citationSchema), keyFindings: z.array(z.string()) }))
  .prompt(i => `Write a sourced report answering "${i.question}" from these sources:\n${i.sources.map(s => `- ${s.title} (${s.url}): ${s.finding}`).join('\n')}`);

const citationPassRate = H.metric('citation-check-pass-rate').rate(
  H.events.steps('checkCitations', { outcome: 'succeeded' }),
  H.events.steps('checkCitations'),
);

const explorationSamples = 15;
const bestCitationPassRate = H.policy.seat('best-citation-pass-rate', ({ candidates, seat, metrics }) => {
  const scored = candidates.map(model => ({ model, reading: metrics.read(citationPassRate, { window: '30d', where: { seat, model } }) }));
  const unexplored = scored.filter(s => s.reading.samples < explorationSamples);
  if (unexplored.length > 0) return unexplored.sort((a, b) => a.reading.samples - b.reading.samples).map(s => s.model);
  return scored.sort((a, b) => (b.reading.value ?? 0) - (a.reading.value ?? 0)).map(s => s.model);
});

const extractor = H.agent('extractor').role(extractorRole).model(haiku);
const synthesizer = H.seat('synthesizer').role(synthesizerRole).models(sonnet, opus).policy(bestCitationPassRate);

const workstation = H.runner.local('workstation', { slots: 4 });
const minimumSources = 5;

const gather = H.command('gather-sources')
  .input(z.object({ results: z.array(extractionSchema) }))
  .output(z.object({ sources: z.array(findingSchema), enough: z.boolean() }))
  .runner(workstation)
  .effect('repeatable')
  .run(async input => {
    const byUrl = new Map<string, Finding>();
    for (const result of input.results) {
      for (const source of result.sources) {
        if (!byUrl.has(source.url)) byUrl.set(source.url, source);
      }
    }
    const sources = [...byUrl.values()];
    return { sources, enough: sources.length >= minimumSources };
  });

const checkCitations = H.command('check-citations')
  .input(z.object({ citations: z.array(citationSchema) }))
  .output(z.object({ checked: z.number() }))
  .runner(workstation)
  .effect('repeatable')
  .run(async (input, ctx) => {
    const unresolved: string[] = [];
    for (const citation of input.citations) {
      const response = await fetch(citation.url, { method: 'HEAD', signal: ctx.signal });
      if (!response.ok) unresolved.push(citation.url);
    }
    if (unresolved.length > 0) throw new Error(`Unresolved citations: ${unresolved.join(', ')}`);
    return { checked: input.citations.length };
  });

const recordFindings = H.command('record-findings')
  .input(z.object({ title: z.string(), edition: z.string(), keyFindings: z.array(z.string()) }))
  .runner(workstation)
  .effect('repeatable')
  .run(async (input, ctx) => {
    for (const finding of input.keyFindings) {
      await ctx.record(findingsJournal, {
        content: {
          condition: `when researching ${input.title}`,
          action: `start from the established finding: ${finding}`,
          reason: `the ${input.edition} report established it with checked citations`,
        },
        when: { kinds: [topic] },
      });
    }
  });

const angles = [
  'definitions', 'history', 'current consensus', 'open disputes', 'methodology', 'datasets',
  'benchmarks', 'industry practice', 'regulation', 'economics', 'failure cases', 'recent preprints',
  'review articles', 'critiques', 'replications', 'geographic differences', 'tooling', 'standards',
  'expert interviews', 'forecasts',
];

const research = H.flow('research')
  .input(topicSchema)
  .batch('extract', {
    items: s => angles.map(angle => ({ question: s.input.question, angle })),
    call: extractor.call(searchExtract),
  })
  .step('gather', gather, s => ({ results: [...s.steps.extract] }))
  .when(s => !s.steps.gather.enough, notEnough => notEnough.exit('notEnoughSources'))
  .step('synthesize', synthesizer.call(synthesize), s => ({ question: s.input.question, sources: s.steps.gather.sources }))
  .step('checkCitations', checkCitations, s => ({ citations: s.steps.synthesize.citations }))
  .step('recordFindings', recordFindings, s => ({
    title: s.input.title,
    edition: s.input.edition,
    keyFindings: s.steps.synthesize.keyFindings,
  }))
  .exit('delivered');

const recurringTopics = [
  { title: 'Solid-state batteries', question: 'What changed this week in solid-state battery research?' },
  { title: 'Open model releases', question: 'Which open-weight models were released this week, and how do they compare?' },
];

const topicCeilingUsd = 3;
const topics = H.lane('topics')
  .of(topic)
  .from(
    supply.manual(),
    supply.schedule({
      cron: '0 6 * * 1',
      units: now => recurringTopics.map(t => ({ ...t, tags: ['recurring'], edition: now.toISOString().slice(0, 10) })),
    }).key(data => `${data.title}-${data.edition}`),
  )
  .store(sqlite.store('.harness/topics.db'))
  .handle(research)
  .exits({ notEnoughSources: parked, delivered })
  .retry({ tries: 1, backoff: 'none', exhausted: failed })
  .ceiling({ maxUsd: topicCeilingUsd, onExceed: 'fail' });

const dailySpend = H.metric('daily-spend').sum(H.events.invocations(), 'costUsd');
const succeededTopicCost = H.metric('succeeded-topic-cost').mean(H.events.attempts({ outcome: 'succeeded' }), 'costUsd');

const dailyBudgetUsd = 40;
const dailyResearchBudget = H.policy.schedule('daily-research-budget', ({ candidates, running, metrics, now }) => {
  const midnight = new Date(now);
  midnight.setUTCHours(0, 0, 0, 0);
  const spent = metrics.read(dailySpend, { window: { since: midnight } }).value ?? 0;
  const cost = metrics.read(succeededTopicCost, { window: '30d', where: { kind: topic } });
  const projected = cost.samples >= 5 && cost.value !== undefined ? cost.value : topicCeilingUsd;
  const remaining = dailyBudgetUsd - spent - running.length * projected;
  const affordable = Math.max(0, Math.floor(remaining / projected));
  return [...candidates].sort((a, b) => b.waitingSeconds - a.waitingSeconds).slice(0, affordable);
});

const operator = H.grant(
  claudeCode.client('operator', { session: 'research' }),
  H.ops.work.read,
  H.ops.work.write,
  H.ops.memory.write(sourceJournal),
  H.ops.memory.curate(findingsJournal, sourceJournal),
  H.ops.telemetry.read,
);

export default H.harness('research-pipeline')
  .ledger(sqlite.ledger('.harness/ledger.db'))
  .pools(pool)
  .lanes(topics)
  .journals(findingsJournal, sourceJournal)
  .scheduler(H.scheduler().policy(dailyResearchBudget))
  .grants(operator)
  .observe(observers.board({ path: 'BOARD.md' }), observers.telemetry({ path: 'TELEMETRY.md' }));
