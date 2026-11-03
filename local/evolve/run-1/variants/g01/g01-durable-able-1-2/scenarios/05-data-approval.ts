import { H } from 'harness-dsl';
import { z } from 'zod';
import * as anthropic from 'harness-dsl/anthropic';
import * as sqlite from 'harness-dsl/sqlite';
import * as jsonl from 'harness-dsl/jsonl';
import * as ssh from 'harness-dsl/ssh';
import * as local from 'harness-dsl/local';
import * as claudeCode from 'harness-dsl/claude-code';
import * as markdown from 'harness-dsl/markdown';

const sourceSystems = ['crm', 'billing', 'inventory', 'support'];
const approvalWindowMs = 7 * 60 * 60 * 1000;

const LoadScheduled = H.state('LoadScheduled', 'pending');
const LoadAwaitingApproval = H.state('LoadAwaitingApproval', 'active');
const Loaded = H.state('Loaded', 'terminal', 'success');
const LoadedWithWarnings = H.state('LoadedWithWarnings', 'terminal', 'success');
const LoadRejected = H.state('LoadRejected', 'terminal', 'neutral');
const LoadExpired = H.state('LoadExpired', 'terminal', 'neutral');
const LoadFailed = H.state('LoadFailed', 'terminal', 'failure');

const NightlyLoad = H.work('NightlyLoad')
  .attributes({ source: z.string(), night: z.number(), approvalDeadline: z.number() })
  .states([LoadScheduled, LoadAwaitingApproval, Loaded, LoadedWithWarnings, LoadRejected, LoadExpired, LoadFailed])
  .timers((t) => ({ approvalExpires: t.attribute('approvalDeadline') }))
  .key((u) => `${u.attributes.source}@${u.attributes.night}`);

const approverTaste = H.memory.taste('approver-taste');
const tasteJournal = H.journal('approver-taste-journal', approverTaste)
  .store(jsonl.memory('memory/taste.jsonl'))
  .recall(H.policy.recall('specific-first', (c) => [...c.candidates].sort((a, b) => b.specificity - a.specificity).slice(0, c.limit)));

const apiAccount = anthropic.account('data-api', { apiKey: H.env('ANTHROPIC_API_KEY') });
const sonnet = anthropic.model('claude-sonnet-4-5');

const summaryRole = H.role('anomaly-summarizer')
  .intents(['read'])
  .instructions('Summarise the anomalies in the validation report in plain language for the approver.')
  .input({ source: z.string(), report: z.string() })
  .output({ summary: z.string() });

const summarizer = H.agent('anomaly-summarizer', summaryRole).model(sonnet).pool(apiAccount).recalls([tasteJournal]);

const extract = H.command('extract', ['./bin/extract']);
const validate = H.command('validate', ['./bin/validate']);
const load = H.command('load', ['./bin/load']);
const verify = H.command('verify', ['./bin/verify']).parses({ driftPercent: z.number() });

const loadApproval = H.decision('load-approval', { approve: z.boolean(), note: z.string() });

const backoff = H.retry.exponential({ maxRetries: 3, initialDelayMs: 30_000, maxDelayMs: 600_000 });

const sshHosts = ssh.hosts({
  hosts: [{ host: 'etl.internal', user: 'etl', key: H.env('ETL_SSH_KEY') }],
  slotsPerHost: 2,
});

const nightlyFlow = H.flow('nightly-load')
  .requires({ source: z.string() })
  .step('extract', extract, (c) => ({ args: [c.input.source] }), { runner: sshHosts, retry: backoff, restart: 'rerun' })
  .step('validate', validate, (c) => ({ args: [c.input.source] }), { onFailure: 'halt', restart: 'rerun' })
  .step('summarize', summarizer, (c) => ({ source: c.input.source, report: c.out.validate.stdout }))
  .mark('awaitingApproval')
  .halt('approval', loadApproval, { ask: (c) => `Approve tonight's ${c.input.source} load?\n\n${c.out.summarize.summary}` })
  .exit('rejected', (c) => !c.out.approval.approve)
  .step('load', load, (c) => ({ args: [c.input.source] }), { runner: sshHosts, retry: backoff, restart: 'park' })
  .step('verify', verify, (c) => ({ args: [c.input.source] }), { restart: 'rerun' })
  .ends(['loaded', 'loadedWithWarnings'], (c) => (c.out.verify.data.driftPercent > 0 ? 'loadedWithWarnings' : 'loaded'));

const loadLane = H.lane('nightly-loads', NightlyLoad)
  .supply([
    H.supply.schedule(NightlyLoad, H.time.daily('02:00', 'Europe/Berlin'), (c) =>
      sourceSystems.map((source) => ({
        create: { attributes: { source, night: c.now, approvalDeadline: c.now + approvalWindowMs } },
      })),
    ),
  ])
  .store(sqlite.store(NightlyLoad, 'state/loads.sqlite'))
  .runner(local.shell({ slots: 4 }))
  .handler(nightlyFlow, {
    states: {
      awaitingApproval: LoadAwaitingApproval,
      rejected: LoadRejected,
      loaded: Loaded,
      loadedWithWarnings: LoadedWithWarnings,
      failed: LoadFailed,
    },
  })
  .reacts({ approvalExpires: H.reaction(LoadExpired).from([LoadAwaitingApproval]) });

const arrivalOrder = H.policy.schedule('arrival-order', (c) => ({
  start: [...c.candidates].sort((a, b) => a.entry.enqueuedAt - b.entry.enqueuedAt),
}));

const approverAccess = H.access('approver').allows([
  H.ops.readWork,
  H.ops.resolveBlocks,
  H.ops.manageAttempts,
  H.ops.readMemory,
  H.ops.writeMemory,
  H.ops.readTelemetry,
]);

export const harness = H.harness('nightly-data')
  .ledger(sqlite.ledger('state/ledger.sqlite'))
  .lanes([loadLane])
  .schedule(arrivalOrder)
  .clients([claudeCode.supervisor('approver', approverAccess, { port: H.slot.port(0) })])
  .projections([markdown.board('BOARD.md'), markdown.telemetry('TELEMETRY.md')]);
