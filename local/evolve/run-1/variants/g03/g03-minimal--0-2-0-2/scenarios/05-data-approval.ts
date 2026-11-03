import { H } from 'harness-dsl';
import { z } from 'zod';
import * as claudeCode from 'harness-dsl/claude-code';
import * as anthropic from 'harness-dsl/anthropic';
import * as sqlite from 'harness-dsl/sqlite';
import * as jsonl from 'harness-dsl/jsonl';
import * as shell from 'harness-dsl/shell';
import * as ssh from 'harness-dsl/ssh';
import * as markdown from 'harness-dsl/markdown';

const sourceSchema = z.enum(['crm', 'billing', 'inventory', 'web']);
type SourceSystem = z.infer<typeof sourceSchema>;
const sourceSystems: readonly SourceSystem[] = ['crm', 'billing', 'inventory', 'web'];
const sourceFacet = H.facet('source-system', ['crm', 'billing', 'inventory', 'web']);

const NightlyLoad = H.kind('NightlyLoad')
  .data(z.object({ source: sourceSchema, night: z.string(), approvalDeadline: z.string() }))
  .states(
    H.state('scheduled', 'pending'),
    H.state('awaiting-approval', 'active'),
    H.state('loaded', 'terminal', 'success'),
    H.state('loaded-with-warnings', 'terminal', 'success'),
    H.state('rejected', 'terminal', 'failure'),
    H.state('failed', 'terminal', 'failure'),
    H.state('expired', 'terminal', 'neutral')
  )
  .failsTo('failed');

const tasteKind = H.memory('approver-taste', 'taste');
const approverTaste = H.archive('approver-taste-archive', tasteKind, jsonl.memory('memory/taste.jsonl'));
const summaryBriefing = H.briefing('summary-briefing', [approverTaste]);

const sonnet = anthropic.model('claude-sonnet-4-5');
const api = H.pool('api', [{ account: anthropic.account('api', { apiKey: H.env('ANTHROPIC_API_KEY') }), share: 1 }]);

const local = shell.local('local', { slots: 2 });
const etlHost = ssh.host('etl-host', { address: 'etl.internal', user: 'etl', key: H.env('ETL_SSH_KEY'), slots: 2 });

const loadInput = z.object({ source: sourceSchema, night: z.string() });

const extract = H.command('extract')
  .input(loadInput)
  .argv((input) => ['etl', 'extract', '--source', input.source, '--night', input.night])
  .on(etlHost)
  .recovers('rerun');

const validate = H.command('validate')
  .input(loadInput)
  .argv((input) => ['etl', 'validate', '--source', input.source, '--night', input.night])
  .on(local)
  .recovers('rerun');

const load = H.command('load')
  .input(loadInput)
  .argv((input) => ['etl', 'load', '--source', input.source, '--night', input.night])
  .on(etlHost);

const verify = H.command('verify')
  .input(loadInput)
  .output(z.object({ drift: z.enum(['none', 'tolerable', 'intolerable']), report: z.string() }))
  .argv((input) => ['etl', 'verify', '--source', input.source, '--night', input.night, '--json'])
  .on(etlHost)
  .recovers('rerun');

const summarize = H.role('summarize-anomalies')
  .input(z.object({ source: z.string(), night: z.string(), report: z.string() }))
  .output(z.object({ summary: z.string() }))
  .prompt(
    (input) =>
      `Summarise in plain language the anomalies in the ${input.source} extract for ${input.night}:\n${input.report}`
  )
  .intents(['read']);

const summarizer = H.agent('summarizer', summarize).model(sonnet).recalls(summaryBriefing);

const validationReview = H.halt('validation-review', z.object({ proceed: z.boolean(), note: z.string().optional() }));
const loadApproval = H.halt('load-approval', z.object({ approved: z.boolean(), note: z.string().optional() }));

const backoff = H.policy.retry('exponential-backoff', ({ failures }) =>
  failures > 3 ? 'stop' : { retryInMs: 60_000 * 2 ** (failures - 1) }
);
const noUnitRetry = H.policy.retry('no-unit-retry', () => 'stop');

const nightly = H.flow('nightly-load')
  .for(NightlyLoad)
  .does(async (ctx) => {
    const { source, night } = ctx.unit.data;
    ctx.facet(sourceFacet, source);
    const batch = { source, night };
    const extracted = await ctx.run(extract, batch, { retry: backoff });
    if (!extracted.ok) return ctx.fail(`extract: ${extracted.error}`);
    const validated = await ctx.run(validate, batch);
    const report = validated.ok ? validated.value : validated.error;
    if (!validated.ok) {
      const review = await ctx.halt(validationReview, `Validation failed for ${source} on ${night}:\n\n${report}`);
      if (!review.proceed) return 'rejected';
    }
    const summary = await ctx.run(summarizer, { source, night, report });
    if (!summary.ok) return ctx.fail(`summary: ${summary.error}`);
    await ctx.move('awaiting-approval');
    const approval = await ctx.halt(loadApproval, summary.value.summary);
    if (!approval.approved) return 'rejected';
    const loaded = await ctx.run(load, batch, { retry: backoff });
    if (!loaded.ok) return ctx.fail(`load: ${loaded.error}`);
    const verified = await ctx.run(verify, batch);
    if (!verified.ok) return ctx.fail(`verify: ${verified.error}`);
    if (verified.value.drift === 'none') return 'loaded';
    if (verified.value.drift === 'tolerable') return 'loaded-with-warnings';
    return ctx.fail(`verify found intolerable drift: ${verified.value.report}`);
  });

const nightlyClock = H.clock('nightly-clock', NightlyLoad, { daily: '02:00' }, (tick) => {
  const night = tick.now.toISOString().slice(0, 10);
  const deadline = new Date(tick.now);
  deadline.setUTCHours(9, 0, 0, 0);
  return sourceSystems.map((source) => ({
    create: { source, night, approvalDeadline: deadline.toISOString() },
    key: `${source}-${night}`,
  }));
});

const loads = H.lane('nightly-loads', NightlyLoad)
  .handler(nightly)
  .suppliers(nightlyClock)
  .store(sqlite.store(NightlyLoad, '.harness/loads.db'))
  .retry(noUnitRetry);

const approvalExpires = H.trigger(
  'approval-expires',
  H.on.deadline(NightlyLoad, (data) => new Date(data.approvalDeadline), ['awaiting-approval']),
  (_event, act) => act.move('expired')
);

const fifo = H.policy.scheduler('oldest-first', (view) => ({
  start: [...view.pending].sort((a, b) => b.waitedMs - a.waitedMs),
}));

const approverSession = claudeCode.supervisor({
  grants: [H.ops.readWork, H.ops.resolveHalts, H.ops.readMemory, H.ops.writeMemory, H.ops.readTelemetry],
});

export const dataJob = H.harness('nightly-data-job')
  .ledger(sqlite.ledger('.harness/ledger.db'))
  .lanes(loads)
  .pools(api)
  .triggers(approvalExpires)
  .scheduler(fifo)
  .clients(approverSession)
  .observers(markdown.board('BOARD.md'), markdown.telemetry('TELEMETRY.md'));
