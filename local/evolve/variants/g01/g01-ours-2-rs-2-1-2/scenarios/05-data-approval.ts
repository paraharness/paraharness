import { z } from 'zod';
import { H } from 'harness-dsl';
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
const rejected = H.state('rejected').terminal('failure');
const expired = H.state('expired').terminal('neutral');
const failed = H.state('failed').terminal('failure');

const loadSchema = z.object({ source: z.string(), night: z.string() });
const nightlyLoad = H.work('NightlyLoad').schema(loadSchema).states(scheduled, loaded, loadedWithWarnings, rejected, expired, failed);

const approverTaste = H.memory('approver-taste').content(z.object({ rule: z.string() })).trust('taste');
const tasteJournal = H.journal('approver-taste').of(approverTaste).store(jsonl.memory('.harness/taste.jsonl')).recall(policies.specificity({ limit: 10 }));

const api = H.account('api', anthropic.api({ apiKey: H.env('ANTHROPIC_API_KEY') })).quota(sqlite.quota('.harness/quota.db'));
const sonnet = H.model('claude-sonnet-4-5').pricing(anthropic.pricing());
const pool = H.pool('anthropic', [api]).share(api, 1).serves(sonnet);

const etl = runners.ssh({ name: 'etl', host: H.env('ETL_HOST'), user: 'etl', identity: H.env('ETL_SSH_KEY'), slots: 2 });
const local = runners.local({ name: 'local', slots: 4 });

const extract = H.command('extract')
  .input(loadSchema)
  .output(z.object({ path: z.string(), rows: z.number() }))
  .runner(etl)
  .effect('repeatable')
  .run(async (input, ctx) => {
    const result = await ctx.exec(['/opt/etl/extract', input.source, input.night]);
    if (result.code !== 0) throw new Error(result.stderr);
    const [path, rows] = result.stdout.trim().split('\t');
    return { path, rows: Number(rows) };
  });

const validate = H.command('validate')
  .input(z.object({ path: z.string() }))
  .output(z.object({ report: z.string(), anomalies: z.array(z.string()) }))
  .runner(etl)
  .effect('repeatable')
  .run(async (input, ctx) => {
    const result = await ctx.exec(['/opt/etl/validate', input.path]);
    if (result.code !== 0) throw new Error(result.stdout);
    return { report: result.stdout, anomalies: result.stderr.split('\n').filter(line => line.length > 0) };
  });

const load = H.command('load')
  .input(z.object({ source: z.string(), path: z.string() }))
  .output(z.object({ rows: z.number() }))
  .runner(etl)
  .effect('repeatable')
  .run(async (input, ctx) => {
    const result = await ctx.exec(['/opt/etl/load', input.source, input.path]);
    if (result.code !== 0) throw new Error(result.stderr);
    return { rows: Number(result.stdout.trim()) };
  });

const verify = H.command('verify')
  .input(loadSchema)
  .output(z.object({ driftPercent: z.number() }))
  .runner(local)
  .effect('repeatable')
  .run(async (input, ctx) => {
    const result = await ctx.exec(['./bin/verify-load', input.source, input.night]);
    const driftPercent = Number(result.stdout.trim());
    if (result.code !== 0 || driftPercent > 1) throw new Error(`drift ${driftPercent}% exceeds tolerance`);
    return { driftPercent };
  });

const summarizeAnomalies = H.skill('summarize-anomalies')
  .input(z.object({ source: z.string(), report: z.string(), anomalies: z.array(z.string()) }))
  .output(z.object({ summary: z.string() }))
  .prompt(i => `Summarise in plain language the anomalies in tonight's ${i.source} extract.\n\n${i.report}\n\n${i.anomalies.join('\n')}`);
const summarizerRole = H.role('summarizer').prompt('You explain data anomalies to the person approving the load.').recall(approverTaste);
const summarizer = H.seat('summarizer').role(summarizerRole).skill(summarizeAnomalies).models(sonnet);

const loadApproval = H.halt('load-approval')
  .context(z.object({ source: z.string(), night: z.string(), summary: z.string(), rows: z.number() }))
  .decision(z.object({ approved: z.boolean(), note: z.string().optional() }))
  .ask(c => `Load ${c.rows} rows from ${c.source} for ${c.night}?\n\n${c.summary}`);

const loadFlow = H.flow('nightly-load')
  .input(loadSchema)
  .step('extract', extract, s => s.input, { retry: { retries: 3, backoff: { initial: '1m', factor: 2, max: '15m' } } })
  .step('validate', validate, s => ({ path: s.extract.path }), { onFailure: 'block' })
  .step('summarize', summarizer, s => ({ source: s.input.source, report: s.validate.report, anomalies: s.validate.anomalies }))
  .halt('approval', loadApproval, s => ({ source: s.input.source, night: s.input.night, summary: s.summarize.summary, rows: s.extract.rows }))
  .when(s => !s.approval.approved, f => f.exit('rejected'))
  .step('load', load, s => ({ source: s.input.source, path: s.extract.path }), { retry: { retries: 3, backoff: { initial: '1m', factor: 2, max: '15m' } } })
  .step('verify', verify, s => s.input)
  .when(s => s.verify.driftPercent > 0, f => f.exit('loadedWithWarnings'))
  .exit('loaded');

const sourceSystems: readonly string[] = ['crm', 'billing', 'inventory', 'payroll'];

const loads = H.lane('nightly-loads').of(nightlyLoad);

const loadLane = loads
  .from(schedule.cron({
    name: 'nightly-0200',
    cron: '0 2 * * *',
    children: at => sourceSystems.map(source => ({ key: `${source}-${at.toISOString().slice(0, 10)}`, data: { source, night: at.toISOString().slice(0, 10) } })),
  }))
  .store(sqlite.store('.harness/loads.db'))
  .handle(loadFlow, {
    exits: { rejected, loadedWithWarnings, loaded },
    retry: { retries: 0, backoff: 'none', exhausted: failed },
  });

const approvalWindowCloses = H.trigger('approval-window-closes-0900')
  .on(H.time.every('0 9 * * *'))
  .do(loads.cancel({ halted: loadApproval }, expired));

const approver = H.grant(
  claudeCode.client({ name: 'approver' }),
  H.ops.work.read,
  H.ops.resolve(loadApproval),
  H.ops.attempts.manage,
  H.ops.memory.write(approverTaste),
  H.ops.telemetry.read,
);

export const dataJob = H.harness('nightly-data')
  .ledger(sqlite.ledger('.harness/ledger.db'))
  .pools(pool)
  .lanes(loadLane)
  .journals(tasteJournal)
  .triggers(approvalWindowCloses)
  .grants(approver)
  .observe(observers.board({ path: 'BOARD.md' }), observers.telemetry({ path: 'TELEMETRY.md' }));

void dataJob.start();
