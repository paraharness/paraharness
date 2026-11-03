import { z } from 'zod';
import { H } from 'harness-dsl';
import * as anthropic from 'harness-dsl/anthropic';
import * as claudeCode from 'harness-dsl/claude-code';
import * as sqlite from 'harness-dsl/sqlite';
import * as jsonl from 'harness-dsl/jsonl';
import * as ssh from 'harness-dsl/ssh';
import * as markdown from 'harness-dsl/markdown';

const scheduled = H.state('scheduled', 'pending');
const loaded = H.state('loaded', 'terminal', 'success');
const loadedWithWarnings = H.state('loaded-with-warnings', 'terminal', 'success');
const rejected = H.state('rejected', 'terminal', 'neutral');
const expired = H.state('expired', 'terminal', 'neutral');
const failed = H.state('failed', 'terminal', 'failure');

const nightlyLoad = H.kind('NightlyLoad')
  .data(z.object({ source: z.string(), night: z.string() }))
  .states(scheduled, loaded, loadedWithWarnings, rejected, expired, failed);

const sourceSystems: readonly string[] = ['crm', 'billing', 'inventory', 'web'];

const etlHost = ssh.host('etl-host', {
  address: 'etl.internal',
  user: 'etl',
  key: H.env('ETL_SSH_KEY'),
  slots: 2,
});

const loadInput = z.object({ source: z.string(), night: z.string() });
const backoff = { first: { minutes: 2 }, factor: 2, max: { minutes: 30 } };

const extract = H.command('extract')
  .input(loadInput)
  .argv(input => ['etl', 'extract', input.source, input.night])
  .on(etlHost)
  .retries(3, backoff)
  .recovery('rerun');

const validate = H.command('validate')
  .input(loadInput)
  .output(z.object({ rows: z.number(), anomalies: z.array(z.string()) }))
  .argv(input => ['etl', 'validate', input.source, input.night])
  .on(etlHost)
  .recovery('rerun');

const load = H.command('load')
  .input(loadInput)
  .argv(input => ['etl', 'load', input.source, input.night])
  .on(etlHost)
  .retries(3, backoff)
  .recovery('park');

const verify = H.command('verify')
  .input(loadInput)
  .output(z.object({ driftPercent: z.number() }))
  .argv(input => ['etl', 'verify', input.source, input.night])
  .on(etlHost)
  .recovery('rerun');

const approverTaste = H.memory('approver-taste', 'taste');
const tasteJournal = H.journal('approver-taste', approverTaste, jsonl.memory('./memory/approver-taste.jsonl'));

const summarizerRole = H.role('anomaly-summarizer')
  .input(z.object({ source: z.string(), rows: z.number(), anomalies: z.array(z.string()) }))
  .output(z.object({ summary: z.string() }))
  .prompt(input => `Summarise in plain language the anomalies in tonight's ${input.source} load (${input.rows} rows):\n${input.anomalies.join('\n')}`);

const apiAccount = anthropic.account('data-api', { apiKey: H.env('ANTHROPIC_API_KEY') });
const pool = H.pool('anthropic', [{ account: apiAccount, share: 1 }]);

const summarizer = H.seat('anomaly-summarizer', summarizerRole)
  .model(anthropic.model('claude-sonnet-4-5'))
  .recalls(tasteJournal);

const validationReview = H.halt('validation-review', z.object({ proceed: z.boolean(), note: z.string() }))
  .about(z.object({ source: z.string(), report: z.string() }));
const loadApproval = H.halt('load-approval', z.object({ approved: z.boolean(), note: z.string() }));

const nightly = H.flow('nightly-load')
  .for(nightlyLoad)
  .does(async ctx => {
    const { source, night } = ctx.unit.data;
    const extracted = await ctx.run(extract, { source, night });
    if (!extracted.ok) return ctx.fail(extracted.error);
    const validated = await ctx.run(validate, { source, night });
    let rows = 0;
    let anomalies: string[] = [];
    if (validated.ok) {
      rows = validated.value.rows;
      anomalies = validated.value.anomalies;
    } else {
      const review = await ctx.halt(validationReview, `Validation failed for ${source} on ${night}`, { source, report: validated.error });
      if (!review.proceed) return 'rejected';
      anomalies = [validated.error, review.note];
    }
    const summary = await ctx.run(summarizer, { source, rows, anomalies });
    if (!summary.ok) return ctx.fail(summary.error);
    const approval = await ctx.halt(loadApproval, summary.value.summary);
    if (!approval.approved) return 'rejected';
    const loadedResult = await ctx.run(load, { source, night });
    if (!loadedResult.ok) return ctx.fail(loadedResult.error);
    const verified = await ctx.run(verify, { source, night });
    if (!verified.ok) return ctx.fail(verified.error);
    if (verified.value.driftPercent === 0) return 'loaded';
    return verified.value.driftPercent <= 0.5 ? 'loaded-with-warnings' : 'failed';
  });

const nightlySchedule = H.clock('nightly-at-two', nightlyLoad, { daily: '02:00' }, tick => {
  const night = tick.now.toISOString().slice(0, 10);
  return sourceSystems.map(source => ({ create: { source, night }, key: `${source}-${night}` }));
});

const loads = H.lane('nightly-loads', nightlyLoad)
  .handler(nightly)
  .retry({ times: 0, exhausted: 'failed' })
  .suppliers(nightlySchedule)
  .store(sqlite.store(nightlyLoad, './.harness/loads.sqlite'));

const expireAtNine = H.trigger(
  'expire-unapproved-at-nine',
  H.on.deadline(nightlyLoad, data => new Date(`${data.night}T09:00:00Z`), ['scheduled']),
  (_event, act) => act.move('expired'),
);

const supervisor = claudeCode.supervisor({
  grants: [
    H.ops.readWork,
    H.ops.resolve(loadApproval, validationReview, H.halts.interrupted, H.halts.definitionChanged),
    H.ops.readMemory,
    H.ops.writeMemory,
    H.ops.readTelemetry,
  ],
});

const harness = H.harness('nightly-data')
  .ledger(sqlite.ledger('./.harness/nightly-data.sqlite'))
  .lanes(loads)
  .pools(pool)
  .triggers(expireAtNine)
  .clients(supervisor)
  .observers(markdown.board('./BOARD.md'), markdown.telemetry('./TELEMETRY.md'));

export const running = harness.start();
