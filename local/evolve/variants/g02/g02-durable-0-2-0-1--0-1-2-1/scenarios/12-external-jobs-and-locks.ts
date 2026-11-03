import { z } from 'zod';
import { H } from 'harness-dsl';
import { sqlite } from 'harness-dsl/sqlite';
import { anthropic } from 'harness-dsl/anthropic';
import { claudeCode } from 'harness-dsl/claude-code';
import { folder } from 'harness-dsl/folder';
import { local } from 'harness-dsl/local';
import { markdown } from 'harness-dsl/markdown';

const store = sqlite.store({ path: './ml/store.sqlite' });
const runner = local.runner('ml-box');

const DatabaseName = z.enum(['orders', 'billing', 'features']);
const databases = {
  orders: H.resource('orders-db'),
  billing: H.resource('billing-db'),
  features: H.resource('features-db'),
};

const EvalAttrs = z.object({ runId: z.string(), checkpoint: z.string() });
const EvalRequested = H.state('EvalRequested', 'pending');
const Scored = H.terminal('Scored', 'success');
const EvalFailed = H.terminal('EvalFailed', 'failure');
const EvalRun = H.kind('EvalRun').attributes(EvalAttrs).states(EvalRequested, Scored, EvalFailed).key(a => a.runId).initial(EvalRequested);

const prepare = H.command('prepare-eval').input(EvalAttrs).argv(i => ['./bin/prepare', i.runId, i.checkpoint]).runner(runner);
const submitEval = H.command('submit-gpu-eval')
  .input(EvalAttrs)
  .argv(i => ['./bin/gpu', 'submit', i.runId, i.checkpoint])
  .output(z.object({ jobId: z.string() }))
  .runner(runner);
const collectEval = H.command('collect-gpu-eval')
  .input(z.object({ jobId: z.string() }))
  .argv(h => ['./bin/gpu', 'status', h.jobId])
  .output(H.jobPoll(z.object({ resultsPath: z.string() })))
  .runner(runner);
const gpuEval = H.job('gpu-eval', { submit: submitEval, collect: collectEval, pollEveryMinutes: 10 });
const score = H.command('score-eval')
  .input(z.object({ resultsPath: z.string() }))
  .argv(i => ['./bin/score', i.resultsPath])
  .output(z.object({ score: z.number(), report: z.string() }))
  .runner(runner);

const apiAccount = anthropic.account('ml-api', {
  apiKey: H.env('ANTHROPIC_API_KEY'),
  quota: sqlite.quota('ml-api', { path: './ml/quota.sqlite' }),
});
const sonnet = anthropic.model('sonnet', { id: 'claude-sonnet-4-5' });
const analyst = H.role('eval-analyst').intents('read').instructions('Summarize the evaluation for the team.');
const summarizer = H.seat('eval-summarizer').role(analyst).model(sonnet).pool(H.pool('ml').accounts(apiAccount));

const evalFlow = H.flow('eval-run')
  .input(EvalAttrs)
  .step('prepare', prepare, ctx => ({ runId: ctx.unit.attributes.runId, checkpoint: ctx.unit.attributes.checkpoint }), { afterCrash: 'rerun' })
  .job('gpu', gpuEval, ctx => ({ runId: ctx.unit.attributes.runId, checkpoint: ctx.unit.attributes.checkpoint }))
  .step('score', score, ctx => ({ resultsPath: ctx.steps.gpu.resultsPath }), { afterCrash: 'rerun' })
  .step('summarize', summarizer, ctx => ({ task: `Summarize eval ${ctx.unit.attributes.runId}: score ${ctx.steps.score.score}\n${ctx.steps.score.report}` }))
  .exit('scored');

const evalLane = H.lane('evals', EvalRun)
  .supply(H.operator)
  .handler(evalFlow, { exits: { scored: Scored } })
  .store(store)
  .retry({ maxAttempts: 2, backoff: 'exponential', initialDelayMs: 600_000, exhausted: EvalFailed });

const MigrationAttrs = z.object({ migrationId: z.string(), database: DatabaseName, path: z.string() });
const MigrationQueued = H.state('MigrationQueued', 'pending');
const MigrationHeld = H.state('MigrationHeld', 'waiting');
const Applied = H.terminal('Applied', 'success');
const MigrationFailed = H.terminal('MigrationFailed', 'failure');
const Migration = H.kind('Migration')
  .attributes(MigrationAttrs)
  .states(MigrationQueued, MigrationHeld, Applied, MigrationFailed)
  .key(a => a.migrationId)
  .initial(MigrationQueued);

const applyMigration = H.command('apply-migration')
  .input(MigrationAttrs)
  .argv(i => ['./bin/migrate', i.database, i.path])
  .runner(runner);

const migrationFlow = H.flow('migration')
  .input(MigrationAttrs)
  .step('apply', applyMigration, ctx => ctx.unit.attributes, { afterCrash: 'park' })
  .exit('applied');

const migrationLane = H.lane('migrations', Migration)
  .supply(folder.files({ path: './migrations', glob: '*.sql' }), (file, to) => {
    const [stem, database] = file.name.split('.');
    const parsed = DatabaseName.safeParse(database);
    return parsed.success
      ? to.create({ migrationId: stem.slice(0, 4), database: parsed.data, path: file.path })
      : to.skip();
  })
  .handler(migrationFlow, { exits: { applied: Applied } })
  .store(store)
  .retry({ maxAttempts: 1, exhausted: MigrationFailed })
  .lease(unit => ({ resource: databases[unit.attributes.database], mode: 'exclusive' }))
  .after({
    key: attrs => {
      const number = Number(attrs.migrationId);
      return number > 1 ? String(number - 1).padStart(4, '0') : undefined;
    },
    onPredecessorFailed: MigrationHeld,
  });

const batchRows = 10_000;
const BackfillAttrs = z.object({ table: z.string(), database: DatabaseName, totalRows: z.number() });
const BackfillQueued = H.state('BackfillQueued', 'pending');
const Backfilled = H.terminal('Backfilled', 'success');
const BackfillFailed = H.terminal('BackfillFailed', 'failure');
const Backfill = H.kind('Backfill')
  .attributes(BackfillAttrs)
  .states(BackfillQueued, Backfilled, BackfillFailed)
  .key(a => `${a.database}.${a.table}`)
  .initial(BackfillQueued);

const backfillBatch = H.command('backfill-batch')
  .input(z.object({ database: DatabaseName, table: z.string(), offset: z.number(), limit: z.number() }))
  .argv(i => ['./bin/backfill', i.database, i.table, String(i.offset), String(i.limit)])
  .runner(runner);

const backfillFlow = H.flow('backfill')
  .input(BackfillAttrs)
  .loop('batches', f => f
    .step('batch', backfillBatch, ctx => ({
      database: ctx.unit.attributes.database,
      table: ctx.unit.attributes.table,
      offset: ctx.iteration * batchRows,
      limit: batchRows,
    }), { afterCrash: 'rerun', retry: { maxAttempts: 3, backoff: 'exponential', initialDelayMs: 30_000 } }),
    { max: ctx => Math.ceil(ctx.unit.attributes.totalRows / batchRows) })
  .exit('backfilled');

const backfillLane = H.lane('backfills', Backfill)
  .supply(H.operator)
  .handler(backfillFlow, { exits: { backfilled: Backfilled } })
  .store(store)
  .retry({ maxAttempts: 2, exhausted: BackfillFailed })
  .lease(unit => ({ resource: databases[unit.attributes.database], mode: 'shared' }));

const supervisor = claudeCode.supervisor('ml-supervisor', {
  port: H.slot.port(1),
  grants: [H.ops.workRead, H.ops.workCreate, H.ops.workCancel, H.ops.attemptsRecover, H.ops.telemetryRead],
});

export const harness = H.harness('ml-platform')
  .ledger(sqlite.ledger({ path: './ml/ledger.sqlite' }))
  .lanes(migrationLane, backfillLane, evalLane)
  .scheduler(H.scheduler('ml-platform')
    .standard(migrationLane, backfillLane, evalLane)
    .wip(evalLane, 2)
    .admit(evalLane, ctx => {
      const gpu = ctx.metrics.jobs({ job: gpuEval, window: { calendar: 'day' } });
      return gpu.samples < 5 || gpu.hoursInFlight < 40;
    })
    .admit(backfillLane, ctx => {
      const waits = ctx.metrics.leases({ resource: databases[ctx.unit.attributes.database], window: { lastHours: 24 } });
      return waits.samples < 10 || waits.medianWaitMs < 30 * 60_000;
    }))
  .clients(supervisor)
  .observers(markdown.board({ path: './ml/BOARD.md' }), markdown.telemetry({ path: './ml/TELEMETRY.md' }));
