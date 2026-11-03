import { z } from 'zod';
import { H } from 'harness-dsl';
import * as anthropic from 'harness-dsl/anthropic';
import * as claudeCode from 'harness-dsl/claude-code';
import * as sqlite from 'harness-dsl/sqlite';
import * as jsonl from 'harness-dsl/jsonl';
import * as ssh from 'harness-dsl/ssh';
import * as markdown from 'harness-dsl/markdown';

const sourceSystems = ['crm', 'billing', 'inventory', 'support'] as const;

const LoadData = z.object({
  source: z.enum(sourceSystems),
  night: z.string(),
});

const loadScheduled = H.state('load-scheduled', 'pending');
const extracting = H.state('extracting', 'active');
const awaitingApproval = H.state('awaiting-approval', 'active');
const loading = H.state('loading', 'active');
const loaded = H.state('loaded', 'terminal', 'success');
const loadedWithWarnings = H.state('loaded-with-warnings', 'terminal', 'success');
const rejected = H.state('rejected', 'terminal', 'neutral');
const loadExpired = H.state('load-expired', 'terminal', 'failure');
const loadFailed = H.state('load-failed', 'terminal', 'failure');

const NightlyLoad = H.kind('nightly-load')
  .data(LoadData)
  .states(loadScheduled, extracting, awaitingApproval, loading, loaded, loadedWithWarnings, rejected, loadExpired, loadFailed)
  .failsTo('load-failed');

const etlHost = ssh.host('etl-host', { address: '10.0.1.20', user: 'etl', key: H.env('ETL_SSH_KEY'), slots: 2 });

const extract = H.command('extract')
  .input(LoadData)
  .argv((load) => ['etl', 'extract', load.source, '--night', load.night])
  .on(etlHost);

const validate = H.command('validate')
  .input(LoadData)
  .argv((load) => ['etl', 'validate', load.source, '--night', load.night])
  .on(etlHost);

const load = H.command('load')
  .input(LoadData)
  .argv((target) => ['etl', 'load', target.source, '--night', target.night])
  .on(etlHost);

const verify = H.command('verify')
  .input(LoadData)
  .output(z.object({ driftPct: z.number() }))
  .argv((target) => ['etl', 'verify', target.source, '--night', target.night, '--json'])
  .on(etlHost);

const summarizeRole = H.role('anomaly-summarizer')
  .input(z.object({ source: z.string(), report: z.string() }))
  .output(z.object({ summary: z.string() }))
  .prompt((input) => `Summarise, in plain language for the approver, the anomalies in tonight's ${input.source} extract.\n\n${input.report}`)
  .intents([]);

const approverTaste = H.memory('approver-taste', 'taste');
const tasteJournal = H.library('approver-taste-journal', approverTaste, jsonl.memory('.harness/approver-taste.jsonl'));

const sonnet = anthropic.model('claude-sonnet-4-5');
const api = anthropic.account('anthropic-api', { apiKey: H.env('ANTHROPIC_API_KEY') });
const apiPool = H.pool('api', [{ account: api, share: 1 }]);

const summarizer = H.agent('anomaly-summarizer', summarizeRole).model(sonnet).recalls(tasteJournal);

const exponentialBackoff = H.policy.retry('exponential-backoff', ({ failures }) =>
  failures > 3 ? 'stop' : { retryInMs: 60_000 * 2 ** (failures - 1) });

const failNight = H.policy.retry('fail-the-night', () => 'stop');

const validationReview = H.halt('validation-review', z.object({ action: z.enum(['continue', 'reject']) }));
const loadApproval = H.halt('load-approval', z.object({ approved: z.boolean(), note: z.string() }));

const tolerableDriftPct = 0.5;

const nightlyLoadFlow = H.flow('nightly-load-flow')
  .for(NightlyLoad)
  .does(async (ctx) => {
    const target = ctx.unit.data;
    await ctx.move('extracting');
    const extracted = await ctx.run(extract, target, { retry: exponentialBackoff });
    if (!extracted.ok) return ctx.fail(extracted.error);

    const validated = await ctx.run(validate, target);
    if (!validated.ok) {
      const review = await ctx.halt(validationReview, `Validation failed for ${target.source} on ${target.night}:\n\n${validated.error}`);
      if (review.action === 'reject') return 'rejected';
    }

    const summary = await ctx.run(summarizer, { source: target.source, report: validated.ok ? validated.value : validated.error });
    if (!summary.ok) return ctx.fail(summary.error);

    await ctx.move('awaiting-approval');
    const approval = await ctx.halt(loadApproval, summary.value.summary);
    if (!approval.approved) return 'rejected';

    await ctx.move('loading');
    const loadedResult = await ctx.run(load, target, { retry: exponentialBackoff });
    if (!loadedResult.ok) return ctx.fail(loadedResult.error);

    const verified = await ctx.run(verify, target);
    if (!verified.ok) return ctx.fail(verified.error);
    if (verified.value.driftPct === 0) return 'loaded';
    return verified.value.driftPct <= tolerableDriftPct
      ? 'loaded-with-warnings'
      : ctx.fail(`drift ${verified.value.driftPct}% exceeds ${tolerableDriftPct}%`);
  });

const nightlyClock = H.clock('nightly-clock', NightlyLoad, { daily: '02:00' }, ({ now }) => {
  const night = now.toISOString().slice(0, 10);
  return sourceSystems.map((source) => ({ create: { source, night }, key: `${source}@${night}` }));
});

const loadLane = H.lane('nightly-loads', NightlyLoad)
  .handler(nightlyLoadFlow)
  .suppliers(nightlyClock)
  .store(sqlite.store(NightlyLoad, '.harness/nightly-loads.sqlite'))
  .retry(failNight);

const approvalExpiresAtNine = H.trigger('approval-expires-at-nine',
  H.on.deadline(NightlyLoad, (data) => new Date(`${data.night}T09:00:00`), ['awaiting-approval']),
  (_event, act) => act.move('load-expired'));

const supervisor = claudeCode.supervisor({
  grants: [H.ops.readWork, H.ops.resolveHalts, H.ops.readMemory, H.ops.writeMemory, H.ops.readTelemetry],
});

export const dataJob = H.harness('nightly-data-job')
  .ledger(sqlite.ledger('.harness/data-job.sqlite'))
  .lanes(loadLane)
  .pools(apiPool)
  .triggers(approvalExpiresAtNine)
  .clients(supervisor)
  .observers(markdown.board('BOARD.md'), markdown.telemetry('TELEMETRY.md'));

export const running = dataJob.start();
