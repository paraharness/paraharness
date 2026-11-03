import { H } from 'harness-dsl';
import { z } from 'zod';
import * as claudeCode from 'harness-dsl/claude-code';
import * as anthropic from 'harness-dsl/anthropic';
import * as sqlite from 'harness-dsl/sqlite';
import * as jsonl from 'harness-dsl/jsonl';
import * as shell from 'harness-dsl/shell';
import * as ssh from 'harness-dsl/ssh';
import * as markdown from 'harness-dsl/markdown';

const Scheduled = H.state('scheduled', 'pending');
const AwaitingApproval = H.state('awaiting-approval', 'active');
const Loading = H.state('loading', 'active');
const Loaded = H.state('loaded', 'terminal', 'success');
const LoadedWithWarnings = H.state('loaded-with-warnings', 'terminal', 'success');
const Rejected = H.state('rejected', 'terminal', 'neutral');
const Expired = H.state('expired', 'terminal', 'neutral');
const LoadFailed = H.state('failed', 'terminal', 'failure');

const NightlyLoad = H.kind('nightly-load')
  .data(z.object({
    source: z.string(),
    night: z.string(),
    approveBy: z.string(),
    summary: z.string().optional(),
  }))
  .states(Scheduled, AwaitingApproval, Loading, Loaded, LoadedWithWarnings, Rejected, Expired, LoadFailed)
  .onFailure('failed', { afterAttempts: 2 });

const tasteMemory = H.memory('approver-taste', 'taste');
const taste = H.library('approver-taste', tasteMemory, jsonl.memory('memory/taste.jsonl'));

const accounts = H.pool('anthropic', [{ account: anthropic.account('api', { apiKey: H.env('ANTHROPIC_API_KEY') }), share: 1 }]);

const local = shell.local('local', { slots: 2 });
const extractHost = ssh.host('extract-host', {
  address: 'etl.internal',
  user: 'etl',
  key: H.env('ETL_SSH_KEY'),
  slots: 2,
});

const exponentialBackoff = H.policy.retry('exponential-backoff', view =>
  view.failures > 3 ? 'stop' : { retryInMs: 30_000 * 2 ** (view.failures - 1) }
);

const job = z.object({ source: z.string(), night: z.string() });

const extract = H.command('extract')
  .input(job)
  .argv(i => ['etl/extract', i.source, i.night])
  .on(extractHost)
  .recover('rerun');

const validate = H.command('validate')
  .input(job)
  .argv(i => ['etl/validate', i.source, i.night])
  .on(local)
  .recover('rerun');

const load = H.command('load')
  .input(job)
  .argv(i => ['etl/load', i.source, i.night])
  .on(local)
  .recover('park');

const verify = H.command('verify')
  .input(job)
  .output(z.object({ driftRows: z.number(), toleratedRows: z.number() }))
  .argv(i => ['etl/verify', '--json', i.source, i.night])
  .on(local)
  .recover('rerun');

const summaryRole = H.role('anomaly-summarizer')
  .input(z.object({ source: z.string(), report: z.string() }))
  .output(z.object({ summary: z.string() }))
  .prompt(i => `Summarise the anomalies in tonight's ${i.source} extract in plain language.\n\n${i.report}`);

const summarizer = H.agent('anomaly-summarizer', summaryRole)
  .model(anthropic.model('claude-sonnet-4-5'))
  .recalls(taste);

const reviewValidation = H.decision('review-validation')
  .input(z.object({ source: z.string(), report: z.string() }))
  .output(z.object({ proceed: z.boolean() }))
  .show(i => `Validation failed for ${i.source}:\n\n${i.report}`);

const approveLoad = H.decision('approve-load')
  .input(z.object({ source: z.string(), night: z.string(), summary: z.string() }))
  .output(z.object({ approved: z.boolean(), note: z.string().optional() }))
  .show(i => `${i.source} ${i.night}\n\n${i.summary}`);

const nightlyLoadFlow = H.flow('nightly-load').for(NightlyLoad).does(async ctx => {
  const { source, night } = ctx.unit.data;
  const extracted = await ctx.run(extract, { source, night }, { retry: exponentialBackoff });
  if (extracted.ok === false) return ctx.fail(extracted.error);
  const validated = await ctx.run(validate, { source, night });
  const report = validated.ok ? validated.value : validated.error;
  if (validated.ok === false) {
    const review = await ctx.decide(reviewValidation, { source, report });
    if (review.proceed === false) return 'rejected';
  }
  const summary = await ctx.run(summarizer, { source, report });
  if (summary.ok === false) return ctx.fail(summary.error);
  await ctx.update({ summary: summary.value.summary });
  await ctx.move('awaiting-approval');
  const approval = await ctx.decide(approveLoad, { source, night, summary: summary.value.summary });
  if (approval.approved === false) return 'rejected';
  await ctx.move('loading');
  const loaded = await ctx.run(load, { source, night }, { retry: exponentialBackoff });
  if (loaded.ok === false) return ctx.fail(loaded.error);
  const verified = await ctx.run(verify, { source, night });
  if (verified.ok === false) return ctx.fail(verified.error);
  if (verified.value.driftRows === 0) return 'loaded';
  return verified.value.driftRows <= verified.value.toleratedRows ? 'loaded-with-warnings' : 'failed';
});

const sources = ['billing', 'crm', 'inventory', 'web-analytics'];
const sevenHoursMs = 7 * 3600_000;

const nightlyClock = H.clock('nightly-clock', NightlyLoad, { daily: '02:00' }, tick => {
  const night = tick.now.toISOString().slice(0, 10);
  const approveBy = new Date(tick.now.getTime() + sevenHoursMs).toISOString();
  return sources.map(source => ({ create: { source, night, approveBy }, key: `${source}@${night}` }));
});

const loads = H.lane('nightly-loads', NightlyLoad)
  .handler(nightlyLoadFlow)
  .suppliers(nightlyClock)
  .store(sqlite.store(NightlyLoad, 'harness/loads.sqlite'));

const unapprovedByNineExpires = H.trigger(
  'unapproved-by-nine-expires',
  H.on.deadline(NightlyLoad, data => new Date(data.approveBy), ['awaiting-approval']),
  (_event, act) => act.move('expired')
);

const oldestFirst = H.policy.scheduler('oldest-first', view => ({
  start: [...view.pending].sort((a, b) => b.waitedMs - a.waitedMs),
}));

const supervisor = claudeCode.supervisor({
  grants: [H.ops.readWork, H.ops.resolveDecisions, H.ops.readMemory, H.ops.writeMemory, H.ops.readTelemetry],
});

export const nightlyData = H.harness('nightly-data')
  .ledger(sqlite.ledger('harness/nightly.sqlite'))
  .lanes(loads)
  .pools(accounts)
  .triggers(unapprovedByNineExpires)
  .scheduler(oldestFirst)
  .clients(supervisor)
  .observers(markdown.board('BOARD.md'), markdown.telemetry('TELEMETRY.md'));
