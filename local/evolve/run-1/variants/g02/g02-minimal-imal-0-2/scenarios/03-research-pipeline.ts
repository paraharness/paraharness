import { H } from 'harness-dsl';
import type { Model } from 'harness-dsl';
import { z } from 'zod';
import * as anthropic from 'harness-dsl/anthropic';
import * as claudeCode from 'harness-dsl/claude-code';
import * as sqlite from 'harness-dsl/sqlite';
import * as jsonl from 'harness-dsl/jsonl';
import * as qdrant from 'harness-dsl/qdrant';
import * as shell from 'harness-dsl/shell';
import * as markdown from 'harness-dsl/markdown';

const Topic = H.kind('Topic')
  .data(
    z.object({
      question: z.string(),
      tags: z.array(z.string()),
      report: z.string().optional(),
    })
  )
  .states(
    [
      H.state.pending('queued'),
      H.state.active('searching'),
      H.state.active('synthesizing'),
      H.state.active('checking'),
      H.state.terminal('reported', 'success'),
      H.state.terminal('parked', 'neutral'),
      H.state.terminal('cancelled', 'neutral'),
    ],
    'queued'
  );

const Finding = H.memory('prior-finding', 'fallible').data(
  z.object({ topic: z.string(), confidence: z.number() })
);
const SourceExperience = H.memory('source-experience', 'fallible');

const mostSimilar = H.policy.recall('most-similar-findings', view =>
  [...view.items]
    .filter(item => (item.similarity ?? 0) >= 0.75)
    .sort((a, b) => (b.similarity ?? 0) - (a.similarity ?? 0) || b.specificity - a.specificity)
    .slice(0, 8)
);

const specificFirst = H.policy.recall('specific-then-proven', view =>
  [...view.items]
    .sort(
      (a, b) =>
        b.specificity - a.specificity ||
        (b.trackRecord.value ?? 0.5) - (a.trackRecord.value ?? 0.5)
    )
    .slice(0, 10)
);

const findings = H.library(
  'report-findings',
  Finding,
  qdrant.memory({
    url: 'https://vectors.example.com',
    collection: 'research-findings',
    embedder: 'text-embedding-3-small',
    apiKey: H.env('QDRANT_API_KEY'),
  })
).recall(mostSimilar);

const sourceLessons = H.library(
  'source-lessons',
  SourceExperience,
  jsonl.memory('memory/sources.jsonl')
).recall(specificFirst);

const haiku = anthropic.model('claude-haiku-4-5');
const opus = anthropic.model('claude-opus-4-1');
const sonnet = anthropic.model('claude-sonnet-4-5');

const findingSchema = z.object({
  claim: z.string(),
  source: z.string(),
  confidence: z.number(),
});

const extractorRole = H.role('search-and-extract')
  .input(z.object({ question: z.string(), angle: z.number() }))
  .output(z.object({ findings: z.array(findingSchema) }))
  .prompt(input => `Search angle ${input.angle} of 20 for: ${input.question}. Extract sourced findings.`)
  .intents(['browse']);

const synthesizerRole = H.role('synthesizer')
  .input(z.object({ question: z.string(), findings: z.array(findingSchema) }))
  .output(
    z.object({
      markdown: z.string(),
      citations: z.array(z.string()),
      keyFindings: z.array(z.object({ claim: z.string(), confidence: z.number() })),
    })
  )
  .prompt(
    input =>
      `Write a sourced report answering: ${input.question}\n\nFindings:\n${input.findings
        .map(finding => `- ${finding.claim} (${finding.source}, ${finding.confidence})`)
        .join('\n')}`
  );

const local = shell.local('local', { slots: 2 });

const citationCheck = H.command('citation-check')
  .input(z.object({ citations: z.array(z.string()) }))
  .argv(input => ['scripts/check-citations.sh', ...input.citations])
  .on(local)
  .restart('rerun');

const citationPassRate = H.policy.model('citation-pass-rate', choice => {
  const passRate = (model: Model) =>
    choice.metrics.rate({
      among: {
        entry: 'invocation',
        executable: citationCheck.name,
        status: 'ended',
        tags: { synthesizer: model.name },
      },
      count: { ok: true },
      days: 30,
    });
  const first = passRate(opus);
  const second = passRate(sonnet);
  if (first.samples < 15) return opus;
  if (second.samples < 15) return sonnet;
  return (first.value ?? 0) >= (second.value ?? 0) ? opus : sonnet;
});

const extractor = H.agent('extractor', extractorRole).model(haiku).recalls(sourceLessons);
const synthesizer = H.agent('synthesizer', synthesizerRole)
  .model(citationPassRate)
  .recalls(findings, sourceLessons);

const minimumFindings = 8;

const researchFlow = H.flow('research')
  .for(Topic)
  .does(async ctx => {
    const { question } = ctx.unit.data;
    await ctx.move('searching');
    const extracted = await ctx.batch(
      extractor,
      Array.from({ length: 20 }, (_, angle) => ({ question, angle }))
    );
    const gathered = extracted.flatMap(result => (result.ok ? result.value.findings : []));
    if (gathered.length < minimumFindings) return 'parked';

    await ctx.move('synthesizing');
    const report = await ctx.run(synthesizer, { question, findings: gathered });
    if (!report.ok) return ctx.fail(report.error);
    ctx.tag({ synthesizer: report.model ?? 'unknown' });

    await ctx.move('checking');
    const check = await ctx.run(citationCheck, { citations: report.value.citations });
    if (!check.ok) return ctx.fail(`unresolved citations: ${check.error}`);

    await ctx.update({ report: report.value.markdown });
    for (const finding of report.value.keyFindings) {
      await ctx.remember(findings, {
        text: `When researching "${question}", start from: ${finding.claim}`,
        because: `the report for topic ${ctx.unit.key} established it with confidence ${finding.confidence}`,
        when: { kinds: [Topic], roles: [synthesizerRole] },
        data: { topic: question, confidence: finding.confidence },
      });
    }
    return 'reported';
  });

const weeklyRecurring = H.timetable('weekly-recurring', Topic, { weekly: { day: 'mon', at: '06:00' } }, tick =>
  tick.units
    .filter(unit => unit.data.tags.includes('recurring') && (unit.state === 'reported' || unit.state === 'parked'))
    .map(unit => ({ update: unit.key, state: 'queued' }))
);

const topics = H.lane('topics', Topic)
  .handler(researchFlow)
  .suppliers(H.operator, weeklyRecurring)
  .store(sqlite.store(Topic, '.harness/topics.sqlite'))
  .maxUsdPerUnit(3);

const dailyBudgetUsd = 40;
const topicCeilingUsd = 3;

const withinDailyBudget = H.policy.scheduler('within-daily-budget', view => {
  const midnight = new Date(view.now);
  midnight.setHours(0, 0, 0, 0);
  const spent = view.metrics.sum({ of: 'costUsd', among: { entry: 'invocation' }, since: midnight }).value ?? 0;
  const succeeded = view.metrics.mean({
    of: 'costUsd',
    among: { entry: 'attempt', kind: Topic.name, outcome: 'succeeded' },
    days: 30,
  });
  const projected = succeeded.samples >= 5 && succeeded.value !== null ? succeeded.value : topicCeilingUsd;
  const committed = view.active.length * projected;
  const affordable = Math.max(0, Math.floor((dailyBudgetUsd - spent - committed) / projected));
  return { start: [...view.pending].sort((a, b) => b.waitedMs - a.waitedMs).slice(0, affordable) };
});

const pool = H.pool(
  'api',
  [{ account: anthropic.account('research-api', { apiKey: H.env('ANTHROPIC_API_KEY') }), share: 1 }],
  H.policy.account('first-eligible', choice => {
    const eligible = choice.accounts.find(view => view.eligible);
    return eligible ? eligible.account : null;
  })
);

const supervisor = claudeCode.supervisor({
  grants: [H.ops.readWork, H.ops.writeWork, H.ops.readMemory, H.ops.writeMemory, H.ops.readTelemetry],
});

export const researchPipeline = H.harness('research-pipeline')
  .ledger(sqlite.ledger('.harness/ledger.sqlite'))
  .lanes(topics)
  .pools(pool)
  .scheduler(withinDailyBudget)
  .clients(supervisor)
  .observers(markdown.board('BOARD.md'), markdown.telemetry('TELEMETRY.md'));
