import { H } from 'harness-dsl';
import * as cc from 'harness-dsl/claude-code';
import * as anthropic from 'harness-dsl/anthropic';
import * as sqlite from 'harness-dsl/sqlite';
import * as jsonl from 'harness-dsl/jsonl';
import * as shell from 'harness-dsl/shell';
import * as ssh from 'harness-dsl/ssh';
import * as markdown from 'harness-dsl/markdown';
import { z } from 'zod';

export const NightlyLoad = H.kind('NightlyLoad')
  .data(z.object({ source: z.string(), night: z.string() }))
  .states(
    [
      H.state('queued', 'pending'),
      H.state('loading', 'active'),
      H.state('awaiting-approval', 'active'),
      H.state('loaded', 'terminal', 'success'),
      H.state('loaded-with-warnings', 'terminal', 'success'),
      H.state('rejected', 'terminal', 'neutral'),
      H.state('expired', 'terminal', 'neutral'),
      H.state('failed', 'terminal', 'failure'),
    ],
    { initial: 'queued', afterFailure: 'failed' }
  );

const warehouse = ssh.host('warehouse', {
  address: 'etl.internal',
  user: 'etl',
  key: H.env('ETL_SSH_KEY'),
  slots: 2,
});
const local = shell.local('local', { slots: 2 });

const loadInput = z.object({ source: z.string(), night: z.string() });

const extract = H.command('extract').input(loadInput).argv(i => ['/opt/etl/extract.sh', i.source, i.night]).on(warehouse);
const validate = H.command('validate').input(loadInput).argv(i => ['/opt/etl/validate.sh', i.source, i.night]).on(warehouse);
const load = H.command('load').input(loadInput).argv(i => ['/opt/etl/load.sh', i.source, i.night]).on(warehouse);
const verify = H.command('verify')
  .input(loadInput)
  .output(z.object({ drift: z.number(), tolerable: z.boolean() }))
  .argv(i => ['/opt/etl/verify.sh', i.source, i.night])
  .on(local);

const exponentialBackoff = H.policy.retry('three-retries-exponential-backoff', view =>
  view.failures > 3 ? 'stop' : { retryInMs: 30_000 * 2 ** (view.failures - 1) }
);

const summaryRole = H.role('anomaly-summarizer')
  .input(z.object({ source: z.string(), report: z.string() }))
  .output(z.object({ summary: z.string() }))
  .prompt(i => `Summarise in plain language the anomalies tonight's ${i.source} load shows.\n\n${i.report}`);

const taste = H.memory('approver-taste', 'owner');
const tasteLibrary = H.library('approver-taste', taste, jsonl.memory('.harness/taste.jsonl')).recall(
  H.policy.recall('most-specific-first', view => [...view.items].sort((a, b) => b.specificity - a.specificity).slice(0, 8))
);

const summarizer = H.agent('anomaly-summarizer', summaryRole).model(anthropic.model('claude-haiku-4-5')).recalls(tasteLibrary);

const nightlyLoad = H.flow('nightly-load').for(NightlyLoad).does(async ctx => {
  await ctx.move('loading');
  const input = { source: ctx.unit.data.source, night: ctx.unit.data.night };

  const extracted = await ctx.run(extract, input, { retry: exponentialBackoff });
  if (!extracted.ok) return ctx.fail(extracted.error);

  const validated = await ctx.run(validate, input);
  if (!validated.ok) {
    const review = await ctx.halt({
      name: 'validation-failed',
      show: validated.error,
      decision: z.object({ proceed: z.boolean() }),
    });
    if (!review.proceed) return 'rejected';
  }
  const report = validated.ok ? validated.value : validated.error;

  const summary = await ctx.run(summarizer, { source: input.source, report });
  if (!summary.ok) return ctx.fail(summary.error);

  await ctx.move('awaiting-approval');
  const approval = await ctx.halt({
    name: 'approve-load',
    show: summary.value.summary,
    decision: z.object({ approved: z.boolean(), emphasis: z.string().optional() }),
  });
  if (approval.emphasis) {
    await ctx.remember(tasteLibrary, {
      text: approval.emphasis,
      when: { kinds: [NightlyLoad.name], roles: [summaryRole.name] },
      status: 'accepted',
    });
  }
  if (!approval.approved) return 'rejected';

  await ctx.move('loading');
  const loaded = await ctx.run(load, input, { retry: exponentialBackoff });
  if (!loaded.ok) return ctx.fail(loaded.error);

  const verified = await ctx.run(verify, input);
  if (!verified.ok) return ctx.fail(verified.error);
  if (verified.value.drift === 0) return 'loaded';
  if (verified.value.tolerable) return 'loaded-with-warnings';
  return ctx.fail(`drift of ${verified.value.drift} is beyond tolerance`);
});

const sourceSystems = ['billing', 'crm', 'inventory', 'web-analytics'];

const nightlyCalendar = H.calendar('nightly-loads', NightlyLoad, { daily: '02:00' }, tick => {
  const night = tick.now.toISOString().slice(0, 10);
  return sourceSystems.map(source => ({ create: { source, night }, key: `${source}-${night}` }));
});

const loadLane = H.lane('nightly-loads', NightlyLoad)
  .handler(nightlyLoad)
  .suppliers(nightlyCalendar)
  .store(sqlite.store(NightlyLoad, '.harness/loads.db'));

const approvalExpires = H.trigger(
  'unapproved-load-expires-at-nine',
  H.on.cadence(NightlyLoad, { daily: '09:00' }, ['awaiting-approval']),
  (_event, act) => act.move('expired')
);

const apiAccount = anthropic.account('anthropic-api', { apiKey: H.env('ANTHROPIC_API_KEY') });
const firstEligible = H.policy.account('first-eligible', choice => choice.accounts.find(view => view.eligible)?.account ?? null);

const oldestFirst = H.policy.scheduler('oldest-first', view => ({
  start: [...view.pending].sort((a, b) => b.waitedMs - a.waitedMs),
}));

export const dataJob = H.harness('nightly-data-job')
  .ledger(sqlite.ledger('.harness/ledger.db'))
  .lanes(loadLane)
  .pools(H.pool('anthropic', [{ account: apiAccount, share: 1 }], firstEligible))
  .triggers(approvalExpires)
  .scheduler(oldestFirst)
  .clients(cc.supervisor({ grants: [H.ops.readWork, H.ops.resolveHalts, H.ops.writeMemory, H.ops.readTelemetry] }))
  .observers(markdown.board('BOARD.md'), markdown.telemetry('TELEMETRY.md'));
