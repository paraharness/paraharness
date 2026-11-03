import { z } from 'zod';
import { H } from 'harness-dsl';
import { sqlite } from 'harness-dsl/sqlite';
import { anthropic } from 'harness-dsl/anthropic';
import { claudeCode } from 'harness-dsl/claude-code';
import { folder } from 'harness-dsl/folder';
import { local } from 'harness-dsl/local';
import { ssh } from 'harness-dsl/ssh';
import { markdown } from 'harness-dsl/markdown';

const quota = sqlite.quota('ml-quota', { path: '.harness/quota.sqlite' });
const apiAccount = anthropic.account('api', { apiKey: H.env('ANTHROPIC_API_KEY'), quota });
const sonnet = anthropic.model('sonnet', { id: 'claude-sonnet-4-5' });
const pool = H.pool('api').accounts(apiAccount);
const localRunner = local.runner('local').slots(4);
const sshKey = H.env('DB_SSH_KEY');
const ordersHost = ssh.host('orders-host', { host: 'orders-db.internal', user: 'ops', key: sshKey });
const billingHost = ssh.host('billing-host', { host: 'billing-db.internal', user: 'ops', key: sshKey });
const harnessStore = sqlite.store({ path: '.harness/units.sqlite' });
const resume = H.signal('resume');

const databaseName = z.enum(['orders', 'billing']);
const databases = { orders: H.resource('orders-db'), billing: H.resource('billing-db') };
const migrationKey = (database: string, n: number) => `${database}/${String(n).padStart(4, '0')}`;

const evalAttrs = z.object({ runId: z.string(), candidate: z.string(), suite: z.string() });
const EvalQueued = H.state('eval-queued', 'pending');
const Preparing = H.state('preparing', 'active');
const OnGpu = H.state('on-gpu', 'waiting');
const Scoring = H.state('scoring', 'active');
const Summarizing = H.state('summarizing', 'active');
const EvalNeedsAttention = H.state('eval-needs-attention', 'waiting');
const Evaluated = H.terminal('evaluated', 'success');
const EvalCancelled = H.terminal('eval-cancelled', 'neutral');

const EvalRun = H.kind('EvalRun')
  .attributes(evalAttrs)
  .states(EvalQueued, Preparing, OnGpu, Scoring, Summarizing, EvalNeedsAttention, Evaluated, EvalCancelled)
  .key(a => a.runId);

const prepare = H.command('prepare-eval')
  .input(z.object({ candidate: z.string(), suite: z.string() }))
  .argv(i => ['./scripts/prepare', i.candidate, i.suite])
  .output(z.object({ bundle: z.string() }))
  .runner(localRunner);

const gpuSubmit = H.command('gpu-submit')
  .input(z.object({ bundle: z.string() }))
  .argv(i => ['./scripts/gpu-submit', i.bundle])
  .output(z.object({ jobId: z.string() }))
  .runner(localRunner);

const gpuStatus = H.command('gpu-status')
  .input(z.object({ jobId: z.string() }))
  .argv(i => ['./scripts/gpu-status', i.jobId])
  .output(
    z.object({
      state: z.enum(['running', 'succeeded', 'failed']),
      result: z.object({ artifact: z.string() }).optional(),
      reason: z.string().optional(),
    }),
  )
  .runner(localRunner);

const gpuEval = H.job('gpu-eval', { submit: gpuSubmit, collect: gpuStatus, pollEveryMinutes: 10 });

const score = H.command('score-eval')
  .input(z.object({ artifact: z.string() }))
  .argv(i => ['./scripts/score', i.artifact])
  .output(z.object({ score: z.number(), report: z.string() }))
  .runner(localRunner);

const evalAnalystRole = H.role('eval-analyst').intents('read').instructions('Summarise evaluation results for the team.');
const evalSummarizer = H.seat('eval-summarizer').role(evalAnalystRole).model(sonnet).pool(pool);

const evalFlow = H.flow('eval-run')
  .input(evalAttrs)
  .step('prepare', prepare, ctx => ({ candidate: ctx.unit.attributes.candidate, suite: ctx.unit.attributes.suite }), { afterCrash: 'rerun' })
  .job('gpu', gpuEval, ctx => ({ bundle: ctx.steps.prepare.bundle }))
  .step('score', score, ctx => ({ artifact: ctx.steps.gpu.artifact }), { afterCrash: 'rerun' })
  .step('summarize', evalSummarizer, ctx => ({
    task: `Summarise eval ${ctx.unit.attributes.runId} of ${ctx.unit.attributes.candidate}: score ${ctx.steps.score.score}.\n${ctx.steps.score.report}`,
  }))
  .exit('evaluated');

const evalLane = H.lane('evals', EvalRun)
  .supply(H.operator)
  .store(harnessStore)
  .handler(evalFlow, {
    exits: { evaluated: Evaluated },
    during: { prepare: Preparing, gpu: OnGpu, score: Scoring, summarize: Summarizing },
  })
  .retry({ maxAttempts: 2, backoff: 'exponential', initialDelayMs: 600_000, exhausted: EvalNeedsAttention })
  .on(resume, { enter: EvalQueued })
  .on(H.cancel, { enter: EvalCancelled });

const migrationAttrs = z.object({ database: databaseName, number: z.number(), file: z.string() });
const MigrationQueued = H.state('migration-queued', 'pending');
const Migrating = H.state('migrating', 'active');
const MigrationHeld = H.state('migration-held', 'waiting');
const Applied = H.terminal('applied', 'success');
const MigrationFailed = H.terminal('migration-failed', 'failure');
const MigrationAbandoned = H.terminal('migration-abandoned', 'neutral');

const Migration = H.kind('Migration')
  .attributes(migrationAttrs)
  .states(MigrationQueued, Migrating, MigrationHeld, Applied, MigrationFailed, MigrationAbandoned)
  .key(a => migrationKey(a.database, a.number));

const migrate = H.command('apply-migration')
  .input(z.object({ database: databaseName, file: z.string() }))
  .argv(i => ['./scripts/migrate', i.database, i.file])
  .runner(i => (i.database === 'orders' ? ordersHost : billingHost));

const migrationFlow = H.flow('migration')
  .input(migrationAttrs)
  .step('migrate', migrate, ctx => ({ database: ctx.unit.attributes.database, file: ctx.unit.attributes.file }), {
    afterCrash: 'park',
    lease: i => ({ resource: databases[i.database], mode: 'exclusive' }),
  })
  .exit('applied');

const migrationLane = H.lane('migrations', Migration)
  .supply(folder.files({ path: 'migrations', glob: '*/*.sql' }), (file, to) => {
    const database = databaseName.safeParse(file.path.split('/')[1]);
    const number = Number.parseInt(file.name.slice(0, 4), 10);
    return database.success && Number.isFinite(number) ? to.create({ database: database.data, number, file: file.path }) : to.skip();
  })
  .handler(migrationFlow, { exits: { applied: Applied }, during: { migrate: Migrating } })
  .retry({ maxAttempts: 1, backoff: 'fixed', initialDelayMs: 0, exhausted: MigrationFailed })
  .after({ key: a => (a.number > 1 ? migrationKey(a.database, a.number - 1) : undefined), held: MigrationHeld })
  .on(H.cancel, { enter: MigrationAbandoned });

const backfillAttrs = z.object({ database: databaseName, table: z.string(), totalRows: z.number() });
const BackfillQueued = H.state('backfill-queued', 'pending');
const Backfilling = H.state('backfilling', 'active');
const BackfillStuck = H.state('backfill-stuck', 'waiting');
const Backfilled = H.terminal('backfilled', 'success');
const BackfillCancelled = H.terminal('backfill-cancelled', 'neutral');

const Backfill = H.kind('Backfill')
  .attributes(backfillAttrs)
  .states(BackfillQueued, Backfilling, BackfillStuck, Backfilled, BackfillCancelled)
  .key(a => `${a.database}.${a.table}`);

const backfillBatch = H.command('backfill-batch')
  .input(z.object({ database: databaseName, table: z.string(), offset: z.number(), limit: z.number() }))
  .argv(i => ['./scripts/backfill', i.database, i.table, String(i.offset), String(i.limit)])
  .runner(i => (i.database === 'orders' ? ordersHost : billingHost));

const batchRows = 10_000;

const backfillFlow = H.flow('backfill')
  .input(backfillAttrs)
  .loop(
    'batches',
    batches =>
      batches.step(
        'batch',
        backfillBatch,
        ctx => ({ database: ctx.unit.attributes.database, table: ctx.unit.attributes.table, offset: ctx.iteration * batchRows, limit: batchRows }),
        { afterCrash: 'rerun', lease: i => ({ resource: databases[i.database], mode: 'shared' }) },
      ),
    { max: ctx => Math.ceil(ctx.unit.attributes.totalRows / batchRows) },
  )
  .exit('filled');

const backfillLane = H.lane('backfills', Backfill)
  .supply(H.operator)
  .store(harnessStore)
  .handler(backfillFlow, { exits: { filled: Backfilled }, during: { batch: Backfilling } })
  .retry({ maxAttempts: 3, backoff: 'exponential', initialDelayMs: 60_000, exhausted: BackfillStuck })
  .on(resume, { enter: BackfillQueued })
  .on(H.cancel, { enter: BackfillCancelled });

const gpuHours = H.metric('gpu-hours', H.when.step(evalLane, 'gpu')).amounts(e => [{ amount: e.durationMs / 3_600_000 }]);

const platform = claudeCode.supervisor('platform').client('ml-platform', {
  grants: [
    H.ops.workRead,
    H.ops.workCreate,
    H.ops.attemptsRecover,
    H.ops.signal(resume),
    H.ops.signal(H.cancel),
    H.ops.telemetryRead,
  ],
});

export const harness = H.harness('ml-platform')
  .ledger(sqlite.ledger({ path: '.harness/ledger.sqlite' }))
  .lanes(evalLane, migrationLane, backfillLane)
  .metrics(gpuHours)
  .scheduler(H.scheduler('ml-scheduler').priority(migrationLane, backfillLane, evalLane).wip(evalLane, 2))
  .clients(platform)
  .observers(markdown.board({ path: 'BOARD.md' }), markdown.telemetry({ path: 'TELEMETRY.md' }));

void harness.start();
