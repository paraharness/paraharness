import { z } from 'zod';
import { H } from 'harness-dsl';
import { anthropic } from 'harness-dsl/anthropic';
import { sqlite } from 'harness-dsl/sqlite';
import { jsonl } from 'harness-dsl/jsonl';
import { pgvector } from 'harness-dsl/pgvector';
import { manual } from 'harness-dsl/supply';
import { claudeCode } from 'harness-dsl/claude-code';
import { policies } from 'harness-dsl/policies';
import { observers } from 'harness-dsl/observers';

const topic = z.object({ title: z.string(), question: z.string(), tags: z.array(z.string()) });
const source = z.object({ url: z.string(), claim: z.string() });
type TopicData = z.infer<typeof topic>;

const queued = H.state('queued').pending();
const researching = H.state('researching').active();
const delivered = H.state('delivered').terminal('success');
const parked = H.state('parked').terminal('neutral');
const cancelled = H.state('cancelled').terminal('neutral');
const unresolved = H.state('unresolved').terminal('failure');

const Topic = H.work('topic').schema(topic).states(queued, researching, delivered, parked, cancelled, unresolved);

const costCeiling = H.halt('topic-cost-ceiling')
  .context(z.object({ topic: z.string(), spentUsd: z.number(), nextStep: z.string() }))
  .decision(z.object({ continue: z.boolean() }))
  .ask(context => `Topic ${context.topic} has spent $${context.spentUsd}; continue to ${context.nextStep}?`);

const finding = H.memory('finding').content(z.object({ claim: z.string(), source: z.string() })).trust('experience');
const sourceLesson = H.memory('source-lesson').content(z.object({ rule: z.string() })).trust('experience');

const apiAccount = H.account('api', anthropic.api({ apiKey: H.env('ANTHROPIC_API_KEY') }));
const haiku = H.model('claude-haiku-4-5').pricing(anthropic.pricing());
const opus = H.model('claude-opus-4-1').pricing(anthropic.pricing());
const sonnet = H.model('claude-sonnet-4-5').pricing(anthropic.pricing());

const searcher = H.role('searcher').promptFile('prompts/searcher.md').intents(['web']).recall(sourceLesson);
const synthesizer = H.role('synthesizer').promptFile('prompts/synthesizer.md').recall(finding, sourceLesson).record(sourceLesson);

const searchAndExtract = H.skill('search-and-extract')
  .input(z.object({ question: z.string(), angle: z.number() }))
  .output(z.object({ sources: z.array(source) }))
  .prompt(input => `Search angle ${input.angle} of 20 for: ${input.question}. Extract sourced claims.`);
const synthesize = H.skill('synthesize')
  .input(z.object({ question: z.string(), sources: z.array(source) }))
  .output(z.object({ report: z.string(), citations: z.array(z.string()), findings: z.array(source) }))
  .prompt(input => `Write a sourced report answering: ${input.question}\n\n${input.sources.map(s => `- ${s.claim} (${s.url})`).join('\n')}`);

const citationCheck = H.command('citation-check')
  .input(z.object({ citations: z.array(z.string()) }))
  .output(z.object({ resolved: z.number() }))
  .effect('repeatable')
  .run(async input => {
    const results = await Promise.all(input.citations.map(url => fetch(url, { method: 'HEAD' }).then(response => response.ok, () => false)));
    const broken = input.citations.filter((_url, index) => !results[index]);
    if (broken.length > 0) throw new Error(`Unresolved citations: ${broken.join(', ')}`);
    return { resolved: input.citations.length };
  });

const deliverReport = H.command('deliver-report')
  .input(z.object({ path: z.string(), report: z.string() }))
  .output(z.object({ path: z.string() }))
  .effect('repeatable')
  .run(async (input, ctx) => {
    const result = await ctx.exec(['tee', input.path], { stdin: input.report });
    if (result.code !== 0) throw new Error(result.stderr);
    return { path: input.path };
  });

const recordFindings = H.command('record-findings')
  .input(z.object({ findings: z.array(source) }))
  .output(z.object({ recorded: z.number() }))
  .effect('repeatable')
  .run(async (input, ctx) => {
    input.findings.forEach(item => ctx.remember(finding, { claim: item.claim, source: item.url }, { kinds: [Topic] }));
    return { recorded: input.findings.length };
  });

const citationPass = H.metric('citation-pass', H.events.steps(citationCheck))
  .rate(event => event.outcome === 'completed')
  .by('model')
  .window('30d');

const citationPassLeader = H.policy.models('citation-pass-leader', choice =>
  choice.candidates
    .map(model => ({ model, reading: choice.metrics.read(citationPass, { model: model.name }) }))
    .sort((a, b) => {
      const exploring = a.reading.samples < 30 || b.reading.samples < 30;
      return exploring ? a.reading.samples - b.reading.samples : (b.reading.value ?? 0) - (a.reading.value ?? 0);
    })
    .map(ranked => ranked.model));

const searchSeat = H.seat('search-seat').role(searcher).skill(searchAndExtract).models(haiku);
const synthesizerSeat = H.seat('synthesizer-seat').role(synthesizer).skill(synthesize).models(opus, sonnet).policy(citationPassLeader);
const searchBatch = H.job('search-batch').batch(searchSeat);

const research = H.flow('research')
  .input(topic)
  .step('search', searchBatch, state => Array.from({ length: 20 }, (_unused, angle) => ({ question: state.input.question, angle })))
  .when(state => state.search.flatMap(result => result.sources).length < 5, thin => thin.exit('parked'))
  .step('synthesis', synthesizerSeat, state => ({ question: state.input.question, sources: state.search.flatMap(result => result.sources) }))
  .step('citations', citationCheck, state => ({ citations: state.synthesis.citations }))
  .step('delivery', deliverReport, (state, ctx) => ({ path: `reports/${ctx.unit.key}.md`, report: state.synthesis.report }))
  .step('findings', recordFindings, state => ({ findings: state.synthesis.findings }))
  .exit('delivered');

const topics = H.lane('topics').of(Topic)
  .from(manual<TopicData>('operator-topics'))
  .store(sqlite.store<TopicData>('.harness/topics.sqlite'))
  .handle(research, {
    exits: { delivered, parked },
    retry: { retries: 1, backoff: { initial: '5m', factor: 2 }, exhausted: unresolved },
  })
  .ceiling({
    maxUsd: 3,
    onExceed: costCeiling,
    context: spent => ({ topic: spent.unit.key, spentUsd: spent.spentUsd, nextStep: spent.nextStep }),
  });

const weeklyReopen = H.trigger('weekly-reopen-recurring')
  .on(H.time.every('0 6 * * 1'))
  .do(
    topics.move({ state: delivered, where: data => data.tags.includes('recurring') }, queued),
    topics.move({ state: parked, where: data => data.tags.includes('recurring') }, queued),
  );

const meanSucceededCost = H.metric('mean-succeeded-topic-cost', H.events.attempts(topics).where(event => event.outcome === 'succeeded'))
  .mean(event => event.costUsd)
  .window('30d');
const spendToday = H.metric('spend-today', H.events.invocations())
  .sum(event => event.costUsd)
  .window('calendarDay');

const dailyBudgetUsd = 40;
const topicCeilingUsd = 3;

const withinDailyBudget = H.policy.units('within-daily-budget', choice => {
  const mean = choice.metrics.read(meanSucceededCost);
  const projected = mean.samples >= 5 && mean.value !== undefined ? mean.value : topicCeilingUsd;
  const spent = choice.metrics.read(spendToday).value ?? 0;
  const remaining = dailyBudgetUsd - spent - projected * choice.active.length;
  const affordable = projected > 0 ? Math.max(0, Math.floor(remaining / projected)) : choice.candidates.length;
  return [...choice.candidates].sort((a, b) => a.queuedAt.getTime() - b.queuedAt.getTime()).slice(0, affordable);
});

const nearestFindings = H.policy.recall('nearest-findings', choice =>
  [...choice.candidates]
    .filter(candidate => (candidate.similarity ?? 0) >= 0.75)
    .sort((a, b) => (b.similarity ?? 0) - (a.similarity ?? 0) || b.specificity - a.specificity)
    .slice(0, choice.limit));

const operator = claudeCode.client({ name: 'operator' });

export const harness = H.harness('research-pipeline')
  .ledger(sqlite.ledger('.harness/ledger.sqlite'))
  .pools(H.pool('api', [apiAccount]).serves(haiku, opus, sonnet))
  .lanes(topics)
  .journals(
    H.journal('findings-journal').of(finding)
      .store(pgvector.memory({ url: H.env('FINDINGS_DATABASE_URL'), table: 'findings', embeddingModel: 'voyage-3', embeddingKey: H.env('VOYAGE_API_KEY'), dimensions: 1024 }))
      .recall(nearestFindings),
    H.journal('source-lessons-journal').of(sourceLesson).store(jsonl.memory('.harness/source-lessons.jsonl')).recall(policies.specificity({ limit: 6 })),
  )
  .triggers(weeklyReopen)
  .scheduler(withinDailyBudget)
  .grants(H.grant(operator, H.ops.work.read, H.ops.work.write, H.ops.resolve(costCeiling), H.ops.telemetry.read))
  .observe(observers.board({ path: 'BOARD.md' }), observers.telemetry({ path: 'TELEMETRY.md' }));

export const cancelledState = cancelled;
export default harness;
