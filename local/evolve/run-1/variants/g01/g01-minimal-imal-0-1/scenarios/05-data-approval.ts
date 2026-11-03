import { z } from 'zod';
import { H } from 'harness-dsl';
import * as claudeCode from 'harness-dsl/claude-code';
import * as anthropic from 'harness-dsl/anthropic';
import * as sqlite from 'harness-dsl/sqlite';
import * as jsonl from 'harness-dsl/jsonl';
import * as shell from 'harness-dsl/shell';
import * as ssh from 'harness-dsl/ssh';
import * as markdown from 'harness-dsl/markdown';

const sourceSystem = z.enum(['crm', 'erp', 'billing', 'warehouse']);

const NightlyLoad = H.kind('NightlyLoad')
  .data(z.object({ source: sourceSystem, night: z.string() }))
  .states(
    [
      H.state('scheduled', 'pending'),
      H.state('extracting', 'active'),
      H.state('validating', 'active'),
      H.state('summarizing', 'active'),
      H.state('awaiting-approval', 'active'),
      H.state('loading', 'active'),
      H.state('verifying', 'active'),
      H.state('loaded', 'terminal', 'success'),
      H.state('loaded-with-warnings', 'terminal', 'success'),
      H.state('rejected', 'terminal', 'neutral'),
      H.state('expired', 'terminal', 'neutral'),
      H.state('failed', 'terminal', 'failure'),
    ],
    { initial: 'scheduled', afterFailure: 'failed' }
  );

const approverTaste = H.memory('approver-taste', 'taste');

const specificFirst = H.policy.recall('specific-first', view =>
  view.items
    .filter(item => item.status === 'accepted')
    .sort((a, b) => b.specificity - a.specificity || a.id.localeCompare(b.id))
    .slice(0, 10)
);

const tasteLibrary = H.library('approver-taste', approverTaste, jsonl.memory('memory/approver-taste.jsonl')).recall(specificFirst);

const api = anthropic.account('anthropic-api', { apiKey: H.env('ANTHROPIC_API_KEY') });
const haiku = anthropic.model('claude-haiku-4-5');

const firstEligible = H.policy.account('first-eligible', choice => {
  const open = choice.accounts.find(view => view.eligible);
  return open === undefined ? null : open.account;
});
const apiPool = H.pool('api', [{ account: api, share: 1 }], firstEligible);

const local = shell.local('local', { slots: 2 });
const warehouse = ssh.host('warehouse', {
  address: 'warehouse.internal',
  user: 'etl',
  key: H.env('WAREHOUSE_SSH_KEY'),
  slots: 4,
});

const threeTimesWithBackoff = H.policy.retry('three-times-exponential', view =>
  view.failures > 3 ? 'stop' : { retryInMs: 30_000 * 2 ** (view.failures - 1) }
);

const extract = H.command('extract')
  .input(z.object({ source: sourceSystem, night: z.string() }))
  .argv(input => ['./etl/extract', input.source, input.night])
  .on(warehouse)
  .ifInterrupted('rerun');

const validate = H.command('validate')
  .input(z.object({ source: sourceSystem, night: z.string() }))
  .output(z.object({ rows: z.number(), anomalies: z.array(z.string()) }))
  .argv(input => ['./etl/validate', input.source, input.night])
  .on(local)
  .ifInterrupted('rerun');

const load = H.command('load')
  .input(z.object({ source: sourceSystem, night: z.string() }))
  .argv(input => ['./etl/load', input.source, input.night])
  .on(warehouse)
  .ifInterrupted('park');

const verify = H.command('verify')
  .input(z.object({ source: sourceSystem, night: z.string() }))
  .output(z.object({ driftPercent: z.number(), tolerable: z.boolean() }))
  .argv(input => ['./etl/verify', input.source, input.night])
  .on(warehouse)
  .ifInterrupted('rerun');

const summaryRole = H.role('anomaly-summarizer')
  .input(z.object({ source: z.string(), rows: z.number(), anomalies: z.array(z.string()), validationNote: z.string() }))
  .output(z.object({ summary: z.string() }))
  .prompt(
    input =>
      `Summarize in plain language the anomalies in tonight's ${input.source} extract (${input.rows} rows).\n${input.anomalies.join('\n')}\n${input.validationNote}`
  );

const summarizer = H.agent('anomaly-summarizer', summaryRole).model(haiku).recalls(tasteLibrary);

const nightlyLoadFlow = H.flow('nightly-load')
  .for(NightlyLoad)
  .does(async ctx => {
    const job = { source: ctx.unit.data.source, night: ctx.unit.data.night };

    await ctx.move('extracting');
    const extracted = await ctx.run(extract, job, { retry: threeTimesWithBackoff });
    if (extracted.ok === false) return ctx.fail(extracted.error);

    await ctx.move('validating');
    const validated = await ctx.run(validate, job);
    let rows = 0;
    let anomalies: string[] = [];
    let validationNote = 'Validation passed.';
    if (validated.ok) {
      rows = validated.value.rows;
      anomalies = validated.value.anomalies;
    } else {
      const override = await ctx.halt({
        name: 'validation-failed',
        show: validated.error,
        decision: z.object({ proceed: z.boolean(), note: z.string() }),
      });
      if (override.proceed === false) return 'failed';
      validationNote = `Validation failed and was overridden: ${override.note}`;
    }

    await ctx.move('summarizing');
    const summarized = await ctx.run(summarizer, { source: job.source, rows, anomalies, validationNote });
    if (summarized.ok === false) return ctx.fail(summarized.error);

    await ctx.move('awaiting-approval');
    const approval = await ctx.halt({
      name: 'approve-load',
      show: summarized.value.summary,
      decision: z.object({ approve: z.boolean(), note: z.string().optional() }),
    });
    if (approval.approve === false) return 'rejected';

    await ctx.move('loading');
    const loaded = await ctx.run(load, job, { retry: threeTimesWithBackoff });
    if (loaded.ok === false) return ctx.fail(loaded.error);

    await ctx.move('verifying');
    const verified = await ctx.run(verify, job);
    if (verified.ok === false) return ctx.fail(verified.error);
    if (verified.value.tolerable === false) return 'failed';
    return verified.value.driftPercent > 0 ? 'loaded-with-warnings' : 'loaded';
  });

const nightlySchedule = H.calendar('nightly-at-0200', NightlyLoad, { daily: '02:00' }, tick =>
  sourceSystem.options.map(source => {
    const night = tick.now.toISOString().slice(0, 10);
    return { create: { source, night }, key: `${source}-${night}` };
  })
);

const nightlyLoads = H.lane('nightly-loads', NightlyLoad)
  .handler(nightlyLoadFlow)
  .suppliers(nightlySchedule)
  .store(sqlite.store(NightlyLoad, 'loads.db'));

const approvalExpiresAt0900 = H.trigger(
  'approval-expires-at-0900',
  H.on.time(NightlyLoad, { daily: '09:00' }, ['awaiting-approval']),
  (event, act) => act.move('expired')
);

const oldestFirst = H.policy.scheduler('oldest-first', view => ({
  start: view.pending.slice().sort((a, b) => b.waitedMs - a.waitedMs),
}));

const supervisor = claudeCode.supervisor({
  grants: [
    H.ops.readWork,
    H.ops.resolveHalts,
    H.ops.manageAttempts,
    H.ops.readMemory,
    H.ops.writeMemory,
    H.ops.readTelemetry,
  ],
});

export const dataJob = H.harness('nightly-data-job')
  .ledger(sqlite.ledger('data-job.db'))
  .lanes(nightlyLoads)
  .pools(apiPool)
  .triggers(approvalExpiresAt0900)
  .scheduler(oldestFirst)
  .clients(supervisor)
  .observers(markdown.board('BOARD.md'), markdown.telemetry('TELEMETRY.md'));
