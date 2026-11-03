import { z } from 'zod';
import { H } from 'harness-dsl';
import { sqlite } from 'harness-dsl/sqlite';
import { jsonl } from 'harness-dsl/jsonl';
import { anthropic } from 'harness-dsl/anthropic';
import { claudeCode } from 'harness-dsl/claude-code';
import { ssh } from 'harness-dsl/ssh';
import { markdown } from 'harness-dsl/markdown';

const quota = sqlite.quota('data-quota', { path: '.harness/quota.db' });
const apiAccount = anthropic.account('data-api', { apiKey: H.env('ANTHROPIC_API_KEY'), quota });
const sonnet = anthropic.model('sonnet', { id: 'claude-sonnet-4-5' });
const dataPool = H.pool('data').accounts(apiAccount);

const etl = ssh.host('etl', { host: 'etl.internal', user: 'loader', key: H.env('ETL_SSH_KEY') }).slots(2);

const sourceSystem = z.enum(['crm', 'billing', 'erp', 'warehouse']);
const loadAttrs = z.object({ source: sourceSystem });

const extract = H.command('extract')
  .input(loadAttrs)
  .argv(input => ['/opt/etl/extract.sh', input.source])
  .runner(etl);
const validate = H.command('validate')
  .input(loadAttrs)
  .argv(input => ['/opt/etl/validate.sh', input.source])
  .acceptExitCodes(0, 1)
  .runner(etl);
const load = H.command('load')
  .input(loadAttrs)
  .argv(input => ['/opt/etl/load.sh', input.source])
  .runner(etl);
const verify = H.command('verify')
  .input(loadAttrs)
  .argv(input => ['/opt/etl/verify.sh', input.source])
  .acceptExitCodes(0, 2)
  .runner(etl);

const summarizerRole = H.role('anomalySummarizer')
  .intents('read')
  .instructions('Explain the anomalies in plain language for the approver.');

const summarizer = H.seat('summarizer').role(summarizerRole).model(sonnet).pool(dataPool);

const validationReview = H.halt('validationReview').decision(z.object({ proceed: z.boolean() }));
const loadApproval = H.halt('loadApproval').decision(z.object({ approved: z.boolean(), note: z.string().optional() }));

const validationPassed = H.policy.halt('validationPassed', validationReview, z.object({ exitCode: z.number() }), ctx =>
  ctx.input.exitCode === 0 ? { proceed: true } : undefined,
);

const extractRetry = { maxAttempts: 3, backoff: 'exponential', initialDelayMs: 120000 } satisfies {
  readonly maxAttempts: number;
  readonly backoff: 'exponential';
  readonly initialDelayMs: number;
};

const nightlyLoad = H.flow('nightlyLoad')
  .input(loadAttrs)
  .step('extract', extract, ctx => ctx.unit.attributes, { retry: extractRetry, afterCrash: 'rerun' })
  .step('validate', validate, ctx => ctx.unit.attributes, { afterCrash: 'rerun' })
  .halt('validationReview', validationReview, {
    ask: ctx => `Validation of ${ctx.unit.attributes.source} failed:\n${ctx.steps.validate.stdout}`,
    policy: { by: validationPassed, input: ctx => ({ exitCode: ctx.steps.validate.exitCode }) },
  })
  .exit('invalid', ctx => !ctx.steps.validationReview.proceed)
  .step('summarize', summarizer, ctx => ({
    task: `Summarize the anomalies in tonight's ${ctx.unit.attributes.source} extract:\n${ctx.steps.validate.stdout}`,
  }))
  .halt('approval', loadApproval, { ask: ctx => ctx.steps.summarize })
  .exit('rejected', ctx => !ctx.steps.approval.approved)
  .step('load', load, ctx => ctx.unit.attributes, { retry: extractRetry, afterCrash: 'park' })
  .step('verify', verify, ctx => ctx.unit.attributes, { afterCrash: 'rerun' })
  .exit('warnings', ctx => ctx.steps.verify.exitCode === 2)
  .exit('loaded');

const Scheduled = H.state('Scheduled', 'pending');
const Loaded = H.terminal('Loaded', 'success');
const LoadedWithWarnings = H.terminal('LoadedWithWarnings', 'success');
const Rejected = H.terminal('Rejected', 'neutral');
const Expired = H.terminal('Expired', 'neutral');
const Failed = H.terminal('Failed', 'failure');

const NightlyLoad = H.kind('NightlyLoad')
  .attributes(loadAttrs)
  .states(Scheduled, Loaded, LoadedWithWarnings, Rejected, Expired, Failed)
  .key(unit => unit.source)
  .initial(Scheduled);

const loads = H.lane('nightlyLoads', NightlyLoad)
  .supply(H.clock('twoAm').at('02:00', { tz: 'Europe/London' }), (_tick, to) =>
    sourceSystem.options.map(source => to.create({ source })),
  )
  .store(sqlite.store({ path: '.harness/loads.db' }))
  .handler(nightlyLoad, {
    ends: { invalid: Failed, rejected: Rejected, warnings: LoadedWithWarnings, loaded: Loaded },
    retry: { maxAttempts: 1, backoff: 'fixed', initialDelayMs: 0, exhausted: Failed },
  })
  .on(H.cancel, { enter: Expired });

const approvalDeadline = H.trigger('approvalDeadline')
  .on(
    H.when.timer(loads, {
      at: unit =>
        unit.attempt?.step === 'approval' ? H.nextTime('09:00', { after: unit.createdAt, tz: 'Europe/London' }) : undefined,
    }),
  )
  .signal(H.cancel, loads, event => ({ key: event.unit.key, payload: { reason: 'Approval not given by 09:00' } }));

const approverTaste = H.journal('approverTaste', H.memory('approverTaste', 'taste'))
  .store(jsonl.memoryStore({ path: 'memory/approver-taste.jsonl' }))
  .recall({ by: 'specificity', limit: 10 })
  .readBy(summarizerRole);

const approver = claudeCode.supervisor('approver').client('data-approval', {
  grants: [
    H.ops.workRead,
    H.ops.workCancel,
    H.ops.resolve(validationReview),
    H.ops.resolve(loadApproval),
    H.ops.attemptsRecover,
    H.ops.memoryRead,
    H.ops.memoryWrite,
    H.ops.telemetryRead,
  ],
});

export const dataApproval = H.harness('data-approval')
  .ledger(sqlite.ledger({ path: '.harness/ledger.db' }))
  .lanes(loads)
  .journals(approverTaste)
  .triggers(approvalDeadline)
  .scheduler(H.scheduler('nightly').wip(loads, 2))
  .clients(approver)
  .observers(markdown.board({ path: 'BOARD.md' }), markdown.telemetry({ path: 'TELEMETRY.md' }));

void dataApproval.start();
