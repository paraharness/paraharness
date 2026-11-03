import { z } from 'zod';
import { H } from 'harness-dsl';
import { anthropic } from 'harness-dsl/anthropic';
import { claudeCode } from 'harness-dsl/claude-code';
import { sqlite } from 'harness-dsl/sqlite';
import { jsonl } from 'harness-dsl/jsonl';
import { local } from 'harness-dsl/local';
import { ssh } from 'harness-dsl/ssh';
import { markdown } from 'harness-dsl/markdown';

const sourceEnum = z.enum(['crm', 'billing', 'inventory', 'support']);
const loadAttrs = z.object({ source: sourceEnum, night: z.date() });

const Scheduled = H.state('Scheduled', 'pending');
const Loaded = H.terminal('Loaded', 'success');
const LoadedWithWarnings = H.terminal('LoadedWithWarnings', 'success');
const Rejected = H.terminal('Rejected', 'neutral');
const Expired = H.terminal('Expired', 'neutral');
const Failed = H.terminal('Failed', 'failure');

const NightlyLoad = H.kind('NightlyLoad')
  .attributes(loadAttrs)
  .states(Scheduled, Loaded, LoadedWithWarnings, Rejected, Expired, Failed)
  .key(a => `${a.source}@${a.night.toISOString().slice(0, 10)}`)
  .initial(Scheduled);

const validationReview = H.halt('validation-review').decision(z.object({ proceed: z.boolean(), notes: z.string() }));
const loadApproval = H.halt('load-approval').decision(z.object({ approve: z.boolean(), notes: z.string() }));
const approvalExpired = H.signal('approval-expired');

const apiQuota = sqlite.quota('anthropic-api', { path: 'quota.sqlite' });
const apiAccount = anthropic.account('anthropic-api', { apiKey: H.env('ANTHROPIC_API_KEY'), quota: apiQuota });
const apiPool = H.pool('api').accounts(apiAccount);
const sonnet = anthropic.model('sonnet', { id: 'claude-sonnet-4-5' });

const summarizerRole = H.role('anomaly-summarizer')
  .intents('read')
  .instructions('Summarise the validation anomalies in plain language for the approver.');
const summarizer = H.seat('anomaly-summarizer').role(summarizerRole).model(sonnet).pool(apiPool);

const localRunner = local.runner('local');
const etlHost = ssh.host('etl', { host: 'etl.internal', user: 'loader', key: H.env('SSH_KEY_ETL') }).slots(2);

const sourceInput = z.object({ source: sourceEnum });
const tolerableDriftExitCode = 3;

const extract = H.command('extract').input(sourceInput).argv(i => ['./etl/extract', i.source]).runner(etlHost);
const validate = H.command('validate')
  .input(sourceInput)
  .argv(i => ['./etl/validate', i.source])
  .acceptExitCodes(0, 1)
  .runner(localRunner);
const load = H.command('load').input(sourceInput).argv(i => ['./etl/load', i.source]).runner(etlHost);
const verify = H.command('verify')
  .input(sourceInput)
  .argv(i => ['./etl/verify', i.source])
  .acceptExitCodes(0, tolerableDriftExitCode)
  .runner(localRunner);

const transientRetry = { maxAttempts: 3, backoff: 'exponential', initialDelayMs: 60_000 } satisfies { maxAttempts: number; backoff: 'exponential'; initialDelayMs: number };

const nightlyLoad = H.flow('nightly-load')
  .input(loadAttrs)
  .step('extract', extract, ctx => ({ source: ctx.unit.attributes.source }), { retry: transientRetry, afterCrash: 'rerun' })
  .step('validate', validate, ctx => ({ source: ctx.unit.attributes.source }), { afterCrash: 'rerun' })
  .halt('validationReview', validationReview, {
    when: ctx => ctx.steps.validate.exitCode !== 0,
    ask: ctx => `Validation failed for ${ctx.unit.attributes.source}. Report:\n${ctx.steps.validate.stdout}`,
  })
  .exit('validationRejected', ctx => ctx.steps.validationReview?.proceed === false)
  .step('summarize', summarizer, ctx => ({
    task: `Validation report for ${ctx.unit.attributes.source}:\n${ctx.steps.validate.stdout}`,
  }))
  .halt('approval', loadApproval, { ask: ctx => ctx.steps.summarize })
  .exit('approverRejected', ctx => ctx.steps.approval.approve === false)
  .step('load', load, ctx => ({ source: ctx.unit.attributes.source }), { retry: transientRetry, afterCrash: 'park' })
  .step('verify', verify, ctx => ({ source: ctx.unit.attributes.source }), { afterCrash: 'rerun' })
  .exit('loadedWithWarnings', ctx => ctx.steps.verify.exitCode === tolerableDriftExitCode)
  .exit('loaded');

const tz = 'Europe/Berlin';

const loads = H.lane('nightly-loads', NightlyLoad)
  .supply(H.clock('nightly-two-am').at('02:00', { tz }), (tick, to) =>
    sourceEnum.options.map(source => to.create({ source, night: tick.at })),
  )
  .handler(nightlyLoad, {
    exits: {
      validationRejected: Rejected,
      approverRejected: Rejected,
      loadedWithWarnings: LoadedWithWarnings,
      loaded: Loaded,
    },
  })
  .store(sqlite.store({ path: 'loads.sqlite' }))
  .retry({ maxAttempts: 1, exhausted: Failed })
  .on(approvalExpired, { enter: Expired });

const approvalWindowCloses = H.trigger('approval-window-closes')
  .on(
    H.when.timer(loads, {
      at: u => (u.attempt?.halt === loadApproval ? H.nextTime('09:00', { after: u.createdAt, tz }) : undefined),
    }),
  )
  .signal(approvalExpired, loads, e => ({ key: e.unit.key, payload: {} }));

const approverTaste = H.journal('approver-taste', H.memory('taste', 'taste'))
  .store(jsonl.memoryStore({ path: 'memory/taste.jsonl' }))
  .recall({ by: 'specificity', limit: 10 })
  .readBy(summarizerRole);

const approver = claudeCode.supervisor('approver', {
  grants: [
    H.ops.workRead,
    H.ops.resolve(validationReview, loadApproval),
    H.ops.attemptsRecover,
    H.ops.memoryRead,
    H.ops.memoryWrite,
    H.ops.telemetryRead,
  ],
});

export const harness = H.harness('data-approval')
  .ledger(sqlite.ledger({ path: 'harness.sqlite' }))
  .lanes(loads)
  .journals(approverTaste)
  .triggers(approvalWindowCloses)
  .scheduler(H.scheduler('nightly').standard(loads).wip(loads, 2))
  .clients(approver)
  .observers(markdown.board({ path: 'BOARD.md' }), markdown.telemetry({ path: 'TELEMETRY.md' }));
