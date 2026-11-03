import { z } from 'zod';
import { H } from 'harness-dsl';
import { sqlite } from 'harness-dsl/sqlite';
import { jsonl } from 'harness-dsl/jsonl';
import { anthropic } from 'harness-dsl/anthropic';
import { claudeCode } from 'harness-dsl/claude-code';
import { local } from 'harness-dsl/local';
import { ssh } from 'harness-dsl/ssh';
import { markdown } from 'harness-dsl/markdown';

const sourceSystems = ['crm', 'billing', 'inventory', 'web-analytics'];
const approvalDeadline = '09:00';
const approvalTimeZone = 'Europe/London';
const stepRetry = { maxAttempts: 3, backoff: 'exponential', initialDelayMs: 60000 } satisfies {
  readonly maxAttempts: number;
  readonly backoff: 'fixed' | 'exponential';
  readonly initialDelayMs: number;
};

const loadSchema = z.object({ source: z.string(), night: z.string() });

const Queued = H.state('Queued', 'pending');
const Preparing = H.state('Preparing', 'active');
const HeldForValidation = H.state('HeldForValidation', 'waiting');
const AwaitingApproval = H.state('AwaitingApproval', 'waiting');
const Loading = H.state('Loading', 'active');
const Loaded = H.terminal('Loaded', 'success');
const LoadedWithWarnings = H.terminal('LoadedWithWarnings', 'success');
const Rejected = H.terminal('Rejected', 'neutral');
const Failed = H.terminal('Failed', 'failure');
const Expired = H.terminal('Expired', 'neutral');

const NightlyLoad = H.kind('NightlyLoad')
  .attributes(loadSchema)
  .states(Queued, Preparing, HeldForValidation, AwaitingApproval, Loading, Loaded, LoadedWithWarnings, Rejected, Failed, Expired)
  .key(attrs => `${attrs.source}:${attrs.night}`)
  .initial(Queued)
  .onAttemptFailed(Failed)
  .onCancelled(Expired);

const etlHost = ssh.host('etl-host', { host: 'etl.internal', user: 'etl', key: H.env('ETL_SSH_KEY') }).slots(2);
const localRunner = local.runner('local');

const extract = H.command('extract')
  .input(loadSchema)
  .argv(input => ['/opt/etl/extract.sh', input.source, input.night])
  .runner(etlHost);

const validate = H.command('validate')
  .input(loadSchema)
  .argv(input => ['./scripts/validate.sh', input.source, input.night])
  .runner(localRunner)
  .acceptExitCodes(1);

const load = H.command('load')
  .input(loadSchema)
  .argv(input => ['/opt/etl/load.sh', input.source, input.night])
  .runner(etlHost);

const verify = H.command('verify')
  .input(loadSchema)
  .argv(input => ['./scripts/verify.sh', input.source, input.night])
  .runner(localRunner)
  .acceptExitCodes(3);

const apiAccount = anthropic.account('anthropic-api', { apiKey: H.env('ANTHROPIC_API_KEY') });
const summaryPool = H.pool('summary-pool').accounts(apiAccount);

const summarizerRole = H.role('anomaly-summarizer')
  .intents('read')
  .instructions('Summarise the validation anomalies in plain language for the approver.');

const summarizer = H.agent('anomaly-summarizer')
  .role(summarizerRole)
  .model(anthropic.model('sonnet', { id: 'claude-sonnet-4-5' }))
  .pool(summaryPool)
  .output(z.object({ summary: z.string() }));

const approverTaste = H.corpus('approver-taste', H.memory('taste', 'taste'))
  .store(jsonl.memoryStore({ path: './.harness/memory/taste.jsonl' }))
  .recall({ by: 'specificity', limit: 10 })
  .readBy(summarizerRole);

const loadFlow = H.flow('nightly-load')
  .input(loadSchema)
  .step('extract', extract, ctx => ctx.unit.attributes, { retry: stepRetry })
  .step('validate', validate, ctx => ctx.unit.attributes)
  .halt('validationReview', {
    ask: ctx => `Validation failed for ${ctx.unit.attributes.source} (${ctx.unit.attributes.night}):\n\n${ctx.steps.validate.stdout}`,
    decision: z.object({ proceed: z.boolean() }),
    skip: ctx => (ctx.steps.validate.exitCode === 0 ? { proceed: true } : undefined),
  })
  .exit('invalid', ctx => !ctx.steps.validationReview.proceed)
  .step('summarize', summarizer, ctx => ({
    task: `Source ${ctx.unit.attributes.source}, night ${ctx.unit.attributes.night}. Validation report:\n\n${ctx.steps.validate.stdout}`,
  }))
  .halt('approval', {
    ask: ctx => `Approve the load of ${ctx.unit.attributes.source} for ${ctx.unit.attributes.night}?\n\n${ctx.steps.summarize.summary}`,
    decision: z.object({ approved: z.boolean(), note: z.string().optional() }),
  })
  .exit('rejected', ctx => !ctx.steps.approval.approved)
  .step('load', load, ctx => ctx.unit.attributes, { retry: stepRetry })
  .step('verify', verify, ctx => ctx.unit.attributes)
  .exit('loadedWithWarnings', ctx => ctx.steps.verify.exitCode === 3)
  .exit('loaded');

const loads = H.lane('nightly-loads', NightlyLoad)
  .supply(
    H.clock('two-am').at('02:00', { tz: approvalTimeZone }),
    (tick, to) => sourceSystems.map(source => to.create({ source, night: tick.at.toISOString().slice(0, 10) })),
  )
  .store(sqlite.store({ path: './.harness/loads.db' }))
  .handler(loadFlow, {
    exits: { invalid: Failed, rejected: Rejected, loadedWithWarnings: LoadedWithWarnings, loaded: Loaded },
    during: {
      extract: Preparing,
      validate: Preparing,
      validationReview: HeldForValidation,
      summarize: Preparing,
      approval: AwaitingApproval,
      load: Loading,
      verify: Loading,
    },
  })
  .retry({ maxAttempts: 1, backoff: 'fixed', initialDelayMs: 0 });

const approvalExpiry = H.trigger('approval-expires-at-nine')
  .on(H.when.timer(loads, {
    at: unit => H.nextTime(approvalDeadline, { after: unit.createdAt, tz: approvalTimeZone }),
  }))
  .signal(H.cancel, loads, event =>
    event.unit.attempt?.step === 'approval'
      ? { key: event.unit.key, payload: { reason: `approval not given by ${approvalDeadline}` } }
      : undefined,
  );

const scheduler = H.scheduler('nightly').priority(loads);

const supervisor = claudeCode.supervisor('approver-supervisor', {
  grants: [H.ops.workRead, H.ops.blockersResolve, H.ops.attemptsRecover, H.ops.memoryRead, H.ops.memoryWrite, H.ops.telemetryRead],
});

export const dataJob = H.harness('nightly-data-job')
  .ledger(sqlite.ledger({ path: './.harness/ledger.db' }))
  .lanes(loads)
  .corpora(approverTaste)
  .triggers(approvalExpiry)
  .scheduler(scheduler)
  .clients(supervisor)
  .observers(
    markdown.board({ path: './.harness/board.md' }),
    markdown.telemetry({ path: './.harness/telemetry.md' }),
  );
