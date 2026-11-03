import { H } from 'harness-dsl';
import { z } from 'zod';
import * as claudeCode from 'harness-dsl/claude-code';
import * as anthropic from 'harness-dsl/anthropic';
import * as sqlite from 'harness-dsl/sqlite';
import * as folder from 'harness-dsl/folder';
import * as shell from 'harness-dsl/shell';
import * as markdown from 'harness-dsl/markdown';

const local = shell.local('ml-local', { slots: 4 });
const sonnet = anthropic.model('claude-sonnet-4-5');
const unitsDb = 'ml/.harness/units.sqlite';

const databaseNames = z.enum(['orders', 'analytics']);
const databases = {
  orders: H.resource('orders-db'),
  analytics: H.resource('analytics-db'),
};

const queued = H.state('queued', 'pending');
const blocked = H.state('blocked', 'waiting');
const succeeded = H.state('done', 'terminal', 'success');
const failed = H.state('failed', 'terminal', 'failure');

const evalRun = H.kind('EvalRun')
  .data(z.object({ suite: z.string(), model: z.string() }))
  .states(queued, succeeded, failed);

const prepare = H.command('prepare-eval')
  .input(z.object({ suite: z.string(), model: z.string() }))
  .output(z.object({ bundle: z.string() }))
  .argv((input) => ['evals', 'prepare', input.suite, input.model])
  .on(local)
  .recovery('rerun');

const gpuResult = z.object({ resultsUri: z.string(), gpuHours: z.number() });

const submitGpu = H.command('submit-gpu-eval')
  .input(z.object({ bundle: z.string() }))
  .output(z.string())
  .argv((input) => ['gpu', 'submit', input.bundle])
  .on(local)
  .recovery('park');

const pollGpu = H.command('poll-gpu-eval')
  .input(z.string())
  .output(
    z.discriminatedUnion('status', [
      z.object({ status: z.literal('running') }),
      z.object({ status: z.literal('done'), result: gpuResult }),
      z.object({ status: z.literal('failed'), error: z.string() }),
    ])
  )
  .argv((jobId) => ['gpu', 'status', jobId])
  .on(local)
  .recovery('rerun');

const gpuEval = H.job('gpu-eval').output(gpuResult).submit(submitGpu).collect(pollGpu, { minutes: 10 });

const score = H.command('score-eval')
  .input(z.object({ resultsUri: z.string() }))
  .output(z.object({ score: z.number(), report: z.string() }))
  .argv((input) => ['evals', 'score', input.resultsUri])
  .on(local)
  .recovery('rerun');

const evalSummaryRole = H.role('eval-summarizer')
  .input(z.object({ suite: z.string(), model: z.string(), score: z.number(), report: z.string() }))
  .output(z.object({ summary: z.string() }))
  .prompt((input) => `Summarise the ${input.suite} evaluation of ${input.model} (score ${input.score}):\n${input.report}`);

const evalSummarizer = H.seat('eval-summarizer', evalSummaryRole).model(sonnet);

const runEval = H.flow('run-eval')
  .for(evalRun)
  .does(async (ctx) => {
    const data = ctx.unit.data;
    const prepared = await ctx.run(prepare, data);
    if (!prepared.ok) return ctx.fail(prepared.error);
    const job = await ctx.run(gpuEval, { bundle: prepared.value.bundle });
    if (!job.ok) return ctx.fail(job.error);
    const scored = await ctx.run(score, { resultsUri: job.value.resultsUri });
    if (!scored.ok) return ctx.fail(scored.error);
    const summary = await ctx.run(evalSummarizer, { suite: data.suite, model: data.model, ...scored.value });
    if (!summary.ok) return ctx.fail(summary.error);
    return 'done';
  });

const evalRuns = H.lane('eval-runs', evalRun)
  .handler(runEval)
  .retries(1, { exhausted: 'failed' })
  .suppliers(H.operator)
  .store(sqlite.store(evalRun, unitsDb))
  .wip(2);

const migration = H.kind('Migration')
  .data(z.object({ id: z.string(), database: databaseNames, path: z.string() }))
  .states(queued, blocked, succeeded, failed);

const migrationFiles = folder.files(migration, {
  dir: 'ml/migrations',
  frontmatter: z.object({ database: databaseNames }),
  read: (file) => ({ id: file.path.replace(/^.*\//, '').slice(0, 4), database: file.frontmatter.database, path: file.path }),
  key: (file) => file.path,
});

const migrate = H.command('apply-migration')
  .input(z.object({ database: databaseNames, path: z.string() }))
  .argv((input) => ['migrate', '--database', input.database, input.path])
  .on(local)
  .recovery('park');

const applyMigration = H.flow('apply-migration')
  .for(migration)
  .does(async (ctx) => {
    const applied = await ctx.run(migrate, { database: ctx.unit.data.database, path: ctx.unit.data.path });
    if (!applied.ok) return ctx.fail(applied.error);
    return 'done';
  });

const migrations = H.lane('migrations', migration)
  .handler(applyMigration)
  .retries(0, { exhausted: 'failed' })
  .suppliers(migrationFiles)
  .store(migrationFiles)
  .locks((data) => [{ resource: databases[data.database], mode: 'exclusive' }])
  .sequence((data) => data.id, 'blocked', (data) => data.database);

const backfill = H.kind('Backfill')
  .data(z.object({ table: z.string(), database: databaseNames }))
  .states(queued, succeeded, failed);

const batchRows = 10000;

const backfillBatch = H.command('backfill-batch')
  .input(z.object({ table: z.string(), database: databaseNames, offset: z.number(), limit: z.number() }))
  .output(z.object({ rows: z.number() }))
  .argv((input) => ['backfill', input.database, input.table, `--offset=${input.offset}`, `--limit=${input.limit}`])
  .on(local)
  .recovery('rerun');

const runBackfill = H.flow('run-backfill')
  .for(backfill)
  .does(async (ctx) => {
    for (let offset = 0; ; offset += batchRows) {
      const batch = await ctx.run(backfillBatch, { table: ctx.unit.data.table, database: ctx.unit.data.database, offset, limit: batchRows });
      if (!batch.ok) return ctx.fail(batch.error);
      if (batch.value.rows < batchRows) return 'done';
    }
  });

const backfills = H.lane('backfills', backfill)
  .handler(runBackfill)
  .retries(2, { backoff: { first: { minutes: 1 }, factor: 2 }, exhausted: 'failed' })
  .suppliers(H.operator)
  .store(sqlite.store(backfill, unitsDb))
  .locks((data) => [{ resource: databases[data.database], mode: 'shared' }]);

export const gpuHoursToday = H.policy.rule('gpu-hours-in-flight-today', z.object({}), (_input, metrics) => {
  const inFlight = metrics.sum({ of: 'durationMs', among: { entry: 'invocation', status: 'ended', mode: 'job', executable: gpuEval }, period: 'today' });
  return { hours: inFlight.value === null ? null : inFlight.value / 3_600_000, samples: inFlight.samples };
});

export const lockWait = H.policy.rule('lock-wait-per-database', z.object({ database: databaseNames, days: z.number() }), (input, metrics) =>
  metrics.mean({ of: 'lockWaitMs', among: { entry: 'lease', status: 'acquired', resource: databases[input.database] }, days: input.days })
);

export const harness = H.harness('ml-platform')
  .ledger(sqlite.ledger('ml/.harness/ledger.sqlite'))
  .pools(H.pool('ml-accounts', [{ account: anthropic.account('ml-api', { apiKey: H.env('ANTHROPIC_API_KEY') }), share: 1 }]).serves(sonnet))
  .lanes(evalRuns, migrations, backfills)
  .scheduler(H.policy.scheduler('migrations-first', (view) => ({ start: view.sorted((unit) => (unit.is(migration) ? 0 : 1)) })))
  .clients(
    claudeCode.supervisor({
      grants: [H.ops.readWork, H.ops.writeWork, H.ops.readTelemetry, H.ops.resolve(H.halts.interrupted, H.halts.definitionChanged)],
    })
  )
  .observers(markdown.board('ml/BOARD.md'), markdown.telemetry('ml/TELEMETRY.md'));
