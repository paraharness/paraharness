import { z } from 'zod';
import { H } from 'harness-dsl';
import { sqlite } from 'harness-dsl/sqlite';
import { anthropic } from 'harness-dsl/anthropic';
import { claudeCode } from 'harness-dsl/claude-code';
import { folder } from 'harness-dsl/folder';
import { local } from 'harness-dsl/local';
import { markdown } from 'harness-dsl/markdown';

const workstation = local.runner('ml-box').slots(4);
const store = sqlite.store({ path: './.harness/units.sqlite' });

const api = anthropic.account('ml-api', {
  apiKey: H.env('ANTHROPIC_API_KEY'),
  quota: sqlite.quota('ml-quota', { path: './.harness/quota.sqlite' }),
});
const pool = H.pool('ml-pool').accounts(api);
const sonnet = anthropic.model('sonnet', { id: 'claude-sonnet-4-5' });

const NeedsOwner = H.state('NeedsOwner', 'waiting');

const Queued = H.state('Queued', 'pending');
const Scored = H.terminal('Scored', 'success');
const EvalFailed = H.terminal('EvalFailed', 'failure');

const evalAttrs = z.object({ runId: z.string(), checkpoint: z.string(), suite: z.string() });
const evalRun = H.kind('EvalRun').attributes(evalAttrs).states(Queued, Scored, EvalFailed).key(a => a.runId);

const prepare = H.command('prepare-eval')
  .input(z.object({ checkpoint: z.string(), suite: z.string() }))
  .argv(i => ['./scripts/prepare.sh', i.checkpoint, i.suite])
  .output(z.object({ bundle: z.string() }))
  .runner(workstation);

const submitGpuJob = H.command('submit-gpu-job')
  .input(z.object({ bundle: z.string() }))
  .argv(i => ['./scripts/gpu-submit.sh', i.bundle])
  .output(z.object({ jobId: z.string() }))
  .runner(workstation);

const pollGpuJob = H.command('poll-gpu-job')
  .input(z.object({ jobId: z.string() }))
  .argv(i => ['./scripts/gpu-status.sh', i.jobId])
  .output(H.jobPoll(z.object({ resultsUri: z.string() })))
  .runner(workstation);

const gpuEval = H.job('gpu-eval', { submit: submitGpuJob, collect: pollGpuJob, pollEveryMinutes: 10 });

const score = H.command('score-eval')
  .input(z.object({ resultsUri: z.string() }))
  .argv(i => ['./scripts/score.sh', i.resultsUri])
  .output(z.object({ score: z.number(), report: z.string() }))
  .runner(workstation);

const analyst = H.role('eval-analyst').intents('read').instructions('Summarise the evaluation result for the research team.');
const summarizer = H.seat('eval-summarizer')
  .role(analyst)
  .model(sonnet)
  .pool(pool)
  .output(z.object({ summary: z.string() }));

const evalFlow = H.flow('eval-run')
  .input(evalAttrs)
  .step('prepare', prepare, ctx => ({ checkpoint: ctx.unit.attributes.checkpoint, suite: ctx.unit.attributes.suite }), { afterCrash: 'rerun' })
  .job('gpu', gpuEval, ctx => ({ bundle: ctx.steps.prepare.bundle }))
  .step('score', score, ctx => ({ resultsUri: ctx.steps.gpu.resultsUri }), { afterCrash: 'rerun' })
  .step('summarize', summarizer, ctx => ({ task: `Run ${ctx.unit.attributes.runId}, score ${ctx.steps.score.score}.\n\n${ctx.steps.score.report}` }))
  .exit('scored');

const evalRuns = H.lane('eval-runs', evalRun)
  .supply(H.operator)
  .store(store)
  .handler(evalFlow, { exits: { scored: Scored } })
  .retry({ maxAttempts: 2, backoff: 'exponential', initialDelayMs: 600000, exhausted: EvalFailed });

const databaseName = z.enum(['orders', 'billing', 'catalog']);
const databases = {
  orders: H.resource('orders-db'),
  billing: H.resource('billing-db'),
  catalog: H.resource('catalog-db'),
};

const Pending = H.state('Pending', 'pending');
const HeldByPredecessor = H.state('HeldByPredecessor', 'waiting');
const Applied = H.terminal('Applied', 'success');
const MigrationFailed = H.terminal('MigrationFailed', 'failure');

const migrationAttrs = z.object({
  number: z.string(),
  file: z.string(),
  database: databaseName,
  previous: z.string().optional(),
});
const migration = H.kind('Migration')
  .attributes(migrationAttrs)
  .states(Pending, HeldByPredecessor, Applied, MigrationFailed)
  .key(a => a.number);

const migrate = H.command('apply-migration')
  .input(z.object({ file: z.string(), database: databaseName }))
  .argv(i => ['./scripts/migrate.sh', i.database, i.file])
  .runner(workstation);

const migrationFlow = H.flow('migration')
  .input(migrationAttrs)
  .step('migrate', migrate, ctx => ({ file: ctx.unit.attributes.file, database: ctx.unit.attributes.database }), { afterCrash: 'park' })
  .exit('applied');

const migrations = H.lane('migrations', migration)
  .supply(folder.files({ path: './migrations', glob: '*.sql' }), (file, to) => {
    const match = /^(\d{4})-([a-z]+)-/.exec(file.name);
    if (match === null) return to.skip();
    const database = databaseName.safeParse(match[2]);
    if (!database.success) return to.skip();
    const number = Number(match[1]);
    return to.create({
      number: match[1],
      file: file.path,
      database: database.data,
      previous: number > 1 ? String(number - 1).padStart(4, '0') : undefined,
    });
  })
  .store(store)
  .handler(migrationFlow, { exits: { applied: Applied } })
  .retry({ maxAttempts: 1, exhausted: MigrationFailed })
  .lease(unit => ({ resource: databases[unit.attributes.database], mode: 'exclusive' }))
  .after({ key: a => a.previous, onPredecessorFailed: HeldByPredecessor });

const BackfillQueued = H.state('BackfillQueued', 'pending');
const Backfilled = H.terminal('Backfilled', 'success');
const BackfillFailed = H.terminal('BackfillFailed', 'failure');

const backfillAttrs = z.object({ table: z.string(), database: databaseName, totalRows: z.number() });
const backfill = H.kind('Backfill')
  .attributes(backfillAttrs)
  .states(BackfillQueued, NeedsOwner, Backfilled, BackfillFailed)
  .key(a => `${a.database}.${a.table}`);

const backfillBatch = H.command('backfill-batch')
  .input(z.object({ database: databaseName, table: z.string(), offset: z.number(), limit: z.number() }))
  .argv(i => ['./scripts/backfill.sh', i.database, i.table, String(i.offset), String(i.limit)])
  .output(z.object({ rows: z.number() }))
  .runner(workstation);

const batchSize = 10000;

const backfillFlow = H.flow('backfill')
  .input(backfillAttrs)
  .loop('batches', z.object({ rows: z.number() }), batch => batch
    .step('batch', backfillBatch, ctx => ({
      database: ctx.unit.attributes.database,
      table: ctx.unit.attributes.table,
      offset: ctx.steps.batches.reduce((sum, b) => sum + b.rows, 0),
      limit: batchSize,
    }), { afterCrash: 'rerun' }),
  {
    max: ctx => Math.ceil(ctx.unit.attributes.totalRows / batchSize) + 1,
    until: ctx => ctx.steps.batch.rows < batchSize,
    feed: ctx => ({ rows: ctx.steps.batch.rows }),
  })
  .exit('done');

const backfills = H.lane('backfills', backfill)
  .supply(H.operator)
  .store(store)
  .handler(backfillFlow, { exits: { done: Backfilled } })
  .retry({ maxAttempts: 3, backoff: 'exponential', initialDelayMs: 300000, exhausted: NeedsOwner })
  .lease(unit => ({ resource: databases[unit.attributes.database], mode: 'shared' }));

const platformSupervisor = claudeCode.supervisor('ml-platform-supervisor', {
  port: H.slot.port(0),
  grants: [H.ops.workRead, H.ops.workCreate, H.ops.workCancel, H.ops.attemptsRecover, H.ops.telemetryRead],
});

export default H.harness('ml-platform')
  .ledger(sqlite.ledger({ path: './.harness/ledger.sqlite' }))
  .lanes(evalRuns, migrations, backfills)
  .scheduler(H.scheduler('ml-scheduler')
    .standard(migrations, backfills, evalRuns)
    .wip(evalRuns, 2))
  .clients(platformSupervisor)
  .observers(
    markdown.board({ path: './.harness/BOARD.md' }),
    markdown.telemetry({ path: './.harness/TELEMETRY.md' }),
  );
