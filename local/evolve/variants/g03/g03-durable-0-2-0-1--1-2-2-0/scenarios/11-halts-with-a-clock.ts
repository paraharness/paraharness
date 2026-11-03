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
const api = anthropic.account('anthropic-api', { apiKey: H.env('ANTHROPIC_API_KEY'), quota });
const sonnet = anthropic.model('sonnet', { id: 'claude-sonnet-4-5' });
const pool = H.pool('contracts-pool').accounts(api);
const localRunner = local.runner('local');

const contractCategory = H.facet('contract-category', ['nda', 'msa', 'order-form', 'licence']);
const region = z.enum(['eu', 'us']);

const contractAttrs = z.object({
  contractId: z.string(),
  title: z.string(),
  region,
  category: contractCategory.schema,
  valueUsd: z.number(),
  redlines: z.array(z.string()),
  counselNotes: z.array(z.string()),
});

const Open = H.state('open', 'pending');
const Executed = H.terminal('executed', 'success');
const Declined = H.terminal('declined', 'failure');
const RejectedByFinance = H.terminal('rejected-by-finance', 'failure');
const Failed = H.terminal('failed', 'failure');

const contract = H.kind('Contract')
  .attributes(contractAttrs)
  .states(Open, Executed, Declined, RejectedByFinance, Failed)
  .key(a => a.contractId)
  .initial(Open);

const redline = H.signal('redline').payload(z.object({ text: z.string() }));

const counselHalt = H.halt('counsel').decision(z.object({ action: z.enum(['approve', 'return']), notes: z.string() }));
const signoffHalt = H.halt('signoff').decision(z.object({ approve: z.boolean() }));

const counselApprovals = H.metric('counsel-approvals', H.when.decision(contract, counselHalt)).samples(event => {
  const value = event.facet(contractCategory);
  return value === undefined || event.resolvedBy !== 'human'
    ? []
    : [{ hit: event.decision.action === 'approve', facets: [contractCategory.of(value)] }];
});

const signoffTimeouts = H.metric('signoff-timeouts', H.when.decision(contract, signoffHalt)).samples(event => [
  { hit: event.resolvedBy === 'timeout' },
]);

const skipCounsel = H.policy.halt('skip-counsel-for-proven-categories', contract, counselHalt).decide(ctx => {
  const value = ctx.facet(contractCategory);
  if (value === undefined) return undefined;
  const record = ctx.metrics.rate(counselApprovals, { facets: [contractCategory.of(value)] });
  return record.hits >= 200 && record.hits === record.samples ? { action: 'approve', notes: 'skipped: proven category' } : undefined;
});

const drafterRole = H.role('contract-drafter').intents('read').instructions('Draft the contract, applying every redline and counsel note.');
const drafter = H.seat('contract-drafter').role(drafterRole).model(sonnet).pool(pool);

const pageDeputy = H.command('page-finance-deputy').argv(['pager', 'notify', 'finance-deputy']).runner(localRunner);

const execute = H.command('execute-contract')
  .input(z.object({ contractId: z.string() }))
  .argv(i => ['contracts', 'execute', i.contractId])
  .runner(localRunner);

const contractFlow = H.flow('contract')
  .input(contractAttrs)
  .step('draft', drafter, ctx => ({
    task: `Draft ${ctx.unit.attributes.title}.\nRedlines: ${ctx.unit.attributes.redlines.join('; ')}\nCounsel notes: ${ctx.unit.attributes.counselNotes.join('; ')}`,
  }))
  .halt('counsel', counselHalt, {
    ask: ctx => `Review the draft of ${ctx.unit.attributes.title}:\n${ctx.steps.draft}`,
    skip: skipCounsel,
    facets: ctx => [contractCategory.of(ctx.unit.attributes.category)],
    annotate: (attrs, decision) => ({ counselNotes: [...attrs.counselNotes, decision.notes] }),
    limit: { when: decision => decision.action === 'return', max: 2, exit: 'declined' },
  })
  .exit('returned', ctx => ctx.steps.counsel.action === 'return')
  .halt('signoff', signoffHalt, {
    ask: ctx => `Sign off ${ctx.unit.attributes.title} at $${ctx.unit.attributes.valueUsd}?`,
    escalate: { afterMinutes: 20, run: pageDeputy },
    timeout: { afterMinutes: 30, decide: ctx => ({ approve: ctx.unit.attributes.valueUsd < 500 }) },
  })
  .exit('rejected', ctx => !ctx.steps.signoff.approve)
  .step('execute', execute, ctx => ({ contractId: ctx.unit.attributes.contractId }), { afterCrash: 'park' })
  .exit('executed');

const contractEvents = webhook.json('contract-events', {
  port: H.slot.port(3),
  path: '/contracts',
  secret: H.env('CONTRACTS_WEBHOOK_SECRET'),
  payload: z.discriminatedUnion('event', [
    z.object({
      event: z.literal('created'),
      contractId: z.string(),
      title: z.string(),
      region,
      category: contractCategory.schema,
      valueUsd: z.number(),
    }),
    z.object({ event: z.literal('redline'), contractId: z.string(), text: z.string() }),
  ]),
});

const baseContracts = H.lane('contracts', contract)
  .supply(contractEvents, (event, to) =>
    event.event === 'created'
      ? to.create({
          contractId: event.contractId,
          title: event.title,
          region: event.region,
          category: event.category,
          valueUsd: event.valueUsd,
          redlines: [],
          counselNotes: [],
        })
      : to.signal(redline, event.contractId, { text: event.text }))
  .supply(H.operator)
  .store(ironclad.store({ workspace: 'legal', token: H.env('IRONCLAD_TOKEN') }))
  .handler(contractFlow, {
    exits: { returned: Open, declined: Declined, rejected: RejectedByFinance, executed: Executed },
  })
  .on(redline, {
    update: (attrs, payload) => ({ ...attrs, redlines: [...attrs.redlines, payload.text] }),
    restart: 'draft',
    at: ['counsel'],
  });

const contractsEu = baseContracts
  .rename('contracts-eu')
  .accepts(attrs => attrs.region === 'eu')
  .retry({ maxAttempts: 4, backoff: 'exponential', initialDelayMs: 60_000, exhausted: Failed });

const contractsUs = baseContracts
  .rename('contracts-us')
  .accepts(attrs => attrs.region === 'us')
  .retry({ maxAttempts: 2, exhausted: Failed });

const counselDashboard = http.controlApi('counsel-dashboard', {
  port: H.slot.port(1),
  token: H.env('COUNSEL_TOKEN'),
  grants: [H.ops.resolve(counselHalt)],
});

const financeSupervisor = claudeCode.supervisor('finance-supervisor', {
  port: H.slot.port(2),
  grants: [H.ops.resolve(signoffHalt)],
});

const decisionAuditor = http.controlApi('decision-auditor', {
  port: H.slot.port(4),
  token: H.env('AUDITOR_TOKEN'),
  grants: [H.ops.workRead, H.ops.telemetryRead],
});

const contractsOperator = http.controlApi('contracts-operator', {
  port: H.slot.port(5),
  token: H.env('OPERATOR_TOKEN'),
  grants: [H.ops.workCreate, H.ops.workRead, H.ops.attemptsRecover],
});

void H.harness('contracts')
  .ledger(sqlite.ledger({ path: './.harness/ledger.sqlite' }))
  .lanes(contractsEu, contractsUs)
  .metrics(counselApprovals, signoffTimeouts)
  .scheduler(H.scheduler('contracts').standard(contractsEu, contractsUs).wip([contractsEu, contractsUs], 3))
  .clients(counselDashboard, financeSupervisor, decisionAuditor, contractsOperator)
  .observers(markdown.board({ path: './.harness/board.md' }), markdown.telemetry({ path: './.harness/telemetry.md' }))
  .start();
