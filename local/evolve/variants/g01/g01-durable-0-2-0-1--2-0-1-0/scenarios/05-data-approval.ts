import { z } from 'zod';
import { H } from 'harness-dsl';
import { anthropic } from 'harness-dsl/anthropic';
import { claudeCode } from 'harness-dsl/claude-code';
import { sqlite } from 'harness-dsl/sqlite';
import { jsonl } from 'harness-dsl/jsonl';
import { ssh } from 'harness-dsl/ssh';
import { local } from 'harness-dsl/local';
import { markdown } from 'harness-dsl/markdown';

const warehouse = ssh.host('warehouse', {
  host: 'warehouse.internal',
  user: 'etl',
  key: H.env('ETL_SSH_KEY'),
}).slots(2);
const localRunner = local.runner('local');

const sources = ['crm', 'billing', 'inventory', 'support'];

const quota = sqlite.quota('data-quota', { path: '.harness/quota.sqlite' });
const apiAccount = anthropic.account('data-api', { apiKey: H.env('ANTHROPIC_API_KEY'), quota });
const api = H.pool('data-api').accounts(apiAccount);
const sonnet = anthropic.model('sonnet', { id: 'claude-sonnet-4-5' });

const summarizerRole = H.role('anomaly-summarizer')
  .intents('read')
  .instructions('Summarize the anomalies in the validation report in plain language for the approver.');

const approverTaste = H.memory('approver-taste', 'taste');
const tasteJournal = H.journal('approver-taste', approverTaste)
  .store(jsonl.memoryStore({ path: 'memory/approver-taste.jsonl' }))
  .recall({ by: 'specificity', limit: 10 })
  .readBy(summarizerRole);

const summarizer = H.seat('anomaly-summarizer')
  .role(summarizerRole)
  .model(sonnet)
  .pool(api)
  .output(z.object({ summary: z.string() }));

const stepBackoff = { maxAttempts: 3, backoff: 'exponential' as const, initialDelayMs: 30_000 };

const extract = H.command('extract')
  .input(z.object({ source: z.string() }))
  .argv((input) => ['/opt/etl/extract', input.source])
  .runner(warehouse);

const validate = H.command('validate')
  .input(z.object({ source: z.string() }))
  .argv((input) => ['/opt/etl/validate', '--json', input.source])
  .acceptExitCodes(0, 1)
  .output(z.object({ passed: z.boolean(), report: z.string() }))
  .runner(warehouse);

const load = H.command('load')
  .input(z.object({ source: z.string() }))
  .argv((input) => ['/opt/etl/load', input.source])
  .runner(warehouse);

const verify = H.command('verify')
  .input(z.object({ source: z.string() }))
  .argv((input) => ['/opt/etl/verify', '--json', input.source])
  .output(z.object({ drift: z.enum(['none', 'tolerable', 'excessive']) }))
  .runner(localRunner);

const validationReview = H.halt('validation-review').decision(
  z.object({ proceed: z.boolean(), note: z.string() }),
);
const loadApproval = H.halt('load-approval').decision(z.object({ approved: z.boolean(), note: z.string() }));

const loadSchema = z.object({ source: z.string(), night: z.string() });

const nightlyLoad = H.flow('nightly-load')
  .input(loadSchema)
  .step('extract', extract, (ctx) => ({ source: ctx.unit.attributes.source }), {
    retry: stepBackoff,
    afterCrash: 'rerun',
  })
  .step('validate', validate, (ctx) => ({ source: ctx.unit.attributes.source }))
  .halt('validationReview', validationReview, {
    ask: (ctx) => `Validation failed for ${ctx.unit.attributes.source}:\n${ctx.steps.validate.report}`,
    askIf: (ctx) => !ctx.steps.validate.passed,
  })
  .exit('invalid', (ctx) => ctx.steps.validationReview?.proceed === false)
  .step('summarize', summarizer, (ctx) => ({
    task: `Summarize the anomalies for the ${ctx.unit.attributes.source} load of ${ctx.unit.attributes.night}:\n${ctx.steps.validate.report}`,
  }))
  .halt('approval', loadApproval, {
    ask: (ctx) => `Approve the ${ctx.unit.attributes.source} load?\n\n${ctx.steps.summarize.summary}`,
  })
  .exit('rejected', (ctx) => !ctx.steps.approval.approved)
  .step('load', load, (ctx) => ({ source: ctx.unit.attributes.source }), {
    retry: stepBackoff,
    afterCrash: 'park',
  })
  .step('verify', verify, (ctx) => ({ source: ctx.unit.attributes.source }))
  .exit('driftExcessive', (ctx) => ctx.steps.verify.drift === 'excessive')
  .exit('loadedWithWarnings', (ctx) => ctx.steps.verify.drift === 'tolerable')
  .exit('loaded');

const Scheduled = H.state('Scheduled', 'pending');
const Extracting = H.state('Extracting', 'active');
const Validating = H.state('Validating', 'active');
const Summarizing = H.state('Summarizing', 'active');
const AwaitingApproval = H.state('AwaitingApproval', 'waiting');
const Loading = H.state('Loading', 'active');
const Loaded = H.terminal('Loaded', 'success');
const LoadedWithWarnings = H.terminal('LoadedWithWarnings', 'success');
const Rejected = H.terminal('Rejected', 'neutral');
const Expired = H.terminal('Expired', 'neutral');
const Failed = H.terminal('Failed', 'failure');

const NightlyLoad = H.kind('NightlyLoad')
  .attributes(loadSchema)
  .states(
    Scheduled,
    Extracting,
    Validating,
    Summarizing,
    AwaitingApproval,
    Loading,
    Loaded,
    LoadedWithWarnings,
    Rejected,
    Expired,
    Failed,
  )
  .key((unit) => `${unit.source}@${unit.night}`)
  .initial(Scheduled);

const loads = H.lane('nightly-loads', NightlyLoad)
  .supply(H.clock('two-am').at('02:00', { tz: 'Europe/London' }), (tick, to) =>
    sources.map((source) => to.create({ source, night: tick.at.toISOString().slice(0, 10) })),
  )
  .store(sqlite.store({ path: '.harness/store.sqlite' }))
  .handler(nightlyLoad, {
    exits: {
      invalid: Rejected,
      rejected: Rejected,
      driftExcessive: Failed,
      loadedWithWarnings: LoadedWithWarnings,
      loaded: Loaded,
    },
    during: {
      extract: Extracting,
      validate: Validating,
      summarize: Summarizing,
      load: Loading,
      verify: Loading,
      validationReview: AwaitingApproval,
      approval: AwaitingApproval,
    },
  })
  .retry({ maxAttempts: 1, backoff: 'fixed', initialDelayMs: 0, exhausted: Failed })
  .on(H.cancel, { enter: Expired });

const approvalWindowCloses = H.trigger('approval-window-closes-at-nine')
  .on(
    H.when.timer(loads, {
      at: (unit) =>
        unit.position === 'terminal'
          ? undefined
          : H.nextTime('09:00', { after: unit.createdAt, tz: 'Europe/London' }),
    }),
  )
  .signal(H.cancel, loads, (event) =>
    event.unit.attempt?.step === 'approval'
      ? { key: event.unit.key, payload: { reason: 'approval not given by 09:00' } }
      : undefined,
  );

const approver = claudeCode.supervisor('approver').client('data-approver', {
  grants: [
    H.ops.workRead,
    H.ops.resolve(validationReview),
    H.ops.resolve(loadApproval),
    H.ops.memoryRead,
    H.ops.memoryWrite,
    H.ops.telemetryRead,
  ],
  port: H.slot.port(1),
});

export const harness = H.harness('nightly-data')
  .ledger(sqlite.ledger({ path: '.harness/ledger.sqlite' }))
  .lanes(loads)
  .journals(tasteJournal)
  .triggers(approvalWindowCloses)
  .scheduler(H.scheduler('nightly').priority(loads).wip(loads, 2))
  .clients(approver)
  .observers(markdown.board({ path: 'BOARD.md' }), markdown.telemetry({ path: 'TELEMETRY.md' }));

void harness.start();
