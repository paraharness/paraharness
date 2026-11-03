import { H } from 'harness-dsl';
import type { SupplyOf } from 'harness-dsl';
import { z } from 'zod';
import * as anthropic from 'harness-dsl/anthropic';
import * as claude from 'harness-dsl/claude-code';
import * as sqlite from 'harness-dsl/sqlite';
import * as jsonl from 'harness-dsl/jsonl';
import * as shell from 'harness-dsl/shell';
import * as ssh from 'harness-dsl/ssh';
import * as markdown from 'harness-dsl/markdown';

const loadQueued = H.state('load-queued', 'pending');
const extracting = H.state('load-extracting', 'active');
const validating = H.state('load-validating', 'active');
const summarizing = H.state('load-summarizing', 'active');
const awaitingApproval = H.state('load-awaiting-approval', 'active');
const loading = H.state('load-loading', 'active');
const verifying = H.state('load-verifying', 'active');
const loaded = H.state('loaded', 'terminal', 'success');
const loadedWithWarnings = H.state('loaded-with-warnings', 'terminal', 'success');
const rejected = H.state('load-rejected', 'terminal', 'neutral');
const failed = H.state('load-failed', 'terminal', 'failure');
const expired = H.state('load-expired', 'terminal', 'neutral');

export const NightlyLoad = H.kind('nightly-load')
  .data(z.object({ source: z.string(), night: z.string(), anomalies: z.string().nullable() }))
  .states(
    loadQueued, extracting, validating, summarizing, awaitingApproval, loading, verifying,
    loaded, loadedWithWarnings, rejected, failed, expired,
  )
  .failsTo('load-failed');

const etlHost = ssh.host('etl-host', {
  address: 'etl.internal',
  user: 'etl',
  key: H.env('ETL_SSH_KEY'),
  slots: 2,
});
const local = shell.local('local', { slots: 2 });

const extract = H.command('extract')
  .input(z.object({ source: z.string() }))
  .output(z.object({ stagedPath: z.string() }))
  .argv((input) => ['etl', 'extract', input.source])
  .on(etlHost);

const validate = H.command('validate')
  .input(z.object({ source: z.string(), stagedPath: z.string() }))
  .output(z.object({ passed: z.boolean(), report: z.string() }))
  .argv((input) => ['etl', 'validate', input.source, input.stagedPath])
  .on(local);

const load = H.command('load')
  .input(z.object({ source: z.string(), stagedPath: z.string() }))
  .argv((input) => ['etl', 'load', input.source, input.stagedPath])
  .on(etlHost);

const verify = H.command('verify')
  .input(z.object({ source: z.string() }))
  .output(z.object({ drift: z.enum(['none', 'tolerable', 'excessive']), detail: z.string() }))
  .argv((input) => ['etl', 'verify', input.source])
  .on(local);

const threeRetriesWithBackoff = H.policy.retry('three-retries-with-backoff', ({ failures }) =>
  failures > 3 ? 'stop' : { retryInMs: 60_000 * 2 ** (failures - 1) });

const summaryRole = H.role('anomaly-summarizer')
  .input(z.object({ source: z.string(), report: z.string() }))
  .output(z.object({ summary: z.string() }))
  .prompt((input) => `Summarise the anomalies in tonight's ${input.source} extract in plain language:\n\n${input.report}`);

const approverTaste = H.library('approver-taste', H.memory('approver-taste', 'taste'), jsonl.memory('.harness/taste.jsonl'));

const summarizer = H.agent('anomaly-summarizer', summaryRole)
  .model(anthropic.model('claude-sonnet-4-5'))
  .recalls(approverTaste);

const validationReview = H.halt('validation-review', z.object({ proceed: z.boolean(), note: z.string() }));
const loadApproval = H.halt('load-approval', z.object({ approved: z.boolean(), note: z.string() }));

const nightlyLoadFlow = H.flow('nightly-load').for(NightlyLoad).does(async (ctx) => {
  const { source } = ctx.unit.data;
  await ctx.move('load-extracting');
  const extracted = await ctx.run(extract, { source }, { retry: threeRetriesWithBackoff });
  if (!extracted.ok) return ctx.fail(`extract failed: ${extracted.error}`);
  const { stagedPath } = extracted.value;
  await ctx.move('load-validating');
  const validated = await ctx.run(validate, { source, stagedPath });
  if (!validated.ok) return ctx.fail(`validate could not run: ${validated.error}`);
  if (!validated.value.passed) {
    const review = await ctx.halt(validationReview, validated.value.report);
    if (!review.proceed) return 'load-rejected';
  }
  await ctx.move('load-summarizing');
  const summary = await ctx.run(summarizer, { source, report: validated.value.report });
  if (!summary.ok) return ctx.fail(summary.error);
  await ctx.update({ anomalies: summary.value.summary });
  await ctx.move('load-awaiting-approval');
  const approval = await ctx.halt(loadApproval, summary.value.summary);
  if (!approval.approved) return 'load-rejected';
  await ctx.move('load-loading');
  const loadedResult = await ctx.run(load, { source, stagedPath }, { retry: threeRetriesWithBackoff });
  if (!loadedResult.ok) return ctx.fail(`load failed: ${loadedResult.error}`);
  await ctx.move('load-verifying');
  const verified = await ctx.run(verify, { source });
  if (!verified.ok) return ctx.fail(`verify could not run: ${verified.error}`);
  if (verified.value.drift === 'none') return 'loaded';
  if (verified.value.drift === 'tolerable') return 'loaded-with-warnings';
  return ctx.fail(`verify found excessive drift: ${verified.value.detail}`);
});

const sources = ['crm', 'billing', 'inventory', 'support'];

const nightlyClock = H.clock('nightly-clock', NightlyLoad, { daily: '02:00' }, ({ now }) => {
  const night = now.toISOString().slice(0, 10);
  return sources.map((source): SupplyOf<typeof NightlyLoad> => ({
    create: { source, night, anomalies: null },
    key: `${source}@${night}`,
  }));
});

export const nightlyLoads = H.lane('nightly-loads', NightlyLoad)
  .handler(nightlyLoadFlow)
  .suppliers(nightlyClock)
  .store(sqlite.store(NightlyLoad, '.harness/loads.db'));

const approvalExpires = H.trigger(
  'approval-expires-at-nine',
  H.on.deadline(NightlyLoad, (data) => new Date(`${data.night}T09:00:00`), ['load-awaiting-approval']),
  (_event, act) => act.move('load-expired'),
);

const oldestFirst = H.policy.scheduler('oldest-first', ({ pending }) => ({
  start: [...pending].sort((a, b) => b.waitedMs - a.waitedMs),
}));

const apiAccount = anthropic.account('anthropic-api', { apiKey: H.env('ANTHROPIC_API_KEY') });

const approver = claude.supervisor({
  grants: [H.ops.readWork, H.ops.resolveHalts, H.ops.writeMemory, H.ops.readMemory, H.ops.readTelemetry],
});

export const dataJob = H.harness('nightly-data-job')
  .ledger(sqlite.ledger('.harness/ledger.db'))
  .lanes(nightlyLoads)
  .pools(H.pool('anthropic', [{ account: apiAccount, share: 1 }]))
  .triggers(approvalExpires)
  .scheduler(oldestFirst)
  .clients(approver)
  .observers(markdown.board('.harness/board.md'), markdown.telemetry('.harness/telemetry.md'));

export const running = dataJob.start();
