import { z } from 'zod';
import { H } from 'harness-dsl';
import type { Mean } from 'harness-dsl';
import * as anthropic from 'harness-dsl/anthropic';
import * as claudeCode from 'harness-dsl/claude-code';
import * as folder from 'harness-dsl/folder';
import * as sqlite from 'harness-dsl/sqlite';
import * as shell from 'harness-dsl/shell';
import * as markdown from 'harness-dsl/markdown';

const apiAccount = anthropic.account('ml-api', { apiKey: H.env('ANTHROPIC_API_KEY') });
const sonnet = anthropic.model('claude-sonnet-4-5');
const runner = shell.local('ml-shell', { slots: 6 });

const databaseSchema = z.enum(['orders', 'billing', 'analytics']);
const databases = {
  orders: H.resource('orders-db'),
  billing: H.resource('billing-db'),
  analytics: H.resource('analytics-db'),
};

const evalQueued = H.state('eval-queued', 'pending');
const evalScored = H.state('eval-scored', 'terminal', 'success');
const evalAbandoned = H.state('eval-abandoned', 'terminal', 'failure');

const evalRun = H.kind('eval-run')
  .data(z.object({ checkpoint: z.string(), suite: z.string() }))
  .states(evalQueued, evalScored, evalAbandoned);

const prepareEval = H.command('prepare-eval')
  .input(z.object({ checkpoint: z.string(), suite: z.string() }))
  .output(z.object({ bundle: z.string() }))
  .argv(input => ['evals', 'prepare', input.checkpoint, input.suite])
  .on(runner)
  .recovery('rerun');

const submitGpuJob = H.command('submit-gpu-job')
  .input(z.object({ bundle: z.string() }))
  .argv(input => ['gpu', 'submit', input.bundle])
  .on(runner)
  .recovery('park');

const evalResult = z.object({ accuracy: z.number(), gpuHours: z.number() });

const pollGpuJob = H.command('poll-gpu-job')
  .input(z.string())
  .output(z.discriminatedUnion('status', [
    z.object({ status: z.literal('running') }),
    z.object({ status: z.literal('done'), result: evalResult }),
    z.object({ status: z.literal('failed'), error: z.string() }),
  ]))
  .argv(jobId => ['gpu', 'status', jobId])
  .on(runner)
  .recovery('rerun');

const gpuEval = H.job('gpu-eval').output(evalResult).submit(submitGpuJob).collect(pollGpuJob, { minutes: 10 });

const scoreEval = H.command('score-eval')
  .input(z.object({ suite: z.string(), accuracy: z.number() }))
  .output(z.object({ score: z.number() }))
  .argv(input => ['evals', 'score', input.suite, String(input.accuracy)])
  .on(runner)
  .recovery('rerun');

const evalSummaryRole = H.role('eval-summary')
  .input(z.object({ checkpoint: z.string(), suite: z.string(), score: z.number() }))
  .output(z.object({ summary: z.string() }))
  .prompt(input => `Summarise eval of ${input.checkpoint} on ${input.suite}: score ${input.score}.`);

const evalSummarizer = H.seat('eval-summarizer', evalSummaryRole).model(sonnet);

const evalFlow = H.flow('eval-flow')
  .for(evalRun)
  .does(async ctx => {
    const data = ctx.unit.data;
    const prepared = await ctx.run(prepareEval, { checkpoint: data.checkpoint, suite: data.suite });
    if (!prepared.ok) return ctx.fail(prepared.error);
    const evaluated = await ctx.run(gpuEval, { bundle: prepared.value.bundle });
    if (!evaluated.ok) return ctx.fail(evaluated.error);
    const scored = await ctx.run(scoreEval, { suite: data.suite, accuracy: evaluated.value.accuracy });
    if (!scored.ok) return ctx.fail(scored.error);
    const summary = await ctx.run(evalSummarizer, { checkpoint: data.checkpoint, suite: data.suite, score: scored.value.score });
    if (!summary.ok) return ctx.fail(summary.error);
    return 'eval-scored';
  });

const evalRuns = H.lane('eval-runs', evalRun)
  .handler(evalFlow)
  .suppliers(H.operator)
  .store(sqlite.store(evalRun, '/srv/ml/evals.sqlite'))
  .wip(2);

const migrationQueued = H.state('migration-queued', 'pending');
const migrationBlocked = H.state('migration-blocked', 'waiting');
const migrationApplied = H.state('migration-applied', 'terminal', 'success');
const migrationFailed = H.state('migration-failed', 'terminal', 'failure');

const migration = H.kind('migration')
  .data(z.object({ sequence: z.number(), database: databaseSchema, path: z.string() }))
  .states(migrationQueued, migrationBlocked, migrationApplied, migrationFailed);

const migrationFrontmatter = z.object({ sequence: z.number(), database: databaseSchema });

const migrationFolder = folder.files(migration, {
  dir: '/srv/ml/migrations',
  read: file => ({ ...migrationFrontmatter.parse(file.frontmatter), path: file.path }),
  key: file => file.path,
});

const applyMigration = H.command('apply-migration')
  .input(z.object({ database: databaseSchema, path: z.string() }))
  .argv(input => ['migrate', '--database', input.database, '--file', input.path])
  .on(runner)
  .locks(input => [{ resource: databases[input.database], mode: 'exclusive' }])
  .recovery('park');

const migrationFlow = H.flow('migration-flow')
  .for(migration)
  .does(async ctx => {
    const applied = await ctx.run(applyMigration, { database: ctx.unit.data.database, path: ctx.unit.data.path });
    if (!applied.ok) return ctx.fail(applied.error);
    return 'migration-applied';
  });

const migrationAllowance = H.allowance('migration-allowance', migration)
  .retry(H.policy.retry('migration-single-try', { retries: 0, firstDelayMs: 0 }), 'migration-failed');

const migrations = H.lane('migrations', migration)
  .handler(migrationFlow)
  .suppliers(migrationFolder)
  .store(migrationFolder)
  .wip(3)
  .order(data => data.sequence, 'migration-blocked')
  .allowance(migrationAllowance);

const backfillQueued = H.state('backfill-queued', 'pending');
const backfillDone = H.state('backfill-done', 'terminal', 'success');
const backfillAbandoned = H.state('backfill-abandoned', 'terminal', 'failure');

const backfill = H.kind('backfill')
  .data(z.object({ table: z.string(), database: databaseSchema }))
  .states(backfillQueued, backfillDone, backfillAbandoned);

const batchRows = 10_000;

const countRows = H.command('count-rows')
  .input(z.object({ table: z.string(), database: databaseSchema }))
  .output(z.object({ rows: z.number() }))
  .argv(input => ['db', 'count', '--database', input.database, '--table', input.table])
  .on(runner)
  .recovery('rerun');

const backfillBatch = H.command('backfill-batch')
  .input(z.object({ table: z.string(), database: databaseSchema, offset: z.number(), limit: z.number() }))
  .argv(input => [
    'db', 'backfill', '--database', input.database, '--table', input.table,
    '--offset', String(input.offset), '--limit', String(input.limit),
  ])
  .on(runner)
  .locks(input => [{ resource: databases[input.database], mode: 'shared' }])
  .retry(H.policy.retry('backfill-batch-retry', { retries: 3, firstDelayMs: 5_000, factor: 2 }))
  .recovery('rerun');

const backfillFlow = H.flow('backfill-flow')
  .for(backfill)
  .does(async ctx => {
    const target = { table: ctx.unit.data.table, database: ctx.unit.data.database };
    const counted = await ctx.run(countRows, target);
    if (!counted.ok) return ctx.fail(counted.error);
    for (let offset = 0; offset < counted.value.rows; offset += batchRows) {
      const batch = await ctx.run(backfillBatch, { ...target, offset, limit: batchRows });
      if (!batch.ok) return ctx.fail(batch.error);
    }
    return 'backfill-done';
  });

const backfills = H.lane('backfills', backfill)
  .handler(backfillFlow)
  .suppliers(H.operator)
  .store(sqlite.store(backfill, '/srv/ml/backfills.sqlite'))
  .wip(4);

const platformTelemetry = H.report('platform-telemetry', () => {
  return {};
});

const mlTelemetry = H.report('ml-telemetry', metrics => {
  const lockWaits: Record<string, Mean> = {};
  for (const resource of [databases.orders, databases.billing, databases.analytics]) {
    lockWaits[`lock-wait-ms/${resource.name}`] = metrics.mean({
      of: 'lockWaitMs',
      among: { entry: 'lease', resource, status: 'acquired' },
      days: 1,
    });
  }
  return {
    ...lockWaits,
    gpuJobMsInFlightToday: metrics.sum({
      of: 'durationMs',
      among: { entry: 'invocation', executable: gpuEval, mode: 'job', status: 'ended' },
      days: 1,
    }),
  };
});

export const mlHarness = H.harness('ml-platform')
  .ledger(sqlite.ledger('/srv/ml/ledger.sqlite'))
  .lanes(evalRuns, migrations, backfills)
  .pools(H.pool('ml-pool', [{ account: apiAccount, share: 1 }]))
  .reports(mlTelemetry)
  .clients(
    claudeCode.supervisor({
      grants: [
        H.ops.readWork,
        H.ops.writeWork,
        H.ops.resolve(H.halts.changed, H.halts.interrupted),
        H.ops.readTelemetry,
      ],
    })
  )
  .observers(markdown.board('/srv/ml/BOARD.md'), markdown.telemetry('/srv/ml/TELEMETRY.md'));
