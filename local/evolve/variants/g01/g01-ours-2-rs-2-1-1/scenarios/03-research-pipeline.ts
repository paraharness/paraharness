import { z } from 'zod';
import { H } from 'harness-dsl';
import type { Policy } from 'harness-dsl';
import { claudeCode } from 'harness-dsl/claude-code';
import { anthropic } from 'harness-dsl/anthropic';
import { sqlite } from 'harness-dsl/sqlite';
import { jsonl } from 'harness-dsl/jsonl';
import { pgvector } from 'harness-dsl/pgvector';
import { manual } from 'harness-dsl/supply';
import { policies } from 'harness-dsl/policies';
import { observers } from 'harness-dsl/observers';

const queued = H.state('queued').pending();
const delivered = H.state('delivered').terminal('success');
const parked = H.state('parked').terminal('neutral');
const withdrawn = H.state('cancelled').terminal('neutral');
const failed = H.state('failed').terminal('failure');

const topic = z.object({ title: z.string(), question: z.string(), tags: z.array(z.string()) });
const Topic = H.work('Topic').schema(topic).states(queued, delivered, parked, withdrawn, failed);

const findings = H.memory('report-findings').content(z.object({ topic: z.string(), finding: z.string() })).trust('experience');
const sourceLessons = H.memory('source-lessons')
  .content(z.object({ do: z.string(), when: z.string(), because: z.string() }))
  .trust('experience');

const haiku = H.model('claude-haiku-4-5').pricing(anthropic.pricing());
const opus = H.model('claude-opus-4-1').pricing(anthropic.pricing());
const sonnet = H.model('claude-sonnet-4-5').pricing(anthropic.pricing());

const apiAccount = H.account('anthropic-api', anthropic.api({ apiKey: H.env('ANTHROPIC_API_KEY') }));
const apiPool = H.pool('anthropic', [apiAccount]).serves(haiku, opus, sonnet);

const source = z.object({ url: z.string(), claim: z.string() });

const extractorRole = H.role('extractor').prompt('Search for sources on one angle of the question and extract claims with URLs.').intents(['web']).recall(sourceLessons);
const synthesizerRole = H.role('synthesizer')
  .prompt('Write a sourced report. Every claim cites a URL from the extracted sources.')
  .intents([])
  .recall(findings, sourceLessons)
  .record(findings);

const extractSkill = H.skill('search-and-extract')
  .input(z.object({ topic: z.string(), question: z.string(), angle: z.number() }))
  .output(z.object({ sources: z.array(source) }))
  .prompt(input => `Topic: ${input.topic}\nQuestion: ${input.question}\nAngle ${input.angle + 1} of 20.`);
const synthesizeSkill = H.skill('synthesize')
  .input(z.object({ topic: z.string(), question: z.string(), sources: z.array(source) }))
  .output(z.object({ report: z.string(), citations: z.array(z.string()) }))
  .prompt(input => `Topic: ${input.topic}\nQuestion: ${input.question}\n\n${input.sources.map(entry => `${entry.url}: ${entry.claim}`).join('\n')}`);

const extractor = H.seat('extractor').role(extractorRole).skill(extractSkill).models(haiku);

const citationCheck = H.command('citation-check')
  .input(z.object({ citations: z.array(z.string()) }))
  .output(z.object({ checked: z.number() }))
  .effect('repeatable')
  .run(async (input, ctx) => {
    const unresolved: string[] = [];
    for (const citation of input.citations) {
      const response = await fetch(citation, { method: 'HEAD' });
      if (!response.ok) unresolved.push(citation);
    }
    const preprints = unresolved.filter(url => url.includes('arxiv.org') || url.includes('biorxiv.org'));
    if (preprints.length > 0) {
      ctx.remember(sourceLessons, {
        do: 'downgrade confidence and seek a published version',
        when: 'the source is a preprint server',
        because: `preprint citations failed to resolve: ${preprints.join(', ')}`,
      });
    }
    if (unresolved.length > 0) throw new Error(`Unresolved citations: ${unresolved.join(', ')}`);
    return { checked: input.citations.length };
  });

const citationPass = H.metric('citation-pass', H.events.steps(citationCheck))
  .rate(event => event.outcome === 'completed')
  .by('seat', 'model')
  .window('60d');

const explorationSamples = 30;

const synthesizerModels: Policy<'models'> = H.policy.models('best-citation-pass', choice => {
  const scored = choice.candidates.map(model => ({ model, reading: choice.metrics.read(citationPass, synthesizer, model) }));
  return [...scored]
    .sort((a, b) => {
      const aExplore = a.reading.samples < explorationSamples ? 1 : 0;
      const bExplore = b.reading.samples < explorationSamples ? 1 : 0;
      return bExplore - aExplore || a.reading.samples - b.reading.samples * aExplore || (b.reading.value ?? 0) - (a.reading.value ?? 0);
    })
    .map(entry => entry.model);
});

const synthesizer = H.seat('synthesizer').role(synthesizerRole).skill(synthesizeSkill).models(opus, sonnet).policy(synthesizerModels);

const searchBatch = H.job('search-batch').batch(extractor);

const topicOverBudget = H.halt('topic-over-budget')
  .context(z.object({ unit: z.string(), spentUsd: z.number(), maxUsd: z.number(), nextStep: z.string() }))
  .decision(z.object({ extraUsd: z.number() }))
  .ask(facts => `Topic ${facts.unit} has spent $${facts.spentUsd.toFixed(2)} of $${facts.maxUsd.toFixed(2)} before ${facts.nextStep}. Grant extra dollars, or 0 to stop.`);

const minimumSources = 5;

const research = H.flow('research')
  .input(topic)
  .step('search', searchBatch, state => Array.from({ length: 20 }, (_, angle) => ({ topic: state.input.title, question: state.input.question, angle })))
  .when(state => state.search.flatMap(result => result.sources).length < minimumSources, thin => thin.exit('parked'))
  .step('synthesis', synthesizer, state => ({
    topic: state.input.title,
    question: state.input.question,
    sources: state.search.flatMap(result => result.sources),
  }))
  .step('citations', citationCheck, state => ({ citations: state.synthesis.citations }))
  .exit('delivered');

const topicCeilingUsd = 3;
const dailyBudgetUsd = 40;

const topics = H.lane('topics').of(Topic)
  .from(manual('operator-topics'))
  .store(sqlite.store('.harness/topics.db'))
  .handle(research, {
    exits: { delivered, parked },
    retry: { retries: 1, backoff: { initial: '10m', factor: 2 }, exhausted: failed },
  })
  .ceiling({ maxUsd: topicCeilingUsd, onExceed: topicOverBudget });

const reopenRecurring = H.trigger('reopen-recurring-topics')
  .on(H.time.every('0 6 * * 1'))
  .do(topics.move({ state: delivered, where: data => data.tags.includes('recurring') }, queued));

const spendToday = H.metric('spend-today', H.events.invocations()).sum(event => event.costUsd).window('calendarDay');
const topicCost = H.metric('topic-cost', H.events.attempts(topics).where(event => event.outcome === 'succeeded'))
  .mean(event => event.costUsd)
  .by('kind')
  .window('30d');

const projectionSamples = 5;

const withinDailyBudget = H.policy.units('within-daily-budget', choice => {
  const spent = choice.metrics.read(spendToday).value ?? 0;
  const mean = choice.metrics.read(topicCost, Topic);
  const projected = mean.samples >= projectionSamples && mean.value !== undefined ? mean.value : topicCeilingUsd;
  return choice.candidates
    .filter(candidate => !topics.holds(candidate) || spent + projected <= dailyBudgetUsd)
    .sort((a, b) => a.queuedAt.getTime() - b.queuedAt.getTime());
});

const nearestFindings = H.policy.recall('nearest-findings', choice =>
  [...choice.candidates]
    .filter(candidate => candidate.similarity !== undefined)
    .sort((a, b) => (b.similarity ?? 0) - (a.similarity ?? 0) || b.specificity - a.specificity)
    .slice(0, choice.limit));

const findingsJournal = H.journal('report-findings').of(findings)
  .store(pgvector.memory({
    url: H.env('FINDINGS_DATABASE_URL'),
    table: 'report_findings',
    embeddingModel: 'text-embedding-3-small',
    embeddingKey: H.env('EMBEDDING_API_KEY'),
  }))
  .recall(nearestFindings);
const sourceJournal = H.journal('source-lessons').of(sourceLessons)
  .store(jsonl.memory('.harness/source-lessons.jsonl'))
  .recall(policies.specificity({ limit: 6 }));

const operator = claudeCode.client({ name: 'research-operator' });

export const researchPipeline = H.harness('research-pipeline')
  .ledger(sqlite.ledger('.harness/ledger.db'))
  .pools(apiPool)
  .lanes(topics)
  .journals(findingsJournal, sourceJournal)
  .triggers(reopenRecurring)
  .scheduler(withinDailyBudget)
  .grants(H.grant(
    operator,
    H.ops.work.read,
    H.ops.work.write,
    H.ops.resolve(topicOverBudget),
    H.ops.memory.read(findings),
    H.ops.memory.write(sourceLessons),
    H.ops.telemetry.read,
  ))
  .observe(observers.board({ path: 'BOARD.md' }), observers.telemetry({ path: 'TELEMETRY.md' }));

void researchPipeline.start();

export const withdrawnState = withdrawn;
