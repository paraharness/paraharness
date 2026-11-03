import { H, type Metrics } from 'harness-dsl';
import * as anthropic from 'harness-dsl/anthropic';
import * as folder from 'harness-dsl/folder';
import * as sqlite from 'harness-dsl/sqlite';
import * as shell from 'harness-dsl/shell';
import * as ssh from 'harness-dsl/ssh';
import * as http from 'harness-dsl/http';
import * as markdown from 'harness-dsl/markdown';
import { z } from 'zod';

const account = anthropic.account('api', { apiKey: H.env('ANTHROPIC_API_KEY') });
const pool = H.pool('api-pool', [{ account, share: 1 }]);
const sonnet = anthropic.model('claude-sonnet');
const local = shell.local('local', { slots: 4 });
const dbHost = ssh.host('db-host', {
  address: 'db.internal',
  user: 'ops',
  key: H.env('DB_HOST_SSH_KEY'),
  slots: 4,
  preflight: ['df -h /var/lib/postgresql'],
});

const ordersDb = H.resource('orders-db');
const billingDb = H.resource('billing-db');
const databases = { orders: ordersDb, billing: billingDb };
const databaseName = z.enum(['orders', 'billing']);
const databaseOf = (value: unknown): z.infer<typeof databaseName> => value === 'billing' ? 'billing' : 'orders';

const evalQueued = H.state('eval-queued', 'pending');
const scored = H.state('scored', 'terminal', 'success');
const evalFailed = H.state('eval-failed', 'terminal', 'failure');
const evalRun = H.kind('eval-run')
  .data(z.object({ model: z.string(), suite: z.string() }))
  .states(evalQueued, scored, evalFailed);

const evalResult = z.object({ accuracy: z.number(), artifact: z.string() });
const prepare = H.command('prepare-eval')
  .input(z.object({ suite: z.string() }))
  .argv(input => ['./eval/prepare', input.suite])
  .on(local)
  .recovery('rerun');
const submitGpu = H.command('submit-gpu-eval')
  .input(z.object({ model: z.string(), suite: z.string() }))
  .argv(input => ['./eval/gpu', 'submit', input.model, input.suite])
  .on(local);
const pollGpu = H.command('poll-gpu-eval')
  .input(z.string())
  .output(z.union([
    z.object({ status: z.literal('running') }),
    z.object({ status: z.literal('done'), result: evalResult }),
    z.object({ status: z.literal('failed'), error: z.string() }),
  ]))
  .argv(jobId => ['./eval/gpu', 'status', jobId])
  .on(local);
const gpuEval = H.job('gpu-eval').output(evalResult).submit(submitGpu).collect(pollGpu, { minutes: 10 });
const score = H.command('score-eval')
  .input(evalResult)
  .output(z.object({ score: z.number() }))
  .argv(input => ['./eval/score', input.artifact, String(input.accuracy)])
  .on(local)
  .recovery('rerun');

const summarizerRole = H.role('eval-summarizer')
  .input(z.object({ model: z.string(), suite: z.string(), score: z.number(), platform: z.string() }))
  .output(z.object({ summary: z.string() }))
  .prompt(input => `Summarize the eval of ${input.model} on ${input.suite}: score ${input.score}. Platform load:\n${input.platform}`);
const summarizer = H.seat('eval-summarizer', summarizerRole).model(sonnet);

const platformLoad = H.policy.rule('platform-load', (now: Date, metrics: Metrics): string => {
  const gpu = metrics.sum({ of: 'durationMs', among: { entry: 'invocation', mode: 'job', executable: gpuEval, status: 'ended' }, days: 1 });
  const waits = [ordersDb, billingDb].map(resource => {
    const wait = metrics.mean({ of: 'lockWaitMs', among: { entry: 'lease', resource, status: 'acquired' }, days: 1 });
    return `${resource.name}: mean lock wait ${wait.value ?? 'n/a'} ms (n=${wait.samples})`;
  });
  return [`GPU job hours in the day to ${now.toISOString()}: ${((gpu.value ?? 0) / 3_600_000).toFixed(1)} (n=${gpu.samples})`, ...waits].join('\n');
});

const runEval = H.flow('run-eval').for(evalRun).does(async ctx => {
  const { model, suite } = ctx.unit.data;
  const prepared = await ctx.run(prepare, { suite });
  if (!prepared.ok) return ctx.fail(prepared.error);
  const result = await ctx.run(gpuEval, { model, suite });
  if (!result.ok) return ctx.fail(result.error);
  const graded = await ctx.run(score, result.value);
  if (!graded.ok) return ctx.fail(graded.error);
  const platform = await ctx.decide(platformLoad, ctx.now());
  const summary = await ctx.run(summarizer, { model, suite, score: graded.value.score, platform });
  return summary.ok ? 'scored' : ctx.fail(summary.error);
});

const migrationQueued = H.state('migration-queued', 'pending');
const blockedByEarlier = H.state('blocked-by-earlier', 'waiting');
const applied = H.state('applied', 'terminal', 'success');
const migrationFailed = H.state('migration-failed', 'terminal', 'failure');
const migration = H.kind('migration')
  .data(z.object({ sequence: z.number(), file: z.string(), database: databaseName }))
  .states(migrationQueued, blockedByEarlier, applied, migrationFailed);

const migrationFiles = folder.files(migration, {
  dir: './migrations',
  read: file => ({
    sequence: Number(file.path.match(/(\d+)/)?.[1] ?? 0),
    file: file.path,
    database: databaseOf(file.frontmatter['database']),
  }),
  key: file => file.path,
});
const applyMigration = H.command('apply-migration')
  .input(z.object({ file: z.string(), database: databaseName }))
  .argv(input => ['./db/migrate', input.database, input.file])
  .on(dbHost)
  .recovery('park');

const runMigration = H.flow('run-migration').for(migration).does(async ctx => {
  const result = await ctx.run(applyMigration, { file: ctx.unit.data.file, database: ctx.unit.data.database });
  return result.ok ? 'applied' : ctx.fail(result.error);
});

const backfillQueued = H.state('backfill-queued', 'pending');
const filled = H.state('filled', 'terminal', 'success');
const backfillFailed = H.state('backfill-failed', 'terminal', 'failure');
const backfill = H.kind('backfill')
  .data(z.object({ table: z.string(), database: databaseName }))
  .states(backfillQueued, filled, backfillFailed);

const batchRows = 10_000;
const backfillBatch = H.command('backfill-batch')
  .input(z.object({ table: z.string(), database: databaseName, offset: z.number(), limit: z.number() }))
  .output(z.object({ rows: z.number() }))
  .argv(input => ['./db/backfill', input.database, input.table, String(input.offset), String(input.limit)])
  .on(dbHost)
  .recovery('rerun')
  .retry(H.policy.retry('batch-retry', view => view.failures < 3 ? { retryInMs: 10_000 * 2 ** view.failures } : 'stop'));

const runBackfill = H.flow('run-backfill').for(backfill).does(async ctx => {
  const { table, database } = ctx.unit.data;
  for (let offset = 0; ; offset += batchRows) {
    const batch = await ctx.run(backfillBatch, { table, database, offset, limit: batchRows });
    if (!batch.ok) return ctx.fail(batch.error);
    if (batch.value.rows < batchRows) return 'filled';
  }
});

const unitsDb = './.harness/units.db';
const neverRetry = H.policy.retry('never-retry', () => 'stop');

const evals = H.lane('evals', evalRun)
  .handler(runEval)
  .suppliers(H.operator)
  .store(sqlite.store(evalRun, unitsDb))
  .wip(2);
const migrations = H.lane('migrations', migration)
  .handler(runMigration)
  .suppliers(migrationFiles)
  .store(migrationFiles)
  .locks(data => [{ resource: databases[data.database], mode: 'exclusive' }])
  .order(data => data.sequence, 'blocked-by-earlier')
  .retry(neverRetry, 'migration-failed');
const backfills = H.lane('backfills', backfill)
  .handler(runBackfill)
  .suppliers(H.operator)
  .store(sqlite.store(backfill, unitsDb))
  .locks(data => [{ resource: databases[data.database], mode: 'shared' }])
  .wip(4);

export const harness = H.harness('ml-platform')
  .ledger(sqlite.ledger('./.harness/ledger.db'))
  .lanes(evals, migrations, backfills)
  .pools(pool)
  .clients(http.control({
    port: 8450,
    token: H.env('CONTROL_TOKEN'),
    grants: [H.ops.readWork, H.ops.writeWork, H.ops.resolveHalts, H.ops.readTelemetry],
  }))
  .observers(markdown.board('./BOARD.md'), markdown.telemetry('./TELEMETRY.md'));
