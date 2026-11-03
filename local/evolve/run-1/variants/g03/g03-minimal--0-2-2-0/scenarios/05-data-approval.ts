import { H } from 'harness-dsl';
import { z } from 'zod';
import * as claudeCode from 'harness-dsl/claude-code';
import * as anthropic from 'harness-dsl/anthropic';
import * as sqlite from 'harness-dsl/sqlite';
import * as jsonl from 'harness-dsl/jsonl';
import * as ssh from 'harness-dsl/ssh';
import * as markdown from 'harness-dsl/markdown';

const sourceSystem = z.enum(['crm', 'billing', 'inventory', 'web']);

const NightlyLoad = H.kind('nightly-load')
  .data(z.object({
    source: sourceSystem,
    night: z.string(),
    summary: z.string().optional(),
    drift: z.number().optional()
  }))
  .states(
    H.state('load-scheduled', 'pending'),
    H.state('extracting', 'active'),
    H.state('validating', 'active'),
    H.state('summarizing', 'active'),
    H.state('awaiting-approval', 'active'),
    H.state('loading', 'active'),
    H.state('verifying', 'active'),
    H.state('loaded', 'terminal', 'success'),
    H.state('loaded-with-warnings', 'terminal', 'success'),
    H.state('load-rejected', 'terminal', 'neutral'),
    H.state('load-expired', 'terminal', 'neutral'),
    H.state('load-failed', 'terminal', 'failure')
  )
  .failsTo('load-failed');

const approverTaste = H.library(
  'approver-emphasis',
  H.memory('approver-taste', 'taste'),
  jsonl.memory('.harness/approver-taste.jsonl')
);

const warehouse = ssh.host('warehouse', {
  address: 'warehouse.internal',
  user: 'etl',
  key: H.env('WAREHOUSE_SSH_KEY'),
  slots: 2
});

const job = z.object({ source: sourceSystem, night: z.string() });

const extract = H.command('extract')
  .input(job)
  .argv(({ source, night }) => ['/opt/etl/extract.sh', source, night])
  .on(warehouse);

const validate = H.command('validate')
  .input(job)
  .output(z.object({ passed: z.boolean(), report: z.string(), anomalies: z.array(z.string()) }))
  .argv(({ source, night }) => ['/opt/etl/validate.sh', source, night])
  .on(warehouse);

const load = H.command('load')
  .input(job)
  .argv(({ source, night }) => ['/opt/etl/load.sh', source, night])
  .on(warehouse);

const verify = H.command('verify')
  .input(job)
  .output(z.object({ drift: z.number(), tolerable: z.boolean() }))
  .argv(({ source, night }) => ['/opt/etl/verify.sh', source, night])
  .on(warehouse);

const exponentialBackoff = H.policy.retry('three-retries-exponential', ({ failures }) =>
  failures > 3 ? 'stop' : { retryInMs: 60_000 * 2 ** (failures - 1) });

const noLaneRetry = H.policy.retry('no-lane-retry', () => 'stop');

const summarizerRole = H.role('anomaly-summarizer')
  .input(z.object({ source: z.string(), report: z.string(), anomalies: z.array(z.string()) }))
  .output(z.object({ summary: z.string() }))
  .prompt((input) => `Summarise, in plain language for the approver, the anomalies in tonight's ${input.source} extract.\n\nValidation report:\n${input.report}\n\nAnomalies:\n- ${input.anomalies.join('\n- ')}`);

const summarizer = H.agent('anomaly-summarizer', summarizerRole)
  .model(anthropic.model('claude-sonnet-4-5'))
  .recalls(approverTaste);

const validationReview = H.halt('validation-review', z.object({ action: z.enum(['continue', 'reject']) }));
const loadApproval = H.halt('load-approval', z.object({ approve: z.boolean(), note: z.string().optional() }));

const nightlyWork = H.flow('nightly-load-run')
  .for(NightlyLoad)
  .does(async (ctx) => {
    const target = { source: ctx.unit.data.source, night: ctx.unit.data.night };

    await ctx.move('extracting');
    const extracted = await ctx.run(extract, target, { retry: exponentialBackoff });
    if (!extracted.ok) return ctx.fail(`extract: ${extracted.error}`);

    await ctx.move('validating');
    const validation = await ctx.run(validate, target);
    if (!validation.ok) return ctx.fail(`validate: ${validation.error}`);
    if (!validation.value.passed) {
      const review = await ctx.halt(validationReview, validation.value.report);
      if (review.action === 'reject') return 'load-rejected';
    }

    await ctx.move('summarizing');
    const summarized = await ctx.run(summarizer, {
      source: target.source,
      report: validation.value.report,
      anomalies: validation.value.anomalies
    });
    if (!summarized.ok) return ctx.fail(`summary: ${summarized.error}`);
    await ctx.update({ summary: summarized.value.summary });

    await ctx.move('awaiting-approval');
    const approval = await ctx.halt(loadApproval, summarized.value.summary);
    if (!approval.approve) return 'load-rejected';

    await ctx.move('loading');
    const loaded = await ctx.run(load, target, { retry: exponentialBackoff });
    if (!loaded.ok) return ctx.fail(`load: ${loaded.error}`);

    await ctx.move('verifying');
    const verified = await ctx.run(verify, target);
    if (!verified.ok) return ctx.fail(`verify: ${verified.error}`);
    if (verified.value.drift === 0) return 'loaded';
    if (!verified.value.tolerable) return ctx.fail(`verify: drift ${verified.value.drift} beyond tolerance`);
    await ctx.update({ drift: verified.value.drift });
    return 'loaded-with-warnings';
  });

const nightlySchedule = H.clock('nightly-0200', NightlyLoad, { daily: '02:00' }, ({ now }) => {
  const night = now.toISOString().slice(0, 10);
  return sourceSystem.options.map((source) => NightlyLoad.create({ source, night }, `${source}-${night}`));
});

const loadLane = H.lane('nightly-loads', NightlyLoad)
  .handler(nightlyWork)
  .suppliers(nightlySchedule)
  .store(sqlite.store(NightlyLoad, '.harness/nightly-loads.db'))
  .retry(noLaneRetry);

const approvalExpiry = H.trigger(
  'approval-expires-at-0900',
  H.on.deadline(NightlyLoad, (data) => new Date(`${data.night}T09:00:00`), ['awaiting-approval']),
  (_event, act) => act.move('load-expired')
);

const summaryPool = H.pool('summary-accounts', [
  { account: anthropic.account('etl-api', { apiKey: H.env('ANTHROPIC_API_KEY') }), share: 1 }
]);

export default H.harness('nightly-data')
  .ledger(sqlite.ledger('.harness/nightly-data.db'))
  .lanes(loadLane)
  .pools(summaryPool)
  .triggers(approvalExpiry)
  .clients(claudeCode.supervisor({
    grants: [H.ops.readWork, H.ops.resolveHalts, H.ops.readMemory, H.ops.writeMemory, H.ops.readTelemetry]
  }))
  .observers(markdown.board('BOARD.md'), markdown.telemetry('TELEMETRY.md'));
