import { z } from 'zod';
import { H } from 'harness-dsl';
import type { Metrics } from 'harness-dsl';
import * as anthropic from 'harness-dsl/anthropic';
import * as claude from 'harness-dsl/claude-code';
import * as folder from 'harness-dsl/folder';
import * as sqlite from 'harness-dsl/sqlite';
import * as shell from 'harness-dsl/shell';
import * as markdown from 'harness-dsl/markdown';

const apiAccount = anthropic.account('anthropic-api', { apiKey: H.env('ANTHROPIC_API_KEY') });
const haiku = anthropic.model('claude-haiku-4');
const pool = H.pool('accounts', [{ account: apiAccount, share: 1 }]);
const localRunner = shell.local('local', { slots: 4 });

const databaseName = z.enum(['orders', 'billing']);
const databases = {
  orders: H.resource('orders-db'),
  billing: H.resource('billing-db'),
};

const evalRun = H.kind('eval-run')
  .data(z.object({ model: z.string(), suite: z.string(), summary: z.string().optional() }))
  .states(H.state('queued', 'pending'), H.state('scored', 'terminal', 'success'), H.state('eval-failed', 'terminal', 'failure'));

const prepare = H.command('prepare-eval')
  .input(z.object({ model: z.string(), suite: z.string() }))
  .argv(input => ['./evals/prepare.sh', input.model, input.suite])
  .on(localRunner)
  .recovery('rerun');

const submitEval = H.command('submit-gpu-eval')
  .input(z.object({ model: z.string(), suite: z.string(), bundle: z.string() }))
  .argv(input => ['./evals/submit.sh', input.model, input.suite, input.bundle])
  .on(localRunner)
  .recovery('park');

const evalResult = z.object({ artifact: z.string(), gpuHours: z.number() });
const evalPoll = z.discriminatedUnion('status', [
  z.object({ status: z.literal('running') }),
  z.object({ status: z.literal('done'), result: evalResult }),
  z.object({ status: z.literal('failed'), error: z.string() }),
]);
const pollEval = H.command('poll-gpu-eval')
  .input(z.string())
  .output(evalPoll)
  .argv(handle => ['./evals/status.sh', handle])
  .on(localRunner)
  .recovery('rerun');

const gpuEval = H.job('gpu-eval').output(evalResult).submit(submitEval).collect(pollEval, { minutes: 10 });

const score = H.command('score-eval')
  .input(z.object({ artifact: z.string() }))
  .output(z.object({ score: z.number() }))
  .argv(input => ['./evals/score.sh', input.artifact])
  .on(localRunner)
  .recovery('rerun');

const summaryRole = H.role('eval-summarizer')
  .input(z.object({ suite: z.string(), model: z.string(), score: z.number() }))
  .output(z.object({ summary: z.string() }))
  .prompt(input => `Summarise the ${input.suite} evaluation of ${input.model}: score ${input.score}.`);
const summarizer = H.seat('eval-summarizer', summaryRole).model(haiku);

const runEval = H.flow('run-eval')
  .for(evalRun)
  .does(async ctx => {
    const { model, suite } = ctx.unit.data;
    const prepared = await ctx.run(prepare, { model, suite });
    if (!prepared.ok) return ctx.fail(prepared.error);
    const job = await ctx.run(gpuEval, { model, suite, bundle: prepared.value });
    if (!job.ok) return ctx.fail(job.error);
    const scored = await ctx.run(score, { artifact: job.value.artifact });
    if (!scored.ok) return ctx.fail(scored.error);
    const summary = await ctx.run(summarizer, { suite, model, score: scored.value.score });
    if (!summary.ok) return ctx.fail(summary.error);
    await ctx.update({ summary: summary.value.summary });
    return 'scored';
  });

const evals = H.lane('evals', evalRun)
  .handler(runEval)
  .retries(1, { exhausted: 'eval-failed' })
  .suppliers(H.operator)
  .store(sqlite.store(evalRun, '.harness/evals.sqlite'))
  .wip(2);

const migration = H.kind('migration')
  .data(z.object({ id: z.string(), database: databaseName, file: z.string() }))
  .states(
    H.state('migration-queued', 'pending'),
    H.state('held', 'waiting'),
    H.state('applied', 'terminal', 'success'),
    H.state('migration-failed', 'terminal', 'failure'),
    H.state('abandoned', 'terminal', 'neutral')
  );

const migrate = H.command('apply-migration')
  .input(z.object({ database: z.string(), file: z.string() }))
  .argv(input => ['./db/migrate.sh', input.database, input.file])
  .on(localRunner)
  .recovery('park');

const applyMigration = H.flow('apply-migration')
  .for(migration)
  .does(async ctx => {
    const applied = await ctx.run(migrate, { database: ctx.unit.data.database, file: ctx.unit.data.file });
    return applied.ok ? 'applied' : ctx.fail(applied.error);
  });

const migrationFolder = folder.files(migration, {
  dir: 'migrations',
  read: file => ({
    id: z.string().parse(file.frontmatter.id),
    database: databaseName.parse(file.frontmatter.database),
    file: file.path,
  }),
  key: file => file.path,
});

const migrations = H.lane('migrations', migration)
  .handler(applyMigration)
  .retries(0, { exhausted: 'migration-failed' })
  .suppliers(migrationFolder)
  .store(sqlite.store(migration, '.harness/migrations.sqlite'))
  .locks(data => [{ resource: databases[data.database], mode: 'exclusive' }])
  .sequence(data => data.id, 'held');

const backfill = H.kind('backfill')
  .data(z.object({ table: z.string(), database: databaseName, rows: z.number().int() }))
  .states(H.state('backfill-queued', 'pending'), H.state('backfilled', 'terminal', 'success'), H.state('backfill-failed', 'terminal', 'failure'));

const batchRows = 10000;
const backfillBatch = H.command('backfill-batch')
  .input(z.object({ database: z.string(), table: z.string(), offset: z.number(), limit: z.number() }))
  .argv(input => ['./db/backfill.sh', input.database, input.table, String(input.offset), String(input.limit)])
  .on(localRunner)
  .recovery('rerun')
  .retries(3, { first: { minutes: 1 }, factor: 2 });

const runBackfill = H.flow('run-backfill')
  .for(backfill)
  .does(async ctx => {
    const { database, table, rows } = ctx.unit.data;
    for (let offset = 0; offset < rows; offset += batchRows) {
      const batch = await ctx.run(backfillBatch, { database, table, offset, limit: batchRows });
      if (!batch.ok) return ctx.fail(batch.error);
    }
    return 'backfilled';
  });

const backfills = H.lane('backfills', backfill)
  .handler(runBackfill)
  .retries(1, { exhausted: 'backfill-failed' })
  .suppliers(H.operator)
  .store(sqlite.store(backfill, '.harness/backfills.sqlite'))
  .locks(data => [{ resource: databases[data.database], mode: 'shared' }]);

export const platformReport = H.policy.rule('platform-report', (input: { readonly days: number }, metrics: Metrics) => {
  const gpu = metrics.sum({
    of: 'durationMs',
    among: { entry: 'invocation', executable: gpuEval, status: 'ended' },
    days: input.days,
  });
  const lockWait = (database: keyof typeof databases) =>
    metrics.mean({
      of: 'lockWaitMs',
      among: { entry: 'lease', status: 'acquired', resource: databases[database] },
      days: input.days,
    });
  return {
    gpuHoursPerDay: (gpu.value ?? 0) / 3600000 / input.days,
    gpuJobs: gpu.samples,
    lockWaitOrders: lockWait('orders'),
    lockWaitBilling: lockWait('billing'),
  };
});

export const mlPlatform = H.harness('ml-platform')
  .ledger(sqlite.ledger('.harness/ledger.sqlite'))
  .lanes(evals, migrations, backfills)
  .pools(pool)
  .scheduler(H.policy.scheduler('oldest-first', view => ({ start: [...view.pending].sort((a, b) => b.waitedMs - a.waitedMs) })))
  .clients(
    claude.supervisor('platform-operator', {
      grants: [
        H.ops.readWork,
        H.ops.writeWork,
        H.ops.resolve(H.halts.interrupted, H.halts.definitionChanged),
        H.ops.readTelemetry,
      ],
    })
  )
  .observers(markdown.board('.harness/board.md'), markdown.telemetry('.harness/telemetry.md'));
