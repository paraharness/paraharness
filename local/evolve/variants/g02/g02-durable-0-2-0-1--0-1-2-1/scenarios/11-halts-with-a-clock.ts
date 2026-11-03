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

const ContractCategory = z.enum(['nda', 'msa', 'order-form', 'dpa']);
const contractCategory = H.facet('contract-category', ContractCategory.options);

const ContractAttrs = z.object({
  contractId: z.string(),
  title: z.string(),
  counterparty: z.string(),
  region: z.enum(['eu', 'us']),
  category: ContractCategory,
  amountUsd: z.number(),
  redlines: z.array(z.string()),
});

const Received = H.state('Received', 'pending');
const Executed = H.terminal('Executed', 'success');
const Declined = H.terminal('Declined', 'failure');
const Rejected = H.terminal('Rejected', 'failure');
const Failed = H.terminal('Failed', 'failure');
const Contract = H.kind('Contract')
  .attributes(ContractAttrs)
  .states(Received, Executed, Declined, Rejected, Failed)
  .key(a => a.contractId)
  .initial(Received);

const CounselDecision = z.object({ verdict: z.enum(['approve', 'return']), notes: z.string() });
const counsel = H.halt('counsel').decision(CounselDecision);
const signoff = H.halt('signoff').decision(z.object({ approved: z.boolean() }));

const counselApproval = H.metric('counsel-approval', H.when.decision(Contract, counsel)).samples(ev =>
  ev.resolvedBy === 'human'
    ? [{ hit: ev.decision.verdict === 'approve', halt: counsel, facets: [contractCategory.of(ev.unit.attributes.category)] }]
    : []);
const signoffByTimeout = H.metric('signoff-by-timeout', H.when.decision(Contract, signoff))
  .samples(ev => [{ hit: ev.resolvedBy === 'timeout', halt: signoff }]);

const counselSkip = H.policy.halt('counsel-skip', Contract, counsel).decide(ctx => {
  const track = ctx.metrics.rate(counselApproval, { facets: [contractCategory.of(ctx.unit.attributes.category)] });
  return track.samples >= 200 && track.hits === track.samples
    ? { verdict: 'approve', notes: `skipped: ${track.hits} of ${track.samples} approved` }
    : undefined;
});

const apiAccount = anthropic.account('contracts-api', {
  apiKey: H.env('ANTHROPIC_API_KEY'),
  quota: sqlite.quota('contracts-api', { path: './contracts/quota.sqlite' }),
});
const opus = anthropic.model('opus', { id: 'claude-opus-4-1' });
const draftingRole = H.role('contract-drafter').intents('read', 'edit').instructions('Draft the contract, applying every redline and counsel note.');
const drafter = H.seat('contract-drafter').role(draftingRole).model(opus).pool(H.pool('contracts').accounts(apiAccount));

const runner = local.runner('contracts-box');
const pageDeputy = H.command('page-deputy').argv(['./bin/page', 'finance-deputy']).runner(runner);
const execute = H.command('execute-contract')
  .input(z.object({ contractId: z.string() }))
  .argv(i => ['./bin/execute', i.contractId])
  .runner(runner);

const contractFlow = H.flow('contract')
  .input(ContractAttrs)
  .loop('counselRounds', CounselDecision, f => f
    .step('draft', drafter, ctx => ({
      task: `Draft ${ctx.unit.attributes.title} with ${ctx.unit.attributes.counterparty}.\nRedlines:\n${ctx.unit.attributes.redlines.join('\n')}\nCounsel notes from earlier rounds:\n${ctx.steps.counselRounds.map(n => n.notes).join('\n')}`,
    }))
    .halt('counsel', counsel, {
      ask: ctx => `Review ${ctx.unit.attributes.title}:\n${ctx.steps.draft}`,
      skip: counselSkip,
      facets: ctx => [contractCategory.of(ctx.unit.attributes.category)],
    }),
    {
      max: 2,
      until: ctx => ctx.steps.counsel.verdict === 'approve',
      keep: ctx => ctx.steps.counsel,
    })
  .exit('declined', ctx => ctx.steps.counsel.verdict === 'return')
  .halt('signoff', signoff, {
    ask: ctx => `Sign off ${ctx.unit.attributes.title} for ${ctx.unit.attributes.amountUsd} USD?`,
    escalate: { afterMinutes: 20, run: pageDeputy },
    timeout: { afterMinutes: 30, decide: ctx => ({ approved: ctx.unit.attributes.amountUsd < 500 }) },
  })
  .exit('rejected', ctx => ctx.steps.signoff.approved === false)
  .step('execute', execute, ctx => ({ contractId: ctx.unit.attributes.contractId }), { afterCrash: 'park' })
  .exit('executed');

const redline = H.signal('redline').payload(z.object({ text: z.string() }));

const contractEvents = webhook.json('contract-events', {
  port: H.slot.port(1),
  path: '/contracts',
  secret: H.env('CONTRACT_WEBHOOK_SECRET'),
  payload: z.discriminatedUnion('type', [
    z.object({ type: z.literal('new'), contract: ContractAttrs }),
    z.object({ type: z.literal('redline'), contractId: z.string(), text: z.string() }),
  ]),
});

const documents = ironclad.store({ workspace: 'legal', token: H.env('IRONCLAD_TOKEN') });

const contractsEu = H.lane('contracts-eu', Contract)
  .supply(contractEvents, (ev, to) =>
    ev.type === 'redline' ? to.signal(redline, ev.contractId, { text: ev.text })
      : ev.contract.region === 'eu' ? to.create(ev.contract) : to.skip())
  .supply(H.operator)
  .handler(contractFlow, { exits: { declined: Declined, rejected: Rejected, executed: Executed } })
  .store(documents)
  .retry({ maxAttempts: 4, backoff: 'exponential', initialDelayMs: 60_000, exhausted: Failed })
  .on(redline, { update: (a, p) => ({ ...a, redlines: [...a.redlines, p.text] }), rewind: 'draft', at: ['counsel'] });

const contractsUs = H.lane('contracts-us', Contract)
  .supply(contractEvents, (ev, to) =>
    ev.type === 'redline' ? to.signal(redline, ev.contractId, { text: ev.text })
      : ev.contract.region === 'us' ? to.create(ev.contract) : to.skip())
  .supply(H.operator)
  .handler(contractFlow, { exits: { declined: Declined, rejected: Rejected, executed: Executed } })
  .store(documents)
  .retry({ maxAttempts: 2, exhausted: Failed })
  .on(redline, { update: (a, p) => ({ ...a, redlines: [...a.redlines, p.text] }), rewind: 'draft', at: ['counsel'] });

const counselDashboard = http.controlApi('counsel-dashboard', {
  port: H.slot.port(2),
  token: H.env('COUNSEL_TOKEN'),
  grants: [H.ops.workRead, H.ops.resolve(counsel)],
});
const financeSupervisor = claudeCode.supervisor('finance-supervisor', {
  port: H.slot.port(3),
  grants: [H.ops.workRead, H.ops.resolve(signoff)],
});
const auditorApi = http.controlApi('auditor-api', {
  port: H.slot.port(4),
  token: H.env('AUDITOR_TOKEN'),
  grants: [H.ops.workRead, H.ops.telemetryRead],
});

export const harness = H.harness('contracts')
  .ledger(sqlite.ledger({ path: './contracts/ledger.sqlite' }))
  .lanes(contractsEu, contractsUs)
  .metrics(counselApproval, signoffByTimeout)
  .scheduler(H.scheduler('contracts')
    .standard(contractsEu, contractsUs)
    .wip([contractsEu, contractsUs], 3))
  .clients(counselDashboard, financeSupervisor, auditorApi)
  .observers(markdown.board({ path: './contracts/BOARD.md' }), markdown.telemetry({ path: './contracts/TELEMETRY.md' }));
