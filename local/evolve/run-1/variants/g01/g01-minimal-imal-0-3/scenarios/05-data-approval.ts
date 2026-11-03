import { z } from 'zod';
import { H } from 'harness-dsl';
import * as claudeCode from 'harness-dsl/claude-code';
import * as anthropic from 'harness-dsl/anthropic';
import * as sqlite from 'harness-dsl/sqlite';
import * as jsonl from 'harness-dsl/jsonl';
import * as shell from 'harness-dsl/shell';
import * as ssh from 'harness-dsl/ssh';
import * as markdown from 'harness-dsl/markdown';

const Scheduled = H.state('scheduled', 'pending');
const Extracting = H.state('extracting', 'active');
const Validating = H.state('validating', 'active');
const Summarizing = H.state('summarizing', 'active');
const AwaitingApproval = H.state('awaiting-approval', 'active');
const Loading = H.state('loading', 'active');
const Verifying = H.state('verifying', 'active');
const Loaded = H.state('loaded', 'terminal', 'success');
const LoadedWithWarnings = H.state('loaded-with-warnings', 'terminal', 'success');
const Rejected = H.state('rejected', 'terminal', 'neutral');
const Failed = H.state('failed', 'terminal', 'failure');
const Cancelled = H.state('cancelled', 'terminal', 'neutral');

const NightlyLoad = H.kind('NightlyLoad')
  .data(z.object({ source: z.string(), host: z.string(), night: z.string() }))
  .states(
    [Scheduled, Extracting, Validating, Summarizing, AwaitingApproval, Loading, Verifying, Loaded, LoadedWithWarnings, Rejected, Failed, Cancelled],
    { initial: 'scheduled', afterFailure: 'failed', afterCancel: 'cancelled' },
  );

const summaryRole = H.role('anomaly-summarizer')
  .input(z.object({ source: z.string(), night: z.string(), validationReport: z.string() }))
  .output(z.object({ summary: z.string() }))
  .prompt(input => `Summarise in plain language the anomalies in tonight's ${input.source} extract (${input.night}) for the approver.\n\nValidation report:\n${input.validationReport}`)
  .intents([]);

const taste = H.memory('approver-taste', 'owner');
const approverTaste = H.library('approver-taste', taste, jsonl.memory('memory/approver-taste.jsonl'))
  .recall(H.policy.recall('specificity', view =>
    [...view.items]
      .filter(item => item.status === 'accepted')
      .sort((a, b) => b.specificity - a.specificity)
      .slice(0, 8)));

const summarizer = H.agent('anomaly-summarizer', summaryRole)
  .model(anthropic.model('claude-sonnet-4-5'))
  .recalls(approverTaste);

const local = shell.local('local', { slots: 2 });
const etl1 = ssh.host('etl-1', { address: 'etl-1.internal', user: 'etl', key: H.env('ETL_SSH_KEY'), slots: 2 });
const etl2 = ssh.host('etl-2', { address: 'etl-2.internal', user: 'etl', key: H.env('ETL_SSH_KEY'), slots: 2 });
const hostFor = (input: { host: string }) => input.host === etl1.name ? etl1 : etl2;

const extract = H.command('extract')
  .input(z.object({ source: z.string(), host: z.string(), night: z.string() }))
  .argv(input => ['/opt/etl/extract.sh', input.source, input.night])
  .on(hostFor)
  .restart('rerun');

const validate = H.command('validate')
  .input(z.object({ source: z.string(), night: z.string() }))
  .argv(input => ['/opt/etl/validate.sh', input.source, input.night])
  .on(local)
  .restart('rerun');

const load = H.command('load')
  .input(z.object({ source: z.string(), host: z.string(), night: z.string() }))
  .argv(input => ['/opt/etl/load.sh', input.source, input.night])
  .on(hostFor);

const verify = H.command('verify')
  .input(z.object({ source: z.string(), night: z.string() }))
  .output(z.object({ driftRows: z.number().int(), tolerable: z.boolean() }))
  .argv(input => ['/opt/etl/verify.sh', '--json', input.source, input.night])
  .on(local)
  .restart('rerun');

const exponentialBackoff = H.policy.retry('three-retries-exponential', view =>
  view.failures > 3 ? 'stop' : { retryInMs: 60_000 * 2 ** (view.failures - 1) });

const nightlyLoadFlow = H.flow('nightly-load')
  .for(NightlyLoad)
  .does(async ctx => {
    const { source, host, night } = ctx.unit.data;

    await ctx.move('extracting');
    const extracted = await ctx.run(extract, { source, host, night }, { retry: exponentialBackoff });
    if (!extracted.ok) return ctx.fail(`extract failed: ${extracted.error}`);

    await ctx.move('validating');
    const validated = await ctx.run(validate, { source, night });
    const validationReport = validated.ok ? validated.value : validated.error;
    if (!validated.ok) {
      const review = await ctx.halt({
        name: 'validation-failed',
        show: `Validation of ${source} for ${night} failed:\n\n${validated.error}`,
        decision: z.object({ proceed: z.boolean(), note: z.string().optional() }),
      });
      if (!review.proceed) return 'rejected';
    }

    await ctx.move('summarizing');
    const summary = await ctx.run(summarizer, { source, night, validationReport });
    if (!summary.ok) return ctx.fail(summary.error);

    await ctx.move('awaiting-approval');
    const approval = await ctx.halt({
      name: 'approve-load',
      show: summary.value.summary,
      decision: z.object({ approved: z.boolean(), note: z.string().optional() }),
    });
    if (!approval.approved) return 'rejected';

    await ctx.move('loading');
    const loaded = await ctx.run(load, { source, host, night }, { retry: exponentialBackoff });
    if (!loaded.ok) return ctx.fail(`load failed: ${loaded.error}`);

    await ctx.move('verifying');
    const verified = await ctx.run(verify, { source, night });
    if (!verified.ok) return ctx.fail(`verify failed: ${verified.error}`);
    if (verified.value.driftRows === 0) return 'loaded';
    return verified.value.tolerable ? 'loaded-with-warnings' : ctx.fail(`intolerable drift of ${verified.value.driftRows} rows`);
  });

const nightlyLoads = H.lane('nightly-loads', NightlyLoad)
  .handler(nightlyLoadFlow)
  .store(sqlite.store(NightlyLoad, '.harness/loads.sqlite'));

const sourceSystems = [
  { source: 'billing', host: 'etl-1' },
  { source: 'crm', host: 'etl-1' },
  { source: 'inventory', host: 'etl-2' },
  { source: 'web-analytics', host: 'etl-2' },
];

const nightlyAtTwo = H.trigger('nightly-load-at-0200', H.on.clock({ daily: '02:00' }), (event, act) => {
  const night = event.at.toISOString().slice(0, 10);
  return sourceSystems.map(system =>
    act.create(nightlyLoads, { source: system.source, host: system.host, night }, `${system.source}-${night}`));
});

const approvalExpiresAtNine = H.trigger(
  'unapproved-load-expires-at-0900',
  H.on.clock({ daily: '09:00' }, NightlyLoad, ['awaiting-approval']),
  (_event, act) => act.move('cancelled'),
);

const oldestFirst = H.policy.scheduler('oldest-first', view => ({
  start: [...view.pending].sort((a, b) => b.waitedMs - a.waitedMs),
}));

const apiPool = H.pool('anthropic', [
  { account: anthropic.account('etl-api', { apiKey: H.env('ANTHROPIC_API_KEY') }), share: 1 },
], H.policy.account('first-eligible', choice => {
  const eligible = choice.accounts.find(view => view.eligible);
  return eligible ? eligible.account : null;
}));

const supervisor = claudeCode.supervisor({
  grants: [H.ops.readWork, H.ops.resolveHalts, H.ops.recoverAttempts, H.ops.writeMemory, H.ops.readTelemetry],
});

export default H.harness('nightly-data')
  .ledger(sqlite.ledger('.harness/data-ledger.sqlite'))
  .lanes(nightlyLoads)
  .pools(apiPool)
  .triggers(nightlyAtTwo, approvalExpiresAtNine)
  .scheduler(oldestFirst)
  .clients(supervisor)
  .observers(markdown.board('BOARD.md'), markdown.telemetry('TELEMETRY.md'));
