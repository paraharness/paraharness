import { z } from 'zod';
import { H } from 'harness-dsl';
import * as anthropic from 'harness-dsl/anthropic';
import * as sqlite from 'harness-dsl/sqlite';
import * as jsonl from 'harness-dsl/jsonl';
import * as shell from 'harness-dsl/shell';
import * as ssh from 'harness-dsl/ssh';
import * as claudeCode from 'harness-dsl/claude-code';
import * as markdown from 'harness-dsl/markdown';

const sources = H.resources('source-systems', ['crm', 'billing', 'inventory', 'web']);

const NightlyLoad = H.kind('NightlyLoad')
  .data(z.object({ source: sources.schema, night: z.string() }))
  .states({
    queued: 'pending',
    extracting: 'active',
    'awaiting-approval': 'active',
    loading: 'active',
    loaded: 'success',
    'loaded-with-warnings': 'success',
    rejected: 'neutral',
    expired: 'neutral',
    failed: 'failure',
  }, 'queued')
  .onFailure('failed');

const approverTaste = H.memory('approver-taste', 'owner');
const tasteLibrary = H.library('approver-taste', approverTaste, jsonl.memory('memory/taste.jsonl')).recall(
  H.policy.recall('most-specific', view => [...view.items].sort((a, b) => b.specificity - a.specificity).slice(0, 8))
);

const quota = sqlite.quota('.harness/quota.sqlite');
const apiAccount = anthropic.account('anthropic-api', { apiKey: H.env('ANTHROPIC_API_KEY'), quota });
const apiPool = H.pool(
  'api',
  [{ account: apiAccount, share: 1 }],
  H.policy.account('first-eligible', choice => choice.accounts.find(view => view.eligible)?.account ?? null)
);

const local = shell.local('local', { slots: 2 });
const warehouseHost = ssh.host('etl-host', {
  address: 'etl.internal',
  user: 'etl',
  key: H.env('ETL_SSH_KEY'),
  slots: 2,
});

const exponentialBackoff = H.policy.retry('three-times-exponential', view =>
  view.failures > 3 ? 'stop' : { retryInMs: 30000 * 2 ** (view.failures - 1) }
);

const extract = H.command('extract')
  .input(z.object({ source: sources.schema }))
  .argv(input => ['/opt/etl/extract.sh', input.source])
  .on(warehouseHost)
  .restart('rerun');

const validate = H.command('validate')
  .input(z.object({ source: sources.schema }))
  .argv(input => ['/opt/etl/validate.sh', input.source])
  .on(local)
  .restart('rerun');

const load = H.command('load')
  .input(z.object({ source: sources.schema }))
  .argv(input => ['/opt/etl/load.sh', input.source])
  .on(warehouseHost);

const verify = H.command('verify')
  .input(z.object({ source: sources.schema }))
  .output(z.object({ drift: z.number(), tolerable: z.boolean() }))
  .argv(input => ['/opt/etl/verify.sh', '--json', input.source])
  .on(local)
  .restart('rerun');

const summarizerRole = H.role('anomaly-summarizer')
  .input(z.object({ source: z.string(), validation: z.string() }))
  .output(z.object({ summary: z.string(), anomalies: z.array(z.string()) }))
  .prompt(input => `Summarize, in plain language for the approver, the anomalies in tonight's ${input.source} extract.\n\nValidation report:\n${input.validation}`);

const summarizer = H.agent('anomaly-summarizer', summarizerRole)
  .model(anthropic.model('claude-sonnet-4-5'))
  .recalls(tasteLibrary);

const nightlyLoad = H.flow('nightly-load')
  .for(NightlyLoad)
  .does(async ctx => {
    const source = ctx.unit.data.source;
    await ctx.move('extracting');
    const extracted = await ctx.run(extract, { source }, { retry: exponentialBackoff });
    if (extracted.ok === false) return ctx.fail(`extract: ${extracted.error}`);

    const validated = await ctx.run(validate, { source });
    if (validated.ok === false) {
      const override = await ctx.halt({
        name: 'validation-failed',
        show: validated.error,
        decision: z.object({ proceed: z.boolean() }),
      });
      if (override.proceed === false) return 'rejected';
    }
    const report = validated.ok ? validated.value : validated.error;

    const summary = await ctx.run(summarizer, { source, validation: report });
    if (summary.ok === false) return ctx.fail(`summary: ${summary.error}`);

    await ctx.move('awaiting-approval');
    const approval = await ctx.halt({
      name: 'approve-load',
      show: summary.value.summary,
      decision: z.object({ approved: z.boolean(), note: z.string().optional() }),
    });
    if (approval.approved === false) return 'rejected';

    await ctx.move('loading');
    const loaded = await ctx.run(load, { source }, { retry: exponentialBackoff });
    if (loaded.ok === false) return ctx.fail(`load: ${loaded.error}`);

    const verified = await ctx.run(verify, { source });
    if (verified.ok === false) return 'failed';
    if (verified.value.drift === 0) return 'loaded';
    return verified.value.tolerable ? 'loaded-with-warnings' : 'failed';
  });

const twoAm = H.recurring('nightly-at-two', NightlyLoad, { daily: '02:00' }, tick => {
  const night = tick.now.toISOString().slice(0, 10);
  return sources.ids.map(source => ({ create: { source, night }, key: `${source}-${night}` }));
});

const loads = H.lane('nightly-loads', NightlyLoad)
  .handler(nightlyLoad)
  .suppliers(twoAm)
  .store(sqlite.store(NightlyLoad, '.harness/loads.sqlite'))
  .touches(data => [sources.of(data.source)]);

const approvalExpires = H.trigger(
  'approval-expires-at-nine',
  H.on.time(NightlyLoad, { daily: '09:00' }, ['awaiting-approval']),
  (_event, act) => act.move('expired')
);

const oldestFirst = H.policy.scheduler('oldest-first', view => ({
  start: [...view.pending].sort((a, b) => b.waitedMs - a.waitedMs),
}));

const supervisor = claudeCode.supervisor({
  grants: [H.ops.readWork, H.ops.resolveHalts, H.ops.readMemory, H.ops.writeMemory, H.ops.readTelemetry],
});

export default H.harness('nightly-data')
  .ledger(sqlite.ledger('.harness/ledger.sqlite'))
  .lanes(loads)
  .pools(apiPool)
  .triggers(approvalExpires)
  .scheduler(oldestFirst)
  .clients(supervisor)
  .observers(markdown.board('BOARD.md'), markdown.telemetry('TELEMETRY.md'));
