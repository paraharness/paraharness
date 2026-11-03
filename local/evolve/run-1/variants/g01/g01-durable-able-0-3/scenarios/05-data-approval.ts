import { z } from 'zod';
import { H, Retry } from 'harness-dsl';
import { sqlite } from 'harness-dsl/sqlite';
import { jsonl } from 'harness-dsl/jsonl';
import { anthropic } from 'harness-dsl/anthropic';
import { claudeCode } from 'harness-dsl/claude-code';
import { ssh } from 'harness-dsl/ssh';
import { local } from 'harness-dsl/local';
import { markdown } from 'harness-dsl/markdown';

const Scheduled = H.state('Scheduled', 'pending');
const Extracting = H.state('Extracting', 'active');
const Validating = H.state('Validating', 'active');
const ReviewingValidation = H.state('ReviewingValidation', 'active');
const Summarizing = H.state('Summarizing', 'active');
const AwaitingApproval = H.state('AwaitingApproval', 'active');
const Loading = H.state('Loading', 'active');
const Verifying = H.state('Verifying', 'active');
const Loaded = H.state('Loaded', 'terminal', 'success');
const LoadedWithWarnings = H.state('LoadedWithWarnings', 'terminal', 'success');
const Rejected = H.state('Rejected', 'terminal', 'neutral');
const Expired = H.state('Expired', 'terminal', 'neutral');
const Failed = H.state('Failed', 'terminal', 'failure');

const loadAttrs = z.object({ source: z.string(), night: z.string() });

const NightlyLoad = H.kind('NightlyLoad')
  .attributes(loadAttrs)
  .states(Scheduled, Extracting, Validating, ReviewingValidation, Summarizing, AwaitingApproval, Loading, Verifying, Loaded, LoadedWithWarnings, Rejected, Expired, Failed)
  .key(a => `${a.source}:${a.night}`);

const tz = 'Europe/Berlin';
const sources = ['crm', 'billing', 'inventory', 'web'];

const etlHost = ssh.host('etl', { host: 'etl.internal', user: 'etl', key: H.env('ETL_SSH_KEY') }).slots(2);
const localRunner = local.runner('local');

const backoff: Retry = { retries: 3, backoff: 'exponential', initialDelayMs: 60000, maxDelayMs: 900000 };

const extract = H.command('extract')
  .input(loadAttrs)
  .argv(i => ['/opt/etl/extract', i.source, i.night])
  .runner(etlHost);

const validate = H.command('validate')
  .input(loadAttrs)
  .argv(i => ['/opt/etl/validate', i.source, i.night])
  .output(z.object({ ok: z.boolean(), anomalies: z.array(z.string()), report: z.string() }))
  .runner(etlHost);

const load = H.command('load')
  .input(loadAttrs)
  .argv(i => ['/opt/etl/load', i.source, i.night])
  .runner(etlHost);

const verify = H.command('verify')
  .input(loadAttrs)
  .argv(i => ['/opt/etl/verify', i.source, i.night])
  .output(z.object({ driftRows: z.number() }))
  .runner(localRunner);

const summarizerRole = H.role('anomalySummarizer')
  .intents('read')
  .instructions('Explain the validation anomalies in plain language for the approver.');

const apiAccount = anthropic.account('etl-api', { apiKey: H.env('ANTHROPIC_API_KEY') });
const sonnet = anthropic.model('sonnet', { id: 'claude-sonnet-4-5' });

const summarizer = H.agent('anomalySummarizer')
  .role(summarizerRole)
  .model(sonnet)
  .output(z.object({ summary: z.string() }));

const ApproverTaste = H.memory('approverTaste').body(z.object({ preference: z.string() })).trust('taste');

const approverTaste = H.journal('approverTaste', ApproverTaste)
  .store(jsonl.memoryStore({ path: '.harness/memory/approver-taste.jsonl' }))
  .recall(H.recall('approverTasteBySpecificity', { by: 'specificity', limit: 10 }))
  .readBy(summarizerRole);

const loadFlow = H.flow('nightlyLoad')
  .input(loadAttrs)
  .step('extract', extract, ctx => ctx.unit.attributes, { retry: backoff })
  .step('validate', validate, ctx => ctx.unit.attributes)
  .halt('validationReview', {
    ask: ctx => `Validation failed for ${ctx.unit.attributes.source} (${ctx.unit.attributes.night}):\n${ctx.steps.validate.report}`,
    decision: z.object({ proceed: z.boolean(), note: z.string().optional() }),
    skip: ctx => ctx.steps.validate.ok ? { proceed: true } : undefined,
  })
  .exit('rejectedAtValidation', ctx => !ctx.steps.validationReview.proceed)
  .step('summarize', summarizer, ctx => ({
    task: `Summarize these anomalies for ${ctx.unit.attributes.source}:\n${ctx.steps.validate.anomalies.join('\n')}`,
  }))
  .halt('approval', {
    ask: ctx => `Approve the ${ctx.unit.attributes.source} load for ${ctx.unit.attributes.night}?\n\n${ctx.steps.summarize.summary}`,
    decision: z.object({ approved: z.boolean(), note: z.string().optional() }),
  })
  .exit('rejected', ctx => !ctx.steps.approval.approved)
  .step('load', load, ctx => ctx.unit.attributes, { retry: backoff })
  .step('verify', verify, ctx => ctx.unit.attributes)
  .exit('loadedWithWarnings', ctx => ctx.steps.verify.driftRows > 0)
  .exit('loaded');

const loads = H.lane('nightlyLoads', NightlyLoad)
  .supply(H.clock('nightlyAt0200').daily('02:00', { tz }), (tick, to) =>
    sources.map(source => to.create({ source, night: tick.at.toISOString().slice(0, 10) })))
  .store(sqlite.store({ path: '.harness/loads.sqlite' }))
  .handler(loadFlow, {
    during: {
      extract: Extracting,
      validate: Validating,
      validationReview: ReviewingValidation,
      summarize: Summarizing,
      approval: AwaitingApproval,
      load: Loading,
      verify: Verifying,
    },
    exits: {
      rejectedAtValidation: Rejected,
      rejected: Rejected,
      loadedWithWarnings: LoadedWithWarnings,
      loaded: Loaded,
    },
    failure: Failed,
  })
  .on(H.cancel, { enter: Expired });

const approvalWindowCloses = H.trigger('approvalWindowCloses')
  .on(H.when.timer(loads, {
    at: unit => H.nextTime('09:00', { after: unit.createdAt, tz }),
    if: unit => unit.attempt?.step === 'approval' && unit.attempt.status === 'blocked',
  }))
  .signal(H.cancel, e => ({ unit: e.unit, payload: { reason: 'Approval not given by 09:00' } }));

const approver = claudeCode.supervisor('approver', {
  grants: [H.ops.workRead, H.ops.blockersResolve, H.ops.memoryRead, H.ops.memoryWrite, H.ops.telemetryRead],
});

export const nightlyData = H.harness('nightly-data')
  .ledger(sqlite.ledger({ path: '.harness/ledger.sqlite' }))
  .pool(H.pool('etl').accounts(apiAccount))
  .lanes(loads)
  .journals(approverTaste)
  .triggers(approvalWindowCloses)
  .scheduler(H.scheduler('nightly').priority(loads))
  .clients(approver)
  .observers(markdown.board({ path: '.harness/BOARD.md' }), markdown.telemetry({ path: '.harness/TELEMETRY.md' }));
