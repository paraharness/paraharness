import { z } from 'zod';
import { H } from 'harness-dsl';
import { anthropic } from 'harness-dsl/anthropic';
import { claudeCode } from 'harness-dsl/claude-code';
import { ssh } from 'harness-dsl/ssh';
import { sqlite } from 'harness-dsl/sqlite';
import { jsonl } from 'harness-dsl/jsonl';
import { markdown } from 'harness-dsl/markdown';

const SourceSystem = z.enum(['billing', 'crm', 'inventory', 'payments']);
const LoadSchema = z.object({ source: SourceSystem, night: z.string() });

const Queued = H.state('Queued', 'pending');
const Loaded = H.terminal('Loaded', 'success');
const LoadedWithWarnings = H.terminal('LoadedWithWarnings', 'success');
const Rejected = H.terminal('Rejected', 'neutral');
const Failed = H.terminal('Failed', 'failure');
const Cancelled = H.terminal('Cancelled', 'neutral');

const NightlyLoad = H.kind('NightlyLoad')
  .attributes(LoadSchema)
  .states(Queued, Loaded, LoadedWithWarnings, Rejected, Failed, Cancelled)
  .key(load => `${load.source}:${load.night}`)
  .initial(Queued)
  .onAttemptFailed(Failed)
  .onCancelled(Cancelled);

const apiAccount = anthropic.account('data-api', { apiKey: H.env('ANTHROPIC_API_KEY') });
const sonnet = anthropic.model('sonnet', { id: 'claude-sonnet-4-5' });
const dataPool = H.pool('data').accounts(apiAccount).serves(sonnet);

const etl = ssh.host('etl', { host: 'etl.internal', user: 'loader', key: H.env('ETL_SSH_KEY') }).slots(2);

const extract = H.command('extract')
  .input(LoadSchema)
  .argv(load => ['/opt/etl/extract', load.source, load.night])
  .runner(etl);

const validate = H.command('validate')
  .input(LoadSchema)
  .argv(load => ['/opt/etl/validate', load.source, load.night])
  .runner(etl)
  .acceptExitCodes(1);

const load = H.command('load')
  .input(LoadSchema)
  .argv(input => ['/opt/etl/load', input.source, input.night])
  .runner(etl);

const verify = H.command('verify')
  .input(LoadSchema)
  .argv(input => ['/opt/etl/verify', input.source, input.night])
  .runner(etl)
  .acceptExitCodes(2);

const summarizerRole = H.role('anomalySummarizer')
  .intents('read')
  .instructions('Explain the validation anomalies in plain language for the approver.');

const summarizer = H.agent('anomalySummarizer')
  .role(summarizerRole)
  .model(sonnet)
  .output(z.object({ summary: z.string() }))
  .budgetTokens(20_000);

const backoff = H.retry({ maxAttempts: 4, backoff: 'exponential', initialDelayMs: 60_000, maxDelayMs: 900_000 });

const nightlyFlow = H.flow('nightlyLoad')
  .input(LoadSchema)
  .step('extract', extract, ctx => ctx.unit.attributes, { retry: backoff, afterCrash: 'rerun' })
  .step('validate', validate, ctx => ctx.unit.attributes, { afterCrash: 'rerun' })
  .halt('validationReview', z.object({ proceed: z.boolean(), notes: z.string().optional() }), {
    ask: ctx => `Validation of ${ctx.unit.attributes.source} for ${ctx.unit.attributes.night} failed. Proceed anyway?\n\n${ctx.steps.validate.stdout}`,
    skip: ctx => ctx.steps.validate.exitCode === 0 ? { proceed: true } : undefined,
  })
  .exit('invalid', ctx => ctx.steps.validationReview.proceed === false)
  .step('summarize', summarizer, ctx => ({
    task: `Summarise the anomalies in tonight's ${ctx.unit.attributes.source} extract:\n\n${ctx.steps.validate.stdout}`,
  }), { afterCrash: 'rerun' })
  .halt('approval', z.object({ approved: z.boolean(), notes: z.string().optional() }), {
    ask: ctx => `Approve the ${ctx.unit.attributes.source} load for ${ctx.unit.attributes.night}?\n\n${ctx.steps.summarize.summary}`,
  })
  .exit('rejected', ctx => ctx.steps.approval.approved === false)
  .step('load', load, ctx => ctx.unit.attributes, { retry: backoff, afterCrash: 'park' })
  .step('verify', verify, ctx => ctx.unit.attributes, { afterCrash: 'rerun' })
  .exit('warnings', ctx => ctx.steps.verify.exitCode === 2)
  .exit('loaded');

const loads = H.lane('nightlyLoads', NightlyLoad)
  .supply(H.clock('nightly').daily('02:00', { tz: 'Europe/London' }), (tick, to) => {
    const night = tick.at.toISOString().slice(0, 10);
    return [
      to.create({ source: 'billing', night }),
      to.create({ source: 'crm', night }),
      to.create({ source: 'inventory', night }),
      to.create({ source: 'payments', night }),
    ];
  })
  .store(sqlite.store({ path: '.harness/loads.sqlite' }))
  .handler(nightlyFlow, {
    exits: { invalid: Failed, rejected: Rejected, warnings: LoadedWithWarnings, loaded: Loaded },
  });

const approvalExpiresAtNine = H.trigger('approvalExpiresAtNine', H.when.timer(loads, {
  at: unit => H.nextTime('09:00', { after: unit.createdAt, tz: 'Europe/London' }),
}))
  .signal(H.cancel, loads, event =>
    event.unit.attempt?.step === 'approval' && event.unit.attempt.status === 'blocked'
      ? { key: event.unit.key, payload: { reason: 'Approval not given by 09:00' } }
      : undefined);

const ApproverTaste = H.memory('approverTaste').trust('taste');

const approverTaste = H.journal('approverTaste', ApproverTaste)
  .store(jsonl.memoryStore({ path: '.harness/approver-taste.jsonl' }))
  .recall(H.recall('mostSpecific', { by: 'specificity', limit: 8 }))
  .readBy(summarizerRole);

const approver = claudeCode.supervisor('approver', {
  grants: [H.ops.workRead, H.ops.blockersResolve, H.ops.attemptsRecover, H.ops.memoryWrite, H.ops.telemetryRead],
});

export const dataJob = H.harness('nightlyData')
  .ledger(sqlite.ledger({ path: '.harness/ledger.sqlite' }))
  .pools(dataPool)
  .lanes(loads)
  .journals(approverTaste)
  .triggers(approvalExpiresAtNine)
  .clients(approver)
  .observers(markdown.board({ path: 'BOARD.md' }), markdown.telemetry({ path: 'TELEMETRY.md' }));
