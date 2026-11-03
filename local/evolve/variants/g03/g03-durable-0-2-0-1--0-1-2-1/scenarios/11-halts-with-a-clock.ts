import { z } from 'zod';
import { H, Route, Router } from 'harness-dsl';
import { sqlite } from 'harness-dsl/sqlite';
import { claudeCode } from 'harness-dsl/claude-code';
import { webhook } from 'harness-dsl/webhook';
import { ironclad } from 'harness-dsl/ironclad';
import { http } from 'harness-dsl/http';
import { local } from 'harness-dsl/local';
import { markdown } from 'harness-dsl/markdown';

const regionSchema = z.enum(['eu', 'us']);
const categorySchema = z.enum(['nda', 'msa', 'order-form', 'dpa']);
const contractCategory = H.facet('contract-category', categorySchema.options);

const contractAttrs = z.object({
  contractId: z.string(),
  region: regionSchema,
  category: categorySchema,
  valueUsd: z.number(),
  title: z.string(),
  documentUrl: z.string(),
  redlines: z.array(z.string()),
});
type ContractAttrs = z.infer<typeof contractAttrs>;

const contractEvent = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('new'),
    contractId: z.string(),
    region: regionSchema,
    category: categorySchema,
    valueUsd: z.number(),
    title: z.string(),
    documentUrl: z.string(),
  }),
  z.object({ type: z.literal('redline'), contractId: z.string(), region: regionSchema, text: z.string() }),
]);
type ContractEvent = z.infer<typeof contractEvent>;

const Received = H.state('Received', 'pending');
const Executed = H.terminal('Executed', 'success');
const Declined = H.terminal('Declined', 'failure');
const Rejected = H.terminal('Rejected', 'failure');
const ContractFailed = H.terminal('ContractFailed', 'failure');
const Contract = H.kind('Contract')
  .attributes(contractAttrs)
  .states(Received, Executed, Declined, Rejected, ContractFailed)
  .key(a => a.contractId)
  .initial(Received);

const redline = H.signal('redline').payload(z.object({ text: z.string() }));

const counsel = H.halt('counsel').decision(z.object({ verdict: z.enum(['approve', 'return']), notes: z.string() }));
const signoff = H.halt('signoff').decision(z.object({ approved: z.boolean(), note: z.string() }));

const counselApprovals = H.metric('counsel-approvals', H.when.decision(Contract, counsel)).samples(e =>
  e.resolvedBy === 'human'
    ? [{ hit: e.decision.verdict === 'approve', facets: [contractCategory.of(e.unit.attributes.category)] }]
    : []);

const counselSkip = H.policy.halt('counsel-skip', Contract, counsel).decide(ctx => {
  const approvals = ctx.metrics.rate(counselApprovals, { facets: [contractCategory.of(ctx.unit.attributes.category)] });
  return approvals.samples >= 200 && approvals.hits === approvals.samples
    ? { verdict: 'approve', notes: `skipped: ${approvals.hits} of ${approvals.samples} approved` }
    : undefined;
});

const subscription = claudeCode.subscription('contracts', {
  token: H.env('CLAUDE_TOKEN'),
  quota: sqlite.quota('contracts', { path: './.harness/quota.sqlite' }),
});
const pool = H.pool('contracts').accounts(subscription);
const opus = claudeCode.model('opus', { id: 'claude-opus-4-1' });
const drafterRole = H.role('contract-drafter').intents('read', 'edit').instructions('Draft the contract, applying every redline and counsel note.');
const drafter = H.seat('contract-drafter').role(drafterRole).model(opus).pool(pool).output(z.object({ documentUrl: z.string(), summary: z.string() }));

const runner = local.runner('local');
const pageDeputy = H.command('page-finance-deputy').argv(['./ops/page.sh', 'finance-deputy']).runner(runner);
const execute = H.command('execute-contract')
  .input(z.object({ contractId: z.string() }))
  .argv(i => ['./contracts/execute.sh', i.contractId])
  .runner(runner);

const contractFlow = H.flow('contract')
  .input(contractAttrs)
  .loop(
    'review',
    { carry: z.object({ returns: z.array(z.string()) }), initial: { returns: [] } },
    round => round
      .step('draft', drafter, ctx => ({
        task: `Draft ${ctx.unit.attributes.title} (${ctx.unit.attributes.documentUrl}).\nRedlines:\n${ctx.unit.attributes.redlines.join('\n') || 'none'}\nCounsel notes:\n${ctx.steps.review.returns.join('\n') || 'none'}`,
      }), { afterCrash: 'askDriver' })
      .halt('counsel', counsel, {
        ask: ctx => `Review ${ctx.unit.attributes.title}: ${ctx.steps.draft.documentUrl}\n${ctx.steps.draft.summary}`,
        skip: counselSkip,
      }),
    {
      max: 2,
      span: 'unit',
      until: ctx => ctx.steps.counsel.verdict === 'approve',
      next: ctx => ({ returns: [...ctx.steps.review.returns, ctx.steps.counsel.notes] }),
    },
  )
  .exit('declined', ctx => ctx.steps.counsel.verdict === 'return')
  .halt('signoff', signoff, {
    ask: ctx => `Sign off ${ctx.unit.attributes.title} for $${ctx.unit.attributes.valueUsd}?`,
    escalate: { afterMinutes: 20, run: pageDeputy },
    timeout: {
      afterMinutes: 30,
      decide: ctx => ctx.unit.attributes.valueUsd < 500
        ? { approved: true, note: 'approved by timeout: under $500' }
        : { approved: false, note: 'rejected by timeout: $500 or more' },
    },
  })
  .exit('rejected', ctx => !ctx.steps.signoff.approved)
  .step('execute', execute, ctx => ({ contractId: ctx.unit.attributes.contractId }), { afterCrash: 'park' })
  .exit('executed');

const contractWebhook = webhook.json('contracts', {
  port: H.slot.port(1),
  path: '/contracts',
  secret: H.env('CONTRACTS_WEBHOOK_SECRET'),
  payload: contractEvent,
});

const routeFor = (region: z.infer<typeof regionSchema>) => (e: ContractEvent, to: Router<ContractAttrs>): Route => {
  if (e.region !== region) return to.skip();
  if (e.type === 'redline') return to.signal(redline, e.contractId, { text: e.text });
  return to.create({
    contractId: e.contractId,
    region: e.region,
    category: e.category,
    valueUsd: e.valueUsd,
    title: e.title,
    documentUrl: e.documentUrl,
    redlines: [],
  });
};

const documents = ironclad.store({ workspace: 'legal', token: H.env('DOCUMENTS_TOKEN') });
const exits = { declined: Declined, rejected: Rejected, executed: Executed };

const contractsEu = H.lane('contracts-eu', Contract)
  .supply(contractWebhook, routeFor('eu'))
  .supply(H.operator)
  .store(documents)
  .handler(contractFlow, { exits })
  .retry({ maxAttempts: 4, backoff: 'exponential', initialDelayMs: 60_000, exhausted: ContractFailed })
  .on(redline, { update: (a, p) => ({ ...a, redlines: [...a.redlines, p.text] }), rewind: 'draft', at: ['counsel'] });

const contractsUs = H.lane('contracts-us', Contract)
  .supply(contractWebhook, routeFor('us'))
  .supply(H.operator)
  .store(documents)
  .handler(contractFlow, { exits })
  .retry({ maxAttempts: 2, backoff: 'fixed', initialDelayMs: 60_000, exhausted: ContractFailed })
  .on(redline, { update: (a, p) => ({ ...a, redlines: [...a.redlines, p.text] }), rewind: 'draft', at: ['counsel'] });

const counselDashboard = http.controlApi('counsel-dashboard', {
  port: H.slot.port(2),
  token: H.env('COUNSEL_TOKEN'),
  grants: [H.ops.workRead, H.ops.resolve(counsel)],
});
const finance = claudeCode.supervisor('finance', {
  port: H.slot.port(3),
  grants: [H.ops.workRead, H.ops.resolve(signoff)],
});
const decisionAuditor = http.controlApi('decision-auditor', {
  port: H.slot.port(4),
  token: H.env('AUDITOR_TOKEN'),
  grants: [H.ops.workRead, H.ops.telemetryRead],
});

export const contractsHarness = H.harness('contracts')
  .ledger(sqlite.ledger({ path: './.harness/ledger.sqlite' }))
  .lanes(contractsEu, contractsUs)
  .metrics(counselApprovals)
  .scheduler(H.scheduler('contracts').standard(contractsEu, contractsUs).wip([contractsEu, contractsUs], 3))
  .clients(counselDashboard, finance, decisionAuditor)
  .observers(markdown.board({ path: './BOARD.md' }), markdown.telemetry({ path: './TELEMETRY.md' }));
