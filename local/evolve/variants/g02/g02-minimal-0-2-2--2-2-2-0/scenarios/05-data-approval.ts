import { z } from 'zod';
import { H } from 'harness-dsl';
import * as claudeCode from 'harness-dsl/claude-code';
import * as anthropic from 'harness-dsl/anthropic';
import * as sqlite from 'harness-dsl/sqlite';
import * as jsonl from 'harness-dsl/jsonl';
import * as ssh from 'harness-dsl/ssh';
import * as markdown from 'harness-dsl/markdown';

const scheduled = H.state('scheduled', 'pending');
const loaded = H.state('loaded', 'terminal', 'success');
const loadedWithWarnings = H.state('loaded-with-warnings', 'terminal', 'success');
const rejected = H.state('rejected', 'terminal', 'failure');
const failed = H.state('failed', 'terminal', 'failure');
const expired = H.state('expired', 'terminal', 'neutral');

const nightlyLoad = H.kind('nightly-load')
  .data(z.object({ source: z.string(), night: z.string() }))
  .states(scheduled, loaded, loadedWithWarnings, rejected, failed, expired);

const warehouse = ssh.host('warehouse', {
  address: 'warehouse.internal',
  user: 'etl',
  key: H.env('WAREHOUSE_SSH_KEY'),
  slots: 2,
});

const loadInput = z.object({ source: z.string(), night: z.string() });
const stepBackoff = H.policy.retry('step-backoff', { retries: 3, firstDelayMs: 30000, factor: 2, maxDelayMs: 600000 });

const extract = H.command('extract')
  .input(loadInput)
  .argv(i => ['etl', 'extract', '--source', i.source, '--night', i.night])
  .on(warehouse)
  .retry(stepBackoff)
  .recovery('rerun');
const validate = H.command('validate')
  .input(loadInput)
  .argv(i => ['etl', 'validate', '--source', i.source, '--night', i.night])
  .on(warehouse)
  .recovery('rerun');
const load = H.command('load')
  .input(loadInput)
  .argv(i => ['etl', 'load', '--source', i.source, '--night', i.night])
  .on(warehouse)
  .retry(stepBackoff)
  .recovery('park');
const verify = H.command('verify')
  .input(loadInput)
  .output(z.object({ driftPercent: z.number() }))
  .argv(i => ['etl', 'verify', '--source', i.source, '--night', i.night])
  .on(warehouse)
  .recovery('rerun');

const summaryRole = H.role('anomaly-summary')
  .input(z.object({ source: z.string(), night: z.string(), validation: z.string() }))
  .output(z.object({ summary: z.string() }))
  .prompt(i => `Summarise in plain language the anomalies in tonight's ${i.source} extract (${i.night}):\n${i.validation}`);

const approverTaste = H.journal('approver-taste', H.memory('approver-taste', 'taste'), jsonl.memory('memory/taste.jsonl'));

const api = anthropic.account('data-api', { apiKey: H.env('ANTHROPIC_API_KEY') });
const pool = H.pool('data', [{ account: api, share: 1 }]);

const summarizer = H.seat('summarizer', summaryRole).model(anthropic.model('claude-haiku-4-5')).recalls(approverTaste);

const validationReview = H.halt('validation-review', z.object({ proceed: z.boolean(), note: z.string() }));
const loadApproval = H.halt('load-approval', z.object({ approve: z.boolean(), note: z.string() }));

const tolerableDriftPercent = 0.5;

const nightly = H.flow('nightly-load')
  .for(nightlyLoad)
  .does(async ctx => {
    const job = { source: ctx.unit.data.source, night: ctx.unit.data.night };
    const extracted = await ctx.run(extract, job);
    if (!extracted.ok) return 'failed';
    const validated = await ctx.run(validate, job);
    if (!validated.ok) {
      const review = await ctx.halt(validationReview, validated.error);
      if (!review.proceed) return 'failed';
    }
    const summary = await ctx.run(summarizer, { ...job, validation: validated.ok ? validated.value : validated.error });
    if (!summary.ok) return ctx.fail(summary.error);
    const approval = await ctx.halt(loadApproval, summary.value.summary);
    if (!approval.approve) return 'rejected';
    const loadedRun = await ctx.run(load, job);
    if (!loadedRun.ok) return 'failed';
    const verified = await ctx.run(verify, job);
    if (!verified.ok) return 'failed';
    if (verified.value.driftPercent === 0) return 'loaded';
    return verified.value.driftPercent <= tolerableDriftPercent ? 'loaded-with-warnings' : 'failed';
  });

const sourceSystems = ['crm', 'billing', 'inventory', 'support'];

const nightlyAllowance = H.allowance('nightly-allowance', nightlyLoad).retry(
  H.policy.retry('nightly-attempt-retry', { retries: 2, firstDelayMs: 300000 }),
  'failed'
);

const loads = H.lane('nightly-loads', nightlyLoad)
  .handler(nightly)
  .suppliers(
    H.clock('two-am', nightlyLoad, { daily: '02:00' }, tick => {
      const night = tick.now.toISOString().slice(0, 10);
      return sourceSystems.map(source => ({ create: { source, night }, key: `${source}-${night}` }));
    })
  )
  .store(sqlite.store(nightlyLoad, 'loads.db'))
  .allowance(nightlyAllowance);

const approvalExpiresAtNine = H.trigger(
  'approval-expires-at-nine',
  H.on.deadline(nightlyLoad, data => new Date(`${data.night}T09:00:00`), ['scheduled']),
  (_event, act) => act.move('expired')
);

const loadOutcomes = H.report('load-outcomes', metrics => ({
  ...metrics.rateBy({
    among: { entry: 'transition', kind: nightlyLoad, position: 'terminal' },
    count: { entry: 'transition', kind: nightlyLoad, position: 'terminal' },
    by: 'state',
    days: 30,
  }),
  'clean loads among successes, 30d': metrics.rate({
    among: { entry: 'transition', kind: nightlyLoad, verdict: 'success' },
    count: { entry: 'transition', kind: nightlyLoad, state: loaded },
    days: 30,
  }),
  'median approval time, 30d': metrics.median({ of: 'decisionMs', among: { entry: 'halt', halt: loadApproval, status: 'resolved' }, days: 30 }),
}));

const supervisor = claudeCode.supervisor({
  grants: [
    H.ops.readWork,
    H.ops.resolve(loadApproval, validationReview, H.halts.changed, H.halts.interrupted),
    H.ops.readMemory,
    H.ops.writeMemory,
    H.ops.readTelemetry,
  ],
});

export const harness = H.harness('nightly-data')
  .ledger(sqlite.ledger('ledger.db'))
  .lanes(loads)
  .pools(pool)
  .triggers(approvalExpiresAtNine)
  .reports(loadOutcomes)
  .clients(supervisor)
  .observers(markdown.board('BOARD.md'), markdown.telemetry('TELEMETRY.md'));

export const running = harness.start();
