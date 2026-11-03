import { z } from 'zod';
import { H } from 'harness-dsl';
import type { SupplyOf } from 'harness-dsl';
import * as claudeCode from 'harness-dsl/claude-code';
import * as anthropic from 'harness-dsl/anthropic';
import * as sqlite from 'harness-dsl/sqlite';
import * as jsonl from 'harness-dsl/jsonl';
import * as ssh from 'harness-dsl/ssh';
import * as markdown from 'harness-dsl/markdown';

const sourceSystems = z.enum(['crm', 'billing', 'inventory', 'web']);
const sourceList = sourceSystems.options;

const scheduled = H.state('scheduled', 'pending');
const loaded = H.state('loaded', 'terminal', 'success');
const loadedWithWarnings = H.state('loadedWithWarnings', 'terminal', 'success');
const rejected = H.state('rejected', 'terminal', 'neutral');
const expired = H.state('expired', 'terminal', 'neutral');
const failed = H.state('failed', 'terminal', 'failure');

const NightlyLoad = H.kind('NightlyLoad')
  .data(z.object({ source: sourceSystems, night: z.string(), cutoff: z.date() }))
  .states(scheduled, loaded, loadedWithWarnings, rejected, expired, failed);

const etlHost = ssh.host('etl', { address: 'etl.internal', user: 'etl', key: H.env('ETL_SSH_KEY'), slots: 2 });

const stepBackoff = { first: { minutes: 1 }, factor: 2, max: { minutes: 15 } };

const extract = H.command('extract')
  .input(z.object({ source: sourceSystems, night: z.string() }))
  .output(z.object({ path: z.string(), rows: z.number() }))
  .argv(input => ['etl', 'extract', input.source, '--night', input.night])
  .on(etlHost)
  .recovery('rerun')
  .retries(3, stepBackoff);

const validate = H.command('validate')
  .input(z.object({ path: z.string() }))
  .output(z.object({ anomalies: z.array(z.string()) }))
  .argv(input => ['etl', 'validate', input.path])
  .on(etlHost)
  .recovery('rerun');

const load = H.command('load')
  .input(z.object({ source: sourceSystems, path: z.string() }))
  .argv(input => ['etl', 'load', input.source, input.path])
  .on(etlHost)
  .retries(3, stepBackoff);

const verify = H.command('verify')
  .input(z.object({ source: sourceSystems, night: z.string() }))
  .output(z.object({ drift: z.number(), tolerable: z.boolean() }))
  .argv(input => ['etl', 'verify', input.source, '--night', input.night])
  .on(etlHost)
  .recovery('rerun');

const summaryRole = H.role('anomalySummary')
  .input(z.object({ source: sourceSystems, rows: z.number(), anomalies: z.array(z.string()) }))
  .output(z.object({ summary: z.string() }))
  .prompt(input => `Summarise in plain language the anomalies in tonight's ${input.source} extract of ${input.rows} rows:\n${input.anomalies.join('\n')}`);

const haiku = anthropic.model('claude-haiku-4-5');
const apiAccount = anthropic.account('anthropic-api', { apiKey: H.env('ANTHROPIC_API_KEY') });
const pool = H.pool('anthropic', [{ account: apiAccount, share: 1, serves: [haiku] }]);

const approverTaste = H.journal('approverTaste', H.memory('approverTaste', 'taste'), jsonl.memory('memory/taste.jsonl'));

const summarizer = H.seat('summarizer', summaryRole).model(haiku).recalls(approverTaste);

const validationReview = H.halt('validationReview', z.object({ action: z.enum(['proceed', 'reject']) }));
const loadApproval = H.halt('loadApproval', z.object({ approved: z.boolean(), note: z.string().optional() }));

const nightly = H.flow('nightlyLoad')
  .for(NightlyLoad)
  .does(async ctx => {
    const { source, night } = ctx.unit.data;
    const extracted = await ctx.run(extract, { source, night });
    if (!extracted.ok) return ctx.fail(extracted.error);
    const validated = await ctx.run(validate, { path: extracted.value.path });
    let anomalies: string[] = [];
    if (validated.ok) {
      anomalies = validated.value.anomalies;
    } else {
      const review = await ctx.halt(validationReview, `Validation failed for ${source}:\n${validated.error}`);
      if (review.action === 'reject') return 'rejected';
      anomalies = [validated.error];
    }
    const summary = await ctx.run(summarizer, { source, rows: extracted.value.rows, anomalies });
    if (!summary.ok) return ctx.fail(summary.error);
    const approval = await ctx.halt(loadApproval, summary.value.summary);
    if (!approval.approved) return 'rejected';
    const loadedRows = await ctx.run(load, { source, path: extracted.value.path });
    if (!loadedRows.ok) return ctx.fail(loadedRows.error);
    const verified = await ctx.run(verify, { source, night });
    if (!verified.ok) return ctx.fail(verified.error);
    if (verified.value.drift === 0) return 'loaded';
    return verified.value.tolerable ? 'loadedWithWarnings' : ctx.fail(`drift ${verified.value.drift} is beyond tolerance`);
  });

const nightlySchedule = H.schedule('nightlyAtTwo', NightlyLoad, { daily: '02:00' }, tick => {
  const night = tick.now.toISOString().slice(0, 10);
  const cutoff = new Date(tick.now.getTime());
  cutoff.setHours(9, 0, 0, 0);
  return sourceList.map((source): SupplyOf<typeof NightlyLoad> => ({
    create: { source, night, cutoff },
    key: `${source}-${night}`,
  }));
});

const loads = H.lane('nightlyLoads', NightlyLoad)
  .handler(nightly)
  .attempts(1, { exhausted: 'failed' })
  .suppliers(nightlySchedule)
  .store(sqlite.store(NightlyLoad, '.harness/loads.sqlite'));

const approvalCutoff = H.trigger(
  'approvalCutoff',
  H.on.deadline(NightlyLoad, data => data.cutoff, ['scheduled']),
  (event, act) => event.unit.position === 'waiting' ? act.move('expired') : [],
);

const supervisor = claudeCode.supervisor({
  grants: [
    H.ops.readWork,
    H.ops.resolve(loadApproval, validationReview, H.halts.interrupted, H.halts.definitionChanged),
    H.ops.writeMemory,
    H.ops.readTelemetry,
  ],
});

export const dataApproval = H.harness('data-approval')
  .ledger(sqlite.ledger('.harness/ledger.sqlite'))
  .lanes(loads)
  .pools(pool)
  .triggers(approvalCutoff)
  .clients(supervisor)
  .observers(markdown.board('BOARD.md'), markdown.telemetry('TELEMETRY.md'));
