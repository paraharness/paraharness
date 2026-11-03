import { z } from 'zod';
import { H, Metrics, Route, Router, Window } from 'harness-dsl';
import { sqlite } from 'harness-dsl/sqlite';
import { anthropic } from 'harness-dsl/anthropic';
import { claudeCode } from 'harness-dsl/claude-code';
import { http } from 'harness-dsl/http';
import { webhook } from 'harness-dsl/webhook';
import { ironclad } from 'harness-dsl/ironclad';
import { local } from 'harness-dsl/local';
import { markdown } from 'harness-dsl/markdown';

const region = z.enum(['eu', 'us']);

const contractAttrs = z.object({
  contractId: z.string(),
  region,
  category: z.string(),
  amountUsd: z.number(),
  counterparty: z.string(),
  redlines: z.array(z.string()),
});
type Contract = z.infer<typeof contractAttrs>;

const Received = H.state('Received', 'pending');
const Drafting = H.state('Drafting', 'active');
const AwaitingCounsel = H.state('AwaitingCounsel', 'waiting');
const AwaitingSignoff = H.state('AwaitingSignoff', 'waiting');
const Executing = H.state('Executing', 'active');
const Executed = H.terminal('Executed', 'success');
const Rejected = H.terminal('Rejected', 'neutral');
const Declined = H.terminal('Declined', 'failure');
const ContractFailed = H.terminal('ContractFailed', 'failure');

const contract = H.kind('Contract')
  .attributes(contractAttrs)
  .states(Received, Drafting, AwaitingCounsel, AwaitingSignoff, Executing, Executed, Rejected, Declined, ContractFailed)
  .key(attrs => attrs.contractId)
  .initial(Received);

const redline = H.signal('redline').payload(z.object({ text: z.string() }));

const counselDecision = z.object({ verdict: z.enum(['approve', 'return']), notes: z.string() });
type CounselDecision = z.infer<typeof counselDecision>;

const counselReview = H.halt('counsel').decision(counselDecision);
const financeSignoff = H.halt('signoff').decision(z.object({ approve: z.boolean() }));

const counselApprovals = H.metric('counsel-approvals', H.when.decision(contract, counselReview)).samples(event =>
  event.resolvedBy === 'human'
    ? [{ group: event.unit.attributes.category, hit: event.decision.verdict === 'approve' }]
    : [],
);

const provenCategoryApproval: CounselDecision = {
  verdict: 'approve',
  notes: 'category proven: 200+ approvals, zero returns',
};

const counselSkip = H.policy.halt('counsel-skip-proven-category', contract, counselReview, ctx => {
  const approvals = ctx.metrics.rate(counselApprovals, { group: ctx.unit.attributes.category });
  return approvals.samples >= 200 && approvals.hits === approvals.samples ? provenCategoryApproval : undefined;
});

const apiAccount = anthropic.account('contracts-api', { apiKey: H.env('ANTHROPIC_API_KEY') });
const sonnet = anthropic.model('sonnet', { id: 'claude-sonnet-4-5' });
const contractsPool = H.pool('contracts').accounts(apiAccount);

const drafterRole = H.role('drafter')
  .intents('read', 'search', 'record')
  .instructions('Draft the contract from the counterparty terms and every redline received so far.');

const drafter = H.agent('contract-drafter').role(drafterRole).model(sonnet).pool(contractsPool);

const runner = local.runner('local');

const pageDeputy = H.command('page-finance-deputy')
  .argv(['pager', 'notify', '--team', 'finance-deputy', '--reason', 'signoff-pending-20m'])
  .runner(runner);

const executeContract = H.command('execute-contract')
  .input(z.object({ contractId: z.string() }))
  .argv(input => ['contracts', 'execute', '--id', input.contractId])
  .runner(runner);

const contractFlow = H.flow('contract')
  .input(contractAttrs)
  .loop(
    'counsel-rounds',
    flow =>
      flow
        .step('draft', drafter, ctx => ({
          task: `Draft contract ${ctx.unit.attributes.contractId} with ${ctx.unit.attributes.counterparty}. Redlines:\n${ctx.unit.attributes.redlines.join('\n')}`,
          skills: [ctx.unit.attributes.category],
        }))
        .halt('counsel', counselReview, {
          ask: ctx => `Review contract ${ctx.unit.attributes.contractId} (${ctx.unit.attributes.category}).`,
          skip: counselSkip,
        }),
    { max: 2, until: ctx => ctx.steps.counsel.verdict === 'approve' },
  )
  .exit('declined', ctx => ctx.steps.counsel.verdict === 'return')
  .halt('signoff', financeSignoff, {
    ask: ctx => `Sign off contract ${ctx.unit.attributes.contractId} for $${ctx.unit.attributes.amountUsd}.`,
    escalate: { afterMinutes: 20, run: pageDeputy },
    timeout: { afterMinutes: 30, decide: ctx => ({ approve: ctx.unit.attributes.amountUsd < 500 }) },
  })
  .exit('rejected', ctx => !ctx.steps.signoff.approve)
  .step('execute', executeContract, ctx => ({ contractId: ctx.unit.attributes.contractId }), { afterCrash: 'park' })
  .exit('executed');

const contractEvent = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('new'),
    contractId: z.string(),
    region,
    category: z.string(),
    amountUsd: z.number(),
    counterparty: z.string(),
  }),
  z.object({ type: z.literal('redline'), contractId: z.string(), text: z.string() }),
]);
type ContractEvent = z.infer<typeof contractEvent>;

const contractEvents = webhook.json('contract-events', {
  port: H.slot.port(1),
  path: '/contracts',
  secret: H.env('CONTRACT_WEBHOOK_SECRET'),
  payload: contractEvent,
});

const routeFor =
  (lane: 'eu' | 'us') =>
  (event: ContractEvent, to: Router<Contract, string>): Route => {
    if (event.type === 'redline') return to.signal(redline, event.contractId, { text: event.text });
    if (event.region !== lane) return to.skip();
    return to.create({
      contractId: event.contractId,
      region: event.region,
      category: event.category,
      amountUsd: event.amountUsd,
      counterparty: event.counterparty,
      redlines: [],
    });
  };

const documents = ironclad.store({ workspace: 'legal', token: H.env('IRONCLAD_TOKEN') });

const contractMap = {
  exits: { declined: Declined, rejected: Rejected, executed: Executed },
  during: { draft: Drafting, counsel: AwaitingCounsel, signoff: AwaitingSignoff, execute: Executing },
};

const contractsEu = H.lane('contracts-eu', contract)
  .supply(contractEvents, routeFor('eu'))
  .supply(H.operator)
  .store(documents)
  .handler(contractFlow, contractMap)
  .retry({ maxAttempts: 4, backoff: 'exponential', initialDelayMs: 60_000, exhausted: ContractFailed })
  .on(redline, {
    update: (attrs, payload) => ({ ...attrs, redlines: [...attrs.redlines, payload.text] }),
    restart: { to: 'draft', at: ['counsel'] },
  });

const contractsUs = H.lane('contracts-us', contract)
  .supply(contractEvents, routeFor('us'))
  .supply(H.operator)
  .store(documents)
  .handler(contractFlow, contractMap)
  .retry({ maxAttempts: 2, backoff: 'fixed', initialDelayMs: 300_000, exhausted: ContractFailed })
  .on(redline, {
    update: (attrs, payload) => ({ ...attrs, redlines: [...attrs.redlines, payload.text] }),
    restart: { to: 'draft', at: ['counsel'] },
  });

const draftingSlotsFree = (count: (lane: typeof contractsEu | typeof contractsUs, ...positions: 'active'[]) => number) =>
  count(contractsEu, 'active') + count(contractsUs, 'active') < 3;

const scheduler = H.scheduler('contracts')
  .priority(contractsEu, contractsUs)
  .admit(contractsEu, ctx => draftingSlotsFree(ctx.count))
  .admit(contractsUs, ctx => draftingSlotsFree(ctx.count));

const counselDashboard = http.controlApi('counsel-dashboard', {
  port: H.slot.port(2),
  token: H.env('COUNSEL_TOKEN'),
  grants: [H.ops.workRead, H.ops.resolve(counselReview)],
});

const financeSupervisor = claudeCode.supervisor('finance', {
  grants: [H.ops.workRead, H.ops.resolve(financeSignoff)],
});

const auditor = http.controlApi('auditor', {
  port: H.slot.port(3),
  token: H.env('AUDITOR_TOKEN'),
  grants: [H.ops.workRead, H.ops.telemetryRead],
});

export const contractDecisionReport = (metrics: Metrics) => {
  const month: Window = { calendar: 'month' };
  const signoff = metrics.decisions({ halt: financeSignoff, window: month });
  const byTimeout = signoff.byResolver
    .filter(entry => entry.resolvedBy === 'timeout')
    .reduce((sum, entry) => sum + entry.count, 0);
  return {
    counsel: metrics.decisions({ halt: counselReview, window: month }),
    signoff,
    signoffTimeoutShare: { share: signoff.samples === 0 ? 0 : byTimeout / signoff.samples, samples: signoff.samples },
    retriesThisMonth: {
      eu: metrics.attempts({ of: contractsEu, window: month }).retried,
      us: metrics.attempts({ of: contractsUs, window: month }).retried,
    },
  };
};

export const contracts = H.harness('contracts')
  .ledger(sqlite.ledger({ path: 'contracts.ledger.db' }))
  .lanes(contractsEu, contractsUs)
  .metrics(counselApprovals)
  .scheduler(scheduler)
  .clients(counselDashboard, financeSupervisor, auditor)
  .observers(
    markdown.board({ path: 'docs/board.md' }),
    markdown.telemetry({ path: 'docs/telemetry.md' }),
  );
