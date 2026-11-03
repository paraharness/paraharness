import { z } from 'zod';
import { H } from 'harness-dsl';
import * as claude from 'harness-dsl/claude-code';
import * as anthropic from 'harness-dsl/anthropic';
import * as sqlite from 'harness-dsl/sqlite';
import * as jsonl from 'harness-dsl/jsonl';
import * as shell from 'harness-dsl/shell';
import * as ssh from 'harness-dsl/ssh';
import * as markdown from 'harness-dsl/markdown';

const tolerableDriftPercent = 0.5;

const scheduled = H.state('scheduled', 'pending');
const extracting = H.state('extracting', 'active');
const validating = H.state('validating', 'active');
const summarizing = H.state('summarizing', 'active');
const awaitingApproval = H.state('awaiting-approval', 'active');
const loading = H.state('loading', 'active');
const verifying = H.state('verifying', 'active');
const loaded = H.state('loaded', 'terminal', 'success');
const loadedWithWarnings = H.state('loaded-with-warnings', 'terminal', 'success');
const rejected = H.state('rejected', 'terminal', 'neutral');
const failed = H.state('failed', 'terminal', 'failure');
const expired = H.state('expired', 'terminal', 'neutral');

const NightlyLoad = H.kind('nightly-load')
  .data(z.object({ source: z.string(), night: z.string(), approveBy: z.date() }))
  .states(
    scheduled,
    extracting,
    validating,
    summarizing,
    awaitingApproval,
    loading,
    verifying,
    loaded,
    loadedWithWarnings,
    rejected,
    failed,
    expired
  )
  .failsTo('failed');

const local = shell.local('local', { slots: 2 });
const warehouse = ssh.host('warehouse', {
  address: 'warehouse.internal',
  user: 'etl',
  key: H.env('ETL_SSH_KEY'),
  slots: 2,
});

const approverTaste = H.memory('approver-taste', 'taste');
const tasteLibrary = H.library('approver-taste', approverTaste, jsonl.memory('.harness/taste.jsonl'));

const apiAccount = anthropic.account('anthropic-api', { apiKey: H.env('ANTHROPIC_API_KEY') });
const pool = H.pool('anthropic', [{ account: apiAccount, share: 1 }]);

const exponentialBackoff = H.policy.retry('exponential-backoff', ({ failures }) =>
  failures > 3 ? 'stop' : { retryInMs: 30000 * 2 ** (failures - 1) }
);
const stopAtOnce = H.policy.retry('stop-at-once', () => 'stop');

const sourceInput = z.object({ source: z.string(), night: z.string() });

const extract = H.command('extract')
  .input(sourceInput)
  .output(z.object({ rows: z.number() }))
  .argv((input) => ['extract', '--source', input.source, '--night', input.night])
  .on(warehouse)
  .recovery('rerun');

const validate = H.command('validate')
  .input(sourceInput)
  .output(z.object({ passed: z.boolean(), report: z.string() }))
  .argv((input) => ['validate', '--source', input.source, '--night', input.night])
  .on(local)
  .recovery('rerun');

const load = H.command('load')
  .input(sourceInput)
  .argv((input) => ['load', '--source', input.source, '--night', input.night])
  .on(warehouse)
  .recovery('park');

const verify = H.command('verify')
  .input(sourceInput)
  .output(z.object({ driftPercent: z.number() }))
  .argv((input) => ['verify', '--source', input.source, '--night', input.night])
  .on(warehouse)
  .recovery('rerun');

const summarizerRole = H.role('anomaly-summarizer')
  .input(z.object({ source: z.string(), rows: z.number(), report: z.string() }))
  .output(z.object({ summary: z.string() }))
  .prompt((input) => `Summarize anomalies in plain language for the ${input.source} load (${input.rows} rows).\n${input.report}`);

const summarizer = H.agent('anomaly-summarizer', summarizerRole)
  .model(anthropic.model('claude-sonnet-4-5'))
  .recalls(tasteLibrary);

const validationReview = H.halt('validation-review', z.object({ proceed: z.boolean() }));
const loadApproval = H.halt('load-approval', z.object({ approved: z.boolean(), note: z.string().optional() }));

const nightlyLoad = H.flow('nightly-load')
  .for(NightlyLoad)
  .phases('extracting', 'validating', 'summarizing', 'awaitingApproval', 'loading', 'verifying')
  .exits('loaded', 'loadedWithWarnings', 'rejected')
  .does(async (ctx) => {
    const target = { source: ctx.unit.data.source, night: ctx.unit.data.night };
    await ctx.move('extracting');
    const extracted = await ctx.run(extract, target, { retry: exponentialBackoff });
    if (!extracted.ok) return ctx.fail(extracted.error);
    await ctx.move('validating');
    const validated = await ctx.run(validate, target);
    if (!validated.ok) return ctx.fail(validated.error);
    if (!validated.value.passed) {
      const review = await ctx.halt(validationReview, validated.value.report);
      if (!review.proceed) return ctx.fail(`validation rejected: ${validated.value.report}`);
    }
    await ctx.move('summarizing');
    const summary = await ctx.run(summarizer, {
      source: target.source,
      rows: extracted.value.rows,
      report: validated.value.report,
    });
    if (!summary.ok) return ctx.fail(summary.error);
    await ctx.move('awaitingApproval');
    const approval = await ctx.halt(loadApproval, summary.value.summary);
    if (!approval.approved) return 'rejected';
    await ctx.move('loading');
    const loadedRows = await ctx.run(load, target, { retry: exponentialBackoff });
    if (!loadedRows.ok) return ctx.fail(loadedRows.error);
    await ctx.move('verifying');
    const verified = await ctx.run(verify, target);
    if (!verified.ok) return ctx.fail(verified.error);
    if (verified.value.driftPercent === 0) return 'loaded';
    if (verified.value.driftPercent <= tolerableDriftPercent) return 'loadedWithWarnings';
    return ctx.fail(`drift of ${verified.value.driftPercent}% exceeds tolerance`);
  });

const nightlySchedule = H.clock('nightly-schedule', NightlyLoad, { daily: '02:00' }, ({ now }) => {
  const night = now.toISOString().slice(0, 10);
  const approveBy = new Date(now);
  approveBy.setHours(9, 0, 0, 0);
  return ['crm', 'billing', 'inventory', 'support'].map((source) => ({
    create: { source, night, approveBy },
    key: `${source}@${night}`,
  }));
});

const loads = H.lane('nightly-loads', NightlyLoad)
  .handler(nightlyLoad, {
    extracting,
    validating,
    summarizing,
    awaitingApproval,
    loading,
    verifying,
    loaded,
    loadedWithWarnings,
    rejected,
  })
  .suppliers(nightlySchedule)
  .store(sqlite.store(NightlyLoad, '.harness/loads.db'))
  .retry(stopAtOnce);

const approvalExpires = H.trigger(
  'approval-expires-at-nine',
  H.on.deadline(NightlyLoad, (data) => data.approveBy, ['awaiting-approval']),
  (_event, act) => act.move('expired')
);

const supervisor = claude.supervisor({
  grants: [H.ops.readWork, H.ops.resolveHalts, H.ops.readMemory, H.ops.writeMemory, H.ops.readTelemetry],
});

export const dataJob = H.harness('nightly-data-job')
  .ledger(sqlite.ledger('.harness/ledger.db'))
  .lanes(loads)
  .pools(pool)
  .triggers(approvalExpires)
  .clients(supervisor)
  .observers(markdown.board('BOARD.md'), markdown.telemetry('TELEMETRY.md'));

export const running = dataJob.start();
