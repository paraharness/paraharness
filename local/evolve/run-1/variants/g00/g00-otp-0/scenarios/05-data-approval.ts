import { z } from 'zod';
import { H } from 'harness-dsl';
import { sqlite } from 'harness-dsl/sqlite';
import { jsonl } from 'harness-dsl/jsonl';
import { anthropic } from 'harness-dsl/anthropic';
import { claudeCode } from 'harness-dsl/claude-code';
import { shell } from 'harness-dsl/shell';
import { ssh } from 'harness-dsl/ssh';
import { markdown } from 'harness-dsl/markdown';

const Running = H.state('running', 'runnable');
const Loaded = H.state('loaded', 'succeeded');
const LoadedWithWarnings = H.state('loaded-with-warnings', 'succeeded');
const Rejected = H.state('rejected', 'ended');
const Failed = H.state('failed', 'failed');
const Expired = H.state('expired', 'cancelled');

const NightlyLoad = H.kind('NightlyLoad', {
  data: z.object({ source: z.string(), night: z.string() }),
  key: (load) => `${load.source}@${load.night}`,
})
  .states([Running, Loaded, LoadedWithWarnings, Rejected, Failed, Expired], { initial: Running })
  .timeout(Running, H.time.daily('09:00'), 'approvalWindowClosed')
  .on('approvalWindowClosed', { from: [Running], to: Expired, attempt: 'cancel', guard: (unit) => unit.blocked })
  .on('cancel', { from: [Running], to: Expired, attempt: 'cancel' });

const Taste = H.memory('approver-taste', { authority: 'owner' });
const tasteJournal = H.journal('approver-taste', Taste)
  .store(jsonl.store('memory/approver-taste.jsonl'))
  .recall(H.recall.bySpecificity({ limit: 10 }));

const apiAccount = anthropic.apiKey('etl-api', { key: H.env('ANTHROPIC_API_KEY') });
const etlPool = H.pool('etl').accounts([{ account: apiAccount, share: 1 }]);

const etlHost = ssh.host({ host: 'etl.internal', user: 'etl', privateKey: H.env('ETL_SSH_KEY'), slots: 2 });
const local = shell.local({ slots: 2 });

const target = z.object({ source: z.string(), night: z.string() });
const backoff = H.retry.exponential({ attempts: 3, initialSeconds: 60, factor: 2 });

const extract = H.command('extract', {
  input: target,
  argv: (input) => ['etl', 'extract', input.source, '--night', input.night],
  runner: etlHost,
});

const validate = H.command('validate', {
  input: target,
  argv: (input) => ['etl', 'validate', input.source, '--night', input.night],
  runner: local,
});

const load = H.command('load', {
  input: target,
  argv: (input) => ['etl', 'load', input.source, '--night', input.night],
  runner: etlHost,
});

const verify = H.command('verify', {
  input: target,
  output: z.object({ driftPercent: z.number() }),
  argv: (input) => ['etl', 'verify', input.source, '--night', input.night, '--json'],
  runner: local,
});

const summarizerRole = H.role('anomaly-summarizer', {
  prompt: 'Summarise the anomalies in the validation report in plain language for the approver.',
  intents: [],
  input: z.object({ source: z.string(), night: z.string(), validationReport: z.string() }),
  output: z.object({ summary: z.string() }),
});

const summarizer = H.agent('anomaly-summarizer', summarizerRole)
  .model(anthropic.model('claude-sonnet-4-5'))
  .pool(etlPool)
  .recall(tasteJournal);

const nightlyLoad = H.flow(
  'nightly-load',
  { input: target, exits: ['loaded', 'loadedWithWarnings', 'rejected', 'failed'] },
  async (ctx) => {
    const unit = { source: ctx.input.source, night: ctx.input.night };
    await ctx.run('extract', extract, unit, { retry: backoff });
    const validation = await ctx.try('validate', validate, unit);
    if (validation.ok === false) {
      const review = await ctx.halt('validation-failed', {
        question: `Validation of ${unit.source} for ${unit.night} failed. Continue to summary and approval?`,
        report: validation.stdout,
        decision: z.object({ proceed: z.boolean() }),
      });
      if (review.proceed === false) {
        return ctx.exit('failed');
      }
    }
    const summary = await ctx.run('summarize', summarizer, {
      source: unit.source,
      night: unit.night,
      validationReport: validation.ok ? validation.output.stdout : validation.stdout,
    });
    const approval = await ctx.halt('approve-load', {
      question: `Load ${unit.source} for ${unit.night}?`,
      report: summary.summary,
      decision: z.object({ approved: z.boolean(), note: z.string() }),
    });
    if (approval.approved === false) {
      return ctx.exit('rejected');
    }
    await ctx.run('load', load, unit, { retry: backoff });
    const verification = await ctx.run('verify', verify, unit);
    if (verification.driftPercent === 0) {
      return ctx.exit('loaded');
    }
    return verification.driftPercent <= 0.5 ? ctx.exit('loadedWithWarnings') : ctx.exit('failed');
  },
);

const sources = ['crm', 'billing', 'inventory', 'web-analytics'];

const loadLane = H.lane('nightly-loads', NightlyLoad)
  .supply(
    H.supply.schedule(NightlyLoad, H.time.daily('02:00'), (tick, unit) =>
      sources.map((source) => unit.create({ source, night: tick.at.toISOString().slice(0, 10) })),
    ),
  )
  .store(sqlite.store('loads.db'))
  .handle(Running, nightlyLoad, {
    exits: { loaded: Loaded, loadedWithWarnings: LoadedWithWarnings, rejected: Rejected, failed: Failed },
    crash: { retries: 0, then: Failed },
  })
  .limit({ wip: 4 });

const scheduler = H.scheduler('oldest-first', (query) => ({
  order: [...query.pending].sort((a, b) => b.waitingSeconds - a.waitingSeconds),
}));

const supervisor = H.client('approver', claudeCode.session()).grant([
  H.ops.readWork,
  H.ops.resolveBlockers,
  H.ops.readMemory,
  H.ops.writeMemory,
  H.ops.readTelemetry,
]);

export const harness = H.harness('nightly-data')
  .ledger(sqlite.ledger('data-ledger.db'))
  .lanes([loadLane])
  .journals([tasteJournal])
  .scheduler(scheduler)
  .clients([supervisor])
  .observers([markdown.board('BOARD.md'), markdown.telemetry('TELEMETRY.md')]);
