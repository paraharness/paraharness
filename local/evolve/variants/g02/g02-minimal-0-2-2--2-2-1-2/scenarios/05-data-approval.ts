import { z } from 'zod';
import { H } from 'harness-dsl';
import * as anthropic from 'harness-dsl/anthropic';
import * as claudeCode from 'harness-dsl/claude-code';
import * as sqlite from 'harness-dsl/sqlite';
import * as jsonl from 'harness-dsl/jsonl';
import * as shell from 'harness-dsl/shell';
import * as ssh from 'harness-dsl/ssh';
import * as markdown from 'harness-dsl/markdown';

const sourceSystem = z.enum(['crm', 'billing', 'inventory', 'warehouse']);
type SourceSystem = z.infer<typeof sourceSystem>;
const sources: readonly SourceSystem[] = ['crm', 'billing', 'inventory', 'warehouse'];

const scheduled = H.state('scheduled', 'pending');
const loaded = H.state('loaded', 'terminal', 'success');
const loadedWithWarnings = H.state('loaded-with-warnings', 'terminal', 'success');
const rejected = H.state('rejected', 'terminal', 'failure');
const expired = H.state('expired', 'terminal', 'neutral');
const failed = H.state('failed', 'terminal', 'failure');

const nightlyLoad = H.kind('nightly-load')
  .data(z.object({ source: sourceSystem, night: z.string() }))
  .states(scheduled, loaded, loadedWithWarnings, rejected, expired, failed);

const loadStore = sqlite.store(nightlyLoad, '.harness/loads.db');

const nightlySchedule = H.clock('nightly-schedule', nightlyLoad, { daily: '02:00' }, tick => {
  const night = tick.now.toISOString().slice(0, 10);
  return sources.map(source => ({ create: { source, night }, key: `${source}-${night}` }));
});

const etlHost = ssh.host('etl-host', { address: 'etl.internal', user: 'etl', key: H.env('ETL_SSH_KEY'), slots: 4 });
const local = shell.local('local', { slots: 4 });

const exponential = { first: { minutes: 2 }, factor: 2, max: { minutes: 30 } };
const job = z.object({ source: sourceSystem, night: z.string() });

const extract = H.command('extract')
  .input(job)
  .argv(input => ['etl', 'extract', input.source, '--night', input.night])
  .on(etlHost)
  .retries(3, exponential)
  .recovery('rerun');
const validate = H.command('validate')
  .input(job)
  .output(z.object({ report: z.string(), anomalies: z.array(z.string()) }))
  .argv(input => ['etl', 'validate', input.source, '--night', input.night])
  .on(local);
const load = H.command('load')
  .input(job)
  .argv(input => ['etl', 'load', input.source, '--night', input.night])
  .on(etlHost)
  .retries(3, exponential)
  .recovery('park');
const verify = H.command('verify')
  .input(job)
  .output(z.object({ drift: z.enum(['none', 'tolerable']) }))
  .argv(input => ['etl', 'verify', input.source, '--night', input.night])
  .on(local);

const sonnet = anthropic.model('claude-sonnet-4-5');
const api = anthropic.account('anthropic-api', { apiKey: H.env('ANTHROPIC_API_KEY') });
const anthropicPool = H.pool('anthropic', [{ account: api, share: 1 }]);

const approverTaste = H.library('approver-taste', H.memory('approver-taste', 'taste'), jsonl.memory('.harness/taste.jsonl'));

const summarizerRole = H.role('anomaly-summarizer')
  .input(z.object({ source: sourceSystem, report: z.string(), anomalies: z.array(z.string()) }))
  .output(z.object({ summary: z.string() }))
  .prompt(input =>
    `Summarize in plain language the anomalies in tonight's ${input.source} extract.\n\n${input.report}\n\n${input.anomalies.join('\n')}`
  );

const summarizer = H.seat('anomaly-summarizer', summarizerRole).model(sonnet).recalls(approverTaste);

const validationReview = H.halt('validation-review', z.object({ proceed: z.boolean() }))
  .about(z.object({ source: sourceSystem, report: z.string() }));
const loadApproval = H.halt('load-approval', z.object({ approved: z.boolean(), note: z.string().optional() }))
  .about(z.object({ source: sourceSystem, summary: z.string() }));

const nightly = H.flow('nightly-load').for(nightlyLoad).does(async ctx => {
  const work = ctx.unit.data;
  const extracted = await ctx.run(extract, work);
  if (!extracted.ok) return ctx.fail(extracted.error);
  const validated = await ctx.run(validate, work);
  let report = '';
  let anomalies: string[] = [];
  if (validated.ok) {
    report = validated.value.report;
    anomalies = validated.value.anomalies;
  } else {
    const review = await ctx.halt(validationReview, `Validation failed for ${work.source}`, {
      source: work.source,
      report: validated.error,
    });
    if (!review.proceed) return 'rejected';
    report = validated.error;
  }
  const summary = await ctx.run(summarizer, { source: work.source, report, anomalies });
  if (!summary.ok) return ctx.fail(summary.error);
  const approval = await ctx.halt(loadApproval, summary.value.summary, { source: work.source, summary: summary.value.summary });
  if (!approval.approved) return 'rejected';
  const loadedRows = await ctx.run(load, work);
  if (!loadedRows.ok) return ctx.fail(loadedRows.error);
  const verified = await ctx.run(verify, work);
  if (!verified.ok) return ctx.fail(verified.error);
  return verified.value.drift === 'none' ? 'loaded' : 'loaded-with-warnings';
});

const loads = H.lane('nightly-loads', nightlyLoad)
  .handler(nightly, { retries: 0, exhausted: 'failed' })
  .suppliers(nightlySchedule)
  .store(loadStore);

const approvalExpiresAtNine = H.trigger(
  'approval-expires-at-nine',
  H.on.deadline(nightlyLoad, data => new Date(`${data.night}T09:00:00`), ['scheduled']),
  (event, act) => (event.unit.position === 'waiting' ? act.move('expired') : [])
);

const supervisor = claudeCode.supervisor({
  grants: [
    H.ops.readWork,
    H.ops.resolve(validationReview, loadApproval, H.halts.interrupted, H.halts.definitionChanged),
    H.ops.writeMemory,
    H.ops.readTelemetry,
  ],
});

export const dataApproval = H.harness('data-approval')
  .ledger(sqlite.ledger('.harness/ledger.db'))
  .lanes(loads)
  .pools(anthropicPool)
  .triggers(approvalExpiresAtNine)
  .clients(supervisor)
  .observers(markdown.board('BOARD.md'), markdown.telemetry('TELEMETRY.md'));
