import { H } from 'harness-dsl';
import { z } from 'zod';
import { claudeCode } from 'harness-dsl/claude-code';
import { anthropic } from 'harness-dsl/anthropic';
import { sqlite } from 'harness-dsl/sqlite';
import { jsonl } from 'harness-dsl/jsonl';
import { schedule } from 'harness-dsl/supply';
import { ssh } from 'harness-dsl/runners';
import { byApplicability } from 'harness-dsl/policies';
import { board, telemetry } from 'harness-dsl/projections';

const Scheduled = H.state('Scheduled').pending();
const Extracting = H.state('Extracting').active();
const AwaitingApproval = H.state('AwaitingApproval').active();
const Loading = H.state('Loading').active();
const Loaded = H.state('Loaded').succeeded();
const LoadedWithWarnings = H.state('LoadedWithWarnings').succeeded();
const Rejected = H.state('Rejected').ended();
const Failed = H.state('Failed').failed();
const ApprovalLapsed = H.state('ApprovalLapsed').cancelled();

const NightlyLoad = H.work('nightly-load')
  .schema(z.object({ source: z.string(), night: z.string() }))
  .states(Scheduled, Extracting, AwaitingApproval, Loading, Loaded, LoadedWithWarnings, Rejected, Failed, ApprovalLapsed)
  .key(d => `${d.source}@${d.night}`);

const ApproverTaste = H.memory('approver-taste').content(z.object({ preference: z.string() })).taste();
const tasteJournal = H.journal('approver-taste').of(ApproverTaste).store(jsonl.memory('memory/taste.jsonl')).recall(byApplicability({ budgetTokens: 600 }));

const api = H.account('anthropic-api', anthropic.api({ apiKey: H.env('ANTHROPIC_API_KEY') }));
const sonnet = H.model('sonnet', api, 'claude-sonnet-4-5').pricing(anthropic.pricing());

const summarizerRole = H.role('anomaly-summarizer')
  .prompt('You explain data anomalies in plain language for the person approving the load.')
  .tools()
  .recall(ApproverTaste);

const summarizeAnomalies = H.skill('summarize-anomalies')
  .input(z.object({ source: z.string(), rows: z.number(), report: z.string() }))
  .prompt(i => `Source ${i.source}, ${i.rows} rows extracted.\nValidation report:\n${i.report}\nSummarize the anomalies.`);

const summarizer = H.agent('anomaly-summarizer').role(summarizerRole).model(sonnet);

const etlHost = ssh('etl-host', { host: H.env('ETL_HOST'), user: 'etl', keyPath: H.env('ETL_SSH_KEY_PATH') }).slots(2);

const extract = H.command('extract')
  .input(z.object({ source: z.string(), night: z.string() }))
  .output(z.object({ rows: z.number(), file: z.string() }))
  .runner(etlHost)
  .run(async ctx => {
    const file = `/data/staging/${ctx.input.source}-${ctx.input.night}.parquet`;
    const result = await ctx.exec('etl', ['extract', ctx.input.source, '--out', file]);
    return { rows: Number(result.stdout.trim()), file };
  });

const validate = H.command('validate')
  .input(z.object({ file: z.string() }))
  .output(z.object({ ok: z.boolean(), report: z.string() }))
  .runner(etlHost)
  .run(async ctx => {
    const result = await ctx.exec('etl', ['validate', ctx.input.file], { allowFailure: true });
    return { ok: result.exitCode === 0, report: result.stdout };
  });

const load = H.command('load')
  .input(z.object({ file: z.string(), source: z.string() }))
  .runner(etlHost)
  .run(async ctx => {
    await ctx.exec('etl', ['load', ctx.input.source, ctx.input.file]);
  });

const verify = H.command('verify')
  .input(z.object({ source: z.string(), rows: z.number() }))
  .output(z.object({ driftPercent: z.number() }))
  .runner(etlHost)
  .run(async ctx => {
    const result = await ctx.exec('etl', ['verify', ctx.input.source, '--expected-rows', String(ctx.input.rows)]);
    return { driftPercent: Number(result.stdout.trim()) };
  });

const backoff = { maxRetries: 3, backoff: 'exponential', initialDelayMs: 30000 } as const satisfies { readonly maxRetries: number; readonly backoff: 'exponential'; readonly initialDelayMs: number };

const tolerableDriftPercent = 0.5;

const nightlyFlow = H.flow('nightly-load')
  .of(NightlyLoad)
  .transition(Extracting)
  .step('extract', extract, s => ({ source: s.unit.data.source, night: s.unit.data.night }), { retry: backoff })
  .step('validate', validate, s => ({ file: s.steps.extract.file }))
  .when(
    s => !s.steps.validate.ok,
    w =>
      w
        .halt('validationReview', {
          ask: s => `Validation failed for ${s.unit.data.source} (${s.unit.data.night}):\n${s.steps.validate.report}\nProceed anyway?`,
          decision: z.object({ proceed: z.boolean() }),
        })
        .when(
          s => !s.steps.validationReview.proceed,
          x => x.transition(Failed),
        ),
  )
  .step('summary', summarizer.perform(summarizeAnomalies), s => ({
    source: s.unit.data.source,
    rows: s.steps.extract.rows,
    report: s.steps.validate.report,
  }))
  .transition(AwaitingApproval)
  .halt('approval', {
    ask: s => `Approve the ${s.unit.data.source} load for ${s.unit.data.night}?\n\n${s.steps.summary}`,
    decision: z.object({ approve: z.boolean(), note: z.string() }),
  })
  .when(
    s => !s.steps.approval.approve,
    w => w.transition(Rejected),
  )
  .transition(Loading)
  .step('load', load, s => ({ file: s.steps.extract.file, source: s.unit.data.source }), { retry: backoff })
  .step('verify', verify, s => ({ source: s.unit.data.source, rows: s.steps.extract.rows }))
  .transition(s =>
    s.steps.verify.driftPercent === 0 ? Loaded : s.steps.verify.driftPercent <= tolerableDriftPercent ? LoadedWithWarnings : Failed,
  );

const sources = ['billing', 'crm', 'inventory', 'web-events'];

const loads = H.lane('nightly-loads')
  .of(NightlyLoad)
  .from(schedule('0 2 * * *', at => sources.map(source => ({ source, night: at.toISOString().slice(0, 10) })), { timeZone: 'Europe/Berlin' }))
  .store(sqlite.store('.harness/loads.sqlite'))
  .handle(nightlyFlow);

const nineAmOf = (night: string): Date => new Date(`${night}T09:00:00+01:00`);

const approvalLapses = H.trigger('approval-lapses-at-nine')
  .on(loads.deadline(u => nineAmOf(u.data.night), { during: [AwaitingApproval] }))
  .move(ApprovalLapsed);

const fifo = H.policy.schedule('arrival-order', ctx => ({
  start: [...ctx.pending].sort((a, b) => a.queuedAt.getTime() - b.queuedAt.getTime()),
}));

const supervisor = H.supervisor('approver')
  .endpoint(claudeCode.endpoint({ server: 'nightly-loads' }))
  .grant(H.ops.work.read, H.ops.blockers.resolve, H.ops.memory.write, H.ops.telemetry.read);

export const dataJob = H.harness('nightly-data-job')
  .ledger(sqlite.ledger('.harness/ledger.sqlite'))
  .lanes(loads)
  .journals(tasteJournal)
  .triggers(approvalLapses)
  .scheduler(H.scheduler('nightly').concurrency(2).policy(fifo))
  .supervisor(supervisor)
  .projections(board('BOARD.md'), telemetry('TELEMETRY.md'));

export const run = dataJob.start();
