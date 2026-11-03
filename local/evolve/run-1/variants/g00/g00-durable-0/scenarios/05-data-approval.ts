import { z } from 'zod';
import { H } from 'harness-dsl';
import { anthropic } from 'harness-dsl/anthropic';
import { claudeCode } from 'harness-dsl/claude-code';
import { ssh } from 'harness-dsl/ssh';
import { local } from 'harness-dsl/local';
import { sqlite } from 'harness-dsl/sqlite';
import { jsonl } from 'harness-dsl/jsonl';
import { markdown } from 'harness-dsl/markdown';

const nightlyLoad = z.object({ source: z.string(), night: z.string() });

const Scheduled = H.state('Scheduled', 'pending');
const Extracting = H.state('Extracting', 'active');
const Validating = H.state('Validating', 'active');
const ReviewingValidation = H.state('ReviewingValidation', 'active');
const Summarizing = H.state('Summarizing', 'active');
const AwaitingApproval = H.state('AwaitingApproval', 'active');
const Loading = H.state('Loading', 'active');
const Verifying = H.state('Verifying', 'active');
const Loaded = H.state('Loaded', 'succeeded');
const LoadedWithWarnings = H.state('LoadedWithWarnings', 'succeeded');
const Rejected = H.state('Rejected', 'ended');
const Failed = H.state('Failed', 'failed');
const Expired = H.state('Expired', 'cancelled');

const NightlyLoad = H.kind('NightlyLoad')
  .attributes(nightlyLoad)
  .states(
    Scheduled,
    Extracting,
    Validating,
    ReviewingValidation,
    Summarizing,
    AwaitingApproval,
    Loading,
    Verifying,
    Loaded,
    LoadedWithWarnings,
    Rejected,
    Failed,
    Expired,
  )
  .key(a => `${a.source}@${a.night}`);

const etlHost = ssh.host('etl-host', { host: 'etl.internal', user: 'etl', key: H.env('ETL_SSH_KEY') }).slots(4);
const localRunner = local.runner('local').slots(4);

const extract = H.command('extract')
  .input(nightlyLoad)
  .argv(i => ['/opt/etl/extract', i.source, i.night])
  .runner(etlHost);

const validate = H.command('validate')
  .input(nightlyLoad)
  .argv(i => ['./bin/validate', i.source, i.night])
  .output(z.object({ ok: z.boolean(), report: z.string() }))
  .runner(localRunner);

const load = H.command('load')
  .input(nightlyLoad)
  .argv(i => ['/opt/etl/load', i.source, i.night])
  .runner(etlHost);

const verify = H.command('verify')
  .input(nightlyLoad)
  .argv(i => ['/opt/etl/verify', i.source, i.night])
  .output(z.object({ driftPct: z.number() }))
  .runner(etlHost);

const backoff = H.retry({ maxAttempts: 4, backoff: 'exponential', initialDelayMs: 30000, maxDelayMs: 600000 });

const apiAccount = anthropic.account('anthropic-api', { apiKey: H.env('ANTHROPIC_API_KEY') });
const pool = H.pool('api-pool').accounts(apiAccount);
const sonnet = anthropic.model('sonnet', { id: 'claude-sonnet-4-5', pool });

const summarizerRole = H.role('summarizer').instructions('Explain data anomalies in plain language for the approver.');
const summaryAgent = H.agent('summary-agent').role(summarizerRole).model(sonnet).budgetTokens(15000);

const loadFlow = H.flow('nightly-load')
  .input(nightlyLoad)
  .step('extract', extract, ctx => ctx.unit.attributes, { retry: backoff, timeoutMs: 3600000 })
  .step('validate', validate, ctx => ctx.unit.attributes)
  .halt('validationReview', {
    ask: ctx => `Validation failed for ${ctx.unit.attributes.source}:\n\n${ctx.steps.validate.report}`,
    decision: z.object({ proceed: z.boolean(), note: z.string() }),
    skip: ctx => (ctx.steps.validate.ok ? { proceed: true, note: '' } : undefined),
  })
  .exit('invalid', ctx => !ctx.steps.validationReview.proceed)
  .step('summarize', summaryAgent, ctx => ({
    task: `Summarise the anomalies for ${ctx.unit.attributes.source} on ${ctx.unit.attributes.night}:\n\n${ctx.steps.validate.report}`,
    resources: [ctx.unit.attributes.source],
  }))
  .halt('approval', {
    ask: ctx => `Approve loading ${ctx.unit.attributes.source} for ${ctx.unit.attributes.night}?\n\n${ctx.steps.summarize}`,
    decision: z.object({ approved: z.boolean(), note: z.string() }),
  })
  .exit('rejected', ctx => !ctx.steps.approval.approved)
  .step('load', load, ctx => ctx.unit.attributes, { retry: backoff, timeoutMs: 3600000 })
  .step('verify', verify, ctx => ctx.unit.attributes)
  .exit('loadedWithWarnings', ctx => ctx.steps.verify.driftPct > 0)
  .exit('loaded');

const sources = ['crm', 'billing', 'inventory', 'support'];

const loadLane = H.lane('nightly-loads', NightlyLoad)
  .supply(H.clock('nightly-0200').daily('02:00', { tz: 'Europe/Berlin' }), (tick, to) =>
    sources.map(source => to.create({ source, night: tick.at.toISOString().slice(0, 10) })),
  )
  .store(sqlite.store({ path: '.harness/loads.db' }))
  .handler(loadFlow, {
    exits: { invalid: Failed, rejected: Rejected, loadedWithWarnings: LoadedWithWarnings, loaded: Loaded },
    during: {
      extract: Extracting,
      validate: Validating,
      validationReview: ReviewingValidation,
      summarize: Summarizing,
      approval: AwaitingApproval,
      load: Loading,
      verify: Verifying,
    },
    failure: Failed,
  });

const approvalWindowCloses = H.trigger('approval-window-closes-at-0900')
  .on(H.when.timer(loadLane, {
    at: unit => H.nextTime('09:00', { after: unit.createdAt, tz: 'Europe/Berlin' }),
    if: unit => unit.attempt !== undefined && unit.attempt.status === 'blocked' && unit.attempt.step === 'approval',
  }))
  .signal(H.cancel, () => ({ reason: 'Approval not given by 09:00' }));

const taste = H.memory('approver-taste').trust('taste');
const tasteJournal = H.journal('approver-preferences', taste)
  .store(jsonl.memoryStore({ path: '.harness/taste.jsonl' }))
  .recall(H.recall('most-specific', { by: 'specificity', limit: 6 }))
  .readBy(summarizerRole);

const supervisor = claudeCode.supervisor('supervisor', {
  grants: [H.ops.workRead, H.ops.blockersResolve, H.ops.workCancel, H.ops.memoryWrite, H.ops.telemetryRead],
});

export const dataJob = H.harness('nightly-data')
  .ledger(sqlite.ledger({ path: '.harness/ledger.db' }))
  .lanes(loadLane)
  .journals(tasteJournal)
  .triggers(approvalWindowCloses)
  .scheduler(H.scheduler('nightly').priority(loadLane))
  .clients(supervisor)
  .observers(markdown.board({ path: 'BOARD.md' }), markdown.telemetry({ path: 'TELEMETRY.md' }));

export const running = dataJob.start();
