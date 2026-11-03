import { z } from 'zod';
import { H } from 'harness-dsl';
import * as claudeCode from 'harness-dsl/claude-code';
import * as anthropic from 'harness-dsl/anthropic';
import * as sqlite from 'harness-dsl/sqlite';
import * as jsonl from 'harness-dsl/jsonl';
import * as ssh from 'harness-dsl/ssh';
import * as markdown from 'harness-dsl/markdown';

const nightlyLoad = H.kind('nightly-load')
  .data(z.object({ source: z.string(), night: z.string() }))
  .states(
    H.state('scheduled', 'pending'),
    H.state('loaded', 'terminal', 'success'),
    H.state('loaded-with-warnings', 'terminal', 'success'),
    H.state('rejected', 'terminal', 'failure'),
    H.state('failed', 'terminal', 'failure'),
    H.state('expired', 'terminal', 'neutral')
  );

const sonnet = anthropic.model('claude-sonnet-4-5');
const dataPool = H.pool('data', [
  { account: anthropic.account('data-api', { apiKey: H.env('ANTHROPIC_API_KEY') }), share: 1 },
]).serves(sonnet);

const tasteKind = H.memory('approver-taste', 'taste');
const approverTaste = H.journal('approver-taste', tasteKind, jsonl.memory('.harness/approver-taste.jsonl'));

const etlHost = ssh.host('etl-host', { address: 'etl.internal', user: 'etl', key: H.env('ETL_SSH_KEY'), slots: 2 });

const sourceInput = z.object({ source: z.string() });
const backoff = { first: { minutes: 2 }, factor: 2, max: { minutes: 30 } };

const extract = H.command('extract')
  .input(sourceInput)
  .argv(input => ['etl', 'extract', input.source])
  .on(etlHost)
  .reinvokes(3, backoff)
  .recovery('rerun');

const validate = H.command('validate')
  .input(sourceInput)
  .argv(input => ['etl', 'validate', input.source])
  .on(etlHost)
  .recovery('rerun');

const load = H.command('load')
  .input(sourceInput)
  .argv(input => ['etl', 'load', input.source])
  .on(etlHost)
  .reinvokes(3, backoff);

const verify = H.command('verify')
  .input(sourceInput)
  .output(z.object({ driftPercent: z.number() }))
  .argv(input => ['etl', 'verify', input.source])
  .on(etlHost)
  .recovery('rerun');

const summarizerRole = H.role('anomaly-summarizer')
  .input(z.object({ source: z.string(), report: z.string() }))
  .output(z.object({ summary: z.string() }))
  .prompt(input => `Summarize, in plain language, the anomalies in tonight's ${input.source} extract.\n\n${input.report}`);

const summarizer = H.seat('anomaly-summarizer', summarizerRole).model(sonnet).recalls(approverTaste);

const validationReview = H.halt('validation-review', z.object({ proceed: z.boolean(), note: z.string().optional() }));
const loadApproval = H.halt('load-approval', z.object({ approved: z.boolean(), note: z.string().optional() }));

const nightly = H.flow('nightly-load')
  .for(nightlyLoad)
  .does(async ctx => {
    const target = { source: ctx.unit.data.source };
    const extracted = await ctx.run(extract, target);
    if (!extracted.ok) return ctx.fail(extracted.error);
    const validated = await ctx.run(validate, target);
    const report = validated.ok ? validated.value : validated.error;
    if (!validated.ok) {
      const review = await ctx.halt(validationReview, report);
      if (!review.proceed) return 'failed';
    }
    const summarized = await ctx.run(summarizer, { source: ctx.unit.data.source, report });
    if (!summarized.ok) return ctx.fail(summarized.error);
    const approval = await ctx.halt(loadApproval, summarized.value.summary);
    if (!approval.approved) return 'rejected';
    const loaded = await ctx.run(load, target);
    if (!loaded.ok) return ctx.fail(loaded.error);
    const verified = await ctx.run(verify, target);
    if (!verified.ok) return ctx.fail(verified.error);
    if (verified.value.driftPercent > 2) return ctx.fail(`drift ${verified.value.driftPercent}% exceeds tolerance`);
    return verified.value.driftPercent > 0 ? 'loaded-with-warnings' : 'loaded';
  });

const sourceSystems = ['crm', 'billing', 'inventory', 'web-analytics'];

const nightlySchedule = H.schedule('two-am', nightlyLoad, { daily: '02:00' }, (tick, supply) => {
  const night = tick.now.toISOString().slice(0, 10);
  return sourceSystems.map(source => supply.create({ source, night }, { key: `${source}-${night}` }));
});

const loads = H.lane('nightly-loads', nightlyLoad)
  .handler(nightly)
  .retries(0, { exhausted: 'failed' })
  .suppliers(nightlySchedule)
  .store(sqlite.store(nightlyLoad, '.harness/loads.db'));

const approvalExpires = H.trigger(
  'approval-expires-at-nine',
  H.on.deadline(nightlyLoad, data => new Date(`${data.night}T09:00:00`), ['scheduled'], loadApproval),
  (event, act) => act.move('expired')
);

export const dataJob = H.harness('nightly-data')
  .ledger(sqlite.ledger('.harness/data-ledger.db'))
  .lanes(loads)
  .pools(dataPool)
  .triggers(approvalExpires)
  .clients(
    claudeCode.supervisor({
      grants: [
        H.ops.readWork,
        H.ops.resolve(loadApproval, validationReview, H.halts.interrupted, H.halts.definitionChanged),
        H.ops.readMemory,
        H.ops.writeMemory,
        H.ops.readTelemetry,
      ],
    })
  )
  .observers(markdown.board('BOARD.md'), markdown.telemetry('TELEMETRY.md'));
