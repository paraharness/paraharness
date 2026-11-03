import { z } from 'zod';
import { H } from 'harness-dsl';
import { sqlite } from 'harness-dsl/sqlite';
import { jsonl } from 'harness-dsl/jsonl';
import { anthropic } from 'harness-dsl/anthropic';
import { claudeCode } from 'harness-dsl/claude-code';
import { local } from 'harness-dsl/local';
import { ssh } from 'harness-dsl/ssh';
import { markdown } from 'harness-dsl/markdown';

const LoadSchema = z.object({
  source: z.enum(['billing', 'crm', 'inventory', 'web']),
});
type LoadAttrs = z.infer<typeof LoadSchema>;

const Scheduled = H.state('Scheduled', 'pending');
const Extracting = H.state('Extracting', 'active');
const Validating = H.state('Validating', 'active');
const AwaitingApproval = H.state('AwaitingApproval', 'active');
const Loading = H.state('Loading', 'active');
const Loaded = H.terminal('Loaded', 'success');
const LoadedWithWarnings = H.terminal('LoadedWithWarnings', 'success');
const Rejected = H.terminal('Rejected', 'neutral');
const Failed = H.terminal('Failed', 'failure');
const Expired = H.terminal('Expired', 'neutral');

const NightlyLoad = H.kind('NightlyLoad')
  .attributes(LoadSchema)
  .states(Scheduled, Extracting, Validating, AwaitingApproval, Loading, Loaded, LoadedWithWarnings, Rejected, Failed, Expired)
  .key(a => a.source)
  .initial(Scheduled)
  .onAttemptFailed(Failed)
  .onCancelled(Expired);

const warehouse = ssh.host('warehouse', { host: 'warehouse.internal', user: 'etl', key: H.env('ETL_SSH_KEY') }).slots(2);
const localRunner = local.runner('local');

const extract = H.command('extract')
  .input(LoadSchema)
  .argv(i => ['/opt/etl/extract.sh', i.source])
  .runner(warehouse);

const validate = H.command('validate')
  .input(LoadSchema)
  .argv(i => ['/opt/etl/validate.sh', i.source])
  .acceptExitCodes(0, 1)
  .runner(localRunner);

const load = H.command('load')
  .input(LoadSchema)
  .argv(i => ['/opt/etl/load.sh', i.source])
  .runner(warehouse);

const verify = H.command('verify')
  .input(LoadSchema)
  .argv(i => ['/opt/etl/verify.sh', i.source])
  .acceptExitCodes(0, 3)
  .runner(warehouse);

const backoff = H.retry({ maxAttempts: 3, backoff: 'exponential', initialDelayMs: 60_000, maxDelayMs: 900_000 });

const etlAccount = anthropic.account('etl-api', { apiKey: H.env('ANTHROPIC_API_KEY') });
const etlPool = H.pool('etl').accounts(etlAccount);

const summarizerRole = H.role('anomalySummarizer')
  .instructions('Summarise the anomalies in the validation report in plain language for the approver.');

const summarizer = H.agent('anomalySummarizer')
  .role(summarizerRole)
  .model(anthropic.model('sonnet', { id: 'claude-sonnet-4-5' }))
  .output(z.object({ summary: z.string() }));

const ApproverTaste = H.memory('approverTaste').trust('taste');

const approverTaste = H.journal('approverTaste', ApproverTaste)
  .store(jsonl.memoryStore({ path: '.harness/memory/approver-taste.jsonl' }))
  .recall(H.recall('bySpecificity', { by: 'specificity', limit: 8 }))
  .readBy(summarizerRole);

const ValidationDecision = z.object({ proceed: z.boolean(), notes: z.string() });
type ValidationDecisionValue = z.infer<typeof ValidationDecision>;

const sourceOf = (attrs: LoadAttrs): LoadAttrs => ({ source: attrs.source });

const loadFlow = H.flow('nightlyLoad')
  .input(LoadSchema)
  .step('extract', extract, ctx => sourceOf(ctx.unit.attributes), { retry: backoff, afterCrash: 'rerun' })
  .step('validate', validate, ctx => sourceOf(ctx.unit.attributes), { afterCrash: 'rerun' })
  .halt('validationReview', {
    ask: ctx => `Validation of ${ctx.unit.attributes.source} failed. Report:\n${ctx.steps.validate.stdout}`,
    decision: ValidationDecision,
    skip: (ctx): ValidationDecisionValue | undefined =>
      ctx.steps.validate.exitCode === 0 ? { proceed: true, notes: 'validation passed' } : undefined,
  })
  .exit('invalid', ctx => ctx.steps.validationReview.proceed === false)
  .step('summarize', summarizer, ctx => ({
    task: `Validation report for ${ctx.unit.attributes.source}:\n${ctx.steps.validate.stdout}`,
    skills: [ctx.unit.attributes.source],
  }))
  .halt('approval', {
    ask: ctx => `Approve tonight's ${ctx.unit.attributes.source} load?\n\n${ctx.steps.summarize.summary}`,
    decision: z.object({ approved: z.boolean(), notes: z.string() }),
  })
  .exit('rejected', ctx => ctx.steps.approval.approved === false)
  .step('load', load, ctx => sourceOf(ctx.unit.attributes), { retry: backoff, afterCrash: 'park' })
  .step('verify', verify, ctx => sourceOf(ctx.unit.attributes), { afterCrash: 'rerun' })
  .exit('loadedWithWarnings', ctx => ctx.steps.verify.exitCode === 3)
  .exit('loaded');

const sources: readonly LoadAttrs[] = [
  { source: 'billing' },
  { source: 'crm' },
  { source: 'inventory' },
  { source: 'web' },
];

const loads = H.lane('nightlyLoads', NightlyLoad)
  .supply(H.clock('twoAm').daily('02:00', { tz: 'Europe/London' }), (_tick, to) => sources.map(s => to.create(s)))
  .store(sqlite.store({ path: '.harness/loads.sqlite' }))
  .handler(loadFlow, {
    exits: { invalid: Failed, rejected: Rejected, loadedWithWarnings: LoadedWithWarnings, loaded: Loaded },
    during: {
      extract: Extracting,
      validate: Validating,
      validationReview: Validating,
      summarize: Validating,
      approval: AwaitingApproval,
      load: Loading,
      verify: Loading,
    },
  });

const unapprovedLoadExpires = H.trigger('unapprovedLoadExpires')
  .on(H.when.timer(loads, { at: u => H.nextTime('09:00', { after: u.createdAt, tz: 'Europe/London' }) }))
  .signal(H.cancel, loads, e => e.unit.state === 'AwaitingApproval'
    ? { key: e.unit.key, payload: { reason: 'not approved by 09:00' } }
    : undefined);

const approver = claudeCode.supervisor('approver', {
  grants: [
    H.ops.workRead,
    H.ops.blockersResolve,
    H.ops.attemptsRecover,
    H.ops.memoryRead,
    H.ops.memoryWrite,
    H.ops.telemetryRead,
  ],
});

export const harness = H.harness('nightly-data')
  .ledger(sqlite.ledger({ path: '.harness/ledger.sqlite' }))
  .pools(etlPool)
  .lanes(loads)
  .journals(approverTaste)
  .triggers(unapprovedLoadExpires)
  .scheduler(H.scheduler('nightly').priority(loads))
  .clients(approver)
  .observers(
    markdown.board({ path: '.harness/board.md' }),
    markdown.telemetry({ path: '.harness/telemetry.md' }),
  );

export const running = harness.start();
