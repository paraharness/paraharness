import { z } from 'zod';
import { H } from 'harness-dsl';
import { sqlite } from 'harness-dsl/sqlite';
import { jsonl } from 'harness-dsl/jsonl';
import { claudeCode } from 'harness-dsl/claude-code';
import { local } from 'harness-dsl/local';
import { ssh } from 'harness-dsl/ssh';
import { markdown } from 'harness-dsl/markdown';

const sourceSystem = H.facet('source-system', ['crm', 'billing', 'inventory', 'web-analytics']);
const loadAttrs = z.object({ source: sourceSystem.schema, night: z.string() });

const Scheduled = H.state('scheduled', 'pending');
const Loaded = H.terminal('loaded', 'success');
const LoadedWithWarnings = H.terminal('loaded-with-warnings', 'success');
const Rejected = H.terminal('rejected', 'failure');
const LoadFailed = H.terminal('load-failed', 'failure');
const MissedWindow = H.terminal('missed-window', 'neutral');
const loadKind = H.kind('NightlyLoad')
  .attributes(loadAttrs)
  .states(Scheduled, Loaded, LoadedWithWarnings, Rejected, LoadFailed, MissedWindow)
  .key(a => `${a.source}/${a.night}`)
  .initial(Scheduled);

const missedWindow = H.signal('approval-window-missed');
const validationReview = H.halt('validation-review').decision(z.object({ proceed: z.boolean(), note: z.string() }));
const loadApproval = H.halt('load-approval').decision(z.object({ approved: z.boolean(), note: z.string().optional() }));

const etlHost = ssh.host('etl', { host: 'etl.internal', user: 'etl', key: H.env('ETL_SSH_KEY') }).slots(2);
const localRunner = local.runner('local');

const extract = H.command('extract')
  .input(loadAttrs)
  .argv(i => ['/opt/etl/extract.sh', i.source, i.night])
  .runner(etlHost);

const validate = H.command('validate')
  .input(loadAttrs)
  .argv(i => ['./bin/validate', i.source, i.night])
  .output(z.object({ ok: z.boolean(), report: z.string() }))
  .runner(localRunner);

const load = H.command('load')
  .input(loadAttrs)
  .argv(i => ['/opt/etl/load.sh', i.source, i.night])
  .runner(etlHost);

const verify = H.command('verify')
  .input(loadAttrs)
  .argv(i => ['./bin/verify', i.source, i.night])
  .output(z.object({ driftPercent: z.number() }))
  .runner(localRunner);

const summaryRole = H.role('anomaly-summarizer').intents('read').instructions('Summarize anomalies in plain language for the approver.');

const quota = sqlite.quota('data-quota', { path: '.harness/quota.db' });
const subscription = claudeCode.subscription('claude-max', { token: H.env('CLAUDE_TOKEN'), quota });
const summaryPool = H.pool('summary').accounts(subscription);
const sonnet = claudeCode.model('sonnet', { id: 'claude-sonnet-4-5' });

const summarizer = H.seat('anomaly-summarizer')
  .role(summaryRole)
  .model(sonnet)
  .pool(summaryPool)
  .output(z.object({ summary: z.string() }));

const approverTaste = H.journal('approver-taste', H.memory('taste', 'taste'))
  .store(jsonl.memoryStore({ path: '.harness/taste.jsonl' }))
  .recall({ by: 'specificity', limit: 8 })
  .readBy(summaryRole);

const stepRetry = H.retry({ maxAttempts: 3, backoff: 'exponential', initialDelayMs: 60000 });

const nightlyLoad = H.flow('nightly-load')
  .input(loadAttrs)
  .step('extract', extract, ctx => ctx.unit.attributes, { retry: stepRetry, afterCrash: 'rerun' })
  .step('validate', validate, ctx => ctx.unit.attributes)
  .halt('review', validationReview, {
    when: ctx => !ctx.steps.validate.ok,
    ask: ctx => `Validation failed for ${ctx.unit.attributes.source} on ${ctx.unit.attributes.night}:\n${ctx.steps.validate.report}`,
  })
  .exit('validation-rejected', ctx => ctx.steps.review?.proceed === false)
  .step('summarize', summarizer, ctx => ({
    task: `Summarize anomalies for ${ctx.unit.attributes.source} on ${ctx.unit.attributes.night}:\n${ctx.steps.validate.report}`,
  }))
  .halt('approval', loadApproval, {
    ask: ctx => `Approve the ${ctx.unit.attributes.source} load for ${ctx.unit.attributes.night}?\n\n${ctx.steps.summarize.summary}`,
  })
  .exit('rejected', ctx => !ctx.steps.approval.approved)
  .step('load', load, ctx => ctx.unit.attributes, { retry: stepRetry, afterCrash: 'park' })
  .step('verify', verify, ctx => ctx.unit.attributes)
  .exit('loaded-with-warnings', ctx => ctx.steps.verify.driftPercent > 0)
  .exit('loaded');

const loadLane = H.lane('nightly-loads', loadKind)
  .supply(H.clock('two-am').at('02:00', { tz: 'UTC' }), (tick, to) =>
    sourceSystem.values.map(source => to.create({ source, night: tick.at.toISOString().slice(0, 10) })))
  .handler(nightlyLoad, {
    exits: {
      'validation-rejected': Rejected,
      rejected: Rejected,
      'loaded-with-warnings': LoadedWithWarnings,
      loaded: Loaded,
    },
  })
  .store(sqlite.store({ path: '.harness/loads.db' }))
  .retry({ maxAttempts: 1, exhausted: LoadFailed })
  .on(missedWindow, { enter: MissedWindow, at: ['approval'] });

const approvalWindowCloses = H.trigger('approval-window-closes')
  .on(H.when.timer(loadLane, { at: view => H.nextTime('09:00', { after: view.createdAt, tz: 'UTC' }) }))
  .signal(missedWindow, loadLane, e => (e.unit.attempt?.step === 'approval' ? { key: e.unit.key, payload: {} } : undefined));

const scheduler = H.scheduler('data').standard(loadLane).wip(loadLane, 4);

const approverConsole = claudeCode.supervisor('approver', {
  port: H.slot.port(0),
  grants: [
    H.ops.workRead,
    H.ops.resolve(validationReview, loadApproval),
    H.ops.memoryRead,
    H.ops.memoryWrite,
    H.ops.telemetryRead,
  ],
});

export default H.harness('nightly-data')
  .ledger(sqlite.ledger({ path: '.harness/ledger.db' }))
  .lanes(loadLane)
  .journals(approverTaste)
  .triggers(approvalWindowCloses)
  .scheduler(scheduler)
  .clients(approverConsole)
  .observers(markdown.board({ path: 'BOARD.md' }), markdown.telemetry({ path: 'TELEMETRY.md' }));
