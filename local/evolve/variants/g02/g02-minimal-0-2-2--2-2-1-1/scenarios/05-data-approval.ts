import { z } from 'zod';
import { H } from 'harness-dsl';
import * as anthropic from 'harness-dsl/anthropic';
import * as claude from 'harness-dsl/claude-code';
import * as sqlite from 'harness-dsl/sqlite';
import * as jsonl from 'harness-dsl/jsonl';
import * as ssh from 'harness-dsl/ssh';
import * as markdown from 'harness-dsl/markdown';

const queued = H.state('queued', 'pending');
const loaded = H.state('loaded', 'terminal', 'success');
const loadedWithWarnings = H.state('loaded-with-warnings', 'terminal', 'success');
const rejected = H.state('rejected', 'terminal', 'neutral');
const expired = H.state('expired', 'terminal', 'neutral');
const failed = H.state('failed', 'terminal', 'failure');

const sourceSystems = z.enum(['crm', 'billing', 'inventory', 'web-analytics']);

const nightlyLoad = H.kind('nightly-load')
  .data(z.object({ source: sourceSystems, night: z.string(), approvalCutoff: z.string() }))
  .states(queued, loaded, loadedWithWarnings, rejected, expired, failed);

const approverTaste = H.memory('approver-taste', 'taste');
const tasteLibrary = H.library('approver-taste', approverTaste, jsonl.memory('.harness/approver-taste.jsonl'));

const sonnet = anthropic.model('claude-sonnet-4-5');
const api = anthropic.account('anthropic-api', { apiKey: H.env('ANTHROPIC_API_KEY') });
const pool = H.pool('anthropic', [{ account: api, share: 1 }]);

const etlHost = ssh.host('etl-host', { address: 'etl.internal', user: 'etl', key: H.env('ETL_SSH_KEY'), slots: 2 });

const stepBackoff = { first: { minutes: 2 }, factor: 2, max: { minutes: 30 } };

const extract = H.command('extract')
  .input(z.object({ source: sourceSystems }))
  .output(z.object({ path: z.string(), rows: z.number() }))
  .argv(input => ['./bin/extract', input.source])
  .on(etlHost)
  .retries(3, stepBackoff)
  .recovery('rerun');

const validate = H.command('validate')
  .input(z.object({ path: z.string() }))
  .output(z.object({ ok: z.boolean(), report: z.string(), anomalies: z.array(z.string()) }))
  .argv(input => ['./bin/validate', input.path])
  .on(etlHost)
  .recovery('rerun');

const load = H.command('load')
  .input(z.object({ source: sourceSystems, path: z.string() }))
  .argv(input => ['./bin/load', input.source, input.path])
  .on(etlHost)
  .retries(3, stepBackoff)
  .recovery('park');

const verify = H.command('verify')
  .input(z.object({ source: sourceSystems }))
  .output(z.object({ drift: z.number(), tolerable: z.boolean() }))
  .argv(input => ['./bin/verify', input.source])
  .on(etlHost)
  .recovery('rerun');

const summaryRole = H.role('anomaly-summary')
  .input(z.object({ source: sourceSystems, rows: z.number(), anomalies: z.array(z.string()), report: z.string() }))
  .output(z.object({ summary: z.string() }))
  .prompt(
    input =>
      `Summarise in plain language the anomalies in tonight's ${input.source} extract (${input.rows} rows):\n${input.anomalies.join('\n')}\n\n${input.report}`
  );

const summarizer = H.seat('summarizer', summaryRole).model(sonnet).recalls(tasteLibrary);

const validationReview = H.halt('validation-review', z.object({ action: z.enum(['continue', 'reject']) })).about(
  z.object({ source: sourceSystems, report: z.string() })
);

const loadApproval = H.halt('load-approval', z.object({ approve: z.boolean(), note: z.string().optional() })).about(
  z.object({ source: sourceSystems, summary: z.string() })
);

const nightlyFlow = H.flow('nightly-load')
  .for(nightlyLoad)
  .does(async ctx => {
    const source = ctx.unit.data.source;
    const extracted = await ctx.run(extract, { source });
    if (!extracted.ok) return ctx.fail(extracted.error);
    const validated = await ctx.run(validate, { path: extracted.value.path });
    if (!validated.ok) return ctx.fail(validated.error);
    if (!validated.value.ok) {
      const review = await ctx.halt(validationReview, validated.value.report, { source, report: validated.value.report });
      if (review.action === 'reject') return 'rejected';
    }
    const summary = await ctx.run(summarizer, {
      source,
      rows: extracted.value.rows,
      anomalies: validated.value.anomalies,
      report: validated.value.report,
    });
    if (!summary.ok) return ctx.fail(summary.error);
    const approval = await ctx.halt(loadApproval, summary.value.summary, { source, summary: summary.value.summary });
    if (!approval.approve) return 'rejected';
    const loadResult = await ctx.run(load, { source, path: extracted.value.path });
    if (!loadResult.ok) return ctx.fail(loadResult.error);
    const verified = await ctx.run(verify, { source });
    if (!verified.ok) return ctx.fail(verified.error);
    if (verified.value.drift === 0) return 'loaded';
    return verified.value.tolerable ? 'loaded-with-warnings' : ctx.fail(`drift ${verified.value.drift} is not tolerable`);
  });

const nightlyClock = H.clock('nightly-load-clock', nightlyLoad, { daily: '02:00' }, tick => {
  const night = tick.now.toISOString().slice(0, 10);
  const cutoff = new Date(tick.now);
  cutoff.setHours(9, 0, 0, 0);
  return sourceSystems.options.map(source => ({
    create: { source, night, approvalCutoff: cutoff.toISOString() },
    key: `${source}-${night}`,
  }));
});

const nightlyLoads = H.lane('nightly-loads', nightlyLoad)
  .handler(nightlyFlow)
  .retries(0, { exhausted: 'failed' })
  .suppliers(nightlyClock)
  .store(sqlite.store(nightlyLoad, '.harness/nightly-loads.sqlite'));

const approvalWindowCloses = H.trigger(
  'approval-window-closes',
  H.on.deadline(nightlyLoad, data => new Date(data.approvalCutoff), ['queued']),
  (_event, act) => act.move('expired')
);

const approver = claude.supervisor('approver', {
  grants: [
    H.ops.readWork,
    H.ops.resolve(loadApproval, validationReview, H.halts.interrupted, H.halts.definitionChanged),
    H.ops.readMemory,
    H.ops.writeMemory,
    H.ops.readTelemetry,
  ],
});

export const dataApproval = H.harness('data-approval')
  .ledger(sqlite.ledger('.harness/ledger.sqlite'))
  .lanes(nightlyLoads)
  .pools(pool)
  .triggers(approvalWindowCloses)
  .clients(approver)
  .observers(markdown.board('BOARD.md'), markdown.telemetry('TELEMETRY.md'));
