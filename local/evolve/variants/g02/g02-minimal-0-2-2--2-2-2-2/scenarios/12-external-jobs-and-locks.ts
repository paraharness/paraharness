import { z } from 'zod';
import { H } from 'harness-dsl';
import type { Measurement } from 'harness-dsl';
import * as anthropic from 'harness-dsl/anthropic';
import * as claudeCode from 'harness-dsl/claude-code';
import * as sqlite from 'harness-dsl/sqlite';
import * as folder from 'harness-dsl/folder';
import * as shell from 'harness-dsl/shell';
import * as markdown from 'harness-dsl/markdown';

const local = shell.local('local', { slots: 4 });
const apiAccount = anthropic.account('anthropic-api', { apiKey: H.env('ANTHROPIC_API_KEY') });
const summaryModel = anthropic.model('claude-sonnet-4-5');
const unitsDb = '/srv/ml/units.db';

const databaseSchema = z.enum(['orders', 'analytics']);
const databases = {
  orders: H.resource('orders-db'),
  analytics: H.resource('analytics-db'),
};

const evalQueued = H.state('eval-queued', 'pending');
const evalScored = H.state('eval-scored', 'terminal', 'success');
const evalFailed = H.state('eval-failed', 'terminal', 'failure');

const evalRun = H.kind('eval-run')
  .data(z.object({ model: z.string(), dataset: z.string(), score: z.number().optional() }))
  .states(evalQueued, evalScored, evalFailed);

const prepare = H.command('prepare-eval')
  .input(z.object({ model: z.string(), dataset: z.string() }))
  .argv(input => ['evals', 'prepare', input.model, input.dataset])
  .on(local)
  .recovery('rerun');

const submitGpuJob = H.command('submit-gpu-job')
  .input(z.object({ model: z.string(), dataset: z.string() }))
  .argv(input => ['gpu', 'submit', '--model', input.model, '--dataset', input.dataset])
  .on(local)
  .recovery('park');

const gpuResult = z.object({ resultsUri: z.string() });
const pollGpuJob = H.command('poll-gpu-job')
  .input(z.string())
  .output(
    z.discriminatedUnion('status', [
      z.object({ status: z.literal('running') }),
      z.object({ status: z.literal('done'), result: gpuResult }),
      z.object({ status: z.literal('failed'), error: z.string() }),
    ])
  )
  .argv(jobId => ['gpu', 'status', '--json', jobId])
  .on(local);

const gpuEval = H.job('gpu-eval').output(gpuResult).submit(submitGpuJob).collect(pollGpuJob, { minutes: 10 });

const score = H.command('score-eval')
  .input(z.object({ resultsUri: z.string() }))
  .output(z.object({ score: z.number(), report: z.string() }))
  .argv(input => ['evals', 'score', input.resultsUri])
  .on(local)
  .recovery('rerun');

const evalSummaryRole = H.role('eval-summary')
  .input(z.object({ model: z.string(), dataset: z.string(), report: z.string() }))
  .output(z.object({ summary: z.string() }))
  .prompt(input => `Summarize the evaluation of ${input.model} on ${input.dataset}:\n${input.report}`);

const evalSummarizer = H.seat('eval-summarizer', evalSummaryRole).model(summaryModel);

const runEval = H.flow('run-eval')
  .for(evalRun)
  .does(async ctx => {
    const target = { model: ctx.unit.data.model, dataset: ctx.unit.data.dataset };
    const prepared = await ctx.run(prepare, target);
    if (prepared.ok === false) return ctx.fail(prepared.error);
    const job = await ctx.run(gpuEval, target);
    if (job.ok === false) return ctx.fail(job.error);
    const scored = await ctx.run(score, { resultsUri: job.value.resultsUri });
    if (scored.ok === false) return ctx.fail(scored.error);
    await ctx.update({ score: scored.value.score });
    const summary = await ctx.run(evalSummarizer, { ...target, report: scored.value.report });
    if (summary.ok === false) return ctx.fail(summary.error);
    return 'eval-scored';
  });

const evalRuns = H.lane('eval-runs', evalRun)
  .handler(runEval)
  .suppliers(H.operator)
  .store(sqlite.store(evalRun, unitsDb))
  .wip(2)
  .retry(H.retry({ times: 1 }), 'eval-failed');

const migrationPending = H.state('migration-pending', 'pending');
const migrationHeld = H.state('migration-held', 'waiting');
const migrationApplied = H.state('migration-applied', 'terminal', 'success');
const migrationFailed = H.state('migration-failed', 'terminal', 'failure');

const migration = H.kind('migration')
  .data(z.object({ seq: z.number(), file: z.string(), database: databaseSchema }))
  .states(migrationPending, migrationHeld, migrationApplied, migrationFailed);

const migrationFolder = folder.files(migration, {
  dir: '/srv/ml/migrations',
  read: file => ({
    seq: Number(file.path.replace(/\D/g, '')),
    file: file.path,
    database: databaseSchema.parse(file.frontmatter['database']),
  }),
  key: file => file.path,
});

const applyMigration = H.command('apply-migration')
  .input(z.object({ file: z.string(), database: databaseSchema }))
  .argv(input => ['migrate', 'apply', '--database', input.database, input.file])
  .on(local)
  .recovery('park')
  .locks(input => [{ resource: databases[input.database], mode: 'exclusive' }]);

const runMigration = H.flow('run-migration')
  .for(migration)
  .does(async ctx => {
    const applied = await ctx.run(applyMigration, { file: ctx.unit.data.file, database: ctx.unit.data.database });
    if (applied.ok === false) return ctx.fail(applied.error);
    return 'migration-applied';
  });

const migrations = H.lane('migrations', migration)
  .handler(runMigration)
  .suppliers(migrationFolder)
  .store(migrationFolder)
  .order(data => data.seq, 'migration-held')
  .retry(H.retry({ times: 0 }), 'migration-failed');

const backfillPending = H.state('backfill-pending', 'pending');
const backfilled = H.state('backfilled', 'terminal', 'success');
const backfillFailed = H.state('backfill-failed', 'terminal', 'failure');

const backfill = H.kind('backfill')
  .data(z.object({ database: databaseSchema, table: z.string() }))
  .states(backfillPending, backfilled, backfillFailed);

const countRows = H.command('count-rows')
  .input(z.object({ database: databaseSchema, table: z.string() }))
  .output(z.object({ rows: z.number() }))
  .argv(input => ['backfill', 'count', '--database', input.database, input.table])
  .on(local)
  .recovery('rerun');

const backfillBatch = H.command('backfill-batch')
  .input(z.object({ database: databaseSchema, table: z.string(), offset: z.number(), limit: z.number() }))
  .argv(input => [
    'backfill',
    'batch',
    '--database',
    input.database,
    input.table,
    String(input.offset),
    String(input.limit),
  ])
  .on(local)
  .recovery('rerun')
  .retry(H.retry({ times: 3, firstDelayMs: 10000 }))
  .locks(input => [{ resource: databases[input.database], mode: 'shared' }]);

const batchRows = 10000;

const runBackfill = H.flow('run-backfill')
  .for(backfill)
  .does(async ctx => {
    const target = { database: ctx.unit.data.database, table: ctx.unit.data.table };
    const counted = await ctx.run(countRows, target);
    if (counted.ok === false) return ctx.fail(counted.error);
    for (let offset = 0; offset < counted.value.rows; offset += batchRows) {
      const batch = await ctx.run(backfillBatch, { ...target, offset, limit: batchRows });
      if (batch.ok === false) return ctx.fail(batch.error);
    }
    return 'backfilled';
  });

const backfills = H.lane('backfills', backfill)
  .handler(runBackfill)
  .suppliers(H.operator)
  .store(sqlite.store(backfill, unitsDb))
  .wip(4)
  .retry(H.retry({ times: 2 }), 'backfill-failed');

const platformReport = H.report('ml-platform', () => ({}));

const platformMetrics = H.report('ml-platform-metrics', metrics => {
  const values: Record<string, Measurement> = {};
  const gpuMs = metrics.sum({
    of: 'durationMs',
    among: { entry: 'invocation', executable: gpuEval, status: 'ended' },
    days: 1,
  });
  values['gpuJobHoursLastDay'] = { value: gpuMs.value === null ? null : gpuMs.value / 3600000, samples: gpuMs.samples };
  for (const resource of [databases.orders, databases.analytics]) {
    values[`lockWaitMs.${resource.name}`] = metrics.mean({
      of: 'lockWaitMs',
      among: { entry: 'lease', status: 'acquired', resource },
      days: 7,
    });
  }
  return values;
});

export const mlPlatform = H.harness('ml-platform')
  .ledger(sqlite.ledger('/srv/ml/ledger.db'))
  .lanes(evalRuns, migrations, backfills)
  .pools(H.pool('api', [{ account: apiAccount, share: 1 }]))
  .reports(platformMetrics)
  .clients(
    claudeCode.supervisor({
      grants: [H.ops.readWork, H.ops.writeWork, H.ops.resolve(H.parked), H.ops.readTelemetry],
    })
  )
  .observers(markdown.board('/srv/ml/BOARD.md'), markdown.telemetry('/srv/ml/TELEMETRY.md'));

export const unusedPlaceholderReport = platformReport.name;

export const running = mlPlatform.start();
