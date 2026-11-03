import { z } from 'zod';
import { H } from 'harness-dsl';
import { sqlite } from 'harness-dsl/sqlite';
import { jsonl } from 'harness-dsl/jsonl';
import { anthropic } from 'harness-dsl/anthropic';
import { claudeCode } from 'harness-dsl/claude-code';
import { ssh } from 'harness-dsl/ssh';
import { markdown } from 'harness-dsl/markdown';

const sourceSystem = z.enum(['crm', 'billing', 'warehouse', 'support']);
const loadAttrs = z.object({ source: sourceSystem });

const Scheduled = H.state('Scheduled', 'pending');
const Loaded = H.terminal('Loaded', 'success');
const LoadedWithWarnings = H.terminal('LoadedWithWarnings', 'success');
const Rejected = H.terminal('Rejected', 'neutral');
const LoadFailed = H.terminal('LoadFailed', 'failure');
const ApprovalExpired = H.terminal('ApprovalExpired', 'neutral');

const loadKind = H.kind('NightlyLoad')
  .attributes(loadAttrs)
  .states(Scheduled, Loaded, LoadedWithWarnings, Rejected, LoadFailed, ApprovalExpired)
  .key(a => a.source)
  .initial(Scheduled);

const validationReview = H.halt('validation-review').decision(z.object({ proceed: z.boolean(), note: z.string() }));
const loadApproval = H.halt('load-approval').decision(z.object({ approve: z.boolean(), note: z.string().optional() }));
const approvalExpired = H.signal('approval-expired');

const etlHost = ssh.host('etl-1', { host: 'etl-1.internal', user: 'etl', key: H.env('ETL_SSH_KEY') });

const transientRetry = H.retry({ maxAttempts: 3, backoff: 'exponential', initialDelayMs: 60_000 });

const extract = H.command('extract')
  .input(loadAttrs)
  .argv(i => ['/opt/etl/extract.sh', i.source])
  .runner(etlHost);

const validate = H.command('validate')
  .input(loadAttrs)
  .argv(i => ['/opt/etl/validate.sh', i.source])
  .acceptExitCodes(0, 2)
  .runner(etlHost);

const load = H.command('load')
  .input(loadAttrs)
  .argv(i => ['/opt/etl/load.sh', i.source])
  .runner(etlHost);

const verify = H.command('verify')
  .input(loadAttrs)
  .argv(i => ['/opt/etl/verify.sh', i.source])
  .acceptExitCodes(0, 3)
  .runner(etlHost);

const quota = sqlite.quota('anthropic-quota', { path: '.harness/quota.sqlite' });
const apiAccount = anthropic.account('etl-api', { apiKey: H.env('ANTHROPIC_API_KEY'), quota });
const etlPool = H.pool('etl').accounts(apiAccount);

const summarizerRole = H.role('anomaly-summarizer')
  .intents('read')
  .instructions('Summarize the anomalies in the validation report in plain language for the approver.');

const summarizer = H.seat('anomaly-summarizer')
  .role(summarizerRole)
  .model(anthropic.model('sonnet', { id: 'claude-sonnet-4-5' }))
  .pool(etlPool)
  .output(z.object({ summary: z.string() }));

const approverTaste = H.journal('approver-taste', H.memory('approver-taste', 'taste'))
  .store(jsonl.memoryStore({ path: '.harness/memory/taste.jsonl' }))
  .recall({ by: 'specificity', limit: 10 })
  .readBy(summarizerRole);

const nightlyLoad = H.flow('nightly-load')
  .input(loadAttrs)
  .step('extract', extract, ctx => ({ source: ctx.unit.attributes.source }), { retry: transientRetry, afterCrash: 'rerun' })
  .step('validate', validate, ctx => ({ source: ctx.unit.attributes.source }))
  .halt('validationReview', validationReview, {
    when: ctx => ctx.steps.validate.exitCode > 0,
    ask: ctx => `Validation failed for ${ctx.unit.attributes.source}:\n\n${ctx.steps.validate.stdout}`,
  })
  .exit('validationRejected', ctx => ctx.steps.validationReview?.proceed === false)
  .step('summarize', summarizer, ctx => ({
    task: `Summarize the anomalies for ${ctx.unit.attributes.source}:\n\n${ctx.steps.validate.stdout}`,
  }))
  .halt('approval', loadApproval, {
    ask: ctx => `Approve tonight's ${ctx.unit.attributes.source} load?\n\n${ctx.steps.summarize.summary}`,
  })
  .exit('rejected', ctx => ctx.steps.approval.approve === false)
  .step('load', load, ctx => ({ source: ctx.unit.attributes.source }), { retry: transientRetry, afterCrash: 'park' })
  .step('verify', verify, ctx => ({ source: ctx.unit.attributes.source }))
  .exit('loadedWithWarnings', ctx => ctx.steps.verify.exitCode === 3)
  .exit('loaded');

const loads = H.lane('nightly-loads', loadKind)
  .supply(H.clock('nightly-0200').at('02:00', { tz: 'Europe/London' }), (tick, to) =>
    sourceSystem.options.map(source => to.create({ source })))
  .handler(nightlyLoad, {
    exits: {
      validationRejected: Rejected,
      rejected: Rejected,
      loadedWithWarnings: LoadedWithWarnings,
      loaded: Loaded,
    },
  })
  .store(sqlite.store({ path: '.harness/loads.sqlite' }))
  .retry({ maxAttempts: 1, exhausted: LoadFailed })
  .on(approvalExpired, { enter: ApprovalExpired });

const approvalDeadline = H.trigger('approval-deadline-0900')
  .on(H.when.timer(loads, {
    at: view => H.nextTime('09:00', { after: view.createdAt, tz: 'Europe/London' }),
  }))
  .signal(approvalExpired, loads, e =>
    e.unit.attempt?.halt === loadApproval ? { key: e.unit.key, payload: {} } : undefined);

const approverDesk = claudeCode.supervisor('approver-desk', {
  grants: [
    H.ops.workRead,
    H.ops.resolve(validationReview, loadApproval),
    H.ops.memoryRead,
    H.ops.memoryWrite,
    H.ops.telemetryRead,
  ],
});

export const harness = H.harness('nightly-data')
  .ledger(sqlite.ledger({ path: '.harness/ledger.sqlite' }))
  .lanes(loads)
  .journals(approverTaste)
  .triggers(approvalDeadline)
  .scheduler(H.scheduler('nightly').standard(loads))
  .clients(approverDesk)
  .observers(markdown.board({ path: 'BOARD.md' }), markdown.telemetry({ path: 'TELEMETRY.md' }));

void harness.start();
