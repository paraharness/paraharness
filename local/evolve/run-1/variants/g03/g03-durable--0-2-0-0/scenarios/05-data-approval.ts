import { H } from 'harness-dsl';
import { z } from 'zod';
import { sqlite } from 'harness-dsl/sqlite';
import { jsonl } from 'harness-dsl/jsonl';
import { claudeCode } from 'harness-dsl/claude-code';
import { anthropic } from 'harness-dsl/anthropic';
import { ssh } from 'harness-dsl/ssh';
import { markdown } from 'harness-dsl/markdown';

const Scheduled = H.state('Scheduled', 'pending');
const Extracting = H.state('Extracting', 'active');
const Validating = H.state('Validating', 'active');
const ValidationHold = H.state('ValidationHold', 'waiting');
const Summarizing = H.state('Summarizing', 'active');
const AwaitingApproval = H.state('AwaitingApproval', 'waiting');
const Loading = H.state('Loading', 'active');
const Verifying = H.state('Verifying', 'active');
const Loaded = H.terminal('Loaded', 'success');
const LoadedWithWarnings = H.terminal('LoadedWithWarnings', 'success');
const Rejected = H.terminal('Rejected', 'neutral');
const Expired = H.terminal('Expired', 'neutral');
const Failed = H.terminal('Failed', 'failure');

const loadSchema = z.object({ source: z.string(), night: z.string() });

const NightlyLoad = H.kind('NightlyLoad')
  .attributes(loadSchema)
  .states(Scheduled, Extracting, Validating, ValidationHold, Summarizing, AwaitingApproval, Loading, Verifying, Loaded, LoadedWithWarnings, Rejected, Expired, Failed)
  .key(a => `${a.source}:${a.night}`)
  .initial(Scheduled)
  .onAttemptFailed(Failed)
  .onCancelled(Expired);

const etlHost = ssh.host('etl', { host: 'etl.internal', user: 'etl', key: H.env('ETL_SSH_KEY') }).slots(2);

const sourceInput = z.object({ source: z.string() });

const extract = H.command('extract')
  .input(sourceInput)
  .argv(i => ['etl', 'extract', i.source])
  .runner(etlHost);

const validate = H.command('validate')
  .input(sourceInput)
  .argv(i => ['etl', 'validate', i.source])
  .acceptExitCodes(0, 1)
  .runner(etlHost);

const load = H.command('load')
  .input(sourceInput)
  .argv(i => ['etl', 'load', i.source])
  .runner(etlHost);

const verify = H.command('verify')
  .input(sourceInput)
  .argv(i => ['etl', 'verify', i.source])
  .acceptExitCodes(0, 2)
  .runner(etlHost);

const apiAccount = anthropic.account('etl-api', { apiKey: H.env('ANTHROPIC_API_KEY') });
const pool = H.pool('etl').accounts(apiAccount);

const summarizerRole = H.role('anomalySummarizer')
  .intents('read')
  .instructions('Summarise the anomalies in the validation report in plain language for the approver.');

const summarizer = H.agent('anomalySummarizer')
  .role(summarizerRole)
  .model(anthropic.model('sonnet', { id: 'claude-sonnet-4-5' }))
  .pool(pool);

const approverTaste = H.journal('approverTaste', H.memory('approverTaste', 'taste'))
  .store(jsonl.memoryStore({ path: '.harness/taste.jsonl' }))
  .recall({ by: 'specificity', limit: 10 })
  .readBy(summarizerRole);

const stepRetry = { maxAttempts: 3, initialDelayMs: 30000 };

const nightlyFlow = H.flow('nightlyLoad')
  .input(loadSchema)
  .step('extract', extract, ctx => ({ source: ctx.unit.attributes.source }), { retry: stepRetry, afterCrash: 'rerun' })
  .step('validate', validate, ctx => ({ source: ctx.unit.attributes.source }), { afterCrash: 'rerun' })
  .halt('validationReview', {
    ask: ctx => `Validation failed for ${ctx.unit.attributes.source} on ${ctx.unit.attributes.night}:\n${ctx.steps.validate.stdout}`,
    decision: z.object({ proceed: z.boolean() }),
    skip: ctx => ctx.steps.validate.exitCode === 0 ? { proceed: true } : undefined,
  })
  .exit('invalid', ctx => !ctx.steps.validationReview.proceed)
  .step('summarize', summarizer, ctx => ({
    task: `Summarise the anomalies for ${ctx.unit.attributes.source}:\n${ctx.steps.validate.stdout}`,
    resources: [ctx.unit.attributes.source],
  }))
  .halt('approval', {
    ask: ctx => `Approve tonight's load of ${ctx.unit.attributes.source}?\n\n${ctx.steps.summarize}`,
    decision: z.object({ approved: z.boolean(), note: z.string() }),
  })
  .exit('rejected', ctx => !ctx.steps.approval.approved)
  .step('load', load, ctx => ({ source: ctx.unit.attributes.source }), { retry: stepRetry, afterCrash: 'park' })
  .step('verify', verify, ctx => ({ source: ctx.unit.attributes.source }), { afterCrash: 'rerun' })
  .exit('loadedWithWarnings', ctx => ctx.steps.verify.exitCode === 2)
  .exit('loaded');

const sources = ['billing', 'crm', 'inventory', 'support'];

const loads = H.lane('nightlyLoads', NightlyLoad)
  .supply(
    H.clock('twoAm').at('02:00', { tz: 'Europe/London' }),
    (tick, to) => sources.map(source => to.create({ source, night: tick.at.toISOString().slice(0, 10) })),
  )
  .store(sqlite.store({ path: '.harness/store.db' }))
  .handler(nightlyFlow, {
    exits: {
      invalid: Failed,
      rejected: Rejected,
      loadedWithWarnings: LoadedWithWarnings,
      loaded: Loaded,
    },
    during: {
      extract: Extracting,
      validate: Validating,
      validationReview: ValidationHold,
      summarize: Summarizing,
      approval: AwaitingApproval,
      load: Loading,
      verify: Verifying,
    },
  });

const approvalWindowCloses = H.trigger('approvalWindowCloses')
  .on(H.when.timer(loads, {
    at: unit => H.nextTime('09:00', { after: unit.createdAt, tz: 'Europe/London' }),
  }))
  .signal(H.cancel, loads, e => e.unit.state === 'AwaitingApproval'
    ? { key: e.unit.key, payload: { reason: 'approval not given by 09:00' } }
    : undefined);

const scheduler = H.scheduler('nightly').priority(loads);

const supervisor = claudeCode.supervisor('approver', {
  grants: [
    H.ops.workRead,
    H.ops.blockersResolve,
    H.ops.memoryWrite,
    H.ops.telemetryRead,
  ],
});

export const nightly = H.harness('nightlyData')
  .ledger(sqlite.ledger({ path: '.harness/ledger.db' }))
  .lanes(loads)
  .journals(approverTaste)
  .triggers(approvalWindowCloses)
  .scheduler(scheduler)
  .clients(supervisor)
  .observers(
    markdown.board({ path: '.harness/board.md' }),
    markdown.telemetry({ path: '.harness/telemetry.md' }),
  );

void nightly.start();
