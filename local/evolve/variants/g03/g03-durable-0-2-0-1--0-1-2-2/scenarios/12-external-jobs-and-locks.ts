import { z } from 'zod';
import { H } from 'harness-dsl';
import { anthropic } from 'harness-dsl/anthropic';
import { claudeCode } from 'harness-dsl/claude-code';
import { sqlite } from 'harness-dsl/sqlite';
import { folder } from 'harness-dsl/folder';
import { local } from 'harness-dsl/local';
import { ssh } from 'harness-dsl/ssh';
import { markdown } from 'harness-dsl/markdown';

const harnessStore = sqlite.store({ path: '/srv/ml/units.sqlite' });
const workstation = local.runner('ml-workstation').slots(4);
const databaseHost = ssh.host('database-admin', { host: 'db-admin.internal', user: 'deploy', key: H.env('DB_ADMIN_SSH_KEY') }).slots(4);

const apiAccount = anthropic.account('ml-api', {
  apiKey: H.env('ANTHROPIC_API_KEY'),
  quota: sqlite.quota('ml-api', { path: '/srv/ml/quota.sqlite' }),
});
const sonnet = anthropic.model('sonnet', { id: 'claude-sonnet-4-5' });

const summarizer = H.seat('eval-summarizer')
  .role(H.role('eval-summarizer').intents('read').instructions('Summarise the evaluation result for the model team.'))
  .model(sonnet)
  .pool(H.pool('ml').accounts(apiAccount));

const databaseName = z.enum(['orders', 'billing', 'analytics']);
const database = H.resources('database', databaseName.options);

const evalAttrs = z.object({ suite: z.string(), checkpoint: z.string() });
const evalResult = z.object({ accuracy: z.number(), examples: z.number() });

const EvalQueued = H.state('EvalQueued', 'pending');
const Scored = H.terminal('Scored', 'success');
const EvalFailed = H.terminal('EvalFailed', 'failure');
const EvalRun = H.kind('EvalRun').attributes(evalAttrs).states(EvalQueued, Scored, EvalFailed).initial(EvalQueued);

const prepareEval = H.command('prepare-eval')
  .input(evalAttrs)
  .argv(run => ['./eval/prepare.sh', run.suite, run.checkpoint])
  .runner(workstation);

const submitEval = H.command('submit-gpu-eval')
  .input(evalAttrs)
  .argv(run => ['./eval/submit.sh', run.suite, run.checkpoint])
  .output(z.object({ jobId: z.string() }))
  .runner(workstation);

const collectEval = H.command('collect-gpu-eval')
  .input(z.object({ jobId: z.string() }))
  .argv(handle => ['./eval/status.sh', handle.jobId])
  .output(H.jobPoll(evalResult))
  .runner(workstation);

const gpuEval = H.job('gpu-eval', { submit: submitEval, collect: collectEval, pollEveryMinutes: 10 });

const scoreEval = H.command('score-eval')
  .input(evalResult)
  .argv(result => ['./eval/score.sh', String(result.accuracy), String(result.examples)])
  .output(z.object({ score: z.number() }))
  .runner(workstation);

const evaluate = H.flow('evaluate')
  .input(evalAttrs)
  .step('prepare', prepareEval, ctx => ctx.unit.attributes, { afterCrash: 'rerun' })
  .job('gpu', gpuEval, ctx => ctx.unit.attributes)
  .step('score', scoreEval, ctx => ctx.steps.gpu, { afterCrash: 'rerun' })
  .step('summarize', summarizer, ctx => ({
    task: `Summarise ${ctx.unit.attributes.suite} on ${ctx.unit.attributes.checkpoint}: accuracy ${ctx.steps.gpu.accuracy}, score ${ctx.steps.score.score}.`,
  }))
  .exit('scored');

const evals = H.lane('evals', EvalRun)
  .supply(H.operator)
  .handler(evaluate, { exits: { scored: Scored } })
  .store(harnessStore)
  .retry({ maxAttempts: 2, backoff: 'fixed', initialDelayMs: 900_000, exhausted: EvalFailed });

const migrationAttrs = z.object({ number: z.string(), database: databaseName, file: z.string() });

const MigrationQueued = H.state('MigrationQueued', 'pending');
const HeldForPredecessor = H.state('HeldForPredecessor', 'waiting');
const Applied = H.terminal('Applied', 'success');
const MigrationFailed = H.terminal('MigrationFailed', 'failure');
const Migration = H.kind('Migration')
  .attributes(migrationAttrs)
  .states(MigrationQueued, HeldForPredecessor, Applied, MigrationFailed)
  .key(attrs => attrs.number)
  .initial(MigrationQueued);

const applyMigration = H.command('apply-migration')
  .input(migrationAttrs)
  .argv(migration => ['./db/migrate.sh', migration.database, migration.file])
  .runner(databaseHost);

const migrate = H.flow('migrate')
  .input(migrationAttrs)
  .step('apply', applyMigration, ctx => ctx.unit.attributes, { afterCrash: 'park' })
  .exit('applied');

const migrations = H.lane('migrations', Migration)
  .supply(folder.files({ path: 'migrations', glob: '*.sql' }), (file, to) => {
    const parts = file.name.split('-');
    const number = parts[0] ?? '';
    const target = database.parse(parts[1] ?? '');
    return target === undefined || number === '' ? to.skip() : to.create({ number, database: target.value, file: file.path });
  })
  .handler(migrate, { exits: { applied: Applied } })
  .store(harnessStore)
  .retry({ maxAttempts: 1, exhausted: MigrationFailed })
  .lease(unit => ({ resource: database.of(unit.attributes.database), mode: 'exclusive' }))
  .after({
    key: attrs => (Number(attrs.number) <= 1 ? undefined : String(Number(attrs.number) - 1).padStart(4, '0')),
    onPredecessorFailed: HeldForPredecessor,
  });

const backfillAttrs = z.object({ database: databaseName, table: z.string(), rows: z.number() });

const BackfillQueued = H.state('BackfillQueued', 'pending');
const Filled = H.terminal('Filled', 'success');
const BackfillFailed = H.terminal('BackfillFailed', 'failure');
const Backfill = H.kind('Backfill')
  .attributes(backfillAttrs)
  .states(BackfillQueued, Filled, BackfillFailed)
  .key(attrs => `${attrs.database}.${attrs.table}`)
  .initial(BackfillQueued);

const rowsPerBatch = 10_000;

const copyBatch = H.command('copy-batch')
  .input(z.object({ database: z.string(), table: z.string(), offset: z.number(), limit: z.number() }))
  .argv(batch => ['./db/backfill.sh', batch.database, batch.table, String(batch.offset), String(batch.limit)])
  .runner(databaseHost);

const backfill = H.flow('backfill')
  .input(backfillAttrs)
  .loop(
    'batches',
    body =>
      body.step(
        'copy',
        copyBatch,
        ctx => ({
          database: ctx.unit.attributes.database,
          table: ctx.unit.attributes.table,
          offset: ctx.iteration * rowsPerBatch,
          limit: rowsPerBatch,
        }),
        { afterCrash: 'rerun', retry: { maxAttempts: 3, backoff: 'exponential', initialDelayMs: 30_000 } },
      ),
    { max: ctx => Math.ceil(ctx.unit.attributes.rows / rowsPerBatch) },
  )
  .exit('filled');

const backfills = H.lane('backfills', Backfill)
  .supply(H.operator)
  .handler(backfill, { exits: { filled: Filled } })
  .store(harnessStore)
  .retry({ maxAttempts: 2, backoff: 'fixed', initialDelayMs: 600_000, exhausted: BackfillFailed })
  .lease(unit => ({ resource: database.of(unit.attributes.database), mode: 'shared' }));

const platformSupervisor = claudeCode.supervisor('platform-supervisor', {
  port: H.slot.port(1),
  grants: [H.ops.workRead, H.ops.workCreate, H.ops.attemptsRecover, H.ops.telemetryRead],
});

export const harness = H.harness('ml-platform')
  .ledger(sqlite.ledger({ path: '/srv/ml/ledger.sqlite' }))
  .lanes(evals, migrations, backfills)
  .scheduler(H.scheduler('ml-platform').standard(migrations, backfills, evals).wip(evals, 2))
  .clients(platformSupervisor)
  .observers(markdown.board({ path: '/srv/ml/BOARD.md' }), markdown.telemetry({ path: '/srv/ml/TELEMETRY.md' }));

void harness.start();
