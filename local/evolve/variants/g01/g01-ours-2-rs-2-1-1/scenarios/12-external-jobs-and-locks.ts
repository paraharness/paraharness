import { z } from 'zod';
import { H } from 'harness-dsl';
import { claudeCode } from 'harness-dsl/claude-code';
import { anthropic } from 'harness-dsl/anthropic';
import { sqlite } from 'harness-dsl/sqlite';
import { folder, manual } from 'harness-dsl/supply';
import { runners } from 'harness-dsl/runners';
import { policies } from 'harness-dsl/policies';
import { observers } from 'harness-dsl/observers';

const local = runners.local({ name: 'ml-host', slots: 4 });

const subscription = H.account('claude-max', claudeCode.driver({ configDir: '~/.claude' }));
const sonnet = H.model('claude-sonnet-4-5').pricing(anthropic.pricing());
const pool = H.pool('ml', [subscription]).serves(sonnet).policy(policies.soonestReset());

const databases = { orders: H.resource('orders-db'), billing: H.resource('billing-db') };
const databaseName = z.enum(['orders', 'billing']);

const evalSchema = z.object({ model: z.string(), suite: z.string() });
const evalQueued = H.state('queued').pending();
const evalScored = H.state('scored').terminal('success');
const evalFailed = H.state('failed').terminal('failure');
const evalRun = H.work('EvalRun').schema(evalSchema).states(evalQueued, evalScored, evalFailed);

const prepare = H.command('prepare')
  .input(evalSchema)
  .output(z.object({ bundle: z.string() }))
  .runner(local)
  .effect('repeatable')
  .run(async (input, ctx) => {
    const result = await ctx.exec(['eval', 'bundle', input.model, input.suite]);
    if (result.code !== 0) throw new Error(result.stderr);
    return { bundle: result.stdout.trim() };
  });

const gpuStatus = z.object({
  state: z.enum(['running', 'failed', 'done']),
  message: z.string(),
  resultsUri: z.string(),
  gpuHours: z.number(),
});

const gpuEval = H.job('gpu-eval')
  .input(z.object({ bundle: z.string() }))
  .output(z.object({ resultsUri: z.string(), gpuHours: z.number() }))
  .submit(async (input, ctx) => {
    const submitted = await ctx.exec(['gpu', 'submit', input.bundle]);
    if (submitted.code !== 0) throw new Error(submitted.stderr);
    return submitted.stdout.trim();
  })
  .collect(async (ref, ctx) => {
    const polled = await ctx.exec(['gpu', 'status', ref, '--json']);
    const status = gpuStatus.parse(JSON.parse(polled.stdout));
    if (status.state === 'running') return { status: 'pending' };
    if (status.state === 'failed') return { status: 'failed', reason: status.message };
    return { status: 'done', output: { resultsUri: status.resultsUri, gpuHours: status.gpuHours } };
  }, '10m')
  .detect(async (input, ctx) => {
    const found = await ctx.exec(['gpu', 'find', '--bundle', input.bundle]);
    const ref = found.stdout.trim();
    return ref === '' ? undefined : ref;
  });

const score = H.command('score')
  .input(z.object({ resultsUri: z.string() }))
  .output(z.object({ score: z.number() }))
  .runner(local)
  .effect('repeatable')
  .run(async (input, ctx) => {
    const result = await ctx.exec(['eval', 'score', input.resultsUri]);
    return { score: Number(result.stdout.trim()) };
  });

const analystRole = H.role('eval-analyst').prompt('Summarise the evaluation for the model owners.');
const summarizeSkill = H.skill('summarize-eval').input(z.object({ model: z.string(), suite: z.string(), score: z.number() })).output(z.object({ summary: z.string() }));
const analyst = H.seat('eval-analyst').role(analystRole).skill(summarizeSkill).models(sonnet);

const evalFlow = H.flow('eval-run')
  .input(evalSchema)
  .step('prepare', prepare, s => s.input)
  .step('gpu', gpuEval, s => ({ bundle: s.prepare.bundle }))
  .step('score', score, s => ({ resultsUri: s.gpu.resultsUri }))
  .step('summarize', analyst, s => ({ model: s.input.model, suite: s.input.suite, score: s.score.score }))
  .exit('scored');

const evals = H.lane('evals').of(evalRun)
  .from(manual('ml-engineers'))
  .store(sqlite.store('./.harness/evals.sqlite'))
  .handle(evalFlow, { exits: { scored: evalScored }, retry: { retries: 1, exhausted: evalFailed } })
  .wip(2);

const migrationSchema = z.object({ id: z.string(), database: databaseName, sql: z.string(), previous: z.string().nullable() });
const migrationPending = H.state('pending').pending();
const migrationApplied = H.state('applied').terminal('success');
const migrationFailed = H.state('failed').terminal('failure');
const migration = H.work('Migration').schema(migrationSchema).states(migrationPending, migrationApplied, migrationFailed);

const applyMigration = H.command('apply-migration')
  .input(migrationSchema)
  .output(z.object({ applied: z.boolean() }))
  .runner(local)
  .effect('unrepeatable')
  .run(async (input, ctx) => {
    const result = await ctx.exec(['db', 'migrate', input.database, input.id], { stdin: input.sql });
    if (result.code !== 0) throw new Error(result.stderr);
    return { applied: true };
  });

const migrationFlow = H.flow('migration')
  .input(migrationSchema)
  .resources(input => [databases[input.database].exclusive()])
  .step('apply', applyMigration, s => s.input)
  .exit('applied');

const migrationNumber = (fileName: string) => fileName.slice(0, 4);

const migrations = H.lane('migrations').of(migration)
  .from(folder.files({
    name: 'migration-folder',
    path: './migrations',
    glob: '*.sql',
    key: file => migrationNumber(file.name),
    data: file => {
      const number = Number(migrationNumber(file.name));
      return {
        id: migrationNumber(file.name),
        database: databaseName.parse(file.frontmatter.database),
        sql: file.body,
        previous: number > 1 ? String(number - 1).padStart(4, '0') : null,
      };
    },
  }))
  .store(sqlite.store('./.harness/migrations.sqlite'))
  .order({ after: data => (data.previous === null ? [] : [data.previous]) })
  .handle(migrationFlow, { exits: { applied: migrationApplied }, retry: { retries: 0, exhausted: migrationFailed } });

const backfillSchema = z.object({ table: z.string(), database: databaseName, rows: z.number() });
const backfillQueued = H.state('queued').pending();
const backfillDone = H.state('done').terminal('success');
const backfillFailed = H.state('failed').terminal('failure');
const backfill = H.work('Backfill').schema(backfillSchema).states(backfillQueued, backfillDone, backfillFailed);

const batchRows = 10_000;
const copyBatch = H.command('copy-batch')
  .input(z.object({ table: z.string(), database: databaseName, offset: z.number(), limit: z.number() }))
  .output(z.object({ copied: z.number() }))
  .runner(local)
  .effect('repeatable')
  .run(async (input, ctx) => {
    const result = await ctx.exec(['db', 'backfill', input.database, input.table, '--offset', String(input.offset), '--limit', String(input.limit)]);
    if (result.code !== 0) throw new Error(result.stderr);
    return { copied: Number(result.stdout.trim()) };
  });

const backfillFlow = H.flow('backfill')
  .input(backfillSchema)
  .resources(input => [databases[input.database].shared()])
  .loop('batch', {
    max: s => Math.ceil(s.input.rows / batchRows),
    body: f => f.step('copy', copyBatch, s => ({ table: s.input.table, database: s.input.database, offset: s.batch.iteration * batchRows, limit: batchRows })),
    until: s => s.copy.copied < batchRows,
  })
  .exit('done');

const backfills = H.lane('backfills').of(backfill)
  .from(manual('data-engineers'))
  .store(sqlite.store('./.harness/backfills.sqlite'))
  .handle(backfillFlow, { exits: { done: backfillDone }, retry: { retries: 2, backoff: { initial: '5m', factor: 2 }, exhausted: backfillFailed } });

export const gpuHoursPerDay = H.metric('gpu-hours-in-flight', H.events.jobs(gpuEval)).sum(e => e.hoursInFlight).window('calendarDay');
export const lockWait = H.metric('lock-wait', H.events.leases()).mean(e => e.waitMs).by('resource').window('7d');

const supervisor = claudeCode.client({ name: 'ml-platform' });

export const harness = H.harness('ml-platform')
  .ledger(sqlite.ledger('./.harness/ledger.sqlite'))
  .pools(pool)
  .lanes(evals, migrations, backfills)
  .scheduler(H.policy.units('migrations-first', choice =>
    [...choice.candidates].sort((a, b) => (a.lane === migrations.name ? 0 : 1) - (b.lane === migrations.name ? 0 : 1) || a.queuedAt.getTime() - b.queuedAt.getTime()),
  ))
  .grants(H.grant(supervisor, H.ops.attempts.manage, H.ops.work.read, H.ops.work.write, H.ops.telemetry.read))
  .observe(observers.board({ path: './BOARD.md' }), observers.telemetry({ path: './TELEMETRY.md' }));
