import { z } from 'zod';
import { H } from 'harness-dsl';
import { sqlite } from 'harness-dsl/sqlite';
import { jsonl } from 'harness-dsl/jsonl';
import { anthropic } from 'harness-dsl/anthropic';
import { claudeCode } from 'harness-dsl/claude-code';
import { ssh } from 'harness-dsl/ssh';
import { local } from 'harness-dsl/local';
import { markdown } from 'harness-dsl/markdown';

const Scheduled = H.state('Scheduled', 'pending');
const Extracting = H.state('Extracting', 'active');
const Validating = H.state('Validating', 'active');
const ReviewingValidation = H.state('ReviewingValidation', 'waiting');
const Summarizing = H.state('Summarizing', 'active');
const AwaitingApproval = H.state('AwaitingApproval', 'waiting');
const Loading = H.state('Loading', 'active');
const Verifying = H.state('Verifying', 'active');
const Loaded = H.state('Loaded', 'terminal', 'success');
const LoadedWithWarnings = H.state('LoadedWithWarnings', 'terminal', 'success');
const Rejected = H.state('Rejected', 'terminal', 'failure');
const Expired = H.state('Expired', 'terminal', 'neutral');
const Failed = H.state('Failed', 'terminal', 'failure');

const nightlyLoad = z.object({ source: z.string(), night: z.string() });

const NightlyLoad = H.kind('NightlyLoad')
  .attributes(nightlyLoad)
  .states(
    Scheduled, Extracting, Validating, ReviewingValidation, Summarizing, AwaitingApproval,
    Loading, Verifying, Loaded, LoadedWithWarnings, Rejected, Expired, Failed,
  )
  .key(attrs => `${attrs.source}/${attrs.night}`);

const sourceSystems = ['crm', 'billing', 'inventory', 'support'];

const etlHost = ssh.host('etl', { host: 'etl.internal', user: 'etl', key: H.env('ETL_SSH_KEY') });
const localRunner = local.runner('local');

const withBackoff = H.retry({ maxAttempts: 3, backoff: 'exponential', initialDelayMs: 60_000, maxDelayMs: 900_000 });

const sourceInput = z.object({ source: z.string(), night: z.string() });

const extract = H.command('extract')
  .input(sourceInput)
  .argv(input => ['/opt/etl/extract.sh', input.source, input.night])
  .runner(etlHost);

const validate = H.command('validate')
  .input(sourceInput)
  .output(z.object({ passed: z.boolean(), report: z.string() }))
  .argv(input => ['/opt/etl/validate.sh', input.source, input.night])
  .runner(etlHost);

const load = H.command('load')
  .input(sourceInput)
  .argv(input => ['/opt/etl/load.sh', input.source, input.night])
  .runner(etlHost);

const verify = H.command('verify')
  .input(sourceInput)
  .output(z.object({ drift: z.number(), tolerable: z.boolean() }))
  .argv(input => ['/opt/etl/verify.sh', input.source, input.night])
  .runner(localRunner);

const apiAccount = anthropic.account('anthropic-api', { apiKey: H.env('ANTHROPIC_API_KEY') });
const sonnet = anthropic.model('sonnet', { id: 'claude-sonnet-4-5' });
const apiPool = H.pool('api').accounts(apiAccount);

const summarizerRole = H.role('anomaly-summarizer')
  .instructions('Explain the anomalies in the validation report in plain language for the approver.');

const summarizer = H.agent('anomaly-summarizer')
  .role(summarizerRole)
  .model(sonnet)
  .budgetTokens(20_000);

const nightly = H.flow('nightly-load')
  .input(nightlyLoad)
  .step('extract', extract, ctx => ({ source: ctx.unit.attributes.source, night: ctx.unit.attributes.night }), {
    retry: withBackoff,
    restart: 'rerun',
  })
  .step('validate', validate, ctx => ({ source: ctx.unit.attributes.source, night: ctx.unit.attributes.night }), {
    restart: 'rerun',
  })
  .halt('validationReview', {
    ask: ctx => `Validation failed for ${ctx.unit.attributes.source} (${ctx.unit.attributes.night}):\n\n${ctx.steps.validate.report}`,
    decision: z.object({ proceed: z.boolean(), note: z.string().optional() }),
    skip: ctx => ctx.steps.validate.passed ? { proceed: true } : undefined,
  })
  .exit('stoppedAtValidation', ctx => !ctx.steps.validationReview.proceed)
  .step('summarize', summarizer, ctx => ({
    task: `Summarize the anomalies for ${ctx.unit.attributes.source}:\n\n${ctx.steps.validate.report}`,
    skills: [ctx.unit.attributes.source],
  }), { restart: 'ask' })
  .halt('approve', {
    ask: ctx => `Approve tonight's ${ctx.unit.attributes.source} load?\n\n${ctx.steps.summarize}`,
    decision: z.object({ approved: z.boolean(), notes: z.string().optional() }),
  })
  .exit('rejected', ctx => !ctx.steps.approve.approved)
  .step('load', load, ctx => ({ source: ctx.unit.attributes.source, night: ctx.unit.attributes.night }), {
    retry: withBackoff,
    restart: 'park',
  })
  .step('verify', verify, ctx => ({ source: ctx.unit.attributes.source, night: ctx.unit.attributes.night }), {
    restart: 'rerun',
  })
  .exit('driftExceeded', ctx => !ctx.steps.verify.tolerable)
  .exit('loadedWithWarnings', ctx => ctx.steps.verify.drift > 0)
  .exit('loaded');

const loads = H.lane('nightly-loads', NightlyLoad)
  .supply(H.clock('two-am').daily('02:00', { tz: 'Europe/Berlin' }), (tick, to) =>
    sourceSystems.map(source => to.create({ source, night: tick.at.toISOString().slice(0, 10) })),
  )
  .store(sqlite.store({ path: '.harness/loads.sqlite' }))
  .handler(nightly, {
    exits: {
      stoppedAtValidation: Rejected,
      rejected: Rejected,
      driftExceeded: Failed,
      loadedWithWarnings: LoadedWithWarnings,
      loaded: Loaded,
    },
    during: {
      extract: Extracting,
      validate: Validating,
      validationReview: ReviewingValidation,
      summarize: Summarizing,
      approve: AwaitingApproval,
      load: Loading,
      verify: Verifying,
    },
    failure: Failed,
  })
  .on(H.cancel, { enter: Expired });

const approvalWindowCloses = H.trigger('approval-window-closes')
  .on(H.when.timer(loads, {
    at: unit => H.nextTime('09:00', { after: unit.createdAt, tz: 'Europe/Berlin' }),
    if: unit => unit.position !== 'terminal',
  }))
  .signal(H.cancel, event =>
    event.unit.state === AwaitingApproval.name ? { reason: 'approval not given by 09:00' } : undefined,
  );

const taste = H.memory('approver-taste').trust('taste');

const tastePlaybook = H.playbook('approver-taste', taste)
  .store(jsonl.memoryStore({ path: '.harness/memory/taste.jsonl' }))
  .recall(H.recall('taste-by-specificity', { by: 'specificity', limit: 10 }))
  .readBy(summarizerRole);

const approver = claudeCode.supervisor('approver', {
  grants: [
    H.ops.workRead,
    H.ops.workCancel,
    H.ops.blockersResolve,
    H.ops.memoryRead,
    H.ops.memoryWrite,
    H.ops.telemetryRead,
  ],
});

const scheduler = H.scheduler('nightly').priority(loads).wip(loads, 2);

export const dataJob = H.harness('nightly-data-job')
  .ledger(sqlite.ledger({ path: '.harness/ledger.sqlite' }))
  .pools(apiPool)
  .lanes(loads)
  .playbooks(tastePlaybook)
  .triggers(approvalWindowCloses)
  .scheduler(scheduler)
  .clients(approver)
  .observers(markdown.board({ path: 'BOARD.md' }), markdown.telemetry({ path: 'TELEMETRY.md' }));
