import { z } from 'zod';
import { H, type Metrics, type PendingView, type SupplyOf } from 'harness-dsl';
import * as cc from 'harness-dsl/claude-code';
import * as anthropic from 'harness-dsl/anthropic';
import * as sqlite from 'harness-dsl/sqlite';
import * as jsonl from 'harness-dsl/jsonl';
import * as qdrant from 'harness-dsl/qdrant';
import * as shell from 'harness-dsl/shell';
import * as markdown from 'harness-dsl/markdown';

const queued = H.state('queued', 'pending');
const researching = H.state('researching', 'active');
const delivered = H.state('delivered', 'terminal', 'success');
const parked = H.state('parked', 'terminal', 'neutral');
const cancelled = H.state('cancelled', 'terminal', 'neutral');

const Topic = H.kind('Topic')
  .data(z.object({ question: z.string(), tags: z.array(z.string()), report: z.string().optional() }))
  .states(queued, researching, delivered, parked, cancelled);

const source = z.object({ url: z.string(), claim: z.string() });

const searchRole = H.role('search-and-extract')
  .input(z.object({ question: z.string(), angle: z.number().int() }))
  .output(z.object({ sources: z.array(source) }))
  .prompt((input) => `Search angle ${input.angle} for: ${input.question}. Extract sourced claims.`);

const synthesisRole = H.role('synthesizer')
  .input(z.object({ question: z.string(), sources: z.array(source) }))
  .output(z.object({ report: z.string(), keyFinding: z.string() }))
  .prompt((input) =>
    `Write a sourced report on: ${input.question}\n\n${input.sources.map((s) => `- ${s.claim} (${s.url})`).join('\n')}`);

const findings = H.memory('prior-findings', 'experience');
const sourceLessons = H.memory('source-experience', 'experience');
const priorFindings = H.archive('prior-findings', findings, qdrant.memory({
  url: 'https://vectors.example.com',
  collection: 'findings',
  embedder: 'text-embedding-3-small',
  apiKey: H.env('VECTOR_API_KEY'),
}));
const sourceExperience = H.archive('source-experience', sourceLessons, jsonl.memory('.harness/sources.jsonl'));

const similarThenSpecific = H.policy.recall('similar-then-specific', (view) =>
  [...view.items]
    .sort(
      (a, b) =>
        (b.similarity ?? 0) - (a.similarity ?? 0) ||
        b.specificity - a.specificity ||
        (b.trackRecord.value ?? 0.5) - (a.trackRecord.value ?? 0.5)
    )
    .slice(0, 8)
);

const synthesisBriefing = H.briefing('synthesis-briefing', [priorFindings, sourceExperience], similarThenSpecific);

const haiku = anthropic.model('claude-haiku-4-5');
const sonnet = anthropic.model('claude-sonnet-4-5');
const opus = anthropic.model('claude-opus-4-1');

const local = shell.local('local', { slots: 2 });

const citationCheck = H.command('citation-check')
  .input(z.object({ report: z.string() }))
  .argv((input) => ['cite-check', '--text', input.report])
  .on(local)
  .recovers('rerun');

const synthesisModel = H.tag('synthesis-model');

const citationPassRate = (metrics: Metrics) =>
  metrics.rateBy({
    among: { entry: 'invocation', status: 'ended', executable: citationCheck },
    count: { entry: 'invocation', status: 'ended', executable: citationCheck, ok: true },
    by: synthesisModel,
    days: 30,
  });

const byCitationPassRate = H.policy.model('citation-pass-rate', (choice) => {
  const rates = citationPassRate(choice.metrics);
  const opusRate = rates[opus.name];
  const sonnetRate = rates[sonnet.name];
  if (!opusRate || opusRate.samples < 15) return opus;
  if (!sonnetRate || sonnetRate.samples < 15) return sonnet;
  return (sonnetRate.value ?? 0) >= (opusRate.value ?? 0) ? sonnet : opus;
});

const searcher = H.agent('searcher', searchRole).model(haiku).recalls(H.briefing('search-briefing', [sourceExperience]));
const synthesizer = H.agent('synthesizer', synthesisRole).model(byCitationPassRate).recalls(synthesisBriefing);

const minimumSources = 5;
const searchFanOut = 20;

const research = H.flow('research')
  .for(Topic)
  .does(async (ctx) => {
    await ctx.move('researching');
    const { question } = ctx.unit.data;
    const searches = await ctx.batch(
      searcher,
      Array.from({ length: searchFanOut }, (_, angle) => ({ question, angle }))
    );
    const sources = searches.flatMap((result) => (result.ok ? result.value.sources : []));
    if (sources.length < minimumSources) return 'parked';
    const synthesis = await ctx.run(synthesizer, { question, sources });
    if (!synthesis.ok) return ctx.fail(synthesis.error);
    await ctx.tag(synthesisModel, synthesis.model ?? 'unknown');
    const checked = await ctx.run(citationCheck, { report: synthesis.value.report });
    if (!checked.ok) return ctx.fail(`citation did not resolve: ${checked.error}`);
    await ctx.update({ report: synthesis.value.report });
    await ctx.remember(priorFindings, {
      text: `When researching "${question}", start from the finding: ${synthesis.value.keyFinding}`,
      because: 'it was a checked citation in a delivered report',
      when: { kinds: [Topic] },
    });
    return 'delivered';
  });

const reopen = (key: string): SupplyOf<typeof Topic> => ({ update: key, state: 'queued' });

const weeklyRecurring = H.clock('weekly-recurring', Topic, { weekly: { day: 'mon', at: '06:00' } }, (tick) =>
  tick.units
    .filter((unit) => unit.position === 'terminal' && unit.data.tags.includes('recurring'))
    .map((unit) => reopen(unit.key))
);

const topicCeilingUsd = 3;
const dailyBudgetUsd = 40;

const topics = H.lane('topics', Topic)
  .handler(research)
  .suppliers(H.operator, weeklyRecurring)
  .store(sqlite.store(Topic, '.harness/topics.db'))
  .maxUsdPerUnit(topicCeilingUsd);

const withinDailyBudget = H.policy.scheduler('within-daily-budget', (view) => {
  const midnight = new Date(Date.UTC(view.now.getUTCFullYear(), view.now.getUTCMonth(), view.now.getUTCDate()));
  const spent = view.metrics.sum({ of: 'costUsd', among: { entry: 'invocation', kind: Topic }, since: midnight });
  const projected = view.metrics.mean({
    of: 'costUsd',
    among: { entry: 'attempt', kind: Topic, outcome: 'succeeded' },
    days: 30,
  });
  const perTopic = projected.value ?? topicCeilingUsd;
  let remaining = dailyBudgetUsd - spent.value - perTopic * view.active.length;
  const start: PendingView[] = [];
  for (const unit of view.pending) {
    if (perTopic > remaining) break;
    start.push(unit);
    remaining -= perTopic;
  }
  return { start };
});

const researchApi = anthropic.account('research-api', { apiKey: H.env('ANTHROPIC_API_KEY') });

const supervisor = cc.supervisor({
  grants: [H.ops.readWork, H.ops.writeWork, H.ops.readMemory, H.ops.curateMemory, H.ops.readTelemetry],
});

export const researchPipeline = H.harness('research-pipeline')
  .ledger(sqlite.ledger('.harness/ledger.db'))
  .lanes(topics)
  .pools(H.pool('research', [{ account: researchApi, share: 1 }]))
  .scheduler(withinDailyBudget)
  .clients(supervisor)
  .observers(markdown.board('BOARD.md'), markdown.telemetry('TELEMETRY.md'));

export const running = researchPipeline.start();
