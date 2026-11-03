import { z } from 'zod';
import { H } from 'harness-dsl';
import * as sqlite from 'harness-dsl/sqlite';
import * as jsonl from 'harness-dsl/jsonl';
import * as claudeCode from 'harness-dsl/claude-code';
import * as anthropic from 'harness-dsl/anthropic';
import * as markdown from 'harness-dsl/markdown';
import * as ssh from 'harness-dsl/ssh';

const Scheduled = H.state('Scheduled', 'pending');
const Extracting = H.state('Extracting', 'active');
const Validating = H.state('Validating', 'active');
const Summarizing = H.state('Summarizing', 'active');
const AwaitingApproval = H.state('AwaitingApproval', 'waiting');
const Loading = H.state('Loading', 'active');
const Verifying = H.state('Verifying', 'active');
const Held = H.state('Held', 'waiting');
const Loaded = H.state('Loaded', 'terminal', 'success');
const LoadedWithWarnings = H.state('LoadedWithWarnings', 'terminal', 'success');
const Rejected = H.state('Rejected', 'terminal', 'neutral');
const Expired = H.state('Expired', 'terminal', 'neutral');
const Failed = H.state('Failed', 'terminal', 'failure');

const NightlyLoad = H.work('NightlyLoad')
  .attributes({ source: z.string(), night: z.string() })
  .states([
    Scheduled,
    Extracting,
    Validating,
    Summarizing,
    AwaitingApproval,
    Loading,
    Verifying,
    Held,
    Loaded,
    LoadedWithWarnings,
    Rejected,
    Expired,
    Failed,
  ])
  .failsTo(Failed)
  .timers(() => ({ approvalCutoff: H.time.daily('09:00', 'Europe/London') }))
  .key(u => `${u.attributes.source}@${u.attributes.night}`);

const apiAccount = anthropic.account('data-api', { apiKey: H.env('ANTHROPIC_API_KEY') });
const sonnet = anthropic.model('claude-sonnet-4-5');

const approverTaste = H.journal('approver-taste', H.memory.taste('approver-taste'))
  .store(jsonl.memory('memory/approver-taste.jsonl'))
  .recall(
    H.policy.recall('most-specific', c =>
      [...c.candidates].sort((a, b) => b.specificity - a.specificity).slice(0, c.limit),
    ),
  );

const summarizerRole = H.role('anomaly-summarizer')
  .intents(['read'])
  .instructions('Summarize the validation anomalies in plain language for the approver.')
  .input({ source: z.string(), anomalies: z.array(z.string()) })
  .output({ summary: z.string() });

const summarizer = H.agent('anomaly-summarizer', summarizerRole)
  .model(sonnet)
  .pool(apiAccount)
  .recalls([approverTaste]);

const loadApproval = H.decision('load-approval', { approve: z.boolean(), note: z.string() });

const extract = H.command('extract', ['scripts/extract.sh']);
const validate = H.command('validate', ['scripts/validate.sh']).parses({ anomalies: z.array(z.string()) });
const load = H.command('load', ['scripts/load.sh']);
const verify = H.command('verify', ['scripts/verify.sh']).parses({ driftPct: z.number() });

const stepRetry = H.retry.exponential({ maxRetries: 3, initialDelayMs: 60_000, maxDelayMs: 900_000 });

const nightlyFlow = H.flow('nightly-load')
  .requires({ source: z.string(), night: z.string() })
  .step('extract', extract, c => ({ args: [c.input.source, c.input.night] }), { retry: stepRetry, restart: 'rerun' })
  .step('validate', validate, c => ({ args: [c.input.source, c.input.night] }), { onFailure: 'halt', restart: 'rerun' })
  .step('summarize', summarizer, c => ({ source: c.input.source, anomalies: c.out.validate.data.anomalies }))
  .halt('approval', loadApproval, {
    ask: c => `Approve the ${c.input.source} load for ${c.input.night}?\n\n${c.out.summarize.summary}`,
  })
  .exit('rejected', c => c.out.approval.approve === false)
  .step('load', load, c => ({ args: [c.input.source, c.input.night] }), { retry: stepRetry })
  .step('verify', verify, c => ({ args: [c.input.source, c.input.night] }), { restart: 'rerun' })
  .ends(['loaded', 'loadedWithWarnings'], c => (c.out.verify.data.driftPct > 0 ? 'loadedWithWarnings' : 'loaded'));

const sources = ['crm', 'billing', 'inventory', 'support'];

const nightlyLoads = H.lane('nightly-loads', NightlyLoad)
  .supply([
    H.supply.schedule(NightlyLoad, H.time.daily('02:00', 'Europe/London'), (c, supply) =>
      sources.map(source =>
        supply.create({ attributes: { source, night: new Date(c.now).toISOString().slice(0, 10) } }),
      ),
    ),
  ])
  .store(sqlite.store(NightlyLoad, '.harness/loads.db'))
  .runner(
    ssh.hosts({
      hosts: [{ host: 'etl.internal', user: 'etl', key: H.env('ETL_SSH_KEY') }],
      slotsPerHost: 4,
    }),
  )
  .handler(nightlyFlow, {
    states: {
      extract: Extracting,
      validate: Validating,
      summarize: Summarizing,
      approval: AwaitingApproval,
      load: Loading,
      verify: Verifying,
      rejected: Rejected,
      loaded: Loaded,
      loadedWithWarnings: LoadedWithWarnings,
    },
    opens: Extracting,
    blocked: Held,
  })
  .reacts({
    approvalCutoff: H.reaction(Expired).from([AwaitingApproval]).cancels(),
  });

const arrivalOrder = H.policy.schedule('arrival-order', c => ({
  start: c.order(x => x.enqueuedAt),
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
  .ledger(sqlite.ledger('.harness/nightly.db'))
  .lanes([nightlyLoads])
  .schedule(arrivalOrder)
  .clients([claudeCode.supervisor('approver', approverAccess, { port: H.slot.port(0) })])
  .projections([markdown.board('BOARD.md'), markdown.telemetry('TELEMETRY.md')]);
