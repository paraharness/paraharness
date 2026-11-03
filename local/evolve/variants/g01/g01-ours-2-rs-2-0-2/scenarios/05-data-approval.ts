import { z } from 'zod';
import { H } from 'harness-dsl';
import type { Retry } from 'harness-dsl/kernel';
import { claudeCode } from 'harness-dsl/claude-code';
import { anthropic } from 'harness-dsl/anthropic';
import { sqlite } from 'harness-dsl/sqlite';
import { jsonl } from 'harness-dsl/jsonl';
import { supply } from 'harness-dsl/supply';
import { policies } from 'harness-dsl/policies';
import { observers } from 'harness-dsl/observers';

const queued = H.state('queued').pending();
const loading = H.state('loading').active();
const loaded = H.state('loaded').terminal('success');
const loadedWithWarnings = H.state('loadedWithWarnings').terminal('success');
const rejected = H.state('rejected').terminal('neutral');
const failed = H.state('failed').terminal('failure');
const expired = H.state('expired').terminal('neutral');

const loadSchema = z.object({ source: z.enum(['crm', 'billing', 'inventory', 'support']) });
type LoadData = z.infer<typeof loadSchema>;

const NightlyLoad = H.work('NightlyLoad').schema(loadSchema).states(queued, loading, loaded, loadedWithWarnings, rejected, failed, expired);

const sourceSystems: readonly LoadData[] = [
  { source: 'crm' },
  { source: 'billing' },
  { source: 'inventory' },
  { source: 'support' },
];

const warehouse = H.runner.ssh('warehouse', { host: H.env('WAREHOUSE_HOST'), user: 'etl', key: H.env('WAREHOUSE_SSH_KEY'), slots: 2 });

const threeTimesWithBackoff: Retry = { tries: 3, backoff: 'exponential', delaySeconds: 60 };

const extract = H.command('extract')
  .input(loadSchema)
  .output(z.object({ file: z.string(), rows: z.number() }))
  .runner(warehouse)
  .effect('repeatable')
  .run(async (input, ctx) => {
    const file = `/data/staging/${input.source}-${ctx.now.toISOString().slice(0, 10)}.parquet`;
    const result = await ctx.sh(`etl extract --source ${input.source} --out ${file} --print-rows`, { timeoutSeconds: 3600 });
    if (result.code !== 0) throw new Error(result.stderr);
    return { file, rows: Number(result.stdout.trim()) };
  });

const validate = H.command('validate')
  .input(z.object({ source: z.string(), file: z.string() }))
  .output(z.object({ ok: z.boolean(), report: z.string() }))
  .runner(warehouse)
  .run(async (input, ctx) => {
    const result = await ctx.sh(`etl validate --source ${input.source} --file ${input.file}`);
    return { ok: result.code === 0, report: result.stdout };
  });

const load = H.command('load')
  .input(z.object({ source: z.string(), file: z.string() }))
  .runner(warehouse)
  .effect('repeatable')
  .run(async (input, ctx) => {
    const result = await ctx.sh(`etl load --source ${input.source} --file ${input.file} --replace-partition`, { timeoutSeconds: 3600 });
    if (result.code !== 0) throw new Error(result.stderr);
  });

const verify = H.command('verify')
  .input(loadSchema)
  .output(z.object({ driftPercent: z.number(), tolerable: z.boolean() }))
  .runner(warehouse)
  .run(async (input, ctx) => {
    const result = await ctx.sh(`etl verify --source ${input.source} --print-drift`);
    if (result.code !== 0) throw new Error(result.stderr);
    const driftPercent = Number(result.stdout.trim());
    return { driftPercent, tolerable: driftPercent <= 0.5 };
  });

const approverTaste = H.memory('approverTaste').content(z.object({ preference: z.string() })).trust('taste');
const tasteJournal = H.journal('approverTaste').of(approverTaste).store(jsonl.store('memory/approver-taste.jsonl')).recall(policies.specificity({ limit: 8 }));

const apiAccount = H.account('api', anthropic.api({ apiKey: H.env('ANTHROPIC_API_KEY') }));
const sonnet = H.model('claude-sonnet-4-5').pricing(anthropic.pricing());
const pool = H.pool('api', [apiAccount]).serves(sonnet);

const summarizerRole = H.role('anomalySummarizer')
  .prompt('You explain data anomalies in plain language for the person approving tonight\'s load.')
  .intents([])
  .recall(approverTaste);
const summarizer = H.seat('anomalySummarizer').role(summarizerRole).models(sonnet);

const anomalySkill = H.skill('summarizeAnomalies')
  .input(z.object({ source: z.string(), rows: z.number(), report: z.string() }))
  .output(z.object({ summary: z.string() }))
  .prompt(i => `Source: ${i.source}\nRows extracted: ${i.rows}\nValidation report:\n${i.report}`);

const validationReview = H.halt('validationReview')
  .context(z.object({ source: z.string(), report: z.string() }))
  .ask(c => `Validation failed for ${c.source}. Proceed anyway?`)
  .decision(z.object({ proceed: z.boolean() }));

const loadApproval = H.halt('loadApproval')
  .context(z.object({ source: z.string(), summary: z.string(), report: z.string() }))
  .ask(c => `Approve tonight's ${c.source} load?\n\n${c.summary}`)
  .decision(z.object({ approved: z.boolean(), note: z.string().optional() }));

const nightlyLoad = H.flow('nightlyLoad')
  .input(loadSchema)
  .step('extract', extract, { retry: threeTimesWithBackoff })
  .step('validate', validate, s => ({ source: s.input.source, file: s.steps.extract.file }))
  .when(
    s => !s.steps.validate.ok,
    f => f.halt('validationReview', validationReview, s => ({ source: s.input.source, report: s.steps.validate.report })),
  )
  .when(s => s.steps.validationReview?.proceed === false, f => f.exit('rejected'))
  .step('summary', summarizer.call(anomalySkill), s => ({
    source: s.input.source,
    rows: s.steps.extract.rows,
    report: s.steps.validate.report,
  }))
  .halt('approval', loadApproval, s => ({ source: s.input.source, summary: s.steps.summary.summary, report: s.steps.validate.report }))
  .when(s => !s.steps.approval.approved, f => f.exit('rejected'))
  .step('load', load, s => ({ source: s.input.source, file: s.steps.extract.file }), { retry: threeTimesWithBackoff })
  .step('verify', verify)
  .exit(s => (s.steps.verify.driftPercent === 0 ? 'loaded' : s.steps.verify.tolerable ? 'loadedWithWarnings' : 'failed'));

const nightlyLoads = H.lane('nightlyLoads')
  .of(NightlyLoad)
  .from(supply.schedule({ cron: '0 2 * * *', units: () => sourceSystems }).key(unit => unit.source))
  .store(sqlite.store('.harness/loads.db'))
  .handle(nightlyLoad, {
    exits: { loaded, loadedWithWarnings, rejected, failed },
    retry: { tries: 0, backoff: 'none', exhausted: failed },
  })
  .wip(4);

const nineOClock = (openedAt: Date): Date => {
  const nine = new Date(openedAt);
  nine.setHours(9, 0, 0, 0);
  return nine;
};

const approvalExpiresAtNine = H.trigger('approvalExpiresAtNine')
  .on(H.opened(loadApproval).at(nineOClock))
  .do(H.move(nightlyLoads, expired));

const loadedClean = H.metric('loadedClean').count(H.events.entered(loaded));
const loadedWarned = H.metric('loadedWarned').count(H.events.entered(loadedWithWarnings));
const loadSuccess = H.metric('loadSuccess').rate(H.events.terminal({ verdict: 'success' }), H.events.terminal());

const oldestFirst = H.policy.schedule('oldestFirst', ({ candidates }) =>
  [...candidates].sort((a, b) => b.waitingSeconds - a.waitingSeconds),
);

const approver = claudeCode.client('approver');

const approverGrant = H.grant(
  approver,
  H.ops.work.read,
  H.ops.resolve(loadApproval),
  H.ops.resolve(validationReview),
  H.ops.memory.write(tasteJournal),
  H.ops.telemetry.read,
);

export default H.harness('nightly-data')
  .ledger(sqlite.ledger('.harness/ledger.db'))
  .pools(pool)
  .lanes(nightlyLoads)
  .journals(tasteJournal)
  .triggers(approvalExpiresAtNine)
  .schedule(oldestFirst)
  .grants(approverGrant)
  .metrics(loadedClean, loadedWarned, loadSuccess)
  .observe(observers.board({ path: 'BOARD.md' }), observers.telemetry({ path: 'TELEMETRY.md' }));
