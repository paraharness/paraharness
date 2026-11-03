import { z } from 'zod';
import { H } from 'harness-dsl';
import * as anthropic from 'harness-dsl/anthropic';
import * as claude from 'harness-dsl/claude-code';
import * as sqlite from 'harness-dsl/sqlite';
import * as jsonl from 'harness-dsl/jsonl';
import * as local from 'harness-dsl/local';
import * as ssh from 'harness-dsl/ssh';
import * as markdown from 'harness-dsl/markdown';

const Scheduled = H.state('scheduled', 'pending');
const Extracting = H.state('extracting', 'active');
const Validating = H.state('validating', 'active');
const Summarizing = H.state('summarizing', 'active');
const AwaitingApproval = H.state('awaiting-approval', 'active');
const Loading = H.state('loading', 'active');
const Verifying = H.state('verifying', 'active');
const Loaded = H.state('loaded', 'succeeded');
const LoadedWithWarnings = H.state('loaded-with-warnings', 'succeeded');
const Rejected = H.state('rejected', 'failed');
const LoadFailed = H.state('load-failed', 'failed');
const Expired = H.state('expired', 'cancelled');

const Sources = z.enum(['crm', 'billing', 'inventory', 'web']);
const NightlySchema = z.object({ source: Sources, night: z.string() });
type NightlyData = z.infer<typeof NightlySchema>;

const NightlyLoad = H.work('NightlyLoad', NightlySchema)
  .states(Scheduled, Extracting, Validating, Summarizing, AwaitingApproval, Loading, Verifying, Loaded, LoadedWithWarnings, Rejected, LoadFailed, Expired)
  .key(load => `${load.source}@${load.night}`);

const etlHost = ssh.host('etl', { host: 'etl.internal', user: 'etl', key: H.env('ETL_SSH_KEY') });
const backoff = { max: 3, initialSeconds: 60, factor: 2 };

const extract = H.command('extract').run((input: NightlyData) => ['etl', 'extract', input.source, '--night', input.night]);
const validate = H.command('validate')
  .run((input: NightlyData) => ['etl', 'validate', input.source, '--night', input.night])
  .output(z.object({ rows: z.number(), anomalies: z.array(z.string()) }));
const load = H.command('load').run((input: NightlyData) => ['etl', 'load', input.source, '--night', input.night]);
const verify = H.command('verify')
  .run((input: NightlyData) => ['etl', 'verify', input.source, '--night', input.night])
  .output(z.object({ driftPercent: z.number() }));

const apiAccount = anthropic.apiKey('etl-api', { key: H.env('ANTHROPIC_API_KEY') });
const approverTaste = H.journal('approver-taste', H.memory.taste('approver-taste'))
  .store(jsonl.memory('.harness/approver-taste.jsonl'))
  .recall(H.policy.specificity({ limit: 10 }));

const summarist = H.agent('anomaly-summarist', H.role('summarist').instructions('Explain the anomalies in plain language for the approver.'))
  .model(anthropic.model('claude-sonnet-4-5'))
  .pool(H.pool('etl').accounts(apiAccount))
  .recall(approverTaste);

const nightly = H.flow<NightlyData>('nightly-load')
  .exits('loaded', 'warned', 'rejected', 'drifted')
  .call('extract', extract, ctx => ctx.unit.data, { on: etlHost, retry: backoff })
  .call('validate', validate, ctx => ctx.unit.data, {
    onFailure: {
      halt: (ctx, failure) =>
        `Validation failed for ${ctx.unit.data.source} on ${ctx.unit.data.night}:\n${failure.result?.stdout ?? failure.message}`,
    },
  })
  .call('summarize', summarist, ctx =>
    `Source ${ctx.unit.data.source}, ${ctx.steps.validate.rows} rows.\nAnomalies:\n${ctx.steps.validate.anomalies.join('\n')}`,
  )
  .halt('approve', {
    ask: ctx => `Load ${ctx.unit.data.source} for ${ctx.unit.data.night}?\n\n${ctx.steps.summarize}`,
    decision: z.object({ approved: z.boolean(), note: z.string().optional() }),
  })
  .exitWhen(ctx => (ctx.steps.approve.approved ? undefined : 'rejected'))
  .call('load', load, ctx => ctx.unit.data, { on: etlHost, retry: backoff })
  .call('verify', verify, ctx => ctx.unit.data, { onFailure: { exit: 'drifted' } })
  .exit(ctx => (ctx.steps.verify.driftPercent > 0 ? 'warned' : 'loaded'));

const nightlyLane = H.lane(NightlyLoad)
  .supply(
    H.supply.schedule(NightlyLoad, { daily: { at: '02:00' } }).create(tick =>
      Sources.options.map(source => ({ source, night: tick.now.toISOString().slice(0, 10) })),
    ),
  )
  .store(sqlite.store(NightlyLoad, '.harness/loads.db'))
  .handler(nightly)
  .exits({ loaded: Loaded, warned: LoadedWithWarnings, rejected: Rejected, drifted: LoadFailed, crashed: LoadFailed })
  .phases({
    extract: Extracting,
    validate: Validating,
    summarize: Summarizing,
    approve: AwaitingApproval,
    load: Loading,
    verify: Verifying,
  })
  .deadline(unit => new Date(`${unit.data.night}T09:00:00`))
  .runner(local.runner('local'));

const approvalWindowCloses = H.trigger('approval-window-closes')
  .on(H.on.deadline(nightlyLane, { while: [AwaitingApproval] }))
  .do(event => H.do.react(nightlyLane, event.unit, { cancel: true, to: Expired }));

const approverGrant = H.grant('approver', H.op.readWork, H.op.resolveBlocker, H.op.writeMemory, H.op.readTelemetry);

export const dataJob = H.harness('nightly-data')
  .ledger(sqlite.ledger('.harness/ledger.db'))
  .lanes(nightlyLane)
  .triggers(approvalWindowCloses)
  .clients(claude.supervisor({ grant: approverGrant }))
  .observe(markdown.board({ path: 'BOARD.md' }), markdown.telemetry({ path: 'TELEMETRY.md' }))
  .timeZone('Europe/Berlin');

void dataJob.start();
