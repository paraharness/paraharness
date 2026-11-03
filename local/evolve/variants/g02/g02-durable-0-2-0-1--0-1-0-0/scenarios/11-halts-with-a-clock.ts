import { H, MetricRef, Route, Router } from 'harness-dsl';
import { z } from 'zod';
import { sqlite } from 'harness-dsl/sqlite';
import { anthropic } from 'harness-dsl/anthropic';
import { claudeCode } from 'harness-dsl/claude-code';
import { http } from 'harness-dsl/http';
import { webhook } from 'harness-dsl/webhook';
import { ironclad } from 'harness-dsl/ironclad';
import { local } from 'harness-dsl/local';
import { markdown } from 'harness-dsl/markdown';

const runner = local.runner('local');
const categoryFacet = H.facet('contractCategory');

const contractAttrs = z.object({
  contractId: z.string(),
  region: z.enum(['eu', 'us']),
  counterparty: z.string(),
  category: z.string(),
  amountUsd: z.number(),
  redlines: z.array(z.string()),
});
type ContractAttrs = z.infer<typeof contractAttrs>;

const Received = H.state('Received', 'pending');
const Executed = H.terminal('Executed', 'success');
const Declined = H.terminal('Declined', 'failure');
const RejectedByFinance = H.terminal('RejectedByFinance', 'failure');
const Abandoned = H.terminal('Abandoned', 'failure');
type ContractState = typeof Received | typeof Executed | typeof Declined | typeof RejectedByFinance | typeof Abandoned;

const Contract = H.kind('Contract')
  .attributes(contractAttrs)
  .states(Received, Executed, Declined, RejectedByFinance, Abandoned)
  .key(a => a.contractId)
  .initial(Received);

const apiAccount = anthropic.account('contracts-api', {
  apiKey: H.env('ANTHROPIC_API_KEY'),
  quota: sqlite.quota('contracts-api', { path: './.harness/quota.sqlite' }),
});

const drafter = H.seat('contract-drafter')
  .role(H.role('contract-drafter').intents('read', 'edit'))
  .model(anthropic.model('opus', { id: 'claude-opus-4-1' }))
  .pool(H.pool('contracts-pool').accounts(apiAccount));

const counsel = H.halt('counsel').decision(z.object({ verdict: z.enum(['approve', 'return']), notes: z.string() }));
const signoff = H.halt('signoff').decision(z.object({ approve: z.boolean(), note: z.string() }));

const skipCounselForSafeCategory = H.policy.halt(
  'skip-counsel-for-safe-category',
  counsel,
  z.object({ category: z.string() }),
  ctx => {
    const record = ctx.metrics.rate(counselApproval, { by: { facets: [categoryFacet.of(ctx.input.category)] } });
    return record.hits >= 200 && record.hits === record.samples
      ? { verdict: 'approve', notes: `skipped: ${record.hits} of ${record.samples} approved` }
      : undefined;
  },
);

const pageDeputy = H.command('page-finance-deputy').argv(['./ops/page', 'finance-deputy']).runner(runner);

const execute = H.command('execute-contract')
  .input(z.object({ contractId: z.string() }))
  .argv(i => ['./contracts/execute', i.contractId])
  .runner(runner);

const contractFlow = H.flow('contract')
  .input(contractAttrs)
  .loop(
    'rounds',
    round =>
      round
        .step('draft', drafter, ctx => ({
          task: `Draft the ${ctx.unit.attributes.category} contract with ${ctx.unit.attributes.counterparty}, applying redlines:\n${ctx.unit.attributes.redlines.join('\n')}`,
        }))
        .halt('counsel', counsel, {
          ask: ctx => `Review the draft for ${ctx.unit.attributes.contractId}:\n\n${ctx.steps.draft}`,
          policy: { by: skipCounselForSafeCategory, input: ctx => ({ category: ctx.unit.attributes.category }) },
        }),
    { max: 2, until: ctx => ctx.steps.counsel.verdict === 'approve' },
  )
  .exit('declined', ctx => ctx.steps.counsel.verdict === 'return')
  .halt('signoff', signoff, {
    ask: ctx => `Sign off ${ctx.unit.attributes.contractId} for $${ctx.unit.attributes.amountUsd}?`,
    timeout: {
      afterMinutes: 30,
      decide: ctx => ({ approve: ctx.unit.attributes.amountUsd < 500, note: 'approve under $500, else reject' }),
    },
    escalate: { afterMinutes: 20, run: pageDeputy },
  })
  .exit('rejected', ctx => !ctx.steps.signoff.approve)
  .step('execute', execute, ctx => ({ contractId: ctx.unit.attributes.contractId }), { afterCrash: 'park' })
  .exit('executed');

const contractEvent = z.object({
  type: z.enum(['new', 'redline']),
  contractId: z.string(),
  region: z.enum(['eu', 'us']),
  counterparty: z.string(),
  category: z.string(),
  amountUsd: z.number(),
  text: z.string(),
});
type ContractEvent = z.infer<typeof contractEvent>;

const redline = H.signal('redline').payload(z.object({ text: z.string() }));

const contractWebhook = webhook.json('contract-events', {
  port: H.slot.port(1),
  path: '/contracts',
  secret: H.env('CONTRACTS_WEBHOOK_SECRET'),
  payload: contractEvent,
});

const routeContracts =
  (region: 'eu' | 'us') =>
  (e: ContractEvent, to: Router<ContractAttrs, ContractState>): Route => {
    if (e.region !== region) return to.skip();
    return e.type === 'new'
      ? to.create({
          contractId: e.contractId,
          region: e.region,
          counterparty: e.counterparty,
          category: e.category,
          amountUsd: e.amountUsd,
          redlines: [],
        })
      : to.signal(redline, e.contractId, { text: e.text });
  };

const documents = ironclad.store({ workspace: 'legal', token: H.env('IRONCLAD_TOKEN') });

const contractsEu = H.lane('contracts-eu', Contract)
  .supply(contractWebhook, routeContracts('eu'))
  .supply(H.operator)
  .store(documents)
  .handler(contractFlow, {
    ends: { declined: Declined, rejected: RejectedByFinance, executed: Executed },
    retry: { maxAttempts: 4, backoff: 'exponential', initialDelayMs: 120_000, exhausted: Abandoned },
  })
  .on(redline, { update: (a, p) => ({ ...a, redlines: [...a.redlines, p.text] }), restart: { to: 'draft', at: ['counsel'] } });

const contractsUs = H.lane('contracts-us', Contract)
  .supply(contractWebhook, routeContracts('us'))
  .supply(H.operator)
  .store(documents)
  .handler(contractFlow, {
    ends: { declined: Declined, rejected: RejectedByFinance, executed: Executed },
    retry: { maxAttempts: 2, backoff: 'fixed', initialDelayMs: 120_000, exhausted: Abandoned },
  })
  .on(redline, { update: (a, p) => ({ ...a, redlines: [...a.redlines, p.text] }), restart: { to: 'draft', at: ['counsel'] } });

const counselApproval: MetricRef<'rate'> = H.metric('counsel-approval', H.when.decision([contractsEu, contractsUs], counsel))
  .facets(categoryFacet)
  .samples(e =>
    e.resolvedBy === 'human'
      ? [{ hit: e.decision.verdict === 'approve', by: { facets: [categoryFacet.of(e.unit.attributes.category)] } }]
      : [],
  );

const signoffByTimeout = H.metric('signoff-resolved-by-timeout', H.when.decision([contractsEu, contractsUs], signoff)).samples(e => [
  { hit: e.resolvedBy === 'timeout' },
]);

const scheduler = H.scheduler('contracts-scheduler')
  .priority(contractsEu, contractsUs)
  .wip(contractsEu, 3)
  .wip(contractsUs, 3)
  .admit(contractsUs, ctx => ctx.metrics.attempts({ of: contractsUs, window: { calendar: 'month' } }).retried < 50);

const counselDashboard = http.controlApi('counsel-dashboard', {
  port: H.slot.port(2),
  token: H.env('COUNSEL_DASHBOARD_TOKEN'),
  grants: [H.ops.resolve(counsel)],
});

const financeSignoff = claudeCode.supervisor('finance').client('finance-signoff', {
  port: H.slot.port(3),
  grants: [H.ops.resolve(signoff)],
});

const deputySignoff = claudeCode.supervisor('finance-deputy').client('deputy-signoff', {
  port: H.slot.port(4),
  grants: [H.ops.resolve(signoff, { afterMinutes: 20 })],
});

const decisionAuditor = http.controlApi('decision-auditor', {
  port: H.slot.port(5),
  token: H.env('AUDITOR_TOKEN'),
  grants: [H.ops.workRead, H.ops.telemetryRead],
});

export const harness = H.harness('contracts')
  .ledger(sqlite.ledger({ path: './.harness/ledger.sqlite' }))
  .lanes(contractsEu, contractsUs)
  .metrics(counselApproval, signoffByTimeout)
  .scheduler(scheduler)
  .clients(counselDashboard, financeSignoff, deputySignoff, decisionAuditor)
  .observers(markdown.board({ path: './.harness/board.md' }), markdown.telemetry({ path: './.harness/telemetry.md' }));
