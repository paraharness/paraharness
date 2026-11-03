import { H } from 'harness-dsl';
import type { Metrics } from 'harness-dsl';
import { z } from 'zod';
import { ledger, store } from 'harness-dsl/sqlite';
import { files } from 'harness-dsl/folder';
import { local } from 'harness-dsl/shell';
import { host } from 'harness-dsl/ssh';
import { account, model } from 'harness-dsl/anthropic';
import { supervisor } from 'harness-dsl/claude-code';
import { board } from 'harness-dsl/markdown';

const gpuLauncher = local('gpu-launcher', { slots: 4 });
const dbAdmin = host('db-admin', { address: 'db-admin.internal', user: 'deploy', key: H.env('DB_ADMIN_SSH_KEY'), slots: 4 });
const api = account('platform-api', { apiKey: H.env('ANTHROPIC_API_KEY') });
const sonnet = model('claude-sonnet-4-5');

const databaseName = z.enum(['orders', 'billing']);
const databases = { orders: H.resource('orders-db'), billing: H.resource('billing-db') };

const evalQueued = H.state('eval-queued', 'pending');
const evalScored = H.state('eval-scored', 'terminal', 'success');
const evalFailed = H.state('eval-failed', 'terminal', 'failure');
const evalRun = H.kind('eval-run')
  .data(z.object({ checkpoint: z.string(), suite: z.string(), summary: z.string().optional() }))
  .states(evalQueued, evalScored, evalFailed);

const evalScores = z.object({ metrics: z.record(z.string(), z.number()) });
const evalPoll = z.discriminatedUnion('status', [
  z.object({ status: z.literal('running') }),
  z.object({ status: z.literal('done'), result: evalScores }),
  z.object({ status: z.literal('failed'), error: z.string() }),
]);

const prepareEval = H.command('prepare-eval')
  .input(z.object({ checkpoint: z.string(), suite: z.string() }))
  .output(z.object({ bundle: z.string() }))
  .argv(input => ['eval-prepare', input.checkpoint, input.suite])
  .on(gpuLauncher)
  .recovery('rerun');
const submitEval = H.command('submit-eval')
  .input(z.object({ bundle: z.string() }))
  .argv(input => ['gpu-service', 'submit', input.bundle])
  .on(gpuLauncher)
  .recovery('park');
const pollEval = H.command('poll-eval')
  .input(z.string())
  .output(evalPoll)
  .argv(job => ['gpu-service', 'status', job])
  .on(gpuLauncher);
const gpuEval = H.job('gpu-eval').output(evalScores).submit(submitEval).collect(pollEval, { minutes: 10 });
const scoreEval = H.command('score-eval')
  .input(evalScores)
  .output(z.object({ score: z.number() }))
  .argv(input => ['eval-score', JSON.stringify(input.metrics)])
  .on(gpuLauncher)
  .recovery('rerun');

const evalSummaryRole = H.role('eval-summary')
  .input(z.object({ checkpoint: z.string(), suite: z.string(), score: z.number() }))
  .output(z.object({ summary: z.string() }))
  .prompt(input => `Summarize evaluation of ${input.checkpoint} on ${input.suite}: score ${input.score}.`);
const evalSummarizer = H.seat('eval-summarizer', evalSummaryRole).model(sonnet);

const runEval = H.flow('run-eval')
  .for(evalRun)
  .does(async ctx => {
    const { checkpoint, suite } = ctx.unit.data;
    const prepared = await ctx.run(prepareEval, { checkpoint, suite });
    if (!prepared.ok) return ctx.fail(prepared.error);
    const result = await ctx.run(gpuEval, { bundle: prepared.value.bundle });
    if (!result.ok) return ctx.fail(result.error);
    const scored = await ctx.run(scoreEval, result.value);
    if (!scored.ok) return ctx.fail(scored.error);
    const summary = await ctx.run(evalSummarizer, { checkpoint, suite, score: scored.value.score });
    if (!summary.ok) return ctx.fail(summary.error);
    await ctx.update({ summary: summary.value.summary });
    return 'eval-scored';
  });

const evalLane = H.lane('eval-runs', evalRun)
  .handler(runEval)
  .retries(1, { backoff: { first: { minutes: 30 } }, exhausted: 'eval-failed' })
  .suppliers(H.operator)
  .store(store(evalRun, '/srv/platform/eval-runs.sqlite'))
  .wip(2);

const migrationReady = H.state('migration-ready', 'pending');
const waitingOnPredecessor = H.state('waiting-on-predecessor', 'waiting');
const migrated = H.state('migrated', 'terminal', 'success');
const migrationFailed = H.state('migration-failed', 'terminal', 'failure');
const migration = H.kind('migration')
  .data(z.object({ number: z.string(), database: databaseName, path: z.string() }))
  .states(migrationReady, waitingOnPredecessor, migrated, migrationFailed);

const migrationFiles = files(migration, {
  dir: '/repos/platform/migrations',
  read: file => ({
    number: z.string().parse(file.frontmatter['number']),
    database: databaseName.parse(file.frontmatter['database']),
    path: file.path,
  }),
  key: file => file.path,
});

const applyMigration = H.command('apply-migration')
  .input(z.object({ number: z.string(), database: databaseName, path: z.string() }))
  .argv(input => ['migrate', 'apply', '--database', input.database, input.path])
  .on(dbAdmin)
  .recovery('park');

const runMigration = H.flow('run-migration')
  .for(migration)
  .does(async ctx => {
    const applied = await ctx.run(applyMigration, ctx.unit.data);
    if (!applied.ok) return ctx.fail(applied.error);
    return 'migrated';
  });

const migrationLane = H.lane('migrations', migration)
  .handler(runMigration)
  .retries(0, { exhausted: 'migration-failed' })
  .suppliers(migrationFiles)
  .store(migrationFiles)
  .locks(data => [{ resource: databases[data.database], mode: 'exclusive' }])
  .sequence(data => data.number, 'waiting-on-predecessor');

const backfillReady = H.state('backfill-ready', 'pending');
const backfilled = H.state('backfilled', 'terminal', 'success');
const backfillFailed = H.state('backfill-failed', 'terminal', 'failure');
const backfill = H.kind('backfill')
  .data(z.object({ database: databaseName, table: z.string() }))
  .states(backfillReady, backfilled, backfillFailed);

const countRows = H.command('count-rows')
  .input(z.object({ database: databaseName, table: z.string() }))
  .output(z.object({ rows: z.number() }))
  .argv(input => ['db-count', input.database, input.table])
  .on(dbAdmin)
  .recovery('rerun');
const backfillBatch = H.command('backfill-batch')
  .input(z.object({ database: databaseName, table: z.string(), offset: z.number(), limit: z.number() }))
  .argv(input => ['db-backfill', input.database, input.table, String(input.offset), String(input.limit)])
  .on(dbAdmin)
  .recovery('rerun');

const batchRows = 10_000;
const runBackfill = H.flow('run-backfill')
  .for(backfill)
  .does(async ctx => {
    const counted = await ctx.run(countRows, ctx.unit.data);
    if (!counted.ok) return ctx.fail(counted.error);
    for (let offset = 0; offset < counted.value.rows; offset += batchRows) {
      const copied = await ctx.run(backfillBatch, { ...ctx.unit.data, offset, limit: batchRows });
      if (!copied.ok) return ctx.fail(copied.error);
    }
    return 'backfilled';
  });

const backfillLane = H.lane('backfills', backfill)
  .handler(runBackfill)
  .retries(2, { backoff: { first: { minutes: 5 }, factor: 2 }, exhausted: 'backfill-failed' })
  .suppliers(H.operator)
  .store(store(backfill, '/srv/platform/backfills.sqlite'))
  .locks(data => [{ resource: databases[data.database], mode: 'shared' }])
  .wip(4);

export const platformReport = H.policy.rule('platform-report', (ask: { readonly since: Date }, metrics: Metrics) => ({
  gpuJobMsToday: metrics.sum({ of: 'durationMs', days: 1, among: { entry: 'invocation', mode: 'job', status: 'ended' } }),
  ordersLockWaitMs: metrics.median({
    of: 'lockWaitMs',
    since: ask.since,
    among: { entry: 'lease', status: 'acquired', resource: databases.orders },
  }),
  billingLockWaitMs: metrics.median({
    of: 'lockWaitMs',
    since: ask.since,
    among: { entry: 'lease', status: 'acquired', resource: databases.billing },
  }),
}));

export default H.harness('platform')
  .ledger(ledger('/srv/platform/ledger.sqlite'))
  .lanes(evalLane, migrationLane, backfillLane)
  .pools(H.pool('platform-api-pool', [{ account: api, share: 1 }]))
  .clients(
    supervisor({
      grants: [
        H.ops.readWork,
        H.ops.writeWork,
        H.ops.resolve(H.halts.interrupted, H.halts.definitionChanged),
        H.ops.readTelemetry,
      ],
    })
  )
  .observers(board('/srv/platform/BOARD.md'));
