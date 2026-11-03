import { z } from 'zod';
import { H } from 'harness-dsl';
import * as sqlite from 'harness-dsl/sqlite';
import * as folder from 'harness-dsl/folder';
import * as claudeCode from 'harness-dsl/claude-code';
import * as anthropic from 'harness-dsl/anthropic';
import * as local from 'harness-dsl/local';
import * as markdown from 'harness-dsl/markdown';

const databases = {
  orders: H.resource('orders-db'),
  billing: H.resource('billing-db'),
};

const Queued = H.state('Queued', 'pending');
const Preparing = H.state('Preparing', 'active');
const OnGpu = H.state('OnGpu', 'waiting');
const Scoring = H.state('Scoring', 'active');
const Evaluated = H.state('Evaluated', 'terminal', 'success');
const EvalFailed = H.state('EvalFailed', 'terminal', 'failure');
const EvalHeld = H.state('EvalHeld', 'waiting');

const EvalRun = H.work('EvalRun')
  .attributes({ runId: z.string(), model: z.string(), suite: z.string() })
  .states([Queued, Preparing, OnGpu, Scoring, Evaluated, EvalFailed, EvalHeld])
  .failsTo(EvalFailed)
  .key((unit) => unit.attributes.runId);

const MigrationPending = H.state('MigrationPending', 'pending');
const Migrating = H.state('Migrating', 'active');
const MigrationHeld = H.state('MigrationHeld', 'waiting');
const OutOfOrder = H.state('OutOfOrder', 'waiting');
const Applied = H.state('Applied', 'terminal', 'success');
const MigrationFailed = H.state('MigrationFailed', 'terminal', 'failure');

const Migration = H.work('Migration')
  .attributes({ sequence: z.number(), database: z.enum(['orders', 'billing']), path: z.string() })
  .states([MigrationPending, Migrating, MigrationHeld, OutOfOrder, Applied, MigrationFailed])
  .failsTo(MigrationFailed)
  .key((unit) => String(unit.attributes.sequence).padStart(4, '0'));

const BackfillPending = H.state('BackfillPending', 'pending');
const Backfilling = H.state('Backfilling', 'active');
const BackfillHeld = H.state('BackfillHeld', 'waiting');
const Backfilled = H.state('Backfilled', 'terminal', 'success');
const BackfillFailed = H.state('BackfillFailed', 'terminal', 'failure');

const Backfill = H.work('Backfill')
  .attributes({ table: z.string(), database: z.enum(['orders', 'billing']) })
  .states([BackfillPending, Backfilling, BackfillHeld, Backfilled, BackfillFailed])
  .failsTo(BackfillFailed)
  .key((unit) => `${unit.attributes.database}.${unit.attributes.table}`);

const prepareEval = H.command('prepare-eval', ['evals', 'prepare']);
const gpuEval = H.job('gpu-eval', {
  submit: H.command('gpu-submit', ['gpu', 'submit']).parses({ jobId: z.string() }),
  collect: H.command('gpu-status', ['gpu', 'status']).parses({
    state: z.enum(['running', 'succeeded', 'failed']),
    artifact: z.string().nullable(),
  }),
  poll: { minutes: 10 },
  status: (data) => data.state,
});
const scoreEval = H.command('score-eval', ['evals', 'score']).parses({ score: z.number(), report: z.string() });
const summarizer = H.agent('eval-summarizer', H.role('eval-summarizer').instructions('Summarize the eval result for the team.'))
  .model(anthropic.model('claude-sonnet-4-5'))
  .pool(anthropic.account('ml-api', { apiKey: H.env('ANTHROPIC_API_KEY') }));

const evalFlow = H.flow('eval-run')
  .requires({ runId: z.string(), model: z.string(), suite: z.string() })
  .step('prepare', prepareEval, (c) => ({ args: [c.input.runId, c.input.suite] }), { restart: 'rerun' })
  .step('gpu', gpuEval, (c) => ({ args: [c.input.runId, c.input.model], env: { GPU_TOKEN: H.env('GPU_TOKEN') } }))
  .step('score', scoreEval, (c) => ({ args: [c.input.runId, c.out.gpu.artifact ?? ''] }), { restart: 'rerun' })
  .step('summarize', summarizer, (c) => ({ task: `Eval ${c.input.runId} of ${c.input.model} on ${c.input.suite}: score ${c.out.score.data.score}. ${c.out.score.data.report}` }))
  .ends(['evaluated'], () => 'evaluated');

const applyMigration = H.command('apply-migration', ['db', 'migrate']);

const migrationFlow = H.flow('migration')
  .requires({ path: z.string(), database: z.string() })
  .step('migrate', applyMigration, (c) => ({ args: [c.input.database, c.input.path] }), { restart: 'escalate' })
  .ends(['applied'], () => 'applied');

const copyBatch = H.command('backfill-batch', ['db', 'backfill']).parses({ rows: z.number(), lastId: z.number() });

const backfillFlow = H.flow('backfill')
  .requires({ table: z.string(), database: z.string() })
  .loop(
    'batches',
    { carry: { afterId: z.number() }, rounds: () => 100_000 },
    (round) =>
      round.step(
        'copy',
        copyBatch,
        (c) => ({ args: [c.input.database, c.input.table, String(c.carry === null ? 0 : c.carry.afterId), '10000'] }),
        { restart: 'rerun' },
      ),
    (last) => (last.copy.data.rows < 10_000 ? null : { afterId: last.copy.data.lastId }),
  )
  .ends(['backfilled'], () => 'backfilled');

const store = sqlite.store(EvalRun, 'ml/evals.db');
const shell = local.shell({ slots: 4 });

const evalRuns = H.lane('eval-runs', EvalRun)
  .supply([H.supply.operator()])
  .store(store)
  .handler(evalFlow, {
    states: { prepare: Preparing, gpu: OnGpu, score: Scoring, summarize: Scoring, evaluated: Evaluated },
    opens: Preparing,
    blocked: EvalHeld,
  })
  .runner(shell)
  .wip(2);

const migrations = H.lane('migrations', Migration)
  .supply([
    folder.files(Migration, 'migrations', (file, supply) => {
      const database = file.frontmatter.database;
      const sequence = file.frontmatter.sequence;
      if (typeof sequence !== 'number') return null;
      if (database !== 'orders' && database !== 'billing') return null;
      return supply.create({ attributes: { sequence, database, path: file.path } });
    }),
  ])
  .store(sqlite.store(Migration, 'ml/migrations.db'))
  .handler(migrationFlow, {
    states: { migrate: Migrating, applied: Applied },
    opens: Migrating,
    blocked: MigrationHeld,
  })
  .runner(shell)
  .wip(4)
  .locks((unit) => [{ resource: databases[unit.attributes.database], mode: 'exclusive' }])
  .after(
    (unit) => (unit.attributes.sequence > 1 ? String(unit.attributes.sequence - 1).padStart(4, '0') : null),
    OutOfOrder,
  );

const backfills = H.lane('backfills', Backfill)
  .supply([H.supply.operator()])
  .store(sqlite.store(Backfill, 'ml/backfills.db'))
  .handler(backfillFlow, {
    states: { copy: Backfilling, backfilled: Backfilled },
    opens: Backfilling,
    blocked: BackfillHeld,
  })
  .runner(shell)
  .wip(4)
  .locks((unit) => [{ resource: databases[unit.attributes.database], mode: 'shared' }]);

const platformReport = H.report('ml-platform', (c) => ({
  'gpu jobs in flight today': c.metrics.jobs({ executable: gpuEval, sinceMs: c.clock.startOfDay() }),
  'lock wait on orders-db, last day': c.metrics.lockWait({ resource: databases.orders, window: { days: 1 } }),
  'lock wait on billing-db, last day': c.metrics.lockWait({ resource: databases.billing, window: { days: 1 } }),
}));

const supervisorAccess = H.access('ml-supervisor').allows([
  H.ops.readWork,
  H.ops.createWork,
  H.ops.updateWork,
  H.ops.manageAttempts,
  H.ops.resolveBlocks,
  H.ops.readTelemetry,
]);

export const mlPlatform = H.harness('ml-platform')
  .ledger(sqlite.ledger('ml/ledger.db'))
  .lanes([evalRuns, migrations, backfills])
  .schedule(
    H.policy.schedule('migrations-first', (c) => ({
      start: c.order(
        (candidate) => (candidate.is(migrations) ? 0 : candidate.is(backfills) ? 1 : 2),
        (candidate) => candidate.enqueuedAt,
      ),
    })),
  )
  .clients([claudeCode.supervisor('ml-supervisor', supervisorAccess, { port: H.slot.port(0) })])
  .projections([markdown.board('ml/BOARD.md'), markdown.telemetry('ml/TELEMETRY.md')])
  .reports([platformReport]);
