import { H } from 'harness-dsl';
import type { Metrics, Resource } from 'harness-dsl';
import { z } from 'zod';
import * as anthropic from 'harness-dsl/anthropic';
import * as sqlite from 'harness-dsl/sqlite';
import * as folder from 'harness-dsl/folder';
import * as shell from 'harness-dsl/shell';
import * as http from 'harness-dsl/http';
import * as markdown from 'harness-dsl/markdown';

const sonnet = anthropic.model('claude-sonnet-4-5');
const api = anthropic.account('anthropic-api', { apiKey: H.env('ANTHROPIC_API_KEY') });

const local = shell.local('ml-box', { slots: 4 });

const databaseNames = z.enum(['orders', 'users']);
const databases = { orders: H.resource('orders-db'), users: H.resource('users-db') };

const queued = H.state('queued', 'pending');
const scored = H.state('scored', 'terminal', 'success');
const evalFailed = H.state('evalFailed', 'terminal', 'failure');

const evalRun = H.kind('EvalRun')
  .data(z.object({ model: z.string(), dataset: z.string(), score: z.number().optional(), summary: z.string().optional() }))
  .states(queued, scored, evalFailed);

const prepare = H.command('prepare-eval')
  .input(z.object({ model: z.string(), dataset: z.string() }))
  .argv(input => ['evals', 'prepare', '--model', input.model, '--dataset', input.dataset])
  .on(local)
  .recovery('rerun');

const submitEval = H.command('submit-gpu-eval')
  .input(z.object({ model: z.string(), dataset: z.string(), prepared: z.string() }))
  .argv(input => ['gpu-cli', 'submit', '--model', input.model, '--dataset', input.dataset, '--bundle', input.prepared])
  .on(local)
  .recovery('park');

const evalResult = z.object({ resultsUri: z.string() });

const pollEval = H.command('poll-gpu-eval')
  .input(z.string())
  .output(z.discriminatedUnion('status', [
    z.object({ status: z.literal('running') }),
    z.object({ status: z.literal('done'), result: evalResult }),
    z.object({ status: z.literal('failed'), error: z.string() }),
  ]))
  .argv(handle => ['gpu-cli', 'status', handle, '--json'])
  .on(local)
  .recovery('rerun');

const gpuEval = H.job('gpu-eval').output(evalResult).submit(submitEval).collect(pollEval, { minutes: 10 });

const score = H.command('score-eval')
  .input(z.object({ resultsUri: z.string() }))
  .output(z.object({ score: z.number() }))
  .argv(input => ['evals', 'score', input.resultsUri])
  .on(local)
  .recovery('rerun');

const summarizing = H.role('eval-summarizer')
  .input(z.object({ model: z.string(), dataset: z.string(), score: z.number() }))
  .output(z.object({ text: z.string() }))
  .prompt(input => `Summarize the evaluation of ${input.model} on ${input.dataset}: score ${input.score}`);

const summarizer = H.seat('eval-summarizer', summarizing).model(sonnet);

const evaluate = H.flow('evaluate').for(evalRun).does(async ctx => {
  const { model, dataset } = ctx.unit.data;
  const prepared = await ctx.run(prepare, { model, dataset });
  if (!prepared.ok) return ctx.fail(prepared.error);
  const job = await ctx.run(gpuEval, { model, dataset, prepared: prepared.value });
  if (!job.ok) return ctx.fail(job.error);
  const scoring = await ctx.run(score, { resultsUri: job.value.resultsUri });
  if (!scoring.ok) return ctx.fail(scoring.error);
  const summary = await ctx.run(summarizer, { model, dataset, score: scoring.value.score });
  if (!summary.ok) return ctx.fail(summary.error);
  await ctx.update({ score: scoring.value.score, summary: summary.value.text });
  return 'scored';
});

const evalRuns = H.lane('eval-runs', evalRun)
  .handler(evaluate)
  .attempts(2, { exhausted: 'evalFailed' })
  .suppliers(H.operator)
  .store(sqlite.store(evalRun, '.harness/evals.db'))
  .wip(2);

const pendingMigration = H.state('pendingMigration', 'pending');
const waitingOnPredecessor = H.state('waitingOnPredecessor', 'waiting');
const applied = H.state('applied', 'terminal', 'success');
const migrationFailed = H.state('migrationFailed', 'terminal', 'failure');

const migration = H.kind('Migration')
  .data(z.object({ id: z.string(), database: databaseNames, path: z.string() }))
  .states(pendingMigration, waitingOnPredecessor, applied, migrationFailed);

const migrationFiles = folder.files(migration, {
  dir: 'migrations',
  read: file => ({
    id: z.string().parse(file.frontmatter['id']),
    database: databaseNames.parse(file.frontmatter['database']),
    path: file.path,
  }),
  key: file => file.path,
});

const migrate = H.command('apply-migration')
  .input(z.object({ database: databaseNames, path: z.string() }))
  .argv(input => ['dbtool', 'migrate', '--database', input.database, '--file', input.path])
  .on(local)
  .recovery('park');

const applyMigration = H.flow('apply-migration').for(migration).does(async ctx => {
  const result = await ctx.run(migrate, { database: ctx.unit.data.database, path: ctx.unit.data.path });
  return result.ok ? 'applied' : ctx.fail(result.error);
});

const migrations = H.lane('migrations', migration)
  .handler(applyMigration)
  .attempts(1, { exhausted: 'migrationFailed' })
  .suppliers(migrationFiles)
  .store(migrationFiles)
  .locks(data => [{ resource: databases[data.database], mode: 'exclusive' }])
  .sequence(data => data.id, 'waitingOnPredecessor');

const pendingBackfill = H.state('pendingBackfill', 'pending');
const filled = H.state('filled', 'terminal', 'success');
const backfillFailed = H.state('backfillFailed', 'terminal', 'failure');

const backfill = H.kind('Backfill')
  .data(z.object({ table: z.string(), database: databaseNames }))
  .states(pendingBackfill, filled, backfillFailed);

const backfillBatch = H.command('backfill-batch')
  .input(z.object({ table: z.string(), database: databaseNames, offset: z.number(), limit: z.number() }))
  .output(z.object({ rows: z.number(), done: z.boolean() }))
  .argv(input => [
    'dbtool', 'backfill', '--database', input.database, '--table', input.table,
    '--offset', String(input.offset), '--limit', String(input.limit),
  ])
  .on(local)
  .recovery('rerun')
  .retries(2, { first: { minutes: 1 }, factor: 2 });

const batchRows = 10_000;

const backfillTable = H.flow('backfill-table').for(backfill).does(async ctx => {
  for (let batch = 0; ; batch++) {
    const step = await ctx.run(backfillBatch, {
      table: ctx.unit.data.table,
      database: ctx.unit.data.database,
      offset: batch * batchRows,
      limit: batchRows,
    });
    if (!step.ok) return ctx.fail(step.error);
    if (step.value.done) return 'filled';
  }
});

const backfills = H.lane('backfills', backfill)
  .handler(backfillTable)
  .attempts(3, { backoff: { first: { minutes: 5 } }, exhausted: 'backfillFailed' })
  .suppliers(H.operator)
  .store(sqlite.store(backfill, '.harness/backfills.db'))
  .locks(data => [{ resource: databases[data.database], mode: 'shared' }]);

export const platformTelemetry = H.policy.rule('platform-telemetry', (input: { readonly database: Resource }, metrics: Metrics) => {
  const gpu = metrics.sum({ of: 'durationMs', among: { entry: 'invocation', executable: gpuEval, status: 'ended' }, days: 1 });
  return {
    gpuJobHoursToday: { value: gpu.value === null ? null : gpu.value / 3_600_000, samples: gpu.samples },
    lockWaitMs: metrics.mean({ of: 'lockWaitMs', among: { entry: 'lease', status: 'acquired', resource: input.database }, days: 7 }),
  };
});

export const mlPlatform = H.harness('ml-platform')
  .ledger(sqlite.ledger('.harness/ledger.db'))
  .lanes(evalRuns, migrations, backfills)
  .pools(H.pool('api', [{ account: api, share: 1, serves: [sonnet] }]))
  .clients(http.control({
    port: 7500,
    token: H.env('CONTROL_TOKEN'),
    grants: [H.ops.readWork, H.ops.writeWork, H.ops.resolve(H.halts.interrupted, H.halts.definitionChanged), H.ops.readTelemetry],
  }))
  .observers(markdown.board('BOARD.md'), markdown.telemetry('TELEMETRY.md'));
