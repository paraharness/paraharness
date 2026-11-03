import { z } from 'zod';
import { H } from 'harness-dsl';
import { claudeCode } from 'harness-dsl/claude-code';
import { anthropic } from 'harness-dsl/anthropic';
import { sqlite } from 'harness-dsl/sqlite';
import { jsonl } from 'harness-dsl/jsonl';
import { supply } from 'harness-dsl/supply';
import { policies } from 'harness-dsl/policies';
import { observers } from 'harness-dsl/observers';

const loadSchema = z.object({ source: z.enum(['crm', 'billing', 'inventory', 'support']), night: z.string() });
const extractResult = z.object({ rows: z.number(), path: z.string() });

const scheduled = H.state('scheduled').pending();
const loading = H.state('loading').active();
const loaded = H.state('loaded').terminal('success');
const loadedWithWarnings = H.state('loadedWithWarnings').terminal('success');
const rejected = H.state('rejected').terminal('neutral');
const expired = H.state('expired').terminal('neutral');
const failedLoad = H.state('failedLoad').terminal('failure');

const nightlyLoad = H.work('NightlyLoad').schema(loadSchema).states(scheduled, loading, loaded, loadedWithWarnings, rejected, expired, failedLoad);

const approverTaste = H.memory('approverTaste').content(z.object({ prefer: z.string() })).trust('taste');
const tasteJournal = H.journal('approverTaste').of(approverTaste).store(jsonl.store('memory/approver.jsonl')).recall(policies.specificity({ limit: 10 }));

const etl = H.runner.ssh('etl', { host: H.env('ETL_HOST'), user: 'etl', key: H.env('ETL_SSH_KEY'), slots: 2 });
const local = H.runner.local('local', { slots: 2 });

const extract = H.command('extract')
  .input(loadSchema)
  .output(extractResult)
  .runner(etl)
  .effect('repeatable')
  .run(async (input, ctx) => {
    const result = await ctx.sh(`etl extract --source ${input.source} --night ${input.night} --json`);
    if (result.code !== 0) throw new Error(result.stderr);
    return extractResult.parse(JSON.parse(result.stdout));
  });

const validate = H.command('validate')
  .input(z.object({ path: z.string() }))
  .output(z.object({ ok: z.boolean(), report: z.string() }))
  .runner(etl)
  .effect('repeatable')
  .run(async (input, ctx) => {
    const result = await ctx.sh(`etl validate ${input.path}`);
    return { ok: result.code === 0, report: result.stdout };
  });

const load = H.command('load')
  .input(z.object({ source: z.string(), night: z.string(), path: z.string() }))
  .output(z.object({ loadId: z.string() }))
  .runner(etl)
  .effect('unrepeatable')
  .detect(async (input, ctx) => {
    const result = await ctx.sh(`etl load-status --source ${input.source} --night ${input.night}`);
    return result.code === 0 && result.stdout.trim() !== '' ? { loadId: result.stdout.trim() } : undefined;
  })
  .run(async (input, ctx) => {
    const result = await ctx.sh(`etl load --source ${input.source} --night ${input.night} ${input.path}`);
    if (result.code !== 0) throw new Error(result.stderr);
    return { loadId: result.stdout.trim() };
  });

const verify = H.command('verify')
  .input(z.object({ loadId: z.string() }))
  .output(z.object({ driftPercent: z.number() }))
  .runner(local)
  .effect('repeatable')
  .run(async (input, ctx) => {
    const result = await ctx.sh(`etl verify ${input.loadId}`);
    const driftPercent = Number.parseFloat(result.stdout.trim());
    if (driftPercent > 1) throw new Error(`drift ${driftPercent}% beyond tolerance`);
    return { driftPercent };
  });

const sonnet = H.model('claude-sonnet-4-5').pricing(anthropic.pricing());
const apiAccount = H.account('anthropic-api', anthropic.api({ apiKey: H.env('ANTHROPIC_API_KEY') })).quota(sqlite.quota('.harness/quota.db'));
const apiPool = H.pool('api', [apiAccount]).serves(sonnet);

const summarizerRole = H.role('anomalySummarizer').prompt('Summarize data anomalies in plain language for the approver.').recall(approverTaste);
const summarizer = H.seat('anomalySummarizer').role(summarizerRole).models(sonnet);

const summarizeSkill = H.skill('summarizeAnomalies')
  .input(z.object({ source: z.string(), rows: z.number(), report: z.string() }))
  .output(z.object({ summary: z.string() }))
  .prompt(i => `Source ${i.source}, ${i.rows} rows.\n\nValidation report:\n${i.report}`);

const validationReview = H.halt('validationReview')
  .context(z.object({ source: z.string(), report: z.string() }))
  .ask(c => `Validation failed for ${c.source}:\n\n${c.report}\n\nProceed anyway?`)
  .decision(z.object({ proceed: z.boolean() }));

const approveLoad = H.halt('approveLoad')
  .context(z.object({ source: z.string(), night: z.string(), summary: z.string() }))
  .ask(c => `Approve the ${c.night} load of ${c.source}?\n\n${c.summary}`)
  .decision(z.object({ approved: z.boolean(), note: z.string().optional() }));

const stepRetry = { retry: { tries: 3, backoff: 'exponential', delaySeconds: 60 } } as const;

const nightly = H.flow('nightlyLoad')
  .input(loadSchema)
  .step('extract', extract, stepRetry)
  .step('validate', validate, s => ({ path: s.steps.extract.path }))
  .when(
    s => !s.steps.validate.ok,
    invalid => invalid
      .halt('validationReview', validationReview, s => ({ source: s.input.source, report: s.steps.validate.report }))
      .when(s => !s.steps.validationReview.proceed, stop => stop.exit('rejected')),
  )
  .step('summarize', summarizer.call(summarizeSkill), s => ({ source: s.input.source, rows: s.steps.extract.rows, report: s.steps.validate.report }))
  .halt('approval', approveLoad, s => ({ source: s.input.source, night: s.input.night, summary: s.steps.summarize.summary }))
  .when(s => !s.steps.approval.approved, stop => stop.exit('rejected'))
  .step('load', load, s => ({ source: s.input.source, night: s.input.night, path: s.steps.extract.path }), stepRetry)
  .step('verify', verify, s => ({ loadId: s.steps.load.loadId }))
  .exit(s => (s.steps.verify.driftPercent === 0 ? 'loaded' : 'loadedWithWarnings'));

const sources = ['crm', 'billing', 'inventory', 'support'] as const;

const loads = H.lane('nightlyLoads')
  .of(nightlyLoad)
  .from(supply.schedule({
    cron: '0 2 * * *',
    units: now => sources.map(source => ({ source, night: now.toISOString().slice(0, 10) })),
  }).key(d => `${d.source}:${d.night}`))
  .store(sqlite.store('.harness/store.db'))
  .handle(nightly)
  .exits({ rejected, loaded, loadedWithWarnings, failed: { tries: 1, backoff: 'none', then: failedLoad } });

const expiresAtNine = H.trigger('approvalExpiresAtNine')
  .on(approveLoad.opened().at(openedAt => new Date(openedAt.getFullYear(), openedAt.getMonth(), openedAt.getDate(), 9, 0, 0)))
  .do(loads.move(expired));

const warningShare = H.metric('loadedWithWarningsShare').rate(H.events.entered(loadedWithWarnings), H.events.terminal({ verdict: 'success' }));
const approvalWait = H.metric('approvalWaitMedian').median(H.events.decisions(approveLoad), 'waitSeconds');

const approver = claudeCode.client('approver');

export const harness = H.harness('nightly-data')
  .ledger(sqlite.ledger('.harness/ledger.db'))
  .pools(apiPool)
  .lanes(loads)
  .journals(tasteJournal)
  .triggers(expiresAtNine)
  .grants(H.grant(
    approver,
    H.ops.work.read,
    H.ops.resolve(validationReview),
    H.ops.resolve(approveLoad),
    H.ops.memory.write(tasteJournal),
    H.ops.telemetry.read,
  ))
  .metrics(warningShare, approvalWait)
  .observe(observers.board({ path: 'BOARD.md' }), observers.telemetry({ path: 'TELEMETRY.md' }));

export const running = harness.start();
