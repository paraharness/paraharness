import { H } from 'harness-dsl';
import { z } from 'zod';
import { sqlite } from 'harness-dsl/sqlite';
import { jsonl } from 'harness-dsl/jsonl';
import { anthropic } from 'harness-dsl/anthropic';
import { claudeCode } from 'harness-dsl/claude-code';
import { ssh } from 'harness-dsl/ssh';
import { local } from 'harness-dsl/local';
import { markdown } from 'harness-dsl/markdown';

const sourceSchema = z.enum(['crm', 'billing', 'inventory', 'web']);
const loadSchema = z.object({ source: sourceSchema, night: z.string() });

const Scheduled = H.state('Scheduled', 'pending');
const Loaded = H.terminal('Loaded', 'success');
const LoadedWithWarnings = H.terminal('LoadedWithWarnings', 'success');
const Rejected = H.terminal('Rejected', 'neutral');
const LoadFailed = H.terminal('LoadFailed', 'failure');
const ApprovalExpired = H.terminal('ApprovalExpired', 'neutral');

const NightlyLoad = H.kind('NightlyLoad')
  .attributes(loadSchema)
  .states(Scheduled, Loaded, LoadedWithWarnings, Rejected, LoadFailed, ApprovalExpired)
  .key(a => `${a.source}-${a.night}`)
  .initial(Scheduled);

const etlHost = ssh.host('etl-host', { host: 'etl.internal', user: 'etl', key: H.env('ETL_SSH_KEY') });
const localRunner = local.runner('local');
const sourceInput = z.object({ source: sourceSchema });
const stepRetry = { maxAttempts: 3, backoff: 'exponential', initialDelayMs: 60_000 } as const satisfies object;

const extract = H.command('extract')
  .input(sourceInput)
  .argv(i => ['etl', 'extract', i.source])
  .runner(etlHost);
const validate = H.command('validate')
  .input(sourceInput)
  .argv(i => ['etl', 'validate', i.source])
  .acceptExitCodes(0, 2)
  .output(z.object({ ok: z.boolean(), report: z.string() }))
  .runner(localRunner);
const load = H.command('load')
  .input(sourceInput)
  .argv(i => ['etl', 'load', i.source])
  .runner(etlHost);
const verify = H.command('verify')
  .input(sourceInput)
  .argv(i => ['etl', 'verify', i.source])
  .output(z.object({ drift: z.enum(['none', 'tolerable', 'excessive']) }))
  .runner(localRunner);

const quota = sqlite.quota('data-quota', { path: './.harness/quota.sqlite' });
const api = anthropic.account('anthropic-api', { apiKey: H.env('ANTHROPIC_API_KEY'), quota });
const pool = H.pool('data').accounts(api);
const sonnet = anthropic.model('sonnet', { id: 'claude-sonnet-4-5' });

const summarizer = H.role('anomaly-summarizer').intents('read').instructions('Summarize anomalies in the validation report in plain language.');
const summarizerSeat = H.seat('anomaly-summarizer').role(summarizer).model(sonnet).pool(pool);
const summarizeCall = H.call('summarize-anomalies', summarizerSeat).output(z.object({ summary: z.string() }));

const validationReview = H.halt('validation-review').decision(z.object({ proceed: z.boolean(), note: z.string().optional() }));
const loadApproval = H.halt('load-approval').decision(z.object({ approve: z.boolean(), note: z.string().optional() }));

const nightlyFlow = H.flow('nightly-load')
  .input(loadSchema)
  .step('extract', extract, ctx => ({ source: ctx.unit.attributes.source }), { retry: stepRetry, afterCrash: 'rerun' })
  .step('validate', validate, ctx => ({ source: ctx.unit.attributes.source }))
  .halt('validationReview', validationReview, {
    when: ctx => !ctx.steps.validate.ok,
    ask: ctx => `Validation failed for ${ctx.unit.key}. Proceed anyway?\n\n${ctx.steps.validate.report}`,
  })
  .exit('rejectedAtValidation', ctx => ctx.steps.validationReview?.proceed === false)
  .step('summarize', summarizeCall, ctx => ({
    text: `Summarize the anomalies for ${ctx.unit.attributes.source} on ${ctx.unit.attributes.night}:\n\n${ctx.steps.validate.report}`,
  }))
  .halt('approval', loadApproval, {
    ask: ctx => `Approve the ${ctx.unit.attributes.source} load for ${ctx.unit.attributes.night}?\n\n${ctx.steps.summarize.summary}`,
  })
  .exit('rejected', ctx => !ctx.steps.approval.approve)
  .step('load', load, ctx => ({ source: ctx.unit.attributes.source }), { retry: stepRetry, afterCrash: 'park' })
  .step('verify', verify, ctx => ({ source: ctx.unit.attributes.source }))
  .exit('loaded', ctx => ctx.steps.verify.drift === 'none')
  .exit('loadedWithWarnings', ctx => ctx.steps.verify.drift === 'tolerable')
  .exit('driftExceeded');

const loads = H.lane('nightly-loads', NightlyLoad)
  .supply(H.clock('nightly-0200').at('02:00', { tz: 'UTC' }), (tick, to) =>
    sourceSchema.options.map(source => to.create({ source, night: tick.at.toISOString().slice(0, 10) })),
  )
  .handler(nightlyFlow, {
    exits: {
      rejectedAtValidation: Rejected,
      rejected: Rejected,
      loaded: Loaded,
      loadedWithWarnings: LoadedWithWarnings,
      driftExceeded: LoadFailed,
    },
  })
  .store(sqlite.store({ path: './.harness/store.sqlite' }))
  .retry({ maxAttempts: 1, exhausted: LoadFailed })
  .on(H.cancel, { enter: ApprovalExpired });

const approvalDeadline = H.trigger('approval-closes-at-0900')
  .on(H.when.timer(loads, { at: unit => H.nextTime('09:00', { after: unit.createdAt, tz: 'UTC' }) }))
  .signal(H.cancel, loads, e =>
    e.unit.attempt !== undefined && e.unit.attempt.halt === loadApproval
      ? { key: e.unit.key, payload: { reason: 'approval not given by 09:00' } }
      : undefined,
  );

const tasteKind = H.memory('approver-taste', 'taste');
const approverTaste = H.journal('approver-taste', tasteKind)
  .store(jsonl.memoryStore({ path: './memory/approver-taste.jsonl' }))
  .recall({ by: 'specificity', limit: 10 })
  .readBy(summarizer);

const approverConsole = claudeCode.supervisor('approver-console', {
  grants: [H.ops.workRead, H.ops.resolve(validationReview, loadApproval), H.ops.memoryWrite, H.ops.telemetryRead],
});

const dataJob = H.harness('nightly-data')
  .ledger(sqlite.ledger({ path: './.harness/ledger.sqlite' }))
  .lanes(loads)
  .journals(approverTaste)
  .triggers(approvalDeadline)
  .scheduler(H.scheduler('nightly').standard(loads))
  .clients(approverConsole)
  .observers(markdown.board({ path: './BOARD.md' }), markdown.telemetry({ path: './TELEMETRY.md' }));

void dataJob.start();
