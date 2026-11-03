import { z } from 'zod';
import { H } from 'harness-dsl';
import type { RecallCandidate } from 'harness-dsl/kernel';
import * as anthropic from 'harness-dsl/anthropic';
import * as claudeCode from 'harness-dsl/claude-code';
import * as sqlite from 'harness-dsl/sqlite';
import * as jsonl from 'harness-dsl/jsonl';
import * as markdown from 'harness-dsl/markdown';
import * as local from 'harness-dsl/local';
import * as ssh from 'harness-dsl/ssh';

export const Scheduled = H.state('Scheduled', 'pending');
export const Extracting = H.state('Extracting', 'active');
export const AwaitingApproval = H.state('AwaitingApproval', 'active');
export const Loading = H.state('Loading', 'active');
export const Loaded = H.state('Loaded', 'terminal', 'success');
export const LoadedWithWarnings = H.state('LoadedWithWarnings', 'terminal', 'success');
export const Rejected = H.state('Rejected', 'terminal', 'failure');
export const Failed = H.state('Failed', 'terminal', 'failure');
export const Expired = H.state('Expired', 'terminal', 'neutral');

export const NightlyLoad = H.work('NightlyLoad')
  .attributes({ source: z.string(), night: z.string() })
  .states([Scheduled, Extracting, AwaitingApproval, Loading, Loaded, LoadedWithWarnings, Rejected, Failed, Expired])
  .onFailure(Failed)
  .timers(() => ({ approvalDeadline: H.time.daily('09:00', 'Europe/London') }))
  .key(u => `${u.attributes.source}@${u.attributes.night}`);

export const apiAccount = anthropic.account('anthropic-api', { apiKey: H.env('ANTHROPIC_API_KEY') });
export const sonnet = anthropic.model('claude-sonnet-4-5');

const proven = (x: RecallCandidate) => x.track.succeeded / Math.max(1, x.track.present);
export const specificThenProven = H.policy.recall('specific-then-proven', c =>
  [...c.candidates].sort((a, b) => b.specificity - a.specificity || proven(b) - proven(a)).slice(0, c.limit),
);

export const ApproverTaste = H.memory.taste('approver-taste');
export const approverTaste = H.journal('approver-taste', ApproverTaste)
  .store(jsonl.memory('memory/approver-taste.jsonl'))
  .recall(specificThenProven);

export const summarizerRole = H.role('anomaly-summarizer')
  .intents(['read'])
  .instructions('Summarize the anomalies in the validation report in plain language for the approver.')
  .input({ source: z.string(), night: z.string(), report: z.string() })
  .output({ summary: z.string() });

export const summarizer = H.agent('anomaly-summarizer', summarizerRole)
  .model(sonnet)
  .pool(apiAccount)
  .recalls([approverTaste]);

export const extract = H.command('extract', ['./bin/extract']);
export const validate = H.command('validate', ['./bin/validate']);
export const load = H.command('load', ['./bin/load']);
export const verify = H.command('verify', ['./bin/verify']).parses({ driftPct: z.number() });

export const loadApproval = H.decision('load-approval', { approved: z.boolean(), notes: z.string() });

export const warehouseHosts = ssh.hosts({
  hosts: [{ host: 'etl-1.internal', user: 'etl', key: H.env('ETL_SSH_KEY') }],
  slotsPerHost: 2,
});

export const threeRetries = H.retry.exponential({ maxRetries: 3, initialDelayMs: 30000, maxDelayMs: 600000 });

export const nightlyFlow = H.flow('nightly-load')
  .requires({ source: z.string(), night: z.string() })
  .step('extract', extract, c => ({ args: [c.input.source, c.input.night] }), {
    runner: warehouseHosts,
    retry: threeRetries,
    restart: 'rerun',
  })
  .step('validate', validate, c => ({ args: [c.input.source, c.input.night] }), { onFailure: 'halt', restart: 'rerun' })
  .step('summarize', summarizer, c => ({ source: c.input.source, night: c.input.night, report: c.out.validate.stdout }))
  .mark('awaitingApproval')
  .halt('approval', loadApproval, {
    ask: c => `Load ${c.input.source} for ${c.input.night}?\n\n${c.out.summarize.summary}`,
  })
  .exit('rejected', c => c.out.approval.approved === false)
  .mark('loading')
  .step('load', load, c => ({ args: [c.input.source, c.input.night] }), { runner: warehouseHosts, retry: threeRetries })
  .step('verify', verify, c => ({ args: [c.input.source, c.input.night] }), { restart: 'rerun' })
  .ends(['loaded', 'loadedWithWarnings'], c => (c.out.verify.data.driftPct > 0 ? 'loadedWithWarnings' : 'loaded'));

const sources = ['billing', 'crm', 'inventory', 'web-analytics'];

export const loads = H.lane('nightly-loads', NightlyLoad)
  .supply([
    H.supply.schedule(NightlyLoad, H.time.daily('02:00', 'Europe/London'), c =>
      sources.map(source => ({
        create: { attributes: { source, night: new Date(c.now).toISOString().slice(0, 10) } },
      })),
    ),
  ])
  .store(sqlite.store(NightlyLoad, '.harness/loads.db'))
  .handler(nightlyFlow, {
    outcomes: { rejected: Rejected, loaded: Loaded, loadedWithWarnings: LoadedWithWarnings },
    progress: { awaitingApproval: AwaitingApproval, loading: Loading },
  })
  .runner(local.shell({ slots: 4 }))
  .reacts({ approvalDeadline: H.reaction(Expired).from([AwaitingApproval]) });

export const approverAccess = H.access('approver').allows([
  H.ops.readWork,
  H.ops.resolveBlocks,
  H.ops.manageAttempts,
  H.ops.readMemory,
  H.ops.writeMemory,
  H.ops.readTelemetry,
]);

export const supervisor = claudeCode.supervisor('data-supervisor', approverAccess, { port: H.slot.port(0) });

export const harness = H.harness('nightly-data')
  .ledger(sqlite.ledger('.harness/nightly-data.db'))
  .lanes([loads])
  .projections([markdown.board('BOARD.md'), markdown.telemetry('TELEMETRY.md')]);

export const control = H.control('nightly-data-control', harness).clients([supervisor]);
