import { z } from 'zod';
import { H } from 'harness-dsl';
import * as sqlite from 'harness-dsl/sqlite';
import * as jsonl from 'harness-dsl/jsonl';
import * as anthropic from 'harness-dsl/anthropic';
import * as claudeCode from 'harness-dsl/claude-code';
import * as ssh from 'harness-dsl/ssh';
import * as markdown from 'harness-dsl/markdown';

const Scheduled = H.state('Scheduled', 'pending');
const Extracting = H.state('Extracting', 'active');
const AwaitingApproval = H.state('AwaitingApproval', 'active');
const Loading = H.state('Loading', 'active');
const Loaded = H.state('Loaded', 'terminal', 'success');
const LoadedWithWarnings = H.state('LoadedWithWarnings', 'terminal', 'success');
const Rejected = H.state('Rejected', 'terminal', 'neutral');
const Expired = H.state('Expired', 'terminal', 'neutral');
const Failed = H.state('Failed', 'terminal', 'failure');

const NightlyLoad = H.work('NightlyLoad')
  .attributes({ source: z.string(), night: z.string(), approvalDeadline: z.number() })
  .states([Scheduled, Extracting, AwaitingApproval, Loading, Loaded, LoadedWithWarnings, Rejected, Expired, Failed])
  .fails(Failed)
  .timers(t => ({ approvalDeadline: t.attribute('approvalDeadline') }))
  .key(u => `${u.attributes.source}@${u.attributes.night}`);

const approverTaste = H.memory.taste('approver-taste');
const tasteJournal = H.journal('approver-taste', approverTaste)
  .store(jsonl.memory('memory/approver-taste.jsonl'))
  .recall(H.policy.recall('broadest-taste', c => [...c.candidates].sort((a, b) => b.specificity - a.specificity).slice(0, c.limit)));

const apiAccount = anthropic.account('data-api', { apiKey: H.env('ANTHROPIC_API_KEY') });

const summarizerRole = H.role('anomaly-summarizer')
  .instructions('Summarise the validation anomalies in plain language for the approver.')
  .input({ source: z.string(), report: z.string(), anomalies: z.array(z.string()) })
  .output({ summary: z.string() });

const summarizer = H.agent('anomaly-summarizer', summarizerRole)
  .model(anthropic.model('claude-sonnet-4-5'))
  .pool(apiAccount)
  .recalls([tasteJournal]);

const LoadApproval = H.decision('load-approval', { approved: z.boolean(), comment: z.string() });

const extract = H.command('extract', ['./etl/extract']).parses({ path: z.string(), rows: z.number() });
const validate = H.command('validate', ['./etl/validate']).parses({ report: z.string(), anomalies: z.array(z.string()) });
const load = H.command('load', ['./etl/load']);
const verify = H.command('verify', ['./etl/verify']).parses({ driftRows: z.number() });

const backoff = H.retry.exponential({ maxRetries: 3, initialDelayMs: 60000, maxDelayMs: 900000 });

const etlHost = ssh.hosts({
  hosts: [{ host: 'etl.internal', user: 'etl', key: H.env('ETL_SSH_KEY') }],
  slotsPerHost: 2,
});

const nightlyLoad = H.flow('nightly-load')
  .requires({ source: z.string() })
  .step('extract', extract, c => ({ args: [c.input.source] }), { retry: backoff, restart: 'rerun' })
  .step('validate', validate, c => ({ args: [c.out.extract.data.path] }), { onFailure: 'halt' })
  .step('summarize', summarizer, c => ({
    source: c.input.source,
    report: c.out.validate.data.report,
    anomalies: c.out.validate.data.anomalies,
  }))
  .mark('awaitingApproval')
  .halt('approval', LoadApproval, { ask: c => `Approve tonight's ${c.input.source} load?\n\n${c.out.summarize.summary}` })
  .exit('rejected', c => !c.out.approval.approved)
  .mark('loading')
  .step('load', load, c => ({ args: [c.out.extract.data.path] }), { retry: backoff, restart: 'park' })
  .step('verify', verify, c => ({ args: [c.input.source] }))
  .ends(['loaded', 'loadedWithWarnings'], c => c.out.verify.data.driftRows === 0 ? 'loaded' : 'loadedWithWarnings');

const loadLane = H.lane('nightly-loads', NightlyLoad)
  .supply([
    H.supply.schedule(NightlyLoad, H.time.daily('02:00', 'Europe/London'), (c, to) =>
      ['crm', 'billing', 'erp', 'inventory'].map(source => to.create({
        attributes: {
          source,
          night: new Date(c.now).toISOString().slice(0, 10),
          approvalDeadline: c.now + 7 * 3600000,
        },
      }))),
  ])
  .store(sqlite.store(NightlyLoad, '.harness/loads.db'))
  .runner(etlHost)
  .reacts({ approvalDeadline: H.reaction(Expired).from([AwaitingApproval]).cancels() })
  .handler(nightlyLoad, {
    ends: { loaded: Loaded, loadedWithWarnings: LoadedWithWarnings, rejected: Rejected },
    marks: { awaitingApproval: AwaitingApproval, loading: Loading },
  });

const oldestFirst = H.policy.schedule('oldest-first', c => ({
  start: [...c.candidates].sort((a, b) => b.waitedMs - a.waitedMs),
}));

const approverAccess = H.access('approver')
  .allows([H.ops.readWork, H.ops.resolveBlocks, H.ops.readMemory, H.ops.writeMemory, H.ops.readTelemetry]);

export const harness = H.harness('nightly-data')
  .ledger(sqlite.ledger('.harness/data.db'))
  .lanes([loadLane])
  .schedule(oldestFirst)
  .clients([claudeCode.supervisor('approver', approverAccess, { port: H.slot.port(0) })])
  .projections([markdown.board('BOARD.md'), markdown.telemetry('TELEMETRY.md')]);
