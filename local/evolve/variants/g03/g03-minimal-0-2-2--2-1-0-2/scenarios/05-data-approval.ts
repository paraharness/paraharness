import { z } from 'zod';
import { H } from 'harness-dsl';
import * as claudeCode from 'harness-dsl/claude-code';
import * as anthropic from 'harness-dsl/anthropic';
import * as sqlite from 'harness-dsl/sqlite';
import * as jsonl from 'harness-dsl/jsonl';
import * as shell from 'harness-dsl/shell';
import * as ssh from 'harness-dsl/ssh';
import * as markdown from 'harness-dsl/markdown';

const scheduled = H.state('scheduled', 'pending');
const loaded = H.state('loaded', 'terminal', 'success');
const loadedWithWarnings = H.state('loaded-with-warnings', 'terminal', 'success');
const rejected = H.state('rejected', 'terminal', 'failure');
const failed = H.state('failed', 'terminal', 'failure');
const expired = H.state('expired', 'terminal', 'neutral');

const nightlyLoad = H.kind('nightly-load')
  .data(z.object({ source: z.string(), night: z.string() }))
  .states(scheduled, loaded, loadedWithWarnings, rejected, failed, expired);

const sources = ['crm', 'billing', 'inventory', 'support'];

const sonnet = anthropic.model('claude-sonnet-4-5');
const api = anthropic.account('data-api', { apiKey: H.env('ANTHROPIC_API_KEY'), serves: [sonnet] });
const models = H.pool('models', [{ account: api, share: 1 }]);

const etlHost = ssh.host('etl-host', { address: 'etl.internal', user: 'etl', key: H.env('ETL_SSH_KEY'), slots: 4 });
const local = shell.local('local', { slots: 4 });

const loadInput = z.object({ source: z.string(), night: z.string() });
const stepBackoff = { first: { minutes: 1 }, factor: 2, max: { minutes: 20 } };

const extract = H.command('extract')
  .input(loadInput)
  .argv(input => ['extract', '--source', input.source, '--night', input.night])
  .on(etlHost)
  .reinvoke(3, stepBackoff)
  .recovery('rerun');

const validate = H.command('validate')
  .input(loadInput)
  .output(z.object({ report: z.string() }))
  .argv(input => ['validate', '--source', input.source, '--night', input.night])
  .on(local)
  .recovery('rerun');

const load = H.command('load')
  .input(loadInput)
  .argv(input => ['load', '--source', input.source, '--night', input.night])
  .on(local)
  .reinvoke(3, stepBackoff)
  .recovery('park');

const verify = H.command('verify')
  .input(loadInput)
  .output(z.object({ driftRatio: z.number() }))
  .argv(input => ['verify', '--source', input.source, '--night', input.night])
  .on(local)
  .recovery('rerun');

const approverTaste = H.memory('approver-taste', 'taste');
const tasteJournal = H.journal('approver-preferences', approverTaste, jsonl.memory('memory/approver-taste.jsonl'));

const summarizing = H.role('anomaly-summarizer')
  .input(z.object({ source: z.string(), report: z.string() }))
  .output(z.object({ summary: z.string() }))
  .prompt(input => `Summarise the anomalies in tonight's ${input.source} extract in plain language.\n\n${input.report}`);

const summarizer = H.seat('anomaly-summarizer', summarizing).model(sonnet).recalls(tasteJournal);

const validationReview = H.halt('validation-review', z.object({ proceed: z.boolean() })).about(
  z.object({ report: z.string() })
);
const loadApproval = H.halt('load-approval', z.object({ approved: z.boolean(), note: z.string().optional() })).about(
  z.object({ source: z.string(), summary: z.string() })
);

const tolerableDriftRatio = 0.01;

const nightly = H.flow('nightly-load')
  .for(nightlyLoad)
  .does(async ctx => {
    const input = { source: ctx.unit.data.source, night: ctx.unit.data.night };
    const extracted = await ctx.run(extract, input);
    if (extracted.ok === false) return ctx.fail(`extract: ${extracted.error}`);
    const validated = await ctx.run(validate, input);
    let report: string;
    if (validated.ok) {
      report = validated.value.report;
    } else {
      const review = await ctx.halt(validationReview, `Validation failed for ${input.source} on ${input.night}`, {
        report: validated.error,
      });
      if (review.proceed === false) return 'rejected';
      report = validated.error;
    }
    const summary = await ctx.run(summarizer, { source: input.source, report });
    if (summary.ok === false) return ctx.fail(`summary: ${summary.error}`);
    const approval = await ctx.halt(loadApproval, summary.value.summary, {
      source: input.source,
      summary: summary.value.summary,
    });
    if (approval.approved === false) return 'rejected';
    const landed = await ctx.run(load, input);
    if (landed.ok === false) return ctx.fail(`load: ${landed.error}`);
    const verified = await ctx.run(verify, input);
    if (verified.ok === false) return ctx.fail(`verify: ${verified.error}`);
    if (verified.value.driftRatio === 0) return 'loaded';
    return verified.value.driftRatio <= tolerableDriftRatio
      ? 'loaded-with-warnings'
      : ctx.fail(`drift ${verified.value.driftRatio} exceeds tolerance`);
  });

const nightlyAtTwo = H.schedule('nightly-at-two', nightlyLoad, { daily: '02:00' }, tick => {
  const night = tick.now.toISOString().slice(0, 10);
  return sources.map(source => ({ create: { source, night }, key: `${source}-${night}` }));
});

const loads = H.lane('nightly-loads', nightlyLoad)
  .handler(nightly)
  .retries(0, { exhausted: 'failed' })
  .suppliers(nightlyAtTwo)
  .store(sqlite.store(nightlyLoad, '.harness/loads.db'));

const approvalWindowCloses = H.trigger(
  'approval-window-closes-at-nine',
  H.on.deadline(nightlyLoad, data => new Date(`${data.night}T09:00:00`), ['scheduled']),
  (event, act) => act.move('expired')
);

const approver = claudeCode.supervisor({
  grants: [
    H.ops.readWork,
    H.ops.resolve(loadApproval, validationReview, H.halts.interrupted),
    H.ops.readMemory,
    H.ops.writeMemory,
    H.ops.readTelemetry,
  ],
});

export const harness = H.harness('nightly-data')
  .ledger(sqlite.ledger('.harness/data.db'))
  .lanes(loads)
  .pools(models)
  .triggers(approvalWindowCloses)
  .clients(approver)
  .observers(markdown.board('BOARD.md'), markdown.telemetry('TELEMETRY.md'));

export const running = harness.start();
