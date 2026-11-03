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

const scheduled = H.state('scheduled').pending();
const loaded = H.state('loaded').terminal('success');
const loadedWithWarnings = H.state('loaded-with-warnings').terminal('success');
const rejected = H.state('rejected').terminal('neutral');
const expired = H.state('expired').terminal('neutral');
const failed = H.state('failed').terminal('failure');

const nightlyLoad = z.object({ source: z.string(), night: z.string() });
const NightlyLoad = H.work('NightlyLoad').schema(nightlyLoad).states(scheduled, loaded, loadedWithWarnings, rejected, expired, failed);

const approverTaste = H.memory('approver-taste').content(z.object({ preference: z.string() })).trust('taste');

const sonnet = H.model('claude-sonnet-4-5').pricing(anthropic.pricing());
const apiAccount = H.account('anthropic-api', anthropic.api({ apiKey: H.env('ANTHROPIC_API_KEY') }));
const apiPool = H.pool('anthropic', [apiAccount]).serves(sonnet);

const warehouse = runners.ssh({ name: 'warehouse', host: H.env('WAREHOUSE_HOST'), user: 'etl', identity: H.env('ETL_SSH_KEY'), slots: 2 });
const local = runners.local({ name: 'local', slots: 4 });

const threeWithBackoff: StepOptions = { retry: { retries: 3, backoff: { initial: '30s', factor: 2, max: '10m' } } };

const extract = H.command('extract')
  .input(nightlyLoad)
  .output(z.object({ file: z.string(), rows: z.number() }))
  .runner(warehouse)
  .effect('repeatable')
  .run(async (input, ctx) => {
    const result = await ctx.exec(['/opt/etl/extract', input.source, input.night]);
    if (result.code !== 0) throw new Error(result.stderr);
    const [file, rows] = result.stdout.trim().split(' ');
    return { file: file ?? '', rows: Number.parseInt(rows ?? '0', 10) };
  });

const validate = H.command('validate')
  .input(z.object({ file: z.string() }))
  .output(z.object({ ok: z.boolean(), report: z.string() }))
  .runner(local)
  .effect('repeatable')
  .run(async (input, ctx) => {
    const result = await ctx.exec(['/opt/etl/validate', input.file]);
    return { ok: result.code === 0, report: result.stdout };
  });

const load = H.command('load')
  .input(z.object({ source: z.string(), file: z.string() }))
  .output(z.object({ loadedRows: z.number() }))
  .runner(warehouse)
  .effect('repeatable')
  .run(async (input, ctx) => {
    const result = await ctx.exec(['/opt/etl/load-transactional', input.source, input.file]);
    if (result.code !== 0) throw new Error(result.stderr);
    return { loadedRows: Number.parseInt(result.stdout.trim(), 10) };
  });

const verify = H.command('verify')
  .input(nightlyLoad)
  .output(z.object({ driftPercent: z.number() }))
  .runner(warehouse)
  .effect('repeatable')
  .run(async (input, ctx) => {
    const result = await ctx.exec(['/opt/etl/verify', input.source, input.night]);
    if (result.code !== 0) throw new Error(result.stderr);
    return { driftPercent: Number.parseFloat(result.stdout.trim()) };
  });

const summarizerRole = H.role('anomaly-summarizer')
  .prompt('Summarise the anomalies in plain language for the approver.')
  .intents([])
  .recall(approverTaste);
const summarizeSkill = H.skill('summarize-anomalies')
  .input(z.object({ source: z.string(), rows: z.number(), report: z.string() }))
  .output(z.object({ summary: z.string() }))
  .prompt(input => `Source ${input.source}, ${input.rows} rows.\n\nValidation report:\n${input.report}`);
const summarizer = H.seat('anomaly-summarizer').role(summarizerRole).skill(summarizeSkill).models(sonnet);

const validationReview = H.halt('validation-review')
  .context(z.object({ source: z.string(), report: z.string() }))
  .decision(z.object({ proceed: z.boolean() }))
  .ask(context => `Validation failed for ${context.source}. Proceed anyway?\n\n${context.report}`);
const loadApproval = H.halt('load-approval')
  .context(z.object({ source: z.string(), summary: z.string() }))
  .decision(z.object({ approve: z.boolean() }))
  .ask(context => `Approve tonight's load of ${context.source}?\n\n${context.summary}`);

const maxTolerableDriftPercent = 2;

const nightly = H.flow('nightly-load')
  .input(nightlyLoad)
  .step('extract', extract, state => ({ source: state.input.source, night: state.input.night }), threeWithBackoff)
  .step('validate', validate, state => ({ file: state.extract.file }))
  .when(state => !state.validate.ok, invalid => invalid
    .halt('validationReview', validationReview, state => ({ source: state.input.source, report: state.validate.report }))
    .when(state => !state.validationReview.proceed, stop => stop.exit('rejected')))
  .step('summary', summarizer, state => ({ source: state.input.source, rows: state.extract.rows, report: state.validate.report }))
  .halt('approval', loadApproval, state => ({ source: state.input.source, summary: state.summary.summary }))
  .when(state => !state.approval.approve, refused => refused.exit('rejected'))
  .step('load', load, state => ({ source: state.input.source, file: state.extract.file }), threeWithBackoff)
  .step('verify', verify, state => ({ source: state.input.source, night: state.input.night }))
  .when(state => state.verify.driftPercent > maxTolerableDriftPercent, drifted => drifted.exit('failed'))
  .when(state => state.verify.driftPercent > 0, tolerable => tolerable.exit('loadedWithWarnings'))
  .exit('loaded');

const sources = ['crm', 'billing', 'inventory', 'support'];

const loads = H.lane('nightly-loads').of(NightlyLoad)
  .from(schedule.cron({
    name: 'nightly-at-two',
    cron: '0 2 * * *',
    children: at => sources.map(source => ({
      key: `${source}-${at.toISOString().slice(0, 10)}`,
      data: { source, night: at.toISOString().slice(0, 10) },
    })),
  }))
  .store(sqlite.store('.harness/nightly-loads.db'))
  .handle(nightly, {
    exits: { loaded, loadedWithWarnings, rejected, failed },
    retry: { retries: 0, exhausted: failed },
  });

const approvalWindowCloses = H.trigger('approval-window-closes-at-nine')
  .on(H.time.every('0 9 * * *'))
  .do(loads.move({ halted: loadApproval }, expired));

const loadOutcomes = H.metric('load-outcomes', H.events.transitions(loads, { terminal: true }))
  .count()
  .by('state')
  .window('30d');

const tasteJournal = H.journal('approver-taste').of(approverTaste)
  .store(jsonl.memory('.harness/approver-taste.jsonl'))
  .recall(policies.specificity({ limit: 8 }));

const oldestFirst = H.policy.units('oldest-first', choice =>
  [...choice.candidates].sort((a, b) => a.queuedAt.getTime() - b.queuedAt.getTime()));

const approver = claudeCode.client({ name: 'approver' });

export const dataJob = H.harness('nightly-data')
  .ledger(sqlite.ledger('.harness/ledger.db'))
  .pools(apiPool)
  .lanes(loads)
  .journals(tasteJournal)
  .triggers(approvalWindowCloses)
  .scheduler(oldestFirst)
  .grants(H.grant(
    approver,
    H.ops.work.read,
    H.ops.resolve(loadApproval),
    H.ops.resolve(validationReview),
    H.ops.attempts.manage,
    H.ops.memory.write(approverTaste),
    H.ops.telemetry.read,
  ))
  .observe(observers.board({ path: 'BOARD.md' }), observers.telemetry({ path: 'TELEMETRY.md' }));

void dataJob.start();

export const outcomesByState = loadOutcomes;
