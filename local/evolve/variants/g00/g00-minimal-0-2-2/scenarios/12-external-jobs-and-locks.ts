import { H } from 'harness-dsl';
import type { Metrics } from 'harness-dsl';
import { z } from 'zod';
import * as anthropic from 'harness-dsl/anthropic';
import * as claudeCode from 'harness-dsl/claude-code';
import * as sqlite from 'harness-dsl/sqlite';
import * as folder from 'harness-dsl/folder';
import * as shell from 'harness-dsl/shell';
import * as markdown from 'harness-dsl/markdown';

const queued = H.state('queued', 'pending');
const heldByPredecessor = H.state('held-by-predecessor', 'waiting');
const scored = H.state('scored', 'terminal', 'success');
const applied = H.state('applied', 'terminal', 'success');
const backfilled = H.state('backfilled', 'terminal', 'success');
const failed = H.state('failed', 'terminal', 'failure');

const databaseName = z.enum(['orders', 'billing']);
const databases = {
  orders: H.resource('orders-db'),
  billing: H.resource('billing-db'),
};

const EvalRun = H.kind('EvalRun')
  .data(z.object({
    checkpoint: z.string(),
    suite: z.string(),
    score: z.number().optional(),
    summary: z.string().optional(),
  }))
  .states(queued, scored, failed);

const Migration = H.kind('Migration')
  .data(z.object({
    id: z.string(),
    database: databaseName,
    file: z.string(),
    previous: z.string().nullable(),
  }))
  .states(queued, heldByPredecessor, applied, failed);

const Backfill = H.kind('Backfill')
  .data(z.object({ table: z.string(), database: databaseName }))
  .states(queued, backfilled, failed);

const local = shell.local('ml-local', { slots: 4 });

const prepareEval = H.command('prepare-eval')
  .input(z.object({ checkpoint: z.string(), suite: z.string() }))
  .argv(input => ['evals', 'prepare', '--checkpoint', input.checkpoint, '--suite', input.suite])
  .on(local)
  .recovery('rerun');

const submitEval = H.command('submit-eval')
  .input(z.object({ checkpoint: z.string(), suite: z.string(), bundle: z.string() }))
  .argv(input => ['gpu', 'submit', '--bundle', input.bundle, '--checkpoint', input.checkpoint, '--suite', input.suite])
  .on(local)
  .recovery('park');

const evalResult = z.object({ resultsUrl: z.string() });

const collectEval = H.command('collect-eval')
  .input(z.string())
  .output(z.discriminatedUnion('status', [
    z.object({ status: z.literal('running') }),
    z.object({ status: z.literal('done'), result: evalResult }),
    z.object({ status: z.literal('failed'), error: z.string() }),
  ]))
  .argv(jobId => ['gpu', 'status', '--json', jobId])
  .on(local)
  .recovery('rerun');

const gpuEval = H.job('gpu-eval')
  .output(evalResult)
  .submit(submitEval)
  .collect(collectEval, { minutes: 10 });

const scoreEval = H.command('score-eval')
  .input(z.object({ resultsUrl: z.string() }))
  .output(z.object({ score: z.number() }))
  .argv(input => ['evals', 'score', '--results', input.resultsUrl])
  .on(local)
  .recovery('rerun');

const summarizerRole = H.role('eval-summarizer')
  .input(z.object({ suite: z.string(), score: z.number(), resultsUrl: z.string() }))
  .output(z.object({ summary: z.string() }))
  .prompt(input => `Summarize the ${input.suite} evaluation (score ${input.score}) from ${input.resultsUrl} for the team.`);

const summarizer = H.agent('eval-summarizer', summarizerRole).model(anthropic.model('claude-sonnet-4'));

const evalFlow = H.flow('eval-run').for(EvalRun).does(async ctx => {
  const data = ctx.unit.data;
  const prepared = await ctx.run(prepareEval, { checkpoint: data.checkpoint, suite: data.suite });
  if (!prepared.ok) return ctx.fail(prepared.error);
  const job = await ctx.run(gpuEval, { checkpoint: data.checkpoint, suite: data.suite, bundle: prepared.value });
  if (!job.ok) return ctx.fail(job.error);
  const score = await ctx.run(scoreEval, { resultsUrl: job.value.resultsUrl });
  if (!score.ok) return ctx.fail(score.error);
  const summary = await ctx.run(summarizer, { suite: data.suite, score: score.value.score, resultsUrl: job.value.resultsUrl });
  if (!summary.ok) return ctx.fail(summary.error);
  await ctx.update({ score: score.value.score, summary: summary.value.summary });
  return 'scored';
});

const applyMigration = H.command('apply-migration')
  .input(z.object({ database: databaseName, file: z.string() }))
  .argv(input => ['migrate', 'apply', '--database', input.database, input.file])
  .on(local)
  .recovery('park');

const migrationFlow = H.flow('migration').for(Migration).does(async ctx => {
  const result = await ctx.run(applyMigration, { database: ctx.unit.data.database, file: ctx.unit.data.file });
  if (!result.ok) return ctx.fail(result.error);
  return 'applied';
});

const batchRows = 10_000;

const copyBatch = H.command('copy-backfill-batch')
  .input(z.object({ table: z.string(), database: databaseName, offset: z.number() }))
  .output(z.object({ copied: z.number() }))
  .argv(input => ['backfill', 'batch', '--database', input.database, '--table', input.table, '--offset', String(input.offset), '--limit', String(batchRows)])
  .on(local)
  .recovery('rerun');

const backfillFlow = H.flow('backfill').for(Backfill).does(async ctx => {
  let offset = 0;
  for (;;) {
    const batch = await ctx.run(copyBatch, { table: ctx.unit.data.table, database: ctx.unit.data.database, offset });
    if (!batch.ok) return ctx.fail(batch.error);
    if (batch.value.copied < batchRows) return 'backfilled';
    offset += batchRows;
  }
});

function migrationId(path: string): string {
  return path.split('/').pop()?.slice(0, 4) ?? path;
}

const migrationFiles = folder.files(Migration, {
  dir: 'migrations',
  key: file => migrationId(file.path),
  read: file => {
    const id = migrationId(file.path);
    const number = Number(id);
    return {
      id,
      database: databaseName.parse(file.frontmatter.database),
      file: file.path,
      previous: number > 1 ? String(number - 1).padStart(4, '0') : null,
    };
  },
});

const mlStore = 'ml.db';

const evalTwice = H.policy.retry('eval-twice', view => view.failures < 2 ? { retryInMs: 600_000 } : 'stop');
const neverRetry = H.policy.retry('never-retry', () => 'stop');
const backfillBackoff = H.policy.retry('backfill-backoff', view =>
  view.failures <= 3 ? { retryInMs: 30_000 * 2 ** (view.failures - 1) } : 'stop');

const evalRuns = H.lane('eval-runs', EvalRun)
  .handler(evalFlow)
  .suppliers(H.operator)
  .store(sqlite.store(EvalRun, mlStore))
  .wip(2)
  .retry(evalTwice, 'failed');

const migrations = H.lane('migrations', Migration)
  .handler(migrationFlow)
  .suppliers(migrationFiles)
  .store(migrationFiles)
  .wip(4)
  .retry(neverRetry, 'failed')
  .locks(data => [{ resource: databases[data.database], mode: 'exclusive' }])
  .after(data => data.previous, 'held-by-predecessor');

const backfills = H.lane('backfills', Backfill)
  .handler(backfillFlow)
  .suppliers(H.operator)
  .store(sqlite.store(Backfill, mlStore))
  .wip(4)
  .retry(backfillBackoff, 'failed')
  .locks(data => [{ resource: databases[data.database], mode: 'shared' }]);

const migrationsFirst = H.policy.scheduler('migrations-first', view => ({
  start: [...view.pending].sort((a, b) => {
    const rank = (unit: typeof a) => (unit.is(Migration) ? 0 : unit.is(Backfill) ? 1 : 2);
    return rank(a) - rank(b) || b.waitedMs - a.waitedMs;
  }),
}));

const pool = H.pool('ml-api', [
  { account: anthropic.account('ml-api', { apiKey: H.env('ANTHROPIC_API_KEY') }), share: 1 },
]);

export function platformTelemetry(metrics: Metrics) {
  const gpu = metrics.sum({ of: 'durationMs', among: { entry: 'invocation', status: 'ended', executable: gpuEval, mode: 'job' }, days: 1 });
  return {
    gpuJobHoursToday: { hours: gpu.value === null ? null : gpu.value / 3_600_000, samples: gpu.samples },
    lockWaitOrders: metrics.mean({ of: 'lockWaitMs', among: { entry: 'lease', status: 'acquired', resource: databases.orders }, days: 7 }),
    lockWaitBilling: metrics.mean({ of: 'lockWaitMs', among: { entry: 'lease', status: 'acquired', resource: databases.billing }, days: 7 }),
  };
}

export const mlPlatform = H.harness('ml-platform')
  .ledger(sqlite.ledger('ml-ledger.db'))
  .lanes(evalRuns, migrations, backfills)
  .pools(pool)
  .scheduler(migrationsFirst)
  .clients(claudeCode.supervisor({ grants: [H.ops.readWork, H.ops.writeWork, H.ops.resolveHalts, H.ops.readTelemetry] }))
  .observers(markdown.board('board.md'), markdown.telemetry('telemetry.md'));
