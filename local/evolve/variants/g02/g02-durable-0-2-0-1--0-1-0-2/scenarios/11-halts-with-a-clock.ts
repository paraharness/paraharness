import { z } from 'zod';
import { H, MetricRef } from 'harness-dsl';
import { sqlite } from 'harness-dsl/sqlite';
import { anthropic } from 'harness-dsl/anthropic';
import { claudeCode } from 'harness-dsl/claude-code';
import { http } from 'harness-dsl/http';
import { webhook } from 'harness-dsl/webhook';
import { ironclad } from 'harness-dsl/ironclad';
import { local } from 'harness-dsl/local';
import { markdown } from 'harness-dsl/markdown';

const quota = sqlite.quota('contracts-quota', { path: 'data/quota.sqlite' });
const apiAccount = anthropic.account('api', { apiKey: H.env('ANTHROPIC_API_KEY'), quota });
const sonnet = anthropic.model('sonnet', { id: 'claude-sonnet-4-5' });
const pool = H.pool('api').accounts(apiAccount);
const shell = local.runner('contracts-shell').slots(2);

const category = H.facet('category');

const drafterRole = H.role('contract-drafter').intents('read', 'edit').instructions('Draft the contract and apply every redline.');

const drafter = H.seat('contract-drafter')
  .output(z.object({ documentUrl: z.string() }))
  .role(drafterRole)
  .model(sonnet)
  .pool(pool);

const counselDecision = z.object({ verdict: z.enum(['approve', 'return']), notes: z.string() });
const counsel = H.halt('counsel').decision(counselDecision);
const signoff = H.halt('signoff').decision(z.object({ approved: z.boolean(), note: z.string() }));

const counselApprovals: MetricRef<'rate'> = H.metric('counsel-approvals', H.when.decision([euContracts(), usContracts()], counsel))
  .facets(category)
  .samples(decided =>
    decided.resolvedBy === 'human'
      ? [{ hit: decided.decision.verdict === 'approve', by: { facets: [category.of(decided.unit.attributes.category)] } }]
      : [],
  );

const counselSkip = H.policy.halt('counsel-skip-proven-category', counsel, z.object({ category: z.string() }), ctx => {
  const record = ctx.metrics.rate(counselApprovals, { by: { facets: [category.of(ctx.input.category)] } });
  if (record.samples < 200 || record.hits !== record.samples) return undefined;
  const decision: z.infer<typeof counselDecision> = {
    verdict: 'approve',
    notes: `category ${ctx.input.category}: ${record.hits} of ${record.samples} approved`,
  };
  return decision;
});

const pageDeputy = H.command('page-deputy').argv(['pager', 'notify', '--team', 'finance-deputy']).runner(shell);

const executeContract = H.command('execute-contract')
  .input(z.object({ contractId: z.string() }))
  .argv(i => ['contracts', 'execute', i.contractId])
  .runner(shell);

const contractAttributes = z.object({
  contractId: z.string(),
  title: z.string(),
  counterparty: z.string(),
  category: z.string(),
  valueUsd: z.number(),
  region: z.enum(['eu', 'us']),
  redlines: z.array(z.string()),
});

const Received = H.state('Received', 'pending');
const Drafting = H.state('Drafting', 'active');
const AwaitingCounsel = H.state('AwaitingCounsel', 'waiting');
const AwaitingSignoff = H.state('AwaitingSignoff', 'waiting');
const Executing = H.state('Executing', 'active');
const Executed = H.terminal('Executed', 'success');
const Declined = H.terminal('Declined', 'failure');
const Rejected = H.terminal('Rejected', 'failure');
const Abandoned = H.terminal('Abandoned', 'failure');

const Contract = H.kind('Contract')
  .attributes(contractAttributes)
  .states(Received, Drafting, AwaitingCounsel, AwaitingSignoff, Executing, Executed, Declined, Rejected, Abandoned)
  .key(a => a.contractId)
  .initial(Received);

const contractFlow = H.flow('contract')
  .input(contractAttributes)
  .loop(
    'counsel-rounds',
    f =>
      f
        .step('draft', drafter, ctx => ({
          task: `Draft ${ctx.unit.attributes.title} with ${ctx.unit.attributes.counterparty}, round ${ctx.iteration + 1}. Redlines: ${ctx.unit.attributes.redlines.join('; ')}`,
        }), { afterCrash: 'askDriver' })
        .halt('counsel', counsel, {
          ask: ctx => `Review ${ctx.unit.attributes.title}: ${ctx.steps.draft.documentUrl}`,
          skip: { by: counselSkip, input: ctx => ({ category: ctx.unit.attributes.category }) },
        }),
    { max: 2, until: ctx => ctx.steps.counsel.verdict === 'approve' },
  )
  .exit('declined', ctx => ctx.steps.counsel.verdict === 'return')
  .halt('signoff', signoff, {
    ask: ctx => `Sign off ${ctx.unit.attributes.title} for ${ctx.unit.attributes.valueUsd} USD`,
    escalate: { afterMinutes: 20, run: pageDeputy },
    timeout: {
      afterMinutes: 30,
      decide: ctx => ({ approved: ctx.unit.attributes.valueUsd < 500, note: 'resolved by timeout: approve under 500 USD, else reject' }),
    },
  })
  .exit('rejected', ctx => !ctx.steps.signoff.approved)
  .step('execute', executeContract, ctx => ({ contractId: ctx.unit.attributes.contractId }), { afterCrash: 'park' })
  .exit('executed');

const redline = H.signal('redline').payload(z.object({ text: z.string() }));

const contractEvents = webhook.json('contract-events', {
  port: H.slot.port(1),
  path: '/contracts',
  secret: H.env('CONTRACTS_WEBHOOK_SECRET'),
  payload: z.discriminatedUnion('type', [
    z.object({
      type: z.literal('new'),
      contractId: z.string(),
      title: z.string(),
      counterparty: z.string(),
      category: z.string(),
      valueUsd: z.number(),
      region: z.enum(['eu', 'us']),
    }),
    z.object({ type: z.literal('redline'), contractId: z.string(), region: z.enum(['eu', 'us']), text: z.string() }),
  ]),
});

const documents = ironclad.store({ workspace: 'legal', token: H.env('IRONCLAD_TOKEN') });

const contractLane = (name: string, region: 'eu' | 'us', maxAttempts: number) =>
  H.lane(name, Contract)
    .supply(contractEvents, (event, to) =>
      event.region !== region
        ? to.skip()
        : event.type === 'new'
          ? to.create({
              contractId: event.contractId,
              title: event.title,
              counterparty: event.counterparty,
              category: event.category,
              valueUsd: event.valueUsd,
              region: event.region,
              redlines: [],
            })
          : to.signal(redline, event.contractId, { text: event.text }),
    )
    .supply(H.operator)
    .store(documents)
    .handler(contractFlow, {
      exits: { declined: Declined, rejected: Rejected, executed: Executed },
      during: { draft: Drafting, execute: Executing, counsel: AwaitingCounsel, signoff: AwaitingSignoff },
    })
    .retry({ maxAttempts, backoff: 'exponential', initialDelayMs: 120000, exhausted: Abandoned })
    .on(redline, {
      update: (attrs, change) => ({ ...attrs, redlines: [...attrs.redlines, change.text] }),
      restart: { to: 'draft', at: ['counsel'] },
    });

function euContracts() {
  return contractLane('contracts-eu', 'eu', 4);
}

function usContracts() {
  return contractLane('contracts-us', 'us', 2);
}

const eu = euContracts();
const us = usContracts();

const counselDashboard = http.controlApi('counsel-dashboard', {
  port: H.slot.port(2),
  token: H.env('COUNSEL_TOKEN'),
  grants: [H.ops.workRead, H.ops.resolve(counsel)],
});

const financeSupervisor = claudeCode.supervisor('finance').client('finance-supervisor', {
  grants: [H.ops.workRead, H.ops.resolve(signoff)],
});

const deputySupervisor = claudeCode.supervisor('finance-deputy').client('deputy-supervisor', {
  grants: [H.ops.workRead, H.ops.resolve(signoff, { onceEscalated: true })],
});

const auditor = http.controlApi('decision-auditor', {
  port: H.slot.port(3),
  token: H.env('AUDITOR_TOKEN'),
  grants: [H.ops.workRead, H.ops.telemetryRead],
});

const operations = http.controlApi('contracts-operations', {
  port: H.slot.port(4),
  token: H.env('OPERATIONS_TOKEN'),
  grants: [H.ops.workRead, H.ops.workCreate, H.ops.attemptsRecover],
});

const harness = H.harness('contracts')
  .ledger(sqlite.ledger({ path: 'data/ledger.sqlite' }))
  .lanes(eu, us)
  .metrics(counselApprovals)
  .scheduler(H.scheduler('contracts-scheduler').priority(eu, us).wip(eu, 3).wip(us, 3))
  .clients(counselDashboard, financeSupervisor, deputySupervisor, auditor, operations)
  .observers(markdown.board({ path: 'data/board.md' }), markdown.telemetry({ path: 'data/telemetry.md' }));

void harness.start();
