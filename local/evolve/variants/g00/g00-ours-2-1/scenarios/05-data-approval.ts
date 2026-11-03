import { z } from 'zod';
import { H } from 'harness-dsl';
import type { StepOptions } from 'harness-dsl';
import { claudeCode } from 'harness-dsl/claude-code';
import { anthropic } from 'harness-dsl/anthropic';
import { sqlite } from 'harness-dsl/sqlite';
import { jsonl } from 'harness-dsl/jsonl';
import { schedule } from 'harness-dsl/supply';
import { runners } from 'harness-dsl/runners';
import { policies } from 'harness-dsl/policies';
import { observers } from 'harness-dsl/observers';

const nightlyLoad = z.object({ source: z.string(), night: z.string() });
type NightlyLoadData = z.infer<typeof nightlyLoad>;

const scheduled = H.state('scheduled').pending();
const loading = H.state('loading').active();
const loaded = H.state('loaded').terminal('success');
const loadedWithWarnings = H.state('loaded-with-warnings').terminal('success');
const rejected = H.state('rejected').terminal('neutral');
const expired = H.state('expired').terminal('neutral');
const failed = H.state('failed').terminal('failure');

const NightlyLoad = H.work('nightly-load').schema(nightlyLoad).states(scheduled, loading, loaded, loadedWithWarnings, rejected, expired, failed);

const validationReview = H.halt('validation-review')
  .context(z.object({ source: z.string(), report: z.string() }))
  .decision(z.object({ proceed: z.boolean(), note: z.string() }))
  .ask(context => `Validation failed for ${context.source}. Proceed anyway?\n\n${context.report}`);
const loadApproval = H.halt('load-approval')
  .context(z.object({ source: z.string(), summary: z.string() }))
  .decision(z.object({ approve: z.boolean(), note: z.string() }))
  .ask(context => `Approve tonight's load of ${context.source}?\n\n${context.summary}`);

const taste = H.memory('taste').content(z.object({ rule: z.string() })).trust('taste');

const apiAccount = H.account('api', anthropic.api({ apiKey: H.env('ANTHROPIC_API_KEY') }));
const sonnet = H.model('claude-sonnet-4-5').pricing(anthropic.pricing());

const warehouse = runners.ssh({ name: 'etl-host', host: 'etl.internal', user: 'etl', identity: H.env('ETL_SSH_KEY'), slots: 2 });

const exponentialRetry: StepOptions = { retry: { retries: 3, backoff: { initial: '30s', factor: 2, max: '10m' } } };

const extract = H.command('extract')
  .input(nightlyLoad)
  .output(z.object({ file: z.string() }))
  .runner(warehouse)
  .effect('repeatable')
  .run(async (input, ctx) => {
    const file = `/data/staging/${input.source}-${input.night}.parquet`;
    const result = await ctx.exec(['extract', input.source, '--night', input.night, '--out', file]);
    if (result.code !== 0) throw new Error(result.stderr);
    return { file };
  });

const validate = H.command('validate')
  .input(z.object({ source: z.string(), file: z.string() }))
  .output(z.object({ ok: z.boolean(), report: z.string(), anomalies: z.array(z.string()) }))
  .runner(warehouse)
  .effect('repeatable')
  .run(async (input, ctx) => {
    const result = await ctx.exec(['validate', input.file, '--source', input.source]);
    const anomalies = result.stdout.split('\n').filter(line => line.startsWith('ANOMALY'));
    return { ok: result.code === 0, report: result.stdout, anomalies };
  });

const load = H.command('load')
  .input(z.object({ source: z.string(), file: z.string() }))
  .output(z.object({ rows: z.number() }))
  .runner(warehouse)
  .effect('unrepeatable')
  .run(async (input, ctx) => {
    const result = await ctx.exec(['load', input.file, '--into', `warehouse.${input.source}`]);
    if (result.code !== 0) throw new Error(result.stderr);
    return { rows: Number.parseInt(result.stdout, 10) };
  });

const verify = H.command('verify')
  .input(z.object({ source: z.string(), rows: z.number() }))
  .output(z.object({ driftPercent: z.number(), tolerable: z.boolean() }))
  .runner(warehouse)
  .effect('repeatable')
  .run(async (input, ctx) => {
    const result = await ctx.exec(['verify', `warehouse.${input.source}`, '--expected-rows', String(input.rows)]);
    const driftPercent = Number.parseFloat(result.stdout);
    return { driftPercent, tolerable: driftPercent <= 0.5 };
  });

const summarizer = H.role('anomaly-summarizer').prompt('Summarize data anomalies in plain language for the approver.').recall(taste);
const summarizeAnomalies = H.skill('summarize-anomalies')
  .input(z.object({ source: z.string(), report: z.string(), anomalies: z.array(z.string()) }))
  .output(z.object({ summary: z.string() }))
  .prompt(input => `Source ${input.source}\n\nAnomalies:\n${input.anomalies.join('\n')}\n\nFull report:\n${input.report}`);
const summarizerSeat = H.seat('anomaly-summarizer-seat').role(summarizer).skill(summarizeAnomalies).models(sonnet);

const loadFlow = H.flow('nightly-load')
  .input(nightlyLoad)
  .step('extract', extract, state => state.input, exponentialRetry)
  .step('validate', validate, state => ({ source: state.input.source, file: state.extract.file }))
  .when(state => !state.validate.ok, invalid => invalid
    .halt('validationReview', validationReview, state => ({ source: state.input.source, report: state.validate.report }))
    .when(state => !state.validationReview.proceed, stop => stop.exit('rejected')))
  .step('summary', summarizerSeat, state => ({ source: state.input.source, report: state.validate.report, anomalies: state.validate.anomalies }))
  .halt('approval', loadApproval, state => ({ source: state.input.source, summary: state.summary.summary }))
  .when(state => !state.approval.approve, refused => refused.exit('rejected'))
  .step('load', load, state => ({ source: state.input.source, file: state.extract.file }), exponentialRetry)
  .step('verify', verify, state => ({ source: state.input.source, rows: state.load.rows }))
  .when(state => state.verify.driftPercent === 0, clean => clean.exit('loaded'))
  .when(state => state.verify.tolerable, tolerable => tolerable.exit('loaded-with-warnings'))
  .exit('drifted');

const sourceSystems = ['crm', 'billing', 'inventory', 'support'];

const loads = H.lane('nightly-loads').of(NightlyLoad)
  .from(schedule.cron<NightlyLoadData>({
    name: 'nightly-at-two',
    cron: '0 2 * * *',
    children: at => sourceSystems.map(source => ({
      key: `${source}@${at.toISOString().slice(0, 10)}`,
      data: { source, night: at.toISOString().slice(0, 10) },
    })),
  }))
  .store(sqlite.store<NightlyLoadData>('.harness/nightly-loads.sqlite'))
  .handle(loadFlow, {
    exits: { loaded, 'loaded-with-warnings': loadedWithWarnings, rejected, drifted: failed },
    retry: { retries: 0, backoff: 'none', exhausted: failed },
  });

const approvalExpiresAtNine = H.trigger('approval-expires-at-nine')
  .on(H.time.every('0 9 * * *'))
  .do(loads.move({ halted: loadApproval }, expired));

export const outcomesByState = H.metric('nightly-load-outcomes', H.events.transitions(loads, { terminal: true }))
  .count()
  .by('state', 'kind')
  .window('30d');

const oldestFirst = H.policy.units('oldest-first', choice =>
  [...choice.candidates].sort((a, b) => a.queuedAt.getTime() - b.queuedAt.getTime()));

const approver = claudeCode.client({ name: 'approver' });

export const harness = H.harness('nightly-data')
  .ledger(sqlite.ledger('.harness/ledger.sqlite'))
  .pools(H.pool('api', [apiAccount]).serves(sonnet))
  .lanes(loads)
  .journals(H.journal('taste-journal').of(taste).store(jsonl.memory('.harness/taste.jsonl')).recall(policies.specificity({ limit: 8 })))
  .triggers(approvalExpiresAtNine)
  .scheduler(oldestFirst)
  .grants(H.grant(
    approver,
    H.ops.work.read,
    H.ops.resolve(validationReview),
    H.ops.resolve(loadApproval),
    H.ops.memory.write(taste),
    H.ops.telemetry.read,
    H.ops.attempts.manage,
  ))
  .observe(observers.board({ path: 'BOARD.md' }), observers.telemetry({ path: 'TELEMETRY.md' }));

export default harness;
