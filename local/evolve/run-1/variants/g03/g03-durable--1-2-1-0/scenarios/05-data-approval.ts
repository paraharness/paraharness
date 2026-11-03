import { H } from 'harness-dsl';
import { z } from 'zod';
import * as sqlite from 'harness-dsl/sqlite';
import * as jsonl from 'harness-dsl/jsonl';
import * as claudeCode from 'harness-dsl/claude-code';
import * as anthropic from 'harness-dsl/anthropic';
import * as markdown from 'harness-dsl/markdown';
import * as local from 'harness-dsl/local';
import * as ssh from 'harness-dsl/ssh';

const Scheduled = H.state('Scheduled', 'pending');
const Extracting = H.state('Extracting', 'active');
const Validating = H.state('Validating', 'active');
const Summarizing = H.state('Summarizing', 'active');
const AwaitingApproval = H.state('AwaitingApproval', 'active');
const Loading = H.state('Loading', 'active');
const Verifying = H.state('Verifying', 'active');
const Loaded = H.state('Loaded', 'terminal', 'success');
const LoadedWithWarnings = H.state('LoadedWithWarnings', 'terminal', 'success');
const Rejected = H.state('Rejected', 'terminal', 'neutral');
const Expired = H.state('Expired', 'terminal', 'neutral');
const Failed = H.state('Failed', 'terminal', 'failure');

const NightlyLoad = H.work('nightly-load')
  .attributes({ source: z.string(), night: z.string() })
  .states([
    Scheduled, Extracting, Validating, Summarizing, AwaitingApproval, Loading, Verifying,
    Loaded, LoadedWithWarnings, Rejected, Expired, Failed,
  ])
  .failsTo(Failed)
  .timers(() => ({ approvalDeadline: H.time.daily('09:00', 'UTC') }))
  .key(u => `${u.attributes.source}@${u.attributes.night}`);

const apiAccount = anthropic.account('data-api', { apiKey: H.env('ANTHROPIC_API_KEY') });
const sonnet = anthropic.model('claude-sonnet-4-5');

const approverTaste = H.playbook('approver-taste', H.memory.taste('approver-taste'))
  .store(jsonl.memory('.harness/memory/approver-taste.jsonl'))
  .recall(H.policy.recall('broadest-taste', c =>
    c.candidates.slice().sort((a, b) => b.specificity - a.specificity).slice(0, c.limit)));

const summaryRole = H.role('anomaly-summarizer')
  .intents(['read'])
  .instructions('Summarise the anomalies in plain language for the approver, emphasising what they care about.')
  .input({ source: z.string(), report: z.string(), anomalies: z.array(z.string()) })
  .output({ summary: z.string() });

const summarizer = H.agent('anomaly-summarizer', summaryRole)
  .model(sonnet)
  .pool(apiAccount)
  .recalls([approverTaste]);

const extract = H.command('extract', ['etl', 'extract']);
const validate = H.command('validate', ['etl', 'validate'])
  .parses({ report: z.string(), anomalies: z.array(z.string()) });
const load = H.command('load', ['etl', 'load']);
const verify = H.command('verify', ['etl', 'verify']).parses({ driftPct: z.number() });

const approval = H.decision('load-approval', { approve: z.boolean(), note: z.string() });

const backoff = H.retry.exponential({ maxRetries: 3, initialDelayMs: 30_000, maxDelayMs: 600_000 });

const warehouseHosts = ssh.hosts({
  hosts: [{ host: 'etl.internal', user: 'etl', key: H.env('ETL_SSH_KEY') }],
  slotsPerHost: 2,
});

const loadFlow = H.flow('nightly-load')
  .requires({ source: z.string(), night: z.string() })
  .step('extract', extract, c => ({ args: [c.input.source, c.input.night] }), {
    retry: backoff,
    runner: warehouseHosts,
    restart: 'rerun',
  })
  .step('validate', validate, c => ({ args: [c.input.source, c.input.night] }), { onFailure: 'halt', restart: 'rerun' })
  .step('summarize', summarizer, c => ({
    source: c.input.source,
    report: c.out.validate.data.report,
    anomalies: c.out.validate.data.anomalies,
  }))
  .halt('approval', approval, {
    ask: c => `Load ${c.input.source} for ${c.input.night}?\n\n${c.out.summarize.summary}`,
  })
  .exit('rejected', c => !c.out.approval.approve)
  .step('load', load, c => ({ args: [c.input.source, c.input.night] }), {
    retry: backoff,
    runner: warehouseHosts,
  })
  .step('verify', verify, c => ({ args: [c.input.source, c.input.night] }), { restart: 'rerun' })
  .ends(['loaded', 'loadedWithWarnings'], c => c.out.verify.data.driftPct > 0 ? 'loadedWithWarnings' : 'loaded');

const sources = ['crm', 'billing', 'inventory', 'support'];

const loads = H.lane('nightly-loads', NightlyLoad)
  .supply([
    H.supply.schedule(NightlyLoad, H.time.daily('02:00', 'UTC'), (c, s) =>
      sources.map(source => s.create({ attributes: { source, night: new Date(c.now).toISOString().slice(0, 10) } }))),
  ])
  .store(sqlite.store(NightlyLoad, '.harness/loads.db'))
  .runner(local.shell({ slots: 4 }))
  .reacts({ approvalDeadline: H.reaction(Expired).from([AwaitingApproval]).cancels() })
  .handler(loadFlow, {
    opens: Extracting,
    during: {
      validate: Validating,
      summarize: Summarizing,
      approval: AwaitingApproval,
      load: Loading,
      verify: Verifying,
    },
    ends: { loaded: Loaded, loadedWithWarnings: LoadedWithWarnings, rejected: Rejected },
  });

const approverAccess = H.access('approver').allows([
  H.ops.readWork,
  H.ops.resolveBlocks,
  H.ops.manageAttempts,
  H.ops.readMemory,
  H.ops.writeMemory,
  H.ops.readTelemetry,
]);

export const harness = H.harness('nightly-data')
  .ledger(sqlite.ledger('.harness/ledger.db'))
  .lanes([loads])
  .schedule(H.policy.schedule('arrival-order', c => ({ start: c.order(x => x.enqueuedAt) })))
  .clients([claudeCode.supervisor('approver', approverAccess, { port: H.slot.port(0) })])
  .projections([markdown.board('BOARD.md'), markdown.telemetry('TELEMETRY.md')]);
