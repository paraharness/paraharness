import { z } from 'zod';
import { H } from 'harness-dsl';
import * as claudeCode from 'harness-dsl/claude-code';
import * as anthropic from 'harness-dsl/anthropic';
import * as sqlite from 'harness-dsl/sqlite';
import * as jsonl from 'harness-dsl/jsonl';
import * as ssh from 'harness-dsl/ssh';
import * as markdown from 'harness-dsl/markdown';

const sourceSystems = ['crm', 'billing', 'inventory', 'web-analytics'];

const scheduled = H.state('scheduled', 'pending');
const loaded = H.state('loaded', 'terminal', 'success');
const loadedWithWarnings = H.state('loaded-with-warnings', 'terminal', 'success');
const rejected = H.state('rejected', 'terminal', 'failure');
const loadFailed = H.state('load-failed', 'terminal', 'failure');
const expired = H.state('expired', 'terminal', 'neutral');

const loadInput = z.object({ source: z.string(), night: z.string() });

const nightlyLoad = H.kind('nightly-load')
  .data(loadInput)
  .states(scheduled, loaded, loadedWithWarnings, rejected, loadFailed, expired);

const etlHost = ssh.host('etl-host', {
  address: '10.0.1.20',
  user: 'etl',
  key: H.env('ETL_SSH_KEY'),
  slots: 4,
});

const exponential = { first: { minutes: 2 }, factor: 2, max: { minutes: 30 } };

const extract = H.command('extract')
  .input(loadInput)
  .argv(job => ['etl', 'extract', job.source, job.night])
  .on(etlHost)
  .retries(3, exponential)
  .recovery('rerun');
const validate = H.command('validate')
  .input(loadInput)
  .output(z.object({ anomalies: z.array(z.string()) }))
  .argv(job => ['etl', 'validate', job.source, job.night])
  .on(etlHost)
  .recovery('rerun');
const load = H.command('load')
  .input(loadInput)
  .argv(job => ['etl', 'load', job.source, job.night])
  .on(etlHost)
  .retries(3, exponential)
  .recovery('park');
const verify = H.command('verify')
  .input(loadInput)
  .output(z.object({ drift: z.enum(['none', 'tolerable', 'intolerable']), detail: z.string() }))
  .argv(job => ['etl', 'verify', job.source, job.night])
  .on(etlHost)
  .recovery('rerun');

const approverTaste = H.memory('approver-taste', 'taste');
const approverTasteJournal = H.library('approver-taste-journal', approverTaste, jsonl.memory('.harness/approver-taste.jsonl'));

const summarizerRole = H.role('anomaly-summarizer')
  .input(z.object({ source: z.string(), night: z.string(), anomalies: z.array(z.string()) }))
  .output(z.object({ summary: z.string() }))
  .prompt(job => `Summarise in plain language the anomalies found in the ${job.source} extract for ${job.night}:\n${job.anomalies.join('\n')}`)
  .intents(['read']);

const sonnet = anthropic.model('claude-sonnet-4-5');
const summarizer = H.seat('anomaly-summarizer-agent', summarizerRole).model(sonnet).recalls(approverTasteJournal);

const validationFailed = H.halt('validation-failed', z.object({ action: z.enum(['proceed', 'reject']) }))
  .about(z.object({ report: z.string() }));
const loadApproval = H.halt('load-approval', z.object({ approved: z.boolean(), note: z.string().optional() }));

const nightlyFlow = H.flow('nightly-load-flow').for(nightlyLoad).does(async ctx => {
  const job = ctx.unit.data;
  const extracted = await ctx.run(extract, job);
  if (!extracted.ok) return ctx.fail(`extract failed after retries: ${extracted.error}`);
  const validated = await ctx.run(validate, job);
  let anomalies: string[];
  if (validated.ok) {
    anomalies = validated.value.anomalies;
  } else {
    const ruling = await ctx.halt(validationFailed, `Validation failed for ${job.source}`, { report: validated.error });
    if (ruling.action === 'reject') return 'rejected';
    anomalies = [validated.error];
  }
  const summary = await ctx.run(summarizer, { source: job.source, night: job.night, anomalies });
  if (!summary.ok) return ctx.fail(summary.error);
  const approval = await ctx.halt(loadApproval, summary.value.summary);
  if (!approval.approved) return 'rejected';
  const landed = await ctx.run(load, job);
  if (!landed.ok) return ctx.fail(`load failed after retries: ${landed.error}`);
  const verified = await ctx.run(verify, job);
  if (!verified.ok) return ctx.fail(verified.error);
  if (verified.value.drift === 'none') return 'loaded';
  if (verified.value.drift === 'tolerable') return 'loaded-with-warnings';
  return ctx.fail(`intolerable drift: ${verified.value.detail}`);
});

const nightOf = (now: Date): string => now.toISOString().slice(0, 10);

const nightlySchedule = H.clock('nightly-schedule', nightlyLoad, { daily: '02:00' }, tick =>
  sourceSystems.map(source => ({ create: { source, night: nightOf(tick.now) }, key: `${source}-${nightOf(tick.now)}` })));

const nightlyLoads = H.lane('nightly-loads', nightlyLoad)
  .handler(nightlyFlow)
  .suppliers(nightlySchedule)
  .store(sqlite.store(nightlyLoad, '.harness/loads.db'))
  .retries(0, { exhausted: 'load-failed' });

const approvalWindowCloses = H.trigger(
  'approval-window-closes',
  H.on.deadline(nightlyLoad, job => new Date(`${job.night}T09:00:00`), ['scheduled']),
  (_event, act) => act.move('expired')
);

const apiAccount = anthropic.account('anthropic-api', { apiKey: H.env('ANTHROPIC_API_KEY') });
const apiPool = H.pool('data-api', [{ account: apiAccount, share: 1 }]);

const approver = claudeCode.supervisor({
  grants: [
    H.ops.readWork,
    H.ops.resolve(loadApproval, validationFailed, H.halts.interrupted, H.halts.definitionChanged),
    H.ops.readMemory,
    H.ops.writeMemory,
    H.ops.readTelemetry,
  ],
});

export const dataJob = H.harness('nightly-data')
  .ledger(sqlite.ledger('.harness/ledger.db'))
  .lanes(nightlyLoads)
  .pools(apiPool)
  .triggers(approvalWindowCloses)
  .clients(approver)
  .observers(markdown.board('BOARD.md'), markdown.telemetry('TELEMETRY.md'));
