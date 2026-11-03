import { z } from 'zod';
import { H } from 'harness-dsl';
import { sqlite } from 'harness-dsl/sqlite';
import { anthropic } from 'harness-dsl/anthropic';
import { folder } from 'harness-dsl/folder';
import { local } from 'harness-dsl/local';
import { http } from 'harness-dsl/http';
import { markdown } from 'harness-dsl/markdown';

const databases = H.resources('database', ['orders', 'users', 'billing']);

const localRunner = local.runner('local').slots(4);
const harnessStore = sqlite.store({ path: '.harness/units.sqlite' });

const quota = sqlite.quota('ml-quota', { path: '.harness/quota.sqlite' });
const apiAccount = anthropic.account('anthropic-api', { apiKey: H.env('ANTHROPIC_API_KEY'), quota });
const sonnet = anthropic.model('sonnet', { id: 'claude-sonnet-4-5' });
const pool = H.pool('ml-pool').accounts(apiAccount);

const analystRole = H.role('eval-analyst').intents('read').instructions('Summarize evaluation results for the team.');

const summarizer = H.seat('eval-summarizer')
  .role(analystRole)
  .model(sonnet)
  .pool(pool)
  .output(z.object({ summary: z.string() }));

const prepare = H.command('prepare-eval')
  .input(z.object({ model: z.string(), suite: z.string() }))
  .argv(input => ['evals', 'prepare', input.model, input.suite])
  .output(z.object({ config: z.string() }))
  .runner(localRunner);

const gpuSubmit = H.command('gpu-submit')
  .input(z.object({ config: z.string() }))
  .argv(input => ['gpu', 'submit', input.config])
  .output(z.object({ jobId: z.string() }))
  .runner(localRunner);

const gpuStatus = H.command('gpu-status')
  .input(z.object({ jobId: z.string() }))
  .argv(input => ['gpu', 'status', input.jobId])
  .output(H.jobPoll(z.object({ resultsPath: z.string() })))
  .runner(localRunner);

const gpuEval = H.job('gpu-eval', { submit: gpuSubmit, collect: gpuStatus, pollEveryMinutes: 10 });

const score = H.command('score-eval')
  .input(z.object({ resultsPath: z.string() }))
  .argv(input => ['evals', 'score', input.resultsPath])
  .output(z.object({ score: z.number(), report: z.string() }))
  .runner(localRunner);

const evalSchema = z.object({ name: z.string(), model: z.string(), suite: z.string() });

const EvalQueued = H.state('EvalQueued', 'pending');
const Scored = H.terminal('Scored', 'success');
const EvalFailed = H.terminal('EvalFailed', 'failure');

const evalRun = H.kind('EvalRun').attributes(evalSchema).states(EvalQueued, Scored, EvalFailed).key(a => a.name).initial(EvalQueued);

const evaluate = H.flow('evaluate')
  .input(evalSchema)
  .step('prepare', prepare, ctx => ({ model: ctx.unit.attributes.model, suite: ctx.unit.attributes.suite }))
  .job('gpu', gpuEval, ctx => ({ config: ctx.steps.prepare.config }))
  .step('score', score, ctx => ({ resultsPath: ctx.steps.gpu.resultsPath }))
  .step('summarize', summarizer, ctx => ({
    task: `Summarize eval ${ctx.unit.attributes.name}: score ${ctx.steps.score.score}\n${ctx.steps.score.report}`,
  }))
  .exit('scored');

const evals = H.lane('evals', evalRun)
  .supply(H.operator)
  .handler(evaluate, { exits: { scored: Scored } })
  .store(harnessStore)
  .retry({ maxAttempts: 2, backoff: 'exponential', initialDelayMs: 600_000, exhausted: EvalFailed });

const migrationSchema = z.object({ id: z.string(), database: databases.schema, path: z.string() });

const MigrationQueued = H.state('MigrationQueued', 'pending');
const AwaitingPredecessor = H.state('AwaitingPredecessor', 'waiting');
const Applied = H.terminal('Applied', 'success');
const MigrationFailed = H.terminal('MigrationFailed', 'failure');

const migration = H.kind('Migration')
  .attributes(migrationSchema)
  .states(MigrationQueued, AwaitingPredecessor, Applied, MigrationFailed)
  .key(a => a.id)
  .initial(MigrationQueued);

const applyMigration = H.command('apply-migration')
  .input(z.object({ database: databases.schema, path: z.string() }))
  .argv(input => ['migrate', '--database', input.database, input.path])
  .runner(localRunner);

const migrate = H.flow('migrate')
  .input(migrationSchema)
  .step('apply', applyMigration, ctx => ({ database: ctx.unit.attributes.database, path: ctx.unit.attributes.path }), { afterCrash: 'park' })
  .exit('applied');

const migrationId = z.string().regex(/^\d{4}$/);

const previousMigration = (id: string): string | undefined => {
  const number = Number(id);
  return number > 1 ? String(number - 1).padStart(4, '0') : undefined;
};

const migrations = H.lane('migrations', migration)
  .supply(folder.files({ path: 'migrations', glob: '*.sql' }), (file, to) => {
    const match = /^(\d{4})-([a-z]+)-.+\.sql$/.exec(file.name);
    const id = migrationId.safeParse(match?.[1]);
    const database = databases.schema.safeParse(match?.[2]);
    return id.success && database.success
      ? to.create({ id: id.data, database: database.data, path: file.path })
      : to.skip();
  })
  .handler(migrate, { exits: { applied: Applied } })
  .store(harnessStore)
  .retry({ maxAttempts: 1, exhausted: MigrationFailed })
  .lease(unit => ({ resource: databases.get(unit.attributes.database), mode: 'exclusive' }))
  .after({ key: attrs => previousMigration(attrs.id), onPredecessorFailed: AwaitingPredecessor });

const backfillSchema = z.object({ table: z.string(), database: databases.schema });

const BackfillQueued = H.state('BackfillQueued', 'pending');
const Backfilled = H.terminal('Backfilled', 'success');
const BackfillFailed = H.terminal('BackfillFailed', 'failure');

const backfillKind = H.kind('Backfill')
  .attributes(backfillSchema)
  .states(BackfillQueued, Backfilled, BackfillFailed)
  .key(a => `${a.database}.${a.table}`)
  .initial(BackfillQueued);

const backfillBatch = H.command('backfill-batch')
  .input(z.object({ database: databases.schema, table: z.string(), offset: z.number(), limit: z.number() }))
  .argv(input => ['backfill', input.database, input.table, String(input.offset), String(input.limit)])
  .output(z.object({ rows: z.number() }))
  .runner(localRunner);

const backfill = H.flow('backfill')
  .input(backfillSchema)
  .loop('offset', { schema: z.number(), initial: 0 }, batch => batch
    .step('batch', backfillBatch, ctx => ({
      database: ctx.unit.attributes.database,
      table: ctx.unit.attributes.table,
      offset: ctx.steps.offset,
      limit: 10_000,
    }), { afterCrash: 'rerun' }),
    {
      max: 100_000,
      until: ctx => ctx.steps.batch.rows < 10_000,
      next: ctx => ctx.steps.offset + ctx.steps.batch.rows,
    })
  .exit('backfilled');

const backfills = H.lane('backfills', backfillKind)
  .supply(H.operator)
  .handler(backfill, { exits: { backfilled: Backfilled } })
  .store(harnessStore)
  .retry({ maxAttempts: 3, backoff: 'exponential', initialDelayMs: 60_000, exhausted: BackfillFailed })
  .lease(unit => ({ resource: databases.get(unit.attributes.database), mode: 'shared' }));

const platformApi = http.controlApi('platform', {
  port: H.slot.port(1),
  token: H.env('PLATFORM_TOKEN'),
  grants: [H.ops.workRead, H.ops.workCreate, H.ops.attemptsRecover, H.ops.telemetryRead],
});

export const mlPlatform = H.harness('ml-platform')
  .ledger(sqlite.ledger({ path: '.harness/ledger.sqlite' }))
  .lanes(evals, migrations, backfills)
  .scheduler(H.scheduler('ml-platform')
    .standard(migrations, backfills, evals)
    .wip(evals, 2)
    .admit(evals, ctx => ctx.metrics.jobs({ job: gpuEval, window: { calendar: 'day' } }).hoursInFlight < 48))
  .clients(platformApi)
  .observers(markdown.board({ path: 'BOARD.md' }), markdown.telemetry({ path: 'TELEMETRY.md' }));
