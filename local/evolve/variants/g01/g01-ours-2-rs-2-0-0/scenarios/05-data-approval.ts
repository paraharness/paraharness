import { z } from 'zod';
import { H } from 'harness-dsl';
import { claudeCode } from 'harness-dsl/claude-code';
import { anthropic } from 'harness-dsl/anthropic';
import { sqlite } from 'harness-dsl/sqlite';
import { jsonl } from 'harness-dsl/jsonl';
import { supply } from 'harness-dsl/supply';
import { policies } from 'harness-dsl/policies';
import { observers } from 'harness-dsl/observers';

const scheduled = H.state('scheduled').pending();
const loading = H.state('loading').active();
const loaded = H.state('loaded').terminal('success');
const loadedWithWarnings = H.state('loaded-with-warnings').terminal('success');
const rejected = H.state('rejected').terminal('failure');
const failed = H.state('failed').terminal('failure');
const expired = H.state('expired').terminal('neutral');

const loadSchema = z.object({ source: z.string(), night: z.string() });
const nightlyLoad = H.work('nightly-load')
  .schema(loadSchema)
  .states(scheduled, loading, loaded, loadedWithWarnings, rejected, failed, expired);

const approverTaste = H.memory('approver-taste')
  .content(z.object({ prefer: z.string(), because: z.string() }))
  .trust('taste');
const tasteJournal = H.journal('approver-taste-journal')
  .of(approverTaste)
  .store(jsonl.store('memory/approver-taste.jsonl'))
  .recall(policies.specificity({ limit: 6 }));

const haiku = H.model('claude-haiku-4-5').pricing(anthropic.pricing());
const apiAccount = H.account('api', anthropic.api({ apiKey: H.env('ANTHROPIC_API_KEY') }));
const pool = H.pool('api', [apiAccount]).serves(haiku).policy(policies.soonestExpiring());

const summarizerRole = H.role('anomaly-summarizer').promptFile('prompts/summarizer.md').intents(['read']).recall(approverTaste);
const summarizer = H.seat('anomaly-summarizer').role(summarizerRole).models(haiku);

const summarize = H.skill('summarize-anomalies')
  .input(z.object({ source: z.string(), anomalies: z.array(z.string()), report: z.string() }))
  .output(z.object({ summary: z.string() }))
  .prompt(input => `Summarise the anomalies in tonight's ${input.source} load in plain language.\n\n${input.anomalies.join('\n')}\n\n${input.report}`);

const etlHost = H.runner.ssh('etl-host', { host: H.env('ETL_HOST'), user: 'etl', key: H.env('ETL_SSH_KEY'), slots: 4 });

const extract = H.command('extract')
  .input(loadSchema)
  .output(z.object({ stagedPath: z.string(), rows: z.number() }))
  .runner(etlHost)
  .effect('repeatable')
  .run(async (input, ctx) => {
    const stagedPath = `/staging/${input.source}/${input.night}`;
    const result = await ctx.sh(`etl extract --source ${input.source} --out ${stagedPath}`);
    if (result.code === 0) return { stagedPath, rows: Number.parseInt(result.stdout.trim(), 10) };
    throw new Error(result.stderr);
  });

const validate = H.command('validate')
  .input(z.object({ stagedPath: z.string() }))
  .output(z.object({ valid: z.boolean(), anomalies: z.array(z.string()), report: z.string() }))
  .runner(etlHost)
  .run(async (input, ctx) => {
    const result = await ctx.sh(`etl validate ${input.stagedPath}`);
    const anomalies = result.stdout.split('\n').filter(line => line.startsWith('ANOMALY'));
    return { valid: result.code === 0, anomalies, report: result.stdout };
  });

const load = H.command('load')
  .input(z.object({ stagedPath: z.string(), source: z.string() }))
  .output(z.object({ rowsLoaded: z.number() }))
  .runner(etlHost)
  .effect('repeatable')
  .run(async (input, ctx) => {
    const result = await ctx.sh(`etl load --source ${input.source} --in ${input.stagedPath} --idempotent`);
    if (result.code === 0) return { rowsLoaded: Number.parseInt(result.stdout.trim(), 10) };
    throw new Error(result.stderr);
  });

const verify = H.command('verify')
  .input(z.object({ source: z.string(), expectedRows: z.number() }))
  .output(z.object({ driftRows: z.number() }))
  .runner(etlHost)
  .run(async (input, ctx) => {
    const result = await ctx.sh(`etl count --source ${input.source}`);
    const driftRows = Math.abs(Number.parseInt(result.stdout.trim(), 10) - input.expectedRows);
    if (driftRows > input.expectedRows * 0.01) throw new Error(`drift of ${driftRows} rows is beyond tolerance`);
    return { driftRows };
  });

const validationReview = H.halt('validation-review')
  .context(z.object({ source: z.string(), report: z.string() }))
  .ask(context => `Validation failed for ${context.source}. Proceed anyway?\n\n${context.report}`)
  .decision(z.object({ proceed: z.boolean() }));

const loadApproval = H.halt('load-approval')
  .context(z.object({ source: z.string(), night: z.string(), summary: z.string() }))
  .ask(context => `Approve the ${context.source} load for ${context.night}?\n\n${context.summary}`)
  .decision(z.object({ approved: z.boolean(), note: z.string().optional() }));

const stepRetry = { tries: 3, backoff: 'exponential', delaySeconds: 30 } as const;

const nightly = H.flow('nightly-load')
  .input(loadSchema)
  .step('extract', extract, { retry: stepRetry })
  .step('validate', validate, s => ({ stagedPath: s.steps.extract.stagedPath }))
  .when(s => s.steps.validate.valid === false, f => f
    .halt('reviewValidation', validationReview, s => ({ source: s.input.source, report: s.steps.validate.report }))
    .when(s => s.steps.reviewValidation.proceed === false, g => g.exit('rejected')))
  .step('summarize', summarizer.call(summarize), s => ({
    source: s.input.source,
    anomalies: s.steps.validate.anomalies,
    report: s.steps.validate.report,
  }))
  .halt('approve', loadApproval, s => ({ source: s.input.source, night: s.input.night, summary: s.steps.summarize.summary }))
  .when(s => s.steps.approve.approved === false, f => f.exit('rejected'))
  .step('load', load, s => ({ stagedPath: s.steps.extract.stagedPath, source: s.input.source }), { retry: stepRetry })
  .step('verify', verify, s => ({ source: s.input.source, expectedRows: s.steps.load.rowsLoaded }))
  .exit(s => (s.steps.verify.driftRows > 0 ? 'loadedWithWarnings' : 'loaded'));

const runNightlyLoad = H.handler('run-nightly-load')
  .of(nightlyLoad)
  .flow(nightly)
  .exits({ loaded, loadedWithWarnings, rejected })
  .retry({ tries: 0, backoff: 'none', exhausted: failed });

const sourceSystems = ['crm', 'billing', 'inventory', 'web-analytics'];

const loads = H.lane('nightly-loads', runNightlyLoad)
  .from(supply.schedule({
    cron: '0 2 * * *',
    units: now => sourceSystems.map(source => ({ source, night: now.toISOString().slice(0, 10) })),
  }).key(data => `${data.source}:${data.night}`))
  .store(sqlite.store('.harness/loads.db'));

const nineAfter = (openedAt: Date): Date => {
  const deadline = new Date(openedAt);
  deadline.setHours(9, 0, 0, 0);
  if (deadline.getTime() <= openedAt.getTime()) deadline.setDate(deadline.getDate() + 1);
  return deadline;
};

const approvalExpires = H.trigger('unapproved-load-expires-at-nine')
  .on(loadApproval.opened().at(nineAfter))
  .do(loads.move(expired));

const loadedClean = H.metric('loaded-clean').count(H.events.entered(loaded));
const loadedWarned = H.metric('loaded-with-warnings').count(H.events.entered(loadedWithWarnings));
const loadSuccess = H.metric('load-success-rate').rate(H.events.terminal({ verdict: 'success' }), H.events.terminal());

const approver = claudeCode.client('approver');
const approverGrant = H.grant(
  approver,
  H.ops.work.read,
  H.ops.resolve(validationReview),
  H.ops.resolve(loadApproval),
  H.ops.memory.write(tasteJournal),
  H.ops.telemetry.read,
);

export const harness = H.harness('nightly-data')
  .ledger(sqlite.ledger('.harness/ledger.db'))
  .pools(pool)
  .lanes(loads)
  .journals(tasteJournal)
  .triggers(approvalExpires)
  .grants(approverGrant)
  .metrics(loadedClean, loadedWarned, loadSuccess)
  .observe(observers.board({ path: 'BOARD.md' }), observers.telemetry({ path: 'TELEMETRY.md' }));

void harness.start();
