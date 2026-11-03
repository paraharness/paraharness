import { z } from 'zod';
import { H, Retry } from 'harness-dsl';
import { sqlite } from 'harness-dsl/sqlite';
import { jsonl } from 'harness-dsl/jsonl';
import { anthropic } from 'harness-dsl/anthropic';
import { claudeCode } from 'harness-dsl/claude-code';
import { ssh } from 'harness-dsl/ssh';
import { markdown } from 'harness-dsl/markdown';

const SourceSystem = z.enum(['crm', 'billing', 'inventory', 'events']);
const LoadAttrs = z.object({ source: SourceSystem, night: z.string() });

const Scheduled = H.state('scheduled', 'pending');
const Loaded = H.terminal('loaded', 'success');
const LoadedWithWarnings = H.terminal('loaded-with-warnings', 'success');
const Rejected = H.terminal('rejected', 'failure');
const Failed = H.terminal('failed', 'failure');
const Expired = H.terminal('approval-expired', 'failure');

const NightlyLoad = H.kind('NightlyLoad')
  .attributes(LoadAttrs)
  .states(Scheduled, Loaded, LoadedWithWarnings, Rejected, Failed, Expired)
  .key(attrs => `${attrs.source}:${attrs.night}`)
  .initial(Scheduled);

const approvalExpired = H.signal('approval-expired');

const etlHost = ssh.host('etl-host', { host: 'etl.internal', user: 'etl', key: H.env('ETL_SSH_KEY') });

const extract = H.command('extract')
  .input(LoadAttrs)
  .argv(input => ['./etl/extract', input.source, input.night])
  .runner(etlHost);

const validate = H.command('validate')
  .input(LoadAttrs)
  .argv(input => ['./etl/validate', input.source, input.night])
  .acceptExitCodes(0, 1)
  .output(z.object({ passed: z.boolean(), report: z.string(), anomalies: z.array(z.string()) }))
  .runner(etlHost);

const load = H.command('load')
  .input(LoadAttrs)
  .argv(input => ['./etl/load', input.source, input.night])
  .runner(etlHost);

const verify = H.command('verify')
  .input(LoadAttrs)
  .argv(input => ['./etl/verify', input.source, input.night])
  .acceptExitCodes(0, 2)
  .output(z.object({ driftRows: z.number() }))
  .runner(etlHost);

const quota = sqlite.quota('etl-quota', { path: '.harness/quota.sqlite' });
const apiAccount = anthropic.account('etl-api', { apiKey: H.env('ANTHROPIC_API_KEY'), quota });
const sonnet = anthropic.model('sonnet', { id: 'claude-sonnet-4-5' });
const apiPool = H.pool('etl-api').accounts(apiAccount);

const summarizerRole = H.role('anomaly-summarizer')
  .intents('read')
  .instructions('Summarise validation anomalies in plain language for the approver.');
const approverRole = H.role('approver')
  .intents('read', 'record')
  .instructions('Approve or reject the nightly load.');

const summarizer = H.seat('anomaly-summarizer')
  .role(summarizerRole)
  .model(sonnet)
  .pool(apiPool)
  .output(z.object({ summary: z.string() }));

const validationReview = H.halt('validation-review').decision(z.object({ proceed: z.boolean(), note: z.string() }));
const loadApproval = H.halt('load-approval').decision(
  z.object({ approved: z.boolean(), note: z.string().optional() }),
);

const transientRetry: Retry = { maxAttempts: 3, backoff: 'exponential', initialDelayMs: 60_000 };

const nightlyLoadFlow = H.flow('nightly-load')
  .input(LoadAttrs)
  .step('extract', extract, ctx => ctx.unit.attributes, { retry: transientRetry, afterCrash: 'rerun' })
  .step('validate', validate, ctx => ctx.unit.attributes, { afterCrash: 'rerun' })
  .halt('validationReview', validationReview, {
    when: ctx => !ctx.steps.validate.passed,
    ask: ctx => `Validation failed for ${ctx.unit.attributes.source} on ${ctx.unit.attributes.night}:\n\n${ctx.steps.validate.report}`,
  })
  .exit('invalid', ctx => ctx.steps.validationReview?.proceed === false)
  .step('summarize', summarizer, ctx => ({
    task: `Summarise these anomalies for the approver:\n- ${ctx.steps.validate.anomalies.join('\n- ')}`,
  }))
  .halt('approval', loadApproval, {
    ask: ctx => `Approve the ${ctx.unit.attributes.source} load for ${ctx.unit.attributes.night}?\n\n${ctx.steps.summarize.summary}`,
  })
  .exit('rejected', ctx => !ctx.steps.approval.approved)
  .step('load', load, ctx => ctx.unit.attributes, { retry: transientRetry, afterCrash: 'park' })
  .step('verify', verify, ctx => ctx.unit.attributes, { afterCrash: 'rerun' })
  .exit('loaded', ctx => ctx.steps.verify.driftRows === 0)
  .exit('loadedWithWarnings');

const loads = H.lane('nightly-loads', NightlyLoad)
  .supply(H.clock('nightly-0200').at('02:00', { tz: 'Europe/Berlin' }), (tick, to) =>
    SourceSystem.options.map(source => to.create({ source, night: tick.at.toISOString().slice(0, 10) })),
  )
  .handler(nightlyLoadFlow, {
    exits: { invalid: Rejected, rejected: Rejected, loaded: Loaded, loadedWithWarnings: LoadedWithWarnings },
  })
  .store(sqlite.store({ path: '.harness/loads.sqlite' }))
  .retry({ maxAttempts: 1, exhausted: Failed })
  .on(approvalExpired, { enter: Expired, at: ['approval'] });

const approvalWindowCloses = H.trigger('approval-window-closes-at-0900')
  .on(
    H.when.timer(loads, {
      at: unit =>
        unit.position === 'terminal'
          ? undefined
          : H.nextTime('09:00', { after: unit.createdAt, tz: 'Europe/Berlin' }),
    }),
  )
  .signal(approvalExpired, loads, event => ({ key: event.unit.key, payload: {} }));

const approverTaste = H.journal('approver-taste', H.memory('approver-taste', 'taste'))
  .store(jsonl.memoryStore({ path: '.harness/approver-taste.jsonl' }))
  .recall({ by: 'specificity', limit: 10 })
  .readBy(summarizerRole)
  .recordedBy(approverRole);

const scheduler = H.scheduler('nightly').standard(loads);

const supervisor = claudeCode.supervisor('approver-supervisor', {
  port: H.slot.port(0),
  grants: [
    H.ops.workRead,
    H.ops.resolve(validationReview, loadApproval),
    H.ops.attemptsRecover,
    H.ops.memoryRead,
    H.ops.memoryWrite,
    H.ops.telemetryRead,
  ],
});

export default H.harness('nightly-data')
  .ledger(sqlite.ledger({ path: '.harness/ledger.sqlite' }))
  .lanes(loads)
  .journals(approverTaste)
  .triggers(approvalWindowCloses)
  .scheduler(scheduler)
  .clients(supervisor)
  .observers(markdown.board({ path: 'BOARD.md' }), markdown.telemetry({ path: 'TELEMETRY.md' }));
