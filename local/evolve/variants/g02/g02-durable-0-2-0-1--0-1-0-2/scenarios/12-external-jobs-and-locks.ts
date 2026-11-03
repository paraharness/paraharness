import { z } from 'zod';
import { H, Resource } from 'harness-dsl';
import { sqlite } from 'harness-dsl/sqlite';
import { anthropic } from 'harness-dsl/anthropic';
import { folder } from 'harness-dsl/folder';
import { local } from 'harness-dsl/local';
import { http } from 'harness-dsl/http';
import { markdown } from 'harness-dsl/markdown';

const store = sqlite.store({ path: 'data/units.sqlite' });
const quota = sqlite.quota('ml-quota', { path: 'data/quota.sqlite' });
const apiAccount = anthropic.account('api', { apiKey: H.env('ANTHROPIC_API_KEY'), quota });
const sonnet = anthropic.model('sonnet', { id: 'claude-sonnet-4-5' });
const pool = H.pool('api').accounts(apiAccount);
const shell = local.runner('ml-shell').slots(4);

const databaseName = z.enum(['users', 'orders', 'events']);
type DatabaseName = z.infer<typeof databaseName>;

const databases: { readonly [K in DatabaseName]: Resource } = {
  users: H.resource('database-users'),
  orders: H.resource('database-orders'),
  events: H.resource('database-events'),
};

const evalAttributes = z.object({ runId: z.string(), model: z.string(), suite: z.string() });

const prepareEval = H.command('prepare-eval')
  .input(evalAttributes)
  .argv(i => ['eval', 'prepare', i.runId, i.model, i.suite])
  .output(z.object({ config: z.string() }))
  .runner(shell);

const submitGpuJob = H.command('submit-gpu-job')
  .input(z.object({ runId: z.string(), config: z.string() }))
  .argv(i => ['gpu', 'submit', '--run', i.runId, '--config', i.config])
  .output(z.object({ jobId: z.string() }))
  .runner(shell);

const pollGpuJob = H.command('poll-gpu-job')
  .input(z.object({ jobId: z.string() }))
  .argv(handle => ['gpu', 'status', handle.jobId])
  .output(H.jobPoll(z.object({ resultsUri: z.string() })))
  .runner(shell);

const gpuEval = H.job('gpu-eval', { submit: submitGpuJob, collect: pollGpuJob, pollEveryMinutes: 10 });

const scoreEval = H.command('score-eval')
  .input(z.object({ resultsUri: z.string() }))
  .argv(i => ['eval', 'score', i.resultsUri])
  .output(z.object({ score: z.number(), report: z.string() }))
  .runner(shell);

const evalSummarizer = H.seat('eval-summarizer')
  .output(z.object({ summary: z.string() }))
  .role(H.role('eval-summarizer').intents('read').instructions('Summarise the evaluation result for the team.'))
  .model(sonnet)
  .pool(pool);

const Queued = H.state('Queued', 'pending');
const Preparing = H.state('Preparing', 'active');
const OnGpu = H.state('OnGpu', 'waiting');
const Scoring = H.state('Scoring', 'active');
const Scored = H.terminal('Scored', 'success');
const EvalFailed = H.terminal('EvalFailed', 'failure');

const EvalRun = H.kind('EvalRun')
  .attributes(evalAttributes)
  .states(Queued, Preparing, OnGpu, Scoring, Scored, EvalFailed)
  .key(a => a.runId)
  .initial(Queued);

const runEval = H.flow('run-eval')
  .input(evalAttributes)
  .step('prepare', prepareEval, ctx => ctx.unit.attributes, { afterCrash: 'rerun' })
  .job('gpu', gpuEval, ctx => ({ runId: ctx.unit.attributes.runId, config: ctx.steps.prepare.config }), { afterCrash: 'park' })
  .step('score', scoreEval, ctx => ({ resultsUri: ctx.steps.gpu.resultsUri }), { afterCrash: 'rerun' })
  .step('summarize', evalSummarizer, ctx => ({
    task: `Summarise ${ctx.unit.attributes.model} on ${ctx.unit.attributes.suite}: score ${ctx.steps.score.score}. ${ctx.steps.score.report}`,
  }), { afterCrash: 'rerun' })
  .exit('scored');

const evalRuns = H.lane('eval-runs', EvalRun)
  .supply(H.operator)
  .store(store)
  .handler(runEval, {
    exits: { scored: Scored },
    during: { prepare: Preparing, score: Scoring, summarize: Scoring, gpu: OnGpu },
  })
  .retry({ maxAttempts: 2, backoff: 'exponential', initialDelayMs: 600000, exhausted: EvalFailed });

const migrationAttributes = z.object({ file: z.string(), sequence: z.number(), database: databaseName });

const MigrationQueued = H.state('MigrationQueued', 'pending');
const Held = H.state('Held', 'waiting');
const Migrating = H.state('Migrating', 'active');
const Applied = H.terminal('Applied', 'success');
const MigrationFailed = H.terminal('MigrationFailed', 'failure');

const Migration = H.kind('Migration')
  .attributes(migrationAttributes)
  .states(MigrationQueued, Held, Migrating, Applied, MigrationFailed)
  .key(a => a.file)
  .initial(MigrationQueued);

const applyMigration = H.command('apply-migration')
  .input(migrationAttributes)
  .argv(i => ['migrate', 'apply', '--database', i.database, i.file])
  .runner(shell);

const migrate = H.flow('migrate')
  .input(migrationAttributes)
  .step('apply', applyMigration, ctx => ctx.unit.attributes, { afterCrash: 'park' })
  .exit('applied');

const migrations = H.lane('migrations', Migration)
  .supply(folder.files({ path: 'migrations', glob: '*.sql' }), (file, to) => {
    const match = /^(\d+)-([a-z]+)-/.exec(file.name);
    if (match === null) {
      return to.skip();
    }
    const database = databaseName.safeParse(match[2]);
    return database.success
      ? to.create({ file: file.path, sequence: Number.parseInt(match[1], 10), database: database.data })
      : to.skip();
  })
  .store(store)
  .handler(migrate, { exits: { applied: Applied }, during: { apply: Migrating } })
  .retry({ maxAttempts: 1, backoff: 'fixed', initialDelayMs: 0, exhausted: MigrationFailed })
  .order({ within: a => databases[a.database], sequence: a => a.sequence, from: 1, held: Held })
  .lease(unit => ({ resource: databases[unit.attributes.database], mode: 'exclusive' }));

const backfillAttributes = z.object({ table: z.string(), database: databaseName, totalRows: z.number() });

const BackfillQueued = H.state('BackfillQueued', 'pending');
const Backfilling = H.state('Backfilling', 'active');
const Backfilled = H.terminal('Backfilled', 'success');
const BackfillFailed = H.terminal('BackfillFailed', 'failure');

const Backfill = H.kind('Backfill')
  .attributes(backfillAttributes)
  .states(BackfillQueued, Backfilling, Backfilled, BackfillFailed)
  .key(a => `${a.database}.${a.table}`)
  .initial(BackfillQueued);

const backfillBatch = H.command('backfill-batch')
  .input(z.object({ database: databaseName, table: z.string(), offset: z.number(), limit: z.number() }))
  .argv(i => ['backfill', '--database', i.database, '--table', i.table, '--offset', String(i.offset), '--limit', String(i.limit)])
  .runner(shell);

const batchRows = 10000;

const backfill = H.flow('backfill')
  .input(backfillAttributes)
  .loop(
    'batches',
    f =>
      f.step('batch', backfillBatch, ctx => ({
        database: ctx.unit.attributes.database,
        table: ctx.unit.attributes.table,
        offset: ctx.iteration * batchRows,
        limit: batchRows,
      }), { afterCrash: 'rerun', retry: { maxAttempts: 3, backoff: 'exponential', initialDelayMs: 5000 } }),
    { max: ctx => Math.ceil(ctx.unit.attributes.totalRows / batchRows) },
  )
  .exit('backfilled');

const backfills = H.lane('backfills', Backfill)
  .supply(H.operator)
  .store(store)
  .handler(backfill, { exits: { backfilled: Backfilled }, during: { batch: Backfilling } })
  .retry({ maxAttempts: 3, backoff: 'exponential', initialDelayMs: 60000, exhausted: BackfillFailed })
  .lease(unit => ({ resource: databases[unit.attributes.database], mode: 'shared' }));

const gpuHours = H.metric('gpu-hours', H.when.step(evalRuns, 'gpu'))
  .amounts(ended => [{ amount: ended.durationMs / 3600000 }]);

const operations = http.controlApi('ml-operations', {
  port: H.slot.port(1),
  token: H.env('CONTROL_API_TOKEN'),
  grants: [H.ops.workRead, H.ops.workCreate, H.ops.workCancel, H.ops.attemptsRecover, H.ops.telemetryRead],
});

const harness = H.harness('ml-platform')
  .ledger(sqlite.ledger({ path: 'data/ledger.sqlite' }))
  .lanes(evalRuns, migrations, backfills)
  .metrics(gpuHours)
  .scheduler(H.scheduler('ml-scheduler').priority(migrations, backfills, evalRuns).wip(evalRuns, 2).wip(backfills, 2))
  .clients(operations)
  .observers(markdown.board({ path: 'data/board.md' }), markdown.telemetry({ path: 'data/telemetry.md' }));

void harness.start();
