import { H } from 'harness-dsl';
import { z } from 'zod';
import { sqlite } from 'harness-dsl/sqlite';
import { anthropic } from 'harness-dsl/anthropic';
import { claudeCode } from 'harness-dsl/claude-code';
import { folder } from 'harness-dsl/folder';
import { local } from 'harness-dsl/local';
import { ssh } from 'harness-dsl/ssh';
import { markdown } from 'harness-dsl/markdown';

const unitStore = sqlite.store({ path: './.harness/units.sqlite' });
const localRunner = local.runner('ml-local').slots(4);
const dbAdmin = ssh.host('db-admin', { host: 'db-admin.internal', user: 'deploy', key: H.env('DB_ADMIN_SSH_KEY') }).slots(4);

const databaseName = z.enum(['users', 'orders']);
const databases = { users: H.resource('users-db'), orders: H.resource('orders-db') };

const apiAccount = anthropic.account('ml-api', {
  apiKey: H.env('ANTHROPIC_API_KEY'),
  quota: sqlite.quota('ml-api', { path: './.harness/quota.sqlite' }),
});

const evalSummarizer = H.seat('eval-summarizer')
  .role(H.role('eval-summarizer').intents('read'))
  .model(anthropic.model('sonnet', { id: 'claude-sonnet-4-5' }))
  .pool(H.pool('ml-pool').accounts(apiAccount));

const evalAttrs = z.object({ name: z.string(), checkpoint: z.string(), suite: z.string() });

const EvalQueued = H.state('EvalQueued', 'pending');
const Scored = H.terminal('Scored', 'success');
const EvalFailed = H.terminal('EvalFailed', 'failure');

const EvalRun = H.kind('EvalRun').attributes(evalAttrs).states(EvalQueued, Scored, EvalFailed).key(a => a.name).initial(EvalQueued);

const prepare = H.command('prepare-eval')
  .input(z.object({ checkpoint: z.string(), suite: z.string() }))
  .argv(i => ['./eval/prepare', i.checkpoint, i.suite])
  .runner(localRunner);

const gpuEval = H.job('gpu-eval', {
  submit: H.command('submit-gpu-eval')
    .input(z.object({ checkpoint: z.string(), suite: z.string() }))
    .argv(i => ['./eval/submit', i.checkpoint, i.suite])
    .output(z.object({ jobId: z.string() }))
    .runner(localRunner),
  collect: H.command('poll-gpu-eval')
    .input(z.object({ jobId: z.string() }))
    .argv(i => ['./eval/poll', i.jobId])
    .output(H.jobPoll(z.object({ artifactUri: z.string(), accuracy: z.number() })))
    .runner(localRunner),
  pollEveryMinutes: 10,
});

const score = H.command('score-eval')
  .input(z.object({ name: z.string(), artifactUri: z.string() }))
  .argv(i => ['./eval/score', i.name, i.artifactUri])
  .runner(localRunner);

const evalFlow = H.flow('eval-run')
  .input(evalAttrs)
  .step('prepare', prepare, ctx => ({ checkpoint: ctx.unit.attributes.checkpoint, suite: ctx.unit.attributes.suite }))
  .job('evaluate', gpuEval, ctx => ({ checkpoint: ctx.unit.attributes.checkpoint, suite: ctx.unit.attributes.suite }))
  .step('score', score, ctx => ({ name: ctx.unit.attributes.name, artifactUri: ctx.steps.evaluate.artifactUri }))
  .step('summarize', evalSummarizer, ctx => ({
    task: `Summarize eval ${ctx.unit.attributes.name}: accuracy ${ctx.steps.evaluate.accuracy}.\n${ctx.steps.score.stdout}`,
  }))
  .exit('scored');

const evals = H.lane('evals', EvalRun)
  .supply(H.operator)
  .store(unitStore)
  .handler(evalFlow, {
    ends: { scored: Scored },
    retry: { maxAttempts: 2, backoff: 'exponential', initialDelayMs: 600_000, exhausted: EvalFailed },
  });

const migrationAttrs = z.object({
  key: z.string(),
  number: z.number().int(),
  database: databaseName,
  file: z.string(),
  previous: z.string().optional(),
});

const MigrationQueued = H.state('MigrationQueued', 'pending');
const AwaitingPredecessor = H.state('AwaitingPredecessor', 'waiting');
const Applied = H.terminal('Applied', 'success');
const MigrationFailed = H.terminal('MigrationFailed', 'failure');

const Migration = H.kind('Migration')
  .attributes(migrationAttrs)
  .states(MigrationQueued, AwaitingPredecessor, Applied, MigrationFailed)
  .key(a => a.key)
  .initial(MigrationQueued);

const migrationKey = (database: string, number: number): string => `${database}/${String(number).padStart(4, '0')}`;

const applyMigration = H.command('apply-migration')
  .input(z.object({ database: z.string(), file: z.string() }))
  .argv(i => ['./db/migrate', i.database, i.file])
  .runner(dbAdmin);

const migrationFlow = H.flow('migration')
  .input(migrationAttrs)
  .step('apply', applyMigration, ctx => ({ database: ctx.unit.attributes.database, file: ctx.unit.attributes.file }), {
    afterCrash: 'park',
  })
  .exit('applied');

const migrations = H.lane('migrations', Migration)
  .supply(folder.files({ path: './migrations', glob: '*/*.sql' }), (f, to) => {
    const [databaseSegment] = f.path.split('/').slice(-2);
    const database = databaseName.safeParse(databaseSegment);
    const number = Number.parseInt(f.name.slice(0, 4), 10);
    if (!database.success || Number.isNaN(number)) return to.skip();
    return to.create({
      key: migrationKey(database.data, number),
      number,
      database: database.data,
      file: f.path,
      previous: number > 1 ? migrationKey(database.data, number - 1) : undefined,
    });
  })
  .store(unitStore)
  .handler(migrationFlow, {
    ends: { applied: Applied },
    retry: { maxAttempts: 1, backoff: 'fixed', initialDelayMs: 0, exhausted: MigrationFailed },
    lease: unit => ({ resource: databases[unit.attributes.database], mode: 'exclusive' }),
    order: { after: a => a.previous, held: AwaitingPredecessor },
  });

const backfillAttrs = z.object({ database: databaseName, table: z.string(), totalRows: z.number().int() });

const BackfillQueued = H.state('BackfillQueued', 'pending');
const Filled = H.terminal('Filled', 'success');
const BackfillFailed = H.terminal('BackfillFailed', 'failure');

const Backfill = H.kind('Backfill')
  .attributes(backfillAttrs)
  .states(BackfillQueued, Filled, BackfillFailed)
  .key(a => `${a.database}.${a.table}`)
  .initial(BackfillQueued);

const backfillBatch = H.command('backfill-batch')
  .input(z.object({ database: z.string(), table: z.string(), offset: z.number(), limit: z.number() }))
  .argv(i => ['./db/backfill', i.database, i.table, String(i.offset), String(i.limit)])
  .runner(dbAdmin);

const rowsPerBatch = 10_000;

const backfillFlow = H.flow('backfill')
  .input(backfillAttrs)
  .loop(
    'batches',
    batches =>
      batches.step(
        'batch',
        backfillBatch,
        ctx => ({
          database: ctx.unit.attributes.database,
          table: ctx.unit.attributes.table,
          offset: ctx.iteration * rowsPerBatch,
          limit: rowsPerBatch,
        }),
        { afterCrash: 'rerun', retry: { maxAttempts: 3, backoff: 'exponential', initialDelayMs: 30_000 } },
      ),
    { max: ctx => Math.ceil(ctx.unit.attributes.totalRows / rowsPerBatch) },
  )
  .exit('filled');

const backfills = H.lane('backfills', Backfill)
  .supply(H.operator)
  .store(unitStore)
  .handler(backfillFlow, {
    ends: { filled: Filled },
    retry: { maxAttempts: 2, backoff: 'exponential', initialDelayMs: 300_000, exhausted: BackfillFailed },
    lease: unit => ({ resource: databases[unit.attributes.database], mode: 'shared' }),
  });

const gpuHoursInFlight = H.metric('gpu-hours-in-flight', H.when.step(evals, 'evaluate')).amounts(e => [
  { amount: e.durationMs / 3_600_000 },
]);

const scheduler = H.scheduler('ml-platform-scheduler')
  .priority(migrations, backfills, evals)
  .wip(evals, 2)
  .admit(backfills, ctx =>
    ctx.metrics.leases({ resource: databases[ctx.unit.attributes.database], window: { lastHours: 1 } }).medianWaitMs < 600_000,
  );

const platformDesk = claudeCode.supervisor('ml-platform').client('ml-platform-control', {
  port: H.slot.port(1),
  grants: [H.ops.workRead, H.ops.workCreate, H.ops.attemptsRecover, H.ops.telemetryRead],
});

export const harness = H.harness('ml-platform')
  .ledger(sqlite.ledger({ path: './.harness/ledger.sqlite' }))
  .lanes(evals, migrations, backfills)
  .metrics(gpuHoursInFlight)
  .scheduler(scheduler)
  .clients(platformDesk)
  .observers(markdown.board({ path: './.harness/board.md' }), markdown.telemetry({ path: './.harness/telemetry.md' }));
