import { z } from 'zod';
import { H } from 'harness-dsl';
import type { SupplyOf } from 'harness-dsl';
import * as anthropic from 'harness-dsl/anthropic';
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
const expired = H.state('expired', 'terminal', 'neutral');
const failed = H.state('failed', 'terminal', 'failure');

const NightlyLoad = H.kind('NightlyLoad')
  .data(z.object({ source: z.string(), night: z.string() }))
  .states(scheduled, loaded, loadedWithWarnings, rejected, expired, failed);

const taste = H.memory('approver-taste', 'taste');
const tasteJournal = H.journal('approver-taste', taste, jsonl.memory('.harness/taste.jsonl'));

const etlHost = ssh.host('etl-host', { address: 'etl.internal', user: 'etl', key: H.env('ETL_SSH_KEY'), slots: 4 });
const local = shell.local('local', { slots: 4 });

const backoffThreeTimes = H.policy.retry('backoff-three-times', view =>
  view.failures > 3 ? 'stop' : { retryInMs: 30_000 * 2 ** view.failures }
);
const noAttemptRetry = H.policy.retry('no-attempt-retry', () => 'stop');

const extract = H.command('extract')
  .input(z.object({ source: z.string(), night: z.string() }))
  .argv(input => ['extract', '--source', input.source, '--night', input.night])
  .on(etlHost)
  .retry(backoffThreeTimes)
  .recovery('rerun');

const validate = H.command('validate')
  .input(z.object({ source: z.string(), night: z.string() }))
  .output(z.object({ passed: z.boolean(), report: z.string() }))
  .argv(input => ['validate', '--source', input.source, '--night', input.night])
  .on(local)
  .recovery('rerun');

const load = H.command('load')
  .input(z.object({ source: z.string(), night: z.string() }))
  .argv(input => ['load', '--source', input.source, '--night', input.night])
  .on(etlHost)
  .retry(backoffThreeTimes)
  .recovery('park');

const verify = H.command('verify')
  .input(z.object({ source: z.string(), night: z.string() }))
  .output(z.object({ drift: z.number(), tolerable: z.boolean() }))
  .argv(input => ['verify', '--source', input.source, '--night', input.night])
  .on(local)
  .recovery('rerun');

const summaryRole = H.role('anomaly-summarizer')
  .input(z.object({ source: z.string(), report: z.string() }))
  .output(z.object({ summary: z.string() }))
  .prompt(input => `Summarise in plain language the anomalies in tonight's ${input.source} extract.\n\n${input.report}`);

const summarizer = H.seat('anomaly-summarizer', summaryRole)
  .model(anthropic.model('claude-sonnet-4-5'))
  .recalls(tasteJournal);

const validationReview = H.halt('validation-review', z.object({ action: z.enum(['continue', 'reject']) }))
  .about(z.object({ report: z.string() }));
const loadApproval = H.halt('load-approval', z.object({ approve: z.boolean(), note: z.string().optional() }))
  .about(z.object({ summary: z.string() }));

const nightlyLoad = H.flow('nightly-load')
  .for(NightlyLoad)
  .does(async ctx => {
    const target = { source: ctx.unit.data.source, night: ctx.unit.data.night };
    const extracted = await ctx.run(extract, target);
    if (!extracted.ok) return ctx.fail(extracted.error);
    const validated = await ctx.run(validate, target);
    if (!validated.ok) return ctx.fail(validated.error);
    if (!validated.value.passed) {
      const review = await ctx.halt(validationReview, `Validation failed for ${target.source}`, { report: validated.value.report });
      if (review.action === 'reject') return 'rejected';
    }
    const summary = await ctx.run(summarizer, { source: target.source, report: validated.value.report });
    if (!summary.ok) return ctx.fail(summary.error);
    const approval = await ctx.halt(loadApproval, summary.value.summary, { summary: summary.value.summary });
    if (!approval.approve) return 'rejected';
    const loadedResult = await ctx.run(load, target);
    if (!loadedResult.ok) return ctx.fail(loadedResult.error);
    const verified = await ctx.run(verify, target);
    if (!verified.ok) return ctx.fail(verified.error);
    if (verified.value.drift === 0) return 'loaded';
    return verified.value.tolerable ? 'loaded-with-warnings' : ctx.fail(`verify found drift ${verified.value.drift}`);
  });

const sources = ['crm', 'billing', 'inventory', 'web-analytics'];

const nightlySchedule = H.clock('nightly-at-two', NightlyLoad, { daily: '02:00' }, tick => {
  const night = tick.now.toISOString().slice(0, 10);
  return sources.map((source): SupplyOf<typeof NightlyLoad> => ({ create: { source, night }, key: `${source}-${night}` }));
});

const nightlyLoads = H.lane('nightly-loads', NightlyLoad)
  .handler(nightlyLoad)
  .suppliers(nightlySchedule)
  .store(sqlite.store(NightlyLoad, '.harness/loads.db'))
  .retry(noAttemptRetry, 'failed');

const approvalWindowCloses = H.trigger(
  'approval-window-closes-at-nine',
  H.on.deadline(NightlyLoad, data => new Date(`${data.night}T09:00:00`), ['scheduled']),
  (_event, act) => act.move('expired')
);

const approver = claude.supervisor({
  grants: [H.ops.readWork, H.ops.resolve(validationReview, loadApproval), H.ops.writeMemory, H.ops.readTelemetry],
});

export const harness = H.harness('nightly-data')
  .ledger(sqlite.ledger('.harness/ledger.db'))
  .lanes(nightlyLoads)
  .pools(H.pool('anthropic', [{ account: anthropic.account('api', { apiKey: H.env('ANTHROPIC_API_KEY') }), share: 1 }]))
  .triggers(approvalWindowCloses)
  .clients(approver)
  .observers(markdown.board('.harness/board.md'), markdown.telemetry('.harness/telemetry.md'));

export const running = harness.start();
