import { z } from 'zod';
import { H } from 'harness-dsl';
import { sqlite } from 'harness-dsl/sqlite';
import { anthropic } from 'harness-dsl/anthropic';
import { folder } from 'harness-dsl/folder';
import { http } from 'harness-dsl/http';
import { local } from 'harness-dsl/local';
import { markdown } from 'harness-dsl/markdown';

const quota = sqlite.quota('ml-quota', { path: './.harness/quota.sqlite' });
const api = anthropic.account('anthropic-api', { apiKey: H.env('ANTHROPIC_API_KEY'), quota });
const sonnet = anthropic.model('sonnet', { id: 'claude-sonnet-4-5' });
const pool = H.pool('ml-pool').accounts(api);
const localRunner = local.runner('local').slots(4);
const units = sqlite.store({ path: './.harness/units.sqlite' });

const databases = H.resources('database', ['orders', 'analytics', 'billing']);

const evalAttrs = z.object({ evalId: z.string(), model: z.string(), dataset: z.string() });

const EvalQueued = H.state('eval-queued', 'pending');
const EvalScored = H.terminal('eval-scored', 'success');
const EvalFailed = H.terminal('eval-failed', 'failure');

const evalRun = H.kind('EvalRun')
  .attributes(evalAttrs)
  .states(EvalQueued, EvalScored, EvalFailed)
  .key(a => a.evalId)
  .initial(EvalQueued);

const prepare = H.command('prepare-eval')
  .input(z.object({ evalId: z.string(), dataset: z.string() }))
  .argv(i => ['evals', 'prepare', i.evalId, i.dataset])
  .output(z.object({ bundle: z.string() }))
  .runner(localRunner);

const gpuEval = H.job('gpu-eval', {
  submit: H.command('submit-gpu-eval')
    .input(z.object({ bundle: z.string(), model: z.string() }))
    .argv(i => ['gpu', 'submit', '--bundle', i.bundle, '--model', i.model])
    .output(z.object({ jobId: z.string() }))
    .runner(localRunner),
  collect: H.command('poll-gpu-eval')
    .input(z.object({ jobId: z.string() }))
    .argv(i => ['gpu', 'status', i.jobId])
    .output(H.jobPoll(z.object({ scoresPath: z.string() })))
    .runner(localRunner),
  pollEveryMinutes: 10,
});

const score = H.command('score-eval')
  .input(z.object({ scoresPath: z.string() }))
  .argv(i => ['evals', 'score', i.scoresPath])
  .runner(localRunner);

const analystRole = H.role('eval-analyst').intents('read').instructions('Summarize the evaluation scores for the team.');
const summarizer = H.seat('eval-summarizer').role(analystRole).model(sonnet).pool(pool);

const evalFlow = H.flow('eval-run')
  .input(evalAttrs)
  .step('prepare', prepare, ctx => ({ evalId: ctx.unit.attributes.evalId, dataset: ctx.unit.attributes.dataset }), { afterCrash: 'rerun' })
  .job('gpu', gpuEval, ctx => ({ bundle: ctx.steps.prepare.bundle, model: ctx.unit.attributes.model }))
  .step('score', score, ctx => ({ scoresPath: ctx.steps.gpu.scoresPath }), { afterCrash: 'rerun' })
  .step('summarize', summarizer, ctx => ({ task: `Summarize eval ${ctx.unit.attributes.evalId}:\n${ctx.steps.score.stdout}` }), {
    afterCrash: 'rerun',
  })
  .exit('scored');

const evals = H.lane('evals', evalRun)
  .supply(H.operator)
  .store(units)
  .handler(evalFlow, { exits: { scored: EvalScored } })
  .retry({ maxAttempts: 2, backoff: 'exponential', initialDelayMs: 600_000, exhausted: EvalFailed });

const migrationAttrs = z.object({ id: z.string(), name: z.string(), database: databases.schema, path: z.string() });

const MigrationQueued = H.state('migration-queued', 'pending');
const HeldForPredecessor = H.state('held-for-predecessor', 'waiting');
const Applied = H.terminal('applied', 'success');
const MigrationFailed = H.terminal('migration-failed', 'failure');

const migration = H.kind('Migration')
  .attributes(migrationAttrs)
  .states(MigrationQueued, HeldForPredecessor, Applied, MigrationFailed)
  .key(a => a.id)
  .initial(MigrationQueued);

const migrate = H.command('apply-migration')
  .input(z.object({ database: databases.schema, path: z.string() }))
  .argv(i => ['migrate', '--database', i.database, '--file', i.path])
  .runner(localRunner);

const migrationFlow = H.flow('apply-migration')
  .input(migrationAttrs)
  .step('migrate', migrate, ctx => ({ database: ctx.unit.attributes.database, path: ctx.unit.attributes.path }), { afterCrash: 'park' })
  .exit('applied');

const migrations = H.lane('migrations', migration)
  .supply(folder.files({ path: './migrations', glob: '*.sql' }), (file, to) => {
    const [id, database] = file.name.split('_');
    const parsed = databases.schema.safeParse(database);
    return id === undefined || !parsed.success
      ? to.skip()
      : to.create({ id, name: file.name, database: parsed.data, path: file.path });
  })
  .store(units)
  .handler(migrationFlow, { exits: { applied: Applied } })
  .retry({ maxAttempts: 1, exhausted: MigrationFailed });

const backfillAttrs = z.object({ database: databases.schema, table: z.string(), totalRows: z.number() });

const BackfillRequested = H.state('backfill-requested', 'pending');
const BackfillDone = H.terminal('backfill-done', 'success');
const BackfillFailed = H.terminal('backfill-failed', 'failure');

const backfill = H.kind('Backfill')
  .attributes(backfillAttrs)
  .states(BackfillRequested, BackfillDone, BackfillFailed)
  .key(a => `${a.database}.${a.table}`)
  .initial(BackfillRequested);

const copyBatch = H.command('backfill-batch')
  .input(z.object({ database: databases.schema, table: z.string(), fromRow: z.number(), rows: z.number() }))
  .argv(i => ['backfill', '--database', i.database, '--table', i.table, '--from', String(i.fromRow), '--rows', String(i.rows)])
  .output(z.object({ nextRow: z.number() }))
  .runner(localRunner);

const backfillFlow = H.flow('backfill')
  .input(backfillAttrs)
  .loop(
    'batches',
    { schema: z.object({ fromRow: z.number() }), initial: { fromRow: 0 } },
    batches => batches.step(
      'batch',
      copyBatch,
      ctx => ({
        database: ctx.unit.attributes.database,
        table: ctx.unit.attributes.table,
        fromRow: ctx.steps.batches.fromRow,
        rows: 10_000,
      }),
      { afterCrash: 'rerun' },
    ),
    {
      until: ctx => ctx.steps.batch.nextRow >= ctx.unit.attributes.totalRows,
      next: ctx => ({ fromRow: ctx.steps.batch.nextRow }),
    },
  )
  .exit('done');

const backfills = H.lane('backfills', backfill)
  .supply(H.operator)
  .store(units)
  .handler(backfillFlow, { exits: { done: BackfillDone } })
  .retry({ maxAttempts: 3, backoff: 'exponential', initialDelayMs: 120_000, exhausted: BackfillFailed });

function previousMigration(id: string): string | undefined {
  const number = Number(id);
  return number > 1 ? String(number - 1).padStart(id.length, '0') : undefined;
}

const scheduler = H.scheduler('ml-platform')
  .standard(evals, migrations, backfills)
  .wip(evals, 2)
  .admit(evals, ctx => ctx.metrics.jobs({ job: gpuEval, window: { calendar: 'day' } }).hoursInFlight < 48)
  .lease(migrations, unit => ({ resource: databases.get(unit.attributes.database), mode: 'exclusive' }))
  .lease(backfills, unit => ({ resource: databases.get(unit.attributes.database), mode: 'shared' }))
  .order(migrations, { after: attrs => previousMigration(attrs.id), onPredecessorFailed: HeldForPredecessor });

const operator = http.controlApi('ml-operator', {
  port: H.slot.port(1),
  token: H.env('ML_OPERATOR_TOKEN'),
  grants: [H.ops.workRead, H.ops.workCreate, H.ops.workCancel, H.ops.attemptsRecover, H.ops.telemetryRead],
});

void H.harness('ml-platform')
  .ledger(sqlite.ledger({ path: './.harness/ledger.sqlite' }))
  .lanes(evals, migrations, backfills)
  .scheduler(scheduler)
  .clients(operator)
  .observers(markdown.board({ path: './.harness/board.md' }), markdown.telemetry({ path: './.harness/telemetry.md' }))
  .start();
