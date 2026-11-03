import { z } from 'zod';
import { H, Retry } from 'harness-dsl';
import { sqlite } from 'harness-dsl/sqlite';
import { jsonl } from 'harness-dsl/jsonl';
import { anthropic } from 'harness-dsl/anthropic';
import { claudeCode } from 'harness-dsl/claude-code';
import { ssh } from 'harness-dsl/ssh';
import { local } from 'harness-dsl/local';
import { markdown } from 'harness-dsl/markdown';

const sourceSystems = ['crm', 'billing', 'inventory', 'support'];

const loadSchema = z.object({ source: z.string(), night: z.string() });

const Scheduled = H.state('Scheduled', 'pending');
const Loading = H.state('Loading', 'active');
const Loaded = H.terminal('Loaded', 'success');
const LoadedWithWarnings = H.terminal('LoadedWithWarnings', 'success');
const Rejected = H.terminal('Rejected', 'neutral');
const Expired = H.terminal('Expired', 'neutral');
const Failed = H.terminal('Failed', 'failure');

const NightlyLoad = H.kind('NightlyLoad')
  .attributes(loadSchema)
  .states(Scheduled, Loading, Loaded, LoadedWithWarnings, Rejected, Expired, Failed)
  .key(a => `${a.source}@${a.night}`);

const validationReview = H.halt('validation-review').decision(z.object({ proceed: z.boolean() }));
const loadApproval = H.halt('load-approval').decision(z.object({ approve: z.boolean(), note: z.string().optional() }));

const passedValidation = H.policy.halt(
  'passed-validation',
  validationReview,
  z.object({ passed: z.boolean() }),
  ctx => (ctx.input.passed ? { proceed: true } : undefined),
);

const quota = sqlite.quota('data-accounts', { path: '.harness/quota.sqlite' });
const apiAccount = anthropic.account('anthropic-api', { apiKey: H.env('ANTHROPIC_API_KEY'), quota });
const sonnet = anthropic.model('sonnet', { id: 'claude-sonnet-4-5' });
const pool = H.pool('data-pool').accounts(apiAccount);

const summarizerRole = H.role('anomaly-summarizer')
  .intents('read')
  .instructions('Summarize validation anomalies in plain language for the approver.');

const approverTaste = H.journal('approver-taste', H.memory('approver-taste', 'taste'))
  .store(jsonl.memoryStore({ path: '.harness/taste.jsonl' }))
  .recall({ by: 'specificity', limit: 10 })
  .readBy(summarizerRole);

const summarizer = H.seat('anomaly-summarizer').role(summarizerRole).model(sonnet).pool(pool);

const warehouse = ssh.host('warehouse', { host: 'etl.internal', user: 'etl', key: H.env('ETL_SSH_KEY') });
const localRunner = local.runner('local');

const stepRetry: Retry = { maxAttempts: 3, backoff: 'exponential', initialDelayMs: 60_000 };

const extract = H.command('extract')
  .input(z.object({ source: z.string(), night: z.string() }))
  .argv(i => ['./etl/extract', i.source, i.night])
  .runner(warehouse);

const validate = H.command('validate')
  .input(z.object({ source: z.string(), night: z.string() }))
  .argv(i => ['./etl/validate', i.source, i.night])
  .acceptExitCodes(0, 1)
  .output(z.object({ passed: z.boolean(), report: z.string() }))
  .runner(localRunner);

const load = H.command('load')
  .input(z.object({ source: z.string(), night: z.string() }))
  .argv(i => ['./etl/load', i.source, i.night])
  .runner(warehouse);

const verify = H.command('verify')
  .input(z.object({ source: z.string(), night: z.string() }))
  .argv(i => ['./etl/verify', i.source, i.night])
  .output(z.object({ driftRows: z.number(), tolerable: z.boolean() }))
  .runner(localRunner);

const nightlyLoad = H.flow('nightly-load')
  .input(loadSchema)
  .step('extract', extract, ctx => ({ source: ctx.unit.attributes.source, night: ctx.unit.attributes.night }), {
    retry: stepRetry,
    afterCrash: 'rerun',
  })
  .step('validate', validate, ctx => ({ source: ctx.unit.attributes.source, night: ctx.unit.attributes.night }))
  .halt('validation', validationReview, {
    ask: ctx => `Validation failed for ${ctx.unit.attributes.source}:\n${ctx.steps.validate.report}`,
    skip: { by: passedValidation, input: ctx => ({ passed: ctx.steps.validate.passed }) },
  })
  .exit('invalid', ctx => !ctx.steps.validation.proceed)
  .step('summarize', summarizer, ctx => ({
    task: `Summarize anomalies for ${ctx.unit.attributes.source} on ${ctx.unit.attributes.night}:\n${ctx.steps.validate.report}`,
  }))
  .halt('approval', loadApproval, { ask: ctx => ctx.steps.summarize })
  .exit('rejected', ctx => !ctx.steps.approval.approve)
  .step('load', load, ctx => ({ source: ctx.unit.attributes.source, night: ctx.unit.attributes.night }), {
    retry: stepRetry,
    afterCrash: 'park',
  })
  .step('verify', verify, ctx => ({ source: ctx.unit.attributes.source, night: ctx.unit.attributes.night }))
  .exit('driftTooHigh', ctx => !ctx.steps.verify.tolerable)
  .exit('loadedWithWarnings', ctx => ctx.steps.verify.driftRows > 0)
  .exit('loaded');

const nightlyLoads = H.lane('nightly-loads', NightlyLoad)
  .supply(H.clock('two-am').at('02:00', { tz: 'Europe/Berlin' }), (tick, to) =>
    sourceSystems.map(source => to.create({ source, night: tick.at.toISOString().slice(0, 10) })),
  )
  .store(sqlite.store({ path: '.harness/store.sqlite' }))
  .handler(nightlyLoad, {
    exits: {
      invalid: Failed,
      rejected: Rejected,
      driftTooHigh: Failed,
      loadedWithWarnings: LoadedWithWarnings,
      loaded: Loaded,
    },
    during: { extract: Loading, validate: Loading, summarize: Loading, load: Loading, verify: Loading },
  })
  .retry({ maxAttempts: 1, backoff: 'fixed', initialDelayMs: 0, exhausted: Failed })
  .on(H.cancel, { enter: Expired });

const approvalDeadline = (createdAt: Date): Date => {
  const deadline = new Date(createdAt.getTime());
  deadline.setHours(9, 0, 0, 0);
  return deadline;
};

const approvalWindowCloses = H.trigger('approval-window-closes')
  .on(H.when.timer(nightlyLoads, u => (u.position === 'terminal' ? undefined : approvalDeadline(u.createdAt))))
  .signal(H.cancel, nightlyLoads, e =>
    e.unit.attempt?.step === 'approval'
      ? { key: e.unit.key, payload: { reason: 'approval not given by 09:00' } }
      : undefined,
  );

const approver = claudeCode.supervisor('data-approver').client('data-supervisor', {
  grants: [
    H.ops.workRead,
    H.ops.resolve(validationReview),
    H.ops.resolve(loadApproval),
    H.ops.attemptsRecover,
    H.ops.memoryRead,
    H.ops.memoryWrite,
    H.ops.telemetryRead,
  ],
});

export const dataJob = H.harness('nightly-data')
  .ledger(sqlite.ledger({ path: '.harness/ledger.sqlite' }))
  .lanes(nightlyLoads)
  .journals(approverTaste)
  .triggers(approvalWindowCloses)
  .scheduler(H.scheduler('nightly').priority(nightlyLoads).wip(nightlyLoads, 2))
  .clients(approver)
  .observers(markdown.board({ path: 'BOARD.md' }), markdown.telemetry({ path: 'TELEMETRY.md' }));
