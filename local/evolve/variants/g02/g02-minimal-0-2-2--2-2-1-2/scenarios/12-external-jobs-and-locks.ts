import { H } from 'harness-dsl';
import * as claudeCode from 'harness-dsl/claude-code';
import * as anthropic from 'harness-dsl/anthropic';
import * as sqlite from 'harness-dsl/sqlite';
import * as folder from 'harness-dsl/folder';
import * as shell from 'harness-dsl/shell';
import * as markdown from 'harness-dsl/markdown';
import { z } from 'zod';

const local = shell.local('local', { slots: 4 });
const apiAccount = anthropic.account('api', { apiKey: H.env('ANTHROPIC_API_KEY') });
const sonnet = anthropic.model('claude-sonnet');
const apiPool = H.pool('api', [{ account: apiAccount, share: 1 }]);

const databaseSchema = z.enum(['orders', 'users']);
const databases = {
  orders: H.resource('orders-db'),
  users: H.resource('users-db'),
};

const evalQueued = H.state('eval-queued', 'pending');
const scored = H.state('scored', 'terminal', 'success');
const evalFailed = H.state('eval-failed', 'terminal', 'failure');
const evalRun = H.kind('EvalRun')
  .data(z.object({ suite: z.string(), checkpoint: z.string(), score: z.number().optional(), summary: z.string().optional() }))
  .states(evalQueued, scored, evalFailed);

const prepareEval = H.command('prepare-eval')
  .input(z.object({ suite: z.string(), checkpoint: z.string() }))
  .argv(input => ['bin/prepare-eval', input.suite, input.checkpoint])
  .on(local)
  .recovery('rerun');

const submitGpu = H.command('submit-gpu-eval')
  .input(z.object({ suite: z.string(), checkpoint: z.string() }))
  .argv(input => ['bin/gpu-submit', input.suite, input.checkpoint])
  .on(local)
  .recovery('park');

const evalResult = z.object({ resultsUri: z.string() });

const pollGpu = H.command('poll-gpu-eval')
  .input(z.string())
  .output(z.discriminatedUnion('status', [
    z.object({ status: z.literal('running') }),
    z.object({ status: z.literal('done'), result: evalResult }),
    z.object({ status: z.literal('failed'), error: z.string() }),
  ]))
  .argv(jobId => ['bin/gpu-status', jobId])
  .on(local);

const gpuEval = H.job('gpu-eval').output(evalResult).submit(submitGpu).collect(pollGpu, { minutes: 10 });

const scoreEval = H.command('score-eval')
  .input(z.object({ resultsUri: z.string() }))
  .output(z.object({ score: z.number() }))
  .argv(input => ['bin/score', input.resultsUri])
  .on(local)
  .recovery('rerun');

const summarizeEvalRole = H.role('summarize-eval')
  .input(z.object({ suite: z.string(), checkpoint: z.string(), score: z.number() }))
  .output(z.object({ summary: z.string() }))
  .prompt(input => `Summarize eval ${input.suite} on ${input.checkpoint}: score ${input.score}.`);

const evalSummarizer = H.seat('eval-summarizer', summarizeEvalRole).model(sonnet);

const runEval = H.flow('run-eval').for(evalRun).does(async ctx => {
  const { suite, checkpoint } = ctx.unit.data;
  const prepared = await ctx.run(prepareEval, { suite, checkpoint });
  if (!prepared.ok) return ctx.fail(prepared.error);
  const job = await ctx.run(gpuEval, { suite, checkpoint });
  if (!job.ok) return ctx.fail(job.error);
  const score = await ctx.run(scoreEval, { resultsUri: job.value.resultsUri });
  if (!score.ok) return ctx.fail(score.error);
  const summary = await ctx.run(evalSummarizer, { suite, checkpoint, score: score.value.score });
  if (!summary.ok) return ctx.fail(summary.error);
  await ctx.update({ score: score.value.score, summary: summary.value.summary });
  return 'scored';
});

const evalLane = H.lane('evals', evalRun)
  .handler(runEval, { retries: 1, exhausted: 'eval-failed' })
  .suppliers(H.operator)
  .store(sqlite.store(evalRun, '.harness/evals.sqlite'))
  .wip(2);

const migrationPending = H.state('migration-pending', 'pending');
const afterPredecessor = H.state('after-predecessor', 'waiting');
const applied = H.state('applied', 'terminal', 'success');
const migrationFailed = H.state('migration-failed', 'terminal', 'failure');
const migration = H.kind('Migration')
  .data(z.object({ id: z.string(), database: databaseSchema, file: z.string() }))
  .states(migrationPending, afterPredecessor, applied, migrationFailed);

const migrate = H.command('migrate')
  .input(z.object({ database: databaseSchema, file: z.string() }))
  .argv(input => ['bin/migrate', input.database, input.file])
  .on(local)
  .recovery('park');

const applyMigration = H.flow('apply-migration').for(migration).does(async ctx => {
  const migrated = await ctx.run(migrate, { database: ctx.unit.data.database, file: ctx.unit.data.file });
  return migrated.ok ? 'applied' : ctx.fail(migrated.error);
});

const migrationFiles = folder.files(migration, {
  dir: 'migrations',
  read: file => ({
    id: (file.path.split('/').pop() ?? file.path).slice(0, 4),
    database: databaseSchema.parse(file.frontmatter['database']),
    file: file.path,
  }),
});

const migrationLane = H.lane('migrations', migration)
  .handler(applyMigration, { retries: 0, exhausted: 'migration-failed' })
  .suppliers(migrationFiles)
  .store(sqlite.store(migration, '.harness/migrations.sqlite'))
  .locks(data => [{ resource: databases[data.database], mode: 'exclusive' }])
  .sequence(data => data.id, 'after-predecessor');

const backfillQueued = H.state('backfill-queued', 'pending');
const backfilled = H.state('backfilled', 'terminal', 'success');
const backfillFailed = H.state('backfill-failed', 'terminal', 'failure');
const backfill = H.kind('Backfill')
  .data(z.object({ database: databaseSchema, table: z.string() }))
  .states(backfillQueued, backfilled, backfillFailed);

const countRows = H.command('count-rows')
  .input(z.object({ database: databaseSchema, table: z.string() }))
  .output(z.number())
  .argv(input => ['bin/count-rows', input.database, input.table])
  .on(local)
  .recovery('rerun');

const backfillBatch = H.command('backfill-batch')
  .input(z.object({ database: databaseSchema, table: z.string(), offset: z.number(), limit: z.number() }))
  .argv(input => ['bin/backfill', input.database, input.table, String(input.offset), String(input.limit)])
  .on(local)
  .recovery('rerun')
  .retries(3, { first: { minutes: 1 }, factor: 2 });

const runBackfill = H.flow('run-backfill').for(backfill).does(async ctx => {
  const { database, table } = ctx.unit.data;
  const rows = await ctx.run(countRows, { database, table });
  if (!rows.ok) return ctx.fail(rows.error);
  for (let offset = 0; offset < rows.value; offset += 10000) {
    const batch = await ctx.run(backfillBatch, { database, table, offset, limit: 10000 });
    if (!batch.ok) return ctx.fail(batch.error);
  }
  return 'backfilled';
});

const backfillLane = H.lane('backfills', backfill)
  .handler(runBackfill, { retries: 2, backoff: { first: { minutes: 5 }, factor: 2 }, exhausted: 'backfill-failed' })
  .suppliers(H.operator)
  .store(sqlite.store(backfill, '.harness/backfills.sqlite'))
  .locks(data => [{ resource: databases[data.database], mode: 'shared' }]);

export const platformReport = H.policy.rule('platform-report', (_input: { readonly day: string }, metrics) => {
  const gpuInFlight = metrics.sum({ of: 'durationMs', among: { entry: 'invocation', mode: 'job', status: 'ended' }, days: 1 });
  return {
    gpuHoursPerDay: (gpuInFlight.value ?? 0) / 3600000,
    gpuJobs: gpuInFlight.samples,
    lockWaitOrders: metrics.mean({ of: 'lockWaitMs', among: { entry: 'lease', status: 'acquired', resource: databases.orders }, days: 7 }),
    lockWaitUsers: metrics.mean({ of: 'lockWaitMs', among: { entry: 'lease', status: 'acquired', resource: databases.users }, days: 7 }),
  };
});

const platformSupervisor = claudeCode.supervisor({
  grants: [
    H.ops.readWork,
    H.ops.writeWork,
    H.ops.resolve(H.halts.interrupted, H.halts.definitionChanged),
    H.ops.readTelemetry,
  ],
});

export const mlPlatform = H.harness('ml-platform')
  .ledger(sqlite.ledger('.harness/ledger.sqlite'))
  .lanes(evalLane, migrationLane, backfillLane)
  .pools(apiPool)
  .clients(platformSupervisor)
  .observers(markdown.board('BOARD.md'), markdown.telemetry('TELEMETRY.md'));
