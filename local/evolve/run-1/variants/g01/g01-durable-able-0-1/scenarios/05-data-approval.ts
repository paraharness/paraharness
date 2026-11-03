import { z } from 'zod';
import { H, type Retry } from 'harness-dsl';
import { sqlite } from 'harness-dsl/sqlite';
import { jsonl } from 'harness-dsl/jsonl';
import { anthropic } from 'harness-dsl/anthropic';
import { claudeCode } from 'harness-dsl/claude-code';
import { ssh } from 'harness-dsl/ssh';
import { markdown } from 'harness-dsl/markdown';

const sourceSystem = z.enum(['crm', 'erp', 'billing', 'warehouse']);
const loadAttributes = z.object({ source: sourceSystem, night: z.string() });
const sourceSystems: readonly z.infer<typeof sourceSystem>[] = ['crm', 'erp', 'billing', 'warehouse'];

const scheduled = H.state('Scheduled', 'pending');
const extracting = H.state('Extracting', 'active');
const validating = H.state('Validating', 'active');
const validationHold = H.state('ValidationHold', 'waiting');
const summarizing = H.state('Summarizing', 'active');
const awaitingApproval = H.state('AwaitingApproval', 'waiting');
const loading = H.state('Loading', 'active');
const verifying = H.state('Verifying', 'active');
const loaded = H.state('Loaded', 'terminal', 'success');
const loadedWithWarnings = H.state('LoadedWithWarnings', 'terminal', 'success');
const rejected = H.state('Rejected', 'terminal', 'failure');
const failed = H.state('Failed', 'terminal', 'failure');
const cancelled = H.state('Cancelled', 'terminal', 'neutral');

const NightlyLoad = H.kind('NightlyLoad')
  .attributes(loadAttributes)
  .states(
    scheduled,
    extracting,
    validating,
    validationHold,
    summarizing,
    awaitingApproval,
    loading,
    verifying,
    loaded,
    loadedWithWarnings,
    rejected,
    failed,
    cancelled,
  )
  .key(attrs => `${attrs.source}@${attrs.night}`);

const etlHost = ssh.host('etl-host', { host: 'etl.internal', user: 'etl', key: H.env('ETL_SSH_KEY') });
const sourceInput = z.object({ source: sourceSystem });

const extract = H.command('extract')
  .input(sourceInput)
  .argv(input => ['etl', 'extract', input.source])
  .runner(etlHost);
const validate = H.command('validate')
  .input(sourceInput)
  .argv(input => ['etl', 'validate', '--json', input.source])
  .output(z.object({ ok: z.boolean(), report: z.string() }))
  .runner(etlHost);
const load = H.command('load')
  .input(sourceInput)
  .argv(input => ['etl', 'load', input.source])
  .runner(etlHost);
const verify = H.command('verify')
  .input(sourceInput)
  .argv(input => ['etl', 'verify', '--json', input.source])
  .output(z.object({ driftPct: z.number() }))
  .runner(etlHost);

const transientRetry: Retry = { maxAttempts: 3, backoff: 'exponential', initialDelayMs: 60000, maxDelayMs: 900000 };

const apiAccount = anthropic.account('data-api', { apiKey: H.env('ANTHROPIC_API_KEY') });
const sonnet = anthropic.model('sonnet', { id: 'claude-sonnet-4-5' });
const dataPool = H.pool('data-pool').accounts(apiAccount);

const summaryRole = H.role('anomaly-summarizer')
  .intents('read')
  .instructions('Explain the validation anomalies in plain language for the approver.');
const summarizer = H.agent('anomaly-summarizer-agent')
  .role(summaryRole)
  .model(sonnet)
  .output(z.object({ summary: z.string() }));

const approverTaste = H.memory('approver-taste', 'taste');
const tasteJournal = H.journal('approver-taste-journal', approverTaste)
  .store(jsonl.memoryStore({ path: '.harness/memory/approver-taste.jsonl' }))
  .recall(H.recall('approver-recall', { by: 'specificity', limit: 8 }))
  .readBy(summaryRole);

const nightlyLoad = H.flow('nightly-load')
  .input(loadAttributes)
  .step('extract', extract, ctx => ({ source: ctx.unit.attributes.source }), { retry: transientRetry, onCrash: 'rerun' })
  .step('validate', validate, ctx => ({ source: ctx.unit.attributes.source }), { onCrash: 'rerun' })
  .halt('validationReview', {
    ask: ctx => `Validation failed for ${ctx.unit.attributes.source} (${ctx.unit.attributes.night}):\n\n${ctx.steps.validate.report}`,
    decision: z.object({ proceed: z.boolean(), note: z.string().optional() }),
    skip: ctx => (ctx.steps.validate.ok ? { proceed: true } : undefined),
  })
  .exit('invalid', ctx => !ctx.steps.validationReview.proceed)
  .step('summarize', summarizer, ctx => ({
    task: `Summarize the anomalies in this validation report for ${ctx.unit.attributes.source}:\n\n${ctx.steps.validate.report}`,
    skills: ['anomaly-summary'],
  }))
  .halt('approval', {
    ask: ctx => `Approve tonight's ${ctx.unit.attributes.source} load?\n\n${ctx.steps.summarize.summary}`,
    decision: z.object({ approved: z.boolean(), note: z.string().optional() }),
  })
  .exit('rejected', ctx => !ctx.steps.approval.approved)
  .step('load', load, ctx => ({ source: ctx.unit.attributes.source }), { retry: transientRetry, onCrash: 'park' })
  .step('verify', verify, ctx => ({ source: ctx.unit.attributes.source }), { onCrash: 'rerun' })
  .exit('loadedWithWarnings', ctx => ctx.steps.verify.driftPct > 0)
  .exit('loaded');

const loadLane = H.lane('nightly-loads', NightlyLoad)
  .supply(H.clock('nightly-0200').daily('02:00', { tz: 'Europe/Berlin' }), (tick, to) =>
    sourceSystems.map(source => to.create({ source, night: tick.at.toISOString().slice(0, 10) })),
  )
  .store(sqlite.store({ path: '.harness/loads.db' }))
  .handler(nightlyLoad, {
    exits: { invalid: failed, rejected, loadedWithWarnings, loaded },
    during: {
      extract: extracting,
      validate: validating,
      validationReview: validationHold,
      summarize: summarizing,
      approval: awaitingApproval,
      load: loading,
      verify: verifying,
    },
    failure: failed,
    cancelled,
  });

const approvalWindowCloses = H.trigger('approval-window-closes')
  .on(H.when.timer(loadLane, {
    at: unit => H.nextTime('09:00', { after: unit.createdAt, tz: 'Europe/Berlin' }),
    if: unit => unit.state === 'AwaitingApproval',
  }))
  .signal(loadLane, H.cancel, event => ({ key: event.unit.key, payload: { reason: 'approval window closed at 09:00' } }));

const approver = claudeCode.supervisor('approver-supervisor', {
  grants: [H.ops.workRead, H.ops.blockersResolve, H.ops.memoryRead, H.ops.memoryWrite, H.ops.telemetryRead],
});

export const dataJob = H.harness('data-job')
  .ledger(sqlite.ledger({ path: '.harness/data-ledger.db' }))
  .pools(dataPool)
  .lanes(loadLane)
  .journals(tasteJournal)
  .triggers(approvalWindowCloses)
  .scheduler(H.scheduler('data-scheduler').priority(loadLane))
  .clients(approver)
  .observers(markdown.board({ path: 'BOARD.md' }), markdown.telemetry({ path: 'TELEMETRY.md' }));
