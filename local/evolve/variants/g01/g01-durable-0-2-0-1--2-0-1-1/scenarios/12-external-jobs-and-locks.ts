import { z } from 'zod';
import { H } from 'harness-dsl';
import { anthropic } from 'harness-dsl/anthropic';
import { claudeCode } from 'harness-dsl/claude-code';
import { sqlite } from 'harness-dsl/sqlite';
import { folder } from 'harness-dsl/folder';
import { local } from 'harness-dsl/local';
import { ssh } from 'harness-dsl/ssh';
import { markdown } from 'harness-dsl/markdown';

const apiAccount = anthropic.account('anthropic-api', { apiKey: H.env('ANTHROPIC_API_KEY') });
const sonnet = anthropic.model('sonnet', { id: 'claude-sonnet-4-5' });
const pool = H.pool('api').accounts(apiAccount);
const workstation = local.runner('ml-workstation').slots(4);
const dbAdmin = ssh.host('db-admin', { host: 'db-admin.internal', user: 'deploy', key: H.env('DB_ADMIN_SSH_KEY') }).slots(4);
const store = sqlite.store({ path: '.harness/units.sqlite' });

const ordersDb = H.resource('orders-db');
const billingDb = H.resource('billing-db');
const databaseName = z.enum(['orders', 'billing']);
const databases = { orders: ordersDb, billing: billingDb };

const evalAttributes = z.object({ evalId: z.string(), checkpoint: z.string(), suite: z.string() });

const evalQueued = H.state('queued', 'pending');
const preparing = H.state('preparing', 'active');
const onGpu = H.state('onGpu', 'waiting');
const scoring = H.state('scoring', 'active');
const summarizing = H.state('summarizing', 'active');
const scored = H.terminal('scored', 'success');
const evalFailed = H.terminal('evalFailed', 'failure');
const evalWithdrawn = H.terminal('withdrawn', 'neutral');

const evalKind = H.kind('EvalRun')
  .attributes(evalAttributes)
  .states(evalQueued, preparing, onGpu, scoring, summarizing, scored, evalFailed, evalWithdrawn)
  .key(a => a.evalId)
  .initial(evalQueued);

const prepare = H.command('prepare-eval')
  .input(evalAttributes)
  .argv(i => ['eval', 'prepare', i.evalId, i.checkpoint, i.suite])
  .output(z.object({ artifact: z.string() }))
  .runner(workstation);

const submitGpuJob = H.command('submit-gpu-job')
  .input(z.object({ evalId: z.string(), artifact: z.string() }))
  .argv(i => ['gpu', 'submit', '--name', i.evalId, i.artifact])
  .output(z.object({ jobId: z.string() }))
  .runner(workstation);

const pollGpuJob = H.command('poll-gpu-job')
  .input(z.object({ jobId: z.string() }))
  .argv(i => ['gpu', 'status', '--json', i.jobId])
  .output(H.jobPoll(z.object({ resultsUri: z.string() })))
  .runner(workstation);

const score = H.command('score-eval')
  .input(z.object({ resultsUri: z.string() }))
  .argv(i => ['eval', 'score', i.resultsUri])
  .output(z.object({ score: z.number(), report: z.string() }))
  .runner(workstation);

const analystRole = H.role('eval-analyst').intents('read').instructions('Summarise an evaluation run for the model team.');
const analyst = H.seat('eval-analyst').role(analystRole).model(sonnet).pool(pool).output(z.object({ summary: z.string() }));

const evalFlow = H.flow('eval-run')
  .input(evalAttributes)
  .step('prepare', prepare, ctx => ctx.unit.attributes, { afterCrash: 'rerun' })
  .job('evaluate', {
    submit: submitGpuJob,
    input: ctx => ({ evalId: ctx.unit.attributes.evalId, artifact: ctx.steps.prepare.artifact }),
    collect: pollGpuJob,
    pollEveryMinutes: 10,
  })
  .step('score', score, ctx => ({ resultsUri: ctx.steps.evaluate.resultsUri }), { afterCrash: 'rerun' })
  .step('summarize', analyst, ctx => ({ task: `Eval ${ctx.unit.attributes.evalId} scored ${ctx.steps.score.score}.\n\n${ctx.steps.score.report}` }), {
    afterCrash: 'rerun',
  })
  .exit('scored');

const evalRuns = H.lane('eval-runs', evalKind)
  .supply(H.operator)
  .store(store)
  .handler(evalFlow, {
    exits: { scored },
    during: { prepare: preparing, evaluate: onGpu, score: scoring, summarize: summarizing },
    cancelled: evalWithdrawn,
  })
  .retry({ maxAttempts: 2, backoff: 'exponential', initialDelayMs: 600000, exhausted: evalFailed });

const migrationAttributes = z.object({ sequence: z.number(), name: z.string(), database: databaseName, file: z.string() });
const sequenceKey = (sequence: number) => String(sequence).padStart(4, '0');

const migrationQueued = H.state('queued', 'pending');
const migrating = H.state('migrating', 'active');
const heldByPredecessor = H.state('heldByPredecessor', 'waiting');
const applied = H.terminal('applied', 'success');
const migrationFailed = H.terminal('migrationFailed', 'failure');
const migrationWithdrawn = H.terminal('withdrawn', 'neutral');

const migrationKind = H.kind('Migration')
  .attributes(migrationAttributes)
  .states(migrationQueued, migrating, heldByPredecessor, applied, migrationFailed, migrationWithdrawn)
  .key(a => sequenceKey(a.sequence))
  .initial(migrationQueued);

const applyMigration = H.command('apply-migration')
  .input(z.object({ database: databaseName, file: z.string() }))
  .argv(i => ['migrate', 'apply', '--database', i.database, i.file])
  .runner(dbAdmin);

const migrationFlow = H.flow('migration')
  .input(migrationAttributes)
  .step('apply', applyMigration, ctx => ({ database: ctx.unit.attributes.database, file: ctx.unit.attributes.file }), { afterCrash: 'park' })
  .exit('applied');

const migrations = H.lane('migrations', migrationKind)
  .supply(folder.files({ path: 'migrations', glob: '*.sql' }), (file, to) => {
    const [sequence, database, ...rest] = file.name.replace(/\.sql$/, '').split('-');
    const parsed = databaseName.safeParse(database);
    return parsed.success
      ? to.create({ sequence: Number(sequence), database: parsed.data, name: rest.join('-'), file: file.path })
      : to.skip();
  })
  .store(store)
  .handler(migrationFlow, { exits: { applied }, during: { apply: migrating }, cancelled: migrationWithdrawn })
  .retry({ maxAttempts: 1, exhausted: migrationFailed })
  .lease(unit => ({ resource: databases[unit.attributes.database], mode: 'exclusive' }))
  .after({
    key: a => (a.sequence > 1 ? sequenceKey(a.sequence - 1) : undefined),
    onPredecessorFailed: heldByPredecessor,
  });

const backfillAttributes = z.object({ table: z.string(), database: databaseName });

const backfillQueued = H.state('queued', 'pending');
const backfilling = H.state('backfilling', 'active');
const backfilled = H.terminal('backfilled', 'success');
const backfillFailed = H.terminal('backfillFailed', 'failure');
const backfillWithdrawn = H.terminal('withdrawn', 'neutral');

const backfillKind = H.kind('Backfill')
  .attributes(backfillAttributes)
  .states(backfillQueued, backfilling, backfilled, backfillFailed, backfillWithdrawn)
  .key(a => `${a.database}.${a.table}`)
  .initial(backfillQueued);

const countRows = H.command('count-rows')
  .input(backfillAttributes)
  .argv(i => ['backfill', 'count', '--database', i.database, i.table])
  .output(z.object({ rows: z.number() }))
  .runner(dbAdmin);

const backfillBatch = H.command('backfill-batch')
  .input(z.object({ database: databaseName, table: z.string(), offset: z.number(), limit: z.number() }))
  .argv(i => ['backfill', 'batch', '--database', i.database, i.table, String(i.offset), String(i.limit)])
  .output(z.object({ rowsWritten: z.number() }))
  .runner(dbAdmin);

const batchRows = 10000;

const backfillFlow = H.flow('backfill')
  .input(backfillAttributes)
  .step('count', countRows, ctx => ctx.unit.attributes, { afterCrash: 'rerun' })
  .loop(
    'batches',
    f =>
      f.step('batch', backfillBatch, ctx => ({
        database: ctx.unit.attributes.database,
        table: ctx.unit.attributes.table,
        offset: ctx.iteration * batchRows,
        limit: batchRows,
      }), { afterCrash: 'rerun', retry: { maxAttempts: 3, backoff: 'exponential', initialDelayMs: 5000 } }),
    {
      max: ctx => Math.max(1, Math.ceil(ctx.steps.count.rows / batchRows)),
      until: ctx => ctx.steps.batch.rowsWritten < batchRows,
    },
  )
  .exit('backfilled');

const backfills = H.lane('backfills', backfillKind)
  .supply(H.operator)
  .store(store)
  .handler(backfillFlow, { exits: { backfilled }, during: { count: backfilling, batch: backfilling }, cancelled: backfillWithdrawn })
  .retry({ maxAttempts: 3, backoff: 'exponential', initialDelayMs: 60000, exhausted: backfillFailed })
  .lease(unit => ({ resource: databases[unit.attributes.database], mode: 'shared' }));

const gpuHours = H.metric('gpu-hours', H.when.step(evalRuns, 'evaluate')).amounts(e => [{ amount: e.durationMs / 3600000 }]);

const scheduler = H.scheduler('ml-platform')
  .priority(migrations, backfills, evalRuns)
  .wip(evalRuns, 2)
  .admit(evalRuns, ctx => ctx.metrics.total(gpuHours, { window: { calendar: 'day' } }).total < 200)
  .admit(backfills, ctx => ctx.metrics.leases({ resource: databases[ctx.unit.attributes.database], window: { lastHours: 1 } }).medianWaitMs < 600000);

const supervisor = H.client('platform-supervisor', {
  transport: claudeCode.mcp('platform-mcp', { port: H.slot.port(1) }),
  grants: [H.ops.workRead, H.ops.workCreate, H.ops.workCancel, H.ops.attemptsRecover, H.ops.telemetryRead],
});

export const harness = H.harness('ml-platform')
  .ledger(sqlite.ledger({ path: '.harness/ledger.sqlite' }))
  .lanes(evalRuns, migrations, backfills)
  .metrics(gpuHours)
  .scheduler(scheduler)
  .clients(supervisor)
  .observers(markdown.board({ path: 'BOARD.md' }), markdown.telemetry({ path: 'TELEMETRY.md' }));
