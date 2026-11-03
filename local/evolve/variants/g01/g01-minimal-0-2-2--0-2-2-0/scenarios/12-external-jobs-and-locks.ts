import { H } from 'harness-dsl';
import { z } from 'zod';
import * as anthropic from 'harness-dsl/anthropic';
import * as folder from 'harness-dsl/folder';
import * as sqlite from 'harness-dsl/sqlite';
import * as shell from 'harness-dsl/shell';
import * as http from 'harness-dsl/http';
import * as markdown from 'harness-dsl/markdown';

const apiAccount = anthropic.account('api', { apiKey: H.env('ANTHROPIC_API_KEY') });
const sonnet = anthropic.model('claude-sonnet-4-5');
const apiPool = H.pool('api', [{ account: apiAccount, share: 1 }]);
const localRunner = shell.local('local', { slots: 4 });

const queued = H.state('queued', 'pending');
const held = H.state('held', 'waiting');
const succeeded = H.state('succeeded', 'terminal', 'success');
const failed = H.state('failed', 'terminal', 'failure');

const evalRun = H.kind('EvalRun').data(z.object({ name: z.string(), config: z.string() })).states(queued, succeeded, failed);

const databaseNames = z.enum(['orders', 'users']);
const ordersDb = H.resource('orders-db');
const usersDb = H.resource('users-db');
const databases = { orders: ordersDb, users: usersDb };

const migration = H.kind('Migration')
  .data(z.object({ id: z.string(), file: z.string(), database: databaseNames }))
  .states(queued, held, succeeded, failed);

const backfill = H.kind('Backfill')
  .data(z.object({ table: z.string(), database: databaseNames, rows: z.number() }))
  .states(queued, succeeded, failed);

const prepareEval = H.command('prepare-eval')
  .input(z.object({ name: z.string(), config: z.string() }))
  .argv(input => ['./eval/prepare', input.name, input.config])
  .on(localRunner)
  .recovery('rerun');

const evalResult = z.object({ outputs: z.string(), gpuHours: z.number() });
type EvalResult = z.infer<typeof evalResult>;

const pollEval = H.command('poll-eval')
  .input(z.string())
  .output(
    z.union([
      z.object({ status: z.literal('running') }),
      z.object({ status: z.literal('done'), result: evalResult }),
      z.object({ status: z.literal('failed'), error: z.string() })
    ])
  )
  .argv(handle => ['./eval/status', '--json', handle])
  .on(localRunner)
  .recovery('rerun');

const gpuEval = H.command('submit-eval')
  .input(z.object({ name: z.string(), prepared: z.string() }))
  .argv(input => ['./eval/submit', input.name, input.prepared])
  .on(localRunner)
  .recovery('park')
  .collect<EvalResult>(pollEval, { minutes: 10 });

const scoreEval = H.command('score-eval')
  .input(z.object({ outputs: z.string() }))
  .argv(input => ['./eval/score', input.outputs])
  .on(localRunner)
  .recovery('rerun');

const summaryRole = H.role('eval-summarizer')
  .input(z.object({ name: z.string(), scores: z.string() }))
  .output(z.object({ summary: z.string() }))
  .prompt(input => `Summarise the evaluation ${input.name}. Scores:\n${input.scores}`);

const evalSummarizer = H.seat('eval-summarizer', summaryRole).model(sonnet);

const runEval = H.flow('run-eval')
  .for(evalRun)
  .does(async ctx => {
    const prepared = await ctx.run(prepareEval, { name: ctx.unit.data.name, config: ctx.unit.data.config });
    if (!prepared.ok) return ctx.fail(prepared.error);
    const job = await ctx.run(gpuEval, { name: ctx.unit.data.name, prepared: prepared.value });
    if (!job.ok) return ctx.fail(job.error);
    const scored = await ctx.run(scoreEval, { outputs: job.value.outputs });
    if (!scored.ok) return ctx.fail(scored.error);
    const summary = await ctx.run(evalSummarizer, { name: ctx.unit.data.name, scores: scored.value });
    if (!summary.ok) return ctx.fail(summary.error);
    return 'succeeded';
  });

const applyMigration = H.command('apply-migration')
  .input(z.object({ file: z.string(), database: databaseNames }))
  .argv(input => ['./db/migrate', input.database, input.file])
  .on(localRunner)
  .recovery('park');

const runMigration = H.flow('run-migration')
  .for(migration)
  .does(async ctx => {
    const applied = await ctx.run(applyMigration, { file: ctx.unit.data.file, database: ctx.unit.data.database });
    if (!applied.ok) return ctx.fail(applied.error);
    return 'succeeded';
  });

const batchRows = 10_000;

const backfillBatch = H.command('backfill-batch')
  .input(z.object({ table: z.string(), database: databaseNames, offset: z.number(), limit: z.number() }))
  .argv(input => ['./db/backfill', input.database, input.table, String(input.offset), String(input.limit)])
  .on(localRunner)
  .recovery('rerun');

const runBackfill = H.flow('run-backfill')
  .for(backfill)
  .does(async ctx => {
    for (let offset = 0; offset < ctx.unit.data.rows; offset += batchRows) {
      const batch = await ctx.run(backfillBatch, {
        table: ctx.unit.data.table,
        database: ctx.unit.data.database,
        offset,
        limit: batchRows
      });
      if (!batch.ok) return ctx.fail(batch.error);
    }
    return 'succeeded';
  });

const frontmatterDatabase = databaseNames.catch('orders');

const migrationFolder = folder.files(migration, {
  dir: 'migrations',
  read: file => ({
    id: file.path.replace(/^.*\//, '').slice(0, 4),
    file: file.path,
    database: frontmatterDatabase.parse(file.frontmatter.database)
  }),
  key: file => file.path
});

const evalLane = H.lane('evals', evalRun)
  .handler(runEval)
  .suppliers(H.operator)
  .store(sqlite.store(evalRun, '.harness/evals.db'))
  .wip(2);

const migrationLane = H.lane('migrations', migration)
  .handler(runMigration)
  .suppliers(migrationFolder)
  .store(sqlite.store(migration, '.harness/migrations.db'))
  .locks(data => [{ resource: databases[data.database], mode: 'exclusive' }])
  .ordered(data => data.id, 'held')
  .retry('never', 'failed');

const backfillLane = H.lane('backfills', backfill)
  .handler(runBackfill)
  .suppliers(H.operator)
  .store(sqlite.store(backfill, '.harness/backfills.db'))
  .locks(data => [{ resource: databases[data.database], mode: 'shared' }]);

export const gpuHoursInFlight = H.policy.rule('gpu-hours-in-flight-per-day', (query: { days: number }, metrics) => {
  const inFlight = metrics.sum({ of: 'durationMs', days: query.days, among: { entry: 'invocation', executable: gpuEval, mode: 'job', status: 'ended' } });
  return { hoursPerDay: inFlight.value === null ? null : inFlight.value / 3_600_000 / query.days, samples: inFlight.samples };
});

export const lockWait = H.policy.rule('lock-wait-per-database', (query: { days: number }, metrics) => ({
  orders: metrics.mean({ of: 'lockWaitMs', days: query.days, among: { entry: 'lease', status: 'acquired', resource: ordersDb } }),
  users: metrics.mean({ of: 'lockWaitMs', days: query.days, among: { entry: 'lease', status: 'acquired', resource: usersDb } })
}));

export const harness = H.harness('ml-platform')
  .ledger(sqlite.ledger('.harness/ledger.db'))
  .lanes(evalLane, migrationLane, backfillLane)
  .pools(apiPool)
  .clients(
    http.control({
      port: 7430,
      token: H.env('CONTROL_TOKEN'),
      grants: [H.ops.readWork, H.ops.writeWork, H.ops.resolveHalts, H.ops.readTelemetry]
    })
  )
  .observers(markdown.board('BOARD.md'), markdown.telemetry('TELEMETRY.md'));
