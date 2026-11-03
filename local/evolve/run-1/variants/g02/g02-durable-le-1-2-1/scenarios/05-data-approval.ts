import { z } from 'zod';
import { H } from 'harness-dsl';
import * as sqlite from 'harness-dsl/sqlite';
import * as jsonl from 'harness-dsl/jsonl';
import * as claudeCode from 'harness-dsl/claude-code';
import * as anthropic from 'harness-dsl/anthropic';
import * as markdown from 'harness-dsl/markdown';
import * as local from 'harness-dsl/local';
import * as ssh from 'harness-dsl/ssh';

const Scheduled = H.state('Scheduled', 'pending');
const Loading = H.state('Loading', 'active');
const AwaitingApproval = H.state('AwaitingApproval', 'active');
const Loaded = H.state('Loaded', 'terminal', 'success');
const LoadedWithWarnings = H.state('LoadedWithWarnings', 'terminal', 'success');
const Rejected = H.state('Rejected', 'terminal', 'failure');
const Expired = H.state('Expired', 'terminal', 'neutral');
const LoadFailed = H.state('LoadFailed', 'terminal', 'failure');

const nightlyLoadKind = H.work('NightlyLoad')
  .attributes({ source: z.string(), night: z.string() })
  .states([Scheduled, Loading, AwaitingApproval, Loaded, LoadedWithWarnings, Rejected, Expired, LoadFailed])
  .failsTo(LoadFailed)
  .timers(() => ({ approvalCutoff: H.time.daily('09:00') }))
  .key(unit => `${unit.attributes.source}:${unit.attributes.night}`);

const apiAccount = anthropic.account('anthropic-api', { apiKey: H.env('ANTHROPIC_API_KEY') });
const sonnet = anthropic.model('claude-sonnet-4-5');

const bySpecificityAndTrack = H.policy.recall('bySpecificityAndTrack', c =>
  [...c.candidates]
    .sort((a, b) =>
      b.specificity - a.specificity ||
      b.track.succeeded / Math.max(1, b.track.present) - a.track.succeeded / Math.max(1, a.track.present))
    .slice(0, c.limit));

const approverTaste = H.journal('approverTaste', H.memory.taste('approverPreferences'))
  .store(jsonl.memory('loads/memory/taste.jsonl'))
  .recall(bySpecificityAndTrack);

const summarizerRole = H.role('anomalySummarizer')
  .intents(['read'])
  .instructions('Summarise the anomalies in the validation report in plain language for the approver.')
  .input({ source: z.string(), report: z.string() })
  .output({ summary: z.string() });

const summarizer = H.agent('anomalySummarizer', summarizerRole)
  .model(sonnet)
  .pool(apiAccount)
  .recalls([approverTaste]);

const extract = H.command('extract', ['./etl/extract.sh']);
const validate = H.command('validate', ['./etl/validate.sh']);
const load = H.command('load', ['./etl/load.sh']);
const verify = H.command('verify', ['./etl/verify.sh']).parses({ driftRows: z.number(), tolerable: z.boolean() });

const sourceHosts = ssh.hosts({
  hosts: [{ host: 'etl.internal', user: 'etl', key: H.env('ETL_SSH_KEY') }],
  slotsPerHost: 4,
});

const transientRetry = H.retry.exponential({ maxRetries: 3, initialDelayMs: 60000, maxDelayMs: 900000 });

const approvalDecision = H.decision('loadApproval', { approved: z.boolean(), note: z.string() });

const nightlyLoadFlow = H.flow('nightlyLoad')
  .requires({ source: z.string() })
  .step('extract', extract, c => ({ args: [c.input.source] }), { runner: sourceHosts, retry: transientRetry, restart: 'rerun' })
  .step('validate', validate, c => ({ args: [c.input.source] }), { onFailure: 'halt', restart: 'rerun' })
  .step('summarize', summarizer, c => ({ source: c.input.source, report: c.out.validate.stdout }))
  .mark('awaitingApproval')
  .halt('approval', approvalDecision, {
    ask: c => `Approve tonight's load of ${c.input.source}?\n\n${c.out.summarize.summary}`,
  })
  .exit('rejected', c => !c.out.approval.approved)
  .mark('loading')
  .step('load', load, c => ({ args: [c.input.source] }), { retry: transientRetry, restart: 'escalate' })
  .step('verify', verify, c => ({ args: [c.input.source] }), { restart: 'rerun' })
  .ends(['loaded', 'loadedWithWarnings'], c => c.out.verify.data.driftRows > 0 ? 'loadedWithWarnings' : 'loaded');

const sourceSystems = ['billing', 'crm', 'inventory', 'payroll'];

const nightlyLoads = H.lane('nightlyLoads', nightlyLoadKind)
  .supply([
    H.supply.schedule(nightlyLoadKind, H.time.daily('02:00'), (c, supply) =>
      sourceSystems.map(source => supply.create({
        attributes: { source, night: new Date(c.now).toISOString().slice(0, 10) },
      }))),
  ])
  .store(sqlite.store(nightlyLoadKind, 'loads/units.db'))
  .handler(nightlyLoadFlow, {
    states: {
      awaitingApproval: AwaitingApproval,
      loading: Loading,
      rejected: Rejected,
      loaded: Loaded,
      loadedWithWarnings: LoadedWithWarnings,
    },
    opens: Loading,
  })
  .runner(local.shell({ slots: 4 }))
  .reacts({ approvalCutoff: H.reaction(Expired).from([AwaitingApproval]).cancels() });

const loadsInOrder = H.policy.schedule('loadsInOrder', c => ({
  start: c.order(candidate => candidate.enqueuedAt),
}));

const approverAccess = H.access('approver').allows([
  H.ops.readWork,
  H.ops.resolveBlocks,
  H.ops.manageAttempts,
  H.ops.readMemory,
  H.ops.writeMemory,
  H.ops.readTelemetry,
]);

export const dataApproval = H.harness('nightly-loads')
  .ledger(sqlite.ledger('loads/ledger.db'))
  .lanes([nightlyLoads])
  .schedule(loadsInOrder)
  .clients([claudeCode.supervisor('approver', approverAccess, { port: H.slot.port(0) })])
  .projections([markdown.board('loads/BOARD.md'), markdown.telemetry('loads/TELEMETRY.md')]);
