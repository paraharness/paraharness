import { z } from 'zod';
import { H } from 'harness-dsl';
import * as sqlite from 'harness-dsl/sqlite';
import * as jsonl from 'harness-dsl/jsonl';
import * as claude from 'harness-dsl/claude-code';
import * as anthropic from 'harness-dsl/anthropic';
import * as markdown from 'harness-dsl/markdown';
import * as local from 'harness-dsl/local';
import * as ssh from 'harness-dsl/ssh';

const Scheduled = H.state('scheduled', 'pending');
const Running = H.state('running', 'active');
const AwaitingApproval = H.state('awaiting-approval', 'active');
const Loading = H.state('loading', 'active');
const Loaded = H.state('loaded', 'terminal', 'success');
const LoadedWithWarnings = H.state('loaded-with-warnings', 'terminal', 'success');
const Rejected = H.state('rejected', 'terminal', 'neutral');
const Expired = H.state('expired', 'terminal', 'neutral');
const LoadFailed = H.state('failed', 'terminal', 'failure');

const NightlyLoad = H.work('nightly-load')
  .attributes({ source: z.string(), night: z.string(), approvalDueAt: z.number() })
  .states([Scheduled, Running, AwaitingApproval, Loading, Loaded, LoadedWithWarnings, Rejected, Expired, LoadFailed])
  .timers((t) => ({ approvalDeadline: t.attribute('approvalDueAt') }))
  .key((u) => `${u.attributes.source}:${u.attributes.night}`);

const ApproverTaste = H.memory.taste('approver-taste');

const bySpecificity = H.policy.recall('specificity-then-track-record', (c) =>
  [...c.candidates]
    .sort((a, b) => b.specificity - a.specificity || b.track.succeeded - a.track.succeeded)
    .slice(0, c.limit),
);

const tasteJournal = H.journal('approver-taste', ApproverTaste)
  .store(jsonl.memory('./memory/approver-taste.jsonl'))
  .recall(bySpecificity);

const apiAccount = anthropic.account('data-api', { apiKey: H.env('ANTHROPIC_API_KEY') });
const sonnet = anthropic.model('claude-sonnet-4-5');

const summaryRole = H.role('anomaly-summarizer')
  .intents(['read'])
  .instructions('Summarise the validation anomalies in plain language for the approver.')
  .input({ source: z.string(), night: z.string(), report: z.string(), anomalies: z.array(z.string()) })
  .output({ summary: z.string() });

const summarizer = H.agent('anomaly-summarizer', summaryRole).model(sonnet).pool(apiAccount).recalls([tasteJournal]);

const extract = H.command('extract', ['./etl/extract.sh']);
const validate = H.command('validate', ['./etl/validate.sh']).parses({
  anomalies: z.array(z.string()),
  rows: z.number(),
});
const load = H.command('load', ['./etl/load.sh']);
const verify = H.command('verify', ['./etl/verify.sh']).parses({ driftPct: z.number() });

const extractHosts = ssh.hosts({
  hosts: [{ host: 'etl.internal', user: 'etl', key: H.env('ETL_SSH_KEY') }],
  slotsPerHost: 4,
});

const backoff = H.retry.exponential({ maxRetries: 3, initialDelayMs: 60_000, maxDelayMs: 15 * 60_000 });

const nightlyLoadFlow = H.flow('nightly-load')
  .requires({ source: z.string(), night: z.string() })
  .mark('running')
  .step('extract', extract, (c) => ({ args: [c.input.source, c.input.night] }), {
    runner: extractHosts,
    retry: backoff,
    effect: 'repeatable',
  })
  .step('validate', validate, (c) => ({ args: [c.input.source, c.input.night] }), { onFailure: 'halt' })
  .step('summarize', summarizer, (c) => ({
    source: c.input.source,
    night: c.input.night,
    report: c.out.validate.stdout,
    anomalies: c.out.validate.data.anomalies,
  }))
  .mark('awaiting-approval')
  .halt('approve', {
    ask: (c) =>
      `Load ${c.out.validate.data.rows} rows from ${c.input.source} for ${c.input.night}?\n\n${c.out.summarize.summary}`,
    decision: { approved: z.boolean(), note: z.string() },
  })
  .exit('rejected', (c) => !c.out.approve.approved)
  .mark('loading')
  .step('load', load, (c) => ({ args: [c.input.source, c.input.night] }), { retry: backoff })
  .step('verify', verify, (c) => ({ args: [c.input.source, c.input.night] }))
  .ends(['loaded', 'loaded-with-warnings'], (c) =>
    c.out.verify.data.driftPct > 0 ? 'loaded-with-warnings' : 'loaded',
  );

const sources = ['crm', 'billing', 'inventory', 'support'];
const approvalWindowMs = 7 * 60 * 60 * 1000;

const nightlyLoadLane = H.lane('nightly-loads', NightlyLoad)
  .supply([
    H.supply.schedule(NightlyLoad, H.time.daily('02:00', 'Europe/London'), (c) =>
      sources.map((source) => ({
        create: {
          attributes: {
            source,
            night: new Date(c.now).toISOString().slice(0, 10),
            approvalDueAt: c.now + approvalWindowMs,
          },
        },
      })),
    ),
  ])
  .store(sqlite.store(NightlyLoad, './.harness/loads.db'))
  .runner(local.shell({ slots: 4 }))
  .reaction('approvalDeadline', Expired, { from: [AwaitingApproval] })
  .handler(nightlyLoadFlow, {
    states: {
      running: Running,
      'awaiting-approval': AwaitingApproval,
      loading: Loading,
      rejected: Rejected,
      loaded: Loaded,
      'loaded-with-warnings': LoadedWithWarnings,
      failed: LoadFailed,
    },
  });

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

export const dataJob = H.harness('nightly-data-job')
  .ledger(sqlite.ledger('./.harness/ledger.db'))
  .lanes([nightlyLoadLane])
  .schedule(oldestFirst)
  .clients([claude.supervisor('approver', approverAccess, { port: H.slot.port(0) })])
  .projections([markdown.board('./BOARD.md'), markdown.telemetry('./TELEMETRY.md')]);

export const running = dataJob.start();
