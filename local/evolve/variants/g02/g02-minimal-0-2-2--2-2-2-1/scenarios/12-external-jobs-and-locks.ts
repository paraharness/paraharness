import { z } from 'zod';
import { H } from 'harness-dsl';
import * as cc from 'harness-dsl/claude-code';
import * as anthropic from 'harness-dsl/anthropic';
import * as sqlite from 'harness-dsl/sqlite';
import * as folder from 'harness-dsl/folder';
import * as shell from 'harness-dsl/shell';
import * as ssh from 'harness-dsl/ssh';
import * as markdown from 'harness-dsl/markdown';

const local = shell.local('local', { slots: 4 });
const dbAdmin = ssh.host('db-admin', {
  address: 'db-admin.internal',
  user: 'ops',
  key: H.env('DB_ADMIN_SSH_KEY'),
  slots: 4,
});
const apiAccount = anthropic.account('anthropic-api', { apiKey: H.env('ANTHROPIC_API_KEY') });
const sonnet = anthropic.model('claude-sonnet-4-5');
const store = 'ml/.harness/store.sqlite';

const ordersDb = H.resource('orders-db');
const billingDb = H.resource('billing-db');
const databases = { orders: ordersDb, billing: billingDb };
const databaseName = z.enum(['orders', 'billing']);

const queued = H.state('queued', 'pending');
const scored = H.state('scored', 'terminal', 'success');
const evalFailed = H.state('failed', 'terminal', 'failure');

const evalRun = H.kind('eval-run')
  .data(z.object({
    model: z.string(),
    suite: z.string(),
    score: z.number().optional(),
    summary: z.string().optional(),
  }))
  .states(queued, scored, evalFailed);

const prepareEval = H.command('prepare-eval')
  .input(z.object({ model: z.string(), suite: z.string() }))
  .output(z.object({ bundle: z.string() }))
  .argv(i => ['./eval/prepare.sh', i.model, i.suite])
  .on(local);

const gpuResult = z.object({ resultsUri: z.string() });
const submitGpuEval = H.command('submit-gpu-eval')
  .input(z.object({ bundle: z.string() }))
  .argv(i => ['gpu', 'jobs', 'submit', i.bundle])
  .on(local);
const pollGpuEval = H.command('poll-gpu-eval')
  .input(z.string())
  .output(z.discriminatedUnion('status', [
    z.object({ status: z.literal('running') }),
    z.object({ status: z.literal('done'), result: gpuResult }),
    z.object({ status: z.literal('failed'), error: z.string() }),
  ]))
  .argv(handle => ['gpu', 'jobs', 'status', handle])
  .on(local);
const gpuEval = H.job('gpu-eval').output(gpuResult).submit(submitGpuEval).collect(pollGpuEval, { minutes: 10 });

const scoreEval = H.command('score-eval')
  .input(gpuResult)
  .output(z.object({ score: z.number() }))
  .argv(i => ['./eval/score.sh', i.resultsUri])
  .on(local);

const evalSummarizerRole = H.role('eval-summarizer')
  .input(z.object({ model: z.string(), suite: z.string(), score: z.number() }))
  .output(z.object({ summary: z.string() }))
  .prompt(i => `Summarize the ${i.suite} evaluation of ${i.model}: score ${i.score}.`);
const evalSummarizer = H.seat('eval-summarizer', evalSummarizerRole).model(sonnet);

const runEval = H.flow('run-eval').for(evalRun).does(async ctx => {
  const { model, suite } = ctx.unit.data;
  const prepared = await ctx.call(prepareEval, { model, suite });
  if (!prepared.ok) return ctx.fail(prepared.error);
  const job = await ctx.call(gpuEval, { bundle: prepared.value.bundle });
  if (!job.ok) return ctx.fail(job.error);
  const result = await ctx.call(scoreEval, job.value);
  if (!result.ok) return ctx.fail(result.error);
  const summary = await ctx.call(evalSummarizer, { model, suite, score: result.value.score });
  if (!summary.ok) return ctx.fail(summary.error);
  await ctx.update({ score: result.value.score, summary: summary.value.summary });
  return 'scored';
});

const evalRuns = H.lane('eval-runs', evalRun)
  .handler(runEval)
  .suppliers(H.operator)
  .store(sqlite.store(evalRun, store))
  .wip(2)
  .retry(H.retry('eval-one-retry', { retries: 1, backoff: { initialMs: 600_000 } }), 'failed');

const migrationQueued = H.state('queued', 'pending');
const migrationBlocked = H.state('blocked', 'waiting');
const applied = H.state('applied', 'terminal', 'success');
const migrationFailed = H.state('failed', 'terminal', 'failure');

const migrationData = z.object({ sequence: z.number(), database: databaseName, file: z.string() });
const migration = H.kind('migration').data(migrationData).states(migrationQueued, migrationBlocked, applied, migrationFailed);

const migrationFolder = folder.files(migration, {
  dir: 'migrations',
  read: file => migrationData.parse({
    sequence: Number(file.frontmatter.sequence),
    database: file.frontmatter.database,
    file: file.path,
  }),
  key: file => file.path,
});

const applyMigration = H.command('apply-migration')
  .input(z.object({ database: databaseName, file: z.string() }))
  .argv(i => ['./db/migrate.sh', i.database, i.file])
  .on(dbAdmin)
  .locks(i => [{ resource: databases[i.database], mode: 'exclusive' }])
  .recovery('park');

const runMigration = H.flow('run-migration').for(migration).does(async ctx => {
  const migrated = await ctx.call(applyMigration, { database: ctx.unit.data.database, file: ctx.unit.data.file });
  return migrated.ok ? 'applied' : ctx.fail(migrated.error);
});

const migrations = H.lane('migrations', migration)
  .handler(runMigration)
  .suppliers(migrationFolder)
  .store(migrationFolder)
  .order(d => d.sequence, 'blocked')
  .retry(H.retry('migration-never-retry', { retries: 0 }), 'failed');

const backfillQueued = H.state('queued', 'pending');
const backfilled = H.state('done', 'terminal', 'success');
const backfillFailed = H.state('failed', 'terminal', 'failure');

const tableRef = z.object({ table: z.string(), database: databaseName });
const backfill = H.kind('backfill').data(tableRef).states(backfillQueued, backfilled, backfillFailed);

const countRows = H.command('count-rows')
  .input(tableRef)
  .output(z.object({ rows: z.number() }))
  .argv(i => ['./db/count.sh', i.database, i.table])
  .on(dbAdmin);

const backfillBatch = H.command('backfill-batch')
  .input(tableRef.extend({ offset: z.number(), limit: z.number() }))
  .argv(i => ['./db/backfill.sh', i.database, i.table, String(i.offset), String(i.limit)])
  .on(dbAdmin)
  .locks(i => [{ resource: databases[i.database], mode: 'shared' }])
  .recovery('rerun');

const batchRows = 10_000;

const runBackfill = H.flow('run-backfill').for(backfill).does(async ctx => {
  const counted = await ctx.call(countRows, ctx.unit.data);
  if (!counted.ok) return ctx.fail(counted.error);
  for (let offset = 0; offset < counted.value.rows; offset += batchRows) {
    const batch = await ctx.call(backfillBatch, { ...ctx.unit.data, offset, limit: batchRows });
    if (!batch.ok) return ctx.fail(batch.error);
  }
  return 'done';
});

const backfills = H.lane('backfills', backfill)
  .handler(runBackfill)
  .suppliers(H.operator)
  .store(sqlite.store(backfill, store))
  .wip(2)
  .retry(H.retry('backfill-two-retries', { retries: 2, backoff: { initialMs: 120_000, factor: 2 } }), 'failed');

const platformLoad = H.report('platform-load', m => {
  const inFlight = m.sum({
    of: 'durationMs',
    among: { entry: 'invocation', executable: gpuEval, status: 'ended' },
    days: 1,
  });
  return {
    gpuJobHoursLastDay: { value: inFlight.value === null ? null : inFlight.value / 3_600_000, samples: inFlight.samples },
    medianLockWaitMsByDatabase: m.medianBy({
      of: 'lockWaitMs',
      among: { entry: 'lease', status: 'acquired' },
      by: 'resource',
      days: 1,
    }),
  };
});

export const mlPlatform = H.harness('ml-platform')
  .ledger(sqlite.ledger('ml/.harness/ledger.sqlite'))
  .lanes(evalRuns, migrations, backfills)
  .pools(H.pool('api', [{ account: apiAccount, share: 1 }]))
  .reports(platformLoad)
  .clients(cc.supervisor({
    grants: [H.ops.readWork, H.ops.writeWork, H.ops.resolve(H.parked), H.ops.readTelemetry],
  }))
  .observers(markdown.board('ml/BOARD.md'), markdown.telemetry('ml/TELEMETRY.md'));
