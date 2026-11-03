import { H } from 'harness-dsl';
import { z } from 'zod';
import * as anthropic from 'harness-dsl/anthropic';
import * as cc from 'harness-dsl/claude-code';
import * as sqlite from 'harness-dsl/sqlite';
import * as jsonl from 'harness-dsl/jsonl';
import * as ssh from 'harness-dsl/ssh';
import * as markdown from 'harness-dsl/markdown';

const due = H.state('due', 'pending');
const awaitingApproval = H.state('awaiting-approval', 'active');
const loaded = H.state('loaded', 'terminal', 'success');
const loadedWithWarnings = H.state('loaded-with-warnings', 'terminal', 'success');
const rejected = H.state('rejected', 'terminal', 'neutral');
const expired = H.state('expired', 'terminal', 'neutral');
const failed = H.state('failed', 'terminal', 'failure');

const NightlyLoad = H.kind('NightlyLoad')
  .data(z.object({ source: z.string(), night: z.string(), summary: z.string().optional() }))
  .states(due, awaitingApproval, loaded, loadedWithWarnings, rejected, expired, failed)
  .failsTo('failed');

const approverTaste = H.memory('approver-taste', 'taste');
const tasteArchive = H.archive('approver-taste', approverTaste, jsonl.memory('memory/taste.jsonl'));
const summaryBriefing = H.briefing('summary-briefing', [tasteArchive]);

const warehouse = ssh.host('warehouse', {
  address: 'etl.internal',
  user: 'etl',
  key: H.env('ETL_SSH_KEY'),
  slots: 2,
});

const loadInput = z.object({ source: z.string(), night: z.string() });

const extract = H.command('extract')
  .input(loadInput)
  .argv((input) => ['etl', 'extract', input.source, '--night', input.night])
  .on(warehouse)
  .recovers('rerun');

const validate = H.command('validate')
  .input(loadInput)
  .argv((input) => ['etl', 'validate', input.source, '--night', input.night])
  .on(warehouse)
  .recovers('rerun');

const load = H.command('load')
  .input(loadInput)
  .argv((input) => ['etl', 'load', input.source, '--night', input.night])
  .on(warehouse)
  .recovers('park');

const verify = H.command('verify')
  .input(loadInput)
  .output(z.object({ driftPct: z.number(), tolerable: z.boolean() }))
  .argv((input) => ['etl', 'verify', input.source, '--night', input.night, '--json'])
  .on(warehouse)
  .recovers('rerun');

const exponentialBackoff = H.policy.retry('three-retries-exponential', (view) =>
  view.failures > 3 ? 'stop' : { retryInMs: 30_000 * 2 ** (view.failures - 1) }
);

const summarizerRole = H.role('anomaly-summarizer')
  .input(z.object({ source: z.string(), night: z.string(), report: z.string() }))
  .output(z.object({ summary: z.string() }))
  .prompt((input) => `Summarise the anomalies in tonight's ${input.source} load (${input.night}) in plain language.\n\n${input.report}`)
  .intents([]);

const summarizer = H.agent('anomaly-summarizer', summarizerRole)
  .model(anthropic.model('claude-sonnet-4-5'))
  .recalls(summaryBriefing);

const validationReview = H.halt('validation-review', z.object({ proceed: z.boolean(), notes: z.string().optional() }));
const loadApproval = H.halt('load-approval', z.object({ approved: z.boolean(), notes: z.string().optional() }));

const nightlyFlow = H.flow('nightly-load')
  .for(NightlyLoad)
  .does(async (ctx) => {
    const target = { source: ctx.unit.data.source, night: ctx.unit.data.night };
    const extracted = await ctx.run(extract, target, { retry: exponentialBackoff });
    if (extracted.ok === false) return ctx.fail(`extract failed: ${extracted.error}`, 'failed');
    const validated = await ctx.run(validate, target);
    if (validated.ok === false) {
      const review = await ctx.halt(validationReview, `Validation failed for ${target.source}:\n\n${validated.error}`);
      if (review.proceed === false) return 'rejected';
    }
    const report = validated.ok ? validated.value : validated.error;
    const summarized = await ctx.run(summarizer, { ...target, report });
    const summary = summarized.ok ? summarized.value.summary : `Summary unavailable: ${summarized.error}`;
    await ctx.update({ summary });
    await ctx.move('awaiting-approval');
    const approval = await ctx.halt(loadApproval, summary);
    if (approval.approved === false) return 'rejected';
    const landed = await ctx.run(load, target, { retry: exponentialBackoff });
    if (landed.ok === false) return ctx.fail(`load failed: ${landed.error}`, 'failed');
    const verified = await ctx.run(verify, target);
    if (verified.ok === false) return ctx.fail(`verify failed: ${verified.error}`, 'failed');
    if (verified.value.driftPct === 0) return 'loaded';
    if (verified.value.tolerable) return 'loaded-with-warnings';
    return ctx.fail(`drift of ${verified.value.driftPct}% is beyond tolerance`, 'failed');
  });

const sources = ['billing', 'crm', 'inventory', 'web-analytics'];

const nightly = H.clock('nightly-0200', NightlyLoad, { daily: '02:00' }, (tick) => {
  const night = tick.now.toISOString().slice(0, 10);
  return sources.map((source) => ({ create: { source, night }, key: `${source}-${night}` }));
});

const nightlyLoads = H.lane('nightly-loads', NightlyLoad)
  .handler(nightlyFlow)
  .suppliers(nightly)
  .store(sqlite.store(NightlyLoad, '.harness/loads.db'));

const approvalExpiry = H.trigger(
  'approval-expires-at-0900',
  H.on.deadline(NightlyLoad, (data) => new Date(`${data.night}T09:00:00`), ['awaiting-approval']),
  (event, act) => act.move('expired')
);

const fifo = H.policy.scheduler('oldest-first', (view) => ({
  start: [...view.pending].sort((a, b) => b.waitedMs - a.waitedMs),
}));

const dataPool = H.pool('data', [
  { account: anthropic.account('data-api', { apiKey: H.env('ANTHROPIC_API_KEY') }), share: 1 },
]);

const supervisor = cc.supervisor({
  grants: [H.ops.readWork, H.ops.resolveHalts, H.ops.readMemory, H.ops.writeMemory, H.ops.readTelemetry],
});

export const dataJob = H.harness('nightly-data')
  .ledger(sqlite.ledger('.harness/ledger.db'))
  .lanes(nightlyLoads)
  .pools(dataPool)
  .triggers(approvalExpiry)
  .scheduler(fifo)
  .clients(supervisor)
  .observers(markdown.board('BOARD.md'), markdown.telemetry('TELEMETRY.md'));
