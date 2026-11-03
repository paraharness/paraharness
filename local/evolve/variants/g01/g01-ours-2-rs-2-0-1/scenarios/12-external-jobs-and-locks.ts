import { z } from 'zod';
import { H } from 'harness-dsl';
import type { ShResult } from 'harness-dsl/kernel';
import { claudeCode } from 'harness-dsl/claude-code';
import { anthropic } from 'harness-dsl/anthropic';
import { sqlite } from 'harness-dsl/sqlite';
import { supply } from 'harness-dsl/supply';
import { observers } from 'harness-dsl/observers';

const gpuApi = H.env('GPU_SERVICE_URL');
const gpuToken = H.env('GPU_SERVICE_TOKEN');

const local = H.runner.local('ml-workstation', { slots: 4 });
const dbHost = H.runner.ssh('db-admin', { host: H.env('DB_ADMIN_HOST'), user: 'ops', key: H.env('DB_ADMIN_KEY'), slots: 4 });

const api = H.account('anthropic-api', anthropic.api({ apiKey: H.env('ANTHROPIC_API_KEY') }));
const sonnet = H.model('claude-sonnet-4-5').pricing(anthropic.pricing());

const unitStore = sqlite.store('./ml/.harness/units.sqlite');

const succeed = (result: ShResult) => {
  if (result.code === 0) return result.stdout;
  throw new Error(result.stderr);
};

const queued = H.state('queued').pending();
const running = H.state('running').active();

const evalSchema = z.object({ name: z.string(), checkpoint: z.string(), suite: z.string() });
const evaluated = H.state('evaluated').terminal('success');
const evalFailed = H.state('eval-failed').terminal('failure');
const evalRun = H.work('eval-run').schema(evalSchema).states(queued, running, evaluated, evalFailed);

const prepare = H.command('prepare-eval')
  .input(evalSchema)
  .output(z.object({ bundle: z.string() }))
  .runner(local)
  .run(async (input, ctx) => ({ bundle: succeed(await ctx.sh(`./scripts/bundle.sh ${input.checkpoint} ${input.suite}`)).trim() }));

const jobCreated = z.object({ id: z.string() });
const jobState = z.union([
  z.object({ state: z.literal('succeeded'), resultsUri: z.string(), gpuSeconds: z.number() }),
  z.object({ state: z.literal('failed'), error: z.string() }),
  z.object({ state: z.enum(['queued', 'running']) }),
]);

const gpuEval = H.job('gpu-eval')
  .input(z.object({ bundle: z.string(), suite: z.string() }))
  .output(z.object({ resultsUri: z.string(), gpuSeconds: z.number() }))
  .submit(async (input, ctx) => {
    const res = await fetch(`${ctx.resolve(gpuApi)}/jobs`, {
      method: 'POST',
      headers: { authorization: `Bearer ${ctx.resolve(gpuToken)}`, 'content-type': 'application/json' },
      body: JSON.stringify({ bundle: input.bundle, suite: input.suite, idempotencyKey: ctx.attempt.id }),
    });
    return jobCreated.parse(await res.json()).id;
  })
  .collect(async (ref, ctx) => {
    const res = await fetch(`${ctx.resolve(gpuApi)}/jobs/${ref}`, { headers: { authorization: `Bearer ${ctx.resolve(gpuToken)}` } });
    const job = jobState.parse(await res.json());
    if (job.state === 'succeeded') return { status: 'done', output: { resultsUri: job.resultsUri, gpuSeconds: job.gpuSeconds } };
    if (job.state === 'failed') return { status: 'failed', reason: job.error };
    return { status: 'running' };
  })
  .poll('10m');

const score = H.command('score-eval')
  .input(z.object({ resultsUri: z.string() }))
  .output(z.object({ score: z.number(), report: z.string() }))
  .runner(local)
  .run(async (input, ctx) =>
    z.object({ score: z.number(), report: z.string() }).parse(JSON.parse(succeed(await ctx.sh(`./scripts/score.sh ${input.resultsUri}`)))));

const analystRole = H.role('eval-analyst').prompt('You summarise evaluation results for the ML team.').intents(['read']);
const analyst = H.seat('eval-analyst').role(analystRole).models(sonnet);

const summarizeEval = H.skill('summarize-eval')
  .input(z.object({ name: z.string(), score: z.number(), report: z.string() }))
  .output(z.object({ summary: z.string() }))
  .prompt(i => `Evaluation ${i.name} scored ${i.score}.\n\n${i.report}`);

const evalFlow = H.flow('eval-run')
  .input(evalSchema)
  .step('prepare', prepare)
  .step('gpu', gpuEval, s => ({ bundle: s.steps.prepare.bundle, suite: s.input.suite }))
  .step('score', score, s => ({ resultsUri: s.steps.gpu.resultsUri }))
  .step('summarize', analyst.call(summarizeEval), s => ({ name: s.input.name, score: s.steps.score.score, report: s.steps.score.report }))
  .exit('evaluated');

const evalRuns = H.lane('eval-runs')
  .of(evalRun)
  .from(supply.manual())
  .store(unitStore)
  .handle(evalFlow)
  .exits({ evaluated, failed: { tries: 2, backoff: 'exponential', delaySeconds: 900, then: evalFailed } })
  .wip(2);

const databases = {
  orders: H.resource('orders-db'),
  users: H.resource('users-db'),
  billing: H.resource('billing-db'),
};
const databaseName = z.enum(['orders', 'users', 'billing']);

const migrationSchema = z.object({ number: z.number().int(), name: z.string(), database: databaseName, sql: z.string() });
const applied = H.state('applied').terminal('success');
const migrationFailed = H.state('migration-failed').terminal('failure');
const awaitingPredecessor = H.state('awaiting-predecessor').waiting();
const migration = H.work('migration').schema(migrationSchema).states(queued, running, awaitingPredecessor, applied, migrationFailed);

const applyMigration = H.command('apply-migration')
  .input(migrationSchema)
  .runner(dbHost)
  .effect('unrepeatable')
  .run(async (input, ctx) => {
    succeed(await ctx.sh(`psql --single-transaction -d ${input.database}`, { stdin: input.sql }));
  });

const migrationFlow = H.flow('migration')
  .input(migrationSchema)
  .resources(s => [H.lease.exclusive(databases[s.input.database])])
  .step('migrate', applyMigration)
  .exit('applied');

const migrations = H.lane('migrations')
  .of(migration)
  .from(supply.folder({ path: './ml/migrations', schema: migrationSchema }).key(d => String(d.number)))
  .store(unitStore)
  .handle(migrationFlow)
  .exits({ applied, failed: { tries: 1, backoff: 'none', then: migrationFailed } })
  .after(d => (d.number > 1 ? String(d.number - 1) : undefined), { failed: awaitingPredecessor });

const batchRows = 10000;
const backfillSchema = z.object({ table: z.string(), database: databaseName, column: z.string() });
const backfilled = H.state('backfilled').terminal('success');
const backfillFailed = H.state('backfill-failed').terminal('failure');
const backfill = H.work('backfill').schema(backfillSchema).states(queued, running, backfilled, backfillFailed);

const backfillBatch = H.command('backfill-batch')
  .input(z.object({ table: z.string(), database: databaseName, column: z.string(), offset: z.number(), limit: z.number() }))
  .output(z.object({ rows: z.number() }))
  .runner(dbHost)
  .effect('repeatable')
  .run(async (input, ctx) => {
    const out = succeed(await ctx.sh(`./scripts/backfill.sh ${input.database} ${input.table} ${input.column} ${input.offset} ${input.limit}`));
    return { rows: Number.parseInt(out.trim(), 10) };
  });

const backfillFlow = H.flow('backfill')
  .input(backfillSchema)
  .resources(s => [H.lease.shared(databases[s.input.database])])
  .loop('batches', {
    maxIterations: 100000,
    initial: () => 0,
    body: f => f.step('batch', backfillBatch, s => ({
      table: s.input.table, database: s.input.database, column: s.input.column, offset: s.carry, limit: batchRows,
    })),
    next: s => s.carry + s.steps.batch.rows,
    until: s => s.steps.batch.rows < batchRows,
  })
  .exit('backfilled');

const backfills = H.lane('backfills')
  .of(backfill)
  .from(supply.manual<z.infer<typeof backfillSchema>>().key(d => `${d.database}.${d.table}`))
  .store(unitStore)
  .handle(backfillFlow)
  .exits({ backfilled, failed: { tries: 3, backoff: 'exponential', delaySeconds: 60, then: backfillFailed } });

const gpuSecondsInFlight = H.metric('gpu-job-seconds-in-flight').sum(H.events.jobs(), 'durationSeconds');
const lockWaitSeconds = H.metric('lock-wait-seconds').mean(H.events.leases(), 'waitSeconds');

const laneOrder = [migrations, backfills, evalRuns];
const schedule = H.policy.schedule('migrations-backfills-evals', input =>
  [...input.candidates].sort((a, b) =>
    laneOrder.findIndex(l => l === a.lane) - laneOrder.findIndex(l => l === b.lane) || b.waitingSeconds - a.waitingSeconds));

const supervisor = claudeCode.client('ml-supervisor', { session: 'ml-platform' });

export const harness = H.harness('ml-platform')
  .ledger(sqlite.ledger('./ml/.harness/ledger.sqlite'))
  .pools(H.pool('api', [api]).serves(sonnet))
  .lanes(evalRuns, migrations, backfills)
  .scheduler(H.scheduler().policy(schedule))
  .grants(H.grant(supervisor, H.ops.work.read, H.ops.work.write, H.ops.telemetry.read))
  .metrics(gpuSecondsInFlight, lockWaitSeconds)
  .observe(observers.board({ path: './ml/BOARD.md' }), observers.telemetry({ path: './ml/TELEMETRY.md' }));
