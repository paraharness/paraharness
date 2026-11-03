import { z } from 'zod';
import { H } from 'harness-dsl';
import { claudeCode } from 'harness-dsl/claude-code';
import { anthropic } from 'harness-dsl/anthropic';
import { sqlite } from 'harness-dsl/sqlite';
import { folder, manual } from 'harness-dsl/supply';
import { runners } from 'harness-dsl/runners';
import { policies } from 'harness-dsl/policies';
import { observers } from 'harness-dsl/observers';

const api = H.account('anthropic-api', anthropic.api({ apiKey: H.env('ANTHROPIC_API_KEY') }));
const sonnet = H.model('claude-sonnet-4-5').pricing(anthropic.pricing());
const pool = H.pool('api', [api]).serves(sonnet).policy(policies.soonestReset());

const local = runners
  .local({ name: 'ml-local', slots: 6 })
  .env({ GPU_TOKEN: H.env('GPU_SERVICE_TOKEN'), DATABASE_URL: H.env('DATABASE_URL') });

const databases = {
  orders: H.resource('orders-db'),
  billing: H.resource('billing-db'),
};
const database = z.enum(['orders', 'billing']);
const databaseOf = (value: unknown): z.infer<typeof database> => (value === 'billing' ? 'billing' : 'orders');

const evalQueued = H.state('eval-queued').pending();
const evaluating = H.state('evaluating').active();
const evalStalled = H.state('eval-stalled').waiting();
const evalDone = H.state('eval-done').terminal('success');

const evalSchema = z.object({ model: z.string(), dataset: z.string() });
const evalRun = H.work('EvalRun').schema(evalSchema).states(evalQueued, evaluating, evalStalled, evalDone);

const prepare = H.command('prepare-eval')
  .input(evalSchema)
  .output(z.object({ bundle: z.string() }))
  .runner(local)
  .effect('repeatable')
  .run(async (input, ctx) => {
    const result = await ctx.exec(['eval-bundle', '--model', input.model, '--dataset', input.dataset, '--ref', ctx.attempt]);
    return { bundle: result.stdout.trim() };
  });

const gpuStatus = z.object({
  state: z.enum(['queued', 'running', 'done', 'failed']),
  resultsUri: z.string().optional(),
  error: z.string().optional(),
});

const gpuEval = H.job('gpu-eval')
  .input(z.object({ bundle: z.string() }))
  .output(z.object({ resultsUri: z.string() }))
  .submit(async (input, ctx) => {
    const result = await ctx.exec(['gpu-jobs', 'submit', input.bundle, '--tag', ctx.attempt]);
    return result.stdout.trim();
  })
  .collect(async (ref, ctx) => {
    const result = await ctx.exec(['gpu-jobs', 'status', ref, '--json']);
    const status = gpuStatus.parse(JSON.parse(result.stdout));
    if (status.state === 'done' && status.resultsUri !== undefined) {
      return { status: 'done', output: { resultsUri: status.resultsUri } };
    }
    if (status.state === 'failed') {
      return { status: 'failed', reason: status.error ?? 'remote job failed' };
    }
    return { status: 'pending' };
  })
  .every('10m')
  .detect(async (_, ctx) => {
    const found = await ctx.exec(['gpu-jobs', 'find', '--tag', ctx.attempt]);
    return found.code === 0 && found.stdout.trim() ? found.stdout.trim() : undefined;
  });

const score = H.command('score-eval')
  .input(z.object({ resultsUri: z.string() }))
  .output(z.object({ accuracy: z.number(), report: z.string() }))
  .runner(local)
  .effect('repeatable')
  .run(async (input, ctx) => {
    const result = await ctx.exec(['eval-score', input.resultsUri]);
    const [accuracy, ...rest] = result.stdout.split('\n');
    return { accuracy: Number(accuracy ?? '0'), report: rest.join('\n') };
  });

const analystRole = H.role('eval-analyst').prompt('Summarise an evaluation run for the ML team.').intents(['read']);
const summarySkill = H.skill('summarize-eval')
  .input(z.object({ model: z.string(), dataset: z.string(), accuracy: z.number(), report: z.string() }))
  .output(z.object({ summary: z.string() }))
  .prompt(i => `${i.model} on ${i.dataset}: accuracy ${i.accuracy}\n${i.report}`);
const analyst = H.seat('eval-analyst').role(analystRole).skill(summarySkill).models(sonnet);

const evalFlow = H.flow('eval-run')
  .input(evalSchema)
  .step('prepare', prepare, s => s.input)
  .step('gpu', gpuEval, s => ({ bundle: s.prepare.bundle }))
  .step('score', score, s => ({ resultsUri: s.gpu.resultsUri }))
  .step('summarize', analyst, s => ({
    model: s.input.model,
    dataset: s.input.dataset,
    accuracy: s.score.accuracy,
    report: s.score.report,
  }))
  .exit('done');

const evalRuns = H.lane('eval-runs')
  .of(evalRun)
  .from(manual('operator-evals'))
  .store(sqlite.store('./ml/evals.sqlite'))
  .handle(evalFlow, {
    exits: { done: evalDone },
    retry: { retries: 1, backoff: { initial: '15m', factor: 2 }, exhausted: evalStalled },
  })
  .wip(2);

const migrationQueued = H.state('migration-queued').pending();
const migrating = H.state('migrating').active();
const migrationParked = H.state('migration-parked').waiting();
const migrationApplied = H.state('migration-applied').terminal('success');
const migrationFailed = H.state('migration-failed').terminal('failure');

const migrationSchema = z.object({ file: z.string(), sequence: z.number(), database, sql: z.string() });
const migration = H.work('Migration')
  .schema(migrationSchema)
  .states(migrationQueued, migrating, migrationParked, migrationApplied, migrationFailed);

const migrationKey = (sequence: number) => `${sequence}`.padStart(4, '0');

const migrate = H.command('apply-migration')
  .input(migrationSchema)
  .output(z.object({ applied: z.boolean() }))
  .runner(local)
  .effect('unrepeatable')
  .run(async (input, ctx) => {
    const result = await ctx.exec(['psql', '--single-transaction', '--set', `target=${input.database}`, '-f', input.file]);
    return { applied: result.code === 0 };
  });

const migrationFlow = H.flow('migration')
  .input(migrationSchema)
  .resources(i => [databases[i.database].exclusive()])
  .step('apply', migrate, s => s.input)
  .when(s => !s.apply.applied, f => f.exit('failed'))
  .exit('applied');

const migrations = H.lane('migrations')
  .of(migration)
  .from(
    folder.files({
      name: 'migration-folder',
      path: './migrations',
      glob: '*.sql',
      key: f => f.name.slice(0, 4),
      data: f => ({ file: f.path, sequence: Number(f.name.slice(0, 4)), database: databaseOf(f.frontmatter.database), sql: f.body }),
      mode: 'create',
    }),
  )
  .store(sqlite.store('./ml/migrations.sqlite'))
  .handle(migrationFlow, {
    exits: { applied: migrationApplied, failed: migrationFailed },
    retry: { retries: 0, backoff: 'none', exhausted: migrationFailed },
  })
  .order({ after: d => (d.sequence > 1 ? [migrationKey(d.sequence - 1)] : []), failed: migrationParked });

const backfillQueued = H.state('backfill-queued').pending();
const backfilling = H.state('backfilling').active();
const backfillStalled = H.state('backfill-stalled').waiting();
const backfillDone = H.state('backfill-done').terminal('success');

const backfillSchema = z.object({ table: z.string(), database, column: z.string() });
const backfill = H.work('Backfill').schema(backfillSchema).states(backfillQueued, backfilling, backfillStalled, backfillDone);

const planBackfill = H.command('plan-backfill')
  .input(backfillSchema)
  .output(z.object({ batches: z.number() }))
  .runner(local)
  .effect('repeatable')
  .run(async (input, ctx) => {
    const result = await ctx.exec(['backfill', 'count', input.database, input.table]);
    return { batches: Math.ceil(Number(result.stdout.trim()) / 10_000) };
  });

const copyBatch = H.command('copy-batch')
  .input(z.object({ table: z.string(), database, column: z.string(), offset: z.number(), limit: z.number() }))
  .output(z.object({ copied: z.number() }))
  .runner(local)
  .effect('repeatable')
  .run(async (input, ctx) => {
    const result = await ctx.exec([
      'backfill',
      'copy',
      input.database,
      input.table,
      input.column,
      '--offset',
      String(input.offset),
      '--limit',
      String(input.limit),
    ]);
    return { copied: Number(result.stdout.trim()) };
  });

const backfillFlow = H.flow('backfill')
  .input(backfillSchema)
  .resources(i => [databases[i.database].shared()])
  .step('plan', planBackfill, s => s.input)
  .loop('batch', {
    max: s => s.plan.batches,
    body: f =>
      f.step('copy', copyBatch, s => ({
        table: s.input.table,
        database: s.input.database,
        column: s.input.column,
        offset: s.batch.iteration * 10_000,
        limit: 10_000,
      })),
    until: s => s.copy.copied < 10_000,
  })
  .exit('done');

const backfills = H.lane('backfills')
  .of(backfill)
  .from(manual('operator-backfills'))
  .store(sqlite.store('./ml/backfills.sqlite'))
  .handle(backfillFlow, {
    exits: { done: backfillDone },
    retry: { retries: 2, backoff: { initial: '5m', factor: 2 }, exhausted: backfillStalled },
  });

export const gpuHoursInFlight = H.metric('gpu-hours-in-flight', H.events.jobs(gpuEval))
  .sum(e => e.hoursInFlight)
  .by('job')
  .window('calendarDay');
export const lockWait = H.metric('lock-wait-ms', H.events.leases())
  .median(e => e.waitMs)
  .by('resource')
  .window('calendarDay');

const order = H.policy.units('migrations-in-sequence', ({ candidates }) => {
  const rank = (c: (typeof candidates)[number]) =>
    migrations.holds(c) ? c.data.sequence : backfills.holds(c) ? 1_000_000 : 2_000_000;
  return [...candidates].sort((a, b) => rank(a) - rank(b) || a.queuedAt.getTime() - b.queuedAt.getTime());
});

export const harness = H.harness('ml-platform')
  .ledger(sqlite.ledger('./ml/ledger.sqlite'))
  .pools(pool)
  .lanes(evalRuns, migrations, backfills)
  .scheduler(order)
  .grants(
    H.grant(
      claudeCode.client({ name: 'ml-operator' }),
      H.ops.work.read,
      H.ops.work.write,
      H.ops.attempts.manage,
      H.ops.telemetry.read,
    ),
  )
  .observe(observers.board({ path: './ml/BOARD.md' }), observers.telemetry({ path: './ml/TELEMETRY.md' }));

export const running = harness.start();
