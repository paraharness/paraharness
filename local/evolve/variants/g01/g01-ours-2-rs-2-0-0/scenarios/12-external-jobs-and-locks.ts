import { z } from 'zod';
import { H } from 'harness-dsl';
import type { Resource } from 'harness-dsl';
import { anthropic } from 'harness-dsl/anthropic';
import { claudeCode } from 'harness-dsl/claude-code';
import { sqlite } from 'harness-dsl/sqlite';
import { supply } from 'harness-dsl/supply';
import { observers } from 'harness-dsl/observers';

const gpuUrl = H.env('GPU_SERVICE_URL');
const gpuToken = H.env('GPU_SERVICE_TOKEN');

const local = H.runner.local('local', { slots: 6 });
const store = sqlite.store('./ml/.harness/store.sqlite');
const sonnet = H.model('claude-sonnet-4-5').pricing(anthropic.pricing());
const api = H.account('api', anthropic.api({ apiKey: H.env('ANTHROPIC_API_KEY') }));

const databaseSchema = z.enum(['orders', 'users']);
type Database = z.infer<typeof databaseSchema>;
const databases: Record<Database, Resource> = {
  orders: H.resource('orders-db'),
  users: H.resource('users-db'),
};

const evalSchema = z.object({ name: z.string(), model: z.string(), dataset: z.string() });

const evalQueued = H.state('eval-queued').pending();
const evaluating = H.state('evaluating').active();
const evalScored = H.state('eval-scored').terminal('success');
const evalFailed = H.state('eval-failed').terminal('failure');
const evalRun = H.work('eval-run').schema(evalSchema).states(evalQueued, evaluating, evalScored, evalFailed);

const prepare = H.command('prepare-eval')
  .input(evalSchema)
  .output(z.object({ datasetUri: z.string() }))
  .runner(local)
  .effect('repeatable')
  .run(async (input, ctx) => {
    const result = await ctx.sh(`./bin/prepare-dataset ${input.dataset}`);
    if (result.code !== 0) throw new Error(result.stderr);
    return { datasetUri: result.stdout.trim() };
  });

const submitted = z.object({ id: z.string() });
const gpuStatus = z.object({
  state: z.enum(['queued', 'running', 'succeeded', 'failed']),
  resultUri: z.string().optional(),
  error: z.string().optional(),
});

const gpuEval = H.job('gpu-eval')
  .input(z.object({ datasetUri: z.string(), model: z.string() }))
  .output(z.object({ resultUri: z.string() }))
  .submit(async (input, ctx) => {
    const response = await fetch(`${ctx.resolve(gpuUrl)}/jobs`, {
      method: 'POST',
      headers: { authorization: `Bearer ${ctx.resolve(gpuToken)}`, 'content-type': 'application/json' },
      body: JSON.stringify(input),
    });
    if (!response.ok) throw new Error(`gpu service answered ${response.status}`);
    return submitted.parse(await response.json()).id;
  })
  .collect(async (ref, ctx) => {
    const response = await fetch(`${ctx.resolve(gpuUrl)}/jobs/${ref}`, {
      headers: { authorization: `Bearer ${ctx.resolve(gpuToken)}` },
    });
    const status = gpuStatus.parse(await response.json());
    if (status.state === 'failed') return { status: 'failed', reason: status.error ?? 'remote failure' };
    if (status.state === 'succeeded' && status.resultUri !== undefined) return { status: 'done', output: { resultUri: status.resultUri } };
    return { status: 'running' };
  })
  .poll('10m');

const score = H.command('score-eval')
  .input(z.object({ resultUri: z.string() }))
  .output(z.object({ score: z.number(), report: z.string() }))
  .runner(local)
  .effect('repeatable')
  .run(async (input, ctx) => {
    const result = await ctx.sh(`./bin/score ${input.resultUri}`);
    if (result.code !== 0) throw new Error(result.stderr);
    return z.object({ score: z.number(), report: z.string() }).parse(JSON.parse(result.stdout));
  });

const analystRole = H.role('eval-analyst').prompt('Summarise the evaluation for the team in five sentences.').intents([]);

const summarizeEval = H.skill('summarize-eval')
  .input(z.object({ name: z.string(), score: z.number(), report: z.string() }))
  .output(z.object({ summary: z.string() }))
  .prompt(i => `Eval ${i.name} scored ${i.score}.\n${i.report}`);

const analyst = H.seat('eval-analyst').role(analystRole).models(sonnet);

const evalFlow = H.flow('eval-run')
  .input(evalSchema)
  .step('prepare', prepare)
  .step('gpu', gpuEval, s => ({ datasetUri: s.steps.prepare.datasetUri, model: s.input.model }))
  .step('score', score, s => ({ resultUri: s.steps.gpu.resultUri }))
  .step('summarize', analyst.call(summarizeEval), s => ({
    name: s.input.name,
    score: s.steps.score.score,
    report: s.steps.score.report,
  }))
  .exit('scored');

const evals = H.lane(
  'evals',
  H.handler('eval-run')
    .of(evalRun)
    .flow(evalFlow)
    .exits({ scored: evalScored })
    .retry({ tries: 2, backoff: 'exponential', delaySeconds: 600, exhausted: evalFailed }),
)
  .from(supply.manual())
  .store(store)
  .wip(2);

const migrationSchema = z.object({
  id: z.string(),
  database: databaseSchema,
  file: z.string(),
  after: z.string().optional(),
});

const migrationQueued = H.state('migration-queued').pending();
const migrating = H.state('migrating').active();
const migrationHeld = H.state('migration-held').waiting();
const migrationApplied = H.state('migration-applied').terminal('success');
const migrationFailed = H.state('migration-failed').terminal('failure');
const migration = H.work('migration')
  .schema(migrationSchema)
  .states(migrationQueued, migrating, migrationHeld, migrationApplied, migrationFailed);

const migrate = H.command('apply-migration')
  .input(migrationSchema)
  .runner(local)
  .effect('unrepeatable')
  .run(async (input, ctx) => {
    const result = await ctx.sh(`./bin/migrate --database ${input.database} --file ${input.file}`);
    if (result.code !== 0) throw new Error(result.stderr);
  });

const migrationFlow = H.flow('apply-migration')
  .input(migrationSchema)
  .resources(s => [H.lease.exclusive(databases[s.input.database])])
  .step('migrate', migrate)
  .exit('applied');

const migrations = H.lane(
  'migrations',
  H.handler('apply-migration')
    .of(migration)
    .flow(migrationFlow)
    .exits({ applied: migrationApplied })
    .retry({ tries: 1, backoff: 'none', exhausted: migrationFailed }),
)
  .from(supply.folder({ path: './migrations', schema: migrationSchema }).key(d => d.id))
  .store(store)
  .after(d => d.after, { failed: migrationHeld });

const backfillSchema = z.object({ table: z.string(), database: databaseSchema, totalRows: z.number() });

const backfillQueued = H.state('backfill-queued').pending();
const backfilling = H.state('backfilling').active();
const backfilled = H.state('backfilled').terminal('success');
const backfillFailed = H.state('backfill-failed').terminal('failure');
const backfill = H.work('backfill').schema(backfillSchema).states(backfillQueued, backfilling, backfilled, backfillFailed);

const batchRows = 10000;

const copyBatch = H.command('copy-batch')
  .input(z.object({ table: z.string(), database: databaseSchema, offset: z.number(), limit: z.number() }))
  .output(z.object({ copied: z.number() }))
  .runner(local)
  .effect('repeatable')
  .run(async (input, ctx) => {
    const result = await ctx.sh(
      `./bin/backfill --database ${input.database} --table ${input.table} --offset ${input.offset} --limit ${input.limit}`,
    );
    if (result.code !== 0) throw new Error(result.stderr);
    return { copied: Number(result.stdout.trim()) };
  });

const backfillFlow = H.flow('backfill')
  .input(backfillSchema)
  .resources(s => [H.lease.shared(databases[s.input.database])])
  .loop('batches', {
    maxIterations: s => Math.ceil(s.input.totalRows / batchRows),
    initial: (): number => 0,
    body: f =>
      f.step('copy', copyBatch, s => ({
        table: s.input.table,
        database: s.input.database,
        offset: s.carry,
        limit: batchRows,
      })),
    next: s => s.carry + batchRows,
    until: s => s.steps.copy.copied < batchRows,
  })
  .exit('filled');

const backfills = H.lane(
  'backfills',
  H.handler('backfill')
    .of(backfill)
    .flow(backfillFlow)
    .exits({ filled: backfilled })
    .retry({ tries: 3, backoff: 'exponential', delaySeconds: 60, exhausted: backfillFailed }),
)
  .from(supply.manual())
  .store(store);

const gpuSecondsInFlight = H.metric('gpu-seconds-in-flight').sum(H.events.jobs(), 'durationSeconds');
const lockWait = H.metric('lock-wait-seconds').mean(H.events.leases(), 'waitSeconds');

export const platform = H.harness('ml-platform')
  .ledger(sqlite.ledger('./ml/.harness/ledger.sqlite'))
  .pools(H.pool('api', [api]).serves(sonnet))
  .lanes(evals, migrations, backfills)
  .scheduler(
    H.scheduler().policy(
      H.policy.schedule('migrations-then-backfills-then-evals', input => [
        ...input.of(migrations),
        ...input.of(backfills),
        ...input.of(evals),
      ]),
    ),
  )
  .grants(
    H.grant(claudeCode.client('platform-supervisor', { session: 'platform' }), H.ops.work.read, H.ops.work.write, H.ops.telemetry.read),
  )
  .metrics(gpuSecondsInFlight, lockWait)
  .observe(observers.board({ path: './ml/BOARD.md' }), observers.telemetry({ path: './ml/TELEMETRY.md' }));
