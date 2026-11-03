import { z } from 'zod';
import { H } from 'harness-dsl';
import { anthropic } from 'harness-dsl/anthropic';
import { claudeCode } from 'harness-dsl/claude-code';
import { sqlite } from 'harness-dsl/sqlite';
import { folder, manual } from 'harness-dsl/supply';
import { runners } from 'harness-dsl/runners';
import { observers } from 'harness-dsl/observers';

const local = runners.local({ name: 'local', slots: 4 }).env({ GPU_SERVICE_TOKEN: H.env('GPU_SERVICE_TOKEN') });

const databaseName = z.enum(['orders', 'billing']);
const databases = {
  orders: H.resource('orders-db'),
  billing: H.resource('billing-db'),
};
const databaseHosts = {
  orders: runners.ssh({ name: 'orders-db-host', host: H.env('ORDERS_DB_HOST'), user: 'deploy', slots: 2 }),
  billing: runners.ssh({ name: 'billing-db-host', host: H.env('BILLING_DB_HOST'), user: 'deploy', slots: 2 }),
};

const api = H.account('api', anthropic.api({ apiKey: H.env('ANTHROPIC_API_KEY') }));
const sonnet = H.model('claude-sonnet-4-5').pricing(anthropic.pricing());
const pool = H.pool('ml-platform', [api]).serves(sonnet);

const storePath = '.harness/ml.db';

const evalData = z.object({ model: z.string(), suite: z.string() });
const evalQueued = H.state('queued').pending();
const evalScored = H.state('scored').terminal('success');
const evalFailed = H.state('failed').terminal('failure');
const evalKind = H.work('EvalRun').schema(evalData).states(evalQueued, evalScored, evalFailed);

const prepare = H.command('prepare-eval')
  .input(evalData)
  .output(z.object({ bundleUrl: z.string() }))
  .runner(local)
  .effect('repeatable')
  .run(async (input, ctx) => {
    const result = await ctx.exec(['./bin/eval', 'bundle', input.model, input.suite]);
    return { bundleUrl: result.stdout.trim() };
  });

const gpuStatus = z.object({
  state: z.enum(['queued', 'running', 'done', 'failed']),
  resultsUrl: z.string().default(''),
  reason: z.string().default(''),
});

const gpuEval = H.job('gpu-eval')
  .input(z.object({ bundleUrl: z.string(), suite: z.string() }))
  .output(z.object({ resultsUrl: z.string() }))
  .submit(async (input, ctx) => {
    const submitted = await ctx.exec(['./bin/gpu', 'submit', input.bundleUrl, input.suite, '--idempotency-key', ctx.attempt]);
    return submitted.stdout.trim();
  })
  .collect(async (ref, ctx) => {
    const polled = await ctx.exec(['./bin/gpu', 'status', ref]);
    const status = gpuStatus.parse(JSON.parse(polled.stdout));
    if (status.state === 'done') {
      return { status: 'done', output: { resultsUrl: status.resultsUrl } };
    }
    if (status.state === 'failed') {
      return { status: 'failed', reason: status.reason };
    }
    return { status: 'pending' };
  })
  .every('10m')
  .detect(async (_input, ctx) => {
    const found = await ctx.exec(['./bin/gpu', 'find', '--idempotency-key', ctx.attempt]);
    return found.code === 0 ? found.stdout.trim() : undefined;
  });

const score = H.command('score-eval')
  .input(z.object({ resultsUrl: z.string() }))
  .output(z.object({ score: z.number(), report: z.string() }))
  .runner(local)
  .effect('repeatable')
  .run(async (input, ctx) => {
    const result = await ctx.exec(['./bin/eval', 'score', input.resultsUrl]);
    return { score: Number(result.stdout.split('\n')[0]), report: result.stdout };
  });

const evalAnalyst = H.role('eval-analyst').prompt('Summarise evaluation results for the model team.');
const summarizeEval = H.skill('summarize-eval')
  .input(z.object({ model: z.string(), suite: z.string(), score: z.number(), report: z.string() }))
  .output(z.object({ summary: z.string() }))
  .prompt(input => `${input.model} on ${input.suite} scored ${input.score}.\n${input.report}`);
const evalSummarizer = H.seat('eval-summarizer').role(evalAnalyst).skill(summarizeEval).models(sonnet);

const runEval = H.flow('run-eval')
  .input(evalData)
  .step('prepare', prepare, state => state.input)
  .step('evaluate', gpuEval, state => ({ bundleUrl: state.prepare.bundleUrl, suite: state.input.suite }))
  .step('score', score, state => ({ resultsUrl: state.evaluate.resultsUrl }))
  .step('summarize', evalSummarizer, state => ({ model: state.input.model, suite: state.input.suite, score: state.score.score, report: state.score.report }))
  .exit('scored');

const evals = H.lane('evals')
  .of(evalKind)
  .from(manual('operator-evals'))
  .store(sqlite.store(storePath))
  .handle(runEval, { exits: { scored: evalScored }, retry: { retries: 1, backoff: { initial: '15m', factor: 2 }, exhausted: evalFailed } })
  .wip(2);

const migrationData = z.object({ number: z.number(), database: databaseName, path: z.string(), sql: z.string() });
const migrationQueued = H.state('queued').pending();
const migrationApplied = H.state('applied').terminal('success');
const migrationFailed = H.state('failed').terminal('failure');
const migrationHeld = H.state('held').waiting();
const migrationKind = H.work('Migration').schema(migrationData).states(migrationQueued, migrationApplied, migrationFailed, migrationHeld);

const migrationKey = (number: number): string => `migration-${String(number).padStart(4, '0')}`;

const migrate = H.command('apply-migration')
  .input(migrationData)
  .output(z.object({ applied: z.boolean() }))
  .runner(input => databaseHosts[input.database])
  .effect('unrepeatable')
  .run(async (input, ctx) => {
    const result = await ctx.exec(['psql', '--single-transaction', '-v', 'ON_ERROR_STOP=1', input.database], { stdin: input.sql });
    return { applied: result.code === 0 };
  });

const applyMigration = H.flow('apply-migration')
  .input(migrationData)
  .resources(input => [databases[input.database].exclusive()])
  .step('migrate', migrate, state => state.input)
  .when(state => state.migrate.applied === false, flow => flow.exit('failed'))
  .exit('applied');

const migrations = H.lane('migrations')
  .of(migrationKind)
  .from(folder.files({
    name: 'migration-files',
    path: 'migrations',
    glob: '*/*.sql',
    key: file => migrationKey(Number(file.name.slice(0, 4))),
    data: file => ({
      number: Number(file.name.slice(0, 4)),
      database: databaseName.parse(file.path.split('/')[1]),
      path: file.path,
      sql: file.body,
    }),
    mode: 'create',
  }))
  .store(sqlite.store(storePath))
  .handle(applyMigration, { exits: { applied: migrationApplied, failed: migrationFailed }, retry: { retries: 0, backoff: 'none', exhausted: migrationFailed } })
  .order({ after: data => (data.number > 1 ? [migrationKey(data.number - 1)] : []), failed: migrationHeld });

const batchRows = 10000;

const backfillData = z.object({ table: z.string(), database: databaseName, rows: z.number() });
const backfillQueued = H.state('queued').pending();
const backfillFilled = H.state('filled').terminal('success');
const backfillFailed = H.state('failed').terminal('failure');
const backfillKind = H.work('Backfill').schema(backfillData).states(backfillQueued, backfillFilled, backfillFailed);

const copyBatch = H.command('copy-batch')
  .input(z.object({ table: z.string(), database: databaseName, offset: z.number(), limit: z.number() }))
  .output(z.object({ copied: z.number() }))
  .runner(input => databaseHosts[input.database])
  .effect('repeatable')
  .run(async (input, ctx) => {
    const result = await ctx.exec(['./bin/backfill-batch', input.database, input.table, String(input.offset), String(input.limit)]);
    return { copied: Number(result.stdout.trim()) };
  });

const runBackfill = H.flow('run-backfill')
  .input(backfillData)
  .resources(input => [databases[input.database].shared()])
  .loop('batch', {
    max: state => Math.ceil(state.input.rows / batchRows),
    body: flow => flow.step('copy', copyBatch, state => ({
      table: state.input.table,
      database: state.input.database,
      offset: state.batch.iteration * batchRows,
      limit: batchRows,
    })),
    until: state => state.copy.copied < batchRows,
  })
  .exit('filled');

const backfills = H.lane('backfills')
  .of(backfillKind)
  .from(manual('operator-backfills'))
  .store(sqlite.store(storePath))
  .handle(runBackfill, { exits: { filled: backfillFilled }, retry: { retries: 2, backoff: { initial: '5m', factor: 2 }, exhausted: backfillFailed } });

const gpuHoursPerDay = H.metric('gpu-hours-in-flight', H.events.jobs(gpuEval))
  .sum(event => event.hoursInFlight)
  .window('calendarDay');
const lockWait = H.metric('lock-wait-ms', H.events.leases())
  .mean(event => event.waitMs)
  .by('resource')
  .window('7d');

const platformOrder = H.policy.units('migrations-backfills-evals', choice => {
  const rank = (lane: string): number => (lane === migrations.name ? 0 : lane === backfills.name ? 1 : 2);
  return [...choice.candidates].sort((a, b) => rank(a.lane) - rank(b.lane) || a.queuedAt.getTime() - b.queuedAt.getTime());
});

const supervisor = claudeCode.client({ name: 'supervisor' });

export const harness = H.harness('ml-platform')
  .ledger(sqlite.ledger('.harness/ml-ledger.db'))
  .pools(pool)
  .lanes(evals, migrations, backfills)
  .metrics(gpuHoursPerDay, lockWait)
  .scheduler(platformOrder)
  .grants(H.grant(supervisor, H.ops.work.read, H.ops.work.write, H.ops.work.move(migrationHeld), H.ops.attempts.manage, H.ops.telemetry.read))
  .observe(observers.board({ path: '.harness/board.md' }), observers.telemetry({ path: '.harness/telemetry.md' }));
