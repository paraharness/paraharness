import { z } from 'zod';
import { H } from 'harness-dsl';
import { anthropic } from 'harness-dsl/anthropic';
import { claudeCode } from 'harness-dsl/claude-code';
import { jsonl } from 'harness-dsl/jsonl';
import { local } from 'harness-dsl/local';
import { markdown } from 'harness-dsl/markdown';
import { sqlite } from 'harness-dsl/sqlite';
import { ssh } from 'harness-dsl/ssh';

const loadSchema = z.object({ source: z.string(), night: z.string() });

const Scheduled = H.state('Scheduled', 'pending');
const Extracting = H.state('Extracting', 'active');
const Validating = H.state('Validating', 'active');
const ReviewingValidation = H.state('ReviewingValidation', 'active');
const Summarizing = H.state('Summarizing', 'active');
const AwaitingApproval = H.state('AwaitingApproval', 'active');
const Loading = H.state('Loading', 'active');
const Verifying = H.state('Verifying', 'active');
const Loaded = H.terminal('Loaded', 'success');
const LoadedWithWarnings = H.terminal('LoadedWithWarnings', 'success');
const Rejected = H.terminal('Rejected', 'neutral');
const Failed = H.terminal('Failed', 'failure');
const Expired = H.terminal('Expired', 'neutral');

const NightlyLoad = H.kind('NightlyLoad')
  .attributes(loadSchema)
  .states(
    Scheduled, Extracting, Validating, ReviewingValidation, Summarizing, AwaitingApproval,
    Loading, Verifying, Loaded, LoadedWithWarnings, Rejected, Failed, Expired,
  )
  .key(attrs => `${attrs.source}:${attrs.night}`)
  .initial(Scheduled)
  .onAttemptFailed(Failed)
  .onCancelled(Expired);

const etlHost = ssh.host('etl', { host: 'etl.internal', user: 'etl', key: H.env('ETL_SSH_KEY') }).slots(2);
const localRunner = local.runner('local');

const extract = H.command('extract')
  .input(loadSchema)
  .argv(input => ['/opt/etl/extract.sh', input.source, input.night])
  .runner(etlHost);

const validate = H.command('validate')
  .input(loadSchema)
  .argv(input => ['./bin/validate', input.source, input.night])
  .runner(localRunner)
  .acceptExitCodes(0, 2);

const load = H.command('load')
  .input(loadSchema)
  .argv(input => ['/opt/etl/load.sh', input.source, input.night])
  .runner(etlHost);

const verify = H.command('verify')
  .input(loadSchema)
  .argv(input => ['./bin/verify', input.source, input.night])
  .runner(localRunner)
  .acceptExitCodes(0, 3);

const apiAccount = anthropic.account('anthropic-api', { apiKey: H.env('ANTHROPIC_API_KEY') });
const summarizerRole = H.role('anomaly-summarizer')
  .intents('read')
  .instructions('Explain the validation anomalies in plain language for the approver.');

const summarizer = H.agent('anomaly-summarizer')
  .role(summarizerRole)
  .model(anthropic.model('sonnet', { id: 'claude-sonnet-4-5' }))
  .pool(H.pool('api').accounts(apiAccount));

const backoff = { maxAttempts: 3, backoff: 'exponential', initialDelayMs: 60000 } satisfies { maxAttempts: number; backoff: 'exponential'; initialDelayMs: number };

const nightlyFlow = H.flow('nightly-load')
  .input(loadSchema)
  .step('extract', extract, ctx => ctx.unit.attributes, { retry: backoff, afterCrash: 'rerun' })
  .step('validate', validate, ctx => ctx.unit.attributes, { afterCrash: 'rerun' })
  .halt('validation-review', {
    ask: ctx => `Validation failed for ${ctx.unit.attributes.source} (${ctx.unit.attributes.night}):\n${ctx.steps.validate.stdout}`,
    decision: z.object({ proceed: z.boolean(), notes: z.string().optional() }),
    skip: ctx => (ctx.steps.validate.exitCode === 0 ? { proceed: true } : undefined),
  })
  .exit('invalid', ctx => !ctx.steps['validation-review'].proceed)
  .step('summarize', summarizer, ctx => ({
    task: `Summarize the anomalies for the ${ctx.unit.attributes.source} load of ${ctx.unit.attributes.night}:\n${ctx.steps.validate.stdout}`,
    skills: [ctx.unit.attributes.source],
  }))
  .halt('approval', {
    ask: ctx => `Approve the ${ctx.unit.attributes.source} load for ${ctx.unit.attributes.night}?\n\n${ctx.steps.summarize}`,
    decision: z.object({ approved: z.boolean(), notes: z.string().optional() }),
  })
  .exit('rejected', ctx => !ctx.steps.approval.approved)
  .step('load', load, ctx => ctx.unit.attributes, { retry: backoff, afterCrash: 'park' })
  .step('verify', verify, ctx => ctx.unit.attributes, { afterCrash: 'rerun' })
  .exit('loadedWithWarnings', ctx => ctx.steps.verify.exitCode === 3)
  .exit('loaded');

const sources = ['crm', 'billing', 'inventory', 'web-analytics'];

const loads = H.lane('nightly-loads', NightlyLoad)
  .supply(H.clock('two-am').at('02:00', { tz: 'Europe/Berlin' }), (tick, to) =>
    sources.map(source => to.create({ source, night: tick.at.toISOString().slice(0, 10) })),
  )
  .store(sqlite.store({ path: '.harness/loads.db' }))
  .handler(nightlyFlow, {
    exits: {
      invalid: Rejected,
      rejected: Rejected,
      loadedWithWarnings: LoadedWithWarnings,
      loaded: Loaded,
    },
    during: {
      extract: Extracting,
      validate: Validating,
      'validation-review': ReviewingValidation,
      summarize: Summarizing,
      approval: AwaitingApproval,
      load: Loading,
      verify: Verifying,
    },
  });

const approverTaste = H.journal('approver-taste', H.memory('taste', 'taste'))
  .store(jsonl.memoryStore({ path: 'memory/approver-taste.jsonl' }))
  .recall({ by: 'specificity', limit: 10 })
  .readBy(summarizerRole);

const approvalWindowCloses = H.trigger('approval-window-closes')
  .on(H.when.timer(loads, {
    at: unit => H.nextTime('09:00', { after: unit.createdAt, tz: 'Europe/Berlin' }),
  }))
  .signal(H.cancel, loads, event => event.unit.state === 'AwaitingApproval'
    ? { key: event.unit.key, payload: { reason: 'approval not given by 09:00' } }
    : undefined);

const approver = claudeCode.supervisor('approver', {
  grants: [H.ops.workRead, H.ops.blockersResolve, H.ops.attemptsRecover, H.ops.memoryWrite, H.ops.telemetryRead],
});

export const harness = H.harness('nightly-data')
  .ledger(sqlite.ledger({ path: '.harness/ledger.db' }))
  .lanes(loads)
  .journals(approverTaste)
  .triggers(approvalWindowCloses)
  .scheduler(H.scheduler('nightly').priority(loads))
  .clients(approver)
  .observers(markdown.board({ path: 'BOARD.md' }), markdown.telemetry({ path: 'TELEMETRY.md' }));

void harness.start();
