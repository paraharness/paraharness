import { z } from 'zod';
import { H } from 'harness-dsl';
import { anthropic } from 'harness-dsl/anthropic';
import { claudeCode } from 'harness-dsl/claude-code';
import { sqlite } from 'harness-dsl/sqlite';
import { jsonl } from 'harness-dsl/jsonl';
import { schedule } from 'harness-dsl/supply';
import { byApplicability } from 'harness-dsl/policies';
import { board, telemetry } from 'harness-dsl/observers';
import { local } from 'harness-dsl/local';
import { ssh } from 'harness-dsl/ssh';

const nightlyLoad = z.object({ source: z.string(), runDate: z.string() });
type NightlyLoadData = z.infer<typeof nightlyLoad>;

const Scheduled = H.state('scheduled').pending();
const Extracting = H.state('extracting').active();
const AwaitingApproval = H.state('awaiting-approval').active();
const Loading = H.state('loading').active();
const Loaded = H.state('loaded').succeeded();
const LoadedWithWarnings = H.state('loaded-with-warnings').succeeded();
const Rejected = H.state('rejected').ended();
const LoadFailed = H.state('load-failed').failed();
const ApprovalExpired = H.state('approval-expired').cancelled();

const NightlyLoad = H.work('nightly-load')
  .schema(nightlyLoad)
  .states(Scheduled, Extracting, AwaitingApproval, Loading, Loaded, LoadedWithWarnings, Rejected, LoadFailed, ApprovalExpired)
  .resources(load => [load.source]);

const Taste = H.memory('approver-taste').content(z.object({ emphasise: z.string(), because: z.string() }));
const approverTaste = H.journal('approver-taste')
  .of(Taste)
  .store(jsonl.store('.harness/approver-taste.jsonl'))
  .recall(byApplicability({ budgetTokens: 600 }));

const apiAccount = H.account('anthropic-api', anthropic.api({ apiKey: H.env('ANTHROPIC_API_KEY') }));
const sonnet = H.model('sonnet', apiAccount, 'claude-sonnet-4-5');

const summarizer = H.agent('anomaly-summarizer')
  .role(
    H.role('anomaly-summarizer')
      .prompt('Explain the validation anomalies in plain language for the approver.')
      .recall(Taste),
  )
  .model(sonnet);

const summarizeAnomalies = H.skill('summarize-anomalies')
  .input(z.object({ source: z.string(), report: z.string() }))
  .prompt(job => `Source system: ${job.source}\n\nValidation report:\n${job.report}`);

const etlHost = H.runner('etl-host', ssh({ host: 'etl.internal', user: 'etl', keyFile: H.env('ETL_SSH_KEY') })).slots(2);
const localRunner = H.runner('local', local()).slots(2);

const extract = H.command('extract')
  .input(nightlyLoad)
  .output(z.object({ rows: z.number() }))
  .runner(etlHost)
  .run(async ({ input, exec }) => {
    const result = await exec(`etl extract --source ${input.source} --date ${input.runDate}`);
    if (result.exitCode !== 0) {
      throw new Error(result.stderr);
    }
    return { rows: Number(result.stdout.trim()) };
  });

const validate = H.command('validate')
  .input(nightlyLoad)
  .output(z.object({ ok: z.boolean(), report: z.string() }))
  .runner(etlHost)
  .run(async ({ input, exec }) => {
    const result = await exec(`etl validate --source ${input.source} --date ${input.runDate}`);
    return { ok: result.exitCode === 0, report: result.stdout };
  });

const load = H.command('load')
  .input(nightlyLoad)
  .runner(etlHost)
  .run(async ({ input, exec }) => {
    const result = await exec(`etl load --source ${input.source} --date ${input.runDate}`);
    if (result.exitCode !== 0) {
      throw new Error(result.stderr);
    }
  });

const verify = H.command('verify')
  .input(nightlyLoad)
  .output(z.object({ driftRatio: z.number() }))
  .runner(localRunner)
  .run(async ({ input, exec }) => {
    const result = await exec(`etl verify --source ${input.source} --date ${input.runDate}`);
    if (result.exitCode !== 0) {
      throw new Error(result.stderr);
    }
    return { driftRatio: Number(result.stdout.trim()) };
  });

const ValidationReview = H.blocker('validation-review').resolution(
  z.object({ proceed: z.boolean(), note: z.string().optional() }),
);
const LoadApproval = H.blocker('load-approval').resolution(
  z.object({ approved: z.boolean(), note: z.string().optional() }),
);

const exponentialRetry = { maxRetries: 3, backoff: { initialMs: 60000, factor: 2, maxMs: 600000 } };
const tolerableDriftRatio = 0.01;

const nightlyLoadFlow = H.flow('nightly-load')
  .for(NightlyLoad)
  .transition(Extracting)
  .step('extract', extract, { input: (_, ctx) => ctx.unit.data, retry: exponentialRetry })
  .step('validate', validate, { input: (_, ctx) => ctx.unit.data })
  .haltIf(validation => !validation.ok, ValidationReview, validation => validation.report)
  .when(
    reviewed => reviewed.resolution !== null && !reviewed.resolution.proceed,
    stopped => stopped.transition(LoadFailed),
  )
  .step('summarize', summarizeAnomalies.by(summarizer), {
    input: (reviewed, ctx) => ({ source: ctx.unit.data.source, report: reviewed.value.report }),
  })
  .transition(AwaitingApproval)
  .halt(LoadApproval, summary => summary)
  .when(
    decision => !decision.resolution.approved,
    rejected => rejected.transition(Rejected),
  )
  .transition(Loading)
  .step('load', load, { input: (_, ctx) => ctx.unit.data, retry: exponentialRetry })
  .step('verify', verify, { input: (_, ctx) => ctx.unit.data })
  .transition(check =>
    check.driftRatio === 0 ? Loaded : check.driftRatio <= tolerableDriftRatio ? LoadedWithWarnings : LoadFailed,
  )
  .onError(LoadFailed);

const sourceSystems = ['crm', 'billing', 'inventory', 'web-analytics'];
const calendarDay = (at: Date): string => at.toISOString().slice(0, 10);

const nightlyLoads = H.lane('nightly-loads')
  .of(NightlyLoad)
  .from(
    schedule<NightlyLoadData>({ cron: '0 2 * * *' }, tick =>
      sourceSystems.map(source => ({
        key: `${source}@${calendarDay(tick.now)}`,
        data: { source, runDate: calendarDay(tick.now) },
      })),
    ),
  )
  .store(sqlite.store<NightlyLoadData>({ path: '.harness/loads.db', table: 'nightly_loads' }))
  .handle(nightlyLoadFlow)
  .deadline(unit => {
    const nineAm = new Date(unit.createdAt);
    nineAm.setHours(9, 0, 0, 0);
    return nineAm;
  });

const unapprovedByNineCancels = H.trigger('unapproved-by-nine-cancels')
  .on(nightlyLoads.overdue().where(late => late.unit.state.name === AwaitingApproval.name))
  .transition(ApprovalExpired);

const scheduler = H.scheduler('nightly')
  .concurrency(4)
  .policy(
    H.policy.schedule('first-in-first-out', ctx => ({
      start: [...ctx.pending].sort((a, b) => a.enqueuedAt.getTime() - b.enqueuedAt.getTime()),
    })),
  );

const supervisor = H.supervisor('approver')
  .client(claudeCode.client({ port: 7450 }))
  .grant(H.ops.work.read, H.ops.blockers.resolve, H.ops.memory.write, H.ops.telemetry.read);

export const dataJob = H.harness('nightly-data-job')
  .ledger(sqlite.ledger('.harness/ledger.db'))
  .lanes(nightlyLoads)
  .journals(approverTaste)
  .triggers(unapprovedByNineCancels)
  .scheduler(scheduler)
  .supervisor(supervisor)
  .observe(board('BOARD.md'), telemetry('TELEMETRY.md'));

export const running = dataJob.start();
