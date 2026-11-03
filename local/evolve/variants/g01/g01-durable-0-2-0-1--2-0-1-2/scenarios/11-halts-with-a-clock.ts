import { z } from 'zod';
import { H } from 'harness-dsl';
import { sqlite } from 'harness-dsl/sqlite';
import { anthropic } from 'harness-dsl/anthropic';
import { claudeCode } from 'harness-dsl/claude-code';
import { http } from 'harness-dsl/http';
import { webhook } from 'harness-dsl/webhook';
import { ironclad } from 'harness-dsl/ironclad';
import { local } from 'harness-dsl/local';
import { markdown } from 'harness-dsl/markdown';

const quota = sqlite.quota('contracts-quota', { path: './.harness/quota.sqlite' });
const apiAccount = anthropic.account('api', { apiKey: H.env('ANTHROPIC_API_KEY'), quota });
const opus = anthropic.model('opus', { id: 'claude-opus-4-1' });
const pool = H.pool('contracts-pool').accounts(apiAccount);

const runner = local.runner('local').slots(2);

const contractAttrs = z.object({
  contractId: z.string(),
  title: z.string(),
  valueUsd: z.number(),
  category: z.string(),
  redlines: z.array(z.string()),
});

const received = H.state('Received', 'pending');
const stalled = H.state('Stalled', 'waiting');
const executed = H.terminal('Executed', 'success');
const declined = H.terminal('Declined', 'failure');
const refusedByFinance = H.terminal('RefusedByFinance', 'failure');
const withdrawn = H.terminal('Withdrawn', 'neutral');

const contract = H.kind('Contract')
  .attributes(contractAttrs)
  .states(received, stalled, executed, declined, refusedByFinance, withdrawn)
  .key(a => a.contractId)
  .initial(received);

const redline = H.signal('redline').payload(z.object({ text: z.string() }));

const counsel = H.halt('counsel').decision(z.object({ verdict: z.enum(['approve', 'return']), notes: z.string() }));
const signoff = H.halt('signoff').decision(z.object({ approved: z.boolean() }));

const categoryFacet = H.facet('category');

const counselApproval = H.metric('counsel-approval', H.when.decision(contract, counsel)).samples(event =>
  event.resolvedBy === 'human'
    ? [{ hit: event.decision.verdict === 'approve', halt: counsel, facets: event.facets }]
    : []);

const signoffByTimeout = H.metric('signoff-by-timeout', H.when.decision(contract, signoff)).samples(event => [
  { hit: event.resolvedBy === 'timeout', halt: signoff },
]);

const counselSkip = H.policy.halt('counsel-skip-by-track-record', contract, counsel).decide(ctx => {
  const record = ctx.metrics.rate(counselApproval, { facets: ctx.facets });
  return record.samples >= 200 && record.hits === record.samples
    ? { verdict: 'approve', notes: `Skipped: ${record.samples} approvals, no returns` }
    : undefined;
});

const drafterRole = H.role('contract-drafter').intents('read').instructions('Draft the contract, applying every counterparty redline and counsel note.');

const drafterSeat = H.seat('contract-drafter')
  .role(drafterRole)
  .model(opus)
  .pool(pool)
  .output(z.object({ document: z.string() }));

const pageDeputy = H.command('page-finance-deputy').argv(['pager', 'notify', 'finance-deputy']).runner(runner);

const executeContract = H.command('execute-contract')
  .input(z.object({ contractId: z.string(), document: z.string() }))
  .argv(input => ['contracts', 'execute', input.contractId])
  .runner(runner);

const contractFlow = H.flow('contract')
  .input(contractAttrs)
  .loop(
    'review',
    flow => flow
      .step('draft', drafterSeat, ctx => ({
        task: `Draft ${ctx.unit.attributes.title}. Redlines: ${ctx.unit.attributes.redlines.join('; ') || 'none'}`,
      }), { afterCrash: 'askDriver' })
      .halt('counsel', counsel, {
        ask: ctx => ctx.steps.draft.document,
        skip: counselSkip,
        facets: ctx => [categoryFacet.of(ctx.unit.attributes.category)],
      }),
    {
      max: 2,
      until: ctx => ctx.steps.counsel.verdict === 'approve',
    },
  )
  .exit('declined', ctx => ctx.steps.counsel.verdict !== 'approve')
  .halt('signoff', signoff, {
    ask: ctx => `Sign off ${ctx.unit.attributes.title} at $${ctx.unit.attributes.valueUsd}?`,
    escalate: { afterMinutes: 20, run: pageDeputy },
    timeout: { afterMinutes: 30, decide: ctx => ({ approved: ctx.unit.attributes.valueUsd < 500 }) },
  })
  .exit('refused', ctx => !ctx.steps.signoff.approved)
  .step('execute', executeContract, ctx => ({ contractId: ctx.unit.attributes.contractId, document: ctx.steps.draft.document }), {
    afterCrash: 'park',
  })
  .exit('executed');

const contractEvent = z.discriminatedUnion('type', [
  z.object({ type: z.literal('new'), contractId: z.string(), title: z.string(), valueUsd: z.number(), category: z.string() }),
  z.object({ type: z.literal('redline'), contractId: z.string(), text: z.string() }),
]);

const documentStore = ironclad.store({ workspace: 'legal', token: H.env('DOCUMENT_SYSTEM_TOKEN') });

const euContracts = H.lane('contracts-eu', contract)
  .supply(
    webhook.json('contracts-eu-webhook', {
      port: H.slot.port(4),
      path: '/contracts/eu',
      secret: H.env('CONTRACTS_WEBHOOK_SECRET'),
      payload: contractEvent,
    }),
    (event, to) =>
      event.type === 'new'
        ? to.create({ contractId: event.contractId, title: event.title, valueUsd: event.valueUsd, category: event.category, redlines: [] })
        : to.signal(redline, event.contractId, { text: event.text }),
  )
  .supply(H.operator)
  .handler(contractFlow, { exits: { declined, refused: refusedByFinance, executed } })
  .store(documentStore)
  .retry({ maxAttempts: 3, backoff: 'exponential', initialDelayMs: 60000, exhausted: stalled })
  .on(redline, {
    update: (attrs, change) => ({ ...attrs, redlines: [...attrs.redlines, change.text] }),
    restart: 'draft',
    at: ['counsel'],
  })
  .on(H.cancel, { enter: withdrawn });

const usContracts = H.lane('contracts-us', contract)
  .supply(
    webhook.json('contracts-us-webhook', {
      port: H.slot.port(5),
      path: '/contracts/us',
      secret: H.env('CONTRACTS_WEBHOOK_SECRET'),
      payload: contractEvent,
    }),
    (event, to) =>
      event.type === 'new'
        ? to.create({ contractId: event.contractId, title: event.title, valueUsd: event.valueUsd, category: event.category, redlines: [] })
        : to.signal(redline, event.contractId, { text: event.text }),
  )
  .supply(H.operator)
  .handler(contractFlow, { exits: { declined, refused: refusedByFinance, executed } })
  .store(documentStore)
  .retry({ maxAttempts: 1, exhausted: stalled })
  .on(redline, {
    update: (attrs, change) => ({ ...attrs, redlines: [...attrs.redlines, change.text] }),
    restart: 'draft',
    at: ['counsel'],
  })
  .on(H.cancel, { enter: withdrawn });

const counselDashboard = http.controlApi('counsel-dashboard', {
  port: H.slot.port(1),
  token: H.env('COUNSEL_TOKEN'),
  grants: [H.ops.workRead, H.ops.resolve(counsel)],
});

const financeSupervisor = claudeCode.supervisor('finance-supervisor', {
  port: H.slot.port(2),
  grants: [H.ops.workRead, H.ops.resolve(signoff)],
});

const auditReader = http.controlApi('audit-reader', {
  port: H.slot.port(3),
  token: H.env('AUDITOR_TOKEN'),
  grants: [H.ops.workRead, H.ops.telemetryRead],
});

const operatorApi = http.controlApi('contracts-operator', {
  port: H.slot.port(6),
  token: H.env('OPERATOR_TOKEN'),
  grants: [H.ops.workRead, H.ops.workCreate, H.ops.workCancel, H.ops.attemptsRecover, H.ops.telemetryRead],
});

export const harness = H.harness('contracts')
  .ledger(sqlite.ledger({ path: './.harness/ledger.sqlite' }))
  .lanes(euContracts, usContracts)
  .metrics(counselApproval, signoffByTimeout)
  .scheduler(H.scheduler('contracts-scheduler').standard(euContracts, usContracts).wip([euContracts, usContracts], 3))
  .clients(counselDashboard, financeSupervisor, auditReader, operatorApi)
  .observers(
    markdown.board({ path: './.harness/board.md' }),
    markdown.telemetry({ path: './.harness/telemetry.md' }),
  );
