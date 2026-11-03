import { z } from 'zod';
import { H } from 'harness-dsl';
import * as anthropic from 'harness-dsl/anthropic';
import * as cc from 'harness-dsl/claude-code';
import * as sqlite from 'harness-dsl/sqlite';
import * as jsonl from 'harness-dsl/jsonl';
import * as shell from 'harness-dsl/shell';
import * as ssh from 'harness-dsl/ssh';
import * as markdown from 'harness-dsl/markdown';

const Scheduled = H.state('scheduled', 'pending');
const Extracting = H.state('extracting', 'active');
const Validating = H.state('validating', 'active');
const Summarizing = H.state('summarizing', 'active');
const AwaitingApproval = H.state('awaiting-approval', 'active');
const Loading = H.state('loading', 'active');
const Verifying = H.state('verifying', 'active');
const Loaded = H.state('loaded', 'terminal', 'success');
const LoadedWithWarnings = H.state('loaded-with-warnings', 'terminal', 'success');
const Rejected = H.state('rejected', 'terminal', 'neutral');
const Failed = H.state('failed', 'terminal', 'failure');
const Expired = H.state('expired', 'terminal', 'neutral');

const NightlyLoad = H.kind('nightly-load')
  .data(z.object({
    source: z.string(),
    night: z.string(),
    approvalCutoff: z.string(),
    warnings: z.array(z.string()),
  }))
  .states(
    Scheduled, Extracting, Validating, Summarizing, AwaitingApproval, Loading, Verifying,
    Loaded, LoadedWithWarnings, Rejected, Failed, Expired,
  );

const sourceSystems = ['crm', 'billing', 'erp', 'inventory'];

const etl = ssh.host('etl-1', {
  address: 'etl-1.internal',
  user: 'etl',
  key: H.env('ETL_SSH_KEY'),
  slots: 2,
});
const local = shell.local('local', { slots: 2 });

const batchInput = z.object({ source: z.string(), night: z.string() });

const extract = H.command('extract')
  .input(batchInput)
  .argv(i => ['etl', 'extract', i.source, i.night])
  .on(etl)
  .recovery('rerun');

const validate = H.command('validate')
  .input(batchInput)
  .output(z.object({ passed: z.boolean(), report: z.string() }))
  .argv(i => ['etl', 'validate', i.source, i.night])
  .on(local)
  .recovery('rerun');

const loadApplied = H.command('load-applied')
  .input(batchInput)
  .output(z.boolean())
  .argv(i => ['etl', 'load-status', i.source, i.night])
  .on(etl)
  .recovery('rerun');

const load = H.command('load')
  .input(batchInput)
  .argv(i => ['etl', 'load', i.source, i.night])
  .on(etl)
  .recovery(loadApplied);

const verify = H.command('verify')
  .input(batchInput)
  .output(z.object({ drift: z.enum(['none', 'tolerable', 'intolerable']), notes: z.array(z.string()) }))
  .argv(i => ['etl', 'verify', i.source, i.night])
  .on(etl)
  .recovery('rerun');

const exponentialBackoff = H.policy.retry('three-retries-exponential', view =>
  view.failures > 3 ? 'stop' : { retryInMs: 60000 * 2 ** (view.failures - 1) });

const taste = H.memory('approver-taste', 'taste');
const tasteLibrary = H.library('approver-taste', taste, jsonl.memory('memory/approver-taste.jsonl'));

const summarizerRole = H.role('anomaly-summarizer')
  .input(z.object({ source: z.string(), night: z.string(), report: z.string() }))
  .output(z.object({ summary: z.string() }))
  .prompt(i => `Summarize in plain language the anomalies in the ${i.source} load for ${i.night}.\n\n${i.report}`);

const summarizer = H.agent('anomaly-summarizer', summarizerRole)
  .model(anthropic.model('claude-sonnet-4-5'))
  .recalls(tasteLibrary);

const nightlyFlow = H.flow('nightly-load').for(NightlyLoad).does(async ctx => {
  const { source, night } = ctx.unit.data;

  await ctx.move('extracting');
  const extracted = await ctx.run(extract, { source, night }, { retry: exponentialBackoff });
  if (!extracted.ok) return 'failed';

  await ctx.move('validating');
  const validated = await ctx.run(validate, { source, night });
  if (!validated.ok) return ctx.fail(validated.error);
  if (!validated.value.passed) {
    const review = await ctx.halt({
      name: 'validation-failed',
      show: validated.value.report,
      decision: z.object({ proceed: z.boolean() }),
    });
    if (!review.proceed) return 'failed';
  }

  await ctx.move('summarizing');
  const summary = await ctx.run(summarizer, { source, night, report: validated.value.report });
  if (!summary.ok) return ctx.fail(summary.error);

  await ctx.move('awaiting-approval');
  const approval = await ctx.halt({
    name: 'approve-load',
    show: summary.value.summary,
    decision: z.object({ approved: z.boolean(), note: z.string().optional() }),
  });
  if (!approval.approved) return 'rejected';

  await ctx.move('loading');
  const loaded = await ctx.run(load, { source, night }, { retry: exponentialBackoff });
  if (!loaded.ok) return 'failed';

  await ctx.move('verifying');
  const verified = await ctx.run(verify, { source, night });
  if (!verified.ok) return ctx.fail(verified.error);
  if (verified.value.drift === 'none') return 'loaded';
  if (verified.value.drift === 'tolerable') {
    await ctx.update({ warnings: verified.value.notes });
    return 'loaded-with-warnings';
  }
  return 'failed';
});

const nightlyClock = H.clock('nightly-at-two', NightlyLoad, { daily: '02:00' }, tick => {
  const night = tick.now.toISOString().slice(0, 10);
  const cutoff = new Date(tick.now);
  cutoff.setHours(9, 0, 0, 0);
  return sourceSystems.map(source => ({
    create: { source, night, approvalCutoff: cutoff.toISOString(), warnings: [] },
    key: `${source}-${night}`,
  }));
});

const nightlyLoads = H.lane('nightly-loads', NightlyLoad)
  .handler(nightlyFlow)
  .suppliers(nightlyClock)
  .store(sqlite.store(NightlyLoad, '.harness/loads.db'));

const approvalCutoffCancels = H.trigger(
  'approval-cutoff-cancels',
  H.on.deadline(NightlyLoad, data => new Date(data.approvalCutoff), ['awaiting-approval']),
  (_event, act) => act.move('expired'),
);

const oldestFirst = H.policy.scheduler('oldest-first', view => ({
  start: [...view.pending].sort((a, b) => b.waitedMs - a.waitedMs),
}));

const api = H.pool('anthropic', [
  { account: anthropic.account('data-api', { apiKey: H.env('ANTHROPIC_API_KEY') }), share: 1 },
]);

export const harness = H.harness('nightly-data')
  .ledger(sqlite.ledger('.harness/data-ledger.db'))
  .lanes(nightlyLoads)
  .pools(api)
  .triggers(approvalCutoffCancels)
  .scheduler(oldestFirst)
  .clients(cc.supervisor({
    grants: [H.ops.readWork, H.ops.resolveHalts, H.ops.writeMemory, H.ops.readTelemetry],
  }))
  .observers(markdown.board('BOARD.md'), markdown.telemetry('TELEMETRY.md'));
