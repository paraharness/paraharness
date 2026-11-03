import { z } from 'zod';
import { H, Resource } from 'harness-dsl';
import { sqlite } from 'harness-dsl/sqlite';
import { folder } from 'harness-dsl/folder';
import { local } from 'harness-dsl/local';
import { anthropic } from 'harness-dsl/anthropic';
import { claudeCode } from 'harness-dsl/claude-code';
import { markdown } from 'harness-dsl/markdown';

const runner = local.runner('local').slots(4);
const harnessStore = sqlite.store({ path: 'ml-platform.store.db' });

const ordersDb = H.resource('orders-db');
const billingDb = H.resource('billing-db');
const database = z.enum(['orders', 'billing']);
type Database = z.infer<typeof database>;
const databaseResource = (name: Database): Resource => (name === 'orders' ? ordersDb : billingDb);

const queued = H.state('Queued', 'pending');
const working = H.state('Working', 'active');
const parked = H.state('Parked', 'waiting');
const failed = H.terminal('Failed', 'failure');
const withdrawn = H.terminal('Withdrawn', 'neutral');

const evalRun = z.object({ model: z.string(), suite: z.string() });
const scored = H.terminal('Scored', 'success');

const evalKind = H.kind('EvalRun')
  .attributes(evalRun)
  .states(queued, working, scored, failed, withdrawn)
  .key((run) => `${run.model}:${run.suite}`)
  .initial(queued)
  .onCancelled(withdrawn);

const prepareEval = H.command('prepare-eval')
  .input(evalRun)
  .argv((run) => ['evalctl', 'prepare', '--model', run.model, '--suite', run.suite])
  .output(z.object({ datasetUri: z.string() }))
  .runner(runner);

const submitEval = H.command('submit-gpu-eval')
  .input(z.object({ datasetUri: z.string(), model: z.string() }))
  .argv((job) => ['gpuctl', 'submit', '--dataset', job.datasetUri, '--model', job.model])
  .output(z.object({ jobId: z.string() }))
  .runner(runner);

const pollEval = H.command('poll-gpu-eval')
  .input(z.object({ jobId: z.string() }))
  .argv((job) => ['gpuctl', 'status', '--job', job.jobId])
  .output(
    z.discriminatedUnion('state', [
      z.object({ state: z.literal('running') }),
      z.object({ state: z.literal('succeeded'), output: z.object({ resultUri: z.string() }) }),
      z.object({ state: z.literal('failed'), reason: z.string() }),
    ]),
  )
  .runner(runner);

const gpuEval = H.job('gpu-eval', { submit: submitEval, collect: pollEval, every: { minutes: 10 } });

const scoreEval = H.command('score-eval')
  .input(z.object({ resultUri: z.string() }))
  .argv((result) => ['evalctl', 'score', '--results', result.resultUri])
  .output(z.object({ score: z.number(), report: z.string() }))
  .runner(runner);

const apiAccount = anthropic.account('ml-api', { apiKey: H.env('ANTHROPIC_API_KEY') });
const apiPool = H.pool('ml-api').accounts(apiAccount);
const sonnet = anthropic.model('sonnet', { id: 'claude-sonnet-4-5' });

const summarizer = H.agent('eval-summarizer')
  .role(H.role('eval-summarizer').intents('read').instructions('Summarize evaluation results for the research team.'))
  .model(sonnet)
  .pool(apiPool);

const evalFlow = H.flow('eval-run')
  .input(evalRun)
  .step('prepare', prepareEval, (ctx) => ctx.unit.attributes)
  .step('evaluate', gpuEval, (ctx) => ({
    datasetUri: ctx.steps.prepare.datasetUri,
    model: ctx.unit.attributes.model,
  }))
  .step('score', scoreEval, (ctx) => ({ resultUri: ctx.steps.evaluate.resultUri }))
  .step('summarize', summarizer, (ctx) => ({
    task: `Summarize the ${ctx.unit.attributes.suite} evaluation of ${ctx.unit.attributes.model}. Score ${ctx.steps.score.score}.\n\n${ctx.steps.score.report}`,
  }))
  .exit('scored');

const evalLane = H.lane('evals', evalKind)
  .supply(H.operator)
  .store(harnessStore)
  .handler(evalFlow, {
    exits: { scored },
    during: { prepare: working, score: working, summarize: working },
  })
  .retry({ maxAttempts: 1, backoff: 'fixed', initialDelayMs: 0, exhausted: failed });

const migration = z.object({ number: z.string(), database, file: z.string() });
const applied = H.terminal('Applied', 'success');

const migrationKind = H.kind('Migration')
  .attributes(migration)
  .states(queued, working, parked, applied, failed, withdrawn)
  .key((file) => file.number)
  .initial(queued)
  .onCancelled(withdrawn);

const applyMigration = H.command('apply-migration')
  .input(migration)
  .argv((file) => ['migrate', 'apply', '--database', file.database, '--file', file.file])
  .runner(runner);

const migrationFlow = H.flow('migration')
  .input(migration)
  .step('apply', applyMigration, (ctx) => ctx.unit.attributes, { afterCrash: 'park' })
  .exit('applied');

const migrationLane = H.lane('migrations', migrationKind)
  .supply(folder.files({ path: 'migrations', glob: '*.sql' }), (file, to) => {
    const match = /^(\d{4})-([a-z]+)-/.exec(file.name);
    const target = database.safeParse(match?.[2]);
    if (match === null || !target.success) return to.skip();
    return to.create({ number: match[1], database: target.data, file: file.path });
  })
  .store(harnessStore)
  .handler(migrationFlow, { exits: { applied }, during: { apply: working } })
  .lease((unit) => ({ resource: databaseResource(unit.attributes.database), mode: 'exclusive' }))
  .order((unit) => unit.attributes.number, { onEarlierFailed: parked })
  .retry({ maxAttempts: 1, backoff: 'fixed', initialDelayMs: 0, exhausted: failed });

const backfill = z.object({ table: z.string(), database, totalRows: z.number() });
const filled = H.terminal('Filled', 'success');
const batchRows = 10_000;

const backfillKind = H.kind('Backfill')
  .attributes(backfill)
  .states(queued, working, filled, failed, withdrawn)
  .key((job) => `${job.database}.${job.table}`)
  .initial(queued)
  .onCancelled(withdrawn);

const copyBatch = H.command('backfill-batch')
  .input(z.object({ table: z.string(), database, offset: z.number(), limit: z.number() }))
  .argv((batch) => [
    'backfill',
    '--database',
    batch.database,
    '--table',
    batch.table,
    '--offset',
    String(batch.offset),
    '--limit',
    String(batch.limit),
  ])
  .output(z.object({ remaining: z.number() }))
  .runner(runner);

const backfillFlow = H.flow('backfill')
  .input(backfill)
  .loop(
    'batches',
    (batches) =>
      batches.step(
        'batch',
        copyBatch,
        (ctx) => ({
          table: ctx.unit.attributes.table,
          database: ctx.unit.attributes.database,
          offset: ctx.iteration * batchRows,
          limit: batchRows,
        }),
        { afterCrash: 'rerun' },
      ),
    {
      max: (ctx) => Math.ceil(ctx.unit.attributes.totalRows / batchRows),
      until: (ctx) => ctx.steps.batch.remaining === 0,
    },
  )
  .exit('filled');

const backfillLane = H.lane('backfills', backfillKind)
  .supply(H.operator)
  .store(harnessStore)
  .handler(backfillFlow, { exits: { filled }, during: { batches: working } })
  .lease((unit) => ({ resource: databaseResource(unit.attributes.database), mode: 'shared' }))
  .retry({ maxAttempts: 1, backoff: 'fixed', initialDelayMs: 0, exhausted: failed });

const gpuHours = H.metric('gpu-hours', H.when.step(evalLane, 'evaluate')).amounts((event) => [
  { group: 'gpu', amount: event.durationMs / 3_600_000 },
]);

const lockWait = H.metric('lock-wait', H.when.leased(migrationLane, backfillLane)).amounts((event) => [
  { group: event.resource.name, amount: event.waitedMs },
]);

const scheduler = H.scheduler('ml-platform').wip(evalLane, 2);

const supervisor = claudeCode.supervisor('ml-supervisor', {
  grants: [H.ops.workRead, H.ops.workCreate, H.ops.workCancel, H.ops.attemptsRecover, H.ops.telemetryRead],
});

H.harness('ml-platform')
  .ledger(sqlite.ledger({ path: 'ml-platform.ledger.db' }))
  .lanes(evalLane, migrationLane, backfillLane)
  .metrics(gpuHours, lockWait)
  .scheduler(scheduler)
  .clients(supervisor)
  .observers(markdown.board({ path: 'BOARD.md' }), markdown.telemetry({ path: 'TELEMETRY.md' }))
  .start();
