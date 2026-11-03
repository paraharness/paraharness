import { H } from 'harness-dsl';
import * as claudeCode from 'harness-dsl/claude-code';
import * as sqlite from 'harness-dsl/sqlite';
import * as jsonl from 'harness-dsl/jsonl';
import * as shell from 'harness-dsl/shell';
import * as ssh from 'harness-dsl/ssh';
import * as markdown from 'harness-dsl/markdown';
import { z } from 'zod';

const scheduled = H.state('scheduled', 'pending');
const loaded = H.state('loaded', 'terminal', 'success');
const loadedWithWarnings = H.state('loaded-with-warnings', 'terminal', 'success');
const rejected = H.state('rejected', 'terminal', 'neutral');
const failed = H.state('failed', 'terminal', 'failure');
const expired = H.state('expired', 'terminal', 'neutral');

const nightlyLoad = H.kind('nightly-load')
  .data(z.object({ source: z.string(), night: z.string() }))
  .states(scheduled, loaded, loadedWithWarnings, rejected, failed, expired);

const sourceSystems = ['crm', 'billing', 'inventory', 'web-analytics'];

const local = shell.local('local', { slots: 4 });
const warehouse = ssh.host('warehouse', { address: 'warehouse.internal', user: 'etl', key: H.env('ETL_SSH_KEY'), slots: 2 });
const withBackoff = H.retry({ times: 3, firstDelayMs: 60000, factor: 2 });

const extract = H.command('extract')
  .input(z.object({ source: z.string(), night: z.string() }))
  .argv((i) => ['etl', 'extract', i.source, '--night', i.night])
  .on(warehouse)
  .retry(withBackoff)
  .recovery('rerun');
const validate = H.command('validate')
  .input(z.object({ source: z.string(), night: z.string() }))
  .output(z.object({ anomalies: z.array(z.string()) }))
  .argv((i) => ['etl', 'validate', i.source, '--night', i.night, '--json'])
  .on(local);
const load = H.command('load')
  .input(z.object({ source: z.string(), night: z.string() }))
  .argv((i) => ['etl', 'load', i.source, '--night', i.night])
  .on(warehouse)
  .retry(withBackoff)
  .recovery('park');
const verify = H.command('verify')
  .input(z.object({ source: z.string(), night: z.string() }))
  .output(z.object({ driftPercent: z.number() }))
  .argv((i) => ['etl', 'verify', i.source, '--night', i.night, '--json'])
  .on(warehouse);

const summaryRole = H.role('anomaly-summarizer')
  .input(z.object({ source: z.string(), anomalies: z.array(z.string()) }))
  .output(z.object({ summary: z.string() }))
  .prompt((i) => `Summarize these anomalies in tonight's ${i.source} extract for the approver, in plain language:\n${i.anomalies.join('\n')}`);

const approverTaste = H.journal('approver-taste', H.memory('approver-taste', 'taste'), jsonl.memory('memory/approver-taste.jsonl'));
const summarizer = H.seat('summarizer', summaryRole).model(claudeCode.model('claude-sonnet-4-5')).recalls(approverTaste);

const validationReview = H.halt('validation-review', z.object({ proceed: z.boolean() }))
  .about(z.object({ source: z.string(), report: z.string() }));
const loadApproval = H.halt('load-approval', z.object({ approved: z.boolean(), notes: z.string().optional() }))
  .about(z.object({ source: z.string(), summary: z.string() }));

const tolerableDriftPercent = 0.5;

const nightly = H.flow('nightly-load')
  .for(nightlyLoad)
  .does(async (ctx) => {
    const target = { source: ctx.unit.data.source, night: ctx.unit.data.night };
    const extracted = await ctx.run(extract, target);
    if (!extracted.ok) return ctx.fail(`extract: ${extracted.error}`);
    const validated = await ctx.run(validate, target);
    let anomalies: string[];
    if (validated.ok) {
      anomalies = validated.value.anomalies;
    } else {
      const review = await ctx.halt(validationReview, `Validation failed for ${target.source}`, {
        source: target.source,
        report: validated.error,
      });
      if (!review.proceed) return 'rejected';
      anomalies = [validated.error];
    }
    const summary = await ctx.run(summarizer, { source: target.source, anomalies });
    if (!summary.ok) return ctx.fail(summary.error);
    const approval = await ctx.halt(loadApproval, `Approve tonight's ${target.source} load`, {
      source: target.source,
      summary: summary.value.summary,
    });
    if (!approval.approved) return 'rejected';
    const loadedNow = await ctx.run(load, target);
    if (!loadedNow.ok) return ctx.fail(`load: ${loadedNow.error}`);
    const verified = await ctx.run(verify, target);
    if (!verified.ok) return ctx.fail(`verify: ${verified.error}`);
    if (verified.value.driftPercent === 0) return 'loaded';
    if (verified.value.driftPercent <= tolerableDriftPercent) return 'loaded-with-warnings';
    return ctx.fail(`drift ${verified.value.driftPercent}% exceeds tolerance`);
  });

const loads = H.lane('nightly-loads', nightlyLoad)
  .handler(nightly)
  .suppliers(
    H.clock('two-am', nightlyLoad, { daily: '02:00' }, (tick) => {
      const night = tick.now.toISOString().slice(0, 10);
      return sourceSystems.map((source) => ({ create: { source, night }, key: `${source}-${night}` }));
    })
  )
  .store(sqlite.store(nightlyLoad, 'harness/loads.db'))
  .retry(H.retry({ times: 0 }), 'failed');

const approvalCutoff = H.deadline('approval-cutoff', nightlyLoad, (data) => new Date(`${data.night}T09:00:00Z`), ['scheduled']);
const cancelAtCutoff = H.trigger('cancel-unapproved-at-nine', H.on.deadline(approvalCutoff), (_event, act) => act.move('expired'));

const outcomes = H.report('nightly-outcomes', (metrics) => ({
  'load success (30d)': metrics.successRate({ kind: nightlyLoad, days: 30 }),
  'loaded clean (30d)': metrics.count({ of: { entry: 'transition', kind: nightlyLoad, state: loaded }, days: 30 }),
  'loaded with warnings (30d)': metrics.count({ of: { entry: 'transition', kind: nightlyLoad, state: loadedWithWarnings }, days: 30 }),
  'rejected by approver (30d)': metrics.count({ of: { entry: 'transition', kind: nightlyLoad, state: rejected }, days: 30 }),
  'failed (30d)': metrics.count({ of: { entry: 'transition', kind: nightlyLoad, state: failed }, days: 30 }),
  'expired at cutoff (30d)': metrics.count({ of: { entry: 'transition', kind: nightlyLoad, state: expired }, days: 30 }),
  'approval decision time (30d)': metrics.median({ of: 'decisionMs', among: loadApproval.resolved(), days: 30 }),
}));

const approverAccount = claudeCode.subscription('max-1', { token: H.env('CLAUDE_TOKEN') });

export default H.harness('nightly-data')
  .ledger(sqlite.ledger('harness/ledger.db'))
  .lanes(loads)
  .pools(H.pool('claude', [{ account: approverAccount, share: 1 }]))
  .triggers(cancelAtCutoff)
  .reports(outcomes)
  .clients(
    claudeCode.supervisor({
      grants: [
        H.ops.readWork,
        H.ops.resolve(validationReview, loadApproval, H.parked),
        H.ops.readMemory,
        H.ops.writeMemory,
        H.ops.readTelemetry,
      ],
    })
  )
  .observers(markdown.board('BOARD.md'), markdown.telemetry('TELEMETRY.md'));
