import { z } from 'zod';
import { H } from 'harness-dsl';
import { anthropic } from 'harness-dsl/anthropic';
import { sqlite } from 'harness-dsl/sqlite';
import { jsonl } from 'harness-dsl/jsonl';
import { local } from 'harness-dsl/local';
import { ssh } from 'harness-dsl/ssh';
import { claudeCode } from 'harness-dsl/claude-code';
import { markdown } from 'harness-dsl/markdown';

const loadAttrs = z.object({ source: z.string(), night: z.string() });

const scheduled = H.state('Scheduled', 'pending');
const extracting = H.state('Extracting', 'active');
const validating = H.state('Validating', 'active');
const awaitingReview = H.state('AwaitingValidationReview', 'waiting');
const summarizing = H.state('Summarizing', 'active');
const awaitingApproval = H.state('AwaitingApproval', 'waiting');
const loading = H.state('Loading', 'active');
const loaded = H.terminal('Loaded', 'success');
const loadedWithWarnings = H.terminal('LoadedWithWarnings', 'success');
const rejected = H.terminal('Rejected', 'neutral');
const failed = H.terminal('Failed', 'failure');
const cancelled = H.terminal('Cancelled', 'neutral');

const nightlyLoad = H.kind('NightlyLoad')
  .attributes(loadAttrs)
  .states(
    scheduled,
    extracting,
    validating,
    awaitingReview,
    summarizing,
    awaitingApproval,
    loading,
    loaded,
    loadedWithWarnings,
    rejected,
    failed,
    cancelled,
  )
  .key(a => `${a.source}@${a.night}`)
  .initial(scheduled);

const validationReview = H.halt('validation-review').decision(z.object({ proceed: z.boolean() }));
const loadApproval = H.halt('load-approval').decision(z.object({ approved: z.boolean(), note: z.string().optional() }));

const validationPassedProceeds = H.policy.halt(
  'validation-passed-proceeds',
  validationReview,
  z.object({ passed: z.boolean() }),
  ctx => (ctx.input.passed ? { proceed: true } : undefined),
);

const etlHost = ssh.host('etl-1', { host: 'etl-1.internal', user: 'etl', key: H.env('ETL_SSH_KEY') });
const localRunner = local.runner('local');
const source = z.object({ source: z.string(), night: z.string() });

const extract = H.command('extract').input(source).argv(i => ['/opt/etl/extract', i.source, i.night]).runner(etlHost);
const validate = H.command('validate')
  .input(source)
  .argv(i => ['./bin/validate', i.source, i.night])
  .output(z.object({ passed: z.boolean(), report: z.string() }))
  .runner(localRunner);
const load = H.command('load').input(source).argv(i => ['/opt/etl/load', i.source, i.night]).runner(etlHost);
const verify = H.command('verify')
  .input(source)
  .argv(i => ['./bin/verify', i.source, i.night])
  .output(z.object({ drift: z.enum(['none', 'tolerable', 'excessive']), report: z.string() }))
  .runner(localRunner);

const threeRetries = { maxAttempts: 4, backoff: 'exponential', initialDelayMs: 60000 } satisfies {
  readonly maxAttempts: number;
  readonly backoff: 'fixed' | 'exponential';
  readonly initialDelayMs: number;
};

const quota = sqlite.quota('data-quota', { path: '.harness/quota.db' });
const api = anthropic.account('anthropic-api', { apiKey: H.env('ANTHROPIC_API_KEY'), quota });

const summarizerRole = H.role('anomaly-summarizer')
  .intents('read')
  .instructions('Summarise the anomalies in the validation report in plain language for the approver.');

const approverTaste = H.journal('approver-taste', H.memory('approver-taste', 'taste'))
  .store(jsonl.memoryStore({ path: 'memory/taste.jsonl' }))
  .recall({ by: 'specificity', limit: 10 })
  .readBy(summarizerRole);

const summarizer = H.seat('anomaly-summarizer')
  .role(summarizerRole)
  .model(anthropic.model('sonnet', { id: 'claude-sonnet-4-5' }))
  .pool(H.pool('data').accounts(api));

const nightly = H.flow('nightly-load')
  .input(loadAttrs)
  .step('extract', extract, ctx => ctx.unit.attributes, { retry: threeRetries, afterCrash: 'rerun' })
  .step('validate', validate, ctx => ctx.unit.attributes)
  .halt('validation-review', validationReview, {
    ask: ctx => `Validation failed for ${ctx.unit.attributes.source}:\n${ctx.steps.validate.report}`,
    skip: { by: validationPassedProceeds, input: ctx => ({ passed: ctx.steps.validate.passed }) },
  })
  .exit('invalid', ctx => ctx.steps['validation-review'].proceed === false)
  .step('summarize', summarizer, ctx => ({
    task: `Summarise the anomalies for ${ctx.unit.attributes.source} on ${ctx.unit.attributes.night}:\n${ctx.steps.validate.report}`,
    skills: ['anomaly-summary'],
  }))
  .halt('approval', loadApproval, { ask: ctx => ctx.steps.summarize })
  .exit('rejected', ctx => ctx.steps.approval.approved === false)
  .step('load', load, ctx => ctx.unit.attributes, { retry: threeRetries })
  .step('verify', verify, ctx => ctx.unit.attributes)
  .exit('loaded', ctx => ctx.steps.verify.drift === 'none')
  .exit('loadedWithWarnings', ctx => ctx.steps.verify.drift === 'tolerable')
  .exit('driftExceeded');

const loads = H.lane('nightly-loads', nightlyLoad)
  .supply(H.clock('two-am').at('02:00', { tz: 'Europe/Berlin' }), (tick, to) => {
    const night = tick.at.toISOString().slice(0, 10);
    return ['billing', 'crm', 'inventory', 'web-analytics'].map(s => to.create({ source: s, night }));
  })
  .store(sqlite.store({ path: '.harness/loads.db' }))
  .handler(nightly, {
    exits: { invalid: failed, rejected, loaded, loadedWithWarnings, driftExceeded: failed },
    during: {
      extract: extracting,
      validate: validating,
      'validation-review': awaitingReview,
      summarize: summarizing,
      approval: awaitingApproval,
      load: loading,
      verify: loading,
    },
  })
  .retry({ maxAttempts: 1, backoff: 'fixed', initialDelayMs: 0, exhausted: failed })
  .on(H.cancel, { enter: cancelled });

const approvalWindowCloses = H.trigger('approval-window-closes-at-nine')
  .on(H.when.timer(loads, { at: u => H.nextTime('09:00', { after: u.createdAt, tz: 'Europe/Berlin' }) }))
  .signal(H.cancel, loads, e =>
    e.unit.attempt?.step === 'approval'
      ? { key: e.unit.key, payload: { reason: 'approval not given by 09:00' } }
      : undefined,
  );

export const dataJob = H.harness('nightly-data')
  .ledger(sqlite.ledger({ path: '.harness/nightly-data.db' }))
  .lanes(loads)
  .journals(approverTaste)
  .triggers(approvalWindowCloses)
  .scheduler(H.scheduler('nightly-data').wip(loads, 4))
  .clients(
    claudeCode.supervisor('approver').client('approver-console', {
      grants: [
        H.ops.workRead,
        H.ops.resolve(validationReview),
        H.ops.resolve(loadApproval),
        H.ops.attemptsRecover,
        H.ops.memoryWrite,
        H.ops.telemetryRead,
      ],
    }),
  )
  .observers(markdown.board({ path: 'BOARD.md' }), markdown.telemetry({ path: 'TELEMETRY.md' }));

void dataJob.start();
