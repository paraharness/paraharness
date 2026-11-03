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
const rejected = H.state('rejected').terminal('neutral');
const expired = H.state('expired').terminal('neutral');
const failed = H.state('failed').terminal('failure');

const loadSchema = z.object({ source: z.string(), night: z.string() });
type NightlyLoadData = z.infer<typeof loadSchema>;

const nightlyLoad = H.work('nightly-load').schema(loadSchema).states(scheduled, loaded, loadedWithWarnings, rejected, expired, failed);

const approverTaste = H.memory('approver-taste').content(z.object({ rule: z.string() })).trust('taste');
const approverTasteLog = H.journal('approver-taste')
  .of(approverTaste)
  .store(jsonl.memory('memory/approver-taste.jsonl'))
  .recall(policies.specificity({ limit: 10 }));

const quotaEvents = sqlite.quota('.harness/quota.sqlite');
const apiAccount = H.account('api', anthropic.api({ apiKey: H.env('ANTHROPIC_API_KEY') })).quota(quotaEvents);
const sonnet = H.model('claude-sonnet-4-5').pricing(anthropic.pricing());
const apiPool = H.pool('data-api', [apiAccount]).serves(sonnet).policy(policies.soonestReset());

const warehouse = runners.ssh({ name: 'warehouse', host: H.env('WAREHOUSE_HOST'), user: 'etl', identity: H.env('ETL_SSH_KEY'), slots: 4 });
const local = runners.local({ name: 'local', slots: 4 });

const extract = H.command('extract')
  .input(loadSchema)
  .output(z.object({ path: z.string(), rows: z.number() }))
  .runner(warehouse)
  .effect('repeatable')
  .run(async (input, ctx) => {
    const path = `/staging/${input.source}/${input.night}.parquet`;
    const result = await ctx.exec(['./bin/extract', input.source, path]);
    if (result.code !== 0) throw new Error(result.stderr);
    return { path, rows: Number(result.stdout.trim()) };
  });

const validate = H.command('validate')
  .input(z.object({ path: z.string() }))
  .output(z.object({ ok: z.boolean(), report: z.string() }))
  .runner(local)
  .effect('repeatable')
  .run(async (input, ctx) => {
    const result = await ctx.exec(['./bin/validate', input.path]);
    return { ok: result.code === 0, report: result.stdout };
  });

const load = H.command('load')
  .input(z.object({ source: z.string(), path: z.string() }))
  .output(z.object({ rows: z.number() }))
  .runner(warehouse)
  .effect('repeatable')
  .run(async (input, ctx) => {
    const result = await ctx.exec(['./bin/load', input.source, input.path]);
    if (result.code !== 0) throw new Error(result.stderr);
    return { rows: Number(result.stdout.trim()) };
  });

const verify = H.command('verify')
  .input(z.object({ source: z.string(), expectedRows: z.number() }))
  .output(z.object({ driftRows: z.number() }))
  .runner(warehouse)
  .effect('repeatable')
  .run(async (input, ctx) => {
    const result = await ctx.exec(['./bin/count-rows', input.source]);
    if (result.code !== 0) throw new Error(result.stderr);
    const driftRows = Math.abs(Number(result.stdout.trim()) - input.expectedRows);
    if (driftRows > input.expectedRows * 0.01) throw new Error(`Intolerable drift of ${driftRows} rows`);
    return { driftRows };
  });

const summarizerRole = H.role('anomaly-summarizer').promptFile('prompts/summarizer.md').recall(approverTaste);
const summarizeSkill = H.skill('summarize-anomalies')
  .input(z.object({ source: z.string(), report: z.string(), rows: z.number() }))
  .output(z.object({ summary: z.string() }))
  .prompt(i => `Source ${i.source}, ${i.rows} rows.\n\nValidation report:\n${i.report}`);
const summarizer = H.seat('anomaly-summarizer').role(summarizerRole).skill(summarizeSkill).models(sonnet);

const validationReview = H.halt('validation-review')
  .context(z.object({ source: z.string(), report: z.string() }))
  .decision(z.object({ proceed: z.boolean() }))
  .ask(c => `Validation failed for ${c.source}. Proceed anyway?\n\n${c.report}`);

const loadApproval = H.halt('load-approval')
  .context(z.object({ source: z.string(), night: z.string(), summary: z.string() }))
  .decision(z.object({ approved: z.boolean(), note: z.string() }))
  .ask(c => `Approve the ${c.night} load of ${c.source}?\n\n${c.summary}`);

const stepRetry = { retries: 3, backoff: { initial: '1m', factor: 2, max: '15m' } } as const;

const nightlyFlow = H.flow('nightly-load')
  .input(loadSchema)
  .step('extract', extract, s => s.input, { retry: stepRetry })
  .step('validate', validate, s => ({ path: s.extract.path }))
  .when(
    s => !s.validate.ok,
    f =>
      f
        .halt('review', validationReview, s => ({ source: s.input.source, report: s.validate.report }))
        .when(s => !s.review.proceed, g => g.exit('rejected')),
  )
  .step('summarize', summarizer, s => ({ source: s.input.source, report: s.validate.report, rows: s.extract.rows }))
  .halt('approval', loadApproval, s => ({ source: s.input.source, night: s.input.night, summary: s.summarize.summary }))
  .when(s => !s.approval.approved, f => f.exit('rejected'))
  .step('load', load, s => ({ source: s.input.source, path: s.extract.path }), { retry: stepRetry })
  .step('verify', verify, s => ({ source: s.input.source, expectedRows: s.load.rows }))
  .when(s => s.verify.driftRows > 0, f => f.exit('warnings'))
  .exit('loaded');

const sourceSystems = ['crm', 'billing', 'inventory', 'support'];

const loads = H.lane('nightly-loads')
  .of(nightlyLoad)
  .from(
    schedule.cron<NightlyLoadData>({
      name: 'nightly-at-two',
      cron: '0 2 * * *',
      children: at => {
        const night = at.toISOString().slice(0, 10);
        return sourceSystems.map(source => ({ key: `${source}-${night}`, data: { source, night } }));
      },
    }),
  )
  .store(sqlite.store<NightlyLoadData>('.harness/loads.sqlite'))
  .handle(nightlyFlow, {
    exits: { loaded, warnings: loadedWithWarnings, rejected },
    retry: { retries: 0, backoff: 'none', exhausted: failed },
  });

const approvalDeadline = H.trigger('approval-expires-at-nine')
  .on(H.time.every('0 9 * * *'))
  .do(loads.move({ halted: loadApproval }, expired));

const loadOutcomes = H.metric('load-outcomes', H.events.transitions(loads, { terminal: true })).count().by('state').window('30d');

const oldestFirst = H.policy.units('oldest-first', choice =>
  [...choice.candidates].sort((a, b) => a.queuedAt.getTime() - b.queuedAt.getTime() || choice.metrics.read(loadOutcomes).samples * 0),
);

const supervisor = claudeCode.client({ name: 'approver' });

export const dataApproval = H.harness('data-approval')
  .ledger(sqlite.ledger('.harness/ledger.sqlite'))
  .pools(apiPool)
  .lanes(loads)
  .journals(approverTasteLog)
  .triggers(approvalDeadline)
  .scheduler(oldestFirst)
  .grants(
    H.grant(
      supervisor,
      H.ops.work.read,
      H.ops.resolve(validationReview),
      H.ops.resolve(loadApproval),
      H.ops.memory.write(approverTaste),
      H.ops.telemetry.read,
    ),
  )
  .observe(observers.board({ path: 'BOARD.md' }), observers.telemetry({ path: 'TELEMETRY.md' }));
