import { H } from 'harness-dsl';
import { z } from 'zod';
import { anthropic } from 'harness-dsl/anthropic';
import { claudeCode } from 'harness-dsl/claude-code';
import { ssh } from 'harness-dsl/ssh';
import { local } from 'harness-dsl/local';
import { sqlite } from 'harness-dsl/sqlite';
import { jsonl } from 'harness-dsl/jsonl';
import { markdown } from 'harness-dsl/markdown';

const SourceSystem = z.enum(['crm', 'erp', 'billing', 'web']);

const LoadAttributes = z.object({ source: SourceSystem, night: z.string() });

const Scheduled = H.state('Scheduled', 'pending');
const Extracting = H.state('Extracting', 'active');
const AwaitingValidationReview = H.state('AwaitingValidationReview', 'waiting');
const Summarizing = H.state('Summarizing', 'active');
const AwaitingApproval = H.state('AwaitingApproval', 'waiting');
const Loading = H.state('Loading', 'active');
const Loaded = H.terminal('Loaded', 'success');
const LoadedWithWarnings = H.terminal('LoadedWithWarnings', 'success');
const Rejected = H.terminal('Rejected', 'neutral');
const LoadFailed = H.terminal('LoadFailed', 'failure');
const Expired = H.terminal('Expired', 'neutral');

const NightlyLoad = H.kind('NightlyLoad')
  .attributes(LoadAttributes)
  .states(
    Scheduled,
    Extracting,
    AwaitingValidationReview,
    Summarizing,
    AwaitingApproval,
    Loading,
    Loaded,
    LoadedWithWarnings,
    Rejected,
    LoadFailed,
    Expired,
  )
  .key(load => `${load.source}:${load.night}`)
  .initial(Scheduled);

const warehouse = ssh.host('warehouse', { host: 'warehouse.internal', user: 'etl', key: H.env('ETL_SSH_KEY') }).slots(2);
const etlLocal = local.runner('etl-local').slots(4);

const stepRetry = { maxAttempts: 3, backoff: 'exponential', initialDelayMs: 60_000 } as const satisfies object;

const extract = H.command('extract')
  .input(z.object({ source: SourceSystem }))
  .argv(input => ['./etl/extract.sh', input.source])
  .runner(warehouse);

const validate = H.command('validate')
  .input(z.object({ source: SourceSystem }))
  .argv(input => ['./etl/validate.sh', input.source])
  .runner(etlLocal)
  .acceptExitCodes(0, 1);

const load = H.command('load')
  .input(z.object({ source: SourceSystem }))
  .argv(input => ['./etl/load.sh', input.source])
  .runner(warehouse);

const verify = H.command('verify')
  .input(z.object({ source: SourceSystem }))
  .argv(input => ['./etl/verify.sh', input.source])
  .runner(etlLocal)
  .acceptExitCodes(0, 3);

const apiAccount = anthropic.account('etl-api', { apiKey: H.env('ANTHROPIC_API_KEY') });
const pool = H.pool('etl').accounts(apiAccount);

const summarizerRole = H.role('anomaly-summarizer')
  .intents('read')
  .instructions('Summarize the anomalies in the validation report in plain language for the approver.');

const summarizer = H.seat('anomaly-summarizer')
  .role(summarizerRole)
  .model(anthropic.model('sonnet', { id: 'claude-sonnet-4-5' }))
  .pool(pool)
  .output(z.object({ summary: z.string() }));

const ValidationReview = H.halt('validation-review').decision(z.object({ proceed: z.boolean(), note: z.string().optional() }));
const LoadApproval = H.halt('load-approval').decision(z.object({ approved: z.boolean(), note: z.string().optional() }));

const nightly = H.flow('nightly-load')
  .input(LoadAttributes)
  .step('extract', extract, ctx => ({ source: ctx.unit.attributes.source }), {
    retry: { maxAttempts: 3, backoff: 'exponential', initialDelayMs: 60_000 },
    afterCrash: 'rerun',
  })
  .step('validate', validate, ctx => ({ source: ctx.unit.attributes.source }))
  .halt('validationReview', ValidationReview, {
    askWhen: ctx => ctx.steps.validate.exitCode > 0,
    ask: ctx => `Validation failed for ${ctx.unit.attributes.source}:\n${ctx.steps.validate.stdout}`,
  })
  .exit('rejectedAtValidation', ctx => ctx.steps.validationReview?.proceed === false)
  .step('summarize', summarizer, ctx => ({
    task: `Summarize anomalies for ${ctx.unit.attributes.source} on ${ctx.unit.attributes.night}:\n${ctx.steps.validate.stdout}`,
  }))
  .halt('approval', LoadApproval, {
    ask: ctx => `Approve the ${ctx.unit.attributes.source} load for ${ctx.unit.attributes.night}?\n\n${ctx.steps.summarize.summary}`,
  })
  .exit('rejected', ctx => ctx.steps.approval.approved === false)
  .step('load', load, ctx => ({ source: ctx.unit.attributes.source }), {
    retry: { maxAttempts: 3, backoff: 'exponential', initialDelayMs: 60_000 },
    afterCrash: 'park',
  })
  .step('verify', verify, ctx => ({ source: ctx.unit.attributes.source }))
  .exit('loadedWithWarnings', ctx => ctx.steps.verify.exitCode === 3)
  .exit('loaded');

const loads = H.lane('nightly-loads', NightlyLoad)
  .supply(H.clock('two-am').at('02:00', { tz: 'Europe/London' }), (tick, to) =>
    SourceSystem.options.map(source => to.create({ source, night: tick.at.toISOString().slice(0, 10) })),
  )
  .store(sqlite.store({ path: './.harness/loads.db' }))
  .handler(nightly, {
    exits: {
      rejectedAtValidation: Rejected,
      rejected: Rejected,
      loadedWithWarnings: LoadedWithWarnings,
      loaded: Loaded,
    },
    during: {
      extract: Extracting,
      validate: Extracting,
      validationReview: AwaitingValidationReview,
      summarize: Summarizing,
      approval: AwaitingApproval,
      load: Loading,
      verify: Loading,
    },
    cancelled: Expired,
  })
  .retry({ maxAttempts: 1, exhausted: LoadFailed });

const approvalWindowCloses = H.trigger('approval-window-closes-at-nine')
  .on(
    H.when.timer(loads, {
      at: unit => H.nextTime('09:00', { after: unit.createdAt, tz: 'Europe/London' }),
      onlyAt: ['approval'],
    }),
  )
  .signal(H.cancel, loads, event => ({
    key: event.unit.key,
    payload: { reason: `No approval by 09:00 for ${event.unit.attributes.night}` },
  }));

const approverTaste = H.journal('approver-taste', H.memory('approver-emphasis', 'taste'))
  .store(jsonl.memoryStore({ path: './memory/approver-taste.jsonl' }))
  .recall({ by: 'specificity', limit: 8 })
  .readBy(summarizerRole);

const approverDesk = H.client('approver-desk', {
  transport: claudeCode.mcp('etl-mcp'),
  grants: [
    H.ops.workRead,
    H.ops.resolve(ValidationReview, LoadApproval),
    H.ops.attemptsRecover,
    H.ops.memoryWrite,
    H.ops.telemetryRead,
  ],
});

export const dataJob = H.harness('nightly-data-job')
  .ledger(sqlite.ledger({ path: './.harness/etl-ledger.db' }))
  .lanes(loads)
  .journals(approverTaste)
  .triggers(approvalWindowCloses)
  .scheduler(H.scheduler('etl').wip(loads, 2))
  .clients(approverDesk)
  .observers(markdown.board({ path: './BOARD.md' }), markdown.telemetry({ path: './TELEMETRY.md' }));

export const unusedRetryShape = stepRetry;
