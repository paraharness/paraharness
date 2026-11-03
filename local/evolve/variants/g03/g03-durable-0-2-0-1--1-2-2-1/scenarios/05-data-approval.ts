import { z } from 'zod';
import { H } from 'harness-dsl';
import { sqlite } from 'harness-dsl/sqlite';
import { jsonl } from 'harness-dsl/jsonl';
import { ssh } from 'harness-dsl/ssh';
import { local } from 'harness-dsl/local';
import { claudeCode } from 'harness-dsl/claude-code';
import { markdown } from 'harness-dsl/markdown';

const sourceSystem = H.facet('source-system', ['crm', 'billing', 'inventory', 'web']);

const etlHost = ssh.host('etl-host', { host: 'etl.internal', user: 'etl', key: H.env('ETL_SSH_KEY') }).slots(4);
const localRunner = local.runner('local').slots(4);

const quota = sqlite.quota('claude-subscriptions', { path: '.harness/quota.sqlite' });
const subscription = claudeCode.subscription('data-subscription', { token: H.env('CLAUDE_TOKEN'), quota });
const pool = H.pool('data').accounts(subscription);
const sonnet = claudeCode.model('sonnet', { id: 'claude-sonnet-4-5' });

const loadSchema = z.object({ source: sourceSystem.schema, night: z.string() });

const scheduled = H.state('scheduled', 'pending');
const loaded = H.terminal('loaded', 'success');
const loadedWithWarnings = H.terminal('loaded-with-warnings', 'success');
const rejected = H.terminal('rejected', 'failure');
const failed = H.terminal('failed', 'failure');
const expired = H.terminal('expired', 'neutral');

const nightlyLoad = H.kind('NightlyLoad')
  .attributes(loadSchema)
  .states(scheduled, loaded, loadedWithWarnings, rejected, failed, expired)
  .initial(scheduled)
  .key(attrs => `${attrs.source}@${attrs.night}`);

const stepRetry = H.retry({ maxAttempts: 3, backoff: 'exponential', initialDelayMs: 60000 });

const extract = H.command('extract')
  .input(loadSchema)
  .argv(input => ['/opt/etl/extract', input.source, input.night])
  .runner(etlHost);

const validate = H.command('validate')
  .input(loadSchema)
  .argv(input => ['/opt/etl/validate', input.source, input.night])
  .output(z.object({ ok: z.boolean(), report: z.string(), anomalies: z.array(z.string()) }))
  .acceptExitCodes(0, 1)
  .runner(etlHost);

const load = H.command('load')
  .input(loadSchema)
  .argv(input => ['/opt/etl/load', input.source, input.night])
  .runner(etlHost);

const verify = H.command('verify')
  .input(loadSchema)
  .argv(input => ['/opt/etl/verify', input.source, input.night])
  .output(z.object({ driftRows: z.number() }))
  .acceptExitCodes(0, 3)
  .runner(localRunner);

const summarizerRole = H.role('anomaly-summarizer').intents('read').instructions('Summarise the anomalies in plain language for the approver.');
const approverRole = H.role('approver').intents('record').instructions('Approve or reject the nightly load.');

const summarizer = H.seat('anomaly-summarizer')
  .role(summarizerRole)
  .model(sonnet)
  .pool(pool)
  .output(z.object({ summary: z.string() }));

const validationReview = H.halt('validation-review').decision(z.object({ proceed: z.boolean(), note: z.string() }));
const loadApproval = H.halt('load-approval').decision(z.object({ approve: z.boolean(), note: z.string() }));

const nightly = H.flow('nightly-load')
  .input(loadSchema)
  .step('extract', extract, ctx => ctx.unit.attributes, { retry: stepRetry, afterCrash: 'rerun' })
  .step('validate', validate, ctx => ctx.unit.attributes, { afterCrash: 'rerun' })
  .halt('validationReview', validationReview, {
    ask: ctx => ctx.steps.validate.report,
    when: ctx => ctx.steps.validate.ok === false,
  })
  .exit('rejectedAtValidation', ctx => ctx.steps.validationReview?.proceed === false)
  .step('summarize', summarizer, ctx => ({
    task: `Summarise these anomalies for the ${ctx.unit.attributes.source} load of ${ctx.unit.attributes.night}:\n${ctx.steps.validate.anomalies.join('\n')}\nValidation note: ${ctx.steps.validationReview?.note ?? 'none'}`,
  }), { afterCrash: 'askDriver' })
  .halt('approval', loadApproval, { ask: ctx => ctx.steps.summarize.summary })
  .exit('rejectedByApprover', ctx => ctx.steps.approval.approve === false)
  .step('load', load, ctx => ctx.unit.attributes, { retry: stepRetry, afterCrash: 'park' })
  .step('verify', verify, ctx => ctx.unit.attributes, { afterCrash: 'rerun' })
  .exit('loaded', ctx => ctx.steps.verify.driftRows === 0)
  .exit('loadedWithWarnings');

const approvalWindowClosed = H.signal('approval-window-closed');

const nightlyLane = H.lane('nightly-loads', nightlyLoad)
  .supply(H.clock('two-am').at('02:00', { tz: 'Europe/London' }), (tick, to) => sourceSystem.values.map(source => to.create({
    source,
    night: tick.at.toISOString().slice(0, 10),
  })))
  .handler(nightly, {
    exits: {
      rejectedAtValidation: rejected,
      rejectedByApprover: rejected,
      loaded,
      loadedWithWarnings,
    },
  })
  .store(sqlite.store({ path: '.harness/loads.sqlite' }))
  .retry({ maxAttempts: 1, exhausted: failed })
  .on(approvalWindowClosed, { enter: expired, at: ['approval'] });

const approvalDeadline = H.trigger('approval-deadline-nine-am')
  .on(H.when.timer(nightlyLane, { at: view => H.nextTime('09:00', { after: view.createdAt, tz: 'Europe/London' }) }))
  .signal(approvalWindowClosed, nightlyLane, event => ({ key: event.unit.key, payload: {} }));

const approverTaste = H.memory('approver-taste', 'taste');
const tasteJournal = H.journal('approver-taste', approverTaste)
  .store(jsonl.memoryStore({ path: 'memory/approver-taste.jsonl' }))
  .recall({ by: 'specificity', limit: 10 })
  .readBy(summarizerRole)
  .recordedBy(approverRole);

const approverDesk = claudeCode.supervisor('approver-desk', {
  grants: [
    H.ops.workRead,
    H.ops.resolve(validationReview, loadApproval),
    H.ops.attemptsRecover,
    H.ops.memoryRead,
    H.ops.memoryWrite,
    H.ops.telemetryRead,
  ],
});

export const dataJob = H.harness('nightly-data')
  .ledger(sqlite.ledger({ path: '.harness/ledger.sqlite' }))
  .lanes(nightlyLane)
  .journals(tasteJournal)
  .triggers(approvalDeadline)
  .scheduler(H.scheduler('nightly').standard(nightlyLane).wip(nightlyLane, 4))
  .clients(approverDesk)
  .observers(markdown.board({ path: 'BOARD.md' }), markdown.telemetry({ path: 'TELEMETRY.md' }));

void dataJob.start();
