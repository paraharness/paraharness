import { z } from 'zod';
import { H } from 'harness-dsl';
import type { Candidate, ChooseContext, PendingUnit } from 'harness-dsl';
import { anthropic } from 'harness-dsl/anthropic';
import { claudeCode } from 'harness-dsl/claude-code';
import { sqlite } from 'harness-dsl/sqlite';
import { jsonl } from 'harness-dsl/jsonl';
import { lancedb } from 'harness-dsl/lancedb';
import { manual, schedule } from 'harness-dsl/supply';
import { byApplicability, bySimilarity } from 'harness-dsl/policies';
import { board, telemetry } from 'harness-dsl/observers';
import { local } from 'harness-dsl/local';

const topic = z.object({
  title: z.string(),
  question: z.string(),
  tags: z.array(z.string()),
  report: z.string().optional(),
});
type TopicData = z.infer<typeof topic>;

const Queued = H.state('queued').pending();
const Researching = H.state('researching').active();
const Delivered = H.state('delivered').succeeded();
const Parked = H.state('parked').ended();
const CitationsBroken = H.state('citations-broken').failed();
const ResearchFailed = H.state('research-failed').failed();
const Cancelled = H.state('cancelled').cancelled();

const Topic = H.work('topic')
  .schema(topic)
  .states(Queued, Researching, Delivered, Parked, CitationsBroken, ResearchFailed, Cancelled);

const priorFinding = z.object({ whenResearching: z.string(), startFrom: z.string() });
type PriorFindingContent = z.infer<typeof priorFinding>;

const PriorFinding = H.memory('prior-finding').content(priorFinding);
const SourceExperience = H.memory('source-experience').content(
  z.object({ do: z.string(), when: z.string(), because: z.string() }),
);

const priorFindings = H.journal('prior-findings')
  .of(PriorFinding)
  .store(
    lancedb.store<PriorFindingContent>({
      uri: '.harness/vectors',
      table: 'prior_findings',
      text: finding => `${finding.whenResearching}: ${finding.startFrom}`,
      embeddingModel: 'voyage-3',
      apiKey: H.env('VOYAGE_API_KEY'),
    }),
  )
  .recall(bySimilarity({ budgetTokens: 3000, minSimilarity: 0.72 }));
const sourceExperience = H.journal('source-experience')
  .of(SourceExperience)
  .store(jsonl.store('.harness/source-experience.jsonl'))
  .recall(byApplicability({ budgetTokens: 800 }));

const apiAccount = H.account('anthropic-api', anthropic.api({ apiKey: H.env('ANTHROPIC_API_KEY') }));
const haiku = H.model('haiku', apiAccount, 'claude-haiku-4-5');
const opus = H.model('opus', apiAccount, 'claude-opus-4-1');
const sonnet = H.model('sonnet', apiAccount, 'claude-sonnet-4-5');

function byCitationPassRate(ctx: ChooseContext): readonly Candidate[] {
  const scored = ctx.candidates.map(candidate => ({
    candidate,
    stats: ctx.metrics.rate(citationPass, { key: `model:${candidate.name}`, window: '30d' }),
  }));
  const underSampled = scored.find(entry => entry.stats.samples < 30);
  if (underSampled !== undefined) {
    return [underSampled.candidate, ...ctx.candidates.filter(c => c !== underSampled.candidate)];
  }
  return [...scored]
    .sort((a, b) => (b.stats.rate ?? 0) - (a.stats.rate ?? 0))
    .map(entry => entry.candidate);
}

const synthesizerModels = H.pool('synthesizer-models', [opus, sonnet]).policy(
  H.policy.choose('citation-pass-rate', byCitationPassRate),
);

const extractor = H.agent('extractor')
  .role(
    H.role('extractor')
      .prompt('Read the source and extract findings that answer the question, with the exact citation.')
      .tools('fetch-web')
      .recall(SourceExperience),
  )
  .model(haiku);
const synthesizer = H.agent('synthesizer')
  .role(
    H.role('synthesizer')
      .prompt('Write a sourced report. Every claim carries a citation from the findings.')
      .recall(PriorFinding, SourceExperience)
      .record(SourceExperience),
  )
  .model(synthesizerModels);

const extract = H.skill('extract')
  .input(z.object({ url: z.string(), question: z.string() }))
  .output(z.object({ relevant: z.boolean(), finding: z.string(), source: z.string() }))
  .prompt(job => `Question: ${job.question}\nSource: ${job.url}`);

const report = z.object({ report: z.string(), citations: z.array(z.string()) });
const synthesize = H.skill('synthesize')
  .input(z.object({ question: z.string(), findings: z.array(z.string()) }))
  .output(report)
  .prompt(job => `Question: ${job.question}\n\nFindings:\n${job.findings.join('\n')}`);

const localRunner = H.runner('local', local()).slots(4);

const findSources = H.command('find-sources')
  .input(z.object({ question: z.string() }))
  .output(z.object({ urls: z.array(z.string()) }))
  .runner(localRunner)
  .env({ SEARCH_API_KEY: H.env('SEARCH_API_KEY') })
  .run(async ({ input, exec }) => {
    const result = await exec(`search-sources --limit 20 ${JSON.stringify(input.question)}`);
    if (result.exitCode !== 0) {
      throw new Error(result.stderr);
    }
    return { urls: result.stdout.split('\n').filter(line => line.length > 0) };
  });

const checkCitations = H.command('check-citations')
  .input(report)
  .output(z.object({ unresolved: z.array(z.string()) }))
  .runner(localRunner)
  .run(async ({ input, exec }) => {
    const unresolved: string[] = [];
    for (const citation of input.citations) {
      const result = await exec(`curl -fsIL --max-time 15 ${JSON.stringify(citation)}`);
      if (result.exitCode !== 0) {
        unresolved.push(citation);
      }
    }
    return { unresolved };
  });

const minimumRelevantSources = 5;

const research = H.flow('research')
  .for(Topic)
  .transition(Researching)
  .step('find-sources', findSources, { input: (_, ctx) => ({ question: ctx.unit.data.question }) })
  .batch('search-and-extract', {
    items: (found, ctx) => found.urls.slice(0, 20).map(url => ({ url, question: ctx.unit.data.question })),
    run: extract.by(extractor),
    via: 'provider-batch',
  })
  .map(extracted => extracted.filter(finding => finding.relevant))
  .when(
    relevant => relevant.length < minimumRelevantSources,
    thin => thin.transition(Parked),
  )
  .step('synthesize', synthesize.by(synthesizer), {
    input: (relevant, ctx) => ({
      question: ctx.unit.data.question,
      findings: relevant.map(finding => `${finding.source}: ${finding.finding}`),
    }),
  })
  .patch(written => ({ report: written.report }))
  .step('check-citations', checkCitations)
  .transition(check => (check.unresolved.length === 0 ? Delivered : CitationsBroken))
  .onError(ResearchFailed);

const topicCeilingUsd = 3;
const dailyBudgetUsd = 40;

const topics = H.lane('topics')
  .of(Topic)
  .from(
    manual<TopicData>(),
    schedule<TopicData>({ cron: '0 6 * * 1' }, tick =>
      tick.units
        .filter(
          unit =>
            unit.data.tags.includes('recurring') &&
            (unit.state.outcome === 'succeeded' || unit.state.outcome === 'ended'),
        )
        .map(unit => ({ key: unit.key, patch: {}, state: Queued })),
    ),
  )
  .store(sqlite.store<TopicData>({ path: '.harness/topics.db', table: 'topics' }))
  .handle(research)
  .maxUsdPerUnit(topicCeilingUsd, { onExceed: 'fail' });

const citationPass = H.metric('citation-pass')
  .over(topics.enters(Delivered, CitationsBroken))
  .sample(checked => [
    {
      key: `model:${checked.attempt?.models[synthesizer.name] ?? 'unknown'}`,
      hit: checked.to.name === Delivered.name,
    },
  ]);

const deliveredReportsBecomeFindings = H.trigger('delivered-reports-become-findings')
  .on(topics.enters(Delivered))
  .record(priorFindings, delivered => ({
    content: {
      whenResearching: delivered.unit.data.question,
      startFrom: delivered.unit.data.report ?? '',
    },
    when: { kinds: [Topic] },
  }));

const scheduler = H.scheduler('research')
  .concurrency(3)
  .policy(
    H.policy.schedule('within-daily-budget', ctx => {
      const midnight = new Date(ctx.now);
      midnight.setHours(0, 0, 0, 0);
      const spentToday = ctx.metrics.spend({ window: { since: midnight } }).costUsd;
      const history = ctx.metrics.outcomes({ kind: Topic.name, window: '30d' });
      const projectedUsd = history.meanSucceededCostUsd ?? topicCeilingUsd;
      let remainingUsd = dailyBudgetUsd - spentToday - projectedUsd * ctx.active.length;
      const start: PendingUnit[] = [];
      for (const unit of [...ctx.pending].sort((a, b) => a.enqueuedAt.getTime() - b.enqueuedAt.getTime())) {
        if (projectedUsd > remainingUsd) {
          break;
        }
        start.push(unit);
        remainingUsd -= projectedUsd;
      }
      return { start };
    }),
  );

const supervisor = H.supervisor('operator')
  .client(claudeCode.client({ port: 7420 }))
  .grant(H.ops.work.read, H.ops.work.write, H.ops.memory.write, H.ops.telemetry.read);

export const researchPipeline = H.harness('research-pipeline')
  .ledger(sqlite.ledger('.harness/ledger.db'))
  .lanes(topics)
  .journals(priorFindings, sourceExperience)
  .triggers(deliveredReportsBecomeFindings)
  .metrics(citationPass)
  .scheduler(scheduler)
  .supervisor(supervisor)
  .observe(board('BOARD.md'), telemetry('TELEMETRY.md'));

export const running = researchPipeline.start();
