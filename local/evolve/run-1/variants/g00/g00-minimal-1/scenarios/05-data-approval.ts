import { z } from 'zod';
import { H } from 'harness-dsl';
import type { MemoryItem, RecallContext, Retry } from 'harness-dsl';
import { anthropic } from 'harness-dsl/anthropic';
import { claudeCode } from 'harness-dsl/claude-code';
import { sqlite } from 'harness-dsl/sqlite';
import { jsonl } from 'harness-dsl/jsonl';
import { shell } from 'harness-dsl/shell';
import { markdown } from 'harness-dsl/markdown';

const SourceSystem = z.enum(['crm', 'billing', 'inventory', 'web']);

const NightlyLoad = H.kind('NightlyLoad', {
  data: z.object({ source: SourceSystem, night: z.string() }),
  states: {
    scheduled: 'pending',
    extracting: 'active',
    validating: 'active',
    summarizing: 'active',
    awaitingApproval: 'active',
    loading: 'active',
    verifying: 'active',
    loaded: 'succeeded',
    loadedWithWarnings: 'succeeded',
    rejected: 'concluded',
    failed: 'failed',
    expired: 'cancelled',
  },
  initial: 'scheduled',
  tags: (load) => [load.source],
});

const nightOf = (now: Date) => now.toISOString().slice(0, 10);

const nightlySchedule = H.every(NightlyLoad, { cron: '0 2 * * *', tz: 'Europe/Amsterdam' }, (tick) =>
  SourceSystem.options.map((source) => ({ key: `${source}-${nightOf(tick.now)}`, data: { source, night: nightOf(tick.now) } })),
);

const etlHost = shell.ssh({ name: 'etl-host', host: 'etl.internal', user: 'etl', key: H.env('ETL_SSH_KEY'), slots: 2 });
const local = shell.local({ name: 'local', slots: 4 });

const api = anthropic.account({ name: 'data-api', key: H.env('ANTHROPIC_API_KEY') });
const sonnet = anthropic.model({ name: 'sonnet', id: 'claude-sonnet-4-5', account: api, price: { inputUsdPerMTok: 3, outputUsdPerMTok: 15 } });

const summarizer = H.role('summarizer', {
  instructions: 'Summarize the anomalies in plain language for the approver.',
  intents: ['read'],
});

const ValidationReport = z.object({ ok: z.boolean(), report: z.string() });
const AnomalySummary = z.object({ summary: z.string(), anomalies: z.array(z.string()) });
const Verification = z.object({ driftPct: z.number() });
const transientRetry: Retry = { maxRetries: 3, backoff: 'exponential', baseSeconds: 60 };

const nightlyFlow = H.flow('nightly-load', { kinds: [NightlyLoad] })
  .mark('extracting')
  .step(
    'extract',
    (ctx) => H.command('extract', { argv: ['/opt/etl/bin/extract', ctx.unit.data.source, ctx.unit.data.night], timeoutSeconds: 3600 }),
    { on: etlHost, retry: transientRetry },
  )
  .mark('validating')
  .step('validate', (ctx) =>
    H.command('validate', { argv: ['/opt/etl/bin/validate', ctx.unit.data.source, ctx.unit.data.night], output: ValidationReport }),
  )
  .halt('validationReview', {
    question: (ctx) => `Validation of ${ctx.unit.data.source} for ${ctx.unit.data.night} failed:\n\n${ctx.out.validate.report}\n\nProceed anyway?`,
    decision: z.object({ proceed: z.boolean() }),
    unless: (ctx) => ctx.out.validate.ok,
  })
  .end((ctx) => (ctx.out.validationReview !== undefined && !ctx.out.validationReview.proceed ? 'rejected' : undefined), {
    note: () => 'the approver stopped the load after a failed validation',
  })
  .mark('summarizing')
  .step('summarize', (ctx) =>
    H.ask(summarizer, {
      prompt: `Source ${ctx.unit.data.source}, night ${ctx.unit.data.night}.\nValidation report:\n${ctx.out.validate.report}`,
      output: AnomalySummary,
      budgetTokens: 6000,
    }),
  )
  .mark('awaitingApproval')
  .halt('approval', {
    question: (ctx) => `Load ${ctx.unit.data.source} for ${ctx.unit.data.night}?\n\n${ctx.out.summarize.summary}`,
    decision: z.object({ approve: z.boolean(), note: z.string() }),
  })
  .end((ctx) => (ctx.out.approval !== undefined && ctx.out.approval.approve ? undefined : 'rejected'), {
    note: (ctx) => ctx.out.approval?.note ?? '',
  })
  .mark('loading')
  .step(
    'load',
    (ctx) => H.command('load', { argv: ['/opt/etl/bin/load', ctx.unit.data.source, ctx.unit.data.night], timeoutSeconds: 3600 }),
    { on: etlHost, retry: transientRetry },
  )
  .mark('verifying')
  .step('verify', (ctx) =>
    H.command('verify', { argv: ['/opt/etl/bin/verify', ctx.unit.data.source, ctx.unit.data.night], output: Verification }),
  )
  .end((ctx) => (ctx.out.verify.driftPct > 0 ? 'loadedWithWarnings' : 'loaded'));

const nightlyLane = H.lane(NightlyLoad)
  .from(nightlySchedule)
  .store(sqlite.store(NightlyLoad, { path: '.harness/loads.sqlite' }))
  .handle(nightlyFlow)
  .cast({ summarizer: sonnet })
  .states({
    extracting: 'extracting',
    validating: 'validating',
    summarizing: 'summarizing',
    awaitingApproval: 'awaitingApproval',
    loading: 'loading',
    verifying: 'verifying',
    loaded: 'loaded',
    loadedWithWarnings: 'loadedWithWarnings',
    rejected: 'rejected',
    failed: 'failed',
    cancelled: 'expired',
  })
  .runOn(local);

const approvalExpires = H.trigger(
  'approval-expires-at-nine',
  H.when.overdue(NightlyLoad, { in: ['awaitingApproval'], at: (unit) => new Date(`${unit.data.night}T09:00:00+01:00`) }),
  (then) => then.cancel('expired'),
);

const within = (allowed: readonly string[] | undefined, present: readonly string[]) =>
  allowed === undefined || allowed.length === 0 || allowed.some((entry) => present.includes(entry));

const applies = (item: MemoryItem, ctx: RecallContext) =>
  item.status === 'active' && within(item.when.roles, [ctx.scope.role]) && within(item.when.tags, ctx.scope.tags);

const Taste = H.memory('approver-taste', { stance: 'taste' });

const tasteJournal = H.journal('approver-taste', Taste, jsonl.memory({ path: '.harness/taste.jsonl' }))
  .recall(
    H.policy.recall('taste-most-specific', async (ctx) =>
      (await ctx.items()).filter((item) => applies(item, ctx)).sort((a, b) => ctx.specificity(b) - ctx.specificity(a)).slice(0, ctx.limit),
    ),
  )
  .recalledBy(summarizer)
  .recordedBy(H.operator);

const projections = H.trigger('projections', H.when.transition(), (then) => [
  then.run(markdown.board({ path: 'BOARD.md' })),
  then.run(markdown.telemetry({ path: 'TELEMETRY.md', sinceDays: 30 })),
]);

const approverConsole = claudeCode.supervisor({
  name: 'approver-console',
  endpoint: H.slot.port(7405),
  grants: [H.op.readWork, H.op.resolveBlocker, H.op.cancelWork, H.op.writeMemory, H.op.readMemory, H.op.readTelemetry],
});

export const dataJob = H.harness('nightly-data')
  .ledger(sqlite.ledger({ path: '.harness/ledger.sqlite' }))
  .lanes(nightlyLane)
  .journals(tasteJournal)
  .triggers(approvalExpires, projections)
  .scheduler(H.policy.order('oldest-first', (ctx) => ({ order: [...ctx.pending].sort((a, b) => b.waitingSeconds - a.waitingSeconds) })))
  .clients(approverConsole);

export const running = dataJob.start();
