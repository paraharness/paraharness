import { z } from 'zod';
import { H } from 'harness-dsl';
import * as claude from 'harness-dsl/claude-code';
import * as sqlite from 'harness-dsl/sqlite';
import * as jsonl from 'harness-dsl/jsonl';
import * as shell from 'harness-dsl/shell';
import * as ssh from 'harness-dsl/ssh';
import * as markdown from 'harness-dsl/markdown';

const scheduled = H.state('scheduled', 'pending');
const loaded = H.state('loaded', 'terminal', 'success');
const loadedWithWarnings = H.state('loaded-with-warnings', 'terminal', 'success');
const rejected = H.state('rejected', 'terminal', 'neutral');
const failed = H.state('failed', 'terminal', 'failure');
const expired = H.state('expired', 'terminal', 'neutral');

export const nightlyLoad = H.kind('NightlyLoad')
  .data(z.object({ source: z.string(), runDate: z.string(), approvalDeadline: z.string() }))
  .states(scheduled, loaded, loadedWithWarnings, rejected, failed, expired);

const summarizing = H.role('anomaly-summarizer')
  .input(z.object({ source: z.string(), validationReport: z.string() }))
  .output(z.object({ summary: z.string() }))
  .prompt(input => `Summarize the anomalies in tonight's ${input.source} extract in plain language.\n\n${input.validationReport}`);

const tasteMemory = H.memory('approver-taste', 'taste');
const taste = H.journal('approver-taste', tasteMemory, jsonl.memory('memory/taste.jsonl'));

const validationReview = H.halt(
  'validation-review',
  z.object({ action: z.enum(['proceed', 'reject']), note: z.string().optional() })
).about(z.object({ report: z.string() }));

const loadApproval = H.halt('load-approval', z.object({ approve: z.boolean(), note: z.string().optional() })).about(
  z.object({ summary: z.string() })
);

const subscription = claude.subscription('claude-data', { token: H.env('CLAUDE_TOKEN') });
const dataPool = H.pool('data', [{ account: subscription, share: 1 }]);
const sonnet = claude.model('claude-sonnet-4-5');

const summarizer = H.seat('summarizer', summarizing).model(sonnet).recalls(taste);

const local = shell.local('local', { slots: 2 });
const warehouseHost = ssh.host('warehouse', {
  address: 'warehouse.internal',
  user: 'etl',
  key: H.env('ETL_SSH_KEY'),
  slots: 2,
});

const exponential = { first: { minutes: 2 }, factor: 2, max: { minutes: 30 } };

const extract = H.command('extract')
  .input(z.object({ source: z.string(), runDate: z.string() }))
  .argv(input => ['etl', 'extract', input.source, input.runDate])
  .on(warehouseHost)
  .recovery('rerun')
  .retries(3, exponential);

const validate = H.command('validate')
  .input(z.object({ source: z.string(), runDate: z.string() }))
  .argv(input => ['etl', 'validate', input.source, input.runDate])
  .on(local);

const load = H.command('load')
  .input(z.object({ source: z.string(), runDate: z.string() }))
  .argv(input => ['etl', 'load', input.source, input.runDate])
  .on(warehouseHost)
  .recovery('park')
  .retries(3, exponential);

const verify = H.command('verify')
  .input(z.object({ source: z.string(), runDate: z.string() }))
  .output(z.object({ drift: z.enum(['none', 'tolerable', 'excessive']) }))
  .argv(input => ['etl', 'verify', input.source, input.runDate])
  .on(local);

const nightly = H.flow('nightly-load')
  .for(nightlyLoad)
  .does(async ctx => {
    const target = { source: ctx.unit.data.source, runDate: ctx.unit.data.runDate };
    const extracted = await ctx.run(extract, target);
    if (!extracted.ok) return ctx.fail(`extract failed: ${extracted.error}`);
    const validated = await ctx.run(validate, target);
    const report = validated.ok ? validated.value : validated.error;
    if (!validated.ok) {
      const review = await ctx.halt(validationReview, `Validation failed for ${target.source}`, { report });
      if (review.action === 'reject') return 'rejected';
    }
    const summary = await ctx.run(summarizer, { source: target.source, validationReport: report });
    if (!summary.ok) return ctx.fail(summary.error);
    const approval = await ctx.halt(loadApproval, summary.value.summary, { summary: summary.value.summary });
    if (!approval.approve) return 'rejected';
    const loading = await ctx.run(load, target);
    if (!loading.ok) return ctx.fail(`load failed: ${loading.error}`);
    const verified = await ctx.run(verify, target);
    if (!verified.ok) return ctx.fail(verified.error);
    if (verified.value.drift === 'none') return 'loaded';
    if (verified.value.drift === 'tolerable') return 'loaded-with-warnings';
    return ctx.fail('verify found drift beyond tolerance');
  });

const sources = ['crm', 'billing', 'inventory', 'support'];

const nightlyClock = H.clock('nightly-at-0200', nightlyLoad, { daily: '02:00' }, tick =>
  sources.map(source => {
    const runDate = tick.now.toISOString().slice(0, 10);
    const deadline = new Date(tick.now.getTime());
    deadline.setHours(9, 0, 0, 0);
    return { create: { source, runDate, approvalDeadline: deadline.toISOString() }, key: `${source}-${runDate}` };
  })
);

export const loadsLane = H.lane('nightly-loads', nightlyLoad)
  .handler(nightly, { exhausted: 'failed' })
  .suppliers(nightlyClock)
  .store(sqlite.store(nightlyLoad, '.harness/loads.sqlite'));

const approvalWindowCloses = H.trigger(
  'approval-window-closes-at-0900',
  H.on.deadline(nightlyLoad, data => new Date(data.approvalDeadline), ['scheduled']),
  (_event, act) => act.move('expired')
);

const approver = claude.supervisor({
  grants: [
    H.ops.readWork,
    H.ops.readTelemetry,
    H.ops.writeMemory,
    H.ops.resolve(validationReview, loadApproval, H.halts.interrupted, H.halts.definitionChanged),
  ],
});

export const dataJob = H.harness('nightly-data')
  .ledger(sqlite.ledger('.harness/data.sqlite'))
  .lanes(loadsLane)
  .pools(dataPool)
  .triggers(approvalWindowCloses)
  .clients(approver)
  .observers(markdown.board('BOARD.md'), markdown.telemetry('TELEMETRY.md'));
