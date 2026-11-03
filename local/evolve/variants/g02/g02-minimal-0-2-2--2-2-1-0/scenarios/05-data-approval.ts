import { z } from 'zod';
import { H } from 'harness-dsl';
import * as anthropic from 'harness-dsl/anthropic';
import * as claudeCode from 'harness-dsl/claude-code';
import * as sqlite from 'harness-dsl/sqlite';
import * as jsonl from 'harness-dsl/jsonl';
import * as ssh from 'harness-dsl/ssh';
import * as markdown from 'harness-dsl/markdown';

const sourceSystem = z.enum(['crm', 'billing', 'inventory', 'support']);

const loadDue = H.state('loadDue', 'pending');
const loaded = H.state('loaded', 'terminal', 'success');
const loadedWithWarnings = H.state('loadedWithWarnings', 'terminal', 'success');
const rejected = H.state('rejected', 'terminal', 'neutral');
const loadFailed = H.state('loadFailed', 'terminal', 'failure');
const expired = H.state('expired', 'terminal', 'neutral');

const nightlyLoad = H.kind('NightlyLoad')
  .data(z.object({ source: sourceSystem, night: z.string() }))
  .states(loadDue, loaded, loadedWithWarnings, rejected, loadFailed, expired);

const approverTaste = H.memory('approverTaste', 'taste');
const tasteJournal = H.journal('tasteJournal', approverTaste, jsonl.memory('memory/approver-taste.jsonl'));

const haiku = anthropic.model('claude-haiku-4-5');
const apiAccount = anthropic.account('dataApi', { apiKey: H.env('ANTHROPIC_API_KEY') });
const pool = H.pool('dataPool', [{ account: apiAccount, share: 1 }]);

const etlHost = ssh.host('etlHost', { address: 'etl.internal', user: 'etl', key: H.env('ETL_SSH_KEY'), slots: 2 });

const stepBackoff = { first: { minutes: 1 }, factor: 2, max: { minutes: 30 } };
const sourceInput = z.object({ source: sourceSystem });

const extract = H.command('extract')
  .input(sourceInput)
  .argv(input => ['etl', 'extract', input.source])
  .on(etlHost)
  .recovery('rerun')
  .retries(3, stepBackoff);

const validate = H.command('validate')
  .input(sourceInput)
  .output(z.object({ passed: z.boolean(), report: z.string() }))
  .argv(input => ['etl', 'validate', input.source])
  .on(etlHost)
  .recovery('rerun');

const load = H.command('load')
  .input(sourceInput)
  .argv(input => ['etl', 'load', input.source])
  .on(etlHost)
  .recovery('park')
  .retries(3, stepBackoff);

const verify = H.command('verify')
  .input(sourceInput)
  .output(z.object({ driftPercent: z.number(), tolerable: z.boolean() }))
  .argv(input => ['etl', 'verify', input.source])
  .on(etlHost)
  .recovery('rerun');

const summaryRole = H.role('summarizeAnomalies')
  .input(z.object({ source: sourceSystem, report: z.string() }))
  .output(z.object({ summary: z.string() }))
  .prompt(input => `Summarise in plain language the anomalies in tonight's ${input.source} extract:\n${input.report}`);

const summarizer = H.seat('summarizer', summaryRole).model(haiku).recalls(tasteJournal);

const validationReview = H.halt('validationReview', z.object({ proceed: z.boolean() })).about(z.object({ report: z.string() }));
const loadApproval = H.halt('loadApproval', z.object({ approve: z.boolean(), note: z.string().optional() })).about(
  z.object({ summary: z.string() })
);

const nightlyFlow = H.flow('nightlyLoad')
  .for(nightlyLoad)
  .does(async ctx => {
    const { source } = ctx.unit.data;
    const extracted = await ctx.run(extract, { source });
    if (!extracted.ok) return ctx.fail(extracted.error);
    const validated = await ctx.run(validate, { source });
    if (!validated.ok) return ctx.fail(validated.error);
    if (!validated.value.passed) {
      const review = await ctx.halt(validationReview, `Validation failed for ${source}`, { report: validated.value.report });
      if (!review.proceed) return 'rejected';
    }
    const summary = await ctx.run(summarizer, { source, report: validated.value.report });
    if (!summary.ok) return ctx.fail(summary.error);
    const decision = await ctx.halt(loadApproval, summary.value.summary, { summary: summary.value.summary });
    if (!decision.approve) return 'rejected';
    const applied = await ctx.run(load, { source });
    if (!applied.ok) return ctx.fail(applied.error);
    const verified = await ctx.run(verify, { source });
    if (!verified.ok) return ctx.fail(verified.error);
    if (!verified.value.tolerable) return ctx.fail(`drift of ${verified.value.driftPercent}% is not tolerable`);
    return verified.value.driftPercent > 0 ? 'loadedWithWarnings' : 'loaded';
  });

const nightly = H.schedule('nightlyAtTwo', nightlyLoad, { daily: '02:00' }, tick => {
  const night = tick.now.toISOString().slice(0, 10);
  return sourceSystem.options.map(source => ({ create: { source, night }, key: `${source}-${night}` }));
});

const loads = H.lane('nightlyLoads', nightlyLoad)
  .handler(nightlyFlow)
  .retries(0, { exhausted: 'loadFailed' })
  .suppliers(nightly)
  .store(sqlite.store(nightlyLoad, '.harness/loads.db'));

const approvalWindowCloses = H.trigger(
  'approvalWindowClosesAtNine',
  H.on.deadline(nightlyLoad, data => new Date(`${data.night}T09:00:00`), ['loadDue']),
  (event, act) => act.move('expired')
);

const supervisor = claudeCode.supervisor({
  grants: [
    H.ops.readWork,
    H.ops.resolve(validationReview, loadApproval, H.halts.interrupted, H.halts.definitionChanged),
    H.ops.readMemory,
    H.ops.writeMemory,
    H.ops.readTelemetry,
  ],
});

export const dataJob = H.harness('nightlyData')
  .ledger(sqlite.ledger('.harness/data.db'))
  .lanes(loads)
  .pools(pool)
  .triggers(approvalWindowCloses)
  .clients(supervisor)
  .observers(markdown.board('BOARD.md'), markdown.telemetry('TELEMETRY.md'));

export const running = dataJob.start();
