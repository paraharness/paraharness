import { z } from 'zod';
import { H } from 'harness-dsl';
import { sqlite } from 'harness-dsl/sqlite';
import { claudeCode } from 'harness-dsl/claude-code';
import { folder } from 'harness-dsl/folder';
import { local } from 'harness-dsl/local';
import { markdown } from 'harness-dsl/markdown';

const runner = local.runner('local').slots(4);
const store = sqlite.store({ path: './.harness/units.sqlite' });

const databaseSchema = z.enum(['orders', 'billing', 'analytics']);
const databases = H.resources('database', databaseSchema.options);

const subscription = claudeCode.subscription('ml-platform', {
  token: H.env('CLAUDE_TOKEN'),
  quota: sqlite.quota('ml-platform', { path: './.harness/quota.sqlite' }),
});
const pool = H.pool('ml-platform').accounts(subscription);
const sonnet = claudeCode.model('sonnet', { id: 'claude-sonnet-4-5' });
const analystRole = H.role('eval-analyst').intents('read').instructions('Summarize evaluation results and regressions.');
const analyst = H.seat('eval-analyst').role(analystRole).model(sonnet).pool(pool).output(z.object({ summary: z.string() }));

const evalAttrs = z.object({ model: z.string(), suite: z.string() });
const EvalQueued = H.state('EvalQueued', 'pending');
const EvalScored = H.terminal('EvalScored', 'success');
const EvalFailed = H.terminal('EvalFailed', 'failure');
const EvalRun = H.kind('EvalRun')
  .attributes(evalAttrs)
  .states(EvalQueued, EvalScored, EvalFailed)
  .key(a => `${a.model}:${a.suite}`)
  .initial(EvalQueued);

const prepare = H.command('prepare-eval')
  .input(z.object({ suite: z.string() }))
  .argv(i => ['./eval/prepare.sh', i.suite])
  .output(z.object({ datasetUri: z.string() }))
  .runner(runner);
const gpuEval = H.job('gpu-eval', {
  submit: H.command('gpu-submit')
    .input(z.object({ model: z.string(), datasetUri: z.string() }))
    .argv(i => ['./eval/gpu-submit.sh', i.model, i.datasetUri])
    .output(z.object({ jobId: z.string() }))
    .runner(runner),
  collect: H.command('gpu-collect')
    .input(z.object({ jobId: z.string() }))
    .argv(h => ['./eval/gpu-status.sh', h.jobId])
    .output(H.jobPoll(z.object({ artifactUri: z.string() })))
    .runner(runner),
  pollEveryMinutes: 10,
});
const score = H.command('score-eval')
  .input(z.object({ artifactUri: z.string() }))
  .argv(i => ['./eval/score.sh', i.artifactUri])
  .output(z.object({ score: z.number(), report: z.string() }))
  .runner(runner);

const evalFlow = H.flow('eval-run')
  .input(evalAttrs)
  .step('prepare', prepare, ctx => ({ suite: ctx.unit.attributes.suite }), { afterCrash: 'rerun' })
  .job('gpu', gpuEval, ctx => ({ model: ctx.unit.attributes.model, datasetUri: ctx.steps.prepare.datasetUri }))
  .step('score', score, ctx => ({ artifactUri: ctx.steps.gpu.artifactUri }), { afterCrash: 'rerun' })
  .step('summarize', analyst, ctx => ({ task: `Summarize eval of ${ctx.unit.attributes.model} on ${ctx.unit.attributes.suite}: score ${ctx.steps.score.score}\n${ctx.steps.score.report}` }), { afterCrash: 'askDriver' })
  .exit('scored');

const evals = H.lane('evals', EvalRun)
  .supply(H.operator)
  .store(store)
  .handler(evalFlow, { exits: { scored: EvalScored } })
  .retry({ maxAttempts: 2, backoff: 'exponential', initialDelayMs: 600_000, exhausted: EvalFailed });

const migrationAttrs = z.object({ id: z.string(), database: databaseSchema, path: z.string() });
const migrationFileName = z.tuple([z.string(), z.string(), databaseSchema]);
const MigrationQueued = H.state('MigrationQueued', 'pending');
const MigrationHeld = H.state('MigrationHeld', 'waiting');
const MigrationApplied = H.terminal('MigrationApplied', 'success');
const MigrationFailed = H.terminal('MigrationFailed', 'failure');
const Migration = H.kind('Migration')
  .attributes(migrationAttrs)
  .states(MigrationQueued, MigrationHeld, MigrationApplied, MigrationFailed)
  .key(a => a.id)
  .initial(MigrationQueued);

const migrate = H.command('migrate')
  .input(z.object({ database: databaseSchema, path: z.string() }))
  .argv(i => ['./db/migrate.sh', i.database, i.path])
  .runner(runner);

const migrationFlow = H.flow('migration')
  .input(migrationAttrs)
  .step('migrate', migrate, ctx => ({ database: ctx.unit.attributes.database, path: ctx.unit.attributes.path }), { afterCrash: 'park' })
  .exit('applied');

const predecessorOf = (id: string) => {
  const number = Number(id);
  return number <= 1 ? undefined : String(number - 1).padStart(4, '0');
};

const migrations = H.lane('migrations', Migration)
  .supply(folder.files({ path: './migrations', glob: '*.sql' }), (file, to) => {
    const parsed = migrationFileName.safeParse(Array.from(/^(\d{4})_([a-z]+)_/.exec(file.name) ?? []));
    return parsed.success ? to.create({ id: parsed.data[1], database: parsed.data[2], path: file.path }) : to.skip();
  })
  .store(store)
  .handler(migrationFlow, { exits: { applied: MigrationApplied } })
  .retry({ maxAttempts: 1, exhausted: MigrationFailed })
  .lease(u => ({ resource: databases.of(u.attributes.database), mode: 'exclusive' }))
  .after({ key: a => predecessorOf(a.id), onPredecessorFailed: MigrationHeld });

const backfillAttrs = z.object({ table: z.string(), database: databaseSchema });
const BackfillQueued = H.state('BackfillQueued', 'pending');
const BackfillDone = H.terminal('BackfillDone', 'success');
const BackfillFailed = H.terminal('BackfillFailed', 'failure');
const Backfill = H.kind('Backfill')
  .attributes(backfillAttrs)
  .states(BackfillQueued, BackfillDone, BackfillFailed)
  .key(a => a.table)
  .initial(BackfillQueued);

const backfillBatch = H.command('backfill-batch')
  .input(z.object({ database: databaseSchema, table: z.string(), offset: z.number(), limit: z.number() }))
  .argv(i => ['./db/backfill.sh', i.database, i.table, String(i.offset), String(i.limit)])
  .output(z.object({ rows: z.number() }))
  .runner(runner);

const backfillFlow = H.flow('backfill')
  .input(backfillAttrs)
  .loop(
    'batches',
    { carry: z.object({ offset: z.number() }), initial: { offset: 0 } },
    round => round.step('batch', backfillBatch, ctx => ({
      database: ctx.unit.attributes.database,
      table: ctx.unit.attributes.table,
      offset: ctx.steps.batches.offset,
      limit: 10_000,
    }), { afterCrash: 'rerun' }),
    {
      until: ctx => ctx.steps.batch.rows < 10_000,
      next: ctx => ({ offset: ctx.steps.batches.offset + ctx.steps.batch.rows }),
    },
  )
  .exit('done');

const backfills = H.lane('backfills', Backfill)
  .supply(H.operator)
  .store(store)
  .handler(backfillFlow, { exits: { done: BackfillDone } })
  .retry({ maxAttempts: 3, backoff: 'exponential', initialDelayMs: 60_000, exhausted: BackfillFailed })
  .lease(u => ({ resource: databases.of(u.attributes.database), mode: 'shared' }));

const supervisor = claudeCode.supervisor('platform-supervisor', {
  port: H.slot.port(1),
  grants: [H.ops.workRead, H.ops.workCreate, H.ops.attemptsRecover, H.ops.telemetryRead],
});

export const platformHarness = H.harness('ml-platform')
  .ledger(sqlite.ledger({ path: './.harness/ledger.sqlite' }))
  .lanes(evals, migrations, backfills)
  .scheduler(H.scheduler('ml-platform').standard(migrations, backfills, evals).wip(evals, 2))
  .clients(supervisor)
  .observers(markdown.board({ path: './BOARD.md' }), markdown.telemetry({ path: './TELEMETRY.md' }));
