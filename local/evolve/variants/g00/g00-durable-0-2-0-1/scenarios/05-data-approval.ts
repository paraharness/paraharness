import { z } from 'zod';
import { H, type Retry } from 'harness-dsl';
import { sqlite } from 'harness-dsl/sqlite';
import { jsonl } from 'harness-dsl/jsonl';
import { anthropic } from 'harness-dsl/anthropic';
import { claudeCode } from 'harness-dsl/claude-code';
import { local } from 'harness-dsl/local';
import { ssh } from 'harness-dsl/ssh';
import { markdown } from 'harness-dsl/markdown';

const timeZone = 'Europe/London';
const sourceSystems = ['billing', 'crm', 'inventory', 'payments'];

const loadAttrs = z.object({ source: z.string(), night: z.string() });

const Scheduled = H.state('Scheduled', 'pending');
const Extracting = H.state('Extracting', 'active');
const Validating = H.state('Validating', 'active');
const AwaitingValidationReview = H.state('AwaitingValidationReview', 'waiting');
const Summarizing = H.state('Summarizing', 'active');
const AwaitingApproval = H.state('AwaitingApproval', 'waiting');
const Loading = H.state('Loading', 'active');
const Verifying = H.state('Verifying', 'active');
const Loaded = H.terminal('Loaded', 'success');
const LoadedWithWarnings = H.terminal('LoadedWithWarnings', 'success');
const Rejected = H.terminal('Rejected', 'neutral');
const LoadFailed = H.terminal('LoadFailed', 'failure');
const Expired = H.terminal('Expired', 'neutral');

const NightlyLoad = H.kind('NightlyLoad')
  .attributes(loadAttrs)
  .states(
    Scheduled,
    Extracting,
    Validating,
    AwaitingValidationReview,
    Summarizing,
    AwaitingApproval,
    Loading,
    Verifying,
    Loaded,
    LoadedWithWarnings,
    Rejected,
    LoadFailed,
    Expired,
  )
  .key((attrs) => `${attrs.source}:${attrs.night}`)
  .initial(Scheduled)
  .onAttemptFailed(LoadFailed)
  .onCancelled(Expired);

const localRunner = local.runner('local');
const etlHost = ssh.host('etl-1', { host: 'etl-1.internal', user: 'etl', key: H.env('ETL_SSH_KEY') });

const extract = H.command('extract')
  .input(loadAttrs)
  .argv((input) => ['./etl/extract.sh', input.source, input.night])
  .runner(etlHost);

const validate = H.command('validate')
  .input(loadAttrs)
  .argv((input) => ['./etl/validate.sh', input.source, input.night])
  .acceptExitCodes(0, 2)
  .runner(localRunner);

const load = H.command('load')
  .input(loadAttrs)
  .argv((input) => ['./etl/load.sh', input.source, input.night])
  .runner(localRunner);

const verify = H.command('verify')
  .input(loadAttrs)
  .argv((input) => ['./etl/verify.sh', input.source, input.night])
  .acceptExitCodes(0, 3)
  .runner(localRunner);

const summaryRole = H.role('anomaly-summarizer')
  .intents('read')
  .instructions('Explain the anomalies in plain language for the approver, emphasising what the approver cares about.');

const apiAccount = anthropic.account('data-api', { apiKey: H.env('ANTHROPIC_API_KEY') });
const dataPool = H.pool('data').accounts(apiAccount);
const sonnet = anthropic.model('sonnet', { id: 'claude-sonnet-4-5' });

const summarizer = H.agent('anomaly-summarizer').role(summaryRole).model(sonnet).pool(dataPool);

const stepRetry: Retry = { maxAttempts: 3, backoff: 'exponential', initialDelayMs: 60_000 };

const nightlyLoadFlow = H.flow('nightly-load')
  .input(loadAttrs)
  .step('extract', extract, (ctx) => ctx.unit.attributes, { retry: stepRetry, afterCrash: 'rerun' })
  .step('validate', validate, (ctx) => ctx.unit.attributes, { afterCrash: 'rerun' })
  .halt('validationReview', {
    ask: (ctx) =>
      `Validation failed for ${ctx.unit.attributes.source} on ${ctx.unit.attributes.night}:\n\n${ctx.steps.validate.stdout}\n\nProceed to summary and approval?`,
    decision: z.object({ proceed: z.boolean(), note: z.string() }),
    skip: (ctx) => (ctx.steps.validate.exitCode === 0 ? { proceed: true, note: 'validation passed' } : undefined),
  })
  .exit('rejectedAtValidation', (ctx) => !ctx.steps.validationReview.proceed)
  .step('summarize', summarizer, (ctx) => ({
    task: `Summarise the anomalies in tonight's ${ctx.unit.attributes.source} extract for the approver.\n\nValidation report:\n${ctx.steps.validate.stdout}`,
    skills: [ctx.unit.attributes.source],
  }))
  .halt('approval', {
    ask: (ctx) => ctx.steps.summarize,
    decision: z.object({ approved: z.boolean(), note: z.string().optional() }),
  })
  .exit('rejected', (ctx) => !ctx.steps.approval.approved)
  .step('load', load, (ctx) => ctx.unit.attributes, { retry: stepRetry, afterCrash: 'park' })
  .step('verify', verify, (ctx) => ctx.unit.attributes, { afterCrash: 'rerun' })
  .exit('loadedWithWarnings', (ctx) => ctx.steps.verify.exitCode === 3)
  .exit('loaded');

const loads = H.lane('nightly-loads', NightlyLoad)
  .supply(H.clock('two-am').at('02:00', { tz: timeZone }), (tick, to) =>
    sourceSystems.map((source) => to.create({ source, night: tick.at.toISOString().slice(0, 10) })),
  )
  .store(sqlite.store({ path: '.harness/loads.db' }))
  .handler(nightlyLoadFlow, {
    exits: {
      rejectedAtValidation: Rejected,
      rejected: Rejected,
      loadedWithWarnings: LoadedWithWarnings,
      loaded: Loaded,
    },
    during: {
      extract: Extracting,
      validate: Validating,
      validationReview: AwaitingValidationReview,
      summarize: Summarizing,
      approval: AwaitingApproval,
      load: Loading,
      verify: Verifying,
    },
  });

const approvalWindowCloses = H.trigger('approval-window-closes-at-nine')
  .on(H.when.timer(loads, { at: (unit) => H.nextTime('09:00', { after: unit.createdAt, tz: timeZone }) }))
  .signal(H.cancel, loads, (event) =>
    event.unit.attempt?.step === 'approval'
      ? { key: event.unit.key, payload: { reason: 'not approved by 09:00' } }
      : undefined,
  );

const approverTaste = H.journal('approver-taste', H.memory('approver-taste', 'taste'))
  .store(jsonl.memoryStore({ path: '.harness/taste.jsonl' }))
  .recall({ by: 'specificity', limit: 10 })
  .readBy(summaryRole);

const approverSupervisor = claudeCode.supervisor('approver-supervisor', {
  grants: [
    H.ops.workRead,
    H.ops.blockersResolve,
    H.ops.attemptsRecover,
    H.ops.memoryRead,
    H.ops.memoryWrite,
    H.ops.telemetryRead,
  ],
});

export const dataJob = H.harness('nightly-data-job')
  .ledger(sqlite.ledger({ path: '.harness/ledger.db' }))
  .lanes(loads)
  .journals(approverTaste)
  .triggers(approvalWindowCloses)
  .scheduler(H.scheduler('nightly-data').priority(loads))
  .clients(approverSupervisor)
  .observers(markdown.board({ path: '.harness/BOARD.md' }), markdown.telemetry({ path: '.harness/TELEMETRY.md' }));

void dataJob.start();
