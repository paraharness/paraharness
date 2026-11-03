import { z } from 'zod';
import { H } from 'harness-dsl';
import { claudeCode } from 'harness-dsl/claude-code';
import { anthropic } from 'harness-dsl/anthropic';
import { sqlite } from 'harness-dsl/sqlite';
import { supply } from 'harness-dsl/supply';
import { observers } from 'harness-dsl/observers';

const gpuUrl = H.env('GPU_SERVICE_URL');
const gpuToken = H.env('GPU_SERVICE_TOKEN');
const workers = H.runner.local('workers', { slots: 4 });
const unitStore = sqlite.store('.harness/units.db');

const apiAccount = H.account('anthropic-api', anthropic.api({ apiKey: H.env('ANTHROPIC_API_KEY') }));
const sonnet = H.model('claude-sonnet-4-5').pricing(anthropic.pricing());
const pool = H.pool('api', [apiAccount]).serves(sonnet);

const databases = {
  orders: H.resource('orders-db'),
  users: H.resource('users-db'),
  billing: H.resource('billing-db'),
};
const databaseName = z.enum(['orders', 'users', 'billing']);

const queued = H.state('queued').pending();
const running = H.state('running').active();
const heldByPredecessor = H.state('held-by-failed-predecessor').waiting();

const scored = H.state('scored').terminal('success');
const evalFailed = H.state('eval-failed').terminal('failure');
const evalSchema = z.object({ runId: z.string(), model: z.string(), dataset: z.string() });
const evalRun = H.work('eval-run').schema(evalSchema).states(queued, running, scored, evalFailed);

const applied = H.state('applied').terminal('success');
const migrationFailed = H.state('migration-failed').terminal('failure');
const migrationSchema = z.object({ id: z.string(), sequence: z.number(), database: databaseName, sql: z.string() });
const migration = H.work('migration').schema(migrationSchema).states(queued, running, heldByPredecessor, applied, migrationFailed);

const filled = H.state('filled').terminal('success');
const backfillFailed = H.state('backfill-failed').terminal('failure');
const backfillSchema = z.object({ table: z.string(), database: databaseName, rowCount: z.number() });
const backfill = H.work('backfill').schema(backfillSchema).states(queued, running, filled, backfillFailed);

const prepareEval = H.command('prepare-eval')
  .input(evalSchema)
  .output(z.object({ bundle: z.string() }))
  .runner(workers)
  .effect('repeatable')
  .run(async (i, ctx) => {
    const result = await ctx.sh(`eval bundle --model ${i.model} --dataset ${i.dataset} --out bundles/${i.runId}`);
    if (result.code !== 0) throw new Error(result.stderr);
    return { bundle: `bundles/${i.runId}` };
  });

const remoteJob = z.object({
  state: z.enum(['queued', 'running', 'failed', 'done']),
  error: z.string().optional(),
  resultsUri: z.string().optional(),
});

const gpuEval = H.job('gpu-eval')
  .input(z.object({ runId: z.string(), bundle: z.string() }))
  .output(z.object({ resultsUri: z.string() }))
  .submit(async (i, ctx) => {
    const response = await fetch(`${ctx.resolve(gpuUrl)}/jobs`, {
      method: 'POST',
      headers: { authorization: `Bearer ${ctx.resolve(gpuToken)}` },
      body: JSON.stringify({ name: i.runId, bundle: i.bundle }),
    });
    return z.object({ jobId: z.string() }).parse(await response.json()).jobId;
  })
  .collect(async (ref, ctx) => {
    const response = await fetch(`${ctx.resolve(gpuUrl)}/jobs/${ref}`, {
      headers: { authorization: `Bearer ${ctx.resolve(gpuToken)}` },
    });
    const job = remoteJob.parse(await response.json());
    if (job.state === 'queued' || job.state === 'running') return { status: 'running' };
    if (job.state === 'failed' || job.resultsUri === undefined) return { status: 'failed', reason: job.error ?? 'no results' };
    return { status: 'done', output: { resultsUri: job.resultsUri } };
  })
  .poll('10m');

const scoreEval = H.command('score-eval')
  .input(z.object({ resultsUri: z.string() }))
  .output(z.object({ score: z.number(), report: z.string() }))
  .runner(workers)
  .effect('repeatable')
  .run(async (i, ctx) => {
    const result = await ctx.sh(`eval score ${i.resultsUri} --json`);
    return z.object({ score: z.number(), report: z.string() }).parse(JSON.parse(result.stdout));
  });

const analystRole = H.role('eval-analyst').prompt('Summarize an evaluation run for the team.');
const summarizeEval = H.skill('summarize-eval')
  .input(z.object({ model: z.string(), dataset: z.string(), score: z.number(), report: z.string() }))
  .output(z.object({ summary: z.string() }))
  .prompt(i => `${i.model} on ${i.dataset} scored ${i.score}.\n${i.report}`);
const analyst = H.seat('eval-analyst').role(analystRole).models(sonnet);

const evalFlow = H.flow('eval-run')
  .input(evalSchema)
  .step('prepare', prepareEval)
  .step('gpu', gpuEval, s => ({ runId: s.input.runId, bundle: s.steps.prepare.bundle }))
  .step('score', scoreEval, s => ({ resultsUri: s.steps.gpu.resultsUri }))
  .step('summarize', analyst.call(summarizeEval), s => ({ model: s.input.model, dataset: s.input.dataset, ...s.steps.score }))
  .exit('scored');

const evals = H.lane('evals')
  .of(evalRun)
  .from(supply.manual(evalSchema).key(d => d.runId))
  .store(unitStore)
  .wip(2)
  .handle(evalFlow, {
    exits: { scored },
    retry: { tries: 2, backoff: 'exponential', delaySeconds: 600, exhausted: evalFailed },
  });

const applyMigration = H.command('apply-migration')
  .input(migrationSchema)
  .runner(workers)
  .effect('unrepeatable')
  .run(async (m, ctx) => {
    const result = await ctx.sh(`migrate apply --database ${m.database} --id ${m.id}`, { stdin: m.sql });
    if (result.code !== 0) throw new Error(result.stderr);
  });

const migrationFlow = H.flow('migration')
  .input(migrationSchema)
  .resources(s => [H.lease.exclusive(databases[s.input.database])])
  .step('apply', applyMigration, { onFailure: 'fail' })
  .exit('applied');

const migrations = H.lane('migrations')
  .of(migration)
  .from(supply.folder({ path: 'migrations', schema: migrationSchema }).key(m => m.id))
  .store(unitStore)
  .after(m => (m.sequence > 1 ? String(m.sequence - 1).padStart(4, '0') : undefined), { failed: heldByPredecessor })
  .handle(migrationFlow, {
    exits: { applied },
    retry: { tries: 1, backoff: 'none', exhausted: migrationFailed },
  });

const backfillBatch = H.command('backfill-batch')
  .input(z.object({ table: z.string(), database: databaseName, offset: z.number(), size: z.number() }))
  .output(z.object({ rowsWritten: z.number() }))
  .runner(workers)
  .effect('repeatable')
  .run(async (i, ctx) => {
    const result = await ctx.sh(`backfill --database ${i.database} --table ${i.table} --offset ${i.offset} --limit ${i.size} --upsert`);
    if (result.code !== 0) throw new Error(result.stderr);
    return { rowsWritten: Number(result.stdout.trim()) };
  });

const backfillFlow = H.flow('backfill')
  .input(backfillSchema)
  .resources(s => [H.lease.shared(databases[s.input.database])])
  .loop('batches', {
    maxIterations: s => Math.ceil(s.input.rowCount / 10000) + 1,
    initial: () => 0,
    body: f =>
      f.step('batch', backfillBatch, s => ({ table: s.input.table, database: s.input.database, offset: s.carry, size: 10000 }), {
        retry: { tries: 3, backoff: 'exponential', delaySeconds: 30 },
      }),
    next: s => s.carry + 10000,
    until: s => s.steps.batch.rowsWritten < 10000,
  })
  .exit(s => (s.steps.batches.completed ? 'filled' : 'incomplete'));

const backfills = H.lane('backfills')
  .of(backfill)
  .from(supply.manual(backfillSchema).key(b => `${b.database}.${b.table}`))
  .store(unitStore)
  .handle(backfillFlow, {
    exits: { filled, incomplete: backfillFailed },
    retry: { tries: 2, backoff: 'exponential', delaySeconds: 300, exhausted: backfillFailed },
  });

const gpuSecondsInFlight = H.metric('gpu-job-seconds').sum(H.events.jobs(), 'durationSeconds');
const lockWait = H.metric('lock-wait-seconds').mean(H.events.leases(), 'waitSeconds');

const migrationsFirst = H.policy.schedule('migrations-backfills-evals', ({ candidates }) => [
  ...candidates.filter(c => c.lane === migrations).sort((a, b) => (a.unit.key < b.unit.key ? -1 : 1)),
  ...candidates.filter(c => c.lane === backfills),
  ...candidates.filter(c => c.lane === evals),
]);

export default H.harness('ml-platform')
  .ledger(sqlite.ledger('.harness/ledger.db'))
  .pools(pool)
  .lanes(evals, migrations, backfills)
  .schedule(migrationsFirst)
  .grants(
    H.grant(claudeCode.client('platform-supervisor'), H.ops.work.read, H.ops.work.write, H.ops.telemetry.read),
  )
  .metrics(gpuSecondsInFlight, lockWait)
  .observe(observers.board({ path: '.harness/board.md' }), observers.telemetry({ path: '.harness/telemetry.md' }));
