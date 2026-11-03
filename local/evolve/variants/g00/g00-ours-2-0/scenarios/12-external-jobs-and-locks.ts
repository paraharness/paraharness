import { z } from 'zod';
import { H } from 'harness-dsl';
import { anthropic } from 'harness-dsl/anthropic';
import { claudeCode } from 'harness-dsl/claude-code';
import { sqlite } from 'harness-dsl/sqlite';
import { http } from 'harness-dsl/http';
import { supply } from 'harness-dsl/supply';
import { policies } from 'harness-dsl/policies';
import { observers } from 'harness-dsl/observers';

const apiAccount = H.account('anthropic-api', anthropic.api({ apiKey: H.env('ANTHROPIC_API_KEY') }));
const sonnet = H.model('claude-sonnet-4-5').pricing(anthropic.pricing());
const apiPool = H.pool('api', [apiAccount]).serves(sonnet).policy(policies.soonestExpiring());

const store = sqlite.store('.harness/units.sqlite');
const workstation = H.runner.local('workstation', { slots: 4 });
const databaseRunner = H.runner
  .local('database-runner', { slots: 4 })
  .env({ ORDERS_DB_URL: H.env('ORDERS_DB_URL'), ANALYTICS_DB_URL: H.env('ANALYTICS_DB_URL') });

const databaseName = z.enum(['orders', 'analytics']);
const databases = { orders: H.resource('orders-db'), analytics: H.resource('analytics-db') };
const urlVariable = { orders: 'ORDERS_DB_URL', analytics: 'ANALYTICS_DB_URL' };

const queued = H.state('queued').pending();
const working = H.state('working').active();
const finished = H.state('finished').terminal('success');
const failed = H.state('failed').terminal('failure');
const parked = H.state('parked').waiting();
const cancelled = H.state('cancelled').terminal('neutral');

const evalSchema = z.object({ evalId: z.string(), checkpoint: z.string(), suite: z.string() });
const evalRunKind = H.work('EvalRun').schema(evalSchema).states(queued, working, finished, failed, cancelled);

const gpuApi = H.env('GPU_API_URL');
const gpuToken = H.env('GPU_API_TOKEN');

const prepare = H.command('prepare-eval')
  .input(evalSchema)
  .output(z.object({ bundle: z.string() }))
  .runner(workstation)
  .effect('repeatable')
  .run(async (i, ctx) => {
    const result = await ctx.sh(`./prepare.sh ${i.checkpoint} ${i.suite}`);
    if (result.code !== 0) throw new Error(result.stderr);
    return { bundle: result.stdout.trim() };
  });

const gpuEvaluation = H.job('gpu-evaluation')
  .input(z.object({ evalId: z.string(), bundle: z.string() }))
  .output(z.object({ resultsUri: z.string() }))
  .submit(async (i, ctx) => {
    const response = await fetch(`${ctx.resolve(gpuApi)}/jobs`, {
      method: 'POST',
      headers: { authorization: `Bearer ${ctx.resolve(gpuToken)}`, 'content-type': 'application/json' },
      body: JSON.stringify({ name: i.evalId, bundle: i.bundle }),
    });
    return z.object({ jobId: z.string() }).parse(await response.json()).jobId;
  })
  .collect(async (ref, ctx) => {
    const response = await fetch(`${ctx.resolve(gpuApi)}/jobs/${ref}`, {
      headers: { authorization: `Bearer ${ctx.resolve(gpuToken)}` },
    });
    const job = z
      .object({
        state: z.enum(['queued', 'running', 'succeeded', 'failed']),
        resultsUri: z.string().optional(),
        error: z.string().optional(),
      })
      .parse(await response.json());
    if (job.state === 'succeeded') return { status: 'done', output: { resultsUri: job.resultsUri ?? '' } };
    if (job.state === 'failed') return { status: 'failed', reason: job.error ?? 'remote job failed' };
    return { status: 'running' };
  })
  .poll('10m');

const score = H.command('score-eval')
  .input(z.object({ resultsUri: z.string() }))
  .output(z.object({ score: z.number(), breakdown: z.record(z.string(), z.number()) }))
  .runner(workstation)
  .effect('repeatable')
  .run(async (i, ctx) =>
    z.object({ score: z.number(), breakdown: z.record(z.string(), z.number()) }).parse(JSON.parse((await ctx.sh(`./score.sh ${i.resultsUri}`)).stdout)),
  );

const analystRole = H.role('eval-analyst').prompt('Summarise an evaluation run for the ML team.');
const analyst = H.agent('eval-analyst').role(analystRole).model(sonnet);
const summarizeEval = H.skill('summarize-eval')
  .input(z.object({ checkpoint: z.string(), score: z.number(), breakdown: z.record(z.string(), z.number()) }))
  .output(z.object({ summary: z.string() }))
  .prompt((i) => `Checkpoint ${i.checkpoint} scored ${i.score}. Breakdown: ${JSON.stringify(i.breakdown)}`);

const evaluate = H.flow('evaluate')
  .input(evalSchema)
  .step('prepare', prepare)
  .step('gpu', gpuEvaluation, (s) => ({ evalId: s.input.evalId, bundle: s.steps.prepare.bundle }))
  .step('score', score, (s) => ({ resultsUri: s.steps.gpu.resultsUri }))
  .step('summarize', analyst.call(summarizeEval), (s) => ({
    checkpoint: s.input.checkpoint,
    score: s.steps.score.score,
    breakdown: s.steps.score.breakdown,
  }))
  .exit('scored');

const evalRuns = H.lane('eval-runs')
  .of(evalRunKind)
  .from(supply.manual())
  .store(store)
  .handle(evaluate)
  .exits({ scored: finished })
  .retry({ tries: 1, backoff: 'linear', delaySeconds: 600, exhausted: failed })
  .wip(2);

const migrationSchema = z.object({ id: z.string(), database: databaseName, sql: z.string() });
const migrationKind = H.work('Migration').schema(migrationSchema).states(queued, working, finished, failed, parked, cancelled);

const applyMigration = H.command('apply-migration')
  .input(migrationSchema)
  .runner(databaseRunner)
  .effect('unrepeatable')
  .run(async (i, ctx) => {
    const result = await ctx.sh(`psql "$${urlVariable[i.database]}" -v ON_ERROR_STOP=1 --single-transaction`, { stdin: i.sql });
    if (result.code !== 0) throw new Error(result.stderr);
  });

const migrate = H.flow('migrate')
  .input(migrationSchema)
  .resources((s) => [H.lease.exclusive(databases[s.input.database])])
  .step('apply', applyMigration)
  .exit('applied');

const previousMigration = (id: string) => {
  const number = Number.parseInt(id, 10);
  return number > 1 ? String(number - 1).padStart(id.length, '0') : undefined;
};

const migrations = H.lane('migrations')
  .of(migrationKind)
  .from(supply.folder({ path: 'migrations', schema: migrationSchema }).key((d) => d.id))
  .store(store)
  .handle(migrate)
  .exits({ applied: finished })
  .retry({ tries: 0, backoff: 'none', exhausted: failed })
  .after((d) => previousMigration(d.id), { failed: parked });

const backfillSchema = z.object({ table: z.string(), database: databaseName, transform: z.string() });
const backfillKind = H.work('Backfill').schema(backfillSchema).states(queued, working, finished, failed, cancelled);
const batchRows = 10_000;

const copyBatch = H.command('backfill-batch')
  .input(z.object({ table: z.string(), database: databaseName, transform: z.string(), offset: z.number(), limit: z.number() }))
  .output(z.object({ rows: z.number() }))
  .runner(databaseRunner)
  .effect('repeatable')
  .run(async (i, ctx) => {
    const result = await ctx.sh(
      `./backfill.sh "$${urlVariable[i.database]}" ${i.table} ${i.transform} --offset ${i.offset} --limit ${i.limit}`,
    );
    if (result.code !== 0) throw new Error(result.stderr);
    return { rows: Number.parseInt(result.stdout.trim(), 10) };
  });

const backfill = H.flow('backfill')
  .input(backfillSchema)
  .resources((s) => [H.lease.shared(databases[s.input.database])])
  .loop('batches', {
    maxIterations: 100_000,
    initial: () => 0,
    body: (batch) =>
      batch.step('copy', copyBatch, (s) => ({
        table: s.input.table,
        database: s.input.database,
        transform: s.input.transform,
        offset: s.carry,
        limit: batchRows,
      })),
    next: (s) => s.carry + s.steps.copy.rows,
    until: (s) => s.steps.copy.rows < batchRows,
  })
  .exit((s) => (s.steps.batches.completed ? 'backfilled' : 'tooManyBatches'));

const backfills = H.lane('backfills')
  .of(backfillKind)
  .from(supply.manual())
  .store(store)
  .handle(backfill)
  .exits({ backfilled: finished, tooManyBatches: failed })
  .retry({ tries: 2, backoff: 'exponential', delaySeconds: 300, exhausted: failed });

const gpuJobSeconds = H.metric('gpu-job-seconds').sum(H.events.jobs(), 'durationSeconds');
const leaseWaitSeconds = H.metric('lease-wait-seconds').median(H.events.leases(), 'waitSeconds');

export const mlPlatform = H.harness('ml-platform')
  .ledger(sqlite.ledger('.harness/ledger.sqlite'))
  .pools(apiPool)
  .lanes(evalRuns, migrations, backfills)
  .scheduler(H.scheduler().policy(H.policy.schedule('oldest-first', ({ candidates }) => [...candidates].sort((a, b) => b.waitingSeconds - a.waitingSeconds))))
  .grants(
    H.grant(http.client('operator', { port: 8720, token: H.env('OPERATOR_TOKEN') }), H.ops.work.read, H.ops.work.write, H.ops.telemetry.read),
    H.grant(claudeCode.client('platform-supervisor', { session: 'platform' }), H.ops.work.read, H.ops.work.write, H.ops.telemetry.read),
  )
  .metrics(gpuJobSeconds, leaseWaitSeconds)
  .observe(observers.board({ path: '.harness/board.md' }), observers.telemetry({ path: '.harness/telemetry.md' }));
