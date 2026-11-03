import { z } from 'zod';
import { H } from 'harness-dsl';
import { sqlite } from 'harness-dsl/sqlite';
import { anthropic } from 'harness-dsl/anthropic';
import { claudeCode } from 'harness-dsl/claude-code';
import { folder } from 'harness-dsl/folder';
import { local } from 'harness-dsl/local';
import { ssh } from 'harness-dsl/ssh';
import { markdown } from 'harness-dsl/markdown';

const quota = sqlite.quota('ml-quota', { path: './.harness/quota.sqlite' });
const apiAccount = anthropic.account('api', { apiKey: H.env('ANTHROPIC_API_KEY'), quota });
const sonnet = anthropic.model('sonnet', { id: 'claude-sonnet-4-5' });
const pool = H.pool('ml-pool').accounts(apiAccount);

const runner = local.runner('local').slots(4);
const dbOps = ssh.host('db-ops', { host: 'db-ops.internal', user: 'ops', key: H.env('DB_OPS_SSH_KEY') }).slots(4);
const harnessStore = sqlite.store({ path: './.harness/units.sqlite' });

const databaseName = z.enum(['orders', 'billing']);
const databases = {
  orders: H.resource('orders-db'),
  billing: H.resource('billing-db'),
};

const evalAttrs = z.object({ name: z.string(), model: z.string(), suite: z.string() });

const evalQueued = H.state('Queued', 'pending');
const evalScored = H.terminal('Scored', 'success');
const evalFailed = H.terminal('Failed', 'failure');
const evalDropped = H.terminal('Dropped', 'neutral');

const evalRun = H.kind('EvalRun')
  .attributes(evalAttrs)
  .states(evalQueued, evalScored, evalFailed, evalDropped)
  .key(a => a.name)
  .initial(evalQueued);

const prepare = H.command('prepare-eval')
  .input(z.object({ model: z.string(), suite: z.string() }))
  .argv(input => ['evals', 'prepare', input.model, input.suite])
  .output(z.object({ checkpoint: z.string() }))
  .runner(runner);

const submitGpu = H.command('submit-gpu-eval')
  .input(z.object({ checkpoint: z.string(), suite: z.string() }))
  .argv(input => ['gpu-jobs', 'submit', input.checkpoint, input.suite])
  .output(z.object({ jobId: z.string() }))
  .runner(runner);

const collectGpu = H.command('collect-gpu-eval')
  .input(z.object({ jobId: z.string() }))
  .argv(input => ['gpu-jobs', 'status', input.jobId])
  .output(H.jobPoll(z.object({ resultsPath: z.string() })))
  .runner(runner);

const gpuEval = H.job('gpu-eval', { submit: submitGpu, collect: collectGpu, pollEveryMinutes: 10 });

const score = H.command('score-eval')
  .input(z.object({ resultsPath: z.string() }))
  .argv(input => ['evals', 'score', input.resultsPath])
  .output(z.object({ score: z.number(), report: z.string() }))
  .runner(runner);

const analystRole = H.role('eval-analyst').intents('read').instructions('Summarise the evaluation scores for the model owners.');
const analystSeat = H.seat('eval-analyst').role(analystRole).model(sonnet).pool(pool);

const evalFlow = H.flow('eval-run')
  .input(evalAttrs)
  .step('prepare', prepare, ctx => ({ model: ctx.unit.attributes.model, suite: ctx.unit.attributes.suite }), { afterCrash: 'rerun' })
  .job('gpu', gpuEval, ctx => ({ checkpoint: ctx.steps.prepare.checkpoint, suite: ctx.unit.attributes.suite }))
  .step('score', score, ctx => ({ resultsPath: ctx.steps.gpu.resultsPath }), { afterCrash: 'rerun' })
  .step('summarize', analystSeat, ctx => ({ task: `Summarise ${ctx.unit.attributes.name}: score ${ctx.steps.score.score}\n${ctx.steps.score.report}` }))
  .exit('scored');

const evals = H.lane('evals', evalRun)
  .supply(H.operator)
  .handler(evalFlow, { exits: { scored: evalScored } })
  .store(harnessStore)
  .retry({ maxAttempts: 2, backoff: 'exponential', initialDelayMs: 600000, exhausted: evalFailed })
  .on(H.cancel, { enter: evalDropped });

const migrationAttrs = z.object({ database: databaseName, sequence: z.number(), path: z.string() });

const migrationQueued = H.state('Queued', 'pending');
const heldByPredecessor = H.state('HeldByPredecessor', 'waiting');
const migrationApplied = H.terminal('Applied', 'success');
const migrationFailed = H.terminal('Failed', 'failure');
const migrationDropped = H.terminal('Dropped', 'neutral');

const migrationKey = (database: string, sequence: number): string => `${database}-${String(sequence).padStart(4, '0')}`;

const migration = H.kind('Migration')
  .attributes(migrationAttrs)
  .states(migrationQueued, heldByPredecessor, migrationApplied, migrationFailed, migrationDropped)
  .key(a => migrationKey(a.database, a.sequence))
  .initial(migrationQueued);

const applyMigration = H.command('apply-migration')
  .input(z.object({ database: z.string(), path: z.string() }))
  .argv(input => ['migrate', '--database', input.database, input.path])
  .runner(dbOps);

const migrationFlow = H.flow('migration')
  .input(migrationAttrs)
  .step('apply', applyMigration, ctx => ({ database: ctx.unit.attributes.database, path: ctx.unit.attributes.path }), { afterCrash: 'park' })
  .exit('applied');

const migrations = H.lane('migrations', migration)
  .supply(folder.files({ path: './migrations', glob: '*/*.sql' }), (file, to) => {
    const match = /([a-z]+)\/(\d{4})-[^/]+\.sql$/.exec(file.path);
    if (match === null) return to.skip();
    const database = databaseName.safeParse(match[1]);
    if (!database.success) return to.skip();
    return to.create({ database: database.data, sequence: Number(match[2]), path: file.path });
  })
  .handler(migrationFlow, { exits: { applied: migrationApplied } })
  .store(harnessStore)
  .retry({ maxAttempts: 1, exhausted: migrationFailed })
  .lease(unit => ({ resource: databases[unit.attributes.database], mode: 'exclusive' }))
  .after({
    key: a => (a.sequence > 1 ? migrationKey(a.database, a.sequence - 1) : undefined),
    onPredecessorFailed: heldByPredecessor,
  })
  .on(H.cancel, { enter: migrationDropped });

const backfillAttrs = z.object({ database: databaseName, table: z.string(), totalRows: z.number() });

const backfillQueued = H.state('Queued', 'pending');
const backfillDone = H.terminal('Done', 'success');
const backfillFailed = H.terminal('Failed', 'failure');
const backfillDropped = H.terminal('Dropped', 'neutral');

const backfill = H.kind('Backfill')
  .attributes(backfillAttrs)
  .states(backfillQueued, backfillDone, backfillFailed, backfillDropped)
  .key(a => `${a.database}.${a.table}`)
  .initial(backfillQueued);

const backfillBatch = H.command('backfill-batch')
  .input(z.object({ database: z.string(), table: z.string(), offset: z.number(), limit: z.number() }))
  .argv(input => ['backfill', input.database, input.table, `--offset=${input.offset}`, `--limit=${input.limit}`])
  .output(z.object({ rowsWritten: z.number() }))
  .runner(dbOps);

const batchRows = 10000;

const backfillFlow = H.flow('backfill')
  .input(backfillAttrs)
  .loop(
    'batches',
    flow => flow.step('batch', backfillBatch, ctx => ({
      database: ctx.unit.attributes.database,
      table: ctx.unit.attributes.table,
      offset: ctx.iteration * batchRows,
      limit: batchRows,
    }), { afterCrash: 'rerun', retry: { maxAttempts: 3, backoff: 'exponential', initialDelayMs: 5000 } }),
    {
      max: ctx => Math.ceil(ctx.unit.attributes.totalRows / batchRows),
      until: ctx => ctx.steps.batch.rowsWritten < batchRows,
    },
  )
  .exit('done');

const backfills = H.lane('backfills', backfill)
  .supply(H.operator)
  .handler(backfillFlow, { exits: { done: backfillDone } })
  .store(harnessStore)
  .retry({ maxAttempts: 2, backoff: 'exponential', initialDelayMs: 60000, exhausted: backfillFailed })
  .lease(unit => ({ resource: databases[unit.attributes.database], mode: 'shared' }))
  .on(H.cancel, { enter: backfillDropped });

const gpuHours = H.metric('gpu-hours-in-flight', H.when.step(evals, 'gpu')).amounts(event => [
  { amount: event.durationMs / 3600000 },
]);

const supervisor = claudeCode.supervisor('ml-supervisor', {
  port: H.slot.port(1),
  grants: [
    H.ops.workRead,
    H.ops.workCreate,
    H.ops.workCancel,
    H.ops.attemptsRecover,
    H.ops.telemetryRead,
  ],
});

export const harness = H.harness('ml-platform')
  .ledger(sqlite.ledger({ path: './.harness/ledger.sqlite' }))
  .lanes(evals, migrations, backfills)
  .metrics(gpuHours)
  .scheduler(
    H.scheduler('ml-scheduler')
      .standard(migrations, backfills, evals)
      .wip(evals, 2)
      .wip(backfills, 4)
      .admit(evals, ctx => ctx.metrics.total(gpuHours, { window: { calendar: 'day' } }).total < 200),
  )
  .clients(supervisor)
  .observers(
    markdown.board({ path: './.harness/board.md' }),
    markdown.telemetry({ path: './.harness/telemetry.md' }),
  );
