import { z } from 'zod';
import { H } from 'harness-dsl';
import * as anthropic from 'harness-dsl/anthropic';
import * as cc from 'harness-dsl/claude-code';
import * as sqlite from 'harness-dsl/sqlite';
import * as jsonl from 'harness-dsl/jsonl';
import * as shell from 'harness-dsl/shell';
import * as ssh from 'harness-dsl/ssh';
import * as markdown from 'harness-dsl/markdown';

const hour = 60 * 60 * 1000;
const tolerableDriftPercent = 0.5;

const scheduled = H.state('scheduled', 'pending');
const loaded = H.state('loaded', 'terminal', 'success');
const loadedWithWarnings = H.state('loadedWithWarnings', 'terminal', 'success');
const rejected = H.state('rejected', 'terminal', 'neutral');
const failed = H.state('failed', 'terminal', 'failure');
const expired = H.state('expired', 'terminal', 'neutral');

const loadData = z.object({ source: z.string(), night: z.string(), approvalDeadline: z.date() });
const nightlyLoad = H.kind('NightlyLoad').data(loadData).states(scheduled, loaded, loadedWithWarnings, rejected, failed, expired);

const approverTaste = H.memory('approver-taste', 'taste');
const tasteJournal = H.library('approver-taste-journal', approverTaste, jsonl.memory('memory/approver-taste.jsonl'));

const apiAccount = anthropic.account('data-api', { apiKey: H.env('ANTHROPIC_API_KEY') });
const pool = H.pool('data-models', [{ account: apiAccount, share: 1 }]);
const sonnet = anthropic.model('claude-sonnet-4-5');

const warehouse = ssh.host('warehouse', {
  address: 'warehouse.internal',
  user: 'etl',
  key: H.env('ETL_SSH_KEY'),
  slots: 2,
});
const local = shell.local('local', { slots: 4 });

const exponentialThree = H.policy.invocationRetry('exponential-three', view =>
  view.failedInvocations > 3 ? 'stop' : { retryInMs: 30 * 1000 * 2 ** (view.failedInvocations - 1) }
);

const batchInput = z.object({ source: z.string(), night: z.string() });

const extract = H.command('extract')
  .input(batchInput)
  .argv(input => ['etl', 'extract', input.source, '--night', input.night])
  .on(warehouse)
  .recovery('rerun')
  .retry(exponentialThree);

const validate = H.command('validate')
  .input(batchInput)
  .output(z.object({ report: z.string() }))
  .argv(input => ['etl', 'validate', input.source, '--night', input.night])
  .on(local)
  .recovery('rerun');

const load = H.command('load')
  .input(batchInput)
  .argv(input => ['etl', 'load', input.source, '--night', input.night])
  .on(warehouse)
  .recovery('park')
  .retry(exponentialThree);

const verify = H.command('verify')
  .input(batchInput)
  .output(z.object({ driftPercent: z.number() }))
  .argv(input => ['etl', 'verify', input.source, '--night', input.night])
  .on(local)
  .recovery('rerun');

const summarizerRole = H.role('anomaly-summarizer')
  .input(z.object({ source: z.string(), report: z.string() }))
  .output(z.object({ summary: z.string() }))
  .prompt(input => `Summarize the anomalies in tonight's ${input.source} load in plain language:\n\n${input.report}`);

const summarizer = H.seat('anomaly-summarizer', summarizerRole).model(sonnet).recalls(tasteJournal);

const validationReview = H.halt('validation-review', z.object({ proceed: z.boolean() })).about(z.object({ report: z.string() }));
const loadApproval = H.halt('load-approval', z.object({ approved: z.boolean(), note: z.string() }))
  .about(z.object({ source: z.string(), summary: z.string() }));

const nightly = H.flow('nightly-load')
  .for(nightlyLoad)
  .does(async ctx => {
    const batch = { source: ctx.unit.data.source, night: ctx.unit.data.night };
    const extracted = await ctx.run(extract, batch);
    if (!extracted.ok) return ctx.fail(extracted.error);
    const validated = await ctx.run(validate, batch);
    let report = '';
    if (validated.ok) {
      report = validated.value.report;
    } else {
      const review = await ctx.halt(validationReview, `Validation failed for ${batch.source}`, { report: validated.error });
      if (!review.proceed) return 'rejected';
      report = validated.error;
    }
    const summarized = await ctx.run(summarizer, { source: batch.source, report });
    if (!summarized.ok) return ctx.fail(summarized.error);
    const approval = await ctx.halt(loadApproval, `Approve tonight's ${batch.source} load?`, {
      source: batch.source,
      summary: summarized.value.summary,
    });
    if (!approval.approved) return 'rejected';
    const loading = await ctx.run(load, batch);
    if (!loading.ok) return ctx.fail(loading.error);
    const verified = await ctx.run(verify, batch);
    if (!verified.ok) return ctx.fail(verified.error);
    if (verified.value.driftPercent === 0) return 'loaded';
    if (verified.value.driftPercent <= tolerableDriftPercent) return 'loadedWithWarnings';
    return ctx.fail(`drift of ${verified.value.driftPercent}% exceeds tolerance`);
  });

const nightlyClock = H.clock('nightly-at-0200', nightlyLoad, { daily: '02:00' }, tick => {
  const night = tick.now.toISOString().slice(0, 10);
  const approvalDeadline = new Date(tick.now.getTime() + 7 * hour);
  return ['crm', 'billing', 'inventory', 'web-analytics'].map(source => ({
    create: { source, night, approvalDeadline },
    key: `${source}-${night}`,
  }));
});

const loads = H.lane('nightly-loads', nightlyLoad)
  .handler(nightly)
  .suppliers(nightlyClock)
  .store(sqlite.store(nightlyLoad, '.harness/nightly-loads.sqlite'))
  .wip(4)
  .retry('never', 'failed');

const approvalWindowCloses = H.trigger(
  'approval-window-closes-at-0900',
  H.on.deadline(nightlyLoad, data => data.approvalDeadline, ['scheduled']),
  (event, act) => act.move('expired')
);

const supervisor = cc.supervisor({
  grants: [
    H.ops.readWork,
    H.ops.resolve(validationReview, loadApproval),
    H.ops.readMemory,
    H.ops.writeMemory,
    H.ops.readTelemetry,
  ],
});

export const dataJob = H.harness('nightly-data')
  .ledger(sqlite.ledger('.harness/nightly-data.sqlite'))
  .lanes(loads)
  .pools(pool)
  .triggers(approvalWindowCloses)
  .clients(supervisor)
  .observers(markdown.board('BOARD.md'), markdown.telemetry('TELEMETRY.md'));

export const running = dataJob.start();
