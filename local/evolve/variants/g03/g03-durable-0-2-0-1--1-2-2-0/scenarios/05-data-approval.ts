import { z } from 'zod';
import { H } from 'harness-dsl';
import { sqlite } from 'harness-dsl/sqlite';
import { jsonl } from 'harness-dsl/jsonl';
import { anthropic } from 'harness-dsl/anthropic';
import { claudeCode } from 'harness-dsl/claude-code';
import { ssh } from 'harness-dsl/ssh';
import { local } from 'harness-dsl/local';
import { markdown } from 'harness-dsl/markdown';

const Scheduled = H.state('scheduled', 'pending');
const Loaded = H.terminal('loaded', 'success');
const LoadedWithWarnings = H.terminal('loaded-with-warnings', 'success');
const Rejected = H.terminal('rejected', 'failure');
const Failed = H.terminal('failed', 'failure');
const Expired = H.terminal('expired', 'neutral');

const sourceSystem = H.facet('source-system', ['crm', 'billing', 'inventory', 'web-analytics']);

const load = z.object({ source: sourceSystem.schema, night: z.string() });

const NightlyLoad = H.kind('nightly-load')
  .attributes(load)
  .states(Scheduled, Loaded, LoadedWithWarnings, Rejected, Failed, Expired)
  .key(a => `${a.source}@${a.night}`)
  .initial(Scheduled);

const etlHost = ssh.host('etl-host', { host: 'etl.internal', user: 'etl', key: H.env('ETL_SSH_KEY') }).slots(2);
const localRunner = local.runner('local');

const stepInput = z.object({ source: sourceSystem.schema, night: z.string() });

const extract = H.command('extract')
  .input(stepInput)
  .argv(input => ['etl', 'extract', input.source, input.night])
  .runner(etlHost);

const validate = H.command('validate')
  .input(stepInput)
  .argv(input => ['etl', 'validate', input.source, input.night])
  .acceptExitCodes(0, 1)
  .runner(localRunner);

const loadCommand = H.command('load')
  .input(stepInput)
  .argv(input => ['etl', 'load', input.source, input.night])
  .runner(etlHost);

const verify = H.command('verify')
  .input(stepInput)
  .argv(input => ['etl', 'verify', input.source, input.night])
  .acceptExitCodes(0, 3)
  .runner(localRunner);

const backoff = H.retry({ maxAttempts: 3, backoff: 'exponential', initialDelayMs: 60_000 });

const summarizerRole = H.role('anomaly-summarizer').intents('read').instructions('Summarize anomalies in plain language for the approver.');
const approverRole = H.role('approver').instructions('Approve or reject the nightly load.');

const approverTaste = H.journal('approver-taste', H.memory('approver-emphasis', 'taste'))
  .store(jsonl.memoryStore({ path: 'memory/taste.jsonl' }))
  .recall({ by: 'specificity', limit: 8 })
  .readBy(summarizerRole)
  .recordedBy(approverRole);

const apiAccount = anthropic.account('anthropic-api', {
  apiKey: H.env('ANTHROPIC_API_KEY'),
  quota: sqlite.quota('data-quota', { path: '.harness/quota.db' }),
});

const summarizer = H.seat('anomaly-summarizer')
  .role(summarizerRole)
  .model(anthropic.model('sonnet', { id: 'claude-sonnet-4-5' }))
  .pool(H.pool('data').accounts(apiAccount));

const validationReview = H.halt('validation-review').decision(z.object({ proceed: z.boolean(), note: z.string().optional() }));
const loadApproval = H.halt('load-approval').decision(z.object({ approved: z.boolean(), note: z.string().optional() }));
const approvalExpired = H.signal('approval-expired');

const nightly = H.flow('nightly-load')
  .input(load)
  .step('extract', extract, ctx => ({ source: ctx.unit.attributes.source, night: ctx.unit.attributes.night }), {
    retry: backoff,
    afterCrash: 'rerun',
  })
  .step('validate', validate, ctx => ({ source: ctx.unit.attributes.source, night: ctx.unit.attributes.night }))
  .halt('validationReview', validationReview, {
    when: ctx => ctx.steps.validate.exitCode !== 0,
    ask: ctx => `Validation failed for ${ctx.unit.attributes.source} on ${ctx.unit.attributes.night}:\n${ctx.steps.validate.stdout}`,
  })
  .exit('validation-rejected', ctx => ctx.steps.validationReview?.proceed === false)
  .step('summarize', summarizer, ctx => ({
    task: `Summarize the anomalies in this validation report for ${ctx.unit.attributes.source}:\n${ctx.steps.validate.stdout}`,
    skills: [ctx.unit.attributes.source],
  }))
  .halt('approval', loadApproval, { ask: ctx => ctx.steps.summarize })
  .exit('rejected', ctx => !ctx.steps.approval.approved)
  .step('load', loadCommand, ctx => ({ source: ctx.unit.attributes.source, night: ctx.unit.attributes.night }), {
    retry: backoff,
    afterCrash: 'park',
  })
  .step('verify', verify, ctx => ({ source: ctx.unit.attributes.source, night: ctx.unit.attributes.night }))
  .exit('loaded-with-warnings', ctx => ctx.steps.verify.exitCode === 3)
  .exit('loaded');

const loads = H.lane('nightly-loads', NightlyLoad)
  .supply(H.clock('two-am').at('02:00', { tz: 'Europe/Berlin' }), (tick, to) =>
    sourceSystem.values.map(source => to.create({ source, night: tick.at.toISOString().slice(0, 10) })),
  )
  .handler(nightly, {
    exits: {
      'validation-rejected': Rejected,
      rejected: Rejected,
      'loaded-with-warnings': LoadedWithWarnings,
      loaded: Loaded,
    },
  })
  .store(sqlite.store({ path: '.harness/loads.db' }))
  .retry({ maxAttempts: 1, exhausted: Failed })
  .on(approvalExpired, { enter: Expired, at: ['approval'] });

const approvalWindowCloses = H.trigger('approval-window-closes')
  .on(H.when.timer(loads, { at: view => H.nextTime('09:00', { after: view.createdAt, tz: 'Europe/Berlin' }) }))
  .signal(approvalExpired, loads, event =>
    event.unit.attempt?.step === 'approval' ? { key: event.unit.key, payload: {} } : undefined,
  );

const supervisor = claudeCode.supervisor('approver-supervisor', {
  grants: [H.ops.workRead, H.ops.resolve(validationReview, loadApproval), H.ops.memoryWrite, H.ops.telemetryRead],
});

export const dataJob = H.harness('nightly-data')
  .ledger(sqlite.ledger({ path: '.harness/ledger.db' }))
  .lanes(loads)
  .journals(approverTaste)
  .triggers(approvalWindowCloses)
  .scheduler(H.scheduler('nightly').standard(loads))
  .clients(supervisor)
  .observers(markdown.board({ path: 'BOARD.md' }), markdown.telemetry({ path: 'TELEMETRY.md' }));

void dataJob.start();
