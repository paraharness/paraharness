import { H } from 'harness-dsl';
import { z } from 'zod';
import * as anthropic from 'harness-dsl/anthropic';
import * as claudeCode from 'harness-dsl/claude-code';
import * as sqlite from 'harness-dsl/sqlite';
import * as jsonl from 'harness-dsl/jsonl';
import * as ssh from 'harness-dsl/ssh';
import * as shell from 'harness-dsl/shell';
import * as markdown from 'harness-dsl/markdown';

const sourceSchema = z.enum(['crm', 'billing', 'inventory', 'hr']);

const NightlyLoad = H.kind('NightlyLoad')
  .data(z.object({ source: sourceSchema, night: z.string() }))
  .states(
    [
      H.state.pending('scheduled'),
      H.state.active('extracting'),
      H.state.active('validating'),
      H.state.active('summarizing'),
      H.state.active('awaiting-approval'),
      H.state.active('loading'),
      H.state.active('verifying'),
      H.state.terminal('loaded', 'success'),
      H.state.terminal('loaded-with-warnings', 'success'),
      H.state.terminal('rejected', 'neutral'),
      H.state.terminal('expired', 'failure'),
      H.state.terminal('failed', 'failure'),
    ],
    'scheduled'
  )
  .onFailure('failed');

const ApproverTaste = H.memory('approver-taste', 'owner');
const approverTaste = H.library('approver-taste', ApproverTaste, jsonl.memory('memory/taste.jsonl')).recall(
  H.policy.recall('specific-first', view => [...view.items].sort((a, b) => b.specificity - a.specificity).slice(0, 8))
);

const etl = ssh.host('etl', {
  address: 'etl.internal',
  user: 'loader',
  key: H.env('ETL_SSH_KEY'),
  slots: 4,
});
const local = shell.local('local', { slots: 2 });

const exponentialThree = H.policy.retry('exponential-backoff-3', view =>
  view.failures > 3 ? 'stop' : { retryInMs: 30_000 * 2 ** (view.failures - 1) }
);

const extract = H.command('extract')
  .input(z.object({ source: sourceSchema, night: z.string() }))
  .argv(input => ['/opt/etl/extract.sh', input.source, input.night])
  .on(etl)
  .restart('rerun');

const validate = H.command('validate')
  .input(z.object({ source: sourceSchema, night: z.string() }))
  .argv(input => ['/opt/etl/validate.sh', input.source, input.night])
  .on(etl)
  .restart('rerun');

const load = H.command('load')
  .input(z.object({ source: sourceSchema, night: z.string() }))
  .argv(input => ['/opt/etl/load.sh', input.source, input.night])
  .on(etl);

const verify = H.command('verify')
  .input(z.object({ source: sourceSchema, night: z.string() }))
  .output(z.object({ driftRatio: z.number() }))
  .argv(input => ['/opt/etl/verify.sh', '--json', input.source, input.night])
  .on(local)
  .restart('rerun');

const summarizerRole = H.role('anomaly-summarizer')
  .input(z.object({ source: z.string(), validationReport: z.string() }))
  .output(z.object({ summary: z.string() }))
  .prompt(
    input =>
      `Summarize the anomalies in tonight's ${input.source} extract in plain language for the approver.\n\n${input.validationReport}`
  );

const summarizer = H.agent('anomaly-summarizer', summarizerRole)
  .model(anthropic.model('claude-sonnet-4-5'))
  .recalls(approverTaste);

const tolerableDriftRatio = 0.01;

const nightlyFlow = H.flow('nightly-load')
  .for(NightlyLoad)
  .does(async ctx => {
    const job = { source: ctx.unit.data.source, night: ctx.unit.data.night };

    await ctx.move('extracting');
    const extracted = await ctx.run(extract, job, { retry: exponentialThree });
    if (!extracted.ok) return ctx.fail(`extract: ${extracted.error}`);

    await ctx.move('validating');
    const validated = await ctx.run(validate, job);
    if (!validated.ok) {
      const call = await ctx.halt({
        name: 'validation-failed',
        show: validated.error,
        decision: z.object({ action: z.enum(['continue', 'reject']) }),
      });
      if (call.action === 'reject') return 'rejected';
    }
    const validationReport = validated.ok ? validated.value : validated.error;

    await ctx.move('summarizing');
    const summary = await ctx.run(summarizer, { source: job.source, validationReport });
    if (!summary.ok) return ctx.fail(`summary: ${summary.error}`);

    await ctx.move('awaiting-approval');
    const approval = await ctx.halt({
      name: 'approve-load',
      show: summary.value.summary,
      decision: z.object({ approved: z.boolean(), note: z.string().optional() }),
    });
    if (!approval.approved) return 'rejected';

    await ctx.move('loading');
    const loaded = await ctx.run(load, job, { retry: exponentialThree });
    if (!loaded.ok) return ctx.fail(`load: ${loaded.error}`);

    await ctx.move('verifying');
    const verified = await ctx.run(verify, job);
    if (!verified.ok) return ctx.fail(`verify: ${verified.error}`);
    const drift = verified.value.driftRatio;
    if (drift === 0) return 'loaded';
    if (drift <= tolerableDriftRatio) return 'loaded-with-warnings';
    return ctx.fail(`drift ${drift} exceeds tolerance ${tolerableDriftRatio}`);
  });

const twoAm = H.timetable('nightly-0200', NightlyLoad, { daily: '02:00' }, tick =>
  sourceSchema.options.map(source => ({
    create: { source, night: tick.now.toISOString().slice(0, 10) },
    key: `${source}-${tick.now.toISOString().slice(0, 10)}`,
  }))
);

const loads = H.lane('nightly-loads', NightlyLoad)
  .handler(nightlyFlow)
  .suppliers(twoAm)
  .store(sqlite.store(NightlyLoad, '.harness/loads.sqlite'))
  .retry(H.policy.retry('no-attempt-retry', () => 'stop'));

const approvalExpires = H.trigger(
  'approval-expires-at-0900',
  H.on.time(NightlyLoad, { daily: '09:00' }, ['awaiting-approval']),
  (_event, act) => act.move('expired')
);

const pool = H.pool(
  'api',
  [{ account: anthropic.account('data-api', { apiKey: H.env('ANTHROPIC_API_KEY') }), share: 1 }],
  H.policy.account('first-eligible', choice => {
    const eligible = choice.accounts.find(view => view.eligible);
    return eligible ? eligible.account : null;
  })
);

const approverSupervisor = claudeCode.supervisor({
  grants: [H.ops.readWork, H.ops.resolveHalts, H.ops.readMemory, H.ops.writeMemory, H.ops.readTelemetry],
});

export const dataJob = H.harness('nightly-data')
  .ledger(sqlite.ledger('.harness/ledger.sqlite'))
  .lanes(loads)
  .pools(pool)
  .triggers(approvalExpires)
  .clients(approverSupervisor)
  .observers(markdown.board('BOARD.md'), markdown.telemetry('TELEMETRY.md'));
