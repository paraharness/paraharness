import { z } from 'zod';
import { H } from 'harness-dsl';
import { sqlite } from 'harness-dsl/sqlite';
import { jsonl } from 'harness-dsl/jsonl';
import { anthropic } from 'harness-dsl/anthropic';
import { claudeCode } from 'harness-dsl/claude-code';
import { ssh } from 'harness-dsl/ssh';
import { local } from 'harness-dsl/local';
import { markdown } from 'harness-dsl/markdown';

const apiAccount = anthropic.account('apiAccount', { apiKey: H.env('ANTHROPIC_API_KEY') });
const sonnet = anthropic.model('sonnet', { id: 'claude-sonnet-4-5' });
const apiPool = H.pool('api').accounts(apiAccount).serves(sonnet);

const etlHost = ssh.host('etlHost', { host: 'etl.internal', user: 'etl', key: H.env('ETL_SSH_KEY') }).slots(2);
const localRunner = local.runner('local');

const summarizerRole = H.role('summarizer')
  .intents('read')
  .instructions('Summarise the anomalies in the validation report in plain language for the approver.');

const summarizer = H.agent('summarizer').role(summarizerRole).model(sonnet);

const Taste = H.memory('Taste').trust('taste');
const taste = H.journal('taste', Taste)
  .store(jsonl.memoryStore({ path: '.harness/taste.jsonl' }))
  .recall(H.recall('byScope', { by: 'specificity', limit: 10 }))
  .readBy(summarizerRole);

const Scheduled = H.state('Scheduled', 'pending');
const Extracting = H.state('Extracting', 'active');
const Validating = H.state('Validating', 'active');
const ValidationReview = H.state('ValidationReview', 'waiting');
const Summarizing = H.state('Summarizing', 'active');
const AwaitingApproval = H.state('AwaitingApproval', 'waiting');
const Loading = H.state('Loading', 'active');
const Verifying = H.state('Verifying', 'active');
const Loaded = H.terminal('Loaded', 'success');
const LoadedWithWarnings = H.terminal('LoadedWithWarnings', 'success');
const Rejected = H.terminal('Rejected', 'neutral');
const Failed = H.terminal('Failed', 'failure');
const Expired = H.terminal('Expired', 'neutral');

const NightlyLoad = H.kind('NightlyLoad')
  .attributes(z.object({ source: z.string(), scheduledAt: z.string() }))
  .states(
    Scheduled,
    Extracting,
    Validating,
    ValidationReview,
    Summarizing,
    AwaitingApproval,
    Loading,
    Verifying,
    Loaded,
    LoadedWithWarnings,
    Rejected,
    Failed,
    Expired,
  )
  .key(a => `${a.source}@${a.scheduledAt.slice(0, 10)}`)
  .initial(Scheduled)
  .onAttemptFailed(Failed)
  .onCancelled(Expired);

const sourceInput = z.object({ source: z.string() });

const extract = H.command('extract')
  .input(sourceInput)
  .argv(input => ['/opt/etl/extract.sh', input.source])
  .runner(etlHost);

const validate = H.command('validate')
  .input(sourceInput)
  .argv(input => ['/opt/etl/validate.sh', input.source])
  .runner(etlHost)
  .acceptExitCodes(0, 1);

const load = H.command('load')
  .input(sourceInput)
  .argv(input => ['/opt/etl/load.sh', input.source])
  .runner(etlHost);

const verify = H.command('verify')
  .input(sourceInput)
  .argv(input => ['/opt/etl/verify.sh', input.source])
  .runner(localRunner)
  .acceptExitCodes(0, 2);

const validationDecision = H.signal('validationDecision').payload(z.object({ proceed: z.boolean() }));
const loadApproval = H.signal('loadApproval').payload(z.object({ approved: z.boolean(), note: z.string().optional() }));

const backoff = H.retry({ maxAttempts: 3, backoff: 'exponential', initialDelayMs: 30000, maxDelayMs: 600000 });

const nightlyFlow = H.flow('nightlyLoad')
  .input(sourceInput)
  .step('extract', extract, ctx => ({ source: ctx.unit.attributes.source }), { retry: backoff, afterCrash: 'rerun' })
  .step('validate', validate, ctx => ({ source: ctx.unit.attributes.source }), { afterCrash: 'rerun' })
  .await('validationReview', validationDecision, {
    ask: ctx => `Validation failed for ${ctx.unit.attributes.source}. Report:\n${ctx.steps.validate.stdout}\nProceed anyway?`,
    skip: ctx => (ctx.steps.validate.exitCode === 0 ? { proceed: true } : undefined),
  })
  .exit('invalid', ctx => !ctx.steps.validationReview.proceed)
  .step('summarize', summarizer, ctx => ({
    task: `Summarise the anomalies for the ${ctx.unit.attributes.source} load in plain language.\n\nValidation output:\n${ctx.steps.validate.stdout}`,
  }))
  .await('approval', loadApproval, {
    ask: ctx => `Approve tonight's load of ${ctx.unit.attributes.source}?\n\n${ctx.steps.summarize}`,
  })
  .exit('rejected', ctx => !ctx.steps.approval.approved)
  .step('load', load, ctx => ({ source: ctx.unit.attributes.source }), { retry: backoff, afterCrash: 'park' })
  .step('verify', verify, ctx => ({ source: ctx.unit.attributes.source }), { afterCrash: 'rerun' })
  .exit('loadedWithWarnings', ctx => ctx.steps.verify.exitCode === 2)
  .exit('loaded');

const sources = ['billing', 'crm', 'inventory', 'web'];

const loads = H.lane('nightlyLoads', NightlyLoad)
  .supply(H.clock('nightlyAtTwo').daily('02:00', { tz: 'Europe/London' }), (tick, to) =>
    sources.map(source => to.create({ source, scheduledAt: tick.at.toISOString() })),
  )
  .store(sqlite.store({ path: '.harness/loads.db' }))
  .handler(nightlyFlow, {
    exits: { invalid: Rejected, rejected: Rejected, loadedWithWarnings: LoadedWithWarnings, loaded: Loaded },
    during: {
      extract: Extracting,
      validate: Validating,
      validationReview: ValidationReview,
      summarize: Summarizing,
      approval: AwaitingApproval,
      load: Loading,
      verify: Verifying,
    },
  });

const approvalWindowCloses = H.trigger('approvalWindowCloses')
  .on(
    H.when.timer(loads, {
      at: unit => H.nextTime('09:00', { after: new Date(unit.attributes.scheduledAt), tz: 'Europe/London' }),
    }),
  )
  .signal(H.cancel, loads, event =>
    event.unit.position === 'waiting'
      ? { key: event.unit.key, payload: { reason: 'no approval by 09:00; the next night creates a new load' } }
      : undefined,
  );

const scheduler = H.scheduler('loadScheduler').priority(loads);

const approver = claudeCode.supervisor('approver', {
  grants: [
    H.ops.workRead,
    H.ops.send(loadApproval, { lanes: [loads] }),
    H.ops.send(validationDecision, { lanes: [loads] }),
    H.ops.attemptsRecover,
    H.ops.memoryRead,
    H.ops.memoryWrite,
    H.ops.telemetryRead,
  ],
});

export const dataJob = H.harness('dataJob')
  .ledger(sqlite.ledger({ path: '.harness/ledger.db' }))
  .pools(apiPool)
  .lanes(loads)
  .journals(taste)
  .triggers(approvalWindowCloses)
  .scheduler(scheduler)
  .clients(approver)
  .observers(markdown.board({ path: 'BOARD.md' }), markdown.telemetry({ path: 'TELEMETRY.md' }));
