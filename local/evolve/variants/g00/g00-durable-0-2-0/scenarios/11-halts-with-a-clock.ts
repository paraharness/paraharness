import { z } from 'zod';
import { H, Router, Route } from 'harness-dsl';
import { claudeCode } from 'harness-dsl/claude-code';
import { ironclad, IroncladEvent } from 'harness-dsl/ironclad';
import { sqlite } from 'harness-dsl/sqlite';
import { http } from 'harness-dsl/http';
import { local } from 'harness-dsl/local';
import { markdown } from 'harness-dsl/markdown';

const region = z.enum(['eu', 'us']);
type Region = z.infer<typeof region>;

const contract = z.object({
  contractId: z.string(),
  title: z.string(),
  counterparty: z.string(),
  category: z.string(),
  amountUsd: z.number(),
  region,
  text: z.string(),
  redlines: z.array(z.string()),
});
type Contract = z.infer<typeof contract>;

const received = H.state('Received', 'pending');
const drafting = H.state('Drafting', 'active');
const executed = H.terminal('Executed', 'success');
const declined = H.terminal('Declined', 'failure');
const rejected = H.terminal('Rejected', 'failure');
const abandoned = H.terminal('Abandoned', 'failure');
const withdrawn = H.terminal('Withdrawn', 'neutral');

const contractKind = H.kind('Contract')
  .attributes(contract)
  .states(received, drafting, executed, declined, rejected, abandoned, withdrawn)
  .key((attrs) => attrs.contractId)
  .initial(received)
  .onCancelled(withdrawn);

const counselHalt = H.halt(
  'counsel',
  z.object({
    verdict: z.enum(['approved', 'returned', 'redlined']),
    notes: z.string().optional(),
  }),
);

const signoffHalt = H.halt('signoff', z.object({ verdict: z.enum(['approve', 'reject']) }));

const counselApproval = H.metric('counsel-approval', H.when.decided(counselHalt, { kind: contractKind })).samples(
  (event) =>
    event.resolvedBy === 'human' && event.decision.verdict !== 'redlined'
      ? [{ group: event.unit.attributes.category, hit: event.decision.verdict === 'approved' }]
      : [],
);

const signoffByClock = H.metric('signoff-by-clock', H.when.decided(signoffHalt, { kind: contractKind })).samples(
  (event) => [{ group: 'signoff', hit: event.resolvedBy === 'clock' }],
);

const counselSkip = H.policy.halt('counsel-skip', contractKind, counselHalt, (ctx) => {
  const record = ctx.metrics.rate(counselApproval, { group: ctx.unit.attributes.category });
  return record.hits >= 200 && record.hits === record.samples
    ? { verdict: 'approved', notes: `skipped: ${record.hits} of ${record.samples} approved by counsel` }
    : undefined;
});

const legalAccount = claudeCode.subscription('legal-max', { token: H.env('LEGAL_CLAUDE_TOKEN') });
const legalPool = H.pool('legal').accounts(legalAccount);
const opus = claudeCode.model('opus', { id: 'claude-opus-4-1' });

const drafterRole = H.role('contract-drafter')
  .intents('read', 'edit')
  .instructions('Draft the contract text. Apply every outstanding redline from the counterparty.');

const drafter = H.agent('drafter')
  .role(drafterRole)
  .model(opus)
  .pool(legalPool)
  .output(z.object({ text: z.string() }));

const runner = local.runner('local').slots(2);

const executeContract = H.command('execute-contract')
  .input(z.object({ contractId: z.string() }))
  .argv((input) => ['contracts', 'execute', '--id', input.contractId])
  .runner(runner);

const pageDeputy = H.command('page-finance-deputy')
  .input(z.object({ contractId: z.string(), ask: z.string() }))
  .argv((input) => ['pager', 'send', '--team', 'finance-deputy', '--ref', input.contractId, '--message', input.ask])
  .runner(runner);

const contractFlow = H.flow('contract')
  .input(contract)
  .loop(
    'review-rounds',
    (round) =>
      round
        .step('draft', drafter, (ctx) => ({
          task: [
            `Draft "${ctx.unit.attributes.title}" with ${ctx.unit.attributes.counterparty}.`,
            ctx.unit.attributes.text,
            ...ctx.unit.attributes.redlines.map((redline) => `Redline: ${redline}`),
          ].join('\n\n'),
        }))
        .halt('counsel', counselHalt, {
          ask: (ctx) => `Review the draft of "${ctx.unit.attributes.title}":\n\n${ctx.steps.draft.text}`,
          skip: counselSkip,
        }),
    {
      max: 2,
      counts: (ctx) => ctx.steps.counsel.verdict === 'returned',
      until: (ctx) => ctx.steps.counsel.verdict === 'approved',
    },
  )
  .exit('declined', (ctx) => ctx.steps.counsel.verdict !== 'approved')
  .halt('signoff', signoffHalt, {
    ask: (ctx) => `Sign off "${ctx.unit.attributes.title}" for ${ctx.unit.attributes.amountUsd} USD.`,
    clock: {
      afterMinutes: 30,
      decide: (ctx) => ({ verdict: ctx.unit.attributes.amountUsd < 500 ? 'approve' : 'reject' }),
    },
  })
  .exit('rejected', (ctx) => ctx.steps.signoff.verdict === 'reject')
  .step('execute', executeContract, (ctx) => ({ contractId: ctx.unit.attributes.contractId }), { afterCrash: 'park' })
  .exit('executed');

const contractEvents = ironclad.webhook({
  port: H.slot.port(0),
  path: '/ironclad',
  secret: H.env('IRONCLAD_WEBHOOK_SECRET'),
});

const contractStore = ironclad.store({ workspace: 'acme-legal', token: H.env('IRONCLAD_TOKEN') });

const redline = H.signal('redline').payload(z.object({ text: z.string() }));

const routeContract =
  (only: Region) =>
  (event: IroncladEvent, to: Router<Contract, string>): Route => {
    if (event.region !== only) return to.skip();
    if (event.type === 'redline') return to.signal(redline, event.contractId, { text: event.text });
    return to.create({
      contractId: event.contractId,
      title: event.title,
      counterparty: event.counterparty,
      category: event.category,
      amountUsd: event.amountUsd,
      region: event.region,
      text: event.text,
      redlines: [],
    });
  };

const contractLane = (name: string, only: Region, maxAttempts: number) =>
  H.lane(name, contractKind)
    .supply(H.operator)
    .supply(contractEvents, routeContract(only))
    .store(contractStore)
    .handler(contractFlow, {
      exits: { executed, declined, rejected },
      during: { draft: drafting },
    })
    .retry({ maxAttempts, backoff: 'exponential', initialDelayMs: 60_000, exhausted: abandoned })
    .on(redline, {
      update: (attrs, change) => ({ ...attrs, redlines: [...attrs.redlines, change.text] }),
      resolve: { counsel: () => ({ verdict: 'redlined' }) },
    });

const contractsEu = contractLane('contracts-eu', 'eu', 4);
const contractsUs = contractLane('contracts-us', 'us', 2);

const pageDeputyOnSlowSignoff = H.trigger('page-deputy-on-slow-signoff')
  .on(H.when.halted(signoffHalt, { kind: contractKind, afterMinutes: 20 }))
  .run(pageDeputy, (event) => ({ contractId: event.unit.attributes.contractId, ask: event.ask }));

const scheduler = H.scheduler('contracts')
  .admit(contractsEu, (ctx) => ctx.active(contractsEu) + ctx.active(contractsUs) < 3)
  .admit(contractsUs, (ctx) => ctx.active(contractsEu) + ctx.active(contractsUs) < 3);

const counselDashboard = http.controlApi('counsel-dashboard', {
  port: H.slot.port(1),
  token: H.env('COUNSEL_DASHBOARD_TOKEN'),
  grants: [H.ops.resolve(counselHalt)],
});

const financeSupervisor = claudeCode.supervisor('finance-supervisor', {
  grants: [H.ops.resolve(signoffHalt)],
});

const auditorApi = http.controlApi('auditor', {
  port: H.slot.port(2),
  token: H.env('AUDITOR_TOKEN'),
  grants: [H.ops.workRead, H.ops.telemetryRead],
});

H.harness('contracts')
  .ledger(sqlite.ledger({ path: 'contracts.ledger.db' }))
  .lanes(contractsEu, contractsUs)
  .triggers(pageDeputyOnSlowSignoff)
  .metrics(counselApproval, signoffByClock)
  .scheduler(scheduler)
  .clients(counselDashboard, financeSupervisor, auditorApi)
  .observers(markdown.board({ path: 'BOARD.md' }), markdown.telemetry({ path: 'TELEMETRY.md' }))
  .start();
