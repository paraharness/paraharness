import { z } from 'zod';
import { H, type Resource } from 'harness-dsl';
import * as anthropic from 'harness-dsl/anthropic';
import * as sqlite from 'harness-dsl/sqlite';
import * as folder from 'harness-dsl/folder';
import * as shell from 'harness-dsl/shell';
import * as http from 'harness-dsl/http';
import * as markdown from 'harness-dsl/markdown';

const sonnet = anthropic.model('claude-sonnet-4-5');
const api = anthropic.account('ml-api', { apiKey: H.env('ANTHROPIC_API_KEY'), serves: [sonnet] });

const local = shell.local('local', { slots: 4 });

const databaseNames = z.enum(['orders', 'analytics']);
type DatabaseName = z.infer<typeof databaseNames>;
const ordersDb = H.resource('orders-db');
const analyticsDb = H.resource('analytics-db');
const databases: Readonly<Record<DatabaseName, Resource>> = { orders: ordersDb, analytics: analyticsDb };

const queued = H.state('queued', 'pending');
const failed = H.state('failed', 'terminal', 'failure');
const reported = H.state('reported', 'terminal', 'success');
const held = H.state('held', 'waiting');
const applied = H.state('applied', 'terminal', 'success');
const filled = H.state('filled', 'terminal', 'success');

const evalRun = H.kind('eval-run')
  .data(z.object({ run: z.string(), config: z.string(), summary: z.string().optional() }))
  .states(queued, reported, failed);

const migration = H.kind('migration')
  .data(z.object({ id: z.string(), database: databaseNames, path: z.string() }))
  .states(queued, held, applied, failed);

const backfill = H.kind('backfill')
  .data(z.object({ table: z.string(), database: databaseNames }))
  .states(queued, filled, failed);

const prepare = H.command('prepare-eval')
  .input(z.object({ run: z.string(), config: z.string() }))
  .argv(i => ['eval', 'prepare', '--run', i.run, '--config', i.config])
  .on(local)
  .recovery('rerun');

const submitGpu = H.command('submit-gpu-eval')
  .input(z.object({ run: z.string(), config: z.string() }))
  .argv(i => ['gpu-cli', 'submit', '--run', i.run, '--config', i.config])
  .on(local)
  .recovery('park');

const evalResult = z.object({ scoresPath: z.string() });
const pollGpu = H.command('poll-gpu-eval')
  .input(z.string())
  .output(z.discriminatedUnion('status', [
    z.object({ status: z.literal('running') }),
    z.object({ status: z.literal('done'), result: evalResult }),
    z.object({ status: z.literal('failed'), error: z.string() }),
  ]))
  .argv(job => ['gpu-cli', 'status', job])
  .on(local);

const gpuEval = H.job('gpu-eval').output(evalResult).submit(submitGpu).collect(pollGpu, { minutes: 10 });

const score = H.command('score-eval')
  .input(z.object({ scoresPath: z.string() }))
  .argv(i => ['eval', 'score', i.scoresPath])
  .on(local)
  .recovery('rerun');

const summarizeRole = H.role('summarize-eval')
  .input(z.object({ run: z.string(), scores: z.string() }))
  .output(z.object({ summary: z.string() }))
  .prompt(i => `Summarize eval run ${i.run}:\n${i.scores}`);

const evalSummarizer = H.seat('eval-summarizer', summarizeRole).model(sonnet);

const runEval = H.flow('run-eval')
  .for(evalRun)
  .does(async ctx => {
    const input = { run: ctx.unit.data.run, config: ctx.unit.data.config };
    const prepared = await ctx.run(prepare, input);
    if (!prepared.ok) return ctx.fail(prepared.error);
    const job = await ctx.run(gpuEval, input);
    if (!job.ok) return ctx.fail(job.error);
    const scored = await ctx.run(score, { scoresPath: job.value.scoresPath });
    if (!scored.ok) return ctx.fail(scored.error);
    const summary = await ctx.run(evalSummarizer, { run: ctx.unit.data.run, scores: scored.value });
    if (!summary.ok) return ctx.fail(summary.error);
    await ctx.update({ summary: summary.value.summary });
    return 'reported';
  });

const evalRuns = H.lane('eval-runs', evalRun)
  .handler(runEval)
  .retries(1, { exhausted: 'failed' })
  .suppliers(H.operator)
  .store(sqlite.store(evalRun, '.harness/eval-runs.db'))
  .wip(2);

const migrate = H.command('apply-migration')
  .input(z.object({ path: z.string(), database: databaseNames }))
  .argv(i => ['migrate', 'apply', '--database', i.database, i.path])
  .on(local)
  .recovery('park');

const applyMigration = H.flow('apply-migration')
  .for(migration)
  .does(async ctx => {
    const result = await ctx.run(migrate, { path: ctx.unit.data.path, database: ctx.unit.data.database });
    return result.ok ? 'applied' : ctx.fail(result.error);
  });

const migrationFiles = folder.files(migration, {
  dir: 'migrations',
  read: file => ({
    id: file.path.replace(/^.*\//, '').replace(/\.sql$/, ''),
    database: databaseNames.parse(file.frontmatter['database']),
    path: file.path,
  }),
  key: file => file.path,
});

const migrations = H.lane('migrations', migration)
  .handler(applyMigration)
  .retries(0, { exhausted: 'failed' })
  .suppliers(migrationFiles)
  .store(migrationFiles)
  .locks(d => [{ resource: databases[d.database], mode: 'exclusive' }])
  .sequence(d => d.id, 'held');

const backfillBatch = H.command('backfill-batch')
  .input(z.object({ table: z.string(), database: databaseNames, offset: z.number(), limit: z.number() }))
  .output(z.object({ rows: z.number() }))
  .argv(i => ['backfill', '--database', i.database, '--table', i.table, '--offset', String(i.offset), '--limit', String(i.limit)])
  .on(local)
  .recovery('rerun');

const runBackfill = H.flow('run-backfill')
  .for(backfill)
  .does(async ctx => {
    const limit = 10000;
    for (let offset = 0; ; offset += limit) {
      const batch = await ctx.run(backfillBatch, { table: ctx.unit.data.table, database: ctx.unit.data.database, offset, limit });
      if (!batch.ok) return ctx.fail(batch.error);
      if (batch.value.rows < limit) return 'filled';
    }
  });

const backfills = H.lane('backfills', backfill)
  .handler(runBackfill)
  .retries(2, { backoff: { first: { minutes: 2 }, factor: 2 }, exhausted: 'failed' })
  .suppliers(H.operator)
  .store(sqlite.store(backfill, '.harness/backfills.db'))
  .locks(d => [{ resource: databases[d.database], mode: 'shared' }]);

export const platformReport = H.policy.rule('platform-report', (input: { readonly days: number }, metrics) => ({
  gpuJobMs: metrics.sum({ of: 'durationMs', among: { entry: 'invocation', status: 'ended', mode: 'job', executable: gpuEval }, days: input.days }),
  lockWait: [ordersDb, analyticsDb].map(resource => ({
    resource: resource.name,
    wait: metrics.mean({ of: 'lockWaitMs', among: { entry: 'lease', status: 'acquired', resource }, days: input.days }),
  })),
}));

export default H.harness('ml-platform')
  .ledger(sqlite.ledger('.harness/ledger.db'))
  .lanes(evalRuns, migrations, backfills)
  .pools(H.pool('ml-api', [{ account: api, share: 1 }]))
  .clients(http.control({
    port: 8500,
    token: H.env('PLATFORM_CONTROL_TOKEN'),
    grants: [H.ops.readWork, H.ops.writeWork, H.ops.readTelemetry, H.ops.resolve(H.halts.interrupted, H.halts.definitionChanged)],
  }))
  .observers(markdown.board('.harness/board.md'), markdown.telemetry('.harness/telemetry.md'));
