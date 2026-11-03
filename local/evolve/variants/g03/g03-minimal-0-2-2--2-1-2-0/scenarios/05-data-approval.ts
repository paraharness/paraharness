import { z } from 'zod';
import { H } from 'harness-dsl';
import * as claude from 'harness-dsl/claude-code';
import * as anthropic from 'harness-dsl/anthropic';
import * as sqlite from 'harness-dsl/sqlite';
import * as jsonl from 'harness-dsl/jsonl';
import * as shell from 'harness-dsl/shell';
import * as ssh from 'harness-dsl/ssh';
import * as markdown from 'harness-dsl/markdown';

const sources = z.enum(['crm', 'billing', 'inventory', 'web']);

const nightlyLoad = H.kind('NightlyLoad')
  .data(z.object({ source: sources, night: z.string() }))
  .states(
    H.state('scheduled', 'pending'),
    H.state('loaded', 'terminal', 'success'),
    H.state('loadedWithWarnings', 'terminal', 'success'),
    H.state('rejected', 'terminal', 'neutral'),
    H.state('expired', 'terminal', 'neutral'),
    H.state('failed', 'terminal', 'failure')
  );

const loadApproval = H.halt('load-approval', z.object({ approved: z.boolean(), note: z.string().optional() }));
const validationReview = H.halt('validation-review', z.object({ action: z.enum(['continue', 'reject']) })).about(
  z.object({ report: z.string() })
);

const etlHost = ssh.host('etl-host', { address: '10.0.1.20', user: 'etl', key: H.env('ETL_SSH_KEY'), slots: 2 });
const local = shell.local('local', { slots: 2 });

const unitShape = z.object({ source: sources, night: z.string() });
const exponential = { first: { minutes: 2 }, factor: 2, max: { minutes: 30 } };

const extract = H.command('extract')
  .input(unitShape)
  .argv(i => ['./etl/extract', i.source, i.night])
  .on(etlHost)
  .retries(3, exponential)
  .recovery('rerun');

const validate = H.command('validate')
  .input(unitShape)
  .argv(i => ['./etl/validate', i.source, i.night])
  .on(local)
  .recovery('rerun');

const load = H.command('load')
  .input(unitShape)
  .argv(i => ['./etl/load', i.source, i.night])
  .on(etlHost)
  .retries(3, exponential)
  .recovery('park');

const verify = H.command('verify')
  .input(unitShape)
  .output(z.object({ drift: z.number() }))
  .argv(i => ['./etl/verify', i.source, i.night])
  .on(local)
  .recovery('rerun');

const summaryRole = H.role('anomaly-summarizer')
  .input(z.object({ source: sources, report: z.string() }))
  .output(z.object({ summary: z.string() }))
  .prompt(i => `Summarize anomalies for the ${i.source} load in plain language:\n\n${i.report}`);

const approverTaste = H.journal(
  'approver-taste',
  H.memory('taste', 'taste'),
  jsonl.memory('memory/taste.jsonl'),
  H.policy.recall('specific-first', view => view.ranked.slice(0, 8))
);

const summarizer = H.seat('summarizer', summaryRole).model(anthropic.model('claude-sonnet')).recalls(approverTaste);

const nightly = H.flow('nightly-load').for(nightlyLoad).does(async ctx => {
  const input = { source: ctx.unit.data.source, night: ctx.unit.data.night };
  const extracted = await ctx.run(extract, input);
  if (!extracted.ok) return ctx.fail(extracted);
  const validated = await ctx.run(validate, input);
  if (!validated.ok) {
    const review = await ctx.halt(validationReview, `Validation failed for ${input.source}`, { report: validated.error });
    if (review.action === 'reject') return 'rejected';
  }
  const report = validated.ok ? validated.value : validated.error;
  const summarized = await ctx.run(summarizer, { source: input.source, report });
  if (!summarized.ok) return ctx.fail(summarized);
  const decision = await ctx.halt(loadApproval, summarized.value.summary);
  if (!decision.approved) return 'rejected';
  const loaded = await ctx.run(load, input);
  if (!loaded.ok) return ctx.fail(loaded);
  const verified = await ctx.run(verify, input);
  if (!verified.ok) return ctx.fail(verified);
  return verified.value.drift === 0 ? 'loaded' : 'loadedWithWarnings';
});

const atTwo = H.clock('nightly-0200', nightlyLoad, { daily: '02:00' }, tick => {
  const night = tick.now.toISOString().slice(0, 10);
  return sources.options.map(source => tick.create({ source, night }, `${source}-${night}`));
});

const loads = H.lane('nightly-loads', nightlyLoad)
  .handler(nightly)
  .retries(0, 'failed')
  .suppliers(atTwo)
  .store(sqlite.store(nightlyLoad, '.harness/loads.db'));

const approvalCutoff = H.trigger(
  'approval-cutoff-0900',
  H.on.deadline(nightlyLoad, data => new Date(`${data.night}T09:00:00`), ['scheduled']),
  (_event, act) => act.move('expired')
);

const approver = claude.supervisor({
  grants: [H.ops.readWork, H.ops.resolve(loadApproval, validationReview), H.ops.writeMemory, H.ops.readTelemetry],
});

export const harness = H.harness('nightly-data')
  .ledger(sqlite.ledger('.harness/ledger.db'))
  .lanes(loads)
  .pools(H.pool('anthropic', [{ account: anthropic.account('anthropic-api', { apiKey: H.env('ANTHROPIC_API_KEY') }), share: 1 }]))
  .triggers(approvalCutoff)
  .scheduler(H.policy.scheduler('arrival', view => ({ start: view.pending })))
  .clients(approver)
  .observers(markdown.board('BOARD.md'), markdown.telemetry('TELEMETRY.md'));
