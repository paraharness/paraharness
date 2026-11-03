import { H } from 'harness-dsl';
import { z } from 'zod';
import * as anthropic from 'harness-dsl/anthropic';
import * as sqlite from 'harness-dsl/sqlite';
import * as jsonl from 'harness-dsl/jsonl';
import * as shell from 'harness-dsl/shell';
import * as ssh from 'harness-dsl/ssh';
import * as cc from 'harness-dsl/claude-code';
import * as markdown from 'harness-dsl/markdown';

export const scheduled = H.state('scheduled', 'pending');
export const awaitingApproval = H.state('awaitingApproval', 'active');
export const loading = H.state('loading', 'active');
export const loaded = H.state('loaded', 'terminal', 'success');
export const loadedWithWarnings = H.state('loadedWithWarnings', 'terminal', 'success');
export const rejected = H.state('rejected', 'terminal', 'neutral');
export const expired = H.state('expired', 'terminal', 'neutral');
export const loadFailed = H.state('failed', 'terminal', 'failure');

export const NightlyLoad = H.kind('NightlyLoad')
  .data(z.object({
    source: z.string(),
    night: z.string(),
    summary: z.string().optional(),
  }))
  .states(scheduled, awaitingApproval, loading, loaded, loadedWithWarnings, rejected, expired, loadFailed)
  .failsTo('failed');

export const sources = ['billing', 'crm', 'inventory', 'telemetry'] as const;

export const local = shell.local('local', { slots: 2 });
export const warehouseHost = ssh.host('warehouse', {
  address: 'warehouse.internal',
  user: 'etl',
  key: H.env('WAREHOUSE_SSH_KEY'),
  slots: 2,
});

const sourceInput = z.object({ source: z.string() });

export const extract = H.command('extract')
  .input(sourceInput)
  .argv((input) => ['etl', 'extract', '--source', input.source])
  .on(warehouseHost)
  .recovers('rerun');

export const validate = H.command('validate')
  .input(sourceInput)
  .argv((input) => ['etl', 'validate', '--source', input.source])
  .on(local)
  .recovers('rerun');

export const load = H.command('load')
  .input(sourceInput)
  .argv((input) => ['etl', 'load', '--source', input.source])
  .on(warehouseHost)
  .recovers('park');

export const verify = H.command('verify')
  .input(sourceInput)
  .output(z.object({ driftRows: z.number(), tolerable: z.boolean() }))
  .argv((input) => ['etl', 'verify', '--source', input.source, '--json'])
  .on(warehouseHost)
  .recovers('rerun');

export const threeRetriesWithBackoff = H.policy.retry('three-retries-exponential', (view) =>
  view.failures <= 3 ? { retryInMs: 30_000 * 2 ** (view.failures - 1) } : 'stop');

export const noAttemptRetry = H.policy.retry('no-attempt-retry', () => 'stop');

export const approverTaste = H.memory('approver-taste', 'taste');
export const tasteArchive = H.archive('approver-taste', approverTaste, jsonl.memory('.harness/taste.jsonl'));
export const summaryBriefing = H.briefing('summary-briefing', [tasteArchive]);

export const summarizerRole = H.role('anomaly-summarizer')
  .input(z.object({ source: z.string(), report: z.string() }))
  .output(z.object({ summary: z.string() }))
  .prompt((input) => `Summarize the anomalies in tonight's ${input.source} extract in plain language.\n\n${input.report}`);

export const apiAccount = anthropic.account('anthropic-api', { apiKey: H.env('ANTHROPIC_API_KEY') });
export const dataPool = H.pool('data', [{ account: apiAccount, share: 1 }]);

export const summarizer = H.agent('summarizer', summarizerRole)
  .model(anthropic.model('claude-sonnet'))
  .recalls(summaryBriefing);

export const reviewValidation = H.halt('review-validation', z.object({ proceed: z.boolean(), note: z.string() }));
export const approveLoad = H.halt('approve-load', z.object({ approved: z.boolean(), note: z.string().optional() }));

export const nightlyFlow = H.flow('nightly-load').for(NightlyLoad).does(async (ctx) => {
  const { source } = ctx.unit.data;
  const extracted = await ctx.run(extract, { source }, { retry: threeRetriesWithBackoff });
  if (extracted.ok === false) return 'failed';
  const validated = await ctx.run(validate, { source });
  let report = validated.ok ? validated.value : '';
  if (validated.ok === false) {
    const review = await ctx.halt(reviewValidation, `Validation of ${source} failed:\n${validated.error}`);
    if (review.proceed === false) return 'failed';
    report = `Validation failed and the approver chose to proceed (${review.note}):\n${validated.error}`;
  }
  const summarized = await ctx.run(summarizer, { source, report });
  if (summarized.ok === false) return ctx.fail(summarized.error);
  await ctx.update({ summary: summarized.value.summary });
  await ctx.move('awaitingApproval');
  const approval = await ctx.halt(approveLoad, summarized.value.summary);
  if (approval.approved === false) return 'rejected';
  await ctx.move('loading');
  const loadedResult = await ctx.run(load, { source }, { retry: threeRetriesWithBackoff });
  if (loadedResult.ok === false) return 'failed';
  const verified = await ctx.run(verify, { source });
  if (verified.ok === false) return 'failed';
  if (verified.value.driftRows === 0) return 'loaded';
  return verified.value.tolerable ? 'loadedWithWarnings' : 'failed';
});

export const nightlyClock = H.clock('nightly-at-two', NightlyLoad, { daily: '02:00' }, (tick) => {
  const night = tick.now.toISOString().slice(0, 10);
  return sources.map((source) => ({ create: { source, night }, key: `${source}-${night}` }));
});

export const nightlyLane = H.lane('nightly-loads', NightlyLoad)
  .handler(nightlyFlow)
  .suppliers(nightlyClock)
  .store(sqlite.store(NightlyLoad, '.harness/loads.db'))
  .retry(noAttemptRetry);

export const approvalExpiry = H.trigger(
  'approval-expires-at-nine',
  H.on.deadline(NightlyLoad, (data) => new Date(`${data.night}T09:00:00`), ['awaitingApproval']),
  (_event, act) => act.move('expired'),
);

export const fifo = H.policy.scheduler('oldest-first', (view) => ({
  start: [...view.pending].sort((a, b) => b.waitedMs - a.waitedMs),
}));

export const supervisor = cc.supervisor({
  grants: [H.ops.readWork, H.ops.resolveHalts, H.ops.writeMemory, H.ops.readTelemetry],
});

export const dataJob = H.harness('nightly-data')
  .ledger(sqlite.ledger('.harness/ledger.db'))
  .lanes(nightlyLane)
  .pools(dataPool)
  .triggers(approvalExpiry)
  .scheduler(fifo)
  .clients(supervisor)
  .observers(markdown.board('BOARD.md'), markdown.telemetry('TELEMETRY.md'));
