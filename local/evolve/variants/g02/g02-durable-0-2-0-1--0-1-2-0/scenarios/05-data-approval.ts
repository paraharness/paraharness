import { z } from 'zod';
import { H } from 'harness-dsl';
import type { Retry } from 'harness-dsl';
import { sqlite } from 'harness-dsl/sqlite';
import { jsonl } from 'harness-dsl/jsonl';
import { ssh } from 'harness-dsl/ssh';
import { anthropic } from 'harness-dsl/anthropic';
import { claudeCode } from 'harness-dsl/claude-code';
import { markdown } from 'harness-dsl/markdown';

const sourceSystem = z.enum(['crm', 'billing', 'inventory', 'web-analytics']);
type SourceSystem = z.infer<typeof sourceSystem>;
const sources: SourceSystem[] = ['crm', 'billing', 'inventory', 'web-analytics'];
const nightlyLoad = z.object({ source: sourceSystem, night: z.string() });

const Scheduled = H.state('Scheduled', 'pending');
const Loaded = H.terminal('Loaded', 'success');
const LoadedWithWarnings = H.terminal('LoadedWithWarnings', 'success');
const Rejected = H.terminal('Rejected', 'failure');
const Failed = H.terminal('Failed', 'failure');
const Lapsed = H.terminal('Lapsed', 'neutral');
const NightlyLoad = H.kind('NightlyLoad')
  .attributes(nightlyLoad)
  .states(Scheduled, Loaded, LoadedWithWarnings, Rejected, Failed, Lapsed)
  .key(a => `${a.source}:${a.night}`);

const etlHost = ssh.host('etl', { host: 'etl.internal', user: 'etl', key: H.env('ETL_SSH_KEY') }).slots(2);

const extract = H.command('extract')
  .input(nightlyLoad)
  .argv(i => ['./bin/extract', i.source, i.night])
  .output(z.object({ path: z.string(), rows: z.number() }))
  .runner(etlHost);
const validate = H.command('validate')
  .input(z.object({ path: z.string() }))
  .argv(i => ['./bin/validate', i.path])
  .output(z.object({ passed: z.boolean(), report: z.string() }))
  .runner(etlHost);
const load = H.command('load')
  .input(z.object({ path: z.string(), source: sourceSystem }))
  .argv(i => ['./bin/load', i.source, i.path])
  .runner(etlHost);
const verify = H.command('verify')
  .input(nightlyLoad)
  .argv(i => ['./bin/verify', i.source, i.night])
  .output(z.object({ drift: z.number(), tolerable: z.boolean() }))
  .runner(etlHost);

const quota = sqlite.quota('data-quota', { path: '.harness/quota.db' });
const apiAccount = anthropic.account('data-api', { apiKey: H.env('ANTHROPIC_API_KEY'), quota });
const api = H.pool('data-api').accounts(apiAccount);
const sonnet = anthropic.model('sonnet', { id: 'claude-sonnet-4-5' });

const summarizer = H.role('anomaly-summarizer')
  .intents('read')
  .instructions('Summarise the anomalies in the validation report in plain language for the approver.');
const summarizerSeat = H.seat('anomaly-summarizer')
  .role(summarizer)
  .model(sonnet)
  .pool(api)
  .output(z.object({ summary: z.string() }));

const validationReview = H.halt('validation-review').decision(z.object({ proceed: z.boolean(), notes: z.string() }));
const loadApproval = H.halt('load-approval').decision(z.object({ approved: z.boolean(), notes: z.string() }));

const stepRetry: Retry = { maxAttempts: 3, backoff: 'exponential', initialDelayMs: 60000 };

const nightly = H.flow('nightly-load')
  .input(nightlyLoad)
  .step('extract', extract, ctx => ctx.unit.attributes, { retry: stepRetry, afterCrash: 'rerun' })
  .step('validate', validate, ctx => ({ path: ctx.steps.extract.path }))
  .halt('validationReview', validationReview, {
    when: ctx => !ctx.steps.validate.passed,
    ask: ctx => `Validation failed for ${ctx.unit.attributes.source} on ${ctx.unit.attributes.night}:\n\n${ctx.steps.validate.report}`,
  })
  .exit('rejectedAtValidation', ctx => ctx.steps.validationReview?.proceed === false)
  .step('summarize', summarizerSeat, ctx => ({
    task: `Source ${ctx.unit.attributes.source}, night ${ctx.unit.attributes.night}, ${ctx.steps.extract.rows} rows.\n\n${ctx.steps.validate.report}`,
  }))
  .halt('approval', loadApproval, { ask: ctx => ctx.steps.summarize.summary })
  .exit('rejected', ctx => !ctx.steps.approval.approved)
  .step('load', load, ctx => ({ path: ctx.steps.extract.path, source: ctx.unit.attributes.source }), {
    retry: stepRetry,
    afterCrash: 'park',
  })
  .step('verify', verify, ctx => ctx.unit.attributes)
  .exit('loaded', ctx => ctx.steps.verify.drift === 0)
  .exit('loadedWithWarnings', ctx => ctx.steps.verify.tolerable)
  .exit('driftExceeded');

const approvalLapsed = H.signal('approval-lapsed');

const loads = H.lane('nightly-loads', NightlyLoad)
  .supply(H.clock('two-am').at('02:00', { tz: 'Europe/London' }), (tick, to) =>
    sources.map(source => to.create({ source, night: tick.at.toISOString().slice(0, 10) })))
  .store(sqlite.store({ path: '.harness/loads.db' }))
  .handler(nightly, {
    exits: {
      rejectedAtValidation: Rejected,
      rejected: Rejected,
      loaded: Loaded,
      loadedWithWarnings: LoadedWithWarnings,
      driftExceeded: Failed,
    },
  })
  .retry({ maxAttempts: 1, exhausted: Failed })
  .on(approvalLapsed, { enter: Lapsed, at: ['approval'] });

const lapseAtNine = H.trigger('approval-lapses-at-nine')
  .on(H.when.timer(loads, {
    in: Scheduled,
    at: unit => H.nextTime('09:00', { tz: 'Europe/London', after: unit.createdAt }),
  }))
  .signal(approvalLapsed, loads, event => ({ key: event.unit.key, payload: {} }));

const approverTaste = H.journal('approver-taste', H.memory('taste', 'taste'))
  .store(jsonl.memoryStore({ path: '.harness/taste.jsonl' }))
  .recall({ by: 'specificity', limit: 10 })
  .readBy(summarizer);

const scheduler = H.scheduler('data').standard(loads).wip(loads, 2);

const approver = claudeCode.supervisor('approver', {
  port: H.slot.port(1),
  grants: [
    H.ops.workRead,
    H.ops.resolve(validationReview, loadApproval),
    H.ops.attemptsRecover,
    H.ops.memoryWrite,
    H.ops.telemetryRead,
  ],
});

const harness = H.harness('nightly-data')
  .ledger(sqlite.ledger({ path: '.harness/ledger.db' }))
  .lanes(loads)
  .journals(approverTaste)
  .triggers(lapseAtNine)
  .scheduler(scheduler)
  .clients(approver)
  .observers(markdown.board({ path: 'BOARD.md' }), markdown.telemetry({ path: 'TELEMETRY.md' }));

void harness.start();
