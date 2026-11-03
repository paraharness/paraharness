import { z } from 'zod';
import { H, MetricRef, Router, Route, State } from 'harness-dsl';
import { sqlite } from 'harness-dsl/sqlite';
import { claudeCode } from 'harness-dsl/claude-code';
import { ironclad } from 'harness-dsl/ironclad';
import { webhook } from 'harness-dsl/webhook';
import { http } from 'harness-dsl/http';
import { local } from 'harness-dsl/local';
import { markdown } from 'harness-dsl/markdown';

const quota = sqlite.quota('contracts-quota', { path: '.harness/quota.sqlite' });
const subscription = claudeCode.subscription('claude-legal', { token: H.env('CLAUDE_TOKEN'), quota });
const opus = claudeCode.model('opus', { id: 'claude-opus-4-1' });
const pool = H.pool('legal-claude').accounts(subscription);
const runner = local.runner('local').slots(2);
const category = H.facet('category');

const contractAttrs = z.object({
  contractId: z.string(),
  counterparty: z.string(),
  category: z.string(),
  region: z.enum(['eu', 'us']),
  amountUsd: z.number(),
  document: z.string(),
  redlines: z.array(z.string()),
});
type ContractAttrs = z.infer<typeof contractAttrs>;

const contractEvent = z.object({
  type: z.enum(['new', 'redline']),
  contractId: z.string(),
  counterparty: z.string(),
  category: z.string(),
  region: z.enum(['eu', 'us']),
  amountUsd: z.number(),
  document: z.string(),
  redline: z.string().optional(),
});
type ContractEvent = z.infer<typeof contractEvent>;

const Received = H.state('received', 'pending');
const Drafting = H.state('drafting', 'active');
const AwaitingCounsel = H.state('awaiting-counsel', 'waiting');
const AwaitingSignoff = H.state('awaiting-signoff', 'waiting');
const Executing = H.state('executing', 'active');
const Executed = H.terminal('executed', 'success');
const Declined = H.terminal('declined', 'failure');
const RejectedByFinance = H.terminal('rejected-by-finance', 'failure');
const Abandoned = H.terminal('abandoned', 'failure');
const Withdrawn = H.terminal('withdrawn', 'neutral');

const Contract = H.kind('Contract')
  .attributes(contractAttrs)
  .states(Received, Drafting, AwaitingCounsel, AwaitingSignoff, Executing, Executed, Declined, RejectedByFinance, Abandoned, Withdrawn)
  .key(a => a.contractId);

const redlined = H.signal('redlined').payload(z.object({ redline: z.string() }));

const counselDecision = z.object({ action: z.enum(['accept', 'return']), notes: z.string() });
type CounselDecision = z.infer<typeof counselDecision>;
const counselReview = H.halt('counsel').decision(counselDecision);
const signoff = H.halt('signoff').decision(z.object({ approve: z.boolean(), note: z.string() }));

const counselSkip = H.policy.halt(
  'counsel-skip',
  counselReview,
  z.object({ category: z.string() }),
  ({ input, metrics }): CounselDecision | undefined => {
    const accepted = metrics.rate(counselApproval, { by: { facets: [category.of(input.category)] } });
    return accepted.samples >= 200 && accepted.hits === accepted.samples
      ? { action: 'accept', notes: `skipped: ${accepted.hits} of ${accepted.samples} accepted` }
      : undefined;
  },
);

const drafterRole = H.role('contract-drafter').intents('read', 'edit').instructions('Draft the contract, applying every redline.');
const drafter = H.seat('contract-drafter').role(drafterRole).model(opus).pool(pool).output(z.object({ draft: z.string() }));

const pageDeputy = H.command('page-finance-deputy').argv(['./scripts/page', 'finance-deputy']).runner(runner);
const executeContract = H.command('execute-contract')
  .input(z.object({ contractId: z.string() }))
  .argv(i => ['./scripts/execute', i.contractId])
  .runner(runner);

const contractFlow = H.flow('contract')
  .input(contractAttrs)
  .loop(
    'counsel-rounds',
    round =>
      round
        .step('draft', drafter, ctx => ({
          task: `Draft ${ctx.unit.attributes.contractId} with ${ctx.unit.attributes.counterparty}. Redlines: ${ctx.unit.attributes.redlines.join(' | ') || 'none'}`,
        }))
        .halt('counsel', counselReview, {
          ask: ctx => `Review the draft of ${ctx.unit.attributes.contractId}:\n${ctx.steps.draft.draft}`,
          skip: { by: counselSkip, input: ctx => ({ category: ctx.unit.attributes.category }) },
        }),
    { max: 2, until: ctx => ctx.steps.counsel.action === 'accept' },
  )
  .exit('declined', ctx => ctx.steps.counsel.action === 'return')
  .halt('signoff', signoff, {
    ask: ctx => `Sign off ${ctx.unit.attributes.contractId} for $${ctx.unit.attributes.amountUsd}?`,
    timeout: { afterMinutes: 30, decide: ctx => ({ approve: ctx.unit.attributes.amountUsd < 500, note: 'resolved by timeout' }) },
    escalate: { afterMinutes: 20, run: pageDeputy },
  })
  .exit('rejected', ctx => ctx.steps.signoff.approve === false)
  .step('execute', executeContract, ctx => ({ contractId: ctx.unit.attributes.contractId }), { afterCrash: 'park' })
  .exit('executed');

const contractEvents = webhook.json('contract-events', {
  port: H.slot.port(3),
  path: '/contracts',
  secret: H.env('CONTRACT_WEBHOOK_SECRET'),
  payload: contractEvent,
});

function routeFor(region: 'eu' | 'us') {
  return (e: ContractEvent, to: Router<ContractAttrs, State>): Route => {
    if (e.region === region && e.type === 'new') {
      return to.create({
        contractId: e.contractId,
        counterparty: e.counterparty,
        category: e.category,
        region: e.region,
        amountUsd: e.amountUsd,
        document: e.document,
        redlines: [],
      });
    }
    if (e.region === region && e.redline !== undefined) return to.signal(redlined, e.contractId, { redline: e.redline });
    return to.skip();
  };
}

const documentStore = ironclad.store({ workspace: 'legal', token: H.env('IRONCLAD_TOKEN') });
const contractMap = {
  exits: { declined: Declined, rejected: RejectedByFinance, executed: Executed },
  during: { draft: Drafting, counsel: AwaitingCounsel, signoff: AwaitingSignoff, execute: Executing },
};

const euLane = H.lane('contracts-eu', Contract)
  .supply(contractEvents, routeFor('eu'))
  .supply(H.operator)
  .store(documentStore)
  .handler(contractFlow, contractMap)
  .retry({ maxAttempts: 4, backoff: 'exponential', initialDelayMs: 300_000, exhausted: Abandoned })
  .on(redlined, { update: (a, p) => ({ ...a, redlines: [...a.redlines, p.redline] }), restart: { to: 'draft', at: ['counsel'] } })
  .on(H.cancel, { enter: Withdrawn });

const usLane = H.lane('contracts-us', Contract)
  .supply(contractEvents, routeFor('us'))
  .supply(H.operator)
  .store(documentStore)
  .handler(contractFlow, contractMap)
  .retry({ maxAttempts: 2, backoff: 'fixed', initialDelayMs: 300_000, exhausted: Abandoned })
  .on(redlined, { update: (a, p) => ({ ...a, redlines: [...a.redlines, p.redline] }), restart: { to: 'draft', at: ['counsel'] } })
  .on(H.cancel, { enter: Withdrawn });

const counselApproval: MetricRef<'rate'> = H.metric('counsel-approval', H.when.decision([euLane, usLane], counselReview))
  .facets(category)
  .samples(e =>
    e.resolvedBy === 'human'
      ? [{ hit: e.decision.action === 'accept', by: { facets: [category.of(e.unit.attributes.category)] } }]
      : [],
  );

const counselDashboard = http.controlApi('counsel-dashboard', {
  port: H.slot.port(1),
  token: H.env('COUNSEL_TOKEN'),
  grants: [H.ops.resolve(counselReview)],
});

const finance = claudeCode.supervisor('finance').client('finance', { grants: [H.ops.resolve(signoff)] });
const financeDeputy = claudeCode.supervisor('finance-deputy').client('finance-deputy', { grants: [H.ops.resolve(signoff)] });

const auditorView = http.controlApi('auditor', {
  port: H.slot.port(2),
  token: H.env('AUDITOR_TOKEN'),
  grants: [H.ops.workRead, H.ops.telemetryRead],
});

const legalOps = http.controlApi('legal-ops', {
  port: H.slot.port(4),
  token: H.env('LEGAL_OPS_TOKEN'),
  grants: [H.ops.workRead, H.ops.workCreate, H.ops.signal(H.cancel), H.ops.signal(redlined), H.ops.attemptsRecover],
});

export const harness = H.harness('contracts')
  .ledger(sqlite.ledger({ path: '.harness/ledger.sqlite' }))
  .lanes(euLane, usLane)
  .metrics(counselApproval)
  .scheduler(H.scheduler('contracts-scheduler').priority(euLane, usLane).wip(euLane, 3).wip(usLane, 3))
  .clients(counselDashboard, finance, financeDeputy, auditorView, legalOps)
  .observers(markdown.board({ path: 'BOARD.md' }), markdown.telemetry({ path: 'TELEMETRY.md' }));

void harness.start();
