import { z } from 'zod';
import { H } from 'harness-dsl';
import * as sqlite from 'harness-dsl/sqlite';
import * as jsonl from 'harness-dsl/jsonl';
import * as anthropic from 'harness-dsl/anthropic';
import * as claudeCode from 'harness-dsl/claude-code';
import * as local from 'harness-dsl/local';
import * as ssh from 'harness-dsl/ssh';
import * as markdown from 'harness-dsl/markdown';

const Scheduled = H.state('Scheduled', 'pending');
const Running = H.state('Running', 'active');
const AwaitingApproval = H.state('AwaitingApproval', 'waiting');
const Loaded = H.state('Loaded', 'terminal', 'success');
const LoadedWithWarnings = H.state('LoadedWithWarnings', 'terminal', 'success');
const Rejected = H.state('Rejected', 'terminal', 'neutral');
const Expired = H.state('Expired', 'terminal', 'neutral');
const Failed = H.state('Failed', 'terminal', 'failure');

const NightlyLoad = H.work('NightlyLoad')
  .attributes({ source: z.string(), night: z.string() })
  .states([Scheduled, Running, AwaitingApproval, Loaded, LoadedWithWarnings, Rejected, Expired, Failed])
  .timers(() => ({ approvalDeadline: H.time.daily('09:00', 'Europe/London') }))
  .failsTo(Failed)
  .key(u => `${u.attributes.source}@${u.attributes.night}`);

const extract = H.command('extract', ['./etl/extract.sh']);
const validate = H.command('validate', ['./etl/validate.sh']);
const load = H.command('load', ['./etl/load.sh']);
const verify = H.command('verify', ['./etl/verify.sh']).parses({ drift: z.number() });

const loadApproval = H.decision('loadApproval', { approved: z.boolean(), note: z.string() });

const ApproverTaste = H.memory.taste('approverTaste').curated();
const bySpecificity = H.policy.recall('bySpecificity', c =>
  [...c.candidates].sort((a, b) => b.specificity - a.specificity).slice(0, c.limit));
const approverTaste = H.journal('approverTaste', ApproverTaste)
  .store(jsonl.memory('.harness/approver-taste.jsonl'))
  .recall(bySpecificity);

const summarizerRole = H.role('anomalySummarizer')
  .instructions('Summarise the validation report as plain-language anomalies for the approver.')
  .input({ source: z.string(), report: z.string() })
  .output({ summary: z.string() });

const summarizer = H.agent('anomalySummarizer', summarizerRole)
  .model(anthropic.model('claude-sonnet-4-5'))
  .pool(anthropic.account('anthropicApi', { apiKey: H.env('ANTHROPIC_API_KEY') }))
  .recalls([approverTaste]);

const sourceHosts = ssh.hosts({
  hosts: [{ host: 'etl.internal', user: 'etl', key: H.env('ETL_SSH_KEY') }],
  slotsPerHost: 2,
});
const stepRetry = H.retry.exponential({ maxRetries: 3, initialDelayMs: 60_000, maxDelayMs: 900_000 });

const nightlyFlow = H.flow('nightlyLoad')
  .requires({ source: z.string(), night: z.string() })
  .step('extract', extract, c => ({ args: [c.input.source, c.input.night] }), { runner: sourceHosts, retry: stepRetry, restart: 'rerun' })
  .step('validate', validate, c => ({ args: [c.input.source, c.input.night] }), { onFailure: 'halt', restart: 'rerun' })
  .step('summarize', summarizer, c => ({ source: c.input.source, report: c.out.validate.stdout }))
  .halt('approval', loadApproval, { ask: c => `Approve tonight's load of ${c.input.source}?\n\n${c.out.summarize.summary}` })
  .exit('rejected', c => !c.out.approval.approved)
  .step('load', load, c => ({ args: [c.input.source, c.input.night] }), { retry: stepRetry })
  .step('verify', verify, c => ({ args: [c.input.source, c.input.night] }), { restart: 'rerun' })
  .ends(['loaded', 'loadedWithWarnings'], c => (c.out.verify.data.drift > 0 ? 'loadedWithWarnings' : 'loaded'));

const sourceSystems = ['billing', 'crm', 'inventory', 'web'];

const loads = H.lane('nightlyLoads', NightlyLoad)
  .supply([
    H.supply.schedule(NightlyLoad, H.time.daily('02:00', 'Europe/London'), (c, supply) =>
      sourceSystems.map(source =>
        supply.create({ attributes: { source, night: new Date(c.now).toISOString().slice(0, 10) } }))),
  ])
  .store(sqlite.store(NightlyLoad, '.harness/loads.db'))
  .handler(nightlyFlow, {
    opens: Running,
    halts: { approval: AwaitingApproval },
    ends: { loaded: Loaded, loadedWithWarnings: LoadedWithWarnings, rejected: Rejected },
  })
  .runner(local.shell({ slots: 4 }));

const approvalExpired = H.trigger('approvalExpired', H.on.event(loads, 'approvalDeadline'))
  .moves(Expired, { from: [AwaitingApproval], cancels: true });

const byArrival = H.policy.schedule('byArrival', c => ({ start: c.order(k => k.enqueuedAt) }));

const approverAccess = H.access('approver').allows([
  H.ops.readWork,
  H.ops.resolveBlocks,
  H.ops.manageAttempts,
  H.ops.readMemory,
  H.ops.writeMemory,
  H.ops.readTelemetry,
]);

export const dataJob = H.harness('dataJob')
  .ledger(sqlite.ledger('.harness/data-job.db'))
  .lanes([loads])
  .triggers([approvalExpired])
  .schedule(byArrival)
  .clients([claudeCode.supervisor('approver', approverAccess, { port: H.slot.port(0) })])
  .projections([markdown.board('BOARD.md'), markdown.telemetry('TELEMETRY.md')]);
