import { z } from 'zod';
import { H } from 'harness-dsl';
import { sqlite } from 'harness-dsl/sqlite';
import { anthropic } from 'harness-dsl/anthropic';
import { folder } from 'harness-dsl/folder';
import { local } from 'harness-dsl/local';
import { http } from 'harness-dsl/http';
import { markdown } from 'harness-dsl/markdown';

const quota = sqlite.quota('ml-quota', { path: './.harness/quota.sqlite' });
const api = anthropic.account('api', { apiKey: H.env('ANTHROPIC_API_KEY'), quota });
const sonnet = anthropic.model('sonnet', { id: 'claude-sonnet-4-5' });
const firstEligible = H.policy.account('first-eligible', ctx =>
  ctx.candidates.find(c => c.cooldownUntil === undefined || c.cooldownUntil <= ctx.now),
);
const pool = H.pool('ml-pool').accounts(api).drain(firstEligible);
const runner = local.runner('local');
const unitStore = sqlite.store({ path: './.harness/units.sqlite' });

const ordersDb = H.resource('orders-db');
const usersDb = H.resource('users-db');
const databases = { orders: ordersDb, users: usersDb };
const databaseName = z.enum(['orders', 'users']);

const evalAttrs = z.object({ evalId: z.string(), candidateModel: z.string(), dataset: z.string() });

const prepare = H.command('prepare-eval')
  .input(z.object({ evalId: z.string(), dataset: z.string() }))
  .argv(i => ['./bin/prepare', i.evalId, i.dataset])
  .runner(runner);

const submitGpuJob = H.command('submit-gpu-job')
  .input(z.object({ evalId: z.string(), candidateModel: z.string() }))
  .argv(i => ['./bin/gpu-submit', i.evalId, i.candidateModel])
  .output(z.object({ jobId: z.string() }))
  .runner(runner);

const pollGpuJob = H.command('poll-gpu-job')
  .input(z.object({ jobId: z.string() }))
  .argv(i => ['./bin/gpu-status', i.jobId])
  .output(H.jobPoll(z.object({ accuracy: z.number(), artifactUri: z.string() })))
  .runner(runner);

const score = H.command('score-eval')
  .input(z.object({ evalId: z.string(), artifactUri: z.string() }))
  .argv(i => ['./bin/score', i.evalId, i.artifactUri])
  .output(z.object({ score: z.number() }))
  .runner(runner);

const analystRole = H.role('eval-analyst').intents('read').instructions('Summarize an evaluation run for the team.');
const analyst = H.seat('eval-analyst').role(analystRole).model(sonnet).pool(pool);

const EvalRequested = H.state('EvalRequested', 'pending');
const Preparing = H.state('Preparing', 'active');
const OnGpu = H.state('OnGpu', 'waiting');
const Scoring = H.state('Scoring', 'active');
const Summarizing = H.state('Summarizing', 'active');
const Evaluated = H.terminal('Evaluated', 'success');
const EvalFailed = H.terminal('EvalFailed', 'failure');

const EvalRun = H.kind('EvalRun')
  .attributes(evalAttrs)
  .states(EvalRequested, Preparing, OnGpu, Scoring, Summarizing, Evaluated, EvalFailed)
  .key(a => a.evalId)
  .initial(EvalRequested);

const evalFlow = H.flow('eval-run')
  .input(evalAttrs)
  .step('prepare', prepare, ctx => ({ evalId: ctx.unit.attributes.evalId, dataset: ctx.unit.attributes.dataset }), { afterCrash: 'rerun' })
  .job('gpu', {
    submit: submitGpuJob,
    input: ctx => ({ evalId: ctx.unit.attributes.evalId, candidateModel: ctx.unit.attributes.candidateModel }),
    collect: pollGpuJob,
    pollEveryMinutes: 10,
  })
  .step('score', score, ctx => ({ evalId: ctx.unit.attributes.evalId, artifactUri: ctx.steps.gpu.artifactUri }), { afterCrash: 'rerun' })
  .step('summarize', analyst, ctx => ({
    task: `Summarize eval ${ctx.unit.attributes.evalId}: accuracy ${ctx.steps.gpu.accuracy}, score ${ctx.steps.score.score}`,
  }))
  .exit('evaluated');

const evals = H.lane('evals', EvalRun)
  .supply(H.operator)
  .store(unitStore)
  .handler(evalFlow, {
    exits: { evaluated: Evaluated },
    during: { prepare: Preparing, gpu: OnGpu, score: Scoring, summarize: Summarizing },
  })
  .retry({ maxAttempts: 2, backoff: 'exponential', initialDelayMs: 600000, exhausted: EvalFailed });

const migrationAttrs = z.object({ id: z.string(), database: databaseName, path: z.string(), previous: z.string().optional() });

const applyMigration = H.command('apply-migration')
  .input(z.object({ database: databaseName, path: z.string() }))
  .argv(i => ['./bin/migrate', i.database, i.path])
  .runner(runner);

const MigrationQueued = H.state('MigrationQueued', 'pending');
const Applying = H.state('Applying', 'active');
const HeldByOrder = H.state('HeldByOrder', 'waiting');
const Applied = H.terminal('Applied', 'success');
const MigrationFailed = H.terminal('MigrationFailed', 'failure');

const Migration = H.kind('Migration')
  .attributes(migrationAttrs)
  .states(MigrationQueued, Applying, HeldByOrder, Applied, MigrationFailed)
  .key(a => a.id)
  .initial(MigrationQueued);

const migrationFlow = H.flow('migration')
  .input(z.object({ id: z.string(), database: databaseName, path: z.string() }))
  .step('apply', applyMigration, ctx => ({ database: ctx.unit.attributes.database, path: ctx.unit.attributes.path }), { afterCrash: 'park' })
  .exit('applied');

const migrations = H.lane('migrations', Migration)
  .supply(folder.files({ path: './migrations', glob: '*.sql' }), (file, to) => {
    const [id, database] = file.name.split('_');
    if (database !== 'orders' && database !== 'users') return to.skip();
    const number = Number(id);
    return to.create({ id, database, path: file.path, previous: number > 1 ? String(number - 1).padStart(4, '0') : undefined });
  })
  .store(unitStore)
  .handler(migrationFlow, { exits: { applied: Applied }, during: { apply: Applying } })
  .retry({ maxAttempts: 1, backoff: 'fixed', initialDelayMs: 0, exhausted: MigrationFailed })
  .lease(u => ({ resource: databases[u.attributes.database], mode: 'exclusive' }))
  .after({ key: a => a.previous, onPredecessorFailed: HeldByOrder });

const batchRows = 10000;
const backfillAttrs = z.object({ table: z.string(), database: databaseName, totalRows: z.number() });

const copyBatch = H.command('copy-batch')
  .input(z.object({ database: databaseName, table: z.string(), offset: z.number(), limit: z.number() }))
  .argv(i => ['./bin/backfill', i.database, i.table, String(i.offset), String(i.limit)])
  .output(z.object({ copied: z.number(), done: z.boolean() }))
  .runner(runner);

const BackfillRequested = H.state('BackfillRequested', 'pending');
const Copying = H.state('Copying', 'active');
const Backfilled = H.terminal('Backfilled', 'success');
const BackfillFailed = H.terminal('BackfillFailed', 'failure');

const Backfill = H.kind('Backfill')
  .attributes(backfillAttrs)
  .states(BackfillRequested, Copying, Backfilled, BackfillFailed)
  .key(a => `${a.database}.${a.table}`)
  .initial(BackfillRequested);

const backfillFlow = H.flow('backfill')
  .input(backfillAttrs)
  .loop(
    'batches',
    f =>
      f.step(
        'copyBatch',
        copyBatch,
        ctx => ({
          database: ctx.unit.attributes.database,
          table: ctx.unit.attributes.table,
          offset: ctx.iteration * batchRows,
          limit: batchRows,
        }),
        { afterCrash: 'rerun', retry: { maxAttempts: 3, backoff: 'exponential', initialDelayMs: 5000 } },
      ),
    { max: ctx => Math.ceil(ctx.unit.attributes.totalRows / batchRows), until: ctx => ctx.steps.copyBatch.done },
  )
  .exit('backfilled');

const backfills = H.lane('backfills', Backfill)
  .supply(H.operator)
  .store(unitStore)
  .handler(backfillFlow, { exits: { backfilled: Backfilled }, during: { copyBatch: Copying } })
  .retry({ maxAttempts: 3, backoff: 'exponential', initialDelayMs: 60000, exhausted: BackfillFailed })
  .lease(u => ({ resource: databases[u.attributes.database], mode: 'shared' }));

const gpuHours = H.metric('gpu-hours-in-flight', H.when.step(evals, 'gpu')).amounts(e => [{ amount: e.durationMs / 3600000 }]);

const scheduler = H.scheduler('ml-platform')
  .priority(migrations, backfills, evals)
  .wip(evals, 2)
  .wip(backfills, 4)
  .admit(backfills, ctx =>
    ctx.metrics.leases({ resource: databases[ctx.unit.attributes.database], window: { lastHours: 1 } }).medianWaitMs < 600000,
  );

void H.harness('ml-platform')
  .ledger(sqlite.ledger({ path: './.harness/ledger.sqlite' }))
  .lanes(evals, migrations, backfills)
  .metrics(gpuHours)
  .scheduler(scheduler)
  .clients(
    http.controlApi('platform-control', {
      port: H.slot.port(1),
      token: H.env('CONTROL_TOKEN'),
      grants: [H.ops.workRead, H.ops.workCreate, H.ops.attemptsRecover, H.ops.telemetryRead],
    }),
  )
  .observers(markdown.board({ path: './BOARD.md' }), markdown.telemetry({ path: './TELEMETRY.md' }))
  .start();
