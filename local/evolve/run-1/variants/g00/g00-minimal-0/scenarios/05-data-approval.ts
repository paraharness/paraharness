import { z } from 'zod';
import { H } from 'harness-dsl';
import * as anthropic from 'harness-dsl/anthropic';
import * as sqlite from 'harness-dsl/sqlite';
import * as jsonl from 'harness-dsl/jsonl';
import * as ssh from 'harness-dsl/ssh';
import * as shell from 'harness-dsl/shell';
import * as claudeCode from 'harness-dsl/claude-code';
import * as markdown from 'harness-dsl/markdown';

const NightlyLoad = H.kind('NightlyLoad').data(z.object({
  source: z.string(),
  night: z.string(),
})).states({
  queued: 'pending',
  extracting: 'active',
  validating: 'active',
  summarizing: 'active',
  'awaiting-approval': 'active',
  loading: 'active',
  verifying: 'active',
  loaded: 'succeeded',
  'loaded-with-warnings': 'succeeded',
  rejected: 'ended',
  failed: 'failed',
  expired: 'cancelled',
}, 'queued');

const Taste = H.memory('approver-taste', 'owner');
const taste = H.library('approver-taste', Taste, jsonl.memory('memory/taste.jsonl'));

const warehouse = ssh.host('warehouse', {
  address: 'warehouse.internal',
  user: 'etl',
  key: H.env('ETL_SSH_KEY'),
  slots: 2,
});
const local = shell.local('local', { slots: 2 });

const job = z.object({ source: z.string(), night: z.string() });

const extract = H.command('extract').input(job).argv(input => ['etl', 'extract', input.source, input.night]).on(warehouse);
const validate = H.command('validate').input(job).argv(input => ['etl', 'validate', input.source, input.night]).on(local);
const load = H.command('load').input(job).argv(input => ['etl', 'load', input.source, input.night]).on(warehouse);
const verify = H.command('verify')
  .input(job)
  .output(z.object({ driftPercent: z.number() }))
  .argv(input => ['etl', 'verify', '--json', input.source, input.night])
  .on(warehouse);

const exponentialBackoff = H.policy.retry('three-retries-exponential', view =>
  view.failures > 3 ? 'stop' : { retryInMs: 30_000 * 2 ** (view.failures - 1) });

const summaryRole = H.role('anomaly-summary')
  .input(z.object({ source: z.string(), night: z.string(), report: z.string() }))
  .output(z.object({ summary: z.string() }))
  .prompt(input => `Summarise in plain language the anomalies in the ${input.source} load for ${input.night}:\n\n${input.report}`);

const summarizer = H.agent('anomaly-summarizer', summaryRole)
  .model(anthropic.model('claude-sonnet'))
  .recalls(taste);

const tolerableDriftPercent = 0.5;

const nightlyFlow = H.flow('nightly-load').for(NightlyLoad).does(async ctx => {
  const input = ctx.unit.data;
  await ctx.move('extracting');
  const extracted = await ctx.run(extract, input, { retry: exponentialBackoff });
  if (!extracted.ok) return 'failed';
  await ctx.move('validating');
  const validated = await ctx.run(validate, input);
  let report = validated.ok ? validated.value : validated.error;
  if (!validated.ok) {
    const review = await ctx.halt({
      name: 'validation-failed',
      show: validated.error,
      decision: z.object({ proceed: z.boolean(), note: z.string().optional() }),
    });
    if (!review.proceed) return 'rejected';
    report = `${report}\n\nReviewer note: ${review.note ?? ''}`;
  }
  await ctx.move('summarizing');
  const summary = await ctx.run(summarizer, { ...input, report });
  await ctx.move('awaiting-approval');
  const approval = await ctx.halt({
    name: 'approve-load',
    show: summary.ok ? summary.value.summary : report,
    decision: z.object({ approved: z.boolean() }),
  });
  if (!approval.approved) return 'rejected';
  await ctx.move('loading');
  const loaded = await ctx.run(load, input, { retry: exponentialBackoff });
  if (!loaded.ok) return 'failed';
  await ctx.move('verifying');
  const verified = await ctx.run(verify, input);
  if (!verified.ok) return 'failed';
  if (verified.value.driftPercent === 0) return 'loaded';
  return verified.value.driftPercent <= tolerableDriftPercent ? 'loaded-with-warnings' : 'failed';
});

const sources = ['billing', 'crm', 'inventory', 'web-analytics'];

const nightlyLane = H.lane('nightly-loads', NightlyLoad)
  .handler(nightlyFlow)
  .suppliers(H.schedule('two-am', NightlyLoad, { daily: '02:00' }, tick => {
    const night = tick.now.toISOString().slice(0, 10);
    return sources.map(source => ({ create: { source, night }, key: `${source}-${night}` }));
  }))
  .store(sqlite.store(NightlyLoad, '.harness/loads.db'));

const approvalCutoff = H.trigger(
  'approval-cutoff',
  H.on.clock(NightlyLoad, { daily: '09:00' }, ['awaiting-approval']),
  (_event, act) => act.move('expired'),
);

const pool = H.pool('anthropic', [
  { account: anthropic.account('etl-api', { apiKey: H.env('ANTHROPIC_API_KEY') }), share: 1 },
], H.policy.account('first-eligible', choice => choice.accounts.find(view => view.eligible)?.account ?? null));

export const harness = H.harness('nightly-data')
  .ledger(sqlite.ledger('.harness/ledger.db'))
  .lanes(nightlyLane)
  .pools(pool)
  .triggers(approvalCutoff)
  .clients(claudeCode.supervisor({
    grants: [H.ops.readWork, H.ops.resolveHalts, H.ops.readMemory, H.ops.writeMemory, H.ops.readTelemetry],
  }))
  .observers(markdown.board('BOARD.md'), markdown.telemetry('TELEMETRY.md'));
