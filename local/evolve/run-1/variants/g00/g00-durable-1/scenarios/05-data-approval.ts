import { z } from 'zod';
import { H } from 'harness-dsl';
import * as anthropic from 'harness-dsl/anthropic';
import * as sqlite from 'harness-dsl/sqlite';
import * as jsonl from 'harness-dsl/jsonl';
import * as local from 'harness-dsl/local';
import * as ssh from 'harness-dsl/ssh';
import * as claudeCode from 'harness-dsl/claude-code';
import * as markdown from 'harness-dsl/markdown';

const hourMs = 3_600_000;
const dayMs = 24 * hourMs;
const sourceSystems = ['billing', 'crm', 'inventory', 'payroll'];

const Scheduled = H.state('scheduled', 'pending');
const Running = H.state('running', 'active');
const AwaitingApproval = H.state('awaiting approval', 'active');
const Loaded = H.state('loaded', 'succeeded');
const LoadedWithWarnings = H.state('loaded with warnings', 'succeeded');
const Rejected = H.state('rejected', 'concluded');
const Expired = H.state('expired', 'cancelled');
const Failed = H.state('failed', 'failed');

const NightlyLoad = H.work('NightlyLoad')
  .attributes({ source: z.string(), night: z.string(), approvalCutoffAt: z.number() })
  .states([Scheduled, Running, AwaitingApproval, Loaded, LoadedWithWarnings, Rejected, Expired, Failed])
  .timers(t => ({ approvalCutoff: t.attribute('approvalCutoffAt') }))
  .key(unit => `${unit.attributes.source}@${unit.attributes.night}`);

const apiAccount = anthropic.account('anthropic-api', { apiKey: H.env('ANTHROPIC_API_KEY') });
const sonnet = anthropic.model('claude-sonnet-4-5');

const ApproverTaste = H.memory.taste('approver-taste');
const approverTaste = H.journal('approver-taste-journal', ApproverTaste)
  .store(jsonl.memory('memory/approver-taste.jsonl'))
  .recall(H.policy.recall('broadest-taste', c => c.candidates.slice(0, c.limit)));

const summaryRole = H.role('anomaly-summarizer')
  .intents(['read'])
  .instructions('Summarise the validation anomalies in plain language for the approver.')
  .input({ source: z.string(), report: z.string() })
  .output({ summary: z.string() });

const summarizer = H.agent('anomaly-summarizer', summaryRole).model(sonnet).pool(apiAccount).recalls([approverTaste]);

const warehouseHosts = ssh.hosts({
  hosts: [{ host: 'etl-1.internal', user: 'etl', key: H.env('ETL_SSH_KEY') }],
  slotsPerHost: 2,
});

const extract = H.command('extract', ['etl/extract']);
const validate = H.command('validate', ['etl/validate']);
const load = H.command('load', ['etl/load']);
const verify = H.command('verify', ['etl/verify']).parses({ driftRows: z.number() });

const transientRetry = H.retry.exponential({ maxRetries: 3, initialDelayMs: 60_000, maxDelayMs: 900_000 });

const nightlyLoadFlow = H.flow('nightly-load')
  .requires({ source: z.string(), night: z.string() })
  .mark('running')
  .step('extract', extract, c => ({ args: ['--source', c.input.source, '--night', c.input.night] }), {
    retry: transientRetry,
    runner: warehouseHosts,
  })
  .step('validate', validate, c => ({ args: ['--source', c.input.source] }), { onFailure: 'halt' })
  .step('summary', summarizer, c => ({ source: c.input.source, report: c.out.validate.stdout }))
  .mark('awaitingApproval')
  .halt('approval', {
    ask: c => `Approve the ${c.input.source} load for ${c.input.night}?\n\n${c.out.summary.summary}`,
    decision: { approved: z.boolean(), note: z.string().optional() },
  })
  .exit('rejected', c => !c.out.approval.approved)
  .mark('loading')
  .step('load', load, c => ({ args: ['--source', c.input.source, '--night', c.input.night] }), {
    retry: transientRetry,
    runner: warehouseHosts,
  })
  .step('verify', verify, c => ({ args: ['--source', c.input.source] }))
  .ends(['loaded', 'loadedWithWarnings'], c => (c.out.verify.data.driftRows === 0 ? 'loaded' : 'loadedWithWarnings'));

const nightlyLoadLane = H.lane('nightly-loads', NightlyLoad)
  .supply([
    H.supply.schedule(NightlyLoad, H.time.daily('02:00', 'UTC'), c =>
      sourceSystems.map(source => ({
        create: {
          attributes: {
            source,
            night: new Date(c.now).toISOString().slice(0, 10),
            approvalCutoffAt: c.now - (c.now % dayMs) + 9 * hourMs,
          },
        },
      })),
    ),
  ])
  .store(sqlite.store(NightlyLoad, 'loads.db'))
  .runner(local.shell({ slots: 4 }))
  .handler(nightlyLoadFlow, {
    states: {
      running: Running,
      awaitingApproval: AwaitingApproval,
      rejected: Rejected,
      loading: Running,
      loaded: Loaded,
      loadedWithWarnings: LoadedWithWarnings,
      failed: Failed,
    },
  })
  .signals({ approvalCutoff: H.move(Expired).from([AwaitingApproval]) });

const approverAccess = H.access('approver').allows([
  H.ops.readWork,
  H.ops.resolveBlocks,
  H.ops.readMemory,
  H.ops.writeMemory,
  H.ops.readTelemetry,
]);

export const dataJob = H.harness('nightly-data-job')
  .ledger(sqlite.ledger('ledger.db'))
  .lanes([nightlyLoadLane])
  .clients([claudeCode.supervisor('approver-supervisor', approverAccess, { port: H.slot.port(0) })])
  .projections([markdown.board('BOARD.md'), markdown.telemetry('TELEMETRY.md')]);
