import { H } from 'harness-dsl';
import type { Metrics, PendingView, Resource } from 'harness-dsl';
import { z } from 'zod';
import * as anthropic from 'harness-dsl/anthropic';
import * as claude from 'harness-dsl/claude-code';
import * as sqlite from 'harness-dsl/sqlite';
import * as folder from 'harness-dsl/folder';
import * as shell from 'harness-dsl/shell';
import * as ssh from 'harness-dsl/ssh';
import * as markdown from 'harness-dsl/markdown';

const local = shell.local('local', { slots: 4 });
const dbHost = ssh.host('db-admin', {
  address: 'db-admin.internal',
  user: 'ops',
  key: H.env('DB_ADMIN_SSH_KEY'),
  slots: 4,
});
const api = anthropic.account('anthropic-api', { apiKey: H.env('ANTHROPIC_API_KEY') });
const units = './.harness/units.db';

const databaseName = z.enum(['orders', 'users', 'billing']);
const databases = {
  orders: H.resource('orders-db'),
  users: H.resource('users-db'),
  billing: H.resource('billing-db'),
};

const evalRun = H.kind('EvalRun')
  .data(z.object({ model: z.string(), suite: z.string(), summary: z.string() }))
  .states(
    H.state('queued', 'pending'),
    H.state('scored', 'terminal', 'success'),
    H.state('broken', 'terminal', 'failure')
  );

const evalResult = z.object({ accuracy: z.number(), samples: z.number() });
const gpuPoll = z.discriminatedUnion('status', [
  z.object({ status: z.literal('running') }),
  z.object({ status: z.literal('done'), result: evalResult }),
  z.object({ status: z.literal('failed'), error: z.string() }),
]);

const prepare = H.command('prepareEval')
  .input(z.object({ suite: z.string() }))
  .argv((i) => ['./scripts/prepare.sh', i.suite])
  .on(local)
  .recovery('rerun');

const submitGpu = H.command('submitGpuEval')
  .input(z.object({ model: z.string(), suite: z.string() }))
  .argv((i) => ['gpuctl', 'submit', '--model', i.model, '--suite', i.suite])
  .on(local)
  .recovery('park');

const collectGpu = H.command('collectGpuEval')
  .input(z.string())
  .output(gpuPoll)
  .argv((jobId) => ['gpuctl', 'status', '--json', jobId])
  .on(local);

const gpuEval = H.job('gpuEval').output(evalResult).submit(submitGpu).collect(collectGpu, { minutes: 10 });

const score = H.command('scoreEval')
  .input(evalResult)
  .output(z.object({ score: z.number() }))
  .argv((i) => ['./scripts/score.sh', String(i.accuracy), String(i.samples)])
  .on(local)
  .recovery('rerun');

const summarizerRole = H.role('evalSummarizer')
  .input(z.object({ model: z.string(), suite: z.string(), score: z.number() }))
  .output(z.object({ summary: z.string() }))
  .prompt((i) => `Summarise the ${i.suite} evaluation of ${i.model}: score ${i.score}.`);

const summarizer = H.seat('evalSummarizer', summarizerRole).model(anthropic.model('claude-sonnet'));

const evaluate = H.flow('evaluate')
  .for(evalRun)
  .does(async (ctx) => {
    const { model, suite } = ctx.unit.data;
    const prepared = await ctx.run(prepare, { suite });
    if (!prepared.ok) return ctx.fail(prepared.error);
    const result = await ctx.run(gpuEval, { model, suite });
    if (!result.ok) return ctx.fail(result.error);
    const scored = await ctx.run(score, result.value);
    if (!scored.ok) return ctx.fail(scored.error);
    const summary = await ctx.run(summarizer, { model, suite, score: scored.value.score });
    if (!summary.ok) return ctx.fail(summary.error);
    await ctx.update({ summary: summary.value.summary });
    return 'scored';
  });

const evals = H.lane('evals', evalRun)
  .handler(evaluate)
  .suppliers(H.operator)
  .store(sqlite.store(evalRun, units))
  .wip(2)
  .retries(1, { exhausted: 'broken' });

const migration = H.kind('Migration')
  .data(z.object({ id: z.string(), database: databaseName, file: z.string() }))
  .states(
    H.state('queued', 'pending'),
    H.state('parked', 'waiting'),
    H.state('applied', 'terminal', 'success'),
    H.state('migrationFailed', 'terminal', 'failure')
  );

const applyMigration = H.command('applyMigration')
  .input(z.object({ database: databaseName, file: z.string() }))
  .argv((i) => ['./scripts/migrate.sh', i.database, i.file])
  .on(dbHost)
  .locks((i) => [{ resource: databases[i.database], mode: 'exclusive' }])
  .recovery('park');

const migrate = H.flow('migrate')
  .for(migration)
  .does(async (ctx) => {
    const applied = await ctx.run(applyMigration, { database: ctx.unit.data.database, file: ctx.unit.data.file });
    if (!applied.ok) return ctx.fail(applied.error);
    return 'applied';
  });

const migrationFolder = folder.files(migration, {
  dir: './migrations',
  read: (file) => ({
    id: String(file.frontmatter['id'] ?? file.path),
    database: databaseName.parse(file.frontmatter['database']),
    file: file.path,
  }),
  key: (file) => String(file.frontmatter['id'] ?? file.path),
});

const migrations = H.lane('migrations', migration)
  .handler(migrate)
  .suppliers(migrationFolder)
  .store(sqlite.store(migration, units))
  .sequence((d) => d.id, 'parked')
  .retries(0, { exhausted: 'migrationFailed' });

const backfill = H.kind('Backfill')
  .data(z.object({ table: z.string(), database: databaseName, rows: z.number() }))
  .states(
    H.state('queued', 'pending'),
    H.state('filled', 'terminal', 'success'),
    H.state('backfillFailed', 'terminal', 'failure')
  );

const backfillBatch = H.command('backfillBatch')
  .input(z.object({ table: z.string(), database: databaseName, offset: z.number(), limit: z.number() }))
  .argv((i) => ['./scripts/backfill.sh', i.database, i.table, String(i.offset), String(i.limit)])
  .on(dbHost)
  .retries(3, { first: { minutes: 1 }, factor: 2 })
  .recovery('rerun');

const runBackfill = H.flow('runBackfill')
  .for(backfill)
  .does(async (ctx) => {
    const { table, database, rows } = ctx.unit.data;
    for (let offset = 0; offset < rows; offset += 10_000) {
      const batch = await ctx.run(backfillBatch, { table, database, offset, limit: 10_000 });
      if (!batch.ok) return ctx.fail(batch.error);
    }
    return 'filled';
  });

const backfills = H.lane('backfills', backfill)
  .handler(runBackfill)
  .suppliers(H.operator)
  .store(sqlite.store(backfill, units))
  .locks((d) => [{ resource: databases[d.database], mode: 'shared' }])
  .retries(2, { backoff: { first: { minutes: 10 } }, exhausted: 'backfillFailed' });

export const gpuHoursInFlightToday = (metrics: Metrics) =>
  metrics.sum({ of: 'durationMs', among: { entry: 'invocation', status: 'ended', mode: 'job', executable: gpuEval }, days: 1 });

export const lockWaitToday = (metrics: Metrics, database: Resource) =>
  metrics.mean({ of: 'lockWaitMs', among: { entry: 'lease', status: 'acquired', resource: database }, days: 1 });

const platformOrder = H.policy.scheduler('migrationsFirstBackfillsAfterContention', (view) => {
  const contended = (p: PendingView) => {
    if (!p.is(backfill)) return 0;
    const wait = lockWaitToday(view.metrics, databases[p.data.database]);
    return wait.samples >= 5 && (wait.value ?? 0) > 10 * 60_000 ? 1 : 0;
  };
  const rank = (p: PendingView) => (p.is(migration) ? 0 : p.is(evalRun) ? 1 : 2 + contended(p));
  return { start: [...view.pending].sort((a, b) => rank(a) - rank(b) || b.waitedMs - a.waitedMs) };
});

export const platform = H.harness('ml-platform')
  .ledger(sqlite.ledger('./.harness/ledger.db'))
  .lanes(evals, migrations, backfills)
  .pools(H.pool('accounts', [{ account: api, share: 1 }]))
  .scheduler(platformOrder)
  .clients(
    claude.supervisor({
      grants: [
        H.ops.readWork,
        H.ops.writeWork,
        H.ops.resolve(H.halts.interrupted, H.halts.definitionChanged),
        H.ops.readTelemetry,
      ],
    })
  )
  .observers(markdown.board('./BOARD.md'), markdown.telemetry('./TELEMETRY.md'));
