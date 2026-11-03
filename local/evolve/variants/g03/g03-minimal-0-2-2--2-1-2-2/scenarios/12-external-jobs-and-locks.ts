import { z } from 'zod';
import { H } from 'harness-dsl';
import * as anthropic from 'harness-dsl/anthropic';
import * as sqlite from 'harness-dsl/sqlite';
import * as folder from 'harness-dsl/folder';
import * as shell from 'harness-dsl/shell';
import * as ssh from 'harness-dsl/ssh';
import * as claude from 'harness-dsl/claude-code';
import * as markdown from 'harness-dsl/markdown';

const api = anthropic.account('ml-api', { apiKey: H.env('ANTHROPIC_API_KEY') });
const strong = anthropic.model('claude-sonnet-4-5');
const pool = H.pool('ml-accounts', [{ account: api, share: 1 }]);
const local = shell.local('local', { slots: 4 });
const dbAdmin = ssh.host('db-admin', { address: 'db-admin.internal', user: 'deploy', key: H.env('DB_ADMIN_SSH_KEY'), slots: 4 });

const databaseNames = z.enum(['primary', 'analytics']);
const databases = { primary: H.resource('primary-db'), analytics: H.resource('analytics-db') };

const evalQueued = H.state('queued', 'pending');
const scored = H.state('scored', 'terminal', 'success');
const evalFailed = H.state('failed', 'terminal', 'failure');

const evalRun = H.kind('eval-run')
  .data(z.object({ model: z.string(), suite: z.string(), overall: z.number().optional(), summary: z.string().optional() }))
  .states(evalQueued, scored, evalFailed);

const prepare = H.command('prepare-eval')
  .input(z.object({ model: z.string(), suite: z.string() }))
  .output(z.object({ datasetUri: z.string() }))
  .argv(input => ['./bin/prepare-eval', input.model, input.suite])
  .on(local)
  .recovery('rerun');

const submitGpu = H.command('submit-gpu-eval')
  .input(z.object({ model: z.string(), datasetUri: z.string() }))
  .argv(input => ['gpuctl', 'submit', '--model', input.model, '--data', input.datasetUri])
  .on(local)
  .recovery('park');

const pollGpu = H.command('poll-gpu-eval')
  .input(z.string())
  .output(z.discriminatedUnion('status', [
    z.object({ status: z.literal('running') }),
    z.object({ status: z.literal('done'), result: z.object({ metricsUri: z.string() }) }),
    z.object({ status: z.literal('failed'), error: z.string() }),
  ]))
  .argv(jobId => ['gpuctl', 'status', '--json', jobId])
  .on(local);

const gpuEval = H.job('gpu-eval')
  .output(z.object({ metricsUri: z.string() }))
  .submit(submitGpu)
  .collect(pollGpu, { minutes: 10 });

const score = H.command('score-eval')
  .input(z.object({ metricsUri: z.string() }))
  .output(z.object({ overall: z.number(), report: z.string() }))
  .argv(input => ['./bin/score', input.metricsUri])
  .on(local)
  .recovery('rerun');

const summaryRole = H.role('eval-summarizer')
  .input(z.object({ model: z.string(), report: z.string() }))
  .output(z.object({ summary: z.string() }))
  .prompt(input => `Summarise the evaluation of ${input.model}:\n${input.report}`);

const summarizer = H.seat('eval-summarizer', summaryRole).model(strong);

const runEval = H.flow('run-eval').for(evalRun).does(async ctx => {
  const data = ctx.unit.data;
  const prepared = await ctx.run(prepare, { model: data.model, suite: data.suite });
  if (!prepared.ok) return ctx.fail(prepared.error);
  const job = await ctx.run(gpuEval, { model: data.model, datasetUri: prepared.value.datasetUri });
  if (!job.ok) return ctx.fail(job.error);
  const result = await ctx.run(score, { metricsUri: job.value.metricsUri });
  if (!result.ok) return ctx.fail(result.error);
  const summary = await ctx.run(summarizer, { model: data.model, report: result.value.report });
  if (!summary.ok) return ctx.fail(summary.error);
  await ctx.update({ overall: result.value.overall, summary: summary.value.summary });
  return 'scored';
});

const evalRuns = H.lane('eval-runs', evalRun)
  .handler(runEval)
  .retry({ times: 1, exhausted: 'failed' })
  .suppliers(H.operator)
  .store(sqlite.store(evalRun, './harness/evals.sqlite'))
  .wip(2);

const migrationQueued = H.state('queued', 'pending');
const blockedByPredecessor = H.state('blocked-by-predecessor', 'waiting');
const applied = H.state('applied', 'terminal', 'success');
const migrationFailed = H.state('failed', 'terminal', 'failure');

const migrationData = z.object({ id: z.string(), database: databaseNames, path: z.string() });

const migration = H.kind('migration')
  .data(migrationData)
  .states(migrationQueued, blockedByPredecessor, applied, migrationFailed);

const migrate = H.command('apply-migration')
  .input(z.object({ database: databaseNames, path: z.string() }))
  .argv(input => ['./bin/migrate', '--database', input.database, input.path])
  .on(dbAdmin)
  .recovery('park');

const applyMigration = H.flow('apply-migration').for(migration).does(async ctx => {
  const result = await ctx.run(migrate, { database: ctx.unit.data.database, path: ctx.unit.data.path });
  if (!result.ok) return ctx.fail(result.error);
  return 'applied';
});

const migrationFiles = folder.files(migration, {
  dir: './migrations',
  read: file => migrationData.parse({ id: file.frontmatter.id, database: file.frontmatter.database, path: file.path }),
  key: file => `migration-${String(file.frontmatter.id)}`,
});

const migrations = H.lane('migrations', migration)
  .handler(applyMigration)
  .retry({ times: 0, exhausted: 'failed' })
  .suppliers(migrationFiles)
  .store(migrationFiles)
  .locks(data => [{ resource: databases[data.database], mode: 'exclusive' }])
  .sequence(data => data.id, 'blocked-by-predecessor');

const backfillQueued = H.state('queued', 'pending');
const complete = H.state('complete', 'terminal', 'success');
const backfillFailed = H.state('failed', 'terminal', 'failure');

const backfill = H.kind('backfill')
  .data(z.object({ table: z.string(), database: databaseNames }))
  .states(backfillQueued, complete, backfillFailed);

const batchRows = 10000;

const countRows = H.command('count-backfill-rows')
  .input(z.object({ table: z.string(), database: databaseNames }))
  .output(z.object({ rows: z.number() }))
  .argv(input => ['./bin/count-rows', input.database, input.table])
  .on(dbAdmin);

const backfillBatch = H.command('backfill-batch')
  .input(z.object({ table: z.string(), database: databaseNames, offset: z.number(), limit: z.number() }))
  .argv(input => ['./bin/backfill', input.database, input.table, String(input.offset), String(input.limit)])
  .on(dbAdmin)
  .recovery('rerun')
  .retries(3, { first: { minutes: 1 }, factor: 2 });

const runBackfill = H.flow('run-backfill').for(backfill).does(async ctx => {
  const data = ctx.unit.data;
  const counted = await ctx.run(countRows, { table: data.table, database: data.database });
  if (!counted.ok) return ctx.fail(counted.error);
  for (let offset = 0; offset < counted.value.rows; offset += batchRows) {
    const batch = await ctx.run(backfillBatch, { table: data.table, database: data.database, offset, limit: batchRows });
    if (!batch.ok) return ctx.fail(batch.error);
  }
  return 'complete';
});

const backfills = H.lane('backfills', backfill)
  .handler(runBackfill)
  .retry({ times: 2, backoff: { first: { minutes: 5 }, factor: 2 }, exhausted: 'failed' })
  .suppliers(H.operator)
  .store(sqlite.store(backfill, './harness/backfills.sqlite'))
  .locks(data => [{ resource: databases[data.database], mode: 'shared' }]);

export const platformReports = H.policy.rule('platform-reports', (since: Date, metrics) => ({
  gpuJobMsToday: metrics.sum({ of: 'durationMs', among: { entry: 'invocation', mode: 'job', status: 'ended' }, days: 1 }),
  lockWaitMs: {
    primary: metrics.mean({ of: 'lockWaitMs', among: { entry: 'lease', status: 'acquired', resource: databases.primary }, since }),
    analytics: metrics.mean({ of: 'lockWaitMs', among: { entry: 'lease', status: 'acquired', resource: databases.analytics }, since }),
  },
}));

export const mlPlatform = H.harness('ml-platform')
  .ledger(sqlite.ledger('./harness/ml-ledger.sqlite'))
  .lanes(evalRuns, migrations, backfills)
  .pools(pool)
  .clients(claude.supervisor({
    grants: [
      H.ops.readWork, H.ops.writeWork, H.ops.readTelemetry,
      H.ops.resolve(H.halts.interrupted, H.halts.definitionChanged),
    ],
  }))
  .observers(markdown.board('./harness/BOARD.md'), markdown.telemetry('./harness/TELEMETRY.md'));
