import { z } from 'zod';
import { H } from 'harness-dsl';
import type { Retry } from 'harness-dsl';
import * as sqlite from 'harness-dsl/sqlite';
import * as http from 'harness-dsl/http';
import * as claudeCode from 'harness-dsl/claude-code';
import * as anthropic from 'harness-dsl/anthropic';
import * as ironclad from 'harness-dsl/ironclad';
import * as local from 'harness-dsl/local';
import * as slack from 'harness-dsl/slack';
import * as markdown from 'harness-dsl/markdown';

const New = H.state('New', 'pending');
const Drafting = H.state('Drafting', 'active');
const AwaitingCounsel = H.state('AwaitingCounsel', 'waiting');
const AwaitingSignoff = H.state('AwaitingSignoff', 'waiting');
const Executing = H.state('Executing', 'active');
const Held = H.state('Held', 'waiting');
const Executed = H.state('Executed', 'terminal', 'success');
const Rejected = H.state('Rejected', 'terminal', 'failure');
const Declined = H.state('Declined', 'terminal', 'failure');
const Failed = H.state('Failed', 'terminal', 'failure');

const Contract = H.work('Contract')
  .attributes({
    contractId: z.string(),
    region: z.enum(['eu', 'us']),
    title: z.string(),
    counterparty: z.string(),
    category: z.string(),
    amountUsd: z.number(),
  })
  .states([New, Drafting, AwaitingCounsel, AwaitingSignoff, Executing, Held, Executed, Rejected, Declined, Failed])
  .failsTo(Failed)
  .events({ redline: { text: z.string(), author: z.string() } })
  .key((unit) => unit.attributes.contractId);

const counselReview = H.decision('counsel', { verdict: z.enum(['approve', 'return']), notes: z.string() });
const financeSignoff = H.decision('signoff', { approve: z.boolean(), note: z.string() });

const counselApproval = H.metric('counsel-approval')
  .of(counselReview)
  .hit((decision) => decision.verdict === 'approve');

const counselSkip = H.policy.halt('counsel-skip-proven-category', Contract, counselReview).decides((c) => {
  const record = c.metrics.read(counselApproval, {
    kind: Contract,
    resolver: 'human',
    where: { category: c.unit.attributes.category },
    window: 'all',
  });
  return record.n >= 200 && record.hits === record.n
    ? { verdict: 'approve', notes: `category ${c.unit.attributes.category}: ${record.hits}/${record.n} approved by counsel` }
    : null;
});

const drafterRole = H.role('contract-drafter')
  .instructions('Draft the contract, applying every counterparty redline in order.')
  .intents(['read', 'write'])
  .input({ title: z.string(), counterparty: z.string(), redlines: z.array(z.string()) })
  .output({ document: z.string(), summary: z.string() });

const drafter = H.agent('drafter', drafterRole)
  .model(anthropic.model('claude-sonnet-4-5'))
  .pool(anthropic.account('contracts-api', { apiKey: H.env('ANTHROPIC_API_KEY') }));

const executeContract = H.command('execute-contract', ['contracts', 'execute']);

const contractFlow = H.flow('contract')
  .requires({ title: z.string(), counterparty: z.string(), amountUsd: z.number() })
  .events({ redline: { text: z.string(), author: z.string() } })
  .step('draft', drafter, (c) => ({
    title: c.input.title,
    counterparty: c.input.counterparty,
    redlines: c.events.redline.map((received) => received.payload.text),
  }))
  .halt('counsel', counselReview, {
    ask: (c) => `Review ${c.input.title} with ${c.input.counterparty}: ${c.out.draft.summary}`,
  })
  .exit('returned', (c) => c.out.counsel.verdict === 'return')
  .halt('signoff', financeSignoff, {
    ask: (c) => `Sign off ${c.input.title} for $${c.input.amountUsd}`,
    timeout: {
      after: { minutes: 30 },
      resolve: (c) => ({
        approve: c.input.amountUsd < 500,
        note: c.input.amountUsd < 500 ? 'approved by timeout under $500' : 'rejected by timeout at or over $500',
      }),
    },
  })
  .exit('rejected', (c) => !c.out.signoff.approve)
  .step('execute', executeContract, (c) => ({ args: [c.unit.key] }), { restart: 'escalate' })
  .ends(['executed'], () => 'executed');

const contractBody = z.object({
  type: z.enum(['created', 'redline']),
  contractId: z.string(),
  title: z.string(),
  counterparty: z.string(),
  category: z.string(),
  amountUsd: z.number(),
  text: z.string(),
  author: z.string(),
});

const contractWebhook = (region: 'eu' | 'us') =>
  http.webhook(
    Contract,
    { path: `/contracts/${region}`, port: H.slot.port(0), secret: H.env('CONTRACT_WEBHOOK_SECRET'), body: contractBody },
    (body, supply) =>
      body.type === 'created'
        ? supply.create({
            attributes: {
              contractId: body.contractId,
              region,
              title: body.title,
              counterparty: body.counterparty,
              category: body.category,
              amountUsd: body.amountUsd,
            },
          })
        : supply.event(body.contractId, 'redline', { text: body.text, author: body.author }),
  );

const documents = ironclad.store(Contract, {
  apiKey: H.env('IRONCLAD_API_KEY'),
  workspace: 'legal',
  status: {
    New: 'intake',
    Drafting: 'drafting',
    AwaitingCounsel: 'in-review',
    AwaitingSignoff: 'pending-signature',
    Executing: 'executing',
    Held: 'on-hold',
    Executed: 'executed',
    Rejected: 'rejected',
    Declined: 'declined',
    Failed: 'failed',
  },
});

const shell = local.shell({ slots: 3 });

const contractLane = (name: string, region: 'eu' | 'us', retry: Retry) =>
  H.lane(name, Contract)
    .supply([contractWebhook(region), H.supply.operator()])
    .store(documents)
    .handler(contractFlow, {
      states: {
        draft: Drafting,
        counsel: AwaitingCounsel,
        signoff: AwaitingSignoff,
        execute: Executing,
        returned: H.loopback(New, { max: 1, then: Declined }),
        rejected: Rejected,
        executed: Executed,
      },
      opens: Drafting,
      blocked: Held,
      resolvers: { counsel: counselSkip },
    })
    .runner(shell)
    .wip(3)
    .retry(retry)
    .reacts({ redline: H.reaction(New).from([AwaitingCounsel]).cancels() });

const contractsEu = contractLane('contracts-eu', 'eu', H.retry.exponential({ maxRetries: 3, initialDelayMs: 60_000, maxDelayMs: 3_600_000 }));
const contractsUs = contractLane('contracts-us', 'us', H.retry.exponential({ maxRetries: 1, initialDelayMs: 60_000 }));

const deputyPager = slack.notify('finance-deputy-pager', { webhookUrl: H.env('FINANCE_DEPUTY_SLACK_URL') });

const pageFinanceDeputy = H.trigger('page-finance-deputy', H.on.halted(financeSignoff, { after: { minutes: 20 } }))
  .invokes(deputyPager, (halted) => ({
    text: `Signoff on ${halted.unit.key} has waited 20 minutes; it resolves itself at ${new Date(halted.timeoutAt ?? halted.haltedAt).toISOString()}.`,
  }));

const counselAccess = H.access('counsel').allows([H.ops.readWork]).resolves([counselReview]);
const financeAccess = H.access('finance').allows([H.ops.readWork]).resolves([financeSignoff]);
const auditorAccess = H.access('decision-auditor').allows([H.ops.readWork, H.ops.readTelemetry]);
const intakeAccess = H.access('contract-intake').allows([H.ops.readWork, H.ops.createWork, H.ops.sendEvents, H.ops.manageAttempts, H.ops.resolveBlocks]);

const decisionReport = H.report('contract-decisions', (c) => ({
  'counsel time to decision, human': c.metrics.decisions({ decision: counselReview, resolver: 'human', window: { days: 30 } }),
  'counsel time to decision, policy': c.metrics.decisions({ decision: counselReview, resolver: 'policy', window: { days: 30 } }),
  'signoff time to decision, human': c.metrics.decisions({ decision: financeSignoff, resolver: 'human', window: { days: 30 } }),
  'signoff time to decision, timeout': c.metrics.decisions({ decision: financeSignoff, resolver: 'timeout', window: { days: 30 } }),
  'signoff resolved by timeout': c.metrics.decisions({ decision: financeSignoff, window: { days: 30 } }).share('timeout'),
  'contracts-eu retries this month': c.metrics.attempts({ lane: contractsEu, window: { sinceMs: c.clock.startOfMonth() } }).retries,
  'contracts-us retries this month': c.metrics.attempts({ lane: contractsUs, window: { sinceMs: c.clock.startOfMonth() } }).retries,
}));

export const contracts = H.harness('contracts')
  .ledger(sqlite.ledger('contracts.ledger.db'))
  .lanes([contractsEu, contractsUs])
  .triggers([pageFinanceDeputy])
  .schedule(H.policy.schedule('oldest-first', (c) => ({ start: c.order((candidate) => candidate.enqueuedAt) })))
  .clients([
    http.server('counsel-dashboard', counselAccess, { port: H.slot.port(1), token: H.env('COUNSEL_TOKEN') }),
    claudeCode.supervisor('finance-supervisor', financeAccess, { port: H.slot.port(2) }),
    http.server('decision-auditor', auditorAccess, { port: H.slot.port(3), token: H.env('AUDITOR_TOKEN') }),
    http.server('contract-intake', intakeAccess, { port: H.slot.port(4), token: H.env('INTAKE_TOKEN') }),
  ])
  .projections([markdown.board('contracts/BOARD.md'), markdown.telemetry('contracts/TELEMETRY.md')])
  .reports([decisionReport]);
