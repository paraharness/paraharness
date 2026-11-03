import { z } from 'zod';
import { H } from 'harness-dsl';
import * as cc from 'harness-dsl/claude-code';
import * as anthropic from 'harness-dsl/anthropic';
import * as sqlite from 'harness-dsl/sqlite';
import * as jsonl from 'harness-dsl/jsonl';
import * as ssh from 'harness-dsl/ssh';
import * as shell from 'harness-dsl/shell';
import * as markdown from 'harness-dsl/markdown';

const queued = H.state('queued', 'pending');
const running = H.state('running', 'active');
const awaitingApproval = H.state('awaitingApproval', 'active');
const loading = H.state('loading', 'active');
const loaded = H.state('loaded', 'terminal', 'success');
const loadedWithWarnings = H.state('loadedWithWarnings', 'terminal', 'success');
const rejected = H.state('rejected', 'terminal', 'failure');
const failed = H.state('failed', 'terminal', 'failure');
const expired = H.state('expired', 'terminal', 'neutral');

const NightlyLoad = H.kind('NightlyLoad')
  .data(z.object({ source: z.string(), night: z.string() }))
  .states(queued, running, awaitingApproval, loading, loaded, loadedWithWarnings, rejected, failed, expired)
  .failsTo('failed', 'rejected');

const sources = ['crm', 'billing', 'inventory', 'payroll'];

const etlHost = ssh.host('etl', { address: 'etl.internal', user: 'etl', key: H.env('ETL_SSH_KEY'), slots: 2 });
const local = shell.local('local', { slots: 2 });

const sourceInput = z.object({ source: z.string() });

const extract = H.command('extract')
  .input(sourceInput)
  .argv((input) => ['etl', 'extract', '--source', input.source])
  .on(etlHost)
  .recovers('rerun');

const validate = H.command('validate')
  .input(sourceInput)
  .argv((input) => ['etl', 'validate', '--source', input.source])
  .on(etlHost);

const load = H.command('load')
  .input(sourceInput)
  .argv((input) => ['etl', 'load', '--source', input.source])
  .on(etlHost)
  .recovers('park');

const verify = H.command('verify')
  .input(sourceInput)
  .output(z.object({ driftPct: z.number() }))
  .argv((input) => ['etl', 'verify', '--source', input.source, '--json'])
  .on(local);

const threeWithBackoff = H.policy.retry('three-with-backoff', (view) =>
  view.failures > 3 ? 'stop' : { retryInMs: 30_000 * 2 ** (view.failures - 1) }
);

const summaryRole = H.role('anomaly-summary')
  .input(z.object({ source: z.string(), report: z.string() }))
  .output(z.object({ summary: z.string() }))
  .prompt((input) => `Summarise the anomalies in tonight's ${input.source} extract in plain language.\n\n${input.report}`);

const approverTaste = H.archive(
  'approver-taste',
  H.memory('approver-taste', 'taste'),
  jsonl.memory('.harness/approver-taste.jsonl')
);

const summarizer = H.agent('anomaly-summarizer', summaryRole)
  .model(anthropic.model('claude-sonnet-4-5'))
  .recalls(H.briefing('approver-briefing', [approverTaste]));

const validationReview = H.halt('validation-review', z.object({ proceed: z.boolean() }));
const loadApproval = H.halt('load-approval', z.object({ approved: z.boolean(), note: z.string().optional() }));

const toleratedDriftPct = 0.5;

const nightlyFlow = H.flow('nightly-load')
  .for(NightlyLoad)
  .does(async (ctx) => {
    const { source } = ctx.unit.data;
    await ctx.move('running');
    const extracted = await ctx.run(extract, { source }, { retry: threeWithBackoff });
    if (!extracted.ok) return ctx.fail(extracted.error, 'failed');
    const validated = await ctx.run(validate, { source });
    const report = validated.ok ? validated.value : validated.error;
    if (!validated.ok) {
      const review = await ctx.halt(validationReview, report);
      if (!review.proceed) return ctx.fail('validation report rejected', 'rejected');
    }
    const summary = await ctx.run(summarizer, { source, report });
    if (!summary.ok) return ctx.fail(summary.error);
    await ctx.move('awaitingApproval');
    const approval = await ctx.halt(loadApproval, summary.value.summary);
    if (!approval.approved) return ctx.fail(approval.note ?? 'rejected by approver', 'rejected');
    await ctx.move('loading');
    const loadResult = await ctx.run(load, { source }, { retry: threeWithBackoff });
    if (!loadResult.ok) return ctx.fail(loadResult.error, 'failed');
    const verified = await ctx.run(verify, { source });
    if (!verified.ok) return ctx.fail(verified.error, 'failed');
    if (verified.value.driftPct === 0) return 'loaded';
    return verified.value.driftPct <= toleratedDriftPct
      ? 'loadedWithWarnings'
      : ctx.fail(`drift ${verified.value.driftPct}% beyond tolerance`, 'failed');
  });

const nightlyClock = H.clock('nightly-0200', NightlyLoad, { daily: '02:00' }, (tick) => {
  const night = tick.now.toISOString().slice(0, 10);
  return sources.map((source) => ({ create: { source, night }, key: `${source}:${night}` }));
});

const nightlyLoads = H.lane('nightly-loads', NightlyLoad)
  .handler(nightlyFlow)
  .suppliers(nightlyClock)
  .store(sqlite.store(NightlyLoad, '.harness/loads.db'));

const approvalCutoff = H.trigger(
  'approval-cutoff-0900',
  H.on.deadline(NightlyLoad, (data) => new Date(`${data.night}T09:00:00`), ['awaitingApproval']),
  (_event, act) => act.move('expired')
);

const dataApi = anthropic.account('data-api', { apiKey: H.env('ANTHROPIC_API_KEY') });

const supervisor = cc.supervisor({
  grants: [H.ops.readWork, H.ops.resolveHalts, H.ops.readMemory, H.ops.writeMemory, H.ops.readTelemetry],
});

export const dataJob = H.harness('nightly-data')
  .ledger(sqlite.ledger('.harness/ledger.db'))
  .lanes(nightlyLoads)
  .pools(H.pool('data', [{ account: dataApi, share: 1 }]))
  .triggers(approvalCutoff)
  .scheduler(H.policy.scheduler('arrival-order', (view) => ({ start: view.pending })))
  .clients(supervisor)
  .observers(markdown.board('BOARD.md'), markdown.telemetry('TELEMETRY.md'));

export const started = dataJob.start();
