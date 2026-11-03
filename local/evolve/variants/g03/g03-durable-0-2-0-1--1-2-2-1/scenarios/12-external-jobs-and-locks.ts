import { z } from 'zod';
import { H } from 'harness-dsl';
import { sqlite } from 'harness-dsl/sqlite';
import { anthropic } from 'harness-dsl/anthropic';
import { folder } from 'harness-dsl/folder';
import { local } from 'harness-dsl/local';
import { ssh } from 'harness-dsl/ssh';
import { claudeCode } from 'harness-dsl/claude-code';
import { markdown } from 'harness-dsl/markdown';

const localRunner = local.runner('local');
const dbHost = ssh.host('db-admin', { host: 'db-admin.internal', user: 'ops', key: H.env('DB_ADMIN_SSH_KEY') }).slots(4);
const harnessStore = sqlite.store({ path: '.harness/store.db' });
const quota = sqlite.quota('ml-quota', { path: '.harness/quota.db' });
const apiAccount = anthropic.account('ml-api', { apiKey: H.env('ANTHROPIC_API_KEY'), quota });
const apiPool = H.pool('ml-api').accounts(apiAccount);
const sonnet = anthropic.model('sonnet', { id: 'claude-sonnet-4-5' });

const databases = H.resources('database', ['orders', 'users', 'billing']);

const evalSchema = z.object({ evalId: z.string(), checkpoint: z.string(), suite: z.string() });

const EvalQueued = H.state('EvalQueued', 'pending');
const EvalScored = H.terminal('EvalScored', 'success');
const EvalFailed = H.terminal('EvalFailed', 'failure');
const evalKind = H.kind('EvalRun')
  .attributes(evalSchema)
  .states(EvalQueued, EvalScored, EvalFailed)
  .key(a => a.evalId)
  .initial(EvalQueued);

const prepare = H.command('prepare-eval')
  .input(z.object({ evalId: z.string(), suite: z.string() }))
  .argv(i => ['./scripts/prepare-eval', i.evalId, i.suite])
  .runner(localRunner);

const submitJob = H.command('submit-gpu-eval')
  .input(z.object({ evalId: z.string(), checkpoint: z.string() }))
  .argv(i => ['gpuctl', 'submit', i.evalId, i.checkpoint])
  .output(z.object({ jobId: z.string() }))
  .runner(localRunner);

const collectJob = H.command('collect-gpu-eval')
  .input(z.object({ jobId: z.string() }))
  .argv(i => ['gpuctl', 'status', i.jobId])
  .output(H.jobPoll(z.object({ resultsUri: z.string(), gpuHours: z.number() })))
  .runner(localRunner);

const gpuEval = H.job('gpu-eval', { submit: submitJob, collect: collectJob, pollEveryMinutes: 10 });

const score = H.command('score-eval')
  .input(z.object({ resultsUri: z.string() }))
  .argv(i => ['./scripts/score', i.resultsUri])
  .output(z.object({ score: z.number(), breakdown: z.string() }))
  .runner(localRunner);

const analystRole = H.role('eval-analyst').intents('read').instructions('Summarise the evaluation scores for the research channel.');
const analyst = H.seat('eval-analyst').role(analystRole).model(sonnet).pool(apiPool);

const evaluate = H.flow('evaluate')
  .input(evalSchema)
  .step('prepare', prepare, ctx => ({ evalId: ctx.unit.attributes.evalId, suite: ctx.unit.attributes.suite }), { afterCrash: 'rerun' })
  .job('gpu', gpuEval, ctx => ({ evalId: ctx.unit.attributes.evalId, checkpoint: ctx.unit.attributes.checkpoint }))
  .step('score', score, ctx => ({ resultsUri: ctx.steps.gpu.resultsUri }), { afterCrash: 'rerun' })
  .step('summarize', analyst, ctx => ({
    task: `Summarise ${ctx.unit.attributes.checkpoint} on ${ctx.unit.attributes.suite}: score ${ctx.steps.score.score}\n${ctx.steps.score.breakdown}`,
  }), { afterCrash: 'rerun' })
  .exit('scored');

const evalLane = H.lane('evals', evalKind)
  .supply(H.operator)
  .handler(evaluate, { exits: { scored: EvalScored } })
  .store(harnessStore)
  .retry({ maxAttempts: 2, backoff: 'exponential', initialDelayMs: 600_000, exhausted: EvalFailed });

const migrationSchema = z.object({ id: z.string(), database: databases.schema, path: z.string() });

const MigrationQueued = H.state('MigrationQueued', 'pending');
const MigrationHeld = H.state('MigrationHeld', 'waiting');
const MigrationApplied = H.terminal('MigrationApplied', 'success');
const MigrationFailed = H.terminal('MigrationFailed', 'failure');
const migrationKind = H.kind('Migration')
  .attributes(migrationSchema)
  .states(MigrationQueued, MigrationHeld, MigrationApplied, MigrationFailed)
  .key(a => a.id)
  .initial(MigrationQueued);

const migrate = H.command('migrate')
  .input(z.object({ database: databases.schema, path: z.string() }))
  .argv(i => ['./scripts/migrate', i.database, i.path])
  .runner(dbHost);

const applyMigration = H.flow('apply-migration')
  .input(migrationSchema)
  .step('migrate', migrate, ctx => ({ database: ctx.unit.attributes.database, path: ctx.unit.attributes.path }), { afterCrash: 'park' })
  .exit('applied');

const migrationLane = H.lane('migrations', migrationKind)
  .supply(folder.files({ path: 'migrations', glob: '*.sql' }), (file, to) => {
    const [id, database] = file.name.split('-');
    const parsed = databases.schema.safeParse(database);
    return id && parsed.success ? to.create({ id, database: parsed.data, path: file.path }) : to.skip();
  })
  .handler(applyMigration, { exits: { applied: MigrationApplied } })
  .store(harnessStore)
  .retry({ maxAttempts: 1, exhausted: MigrationFailed });

function previousMigration(id: string) {
  const previous = Number(id) - 1;
  return previous < 1 ? undefined : String(previous).padStart(id.length, '0');
}

const backfillSchema = z.object({ table: z.string(), database: databases.schema });

const BackfillQueued = H.state('BackfillQueued', 'pending');
const BackfillDone = H.terminal('BackfillDone', 'success');
const BackfillFailed = H.terminal('BackfillFailed', 'failure');
const backfillKind = H.kind('Backfill')
  .attributes(backfillSchema)
  .states(BackfillQueued, BackfillDone, BackfillFailed)
  .key(a => `${a.database}.${a.table}`)
  .initial(BackfillQueued);

const copyBatch = H.command('backfill-batch')
  .input(z.object({ database: databases.schema, table: z.string(), offset: z.number(), limit: z.number() }))
  .argv(i => ['./scripts/backfill', i.database, i.table, String(i.offset), String(i.limit)])
  .output(z.object({ rows: z.number() }))
  .runner(dbHost);

const backfill = H.flow('backfill')
  .input(backfillSchema)
  .loop('batches', { schema: z.object({ offset: z.number() }), initial: { offset: 0 } }, f => f
    .step('copy', copyBatch, ctx => ({
      database: ctx.unit.attributes.database,
      table: ctx.unit.attributes.table,
      offset: ctx.steps.batches.offset,
      limit: 10_000,
    }), { afterCrash: 'rerun' }),
  {
    until: ctx => ctx.steps.copy.rows < 10_000,
    next: ctx => ({ offset: ctx.steps.batches.offset + 10_000 }),
  })
  .exit('filled');

const backfillLane = H.lane('backfills', backfillKind)
  .supply(H.operator)
  .handler(backfill, { exits: { filled: BackfillDone } })
  .store(harnessStore)
  .retry({ maxAttempts: 3, backoff: 'exponential', initialDelayMs: 60_000, exhausted: BackfillFailed });

const supervisor = claudeCode.supervisor('platform-supervisor', {
  grants: [H.ops.workRead, H.ops.workCreate, H.ops.workMove, H.ops.attemptsRecover, H.ops.telemetryRead],
  port: H.slot.port(1),
});

export const harness = H.harness('ml-platform')
  .ledger(sqlite.ledger({ path: '.harness/ledger.db' }))
  .lanes(evalLane, migrationLane, backfillLane)
  .scheduler(H.scheduler('ml-scheduler')
    .standard(migrationLane, evalLane, backfillLane)
    .wip(evalLane, 2)
    .lease(migrationLane, u => ({ resource: databases.get(u.attributes.database), mode: 'exclusive' }))
    .lease(backfillLane, u => ({ resource: databases.get(u.attributes.database), mode: 'shared' }))
    .order(migrationLane, { after: a => previousMigration(a.id), onPredecessorFailed: MigrationHeld }))
  .clients(supervisor)
  .observers(markdown.board({ path: 'BOARD.md' }), markdown.telemetry({ path: 'TELEMETRY.md' }));

void harness.start();
