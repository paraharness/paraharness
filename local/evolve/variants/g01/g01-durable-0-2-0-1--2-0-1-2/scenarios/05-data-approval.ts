import { z } from 'zod';
import { H } from 'harness-dsl';
import { sqlite } from 'harness-dsl/sqlite';
import { jsonl } from 'harness-dsl/jsonl';
import { anthropic } from 'harness-dsl/anthropic';
import { claudeCode } from 'harness-dsl/claude-code';
import { ssh } from 'harness-dsl/ssh';
import { local } from 'harness-dsl/local';
import { markdown } from 'harness-dsl/markdown';

const quota = sqlite.quota('data-quota', { path: './state/quota.sqlite' });
const apiAccount = anthropic.account('data-api', { apiKey: H.env('ANTHROPIC_API_KEY'), quota });
const sonnet = anthropic.model('sonnet', { id: 'claude-sonnet-4-5' });
const apiPool = H.pool('data-api').accounts(apiAccount);

const NightlyLoad = z.object({
  source: z.enum(['crm', 'billing', 'inventory', 'support']),
  night: z.string(),
});
type NightlyLoadAttrs = z.infer<typeof NightlyLoad>;

const Scheduled = H.state('Scheduled', 'pending');
const Loaded = H.terminal('Loaded', 'success');
const LoadedWithWarnings = H.terminal('LoadedWithWarnings', 'success');
const Rejected = H.terminal('Rejected', 'failure');
const Failed = H.terminal('Failed', 'failure');
const Expired = H.terminal('Expired', 'neutral');

const loadKind = H.kind('NightlyLoad')
  .attributes(NightlyLoad)
  .states(Scheduled, Loaded, LoadedWithWarnings, Rejected, Failed, Expired)
  .key(attrs => `${attrs.source}:${attrs.night}`)
  .initial(Scheduled);

const warehouseHost = ssh.host('warehouse', { host: 'etl.internal', user: 'etl', key: H.env('ETL_SSH_KEY') }).slots(2);
const localRunner = local.runner('local').slots(4);

const extract = H.command('extract')
  .input(NightlyLoad)
  .argv(input => ['./etl/extract.sh', input.source, input.night])
  .output(z.object({ file: z.string(), rows: z.number() }))
  .runner(warehouseHost);

const validate = H.command('validate')
  .input(z.object({ source: z.string(), file: z.string() }))
  .argv(input => ['./etl/validate.sh', input.source, input.file])
  .output(z.object({ passed: z.boolean(), report: z.string() }))
  .acceptExitCodes(0, 1)
  .runner(localRunner);

const load = H.command('load')
  .input(z.object({ source: z.string(), file: z.string() }))
  .argv(input => ['./etl/load.sh', input.source, input.file])
  .runner(warehouseHost);

const verify = H.command('verify')
  .input(NightlyLoad)
  .argv(input => ['./etl/verify.sh', input.source, input.night])
  .output(z.object({ drift: z.number(), tolerable: z.boolean() }))
  .runner(warehouseHost);

const summarizerRole = H.role('anomaly-summarizer')
  .intents('read')
  .instructions('Summarise the anomalies in plain language for the approver.');
const approverRole = H.role('approver');

const summarizer = H.seat('anomaly-summarizer')
  .role(summarizerRole)
  .model(sonnet)
  .pool(apiPool)
  .output(z.object({ summary: z.string() }));

const validationReview = H.halt('validation-review').decision(z.object({ proceed: z.boolean(), note: z.string() }));
const loadApproval = H.halt('load-approval').decision(z.object({ approve: z.boolean(), note: z.string() }));
const approvalExpired = H.signal('approval-expired');

const stepRetry = { maxAttempts: 3, backoff: 'exponential', initialDelayMs: 60_000 } satisfies {
  readonly maxAttempts: number;
  readonly backoff: 'exponential';
  readonly initialDelayMs: number;
};

const nightlyLoad = H.flow('nightly-load')
  .input(NightlyLoad)
  .step('extract', extract, ctx => ctx.unit.attributes, { retry: stepRetry, afterCrash: 'rerun' })
  .step('validate', validate, ctx => ({ source: ctx.unit.attributes.source, file: ctx.steps.extract.file }))
  .halt('validationReview', validationReview, {
    when: ctx => !ctx.steps.validate.passed,
    ask: ctx => `Validation failed for ${ctx.unit.attributes.source} (${ctx.unit.attributes.night}):\n${ctx.steps.validate.report}`,
  })
  .exit('rejectedAtValidation', ctx => ctx.steps.validationReview?.proceed === false)
  .step('summarize', summarizer, ctx => ({
    task: `Summarise the anomalies in this validation report for ${ctx.unit.attributes.source}, ${ctx.steps.extract.rows} rows:\n${ctx.steps.validate.report}`,
  }))
  .halt('approval', loadApproval, { ask: ctx => ctx.steps.summarize.summary })
  .exit('rejected', ctx => !ctx.steps.approval.approve)
  .step('load', load, ctx => ({ source: ctx.unit.attributes.source, file: ctx.steps.extract.file }), {
    retry: stepRetry,
    afterCrash: 'park',
  })
  .step('verify', verify, ctx => ctx.unit.attributes)
  .exit('loaded', ctx => ctx.steps.verify.drift === 0)
  .exit('loadedWithWarnings', ctx => ctx.steps.verify.tolerable)
  .exit('drifted');

const sourceSystems: readonly NightlyLoadAttrs['source'][] = ['crm', 'billing', 'inventory', 'support'];

const loadLane = H.lane('nightly-loads', loadKind)
  .handler(nightlyLoad, {
    exits: {
      rejectedAtValidation: Rejected,
      rejected: Rejected,
      loaded: Loaded,
      loadedWithWarnings: LoadedWithWarnings,
      drifted: Failed,
    },
  })
  .store(sqlite.store({ path: './state/loads.sqlite' }))
  .retry({ maxAttempts: 1, exhausted: Failed })
  .on(approvalExpired, { at: ['approval'], enter: Expired })
  .supply(H.clock('nightly-0200').at('02:00', { tz: 'Europe/Berlin' }), (tick, to) =>
    sourceSystems.map(source => to.create({ source, night: tick.at.toISOString().slice(0, 10) })),
  );

const approvalDeadline = H.trigger('approval-deadline-0900')
  .on(H.when.timer(loadLane, { at: unit => H.nextTime('09:00', { after: unit.createdAt, tz: 'Europe/Berlin' }) }))
  .signal(approvalExpired, loadLane, event => ({ key: event.unit.key, payload: {} }));

const approverTaste = H.journal('approver-taste', H.memory('approver-taste', 'taste'))
  .store(jsonl.memoryStore({ path: './memory/approver-taste.jsonl' }))
  .recall({ by: 'specificity', limit: 10 })
  .readBy(summarizerRole)
  .recordedBy(approverRole);

const scheduler = H.scheduler('nightly').standard(loadLane).wip(loadLane, 2);

const supervisor = claudeCode.supervisor('approver-desk', {
  port: H.slot.port(0),
  grants: [
    H.ops.workRead,
    H.ops.attemptsRecover,
    H.ops.resolve(validationReview, loadApproval),
    H.ops.memoryRead,
    H.ops.memoryWrite,
    H.ops.telemetryRead,
  ],
});

export default H.harness('nightly-data')
  .ledger(sqlite.ledger({ path: './state/ledger.sqlite' }))
  .lanes(loadLane)
  .journals(approverTaste)
  .triggers(approvalDeadline)
  .scheduler(scheduler)
  .clients(supervisor)
  .observers(markdown.board({ path: './BOARD.md' }), markdown.telemetry({ path: './TELEMETRY.md' }));
