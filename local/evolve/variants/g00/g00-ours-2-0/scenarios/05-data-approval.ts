import { z } from 'zod';
import { H } from 'harness-dsl';
import { claudeCode } from 'harness-dsl/claude-code';
import { anthropic } from 'harness-dsl/anthropic';
import { sqlite } from 'harness-dsl/sqlite';
import { jsonl } from 'harness-dsl/jsonl';
import { supply } from 'harness-dsl/supply';
import { policies } from 'harness-dsl/policies';
import { observers } from 'harness-dsl/observers';

const loadSchema = z.object({ source: z.string(), night: z.string() });

const scheduled = H.state('scheduled').pending();
const loading = H.state('loading').active();
const loaded = H.state('loaded').terminal('success');
const loadedWithWarnings = H.state('loadedWithWarnings').terminal('success');
const rejected = H.state('rejected').terminal('neutral');
const failed = H.state('failed').terminal('failure');
const expired = H.state('expired').terminal('neutral');

const nightlyLoad = H.work('NightlyLoad').schema(loadSchema).states(scheduled, loading, loaded, loadedWithWarnings, rejected, failed, expired);

const taste = H.memory('approver-taste').content(z.object({ preference: z.string() })).trust('taste');
const tasteJournal = H.journal('approver-taste').of(taste).store(jsonl.store('memory/taste.jsonl')).recall(policies.specificity({ limit: 6 }));

const apiAccount = H.account('data-api', anthropic.api({ apiKey: H.env('ANTHROPIC_API_KEY') }));
const haiku = H.model('claude-haiku-4-5').pricing(anthropic.pricing());
const pool = H.pool('data', [apiAccount]).serves(haiku);

const summarizerRole = H.role('anomaly-summarizer').promptFile('prompts/summarizer.md').intents(['read']).recall(taste);
const summarizer = H.agent('anomaly-summarizer').role(summarizerRole).model(haiku);

const summarize = H.skill('summarize-anomalies')
  .input(z.object({ source: z.string(), rows: z.number(), report: z.string() }))
  .output(z.object({ summary: z.string() }))
  .prompt(i => `Summarize in plain language the anomalies in tonight's ${i.source} extract (${i.rows} rows):\n${i.report}`);

const warehouse = H.runner.ssh('warehouse', { host: H.env('WAREHOUSE_HOST'), user: 'etl', key: H.env('WAREHOUSE_SSH_KEY'), slots: 2 });
const local = H.runner.local('local', { slots: 4 });

const extract = H.command('extract')
  .input(loadSchema)
  .output(z.object({ path: z.string(), rows: z.number() }))
  .runner(warehouse)
  .effect('repeatable')
  .run(async (input, ctx) => {
    const path = `/data/staging/${input.source}-${input.night}.parquet`;
    const result = await ctx.sh(`./extract.sh ${input.source} ${path}`);
    if (result.code !== 0) throw new Error(result.stderr);
    return { path, rows: Number.parseInt(result.stdout.trim(), 10) };
  });

const validate = H.command('validate')
  .input(z.object({ source: z.string(), path: z.string() }))
  .output(z.object({ passed: z.boolean(), report: z.string() }))
  .runner(local)
  .effect('repeatable')
  .run(async (input, ctx) => {
    const result = await ctx.sh(`./validate.sh ${input.source} ${input.path}`);
    return { passed: result.code === 0, report: result.stdout };
  });

const load = H.command('load')
  .input(z.object({ source: z.string(), path: z.string() }))
  .output(z.object({ rows: z.number() }))
  .runner(warehouse)
  .effect('repeatable')
  .run(async (input, ctx) => {
    const result = await ctx.sh(`./load.sh ${input.source} ${input.path}`);
    if (result.code !== 0) throw new Error(result.stderr);
    return { rows: Number.parseInt(result.stdout.trim(), 10) };
  });

const verify = H.command('verify')
  .input(z.object({ source: z.string(), rows: z.number() }))
  .output(z.object({ driftPercent: z.number() }))
  .runner(local)
  .effect('repeatable')
  .run(async (input, ctx) => {
    const result = await ctx.sh(`./verify.sh ${input.source} ${input.rows}`);
    if (result.code !== 0) throw new Error(result.stderr);
    return { driftPercent: Number.parseFloat(result.stdout.trim()) };
  });

const validationReview = H.halt('validation-review')
  .context(z.object({ source: z.string(), report: z.string() }))
  .ask(c => `Validation failed for ${c.source}:\n${c.report}\nProceed anyway?`)
  .decision(z.object({ proceed: z.boolean(), note: z.string().optional() }));

const loadApproval = H.halt('load-approval')
  .context(z.object({ source: z.string(), summary: z.string() }))
  .ask(c => `Approve tonight's ${c.source} load?\n\n${c.summary}`)
  .decision(z.object({ approve: z.boolean(), note: z.string().optional() }));

const tolerableDriftPercent = 0.5;

const nightly = H.flow('nightly-load')
  .input(loadSchema)
  .step('extract', extract, { retry: { tries: 3, backoff: 'exponential', delaySeconds: 60 } })
  .step('validate', validate, s => ({ source: s.input.source, path: s.steps.extract.path }))
  .when(s => !s.steps.validate.passed, invalid => invalid
    .halt('validationReview', validationReview, s => ({ source: s.input.source, report: s.steps.validate.report })))
  .when(s => s.steps.validationReview?.proceed === false, stop => stop.exit('rejected'))
  .step('summarize', summarizer.call(summarize), s => ({
    source: s.input.source,
    rows: s.steps.extract.rows,
    report: s.steps.validate.report,
  }))
  .halt('approval', loadApproval, s => ({ source: s.input.source, summary: s.steps.summarize.summary }))
  .when(s => !s.steps.approval.approve, stop => stop.exit('rejected'))
  .step('load', load, s => ({ source: s.input.source, path: s.steps.extract.path }), {
    retry: { tries: 3, backoff: 'exponential', delaySeconds: 60 },
  })
  .step('verify', verify, s => ({ source: s.input.source, rows: s.steps.load.rows }))
  .exit(s => s.steps.verify.driftPercent === 0
    ? 'loaded'
    : s.steps.verify.driftPercent <= tolerableDriftPercent ? 'loadedWithWarnings' : 'driftExceeded');

const sourceSystems = ['crm', 'billing', 'inventory', 'support'];

const loads = H.lane('nightly-loads')
  .of(nightlyLoad)
  .from(supply.schedule({
    cron: '0 2 * * *',
    units: now => sourceSystems.map(source => ({ source, night: now.toISOString().slice(0, 10) })),
  }).key(data => `${data.source}-${data.night}`))
  .store(sqlite.store('.harness/loads.db'))
  .handle(nightly)
  .exits({ rejected, loaded, loadedWithWarnings, driftExceeded: failed })
  .retry({ tries: 1, backoff: 'none', exhausted: failed });

const nineAfter = (openedAt: Date) => {
  const deadline = new Date(openedAt);
  deadline.setHours(9, 0, 0, 0);
  if (deadline.getTime() <= openedAt.getTime()) deadline.setDate(deadline.getDate() + 1);
  return deadline;
};

const unapprovedLoadsExpireAtNine = H.trigger('unapproved-loads-expire-at-nine')
  .on(loadApproval.opened().at(nineAfter))
  .do(loads.move(expired));

const approver = H.grant(
  claudeCode.client('approver', { session: 'data' }),
  H.ops.work.read,
  H.ops.resolve(validationReview),
  H.ops.resolve(loadApproval),
  H.ops.memory.write(tasteJournal),
  H.ops.telemetry.read,
);

export default H.harness('nightly-data')
  .ledger(sqlite.ledger('.harness/ledger.db'))
  .pools(pool)
  .lanes(loads)
  .journals(tasteJournal)
  .triggers(unapprovedLoadsExpireAtNine)
  .grants(approver)
  .observe(observers.board({ path: 'BOARD.md' }), observers.telemetry({ path: 'TELEMETRY.md' }));
