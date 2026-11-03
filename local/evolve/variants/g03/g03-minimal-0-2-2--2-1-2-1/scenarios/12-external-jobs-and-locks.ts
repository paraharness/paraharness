import { z } from 'zod';
import { H } from 'harness-dsl';
import type { PendingView } from 'harness-dsl';
import * as anthropic from 'harness-dsl/anthropic';
import * as folder from 'harness-dsl/folder';
import * as sqlite from 'harness-dsl/sqlite';
import * as shell from 'harness-dsl/shell';
import * as http from 'harness-dsl/http';
import * as markdown from 'harness-dsl/markdown';

const databaseSchema = z.enum(['orders', 'billing', 'analytics']);
const databases = {
  orders: H.resource('orders-db'),
  billing: H.resource('billing-db'),
  analytics: H.resource('analytics-db'),
};

const local = shell.local('platform-local', { slots: 4 });
const sonnet = anthropic.model('claude-sonnet-4-5');
const apiAccount = anthropic.account('anthropic-api', { apiKey: H.env('ANTHROPIC_API_KEY') });

const evalRun = H.kind('eval-run')
  .data(z.object({ checkpoint: z.string(), suite: z.string() }))
  .states(H.state('queued', 'pending'), H.state('scored', 'terminal', 'success'), H.state('failed', 'terminal', 'failure'));

const prepare = H.command('prepare-eval')
  .input(z.object({ checkpoint: z.string(), suite: z.string() }))
  .argv((input) => ['eval', 'prepare', '--checkpoint', input.checkpoint, '--suite', input.suite])
  .on(local)
  .recovery('rerun');

const gpuResultSchema = z.object({ resultsUri: z.string(), gpuHours: z.number() });
type GpuResult = z.infer<typeof gpuResultSchema>;

const gpuPoll = H.command('gpu-job-status')
  .input(z.string())
  .output(
    z.discriminatedUnion('status', [
      z.object({ status: z.literal('running') }),
      z.object({ status: z.literal('done'), result: gpuResultSchema }),
      z.object({ status: z.literal('failed'), error: z.string() }),
    ])
  )
  .argv((handle) => ['gpu', 'status', '--job', handle])
  .on(local);

const gpuJob = H.command('gpu-job')
  .input(z.object({ bundle: z.string() }))
  .argv((input) => ['gpu', 'submit', '--bundle', input.bundle])
  .on(local)
  .recovery('park')
  .collect<GpuResult>(gpuPoll, { minutes: 10 });

const score = H.command('score-eval')
  .input(z.object({ resultsUri: z.string() }))
  .argv((input) => ['eval', 'score', '--results', input.resultsUri])
  .on(local)
  .recovery('rerun');

const summarizerRole = H.role('eval-summarizer')
  .input(z.object({ checkpoint: z.string(), scores: z.string() }))
  .output(z.object({ summary: z.string() }))
  .prompt((input) => `Summarise the evaluation of ${input.checkpoint}:\n${input.scores}`);

const summarizer = H.seat('eval-summarizer', summarizerRole).model(sonnet);

const evalFlow = H.flow('eval-run').for(evalRun).does(async (ctx) => {
  const prepared = await ctx.run(prepare, ctx.unit.data);
  if (!prepared.ok) return ctx.fail(prepared.error);
  const job = await ctx.run(gpuJob, { bundle: prepared.value });
  if (!job.ok) return ctx.fail(job.error);
  const scored = await ctx.run(score, { resultsUri: job.value.resultsUri });
  if (!scored.ok) return ctx.fail(scored.error);
  const summary = await ctx.run(summarizer, { checkpoint: ctx.unit.data.checkpoint, scores: scored.value });
  if (!summary.ok) return ctx.fail(summary.error);
  return 'scored';
});

const migration = H.kind('migration')
  .data(z.object({ file: z.string(), database: databaseSchema, sequence: z.string() }))
  .states(
    H.state('queued', 'pending'),
    H.state('held', 'waiting'),
    H.state('applied', 'terminal', 'success'),
    H.state('failed', 'terminal', 'failure')
  );

const applyMigration = H.command('apply-migration')
  .input(z.object({ file: z.string(), database: databaseSchema }))
  .argv((input) => ['migrate', 'apply', '--database', input.database, '--file', input.file])
  .on(local)
  .recovery('park');

const migrationFlow = H.flow('migration').for(migration).does(async (ctx) => {
  const applied = await ctx.run(applyMigration, { file: ctx.unit.data.file, database: ctx.unit.data.database });
  if (!applied.ok) return ctx.fail(applied.error);
  return 'applied';
});

const migrationFolder = folder.files(migration, {
  dir: '/srv/platform/migrations',
  read: (file) => {
    const name = file.path.split('/').pop() ?? file.path;
    return { file: file.path, database: databaseSchema.parse(file.frontmatter['database']), sequence: name.slice(0, 4) };
  },
  key: (file) => file.path,
});

const backfill = H.kind('backfill')
  .data(z.object({ table: z.string(), database: databaseSchema }))
  .states(H.state('queued', 'pending'), H.state('complete', 'terminal', 'success'), H.state('failed', 'terminal', 'failure'));

const countRows = H.command('count-rows')
  .input(z.object({ table: z.string(), database: databaseSchema }))
  .output(z.number())
  .argv((input) => ['backfill', 'count', '--database', input.database, '--table', input.table])
  .on(local)
  .recovery('rerun');

const backfillBatch = H.command('backfill-batch')
  .input(z.object({ table: z.string(), database: databaseSchema, offset: z.number(), limit: z.number() }))
  .argv((input) => [
    'backfill',
    'batch',
    '--database',
    input.database,
    '--table',
    input.table,
    '--offset',
    String(input.offset),
    '--limit',
    String(input.limit),
  ])
  .on(local)
  .retries(3, { first: { minutes: 1 }, factor: 2 })
  .recovery('rerun');

const backfillFlow = H.flow('backfill').for(backfill).does(async (ctx) => {
  const { table, database } = ctx.unit.data;
  const counted = await ctx.run(countRows, { table, database });
  if (!counted.ok) return ctx.fail(counted.error);
  for (let offset = 0; offset < counted.value; offset += 10_000) {
    const batch = await ctx.run(backfillBatch, { table, database, offset, limit: 10_000 });
    if (!batch.ok) return ctx.fail(`batch at row ${offset}: ${batch.error}`);
  }
  return 'complete';
});

const evalLane = H.lane('eval-runs', evalRun)
  .handler(evalFlow, { retries: 1, exhausted: 'failed' })
  .suppliers(H.operator)
  .store(sqlite.store(evalRun, '/srv/platform/.harness/evals.sqlite'))
  .wip(2);

const migrationLane = H.lane('migrations', migration)
  .handler(migrationFlow, { exhausted: 'failed' })
  .suppliers(migrationFolder)
  .store(sqlite.store(migration, '/srv/platform/.harness/migrations.sqlite'))
  .locks((data) => [{ resource: databases[data.database], mode: 'exclusive' }])
  .sequence((data) => data.sequence, 'held');

const backfillLane = H.lane('backfills', backfill)
  .handler(backfillFlow, { retries: 2, backoff: { first: { minutes: 5 }, factor: 2 }, exhausted: 'failed' })
  .suppliers(H.operator)
  .store(sqlite.store(backfill, '/srv/platform/.harness/backfills.sqlite'))
  .locks((data) => [{ resource: databases[data.database], mode: 'shared' }]);

const platformScheduler = H.policy.scheduler('migrations-then-backfills-then-gpu-budget', (view) => {
  const gpuToday = view.metrics.sum({
    of: 'durationMs',
    among: { entry: 'invocation', mode: 'external', executable: gpuJob, status: 'ended' },
    days: 1,
  });
  const gpuBudgetSpent = gpuToday.samples >= 5 && (gpuToday.value ?? 0) / 3_600_000 > 48;
  const lockWaitMs = (unit: PendingView): number => {
    if (!unit.is(backfill)) return 0;
    const wait = view.metrics.mean({
      of: 'lockWaitMs',
      among: { entry: 'lease', status: 'acquired', resource: databases[unit.data.database] },
      days: 1,
    });
    return wait.value ?? 0;
  };
  const rank = (unit: PendingView): number => {
    if (unit.is(migration)) return Number(unit.data.sequence);
    if (unit.is(backfill)) return 10_000 + lockWaitMs(unit);
    return Number.MAX_SAFE_INTEGER;
  };
  return {
    start: [...view.pending].filter((unit) => !(gpuBudgetSpent && unit.is(evalRun))).sort((a, b) => rank(a) - rank(b)),
  };
});

export const platformHarness = H.harness('ml-platform')
  .ledger(sqlite.ledger('/srv/platform/.harness/ledger.sqlite'))
  .lanes(evalLane, migrationLane, backfillLane)
  .pools(H.pool('api', [{ account: apiAccount, share: 1 }]))
  .scheduler(platformScheduler)
  .clients(
    http.control({
      port: 9901,
      token: H.env('PLATFORM_CONTROL_TOKEN'),
      grants: [
        H.ops.readWork,
        H.ops.writeWork,
        H.ops.readTelemetry,
        H.ops.resolve(H.halts.interrupted, H.halts.definitionChanged),
      ],
    })
  )
  .observers(markdown.board('/srv/platform/.harness/board.md'), markdown.telemetry('/srv/platform/.harness/telemetry.md'));
