import { z } from 'zod';
import { H } from 'harness-dsl';
import * as sqlite from 'harness-dsl/sqlite';
import * as jsonl from 'harness-dsl/jsonl';
import * as claude from 'harness-dsl/claude-code';
import * as anthropic from 'harness-dsl/anthropic';
import * as markdown from 'harness-dsl/markdown';
import * as local from 'harness-dsl/local';
import * as ssh from 'harness-dsl/ssh';

const HOUR = 60 * 60 * 1000;
const APPROVAL_WINDOW_MS = 7 * HOUR;

const Scheduled = H.state('scheduled', 'pending');
const Running = H.state('running', 'active');
const AwaitingApproval = H.state('awaiting-approval', 'active');
const Loaded = H.state('loaded', 'terminal', 'success');
const LoadedWithWarnings = H.state('loaded-with-warnings', 'terminal', 'success');
const Rejected = H.state('rejected', 'terminal', 'failure');
const Failed = H.state('failed', 'terminal', 'failure');
const Expired = H.state('expired', 'terminal', 'neutral');

const NightlyLoad = H.work('NightlyLoad')
  .attributes({ source: z.string(), night: z.string(), approvalDeadlineAt: z.number() })
  .states([Scheduled, Running, AwaitingApproval, Loaded, LoadedWithWarnings, Rejected, Failed, Expired])
  .timers((t) => ({ approvalDeadline: t.attribute('approvalDeadlineAt') }))
  .key((unit) => `${unit.attributes.source}:${unit.attributes.night}`);

const warehouseHosts = ssh.hosts({
  hosts: [{ host: 'etl-1.internal', user: 'etl', key: H.env('ETL_SSH_KEY') }],
  slotsPerHost: 2,
});

const backoff = H.retry.exponential({ maxRetries: 3, initialDelayMs: 30000, maxDelayMs: 600000 });

const extract = H.command('extract', ['./etl/extract.sh']);
const validate = H.command('validate', ['./etl/validate.sh']).parses({
  rows: z.number(),
  anomalies: z.array(z.string()),
});
const load = H.command('load', ['./etl/load.sh']);
const loadLanded = H.command('load-landed', ['./etl/load-landed.sh']);
const verify = H.command('verify', ['./etl/verify.sh']).parses({ driftPct: z.number() });

const approverTaste = H.journal('approver-taste', H.memory.taste('approver-taste'))
  .store(jsonl.memory('memory/approver-taste.jsonl'))
  .recall(
    H.policy.recall('specific-first', (c) =>
      [...c.candidates].sort((a, b) => b.specificity - a.specificity).slice(0, c.limit),
    ),
  );

const summarizerRole = H.role('anomaly-summarizer')
  .intents(['read'])
  .instructions('Summarise the validation anomalies in plain language for the approver.')
  .input({ source: z.string(), rows: z.number(), anomalies: z.array(z.string()) })
  .output({ summary: z.string() });

const summarizer = H.agent('anomaly-summarizer', summarizerRole)
  .model(anthropic.model('claude-sonnet-4-5'))
  .pool(anthropic.account('api', { apiKey: H.env('ANTHROPIC_API_KEY') }))
  .recalls([approverTaste]);

const nightlyFlow = H.flow('nightly-load')
  .requires({ source: z.string(), night: z.string() })
  .mark('running')
  .step('extract', extract, (c) => ({ args: [c.input.source, c.input.night] }), {
    retry: backoff,
    runner: warehouseHosts,
    onRestart: 'rerun',
  })
  .step('validate', validate, (c) => ({ args: [c.input.source, c.input.night] }), {
    onFailure: 'halt',
    onRestart: 'rerun',
  })
  .step('summarize', summarizer, (c) => ({
    source: c.input.source,
    rows: c.out.validate.data.rows,
    anomalies: c.out.validate.data.anomalies,
  }))
  .mark('awaiting')
  .halt('approval', {
    ask: (c) => `Load ${c.input.source} for ${c.input.night}?\n\n${c.out.summarize.summary}`,
    decision: { approved: z.boolean(), note: z.string() },
  })
  .exit('rejected', (c) => c.out.approval.approved === false)
  .mark('loading')
  .step('load', load, (c) => ({ args: [c.input.source, c.input.night] }), {
    retry: backoff,
    runner: warehouseHosts,
    onRestart: 'park',
    confirm: loadLanded,
  })
  .step('verify', verify, (c) => ({ args: [c.input.source, c.input.night] }), { onRestart: 'rerun' })
  .ends(['loaded', 'loaded-with-warnings'], (c) =>
    c.out.verify.data.driftPct > 0 ? 'loaded-with-warnings' : 'loaded',
  );

const loads = H.lane('nightly-loads', NightlyLoad)
  .supply([
    H.supply.schedule(NightlyLoad, H.time.daily('02:00', 'UTC'), (c) =>
      ['billing', 'crm', 'inventory', 'web'].map((source) => ({
        create: {
          attributes: {
            source,
            night: new Date(c.now).toISOString().slice(0, 10),
            approvalDeadlineAt: c.now + APPROVAL_WINDOW_MS,
          },
        },
      })),
    ),
  ])
  .store(sqlite.store(NightlyLoad, '.harness/loads.sqlite'))
  .handler(nightlyFlow, {
    states: {
      running: Running,
      loading: Running,
      awaiting: AwaitingApproval,
      rejected: Rejected,
      loaded: Loaded,
      'loaded-with-warnings': LoadedWithWarnings,
      failed: Failed,
    },
  })
  .runner(local.shell({ slots: 4 }));

const approvalWindowCloses = H.trigger(
  'approval-window-closes',
  H.on.signal(loads, 'approvalDeadline'),
).moves(loads, { key: (event) => event.unit.key, to: Expired, from: [AwaitingApproval] });

const oldestFirst = H.policy.schedule('oldest-first', (c) => ({
  start: [...c.candidates].sort((a, b) => b.waitedMs - a.waitedMs),
}));

const approverAccess = H.access('approver').allows([
  H.ops.readWork,
  H.ops.resolveBlocks,
  H.ops.readMemory,
  H.ops.writeMemory,
  H.ops.readTelemetry,
]);

export default H.harness('nightly-data')
  .ledger(sqlite.ledger('.harness/nightly.sqlite'))
  .lanes([loads])
  .triggers([approvalWindowCloses])
  .schedule(oldestFirst)
  .clients([claude.supervisor('approver', approverAccess, { port: H.slot.port(0) })])
  .projections([markdown.board('BOARD.md'), markdown.telemetry('TELEMETRY.md')]);
