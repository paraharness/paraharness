import { H, type SupplyOf } from 'harness-dsl';
import { z } from 'zod';
import * as claudeCode from 'harness-dsl/claude-code';
import * as anthropic from 'harness-dsl/anthropic';
import * as sqlite from 'harness-dsl/sqlite';
import * as jsonl from 'harness-dsl/jsonl';
import * as ssh from 'harness-dsl/ssh';
import * as markdown from 'harness-dsl/markdown';

const sourceSystem = z.enum(['crm', 'erp', 'billing', 'web-analytics']);
const loadData = z.object({ source: sourceSystem, night: z.string() });

const NightlyLoad = H.kind('nightly-load')
  .data(loadData)
  .states(
    [
      H.state('load-scheduled', 'pending'),
      H.state('extracting', 'active'),
      H.state('awaiting-approval', 'active'),
      H.state('loading', 'active'),
      H.state('loaded', { terminal: 'success' }),
      H.state('loaded-with-warnings', { terminal: 'success' }),
      H.state('load-rejected', { terminal: 'neutral' }),
      H.state('load-expired', { terminal: 'neutral' }),
      H.state('load-failed', { terminal: 'failure' }),
    ],
    'load-scheduled'
  )
  .failsTo('load-failed');

const Taste = H.memory('approver-taste', 'owner');

const specificThenProven = H.policy.recall('specific-then-proven', (view) =>
  [...view.items]
    .filter((item) => item.status === 'accepted')
    .sort((a, b) => b.specificity - a.specificity || (b.trackRecord.value ?? 0) - (a.trackRecord.value ?? 0))
    .slice(0, 10)
);

const taste = H.library('approver-taste', Taste, jsonl.memory('memory/taste.jsonl')).recall(specificThenProven);

const warehouse = ssh.host('warehouse', {
  address: 'warehouse.internal',
  user: 'etl',
  key: H.env('ETL_SSH_KEY'),
  slots: 2,
});

const extract = H.command('extract')
  .input(loadData)
  .argv((input) => ['/opt/etl/extract.sh', input.source, input.night])
  .on(warehouse)
  .restart('rerun');

const validate = H.command('validate')
  .input(loadData)
  .argv((input) => ['/opt/etl/validate.sh', input.source, input.night])
  .on(warehouse)
  .restart('rerun');

const load = H.command('load')
  .input(loadData)
  .argv((input) => ['/opt/etl/load.sh', input.source, input.night])
  .on(warehouse)
  .restart('park');

const verify = H.command('verify')
  .input(loadData)
  .output(z.object({ driftPercent: z.number() }))
  .argv((input) => ['/opt/etl/verify.sh', input.source, input.night])
  .on(warehouse)
  .restart('rerun');

const threeWithBackoff = H.policy.retry('three-with-exponential-backoff', (view) =>
  view.failures <= 3 ? { retryInMs: 60000 * 2 ** (view.failures - 1) } : 'stop'
);

const summarizerRole = H.role('anomaly-summarizer')
  .input(z.object({ source: sourceSystem, report: z.string() }))
  .output(z.object({ summary: z.string() }))
  .prompt((input) => `Summarize, in plain language, the anomalies in tonight's ${input.source} extract.\n\nValidation report:\n${input.report}`);

const summarizer = H.agent('anomaly-summarizer', summarizerRole).model(anthropic.model('claude-sonnet-4-5')).recalls(taste);

const firstEligible = H.policy.account('first-eligible', (choice) => choice.accounts.find((view) => view.eligible)?.account ?? null);

const apiPool = H.pool(
  'api',
  [{ account: anthropic.account('etl-api', { apiKey: H.env('ANTHROPIC_API_KEY') }), share: 1 }],
  firstEligible
);

const tolerableDriftPercent = 0.5;

const nightlyFlow = H.flow('nightly-load').for(NightlyLoad).does(async (ctx) => {
  const job = ctx.unit.data;
  await ctx.move('extracting');
  const extracted = await ctx.run(extract, job, { retry: threeWithBackoff });
  if (!extracted.ok) return ctx.fail(extracted.error);
  const validated = await ctx.run(validate, job);
  const report = validated.ok ? validated.value : validated.error;
  if (!validated.ok) {
    const review = await ctx.halt({
      name: 'validation-failed',
      show: report,
      decision: z.object({ proceed: z.boolean() }),
    });
    if (!review.proceed) return 'load-rejected';
  }
  const summary = await ctx.run(summarizer, { source: job.source, report });
  if (!summary.ok) return ctx.fail(summary.error);
  await ctx.move('awaiting-approval');
  const approval = await ctx.halt({
    name: 'approve-load',
    show: summary.value.summary,
    decision: z.object({ approved: z.boolean(), notes: z.string().optional() }),
  });
  if (!approval.approved) return 'load-rejected';
  await ctx.move('loading');
  const loaded = await ctx.run(load, job, { retry: threeWithBackoff });
  if (!loaded.ok) return ctx.fail(loaded.error);
  const verified = await ctx.run(verify, job);
  if (!verified.ok) return ctx.fail(verified.error);
  const drift = verified.value.driftPercent;
  if (drift === 0) return 'loaded';
  return drift <= tolerableDriftPercent
    ? 'loaded-with-warnings'
    : ctx.fail(`drift of ${drift}% exceeds the tolerable ${tolerableDriftPercent}%`);
});

const nightlyAtTwo = H.timetable('nightly-at-0200', NightlyLoad, { daily: '02:00' }, (tick) => {
  const night = tick.now.toISOString().slice(0, 10);
  return sourceSystem.options.map((source): SupplyOf<typeof NightlyLoad> => ({
    create: { source, night },
    key: `${source}-${night}`,
  }));
});

const loadLane = H.lane('nightly-loads', NightlyLoad)
  .handler(nightlyFlow)
  .suppliers(nightlyAtTwo)
  .store(sqlite.store(NightlyLoad, '.harness/loads.sqlite'));

const approvalExpiresAtNine = H.trigger(
  'approval-expires-at-0900',
  H.on.time(NightlyLoad, { daily: '09:00' }, ['awaiting-approval']),
  (_event, act) => act.move('load-expired')
);

const oldestFirst = H.policy.scheduler('oldest-first', (view) => ({
  start: [...view.pending].sort((a, b) => b.waitedMs - a.waitedMs),
}));

const supervisor = claudeCode.supervisor({
  grants: [H.ops.readWork, H.ops.resolveHalts, H.ops.readMemory, H.ops.writeMemory, H.ops.readTelemetry],
});

export const dataApproval = H.harness('nightly-data-load')
  .ledger(sqlite.ledger('.harness/ledger.sqlite'))
  .lanes(loadLane)
  .pools(apiPool)
  .triggers(approvalExpiresAtNine)
  .scheduler(oldestFirst)
  .clients(supervisor)
  .observers(markdown.board('BOARD.md'), markdown.telemetry('TELEMETRY.md'));
