import { z } from 'zod';
import { H } from 'harness-dsl';
import type { PendingView } from 'harness-dsl';
import * as claude from 'harness-dsl/claude-code';
import * as anthropic from 'harness-dsl/anthropic';
import * as sqlite from 'harness-dsl/sqlite';
import * as folder from 'harness-dsl/folder';
import * as shell from 'harness-dsl/shell';
import * as markdown from 'harness-dsl/markdown';

const ledgerPath = '/srv/ml/ledger.sqlite';
const local = shell.local('ml-local', { slots: 4 });

const evalResult = z.object({ accuracy: z.number(), examples: z.number(), reportUrl: z.string() });

const evalQueued = H.state('queued', 'pending');
const evaluated = H.state('evaluated', 'terminal', 'success');
const evalFailed = H.state('failed', 'terminal', 'failure');
const evalRun = H.kind('EvalRun')
  .data(z.object({ checkpoint: z.string(), suite: z.string() }))
  .states(evalQueued, evaluated, evalFailed);

const prepare = H.command('prepare-eval')
  .input(z.object({ checkpoint: z.string(), suite: z.string() }))
  .argv(input => ['eval', 'prepare', input.checkpoint, input.suite])
  .on(local)
  .recovery('rerun');

const submitEval = H.command('submit-eval')
  .input(z.object({ checkpoint: z.string(), suite: z.string(), bundle: z.string() }))
  .argv(input => ['gpu', 'submit', '--checkpoint', input.checkpoint, '--suite', input.suite, '--bundle', input.bundle])
  .on(local)
  .recovery('park');

const pollEval = H.command('poll-eval')
  .input(z.string())
  .output(
    z.discriminatedUnion('status', [
      z.object({ status: z.literal('running') }),
      z.object({ status: z.literal('done'), result: evalResult }),
      z.object({ status: z.literal('failed'), error: z.string() }),
    ])
  )
  .argv(job => ['gpu', 'status', job])
  .on(local);

const gpuEval = H.job('gpu-eval').output(evalResult).submit(submitEval).collect(pollEval, { minutes: 10 });

const score = H.command('score-eval')
  .input(evalResult)
  .output(z.object({ score: z.number() }))
  .argv(input => ['eval', 'score', input.reportUrl])
  .on(local)
  .recovery('rerun');

const summarizer = H.seat(
  'eval-summarizer',
  H.role('eval-summarizer')
    .input(z.object({ suite: z.string(), score: z.number(), accuracy: z.number() }))
    .output(z.object({ summary: z.string() }))
    .prompt(input => `Summarise the ${input.suite} eval: score ${input.score}, accuracy ${input.accuracy}`)
).model(anthropic.model('claude-haiku-4-5'));

const evaluate = H.flow('evaluate').for(evalRun).does(async ctx => {
  const { checkpoint, suite } = ctx.unit.data;
  const prepared = await ctx.run(prepare, { checkpoint, suite });
  if (!prepared.ok) return ctx.fail(prepared);
  const result = await ctx.run(gpuEval, { checkpoint, suite, bundle: prepared.value });
  if (!result.ok) return ctx.fail(result);
  const scored = await ctx.run(score, result.value);
  if (!scored.ok) return ctx.fail(scored);
  const summary = await ctx.run(summarizer, { suite, score: scored.value.score, accuracy: result.value.accuracy });
  if (!summary.ok) return ctx.fail(summary);
  return 'evaluated';
});

const evals = H.lane('evals', evalRun)
  .handler(evaluate)
  .retries(1, 'failed', { first: { minutes: 15 } })
  .suppliers(H.operator)
  .store(sqlite.store(evalRun, ledgerPath))
  .wip(2);

const databaseName = z.enum(['orders', 'billing']);
const databases = { orders: H.resource('orders-db'), billing: H.resource('billing-db') };

const migrationQueued = H.state('queued', 'pending');
const awaitingPredecessor = H.state('awaiting-predecessor', 'waiting');
const applied = H.state('applied', 'terminal', 'success');
const migrationFailed = H.state('failed', 'terminal', 'failure');
const migration = H.kind('Migration')
  .data(z.object({ id: z.string(), database: databaseName, file: z.string() }))
  .states(migrationQueued, awaitingPredecessor, applied, migrationFailed);

const migrate = H.command('apply-migration')
  .input(z.object({ file: z.string(), database: databaseName }))
  .argv(input => ['migrate', 'apply', '--database', input.database, input.file])
  .on(local)
  .recovery('park');

const applyMigration = H.flow('apply-migration').for(migration).does(async ctx => {
  const ran = await ctx.run(migrate, { file: ctx.unit.data.file, database: ctx.unit.data.database });
  if (!ran.ok) return ctx.fail(ran);
  return 'applied';
});

const migrations = H.lane('migrations', migration)
  .handler(applyMigration)
  .retries(0, 'failed')
  .suppliers(
    folder.files(migration, {
      dir: '/srv/ml/migrations',
      read: file => ({
        id: file.path.replace(/^.*\//, '').replace(/\.md$/, ''),
        database: databaseName.parse(file.frontmatter['database']),
        file: file.path,
      }),
      key: file => file.path,
    })
  )
  .store(sqlite.store(migration, ledgerPath))
  .locks(data => [{ resource: databases[data.database], mode: 'exclusive' }])
  .sequence(data => data.id, 'awaiting-predecessor');

const backfillQueued = H.state('queued', 'pending');
const backfilled = H.state('backfilled', 'terminal', 'success');
const backfillFailed = H.state('failed', 'terminal', 'failure');
const backfill = H.kind('Backfill')
  .data(z.object({ table: z.string(), database: databaseName }))
  .states(backfillQueued, backfilled, backfillFailed);

const backfillBatch = H.command('backfill-batch')
  .input(z.object({ table: z.string(), database: databaseName, offset: z.number(), limit: z.number() }))
  .output(z.object({ rows: z.number() }))
  .argv(input => ['backfill', '--database', input.database, '--table', input.table, '--offset', String(input.offset), '--limit', String(input.limit)])
  .on(local)
  .recovery('rerun');

const runBackfill = H.flow('run-backfill').for(backfill).does(async ctx => {
  const batchRows = 10_000;
  let offset = 0;
  let more = true;
  while (more) {
    const batch = await ctx.run(backfillBatch, { table: ctx.unit.data.table, database: ctx.unit.data.database, offset, limit: batchRows });
    if (!batch.ok) return ctx.fail(batch);
    offset += batch.value.rows;
    more = batch.value.rows === batchRows;
  }
  return 'backfilled';
});

const backfills = H.lane('backfills', backfill)
  .handler(runBackfill)
  .retries(2, 'failed', { first: { minutes: 5 }, factor: 2 })
  .suppliers(H.operator)
  .store(sqlite.store(backfill, ledgerPath))
  .locks(data => [{ resource: databases[data.database], mode: 'shared' }]);

export const platformMetrics = H.policy.rule('platform-metrics', z.object({ days: z.number() }), (input, metrics) => ({
  gpuJobInFlightMs: metrics.sum({ of: 'durationMs', among: { entry: 'invocation', mode: 'job', status: 'ended' }, days: input.days }),
  ordersLockWaitMs: metrics.mean({ of: 'lockWaitMs', among: { entry: 'lease', status: 'acquired', resource: databases.orders }, days: input.days }),
  billingLockWaitMs: metrics.mean({ of: 'lockWaitMs', among: { entry: 'lease', status: 'acquired', resource: databases.billing }, days: input.days }),
}));

const platformOrder = H.policy.scheduler('migrations-backfills-evals', view => {
  const rank = (unit: PendingView): number => (unit.is(migration) ? 0 : unit.is(backfill) ? 1 : 2);
  return { start: [...view.pending].sort((a, b) => rank(a) - rank(b) || b.waitedMs - a.waitedMs) };
});

export const harness = H.harness('ml-platform')
  .ledger(sqlite.ledger(ledgerPath))
  .lanes(evals, migrations, backfills)
  .pools(H.pool('api', [{ account: anthropic.account('api', { apiKey: H.env('ANTHROPIC_API_KEY') }), share: 1 }]))
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
  .observers(markdown.board('/srv/ml/BOARD.md'), markdown.telemetry('/srv/ml/TELEMETRY.md'));
