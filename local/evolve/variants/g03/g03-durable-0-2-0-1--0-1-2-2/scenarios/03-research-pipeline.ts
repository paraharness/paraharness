import { z } from 'zod';
import { H, BatchModel, Rate } from 'harness-dsl';
import { anthropic } from 'harness-dsl/anthropic';
import { claudeCode } from 'harness-dsl/claude-code';
import { sqlite } from 'harness-dsl/sqlite';
import { jsonl } from 'harness-dsl/jsonl';
import { pgvector } from 'harness-dsl/pgvector';
import { voyage } from 'harness-dsl/voyage';
import { local } from 'harness-dsl/local';
import { markdown } from 'harness-dsl/markdown';

const topicAttrs = z.object({ title: z.string(), question: z.string(), recurring: z.boolean() });

const Open = H.state('Open', 'pending');
const Delivered = H.terminal('Delivered', 'success');
const Parked = H.terminal('Parked', 'neutral');
const Cancelled = H.terminal('Cancelled', 'neutral');
const Failed = H.terminal('Failed', 'failure');

const Topic = H.kind('Topic')
  .attributes(topicAttrs)
  .states(Open, Delivered, Parked, Cancelled, Failed)
  .key(a => a.title)
  .initial(Open);

const apiQuota = sqlite.quota('anthropic-api', { path: 'quota.sqlite' });
const apiAccount = anthropic.account('anthropic-api', { apiKey: H.env('ANTHROPIC_API_KEY'), quota: apiQuota });
const apiPool = H.pool('api').accounts(apiAccount);

const haiku = anthropic.model('haiku', { id: 'claude-haiku-4-5' });
const opus = anthropic.model('opus', { id: 'claude-opus-4-1' });
const sonnet = anthropic.model('sonnet', { id: 'claude-sonnet-4-5' });

const searcherRole = H.role('searcher')
  .intents('search', 'browse')
  .instructions('Search for sources on the angle given and extract claims with their URLs.')
  .output(z.object({ sources: z.array(z.object({ url: z.string(), claim: z.string(), confidence: z.number() })) }));
const synthesizerRole = H.role('synthesizer')
  .intents('read', 'record')
  .instructions('Write a sourced report. Every claim cites a URL from the extracted sources.')
  .output(z.object({ report: z.string(), findings: z.array(z.string()) }));

const minimumComparisonSamples = 20;

const synthesizerModel = H.policy.model('synthesizer-model', [opus, sonnet], (ctx): BatchModel => {
  const passRate = (model: BatchModel): Rate =>
    ctx.metrics.rate(citationPassRate, { seat: ctx.seat, model, window: { lastDays: 30 } });
  const opusRecord = passRate(opus);
  const sonnetRecord = passRate(sonnet);
  if (opusRecord.samples < minimumComparisonSamples) return opus;
  if (sonnetRecord.samples < minimumComparisonSamples) return sonnet;
  return opusRecord.rate >= sonnetRecord.rate ? opus : sonnet;
});

const searcher = H.seat('searcher').role(searcherRole).model(haiku).pool(apiPool);
const synthesizer = H.seat('synthesizer').role(synthesizerRole).model(synthesizerModel).pool(apiPool);
const searchAndExtract = H.batch('search-and-extract', searcher);

const localRunner = local.runner('local');
const citationCheck = H.command('citation-check')
  .input(z.object({ report: z.string() }))
  .argv(i => ['./scripts/check-citations', '--report', i.report])
  .runner(localRunner);

const searchAngles = 20;
const minimumSources = 5;

const research = H.flow('research')
  .input(topicAttrs)
  .job('search', searchAndExtract, ctx =>
    Array.from({ length: searchAngles }, (_, i) => ({
      task: `Search angle ${i + 1} of ${searchAngles} for the question: ${ctx.unit.attributes.question}`,
    })),
  )
  .exit('notEnoughSources', ctx => ctx.steps.search.flatMap(r => r.sources).length < minimumSources)
  .step('synthesize', synthesizer, ctx => ({
    task: `Write the report on "${ctx.unit.attributes.title}".\nQuestion: ${ctx.unit.attributes.question}\nSources: ${JSON.stringify(ctx.steps.search.flatMap(r => r.sources))}`,
  }))
  .step('cite', citationCheck, ctx => ({ report: ctx.steps.synthesize.report }), { afterCrash: 'rerun' })
  .exit('delivered');

const perTopicCeilingUsd = 3;
const dailyBudgetUsd = 40;

const topics = H.lane('topics', Topic)
  .supply(H.operator)
  .supply(
    sqlite.scan('recurring-topics', {
      path: 'research.sqlite',
      kind: Topic,
      states: [Delivered, Parked],
      schedule: H.clock('weekly-reopen').at('06:00', { on: 'mon', tz: 'Europe/London' }),
    }),
    (found, to) => (found.attributes.recurring ? to.create(found.attributes) : to.skip()),
  )
  .handler(research, { exits: { notEnoughSources: Parked, delivered: Delivered } })
  .store(sqlite.store({ path: 'research.sqlite' }))
  .retry({ maxAttempts: 2, backoff: 'fixed', initialDelayMs: 600_000, exhausted: Failed })
  .on(H.cancel, { enter: Cancelled })
  .ceiling({ maxUsd: perTopicCeilingUsd, onExceed: 'fail' });

const citationPassRate = H.metric('citation-pass-rate', H.when.step(topics, 'cite')).samples(e => [
  { hit: e.ok, seat: e.seats.synthesize?.seat, model: e.seats.synthesize?.model },
]);

const researchSpend = H.metric('research-spend', H.when.invocation({ lanes: [topics] })).amounts(e => [
  { amount: e.costUsd, seat: e.seat, model: e.model },
]);

const deliveredAttemptCost = H.metric('delivered-attempt-cost', H.when.transition(topics, { to: Delivered })).amounts(e =>
  e.attempt === undefined ? [] : [{ amount: e.attempt.costUsd }],
);

const findings = H.journal('prior-findings', H.memory('report-finding', 'experience'))
  .store(
    pgvector.memoryStore({
      url: H.env('FINDINGS_DATABASE_URL'),
      table: 'findings',
      embedder: voyage.embedder('voyage', { id: 'voyage-3', apiKey: H.env('VOYAGE_API_KEY') }),
    }),
  )
  .recall({ by: 'similarity', limit: 6 })
  .readBy(synthesizerRole);

const sourceExperience = H.journal('source-experience', H.memory('source-experience', 'experience'))
  .store(jsonl.memoryStore({ path: 'memory/sources.jsonl' }))
  .recall({ by: 'specificity', limit: 8 })
  .readBy(searcherRole, synthesizerRole)
  .recordedBy(synthesizerRole);

const deliveredReportsBecomeFindings = H.trigger('delivered-reports-become-findings')
  .on(H.when.step(topics, 'cite', { if: e => e.ok }))
  .record(findings, e => {
    const report = e.outputs.synthesize;
    return report === undefined
      ? undefined
      : {
          text: `When researching a question like "${e.unit.attributes.question}", start from: ${report.findings.join('; ')}, because a delivered report established them with checked citations.`,
          when: { kinds: [Topic] },
        };
  });

const scheduler = H.scheduler('research')
  .standard(topics)
  .admit(topics, ctx => {
    const spentToday = ctx.metrics.total(researchSpend, { window: { calendar: 'day', tz: 'Europe/London' } });
    const delivered = ctx.metrics.total(deliveredAttemptCost, { window: { lastDays: 30 } });
    const projectedUsd = delivered.samples === 0 ? perTopicCeilingUsd : delivered.total / delivered.samples;
    return spentToday.total + projectedUsd <= dailyBudgetUsd;
  });

const operator = claudeCode.supervisor('operator', {
  grants: [H.ops.workRead, H.ops.workCreate, H.ops.workCancel, H.ops.memoryRead, H.ops.memoryWrite, H.ops.telemetryRead],
});

export const harness = H.harness('research-pipeline')
  .ledger(sqlite.ledger({ path: 'harness.sqlite' }))
  .lanes(topics)
  .journals(findings, sourceExperience)
  .triggers(deliveredReportsBecomeFindings)
  .metrics(citationPassRate, researchSpend, deliveredAttemptCost)
  .scheduler(scheduler)
  .clients(operator)
  .observers(markdown.board({ path: 'BOARD.md' }), markdown.telemetry({ path: 'TELEMETRY.md' }));
