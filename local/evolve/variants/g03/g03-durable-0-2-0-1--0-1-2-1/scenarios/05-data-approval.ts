import { z } from 'zod';
import { H } from 'harness-dsl';
import type { Retry } from 'harness-dsl';
import { anthropic } from 'harness-dsl/anthropic';
import { claudeCode } from 'harness-dsl/claude-code';
import { sqlite } from 'harness-dsl/sqlite';
import { jsonl } from 'harness-dsl/jsonl';
import { ssh } from 'harness-dsl/ssh';
import { markdown } from 'harness-dsl/markdown';

const timeZone = 'Europe/Berlin';
const sourceSchema = z.enum(['crm', 'billing', 'inventory', 'web']);
const loadItem = z.object({ source: sourceSchema, night: z.string() });

const Scheduled = H.state('Scheduled', 'pending');
const Loaded = H.terminal('Loaded', 'success');
const LoadedWithWarnings = H.terminal('LoadedWithWarnings', 'success');
const Rejected = H.terminal('Rejected', 'neutral');
const Expired = H.terminal('Expired', 'neutral');
const Failed = H.terminal('Failed', 'failure');

const NightlyLoad = H.kind('NightlyLoad')
  .attributes(loadItem)
  .states(Scheduled, Loaded, LoadedWithWarnings, Rejected, Expired, Failed)
  .key(a => `${a.source}@${a.night}`)
  .initial(Scheduled);

const etlHost = ssh.host('etl-host', { host: 'etl.internal', user: 'etl', key: H.env('SSH_KEY_ETL') }).slots(2);

const extract = H.command('extract')
  .input(loadItem)
  .argv(i => ['./etl/extract.sh', i.source, i.night])
  .runner(etlHost);
const validate = H.command('validate')
  .input(loadItem)
  .argv(i => ['./etl/validate.sh', i.source, i.night])
  .runner(etlHost)
  .acceptExitCodes(0, 1);
const load = H.command('load')
  .input(loadItem)
  .argv(i => ['./etl/load.sh', i.source, i.night])
  .runner(etlHost);
const verify = H.command('verify')
  .input(loadItem)
  .argv(i => ['./etl/verify.sh', i.source, i.night])
  .runner(etlHost)
  .output(z.object({ driftPercent: z.number() }));

const threeRetriesWithBackoff: Retry = { maxAttempts: 4, backoff: 'exponential', initialDelayMs: 60000 };

const validationReview = H.halt('validation-review').decision(z.object({ proceed: z.boolean(), note: z.string().optional() }));
const loadApproval = H.halt('load-approval').decision(z.object({ approved: z.boolean(), note: z.string().optional() }));

const loadQuota = sqlite.quota('data-api', { path: './.harness/quota.sqlite' });
const dataAccount = anthropic.account('data-api', { apiKey: H.env('ANTHROPIC_API_KEY'), quota: loadQuota });
const summaryRole = H.role('anomaly-summarizer')
  .intents('read')
  .instructions('Summarize the anomalies in plain language for the approver. Emphasize what the approver has asked for.');
const summarizer = H.seat('anomaly-summarizer')
  .role(summaryRole)
  .model(anthropic.model('sonnet', { id: 'claude-sonnet-4-5' }))
  .pool(H.pool('data').accounts(dataAccount))
  .output(z.object({ summary: z.string() }));

const nightly = H.flow('nightly-load')
  .input(loadItem)
  .step('extract', extract, ctx => ctx.unit.attributes, { retry: threeRetriesWithBackoff, afterCrash: 'rerun' })
  .step('validate', validate, ctx => ctx.unit.attributes, { afterCrash: 'rerun' })
  .halt('validationReview', validationReview, {
    when: ctx => ctx.steps.validate.exitCode !== 0,
    ask: ctx => `Validation failed for ${ctx.unit.attributes.source} (${ctx.unit.attributes.night}):\n${ctx.steps.validate.stdout}`,
  })
  .exit('validationRejected', ctx => ctx.steps.validationReview?.proceed === false)
  .step('summarize', summarizer, ctx => ({
    task: `Summarize anomalies for the ${ctx.unit.attributes.source} load of ${ctx.unit.attributes.night}.\n\nValidation report:\n${ctx.steps.validate.stdout}`,
  }))
  .halt('approval', loadApproval, {
    ask: ctx => `Approve the ${ctx.unit.attributes.source} load of ${ctx.unit.attributes.night}?\n\n${ctx.steps.summarize.summary}`,
  })
  .exit('approvalRejected', ctx => !ctx.steps.approval.approved)
  .step('load', load, ctx => ctx.unit.attributes, { retry: threeRetriesWithBackoff, afterCrash: 'rerun' })
  .step('verify', verify, ctx => ctx.unit.attributes, { afterCrash: 'rerun' })
  .exit('loaded', ctx => ctx.steps.verify.driftPercent === 0)
  .exit('loadedWithWarnings');

const loadLane = H.lane('nightly-loads', NightlyLoad)
  .supply(H.clock('nightly-0200').at('02:00', { tz: timeZone }), (tick, to) =>
    sourceSchema.options.map(source => to.create({ source, night: tick.at.toISOString().slice(0, 10) })),
  )
  .handler(nightly, {
    exits: {
      validationRejected: Rejected,
      approvalRejected: Rejected,
      loaded: Loaded,
      loadedWithWarnings: LoadedWithWarnings,
    },
  })
  .store(sqlite.store({ path: './.harness/loads.sqlite' }))
  .retry({ maxAttempts: 1, exhausted: Failed })
  .on(H.cancel, { enter: Expired, at: ['approval'] });

const approvalDeadline = H.trigger('approval-deadline')
  .on(H.when.timer(loadLane, { at: u => H.nextTime('09:00', { after: u.createdAt, tz: timeZone }) }))
  .signal(H.cancel, loadLane, e => ({ key: e.unit.key, payload: { reason: 'approval not given by 09:00' } }));

const tasteJournal = H.journal('approver-taste', H.memory('approver-taste', 'taste'))
  .store(jsonl.memoryStore({ path: './memory/taste.jsonl' }))
  .recall({ by: 'specificity', limit: 10 })
  .readBy(summaryRole);

const approver = claudeCode.supervisor('approver', {
  grants: [
    H.ops.workRead,
    H.ops.resolve(validationReview, loadApproval),
    H.ops.attemptsRecover,
    H.ops.memoryRead,
    H.ops.memoryWrite,
    H.ops.telemetryRead,
  ],
  port: H.slot.port(0),
});

export const dataHarness = H.harness('nightly-data')
  .ledger(sqlite.ledger({ path: './.harness/ledger.sqlite' }))
  .lanes(loadLane)
  .journals(tasteJournal)
  .triggers(approvalDeadline)
  .scheduler(H.scheduler('nightly').standard(loadLane))
  .clients(approver)
  .observers(markdown.board({ path: './BOARD.md' }), markdown.telemetry({ path: './TELEMETRY.md' }));

void dataHarness.start();
