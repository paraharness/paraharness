import { z } from 'zod';
import { H, type Retry } from 'harness-dsl';
import { claudeCode } from 'harness-dsl/claude-code';
import { sqlite } from 'harness-dsl/sqlite';
import { webhook } from 'harness-dsl/webhook';
import { http } from 'harness-dsl/http';
import { ironclad } from 'harness-dsl/ironclad';
import { local } from 'harness-dsl/local';
import { markdown } from 'harness-dsl/markdown';

const quota = sqlite.quota('contracts-quota', { path: '/srv/contracts/quota.sqlite' });
const subscription = claudeCode.subscription('contracts-max', { token: H.env('CLAUDE_TOKEN'), quota });
const opus = claudeCode.model('opus', { id: 'claude-opus-4-1' });
const pool = H.pool('contracts').accounts(subscription);
const runner = local.runner('contracts');

const contractCategory = H.facet('contract-category', ['nda', 'msa', 'order-form', 'amendment']);

const contractAttrs = z.object({
  reference: z.string(),
  counterparty: z.string(),
  category: contractCategory.schema,
  region: z.enum(['eu', 'us']),
  valueUsd: z.number(),
  redlines: z.array(z.string()),
  counselNotes: z.string(),
});

const Received = H.state('received', 'pending');
const Executed = H.terminal('executed', 'success');
const SignoffRejected = H.terminal('signoff-rejected', 'neutral');
const Declined = H.terminal('declined', 'failure');
const DraftingFailed = H.terminal('drafting-failed', 'failure');

const contractKind = H.kind('contract')
  .attributes(contractAttrs)
  .states(Received, Executed, SignoffRejected, Declined, DraftingFailed)
  .key(a => a.reference)
  .initial(Received);

const drafterRole = H.role('contract-drafter').intents('read', 'edit').instructions('Draft the contract, applying every redline and counsel note.');
const drafter = H.seat('contract-drafter').role(drafterRole).model(opus).pool(pool).output(z.object({ document: z.string() }));

const counselHalt = H.halt('counsel').decision(z.object({ action: z.enum(['approve', 'return']), notes: z.string() }));
const signoffHalt = H.halt('signoff').decision(z.object({ approve: z.boolean() }));

const counselApprovals = H.metric('counsel-approvals', H.when.decision(contractKind, counselHalt)).samples(e =>
  e.resolvedBy === 'human'
    ? [{ hit: e.decision.action === 'approve', facets: [contractCategory.of(e.unit.attributes.category)] }]
    : [],
);

const signoffTimeouts = H.metric('signoff-timeouts', H.when.decision(contractKind, signoffHalt)).samples(e => [
  { hit: e.resolvedBy === 'timeout' },
]);

const counselSkip = H.policy.halt('counsel-skip', contractKind, counselHalt).decide(ctx => {
  const value = ctx.facet(contractCategory);
  if (value === undefined) return undefined;
  const record = ctx.metrics.rate(counselApprovals, { facets: [contractCategory.of(value)] });
  return record.hits >= 200 && record.hits === record.samples
    ? { action: 'approve', notes: `skipped: ${record.hits} approvals of ${record.samples} samples` }
    : undefined;
});

const pageDeputy = H.command('page-finance-deputy').argv(['page', 'finance-deputy', 'signoff pending 20 minutes']).runner(runner);

const execute = H.command('execute-contract')
  .input(z.object({ reference: z.string(), document: z.string() }))
  .argv(i => ['contracts', 'execute', i.reference])
  .runner(runner);

const contractFlow = H.flow('contract')
  .input(contractAttrs)
  .step('draft', drafter, ctx => ({
    task: `Draft ${ctx.unit.attributes.reference} with ${ctx.unit.attributes.counterparty}. Redlines: ${ctx.unit.attributes.redlines.join('; ')}. Counsel notes: ${ctx.unit.attributes.counselNotes}`,
  }))
  .halt('counsel', counselHalt, {
    ask: ctx => ctx.steps.draft.document,
    skip: counselSkip,
    facets: ctx => [contractCategory.of(ctx.unit.attributes.category)],
  })
  .exit('returned', ctx => ctx.steps.counsel.action === 'return')
  .halt('signoff', signoffHalt, {
    ask: ctx => `Sign ${ctx.unit.attributes.reference} with ${ctx.unit.attributes.counterparty} for $${ctx.unit.attributes.valueUsd}?`,
    timeout: { afterMinutes: 30, decide: ctx => ({ approve: ctx.unit.attributes.valueUsd < 500 }) },
    escalate: { afterMinutes: 20, run: pageDeputy },
  })
  .exit('rejected', ctx => !ctx.steps.signoff.approve)
  .step('execute', execute, ctx => ({ reference: ctx.unit.attributes.reference, document: ctx.steps.draft.document }), {
    afterCrash: 'park',
  })
  .exit('executed');

const redline = H.signal('redline').payload(z.object({ text: z.string() }));

const inbox = webhook.json('contracts-inbox', {
  port: H.slot.port(1),
  path: '/contracts',
  secret: H.env('CONTRACTS_WEBHOOK_SECRET'),
  payload: z.object({
    type: z.enum(['new', 'redline']),
    reference: z.string(),
    counterparty: z.string(),
    category: contractCategory.schema,
    region: z.enum(['eu', 'us']),
    valueUsd: z.number(),
    text: z.string(),
  }),
});

const documents = ironclad.store({ workspace: 'legal', token: H.env('DOCUMENTS_TOKEN') });

function contractLane(name: string, region: 'eu' | 'us', retry: Retry) {
  return H.lane(name, contractKind)
    .supply(inbox, (e, to) =>
      e.region !== region
        ? to.skip()
        : e.type === 'new'
          ? to.create({
              reference: e.reference,
              counterparty: e.counterparty,
              category: e.category,
              region: e.region,
              valueUsd: e.valueUsd,
              redlines: [],
              counselNotes: '',
            })
          : to.signal(redline, e.reference, { text: e.text }),
    )
    .supply(H.operator)
    .handler(contractFlow, {
      exits: {
        returned: {
          to: Received,
          update: (a, steps) => ({ ...a, counselNotes: steps.counsel?.notes ?? a.counselNotes }),
          limit: { count: 2, then: Declined },
        },
        rejected: SignoffRejected,
        executed: Executed,
      },
    })
    .store(documents)
    .retry({ ...retry, exhausted: DraftingFailed })
    .on(redline, { update: (a, p) => ({ ...a, redlines: [...a.redlines, p.text] }), restart: 'draft', at: ['counsel'] });
}

const contractsEu = contractLane('contracts-eu', 'eu', H.retry({ maxAttempts: 4, backoff: 'exponential', initialDelayMs: 300_000 }));
const contractsUs = contractLane('contracts-us', 'us', H.retry({ maxAttempts: 2, backoff: 'fixed', initialDelayMs: 300_000 }));

const counselDashboard = http.controlApi('counsel-dashboard', {
  port: H.slot.port(2),
  token: H.env('COUNSEL_TOKEN'),
  grants: [H.ops.resolve(counselHalt)],
});

const financeSupervisor = claudeCode.supervisor('finance', {
  grants: [H.ops.resolve(signoffHalt)],
  port: H.slot.port(3),
});

const auditorApi = http.controlApi('auditor', {
  port: H.slot.port(4),
  token: H.env('AUDITOR_TOKEN'),
  grants: [H.ops.workRead, H.ops.telemetryRead],
});

const harness = H.harness('contracts')
  .ledger(sqlite.ledger({ path: '/srv/contracts/ledger.sqlite' }))
  .lanes(contractsEu, contractsUs)
  .metrics(counselApprovals, signoffTimeouts)
  .scheduler(H.scheduler('contracts').standard(contractsEu, contractsUs).wip([contractsEu, contractsUs], 3))
  .clients(counselDashboard, financeSupervisor, auditorApi)
  .observers(markdown.board({ path: '/srv/contracts/board.md' }), markdown.telemetry({ path: '/srv/contracts/telemetry.md' }));

void harness.start();
