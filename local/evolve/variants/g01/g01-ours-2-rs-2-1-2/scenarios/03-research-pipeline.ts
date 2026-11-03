import { z } from 'zod';
import { H } from 'harness-dsl';
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
const reported = H.state('reported').terminal('success');
const parked = H.state('parked').terminal('neutral');
const withdrawn = H.state('withdrawn').terminal('neutral');
const overBudget = H.state('over-budget').terminal('failure');
const failed = H.state('failed').terminal('failure');

const topicSchema = z.object({ question: z.string(), tags: z.array(z.string()) });
const topic = H.work('Topic').schema(topicSchema).states(queued, reported, parked, withdrawn, overBudget, failed);

const findings = H.memory('report-findings').content(z.object({ findings: z.array(z.string()) })).trust('experience');
const sourceLessons = H.memory('source-experience').content(z.object({ rule: z.string() })).trust('experience');
const findingsJournal = H.journal('report-findings')
  .of(findings)
  .store(pgvector.memory({ url: H.env('FINDINGS_DB_URL'), table: 'findings', embeddingModel: 'text-embedding-3-small', embeddingKey: H.env('EMBEDDING_KEY'), dimensions: 1536 }))
  .recall(policies.similarity({ minimum: 0.75, limit: 8 }));
const sourceJournal = H.journal('source-experience')
  .of(sourceLessons)
  .store(jsonl.memory('.harness/source-experience.jsonl'))
  .recall(policies.specificity({ limit: 6 }));

const api = H.account('api', anthropic.api({ apiKey: H.env('ANTHROPIC_API_KEY') })).quota(sqlite.quota('.harness/quota.db'));
const haiku = H.model('claude-haiku-4-5').pricing(anthropic.pricing());
const opus = H.model('claude-opus-4-1', { budgetTokens: 32000 }).pricing(anthropic.pricing());
const sonnet = H.model('claude-sonnet-4-5', { budgetTokens: 32000 }).pricing(anthropic.pricing());
const pool = H.pool('anthropic', [api]).share(api, 1).serves(haiku, opus, sonnet);

const sourceSchema = z.object({ url: z.string(), claim: z.string() });

const searchAndExtract = H.skill('search-and-extract')
  .input(z.object({ question: z.string(), angle: z.string() }))
  .output(z.object({ sources: z.array(sourceSchema) }))
  .prompt(i => `Find sources on "${i.question}" from the angle: ${i.angle}. Extract one claim per source.`);
const synthesize = H.skill('synthesize-report')
  .input(z.object({ question: z.string(), evidence: z.array(sourceSchema) }))
  .output(z.object({ report: z.string(), citations: z.array(z.string()), keyFindings: z.array(z.string()) }))
  .prompt(i => `Write a sourced report answering "${i.question}" from ${i.evidence.length} claims.`);

const searcherRole = H.role('searcher').prompt('You find and extract sources.').intents(['web']).recall(sourceLessons);
const synthesizerRole = H.role('synthesizer').prompt('You write sourced reports.').recall(findings, sourceLessons).record(sourceLessons);

const local = runners.local({ name: 'local', slots: 4 });

const citationCheck = H.command('citation-check')
  .input(z.object({ citations: z.array(z.string()), keyFindings: z.array(z.string()) }))
  .output(z.object({ resolved: z.number(), findings: z.array(z.string()) }))
  .runner(local)
  .effect('repeatable')
  .run(async input => {
    const responses = await Promise.all(input.citations.map(url => fetch(url, { method: 'HEAD' })));
    const broken = input.citations.filter((_, index) => !responses[index].ok);
    if (broken.length > 0) throw new Error(`unresolved citations: ${broken.join(', ')}`);
    return { resolved: input.citations.length, findings: input.keyFindings };
  });

const publishReport = H.command('publish-report')
  .input(z.object({ question: z.string(), report: z.string() }))
  .output(z.object({ location: z.string() }))
  .runner(local)
  .effect('repeatable')
  .run(async (input, ctx) => {
    const result = await ctx.exec(['./bin/publish-report', ctx.unit.key], { stdin: `# ${input.question}\n\n${input.report}` });
    if (result.code !== 0) throw new Error(result.stderr);
    return { location: result.stdout.trim() };
  });

const citationAb = H.policy.models('citation-pass-ab', c => {
  const readings = c.candidates.map(model => ({ model, reading: c.metrics.read(citationPass, model) }));
  const unexplored = readings.filter(r => r.reading.samples < 30).sort((a, b) => a.reading.samples - b.reading.samples);
  const ranked = readings.filter(r => r.reading.samples >= 30).sort((a, b) => (b.reading.value ?? 0) - (a.reading.value ?? 0));
  return [...unexplored, ...ranked].map(r => r.model);
});

const searcher = H.seat('searcher').role(searcherRole).skill(searchAndExtract).models(haiku);
const synthesizer = H.seat('synthesizer').role(synthesizerRole).skill(synthesize).models(opus, sonnet).policy(citationAb);
const searchBatch = H.job('search-batch').batch(searcher);

const citationPass = H.metric('citation-pass-rate', H.events.steps(citationCheck).credit(synthesizer))
  .rate(c => c.event.outcome === 'completed')
  .by('model')
  .window('60d');

const angles: readonly string[] = [
  'primary studies', 'systematic reviews', 'meta-analyses', 'government reports', 'industry reports',
  'preprints', 'conference proceedings', 'textbooks', 'standards bodies', 'patent filings',
  'datasets', 'replication attempts', 'critiques', 'historical background', 'recent news',
  'expert interviews', 'regional evidence', 'economic analyses', 'methodology papers', 'open questions',
];

const researchFlow = H.flow('research')
  .input(topicSchema)
  .step('search', searchBatch, s => angles.map(angle => ({ question: s.input.question, angle })))
  .when(s => s.search.flatMap(r => r.sources).length < 5, f => f.exit('parked'))
  .step('synthesize', synthesizer, s => ({ question: s.input.question, evidence: s.search.flatMap(r => r.sources) }))
  .step('cite', citationCheck, s => ({ citations: s.synthesize.citations, keyFindings: s.synthesize.keyFindings }))
  .step('deliver', publishReport, s => ({ question: s.input.question, report: s.synthesize.report }))
  .exit('reported');

const topicBudget = H.halt('topic-budget')
  .context(z.object({ spentUsd: z.number(), nextStep: z.string() }))
  .decision(z.object({ raiseToUsd: z.number().optional() }))
  .ask(c => `Topic spent $${c.spentUsd.toFixed(2)}; ${c.nextStep} would pass $3.`);

const topicCeilingUsd = 3;
const dailyBudgetUsd = 40;

const topics = H.lane('topics').of(topic);

const topicLane = topics
  .from(manual('operator'))
  .store(sqlite.store('.harness/topics.db'))
  .handle(researchFlow, {
    exits: { parked, reported },
    retry: { retries: 1, backoff: { initial: '15m', factor: 2 }, exhausted: failed },
  })
  .ceiling({ maxUsd: topicCeilingUsd, halt: topicBudget, context: c => ({ spentUsd: c.spentUsd, nextStep: c.nextStep }), stopped: overBudget });

const reopenRecurring = H.trigger('reopen-recurring-weekly')
  .on(H.time.every('0 6 * * 1'))
  .do(topics.move({ state: reported, where: data => data.tags.includes('recurring') }, queued));

const recordFindings = H.trigger('record-findings')
  .on(H.events.steps(citationCheck).where(e => e.outcome === 'completed'))
  .do(findingsJournal.record(e => ({ content: { findings: e.output?.findings ?? [] }, when: { kinds: [topic] } })));

const succeededTopicCost = H.metric('succeeded-topic-cost', H.events.attempts(topics).where(a => a.outcome === 'succeeded'))
  .mean(a => a.costUsd)
  .window('30d');
const spendToday = H.metric('spend-today', H.events.invocations()).sum(i => i.costUsd).window('calendarDay');

const withinDailyBudget = H.policy.units('within-daily-budget', c => {
  const projected = Math.max(c.metrics.read(succeededTopicCost).value ?? topicCeilingUsd, 0.01);
  const spent = c.metrics.read(spendToday).value ?? 0;
  const committed = c.active.filter(a => a.lane === topics.name).length * projected;
  const room = Math.floor((dailyBudgetUsd - spent - committed) / projected);
  return [...c.candidates].sort((a, b) => a.queuedAt.getTime() - b.queuedAt.getTime()).slice(0, Math.max(0, room));
});

const operator = H.grant(
  claudeCode.client({ name: 'operator' }),
  H.ops.work.read,
  H.ops.work.write,
  H.ops.resolve(topicBudget),
  H.ops.memory.write(sourceLessons),
  H.ops.telemetry.read,
);

export const research = H.harness('research-pipeline')
  .ledger(sqlite.ledger('.harness/ledger.db'))
  .pools(pool)
  .lanes(topicLane)
  .journals(findingsJournal, sourceJournal)
  .triggers(reopenRecurring, recordFindings)
  .scheduler(withinDailyBudget)
  .grants(operator)
  .observe(observers.board({ path: 'BOARD.md' }), observers.telemetry({ path: 'TELEMETRY.md' }));

void research.start();
