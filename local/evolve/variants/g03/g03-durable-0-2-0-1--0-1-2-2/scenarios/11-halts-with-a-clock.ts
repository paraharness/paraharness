import { z } from 'zod';
import { H, Route, Router, Retry } from 'harness-dsl';
import { claudeCode } from 'harness-dsl/claude-code';
import { sqlite } from 'harness-dsl/sqlite';
import { local } from 'harness-dsl/local';
import { http } from 'harness-dsl/http';
import { webhook } from 'harness-dsl/webhook';
import { ironclad } from 'harness-dsl/ironclad';
import { markdown } from 'harness-dsl/markdown';

const contractCategory = z.enum(['nda', 'msa', 'sow', 'vendor']);
const category = H.resources('contract-category', contractCategory.options);

const legalHost = local.runner('legal-host');

const subscription = claudeCode.subscription('contracts-subscription', {
  token: H.env('CLAUDE_TOKEN'),
  quota: sqlite.quota('contracts-quota', { path: '/srv/contracts/quota.sqlite' }),
});
const sonnet = claudeCode.model('sonnet', { id: 'claude-sonnet-4-5' });

const drafter = H.seat('contract-drafter')
  .role(
    H.role('contract-drafter')
      .intents('read', 'search')
      .instructions('Draft the contract, applying every redline and every counsel note.')
      .output(z.object({ document: z.string() })),
  )
  .model(sonnet)
  .pool(H.pool('contracts').accounts(subscription));

const contractAttrs = z.object({
  contractId: z.string(),
  title: z.string(),
  category: contractCategory,
  amountUsd: z.number(),
  redlines: z.array(z.string()),
});

const Received = H.state('Received', 'pending');
const Executed = H.terminal('Executed', 'success');
const Rejected = H.terminal('Rejected', 'failure');
const Declined = H.terminal('Declined', 'failure');
const DraftingFailed = H.terminal('DraftingFailed', 'failure');
const Contract = H.kind('Contract')
  .attributes(contractAttrs)
  .states(Received, Executed, Rejected, Declined, DraftingFailed)
  .key(attrs => attrs.contractId)
  .initial(Received);

const counselReview = H.halt('counsel').decision(z.object({ verdict: z.enum(['approve', 'return']), notes: z.string() }));
const financeSignoff = H.halt('signoff').decision(z.object({ approved: z.boolean() }));

const counselApprovals = H.metric('counsel-approvals', H.when.decision(Contract, counselReview)).samples(event =>
  event.resolvedBy === 'human'
    ? [{ hit: event.decision.verdict === 'approve', halt: event.halt, resources: event.resources }]
    : [],
);

const signoffByTimeout = H.metric('signoff-resolved-by-timeout', H.when.decision(Contract, financeSignoff)).samples(event => [
  { hit: event.resolvedBy === 'timeout', halt: event.halt, resources: event.resources },
]);

const skipCounsel = H.policy.halt('skip-counsel-for-proven-categories', Contract, counselReview).decide(ctx => {
  const record = ctx.metrics.rate(counselApprovals, { halt: counselReview, resources: ctx.resources });
  return record.samples >= 200 && record.hits === record.samples
    ? { verdict: 'approve', notes: `skipped: ${record.samples} approved samples, none returned` }
    : undefined;
});

const pageFinanceDeputy = H.command('page-finance-deputy').argv(['./contracts/page-deputy.sh']).runner(legalHost);

const executeContract = H.command('execute-contract')
  .input(z.object({ contractId: z.string() }))
  .argv(contract => ['./contracts/execute.sh', contract.contractId])
  .runner(legalHost);

const contractFlow = H.flow('contract')
  .input(contractAttrs)
  .loop(
    'rounds',
    z.object({ notes: z.array(z.string()) }),
    body =>
      body
        .step('draft', drafter, ctx => ({
          task: [
            `Draft ${ctx.unit.attributes.title}.`,
            ...ctx.unit.attributes.redlines.map(redline => `Apply redline: ${redline}`),
            ...(ctx.steps.rounds?.notes ?? []).map(note => `Address counsel note: ${note}`),
          ].join('\n'),
          resources: [category.of(ctx.unit.attributes.category)],
        }))
        .halt('counsel', counselReview, {
          ask: ctx => `Review the draft of ${ctx.unit.attributes.title}.`,
          skip: skipCounsel,
          resources: ctx => [category.of(ctx.unit.attributes.category)],
          bound: { counts: decision => decision.verdict === 'return', maxCount: 2, exit: 'declined' },
        }),
    {
      max: 8,
      until: ctx => ctx.steps.counsel.verdict === 'approve',
      carry: ctx => ({ notes: [...(ctx.steps.rounds?.notes ?? []), ctx.steps.counsel.notes] }),
    },
  )
  .halt('signoff', financeSignoff, {
    ask: ctx => `Sign off ${ctx.unit.attributes.title} for $${ctx.unit.attributes.amountUsd}?`,
    resources: ctx => [category.of(ctx.unit.attributes.category)],
    escalate: { afterMinutes: 20, run: pageFinanceDeputy },
    timeout: { afterMinutes: 30, decide: ctx => ({ approved: ctx.unit.attributes.amountUsd < 500 }) },
  })
  .exit('rejected', ctx => !ctx.steps.signoff.approved)
  .step('execute', executeContract, ctx => ({ contractId: ctx.unit.attributes.contractId }), { afterCrash: 'park' })
  .exit('executed');

const contractEvent = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('created'),
    contractId: z.string(),
    title: z.string(),
    category: contractCategory,
    amountUsd: z.number(),
  }),
  z.object({ type: z.literal('redline'), contractId: z.string(), text: z.string() }),
]);

const redline = H.signal('redline').payload(z.object({ text: z.string() }));

const routeContract = (event: z.infer<typeof contractEvent>, to: Router<z.infer<typeof contractAttrs>>): Route =>
  event.type === 'created'
    ? to.create({
        contractId: event.contractId,
        title: event.title,
        category: event.category,
        amountUsd: event.amountUsd,
        redlines: [],
      })
    : to.signal(redline, event.contractId, { text: event.text });

const documentSystem = ironclad.store({ workspace: 'legal', token: H.env('IRONCLAD_TOKEN') });

const contractLane = (name: string, slot: number, retry: Retry) =>
  H.lane(name, Contract)
    .supply(H.operator)
    .supply(
      webhook.json(`${name}-events`, {
        port: H.slot.port(slot),
        path: `/${name}`,
        secret: H.env('CONTRACTS_WEBHOOK_SECRET'),
        payload: contractEvent,
      }),
      routeContract,
    )
    .handler(contractFlow, { exits: { declined: Declined, rejected: Rejected, executed: Executed } })
    .store(documentSystem)
    .retry({ ...retry, exhausted: DraftingFailed })
    .on(redline, {
      update: (attrs, change) => ({ ...attrs, redlines: [...attrs.redlines, change.text] }),
      rewind: 'draft',
      at: ['draft', 'counsel'],
    });

const contractsEu = contractLane('contracts-eu', 1, { maxAttempts: 4, backoff: 'exponential', initialDelayMs: 60_000 });
const contractsUs = contractLane('contracts-us', 2, { maxAttempts: 2, backoff: 'fixed', initialDelayMs: 60_000 });

const counselDashboard = http.controlApi('counsel-dashboard', {
  port: H.slot.port(3),
  token: H.env('COUNSEL_TOKEN'),
  grants: [H.ops.resolve(counselReview)],
});

const finance = claudeCode.supervisor('finance', {
  port: H.slot.port(4),
  grants: [H.ops.resolve(financeSignoff)],
});

const auditor = http.controlApi('auditor', {
  port: H.slot.port(5),
  token: H.env('AUDITOR_TOKEN'),
  grants: [H.ops.workRead, H.ops.telemetryRead],
});

const operatorDesk = http.controlApi('operator-desk', {
  port: H.slot.port(6),
  token: H.env('OPERATOR_TOKEN'),
  grants: [H.ops.workRead, H.ops.workCreate],
});

export const harness = H.harness('contracts')
  .ledger(sqlite.ledger({ path: '/srv/contracts/ledger.sqlite' }))
  .lanes(contractsEu, contractsUs)
  .metrics(counselApprovals, signoffByTimeout)
  .scheduler(H.scheduler('contracts').standard(contractsEu, contractsUs).wip([contractsEu, contractsUs], 3))
  .clients(counselDashboard, finance, auditor, operatorDesk)
  .observers(markdown.board({ path: '/srv/contracts/BOARD.md' }), markdown.telemetry({ path: '/srv/contracts/TELEMETRY.md' }));

void harness.start();
