import { z } from 'zod';
import { H, Metrics, Window } from 'harness-dsl';
import { sqlite } from 'harness-dsl/sqlite';
import { anthropic } from 'harness-dsl/anthropic';
import { claudeCode } from 'harness-dsl/claude-code';
import { folder } from 'harness-dsl/folder';
import { local } from 'harness-dsl/local';
import { markdown } from 'harness-dsl/markdown';

const runner = local.runner('local');
const harnessStore = sqlite.store({ path: 'ml-platform.store.db' });

const apiAccount = anthropic.account('ml-api', { apiKey: H.env('ANTHROPIC_API_KEY') });
const haiku = anthropic.model('haiku', { id: 'claude-haiku-4-5' });
const mlPool = H.pool('ml').accounts(apiAccount);

const evalAttrs = z.object({ suite: z.string(), checkpoint: z.string() });

const EvalQueued = H.state('EvalQueued', 'pending');
const Preparing = H.state('Preparing', 'active');
const Training = H.state('OnGpu', 'waiting');
const Scoring = H.state('Scoring', 'active');
const Summarizing = H.state('Summarizing', 'active');
const Evaluated = H.terminal('Evaluated', 'success');
const EvalFailed = H.terminal('EvalFailed', 'failure');

const evalRun = H.kind('EvalRun')
  .attributes(evalAttrs)
  .states(EvalQueued, Preparing, Training, Scoring, Summarizing, Evaluated, EvalFailed)
  .key(attrs => `${attrs.suite}:${attrs.checkpoint}`)
  .initial(EvalQueued);

const prepareEval = H.command('prepare-eval')
  .input(evalAttrs)
  .argv(input => ['evals', 'prepare', '--suite', input.suite, '--checkpoint', input.checkpoint])
  .runner(runner);

const submitGpuJob = H.command('submit-gpu-job')
  .input(evalAttrs)
  .output(z.object({ jobId: z.string() }))
  .argv(input => ['gpu', 'submit', '--suite', input.suite, '--checkpoint', input.checkpoint])
  .runner(runner);

const collectGpuJob = H.command('collect-gpu-job')
  .input(z.object({ jobId: z.string() }))
  .output(H.jobPoll(z.object({ resultsUri: z.string() })))
  .argv(input => ['gpu', 'status', '--job', input.jobId])
  .runner(runner);

const scoreEval = H.command('score-eval')
  .input(z.object({ resultsUri: z.string() }))
  .output(z.object({ score: z.number(), report: z.string() }))
  .argv(input => ['evals', 'score', '--results', input.resultsUri])
  .runner(runner);

const summarizerRole = H.role('eval-summarizer')
  .intents('read')
  .instructions('Summarize the eval report for the research channel in five bullet points.');

const summarizer = H.agent('eval-summarizer').role(summarizerRole).model(haiku).pool(mlPool);

const evalFlow = H.flow('eval-run')
  .input(evalAttrs)
  .step('prepare', prepareEval, ctx => ctx.unit.attributes)
  .job('gpu', {
    submit: submitGpuJob,
    input: ctx => ctx.unit.attributes,
    collect: collectGpuJob,
    pollEveryMinutes: 10,
  })
  .step('score', scoreEval, ctx => ({ resultsUri: ctx.steps.gpu.resultsUri }))
  .step('summarize', summarizer, ctx => ({
    task: `Summarize eval ${ctx.unit.attributes.suite} on ${ctx.unit.attributes.checkpoint}, score ${ctx.steps.score.score}:\n${ctx.steps.score.report}`,
  }))
  .exit('evaluated');

const evalRuns = H.lane('eval-runs', evalRun)
  .supply(H.operator)
  .store(harnessStore)
  .handler(evalFlow, {
    exits: { evaluated: Evaluated },
    during: { prepare: Preparing, gpu: Training, score: Scoring, summarize: Summarizing },
  })
  .retry({ maxAttempts: 2, backoff: 'fixed', initialDelayMs: 600_000, exhausted: EvalFailed });

const databases = {
  orders: H.resource('orders-db'),
  billing: H.resource('billing-db'),
};
const databaseName = z.enum(['orders', 'billing']);

const migrationAttrs = z.object({ sequence: z.number().int(), database: databaseName, file: z.string() });

const MigrationQueued = H.state('MigrationQueued', 'pending');
const Migrating = H.state('Migrating', 'active');
const HeldByPredecessor = H.state('HeldByPredecessor', 'waiting');
const Migrated = H.terminal('Migrated', 'success');
const MigrationFailed = H.terminal('MigrationFailed', 'failure');

const sequenceKey = (sequence: number) => String(sequence).padStart(4, '0');

const migration = H.kind('Migration')
  .attributes(migrationAttrs)
  .states(MigrationQueued, Migrating, HeldByPredecessor, Migrated, MigrationFailed)
  .key(attrs => sequenceKey(attrs.sequence))
  .initial(MigrationQueued)
  .onAttemptFailed(MigrationFailed);

const applyMigration = H.command('apply-migration')
  .input(migrationAttrs)
  .argv(input => ['migrate', 'apply', '--database', input.database, '--file', input.file])
  .runner(runner);

const migrationFlow = H.flow('migration')
  .input(migrationAttrs)
  .step('apply', applyMigration, ctx => ctx.unit.attributes, { afterCrash: 'park' })
  .exit('migrated');

const migrations = H.lane('migrations', migration)
  .supply(folder.files({ path: 'migrations', glob: '*.sql' }), (file, to) => {
    const parts = file.name.split('_');
    const sequence = Number(parts[0]);
    const database = databaseName.safeParse(parts[1]);
    if (!database.success || !Number.isInteger(sequence)) return to.skip();
    return to.create({ sequence, database: database.data, file: file.path });
  })
  .store(harnessStore)
  .handler(migrationFlow, { exits: { migrated: Migrated }, during: { apply: Migrating } })
  .lease(unit => ({ resource: databases[unit.attributes.database], mode: 'exclusive' }))
  .after({
    key: attrs => (attrs.sequence > 1 ? sequenceKey(attrs.sequence - 1) : undefined),
    onPredecessorFailed: HeldByPredecessor,
  });

const batchRows = 10_000;

const backfillAttrs = z.object({ table: z.string(), database: databaseName, totalRows: z.number().int() });

const BackfillQueued = H.state('BackfillQueued', 'pending');
const Backfilling = H.state('Backfilling', 'active');
const Backfilled = H.terminal('Backfilled', 'success');
const BackfillFailed = H.terminal('BackfillFailed', 'failure');

const backfill = H.kind('Backfill')
  .attributes(backfillAttrs)
  .states(BackfillQueued, Backfilling, Backfilled, BackfillFailed)
  .key(attrs => `${attrs.database}.${attrs.table}`)
  .initial(BackfillQueued)
  .onAttemptFailed(BackfillFailed);

const backfillBatch = H.command('backfill-batch')
  .input(z.object({ table: z.string(), database: databaseName, offset: z.number(), limit: z.number() }))
  .output(z.object({ rowsWritten: z.number(), done: z.boolean() }))
  .argv(input => [
    'backfill',
    '--database',
    input.database,
    '--table',
    input.table,
    '--offset',
    String(input.offset),
    '--limit',
    String(input.limit),
  ])
  .runner(runner);

const backfillFlow = H.flow('backfill')
  .input(backfillAttrs)
  .loop(
    'batches',
    flow =>
      flow.step(
        'batch',
        backfillBatch,
        ctx => ({
          table: ctx.unit.attributes.table,
          database: ctx.unit.attributes.database,
          offset: ctx.iteration * batchRows,
          limit: batchRows,
        }),
        { afterCrash: 'rerun' },
      ),
    {
      max: ctx => Math.ceil(ctx.unit.attributes.totalRows / batchRows),
      until: ctx => ctx.steps.batch.done,
    },
  )
  .exit('backfilled');

const backfills = H.lane('backfills', backfill)
  .supply(H.operator)
  .store(harnessStore)
  .handler(backfillFlow, { exits: { backfilled: Backfilled }, during: { batch: Backfilling } })
  .lease(unit => ({ resource: databases[unit.attributes.database], mode: 'shared' }));

const gpuHours = H.metric('gpu-hours', H.when.step(evalRuns, 'gpu')).amounts(event => [
  { group: 'gpu', amount: event.durationMs / 3_600_000 },
]);

const scheduler = H.scheduler('ml-platform')
  .priority(migrations, backfills, evalRuns)
  .wip(evalRuns, 2);

export const platformReport = (metrics: Metrics) => {
  const today: Window = { calendar: 'day' };
  return {
    gpuHoursToday: metrics.total(gpuHours, { window: today }),
    lockWaits: {
      orders: metrics.leases({ resource: databases.orders, window: today }),
      billing: metrics.leases({ resource: databases.billing, window: today }),
    },
  };
};

const supervisor = claudeCode.supervisor('ml-supervisor', {
  grants: [
    H.ops.workRead,
    H.ops.workCreate,
    H.ops.workCancel,
    H.ops.attemptsRecover,
    H.ops.blockersResolve,
    H.ops.telemetryRead,
  ],
});

export const mlPlatform = H.harness('ml-platform')
  .ledger(sqlite.ledger({ path: 'ml-platform.ledger.db' }))
  .lanes(evalRuns, migrations, backfills)
  .metrics(gpuHours)
  .scheduler(scheduler)
  .clients(supervisor)
  .observers(
    markdown.board({ path: 'docs/board.md' }),
    markdown.telemetry({ path: 'docs/telemetry.md' }),
  );
