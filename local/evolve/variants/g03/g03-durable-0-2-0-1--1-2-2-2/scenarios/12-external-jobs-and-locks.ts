import { z } from 'zod';
import { H } from 'harness-dsl';
import { anthropic } from 'harness-dsl/anthropic';
import { claudeCode } from 'harness-dsl/claude-code';
import { sqlite } from 'harness-dsl/sqlite';
import { folder } from 'harness-dsl/folder';
import { local } from 'harness-dsl/local';
import { ssh } from 'harness-dsl/ssh';
import { markdown } from 'harness-dsl/markdown';

const quota = sqlite.quota('ml-quota', { path: '/srv/ml/quota.sqlite' });
const apiAccount = anthropic.account('ml-api', { apiKey: H.env('ANTHROPIC_API_KEY'), quota });
const sonnet = anthropic.model('sonnet', { id: 'claude-sonnet-4-5' });
const pool = H.pool('ml').accounts(apiAccount);

const localRunner = local.runner('ml-platform').slots(4);
const dbRunner = ssh.host('db-admin', { host: 'db-admin.internal', user: 'deploy', key: H.env('DB_ADMIN_SSH_KEY') }).slots(4);

const store = sqlite.store({ path: '/srv/ml/store.sqlite' });

const evalAttrs = z.object({ checkpoint: z.string(), suite: z.string() });

const EvalQueued = H.state('eval-queued', 'pending');
const EvalScored = H.terminal('eval-scored', 'success');
const EvalFailed = H.terminal('eval-failed', 'failure');

const evalKind = H.kind('eval-run')
  .attributes(evalAttrs)
  .states(EvalQueued, EvalScored, EvalFailed)
  .key(a => `${a.checkpoint}-${a.suite}`)
  .initial(EvalQueued);

const prepare = H.command('prepare-eval')
  .input(evalAttrs)
  .argv(i => ['eval', 'prepare', i.checkpoint, i.suite])
  .output(z.object({ bundle: z.string() }))
  .runner(localRunner);

const submitEval = H.command('submit-gpu-eval')
  .input(z.object({ bundle: z.string() }))
  .argv(i => ['gpu', 'submit', i.bundle])
  .output(z.object({ jobId: z.string() }))
  .runner(localRunner);

const collectEval = H.command('collect-gpu-eval')
  .input(z.object({ jobId: z.string() }))
  .argv(i => ['gpu', 'status', i.jobId])
  .output(H.jobPoll(z.object({ resultsUri: z.string() })))
  .runner(localRunner);

const gpuEval = H.job('gpu-eval', { submit: submitEval, collect: collectEval, pollEveryMinutes: 10 });

const score = H.command('score-eval')
  .input(z.object({ resultsUri: z.string() }))
  .argv(i => ['eval', 'score', i.resultsUri])
  .output(z.object({ score: z.number(), report: z.string() }))
  .runner(localRunner);

const analystRole = H.role('eval-analyst').intents('read').instructions('Summarize an evaluation report for the team.');
const summarizer = H.seat('eval-summarizer').role(analystRole).model(sonnet).pool(pool);

const evalFlow = H.flow('eval-run')
  .input(evalAttrs)
  .step('prepare', prepare, ctx => ctx.unit.attributes, { afterCrash: 'rerun' })
  .job('evaluate', gpuEval, ctx => ({ bundle: ctx.steps.prepare.bundle }))
  .step('score', score, ctx => ({ resultsUri: ctx.steps.evaluate.resultsUri }), { afterCrash: 'rerun' })
  .step(
    'summarize',
    summarizer,
    ctx => ({ task: `Summarize eval of ${ctx.unit.attributes.checkpoint} on ${ctx.unit.attributes.suite}: ${ctx.steps.score.report}` }),
    { afterCrash: 'rerun' },
  )
  .exit('scored');

const evals = H.lane('eval-runs', evalKind)
  .supply(H.operator)
  .handler(evalFlow, { exits: { scored: EvalScored } })
  .store(store)
  .retry({ maxAttempts: 2, backoff: 'exponential', initialDelayMs: 600_000, exhausted: EvalFailed });

const databases = H.resources('database', ['orders', 'analytics']);

const migrationAttrs = z.object({ id: z.string(), database: databases.schema, file: z.string() });

const MigrationQueued = H.state('migration-queued', 'pending');
const HeldByPredecessor = H.state('held-by-predecessor', 'waiting');
const Applied = H.terminal('applied', 'success');
const MigrationFailed = H.terminal('migration-failed', 'failure');

const migrationKind = H.kind('migration')
  .attributes(migrationAttrs)
  .states(MigrationQueued, HeldByPredecessor, Applied, MigrationFailed)
  .key(a => a.id)
  .initial(MigrationQueued);

const applyMigration = H.command('apply-migration')
  .input(z.object({ database: databases.schema, file: z.string() }))
  .argv(i => ['migrate', 'apply', i.database, i.file])
  .runner(dbRunner);

const migrationFlow = H.flow('migration')
  .input(migrationAttrs)
  .step('apply', applyMigration, ctx => ({ database: ctx.unit.attributes.database, file: ctx.unit.attributes.file }), {
    afterCrash: 'park',
  })
  .exit('applied');

const predecessorResolved = H.signal('predecessor-resolved');

const migrations = H.lane('migrations', migrationKind)
  .supply(folder.files({ path: '/srv/ml/migrations', glob: '*.sql' }), (file, to) => {
    const database = databases.schema.safeParse(file.name.split('-')[1]);
    return database.success ? to.create({ id: file.name.slice(0, 4), database: database.data, file: file.path }) : to.skip();
  })
  .handler(migrationFlow, { exits: { applied: Applied } })
  .retry({ maxAttempts: 1, exhausted: MigrationFailed })
  .lease(u => ({ resource: databases.get(u.attributes.database), mode: 'exclusive' }))
  .after({
    key: a => (Number(a.id) <= 1 ? undefined : String(Number(a.id) - 1).padStart(4, '0')),
    onPredecessorFailed: HeldByPredecessor,
  })
  .on(predecessorResolved, { enter: MigrationQueued });

const backfillAttrs = z.object({ table: z.string(), database: databases.schema });

const BackfillQueued = H.state('backfill-queued', 'pending');
const Backfilled = H.terminal('backfilled', 'success');
const BackfillFailed = H.terminal('backfill-failed', 'failure');

const backfillKind = H.kind('backfill')
  .attributes(backfillAttrs)
  .states(BackfillQueued, Backfilled, BackfillFailed)
  .key(a => `${a.database}.${a.table}`)
  .initial(BackfillQueued);

const backfillBatch = H.command('backfill-batch')
  .input(z.object({ database: databases.schema, table: z.string(), offset: z.number(), limit: z.number() }))
  .argv(i => ['backfill', i.database, i.table, String(i.offset), String(i.limit)])
  .output(z.object({ rowsCopied: z.number() }))
  .runner(dbRunner);

const backfillFlow = H.flow('backfill')
  .input(backfillAttrs)
  .loop(
    'batches',
    { schema: z.object({ offset: z.number() }), initial: { offset: 0 } },
    f =>
      f.step(
        'batch',
        backfillBatch,
        ctx => ({
          database: ctx.unit.attributes.database,
          table: ctx.unit.attributes.table,
          offset: ctx.steps.batches.offset,
          limit: 10_000,
        }),
        { afterCrash: 'rerun' },
      ),
    {
      until: ctx => ctx.steps.batch.rowsCopied < 10_000,
      next: ctx => ({ offset: ctx.steps.batches.offset + ctx.steps.batch.rowsCopied }),
    },
  )
  .exit('done');

const backfills = H.lane('backfills', backfillKind)
  .supply(H.operator)
  .handler(backfillFlow, { exits: { done: Backfilled } })
  .store(store)
  .retry({ maxAttempts: 3, backoff: 'exponential', initialDelayMs: 60_000, exhausted: BackfillFailed })
  .lease(u => ({ resource: databases.get(u.attributes.database), mode: 'shared' }));

const scheduler = H.scheduler('ml-platform')
  .standard(evals, migrations, backfills)
  .wip(evals, 2)
  .admit(evals, ctx => ctx.metrics.jobs({ job: gpuEval, window: { calendar: 'day' } }).hoursInFlight < 48)
  .admit(backfills, ctx => {
    const waits = ctx.metrics.leases({ resource: databases.get(ctx.unit.attributes.database), window: { lastHours: 1 } });
    return waits.samples < 5 || waits.medianWaitMs < 600_000;
  });

const supervisor = claudeCode.supervisor('ml-supervisor', {
  grants: [H.ops.workRead, H.ops.workCreate, H.ops.workSignal, H.ops.attemptsRecover, H.ops.telemetryRead],
  port: H.slot.port(1),
});

const harness = H.harness('ml-platform')
  .ledger(sqlite.ledger({ path: '/srv/ml/ledger.sqlite' }))
  .lanes(evals, migrations, backfills)
  .scheduler(scheduler)
  .clients(supervisor)
  .observers(markdown.board({ path: '/srv/ml/board.md' }), markdown.telemetry({ path: '/srv/ml/telemetry.md' }));

void harness.start();
