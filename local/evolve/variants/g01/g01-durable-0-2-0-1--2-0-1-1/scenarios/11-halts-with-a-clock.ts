import { z } from 'zod';
import { H, Router, Route, Retry } from 'harness-dsl';
import { anthropic } from 'harness-dsl/anthropic';
import { claudeCode } from 'harness-dsl/claude-code';
import { sqlite } from 'harness-dsl/sqlite';
import { ironclad } from 'harness-dsl/ironclad';
import { webhook } from 'harness-dsl/webhook';
import { http } from 'harness-dsl/http';
import { local } from 'harness-dsl/local';
import { markdown } from 'harness-dsl/markdown';

const apiAccount = anthropic.account('anthropic-api', { apiKey: H.env('ANTHROPIC_API_KEY') });
const sonnet = anthropic.model('sonnet', { id: 'claude-sonnet-4-5' });
const pool = H.pool('api').accounts(apiAccount);
const ops = local.runner('ops').slots(2);

const category = H.facet('category');

const contractAttributes = z.object({
  contractId: z.string(),
  counterparty: z.string(),
  region: z.enum(['eu', 'us']),
  category: z.string(),
  valueUsd: z.number(),
  redlines: z.array(z.string()),
});
type ContractAttributes = z.infer<typeof contractAttributes>;

const received = H.state('received', 'pending');
const drafting = H.state('drafting', 'active');
const awaitingCounsel = H.state('awaitingCounsel', 'waiting');
const awaitingSignoff = H.state('awaitingSignoff', 'waiting');
const executing = H.state('executing', 'active');
const executed = H.terminal('executed', 'success');
const declined = H.terminal('declined', 'failure');
const rejected = H.terminal('rejected', 'failure');
const failed = H.terminal('failed', 'failure');
const withdrawn = H.terminal('withdrawn', 'neutral');

const contractKind = H.kind('Contract')
  .attributes(contractAttributes)
  .states(received, drafting, awaitingCounsel, awaitingSignoff, executing, executed, declined, rejected, failed, withdrawn)
  .key(a => a.contractId)
  .initial(received);

const counselHalt = H.halt('counsel').decision(z.object({ action: z.enum(['approve', 'return', 'reject']), notes: z.string() }));
const signoffHalt = H.halt('signoff').decision(z.object({ approved: z.boolean(), note: z.string() }));

const counselApprovals = H.metric('counsel-approvals', H.when.decision(contractKind, counselHalt))
  .facets(category)
  .samples(e => (e.resolvedBy === 'human' ? [{ hit: e.decision.action === 'approve', halt: counselHalt, facets: { category: e.unit.attributes.category } }] : []));

const signoffByTimeout = H.metric('signoff-by-timeout', H.when.decision(contractKind, signoffHalt))
  .samples(e => [{ hit: e.resolvedBy === 'timeout', halt: signoffHalt }]);

const counselWaiver = H.policy.halt('counsel-waiver', contractKind, counselHalt, ctx => {
  const read = ctx.metrics.rate(counselApprovals, { facets: { category: ctx.unit.attributes.category } });
  return read.hits >= 200 && read.hits === read.samples
    ? { action: 'approve', notes: `waived: ${read.hits} of ${read.samples} counsel reviews approved` }
    : undefined;
});

const drafterRole = H.role('contract-drafter').intents('read', 'edit').instructions('Draft the contract and fold in every redline.');
const drafter = H.seat('contract-drafter').role(drafterRole).model(sonnet).pool(pool).output(z.object({ document: z.string() }));

const pageDeputy = H.command('page-finance-deputy').argv(['pager', 'notify', 'finance-deputy']).runner(ops);

const executeContract = H.command('execute-contract')
  .input(z.object({ contractId: z.string() }))
  .argv(i => ['contracts', 'execute', i.contractId])
  .runner(ops);

const contractFlow = H.flow('contract')
  .input(contractAttributes)
  .loop(
    'counselRounds',
    f =>
      f
        .step('draft', drafter, ctx => ({
          task: `Draft contract ${ctx.unit.attributes.contractId} with ${ctx.unit.attributes.counterparty}. Redlines: ${ctx.unit.attributes.redlines.join('; ')}`,
          facets: [category.is(ctx.unit.attributes.category)],
        }))
        .halt('counsel', counselHalt, {
          ask: ctx => `Review contract ${ctx.unit.attributes.contractId}:\n\n${ctx.steps.draft.document}`,
          scope: ctx => [category.is(ctx.unit.attributes.category)],
          skip: counselWaiver,
        }),
    { max: 2, until: ctx => ctx.steps.counsel.action !== 'return' },
  )
  .exit('returnedTwice', ctx => ctx.steps.counsel.action === 'return')
  .exit('counselRejected', ctx => ctx.steps.counsel.action === 'reject')
  .halt('signoff', signoffHalt, {
    ask: ctx => `Sign off contract ${ctx.unit.attributes.contractId} worth $${ctx.unit.attributes.valueUsd}?`,
    timeout: {
      afterMinutes: 30,
      decide: ctx => ({ approved: ctx.unit.attributes.valueUsd < 500, note: 'resolved by timeout' }),
    },
    escalate: { afterMinutes: 20, run: pageDeputy },
  })
  .exit('signoffRejected', ctx => !ctx.steps.signoff.approved)
  .step('execute', executeContract, ctx => ({ contractId: ctx.unit.attributes.contractId }), { afterCrash: 'park' })
  .exit('executed');

const redline = H.signal('redline').payload(z.object({ text: z.string() }));

const contractEvent = z.object({
  type: z.enum(['new', 'redline']),
  contractId: z.string(),
  counterparty: z.string(),
  region: z.enum(['eu', 'us']),
  category: z.string(),
  valueUsd: z.number(),
  text: z.string(),
});
type ContractEvent = z.infer<typeof contractEvent>;

const contractEvents = webhook.json('contract-events', {
  port: H.slot.port(1),
  path: '/contracts',
  secret: H.env('CONTRACT_WEBHOOK_SECRET'),
  payload: contractEvent,
});

const routeFor = (region: 'eu' | 'us') => (e: ContractEvent, to: Router<ContractAttributes>): Route =>
  e.region !== region
    ? to.skip()
    : e.type === 'redline'
      ? to.signal(redline, e.contractId, { text: e.text })
      : to.create({
          contractId: e.contractId,
          counterparty: e.counterparty,
          region: e.region,
          category: e.category,
          valueUsd: e.valueUsd,
          redlines: [],
        });

const documents = ironclad.store({ workspace: 'legal', token: H.env('IRONCLAD_TOKEN') });

const contractLane = (name: string, region: 'eu' | 'us', retry: Retry) =>
  H.lane(name, contractKind)
    .supply(contractEvents, routeFor(region))
    .supply(H.operator)
    .store(documents)
    .handler(contractFlow, {
      exits: { returnedTwice: declined, counselRejected: rejected, signoffRejected: rejected, executed },
      during: { draft: drafting, counsel: awaitingCounsel, signoff: awaitingSignoff, execute: executing },
      cancelled: withdrawn,
    })
    .retry({ ...retry, exhausted: failed })
    .on(redline, {
      update: (a, p) => ({ ...a, redlines: [...a.redlines, p.text] }),
      restart: { to: 'draft', at: ['counsel'] },
    });

const contractsEu = contractLane('contracts-eu', 'eu', { maxAttempts: 4, backoff: 'exponential', initialDelayMs: 60000 });
const contractsUs = contractLane('contracts-us', 'us', { maxAttempts: 2, backoff: 'fixed', initialDelayMs: 60000 });

const reportAttributes = z.object({ month: z.string() });
const reportDue = H.state('due', 'pending');
const publishing = H.state('publishing', 'active');
const published = H.terminal('published', 'success');
const reportFailed = H.terminal('reportFailed', 'failure');
const reportDropped = H.terminal('reportDropped', 'neutral');

const reportKind = H.kind('DecisionReport')
  .attributes(reportAttributes)
  .states(reportDue, publishing, published, reportFailed, reportDropped)
  .key(a => a.month)
  .initial(reportDue);

const publishReport = H.command('publish-decision-report')
  .input(z.object({ month: z.string(), figures: z.record(z.string(), z.number()) }))
  .argv(i => ['publish-report', i.month, JSON.stringify(i.figures)])
  .runner(ops);

const month = { calendar: 'month' } as const satisfies { calendar: 'month' };

const reportFlow = H.flow('decision-report')
  .input(reportAttributes)
  .step('publish', publishReport, ctx => {
    const counsel = ctx.metrics.decisions({ halt: counselHalt, window: month });
    const signoff = ctx.metrics.decisions({ halt: signoffHalt, window: month });
    const timeouts = ctx.metrics.rate(signoffByTimeout, { window: month });
    return {
      month: ctx.unit.attributes.month,
      figures: {
        counselMedianMs: counsel.medianMs,
        counselSamples: counsel.samples,
        signoffMedianMs: signoff.medianMs,
        signoffSamples: signoff.samples,
        ...Object.fromEntries(
          [...counsel.byResolver, ...signoff.byResolver].map(r => [`${r.resolvedBy}:${r.resolver}:medianMs`, r.medianMs]),
        ),
        euRetries: ctx.metrics.attempts({ of: contractsEu, window: month }).retried,
        usRetries: ctx.metrics.attempts({ of: contractsUs, window: month }).retried,
        signoffTimeoutShare: timeouts.rate,
        signoffTimeoutSamples: timeouts.samples,
      },
    };
  })
  .exit('published');

const reports = H.lane('decision-reports', reportKind)
  .supply(H.clock('month-end').at('23:00', { on: 28 }), (tick, to) => to.create({ month: tick.at.toISOString().slice(0, 7) }))
  .store(sqlite.store({ path: '.harness/units.sqlite' }))
  .handler(reportFlow, { exits: { published }, during: { publish: publishing }, cancelled: reportDropped })
  .retry({ maxAttempts: 3, backoff: 'exponential', initialDelayMs: 60000, exhausted: reportFailed });

const counselDashboard = H.client('counsel-dashboard', {
  transport: http.transport('counsel-http', { port: H.slot.port(2), token: H.env('COUNSEL_TOKEN') }),
  grants: [H.ops.resolve(counselHalt)],
});

const financeSupervisor = H.client('finance-supervisor', {
  transport: claudeCode.mcp('finance-mcp', { port: H.slot.port(3) }),
  grants: [H.ops.resolve(signoffHalt)],
});

const auditor = H.client('decision-auditor', {
  transport: http.transport('auditor-http', { port: H.slot.port(4), token: H.env('AUDITOR_TOKEN') }),
  grants: [H.ops.workRead, H.ops.telemetryRead],
});

const operatorClient = H.client('operator', {
  transport: http.transport('operator-http', { port: H.slot.port(5), token: H.env('OPERATOR_TOKEN') }),
  grants: [H.ops.workCreate, H.ops.workRead, H.ops.workCancel, H.ops.attemptsRecover],
});

export const harness = H.harness('contracts')
  .ledger(sqlite.ledger({ path: '.harness/ledger.sqlite' }))
  .lanes(contractsEu, contractsUs, reports)
  .metrics(counselApprovals, signoffByTimeout)
  .scheduler(H.scheduler('contracts').priority(contractsEu, contractsUs, reports).wip(contractsEu, 3).wip(contractsUs, 3))
  .clients(counselDashboard, financeSupervisor, auditor, operatorClient)
  .observers(markdown.board({ path: 'BOARD.md' }), markdown.telemetry({ path: 'TELEMETRY.md' }));
