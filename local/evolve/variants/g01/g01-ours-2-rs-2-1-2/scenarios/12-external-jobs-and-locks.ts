import { z } from 'zod';
import { H } from 'harness-dsl';
import { anthropic } from 'harness-dsl/anthropic';
import { claudeCode } from 'harness-dsl/claude-code';
import { sqlite } from 'harness-dsl/sqlite';
import { folder, manual } from 'harness-dsl/supply';
import { runners } from 'harness-dsl/runners';
import { policies } from 'harness-dsl/policies';
import { observers } from 'harness-dsl/observers';

const api = H.account('anthropic-api', anthropic.api({ apiKey: H.env('ANTHROPIC_API_KEY') }));
const sonnet = H.model('claude-sonnet-4-5').pricing(anthropic.pricing());
const local = runners.local({ name: 'local', slots: 4 });
const unitStore = './.harness/units.sqlite';

const database = H.resource('database');

const evalSchema = z.object({ model: z.string(), suite: z.string(), checkpoint: z.string() });
const evalRequested = H.state('eval-requested').pending();
const evalScored = H.state('eval-scored').terminal('success');
const evalAbandoned = H.state('eval-abandoned').terminal('failure');
const evalRun = H.work('EvalRun').schema(evalSchema).states(evalRequested, evalScored, evalAbandoned);

const prepare = H.command('prepare-eval')
  .input(evalSchema)
  .output(z.object({ bundle: z.string() }))
  .runner(local)
  .effect('repeatable')
  .run(async (input, ctx) => {
    const packed = await ctx.exec(['evals', 'bundle', input.suite, input.checkpoint]);
    return { bundle: packed.stdout.trim() };
  });

const gpuStatus = z.object({
  state: z.enum(['queued', 'running', 'succeeded', 'failed']),
  resultsUri: z.string().optional(),
  error: z.string().optional(),
});

const gpuEval = H.job('gpu-eval')
  .input(z.object({ bundle: z.string(), suite: z.string() }))
  .output(z.object({ resultsUri: z.string() }))
  .submit(async (input, ctx) => {
    const submitted = await ctx.exec(['gpu', 'submit', '--bundle', input.bundle, '--suite', input.suite]);
    return submitted.stdout.trim();
  })
  .collect(async (ref, ctx) => {
    const polled = await ctx.exec(['gpu', 'status', ref, '--json']);
    const status = gpuStatus.parse(JSON.parse(polled.stdout));
    if (status.state === 'failed') return { status: 'failed', reason: status.error ?? 'remote job failed' };
    if (status.state === 'succeeded' && status.resultsUri !== undefined) return { status: 'done', output: { resultsUri: status.resultsUri } };
    return { status: 'pending' };
  })
  .every('10m')
  .detect(async (input, ctx) => {
    const found = await ctx.exec(['gpu', 'find', '--bundle', input.bundle]);
    const ref = found.stdout.trim();
    return found.code === 0 && ref.length > 0 ? ref : undefined;
  });

const score = H.command('score-eval')
  .input(z.object({ resultsUri: z.string() }))
  .output(z.object({ score: z.number(), report: z.string() }))
  .runner(local)
  .effect('repeatable')
  .run(async (input, ctx) => {
    const scored = await ctx.exec(['evals', 'score', input.resultsUri]);
    return { score: Number(scored.stdout.split('\n')[0]), report: scored.stdout };
  });

const analyst = H.role('eval-analyst').promptFile('./prompts/eval-analyst.md');
const summarizeEval = H.skill('summarize-eval')
  .input(z.object({ model: z.string(), suite: z.string(), score: z.number(), report: z.string() }))
  .output(z.object({ summary: z.string() }))
  .prompt(i => `${i.model} on ${i.suite} scored ${i.score}.\n${i.report}`);
const analystSeat = H.seat('eval-analyst').role(analyst).skill(summarizeEval).models(sonnet);

const evalFlow = H.flow('eval-run')
  .input(evalSchema)
  .step('prepare', prepare, s => s.input)
  .step('gpu', gpuEval, s => ({ bundle: s.prepare.bundle, suite: s.input.suite }))
  .step('score', score, s => ({ resultsUri: s.gpu.resultsUri }))
  .step('summarize', analystSeat, s => ({ model: s.input.model, suite: s.input.suite, score: s.score.score, report: s.score.report }))
  .exit('scored');

const evalRuns = H.lane('eval-runs')
  .of(evalRun)
  .from(manual('ml-operator'))
  .store(sqlite.store(unitStore))
  .handle(evalFlow, {
    exits: { scored: evalScored },
    retry: { retries: 1, backoff: { initial: '15m', factor: 2 }, exhausted: evalAbandoned },
  })
  .wip(2);

const migrationSchema = z.object({ id: z.string(), database: z.string(), file: z.string(), after: z.array(z.string()) });
const migrationQueued = H.state('migration-queued').pending();
const migrationApplied = H.state('migration-applied').terminal('success');
const migrationHeld = H.state('migration-held').waiting();
const migrationFailed = H.state('migration-failed').terminal('failure');
const migration = H.work('Migration').schema(migrationSchema).states(migrationQueued, migrationApplied, migrationHeld, migrationFailed);

const applyMigration = H.command('apply-migration')
  .input(z.object({ database: z.string(), file: z.string() }))
  .output(z.object({ applied: z.boolean() }))
  .runner(local)
  .effect('unrepeatable')
  .run(async (input, ctx) => {
    const applied = await ctx.exec(['psql', '--dbname', input.database, '--single-transaction', '--file', input.file]);
    if (applied.code !== 0) throw new Error(applied.stderr);
    return { applied: true };
  });

const migrationFlow = H.flow('migration')
  .input(migrationSchema)
  .resources(i => [database.is(i.database).exclusive()])
  .step('apply', applyMigration, s => ({ database: s.input.database, file: s.input.file }))
  .exit('applied');

const migrations = H.lane('migrations')
  .of(migration)
  .from(folder.files({
    name: 'migration-folder',
    path: './migrations',
    glob: '*.sql',
    key: f => f.name,
    data: f => {
      const target = f.frontmatter['database'];
      const predecessor = f.frontmatter['after'];
      return {
        id: f.name,
        database: typeof target === 'string' ? target : 'main',
        file: f.path,
        after: typeof predecessor === 'string' ? [predecessor] : [],
      };
    },
  }))
  .store(sqlite.store(unitStore))
  .handle(migrationFlow, {
    exits: { applied: migrationApplied },
    retry: { retries: 0, backoff: 'none', exhausted: migrationFailed },
  })
  .order({ after: d => d.after, failed: migrationHeld });

const backfillSchema = z.object({ table: z.string(), database: z.string(), rows: z.number() });
const backfillQueued = H.state('backfill-queued').pending();
const backfillDone = H.state('backfill-done').terminal('success');
const backfillAbandoned = H.state('backfill-abandoned').terminal('failure');
const backfill = H.work('Backfill').schema(backfillSchema).states(backfillQueued, backfillDone, backfillAbandoned);

const batchRows = 10000;
const copyBatch = H.command('copy-batch')
  .input(z.object({ table: z.string(), database: z.string(), offset: z.number(), limit: z.number() }))
  .output(z.object({ copied: z.number() }))
  .runner(local)
  .effect('repeatable')
  .run(async (input, ctx) => {
    const copied = await ctx.exec(['backfill', input.database, input.table, '--offset', String(input.offset), '--limit', String(input.limit)]);
    return { copied: Number(copied.stdout.trim()) };
  });

const backfillFlow = H.flow('backfill')
  .input(backfillSchema)
  .resources(i => [database.is(i.database).shared()])
  .loop('batch', {
    max: s => Math.max(1, Math.ceil(s.input.rows / batchRows)),
    body: f => f.step('copy', copyBatch, s => ({ table: s.input.table, database: s.input.database, offset: s.batch.iteration * batchRows, limit: batchRows })),
    until: s => s.copy.copied < batchRows,
  })
  .exit('filled');

const backfills = H.lane('backfills')
  .of(backfill)
  .from(manual('data-operator'))
  .store(sqlite.store(unitStore))
  .handle(backfillFlow, {
    exits: { filled: backfillDone },
    retry: { retries: 2, backoff: { initial: '2m', factor: 2 }, exhausted: backfillAbandoned },
  });

const gpuHoursInFlight = H.metric('gpu-hours-in-flight', H.events.jobs(gpuEval))
  .sum(e => e.hoursInFlight)
  .window('calendarDay');
const lockWait = H.metric('lock-wait', H.events.leases(database))
  .mean(e => e.waitMs)
  .by(database)
  .window('1d');

const platformOrder = H.policy.units('platform-order', c => {
  const gpuToday = c.metrics.read(gpuHoursInFlight);
  const gpuSaturated = gpuToday.samples > 0 && (gpuToday.value ?? 0) > 200;
  const pendingMigrations = c.candidates.filter(migrations.holds);
  const pendingBackfills = c.candidates
    .filter(backfills.holds)
    .sort((a, b) => (c.metrics.read(lockWait, database.is(a.data.database)).value ?? 0) - (c.metrics.read(lockWait, database.is(b.data.database)).value ?? 0));
  const pendingEvals = c.candidates.filter(evalRuns.holds);
  return gpuSaturated
    ? [...pendingMigrations, ...pendingBackfills, ...pendingEvals]
    : [...pendingMigrations, ...pendingEvals, ...pendingBackfills];
});

const pool = H.pool('api', [api]).serves(sonnet).policy(policies.soonestReset());

export const platform = H.harness('ml-platform')
  .ledger(sqlite.ledger('./.harness/ledger.sqlite'))
  .pools(pool)
  .lanes(evalRuns, migrations, backfills)
  .scheduler(platformOrder)
  .grants(H.grant(claudeCode.client({ name: 'platform-supervisor' }), H.ops.work.read, H.ops.work.write, H.ops.attempts.manage, H.ops.telemetry.read))
  .observe(observers.board({ path: './BOARD.md' }), observers.telemetry({ path: './TELEMETRY.md' }));
