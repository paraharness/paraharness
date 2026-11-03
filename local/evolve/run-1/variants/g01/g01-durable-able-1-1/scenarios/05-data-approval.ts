import { z } from 'zod';
import { H } from 'harness-dsl';
import * as sqlite from 'harness-dsl/sqlite';
import * as jsonl from 'harness-dsl/jsonl';
import * as anthropic from 'harness-dsl/anthropic';
import * as claudeCode from 'harness-dsl/claude-code';
import * as markdown from 'harness-dsl/markdown';
import * as local from 'harness-dsl/local';
import * as ssh from 'harness-dsl/ssh';

const Scheduled = H.state.pending('Scheduled');
const Extracting = H.state.active('Extracting');
const Validating = H.state.active('Validating');
const Summarizing = H.state.active('Summarizing');
const AwaitingApproval = H.state.active('AwaitingApproval');
const Loading = H.state.active('Loading');
const Verifying = H.state.active('Verifying');
const Loaded = H.state.terminal('Loaded', 'success');
const LoadedWithWarnings = H.state.terminal('LoadedWithWarnings', 'success');
const Rejected = H.state.terminal('Rejected', 'neutral');
const ApprovalExpired = H.state.terminal('ApprovalExpired', 'neutral');
const LoadFailed = H.state.terminal('LoadFailed', 'failure');

export const NightlyLoad = H.work('NightlyLoad')
  .attributes({ source: z.string(), night: z.string() })
  .states([Scheduled, Extracting, Validating, Summarizing, AwaitingApproval, Loading, Verifying, Loaded, LoadedWithWarnings, Rejected, ApprovalExpired, LoadFailed])
  .timers(() => ({ approvalDeadline: H.time.daily('09:00', 'Europe/London') }))
  .key(u => `${u.attributes.source}:${u.attributes.night}`);

const sourceSystems = ['billing', 'crm', 'inventory', 'web-analytics'];

const dataHosts = ssh.hosts({
  hosts: [{ host: 'etl-1.internal', user: 'etl', key: H.env('SSH_KEY_ETL') }],
  slotsPerHost: 2,
});

const backoff = H.retry.exponential({ maxRetries: 3, initialDelayMs: 60_000, maxDelayMs: 15 * 60_000 });

const extract = H.command('extract', ['/opt/etl/extract.sh']);
const validate = H.command('validate', ['/opt/etl/validate.sh']);
const load = H.command('load', ['/opt/etl/load.sh']);
const verify = H.command('verify', ['/opt/etl/verify.sh']).parses({ driftPercent: z.number() });

const approverTaste = H.journal('approver-taste', H.memory.taste('approver-taste'))
  .store(jsonl.memory('memory/approver-taste.jsonl'))
  .recall(H.policy.recall('broadest-taste-first', c => [...c.candidates].sort((a, b) => a.specificity - b.specificity).slice(0, c.limit)));

const summarizerRole = H.role('anomaly-summarizer')
  .instructions('Summarize the anomalies in the validation report in plain language for the approver.')
  .input({ source: z.string(), report: z.string() })
  .output({ summary: z.string() });

const summarizer = H.agent('anomaly-summarizer', summarizerRole)
  .model(anthropic.model('claude-sonnet-4-5'))
  .pool(anthropic.account('data-api', { apiKey: H.env('ANTHROPIC_API_KEY') }))
  .recalls([approverTaste]);

const nightlyLoad = H.flow('nightly-load')
  .requires({ source: z.string() })
  .mark('extracting')
  .step('extract', extract, c => ({ args: [c.input.source] }), { retry: backoff, runner: dataHosts, onRestart: 'rerun' })
  .mark('validating')
  .step('validate', validate, c => ({ args: [c.input.source] }), { onFailure: 'halt', onRestart: 'rerun' })
  .mark('summarizing')
  .step('summarize', summarizer, c => ({ source: c.input.source, report: c.out.validate.stdout }), { onRestart: 'reconcile' })
  .mark('awaitingApproval')
  .halt('approval', {
    ask: c => `Load ${c.input.source}?\n\n${c.out.summarize.summary}`,
    decision: { approved: z.boolean(), notes: z.string() },
  })
  .exit('rejected', c => !c.out.approval.approved)
  .mark('loading')
  .step('load', load, c => ({ args: [c.input.source] }), { retry: backoff, runner: dataHosts, onRestart: 'park' })
  .mark('verifying')
  .step('verify', verify, c => ({ args: [c.input.source] }), { onRestart: 'rerun' })
  .ends(['loaded', 'loadedWithWarnings'], c => (c.out.verify.data.driftPercent > 0 ? 'loadedWithWarnings' : 'loaded'));

export const nightlyLoads = H.lane('nightly-loads', NightlyLoad)
  .supply([
    H.supply.schedule(NightlyLoad, H.time.daily('02:00', 'Europe/London'), c =>
      sourceSystems.map(source => ({
        create: { attributes: { source, night: new Date(c.now).toISOString().slice(0, 10) } },
      })),
    ),
  ])
  .store(sqlite.store(NightlyLoad, '.harness/nightly-loads.db'))
  .handler(nightlyLoad, {
    states: {
      extracting: Extracting,
      validating: Validating,
      summarizing: Summarizing,
      awaitingApproval: AwaitingApproval,
      rejected: Rejected,
      loading: Loading,
      verifying: Verifying,
      loaded: Loaded,
      loadedWithWarnings: LoadedWithWarnings,
      failed: LoadFailed,
    },
  })
  .runner(local.shell({ slots: 4 }))
  .reacts({ approvalDeadline: r => r.to(ApprovalExpired).from([AwaitingApproval]) });

const approverAccess = H.access('approver').allows([
  H.ops.readWork,
  H.ops.resolveBlocks,
  H.ops.recoverAttempts,
  H.ops.readMemory,
  H.ops.writeMemory,
  H.ops.readTelemetry,
]);

const oldestFirst = H.policy.schedule('oldest-first', c => ({
  start: [...c.candidates].sort((a, b) => b.waitedMs - a.waitedMs),
}));

export const dataJob = H.harness('nightly-data-job')
  .ledger(sqlite.ledger('.harness/data.db'))
  .lanes([nightlyLoads])
  .schedule(oldestFirst)
  .clients([claudeCode.supervisor('approver-supervisor', approverAccess, { port: H.slot.port(0) })])
  .projections([markdown.board('BOARD.md'), markdown.telemetry('TELEMETRY.md')]);
