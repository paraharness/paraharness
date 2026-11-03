import { z } from 'zod';
import { H } from 'harness-dsl';
import * as anthropic from 'harness-dsl/anthropic';
import * as claudeCode from 'harness-dsl/claude-code';
import * as sqlite from 'harness-dsl/sqlite';
import * as jsonl from 'harness-dsl/jsonl';
import * as shell from 'harness-dsl/shell';
import * as ssh from 'harness-dsl/ssh';
import * as markdown from 'harness-dsl/markdown';

const scheduled = H.state('scheduled', 'pending');
const loaded = H.state('loaded', 'terminal', 'success');
const loadedWithWarnings = H.state('loaded-with-warnings', 'terminal', 'success');
const rejected = H.state('rejected', 'terminal', 'neutral');
const expired = H.state('expired', 'terminal', 'neutral');
const failed = H.state('failed', 'terminal', 'failure');

export const nightlyLoad = H.kind('nightly-load')
  .data(z.object({ source: z.string(), night: z.string(), approveBy: z.date() }))
  .states(scheduled, loaded, loadedWithWarnings, rejected, expired, failed);

const sourceSystems = ['crm', 'billing', 'inventory', 'support'];

const local = shell.local('local', { slots: 2 });
const etlHost = ssh.host('etl', { address: 'etl.internal', user: 'etl', key: H.env('ETL_SSH_KEY'), slots: 2 });

const backoffThreeTimes = H.retry('backoff-three-times', { retries: 3, backoff: { initialMs: 60_000, factor: 2, maxMs: 900_000 } });
const loadInput = z.object({ source: z.string(), night: z.string() });

const extract = H.command('extract')
  .input(loadInput)
  .argv(input => ['etl', 'extract', '--source', input.source, '--night', input.night])
  .on(etlHost)
  .retry(backoffThreeTimes);

const validate = H.command('validate')
  .input(loadInput)
  .argv(input => ['etl', 'validate', '--source', input.source, '--night', input.night])
  .on(local);

const load = H.command('load')
  .input(loadInput)
  .argv(input => ['etl', 'load', '--source', input.source, '--night', input.night])
  .on(etlHost)
  .retry(backoffThreeTimes);

const verify = H.command('verify')
  .input(loadInput)
  .output(z.object({ driftRows: z.number() }))
  .argv(input => ['etl', 'verify', '--source', input.source, '--night', input.night])
  .on(local);

const approverTaste = H.journal('approver-taste', H.memory('approver-taste', 'taste'), jsonl.memory('memory/approver-taste.jsonl'));

const summarizeRole = H.role('summarize-anomalies')
  .input(z.object({ source: z.string(), night: z.string(), report: z.string() }))
  .output(z.object({ summary: z.string() }))
  .prompt(input => `Summarise the anomalies in the ${input.source} extract for ${input.night} in plain language.\n\n${input.report}`);

const sonnet = anthropic.model('claude-sonnet-4-5');
const loadPool = H.pool('load-api', [{ account: anthropic.account('load-api', { apiKey: H.env('ANTHROPIC_API_KEY') }), share: 1 }]);

const anomalySummarizer = H.seat('anomaly-summarizer', summarizeRole).model(sonnet).recalls(approverTaste);

const validationReview = H.halt('validation-review', z.object({ proceed: z.boolean() })).about(z.object({ report: z.string() }));
const loadApproval = H.halt('load-approval', z.object({ approve: z.boolean(), note: z.string().optional() })).about(
  z.object({ summary: z.string() })
);

const loadPipeline = H.flow('load-pipeline')
  .for(nightlyLoad)
  .does(async ctx => {
    const { source, night } = ctx.unit.data;
    const extracted = await ctx.call(extract, { source, night });
    if (!extracted.ok) return ctx.fail(extracted.error);
    const validated = await ctx.call(validate, { source, night });
    if (!validated.ok) {
      const review = await ctx.halt(validationReview, `Validation failed for ${source} (${night})`, { report: validated.error });
      if (!review.proceed) return 'rejected';
    }
    const summary = await ctx.call(anomalySummarizer, { source, night, report: validated.ok ? validated.value : validated.error });
    if (!summary.ok) return ctx.fail(summary.error);
    const approved = await ctx.halt(loadApproval, `Approve the ${source} load for ${night}`, { summary: summary.value.summary });
    if (!approved.approve) return 'rejected';
    const loadedRows = await ctx.call(load, { source, night });
    if (!loadedRows.ok) return ctx.fail(loadedRows.error);
    const verified = await ctx.call(verify, { source, night });
    if (!verified.ok) return ctx.fail(verified.error);
    return verified.value.driftRows === 0 ? 'loaded' : 'loaded-with-warnings';
  });

const sevenHoursMs = 7 * 60 * 60 * 1000;

export const nightlyLoads = H.lane('nightly-loads', nightlyLoad)
  .handler(loadPipeline)
  .suppliers(
    H.clock('two-am', nightlyLoad, { daily: '02:00' }, tick =>
      sourceSystems.map(source => ({
        create: { source, night: tick.now.toISOString().slice(0, 10), approveBy: new Date(tick.now.getTime() + sevenHoursMs) },
        key: `${source}-${tick.now.toISOString().slice(0, 10)}`,
      }))
    )
  )
  .store(sqlite.store(nightlyLoad, 'nightly-loads.db'))
  .retry(H.retry('no-attempt-retry', { retries: 0 }), 'failed');

const approvalWindowCloses = H.trigger(
  'approval-window-closes',
  H.on.deadline(nightlyLoad, data => data.approveBy, ['scheduled']),
  (_closed, act) => act.move('expired')
);

export const loadOutcomes = H.report('load-outcomes', metrics => ({
  loaded: metrics.count({ of: { entry: 'transition', state: loaded }, days: 30 }),
  loadedWithWarnings: metrics.count({ of: { entry: 'transition', state: loadedWithWarnings }, days: 30 }),
  rejected: metrics.count({ of: { entry: 'transition', state: rejected }, days: 30 }),
  expired: metrics.count({ of: { entry: 'transition', state: expired }, days: 30 }),
  failed: metrics.count({ of: { entry: 'transition', state: failed }, days: 30 }),
}));

const approver = claudeCode.supervisor({
  grants: [
    H.ops.readWork,
    H.ops.resolve(validationReview, loadApproval, H.parked),
    H.ops.readMemory,
    H.ops.writeMemory,
    H.ops.readTelemetry,
  ],
});

export const dataJob = H.harness('nightly-data')
  .ledger(sqlite.ledger('nightly-data.db'))
  .lanes(nightlyLoads)
  .pools(loadPool)
  .triggers(approvalWindowCloses)
  .reports(loadOutcomes)
  .clients(approver)
  .observers(markdown.board('BOARD.md'), markdown.telemetry('TELEMETRY.md'));
