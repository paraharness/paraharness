import { z } from 'zod';
import { H, type Metrics } from 'harness-dsl';
import { anthropic } from 'harness-dsl/anthropic';
import { sqlite } from 'harness-dsl/sqlite';
import { local } from 'harness-dsl/local';
import { ssh } from 'harness-dsl/ssh';
import { folder } from 'harness-dsl/folder';
import { claudeCode } from 'harness-dsl/claude-code';
import { markdown } from 'harness-dsl/markdown';

const apiAccount = anthropic.account('ml-api', {
  apiKey: H.env('ANTHROPIC_API_KEY'),
  quota: sqlite.quota('ml-api', { path: '.harness/quota.db' }),
});
const analyst = H.role('eval-analyst').intents('read').instructions('Summarise an evaluation run for the team.');
const analystSeat = H.seat('eval-analyst')
  .role(analyst)
  .model(anthropic.model('sonnet', { id: 'claude-sonnet-4-5' }))
  .pool(H.pool('ml').accounts(apiAccount));
const summarizeCall = H.call('summarize-eval', analystSeat);

const localRunner = local.runner('ml-local');
const dbHost = ssh.host('db-admin', { host: 'db-admin.internal', user: 'deploy', key: H.env('DB_ADMIN_SSH_KEY') });
const store = sqlite.store({ path: '.harness/units.db' });

const EvalAttrs = z.object({ runId: z.string(), checkpoint: z.string(), suite: z.string() });
const EvalQueued = H.state('EvalQueued', 'pending');
const EvalScored = H.terminal('EvalScored', 'success');
const EvalFailed = H.terminal('EvalFailed', 'failure');
const EvalRun = H.kind('EvalRun').attributes(EvalAttrs).states(EvalQueued, EvalScored, EvalFailed).key(attrs => attrs.runId).initial(EvalQueued);

const prepareEval = H.command('prepare-eval')
  .input(EvalAttrs)
  .argv(input => ['./eval/prepare', input.checkpoint, input.suite])
  .runner(localRunner);
const submitGpuJob = H.command('submit-gpu-job')
  .input(EvalAttrs)
  .argv(input => ['./eval/submit', input.checkpoint, input.suite])
  .output(z.object({ jobId: z.string() }))
  .runner(localRunner);
const pollGpuJob = H.command('poll-gpu-job')
  .input(z.object({ jobId: z.string() }))
  .argv(input => ['./eval/poll', input.jobId])
  .output(H.jobPoll(z.object({ resultsUri: z.string() })))
  .runner(localRunner);
const gpuEval = H.job('gpu-eval', { submit: submitGpuJob, collect: pollGpuJob, pollEveryMinutes: 10 });
const scoreEval = H.command('score-eval')
  .input(z.object({ resultsUri: z.string() }))
  .argv(input => ['./eval/score', input.resultsUri])
  .output(z.object({ accuracy: z.number(), report: z.string() }))
  .runner(localRunner);

const evalFlow = H.flow('eval-run')
  .input(EvalAttrs)
  .step('prepare', prepareEval, ctx => ctx.unit.attributes, { afterCrash: 'rerun' })
  .job('gpu', gpuEval, ctx => ctx.unit.attributes)
  .step('score', scoreEval, ctx => ({ resultsUri: ctx.steps.gpu.resultsUri }))
  .step('summarize', summarizeCall, ctx => ({
    text: `Summarise ${ctx.unit.attributes.runId}: accuracy ${ctx.steps.score.accuracy}.\n\n${ctx.steps.score.report}`,
  }))
  .exit('scored');

const evals = H.lane('evals', EvalRun)
  .supply(H.operator)
  .store(store)
  .handler(evalFlow, { exits: { scored: EvalScored } })
  .retry({ maxAttempts: 2, backoff: 'exponential', initialDelayMs: 600000, exhausted: EvalFailed });

const DatabaseName = z.enum(['orders', 'users']);
const databases = { orders: H.resource('orders-db'), users: H.resource('users-db') };

const MigrationAttrs = z.object({ number: z.number(), database: DatabaseName, file: z.string() });
const MigrationQueued = H.state('MigrationQueued', 'pending');
const MigrationHeld = H.state('MigrationHeld', 'waiting');
const MigrationApplied = H.terminal('MigrationApplied', 'success');
const MigrationFailed = H.terminal('MigrationFailed', 'failure');
const Migration = H.kind('Migration')
  .attributes(MigrationAttrs)
  .states(MigrationQueued, MigrationHeld, MigrationApplied, MigrationFailed)
  .key(attrs => String(attrs.number).padStart(4, '0'))
  .initial(MigrationQueued);

const applyMigration = H.command('apply-migration')
  .input(MigrationAttrs)
  .argv(input => ['./db/migrate', input.database, input.file])
  .runner(dbHost);

const migrationFlow = H.flow('apply-migration')
  .input(MigrationAttrs)
  .step('apply', applyMigration, ctx => ctx.unit.attributes, { afterCrash: 'park' })
  .exit('applied');

const migrations = H.lane('migrations', Migration)
  .supply(folder.files({ path: 'db/migrations', glob: '*.sql' }), (file, to) => {
    const match = /^(\d{4})-([a-z]+)-/.exec(file.name);
    const database = DatabaseName.safeParse(match?.[2]);
    if (match === null || !database.success) return to.skip();
    return to.create({ number: Number(match[1]), database: database.data, file: file.path });
  })
  .store(store)
  .handler(migrationFlow, { exits: { applied: MigrationApplied } })
  .retry({ maxAttempts: 1, exhausted: MigrationFailed })
  .lease(unit => ({ resource: databases[unit.attributes.database], mode: 'exclusive' }))
  .after({
    key: attrs => (attrs.number > 1 ? String(attrs.number - 1).padStart(4, '0') : undefined),
    onPredecessorFailed: MigrationHeld,
  });

const BackfillAttrs = z.object({ table: z.string(), database: DatabaseName, totalRows: z.number() });
const BackfillQueued = H.state('BackfillQueued', 'pending');
const BackfillDone = H.terminal('BackfillDone', 'success');
const BackfillFailed = H.terminal('BackfillFailed', 'failure');
const Backfill = H.kind('Backfill')
  .attributes(BackfillAttrs)
  .states(BackfillQueued, BackfillDone, BackfillFailed)
  .key(attrs => attrs.table)
  .initial(BackfillQueued);

const backfillBatch = H.command('backfill-batch')
  .input(z.object({ table: z.string(), database: DatabaseName, offset: z.number(), limit: z.number() }))
  .argv(input => ['./db/backfill', input.database, input.table, String(input.offset), String(input.limit)])
  .output(z.object({ rows: z.number(), done: z.boolean() }))
  .runner(dbHost);

const backfillFlow = H.flow('backfill')
  .input(BackfillAttrs)
  .loop(
    'batches',
    batch =>
      batch.step(
        'batch',
        backfillBatch,
        ctx => ({ table: ctx.unit.attributes.table, database: ctx.unit.attributes.database, offset: ctx.iteration * 10000, limit: 10000 }),
        { afterCrash: 'rerun' },
      ),
    {
      max: ctx => Math.ceil(ctx.unit.attributes.totalRows / 10000),
      until: ctx => ctx.steps.batch.done,
    },
  )
  .exit('done');

const backfills = H.lane('backfills', Backfill)
  .supply(H.operator)
  .store(store)
  .handler(backfillFlow, { exits: { done: BackfillDone } })
  .retry({ maxAttempts: 3, backoff: 'exponential', initialDelayMs: 300000, exhausted: BackfillFailed })
  .lease(unit => ({ resource: databases[unit.attributes.database], mode: 'shared' }));

export const platformReport = (metrics: Metrics) => ({
  gpuInFlightToday: metrics.jobs({ job: gpuEval, window: { calendar: 'day' } }),
  ordersLockWaits: metrics.leases({ resource: databases.orders, window: { lastDays: 1 } }),
  usersLockWaits: metrics.leases({ resource: databases.users, window: { lastDays: 1 } }),
});

export const harness = H.harness('ml-platform')
  .ledger(sqlite.ledger({ path: '.harness/ledger.db' }))
  .lanes(evals, migrations, backfills)
  .scheduler(H.scheduler('ml-platform').standard(migrations, backfills, evals).wip(evals, 2))
  .clients(
    claudeCode.supervisor('platform-supervisor', {
      port: H.slot.port(1),
      grants: [H.ops.workRead, H.ops.workCreate, H.ops.attemptsRecover, H.ops.telemetryRead],
    }),
  )
  .observers(markdown.board({ path: 'BOARD.md' }), markdown.telemetry({ path: 'TELEMETRY.md' }));
