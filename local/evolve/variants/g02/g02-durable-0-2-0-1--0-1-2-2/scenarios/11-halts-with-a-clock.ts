import { z } from 'zod';
import { H, type Retry } from 'harness-dsl';
import { sqlite } from 'harness-dsl/sqlite';
import { anthropic } from 'harness-dsl/anthropic';
import { claudeCode } from 'harness-dsl/claude-code';
import { http } from 'harness-dsl/http';
import { webhook } from 'harness-dsl/webhook';
import { ironclad } from 'harness-dsl/ironclad';
import { local } from 'harness-dsl/local';
import { markdown } from 'harness-dsl/markdown';

const category = H.facet('contract-category', ['nda', 'msa', 'sow', 'dpa']);
const region = z.enum(['eu', 'us']);

const localRunner = local.runner('local').slots(2);

const quota = sqlite.quota('contracts-quota', { path: '.harness/quota.sqlite' });
const apiAccount = anthropic.account('anthropic-api', { apiKey: H.env('ANTHROPIC_API_KEY'), quota });
const sonnet = anthropic.model('sonnet', { id: 'claude-sonnet-4-5' });
const pool = H.pool('contracts-pool').accounts(apiAccount);

const contractSchema = z.object({
  contractId: z.string(),
  title: z.string(),
  counterparty: z.string(),
  amountUsd: z.number(),
  category: category.schema,
  region,
  redlines: z.array(z.string()),
  counselNotes: z.array(z.string()),
});

const Received = H.state('Received', 'pending');
const Returned = H.state('Returned', 'pending');
const Stuck = H.state('Stuck', 'waiting');
const Executed = H.terminal('Executed', 'success');
const Rejected = H.terminal('Rejected', 'failure');
const Declined = H.terminal('Declined', 'failure');

const contract = H.kind('Contract')
  .attributes(contractSchema)
  .states(Received, Returned, Stuck, Executed, Rejected, Declined)
  .key(a => a.contractId)
  .initial(Received);

const counselReview = H.halt('counsel-review').decision(z.object({ verdict: z.enum(['approve', 'return']), notes: z.string() }));
const signoff = H.halt('finance-signoff').decision(z.object({ approve: z.boolean(), note: z.string() }));

const counselApprovals = H.metric('counsel-approvals', H.when.decision(contract, counselReview))
  .samples(event => event.resolvedBy === 'human'
    ? [{ hit: event.decision.verdict === 'approve', halt: counselReview, facets: event.facets }]
    : []);

const signoffByTimeout = H.metric('signoff-by-timeout', H.when.decision(contract, signoff))
  .samples(event => [{ hit: event.resolvedBy === 'timeout', halt: signoff }]);

const skipCounsel = H.policy.halt('skip-counsel', contract, counselReview).decide(ctx => {
  const value = ctx.facet(category);
  if (value === undefined) return undefined;
  const record = ctx.metrics.rate(counselApprovals, { halt: counselReview, facets: [category.of(value)] });
  return record.samples >= 200 && record.hits === record.samples
    ? { verdict: 'approve', notes: `counsel skipped: ${record.samples} approvals, no returns` }
    : undefined;
});

const drafterRole = H.role('contract-drafter').intents('read').instructions('Draft the contract, applying every redline and counsel note.');

const drafter = H.seat('drafter')
  .role(drafterRole)
  .model(sonnet)
  .pool(pool)
  .output(z.object({ document: z.string() }));

const pageDeputy = H.command('page-finance-deputy').argv(['pager', 'notify', 'finance-deputy']).runner(localRunner);

const executeContract = H.command('execute-contract')
  .input(z.object({ contractId: z.string() }))
  .argv(input => ['contracts', 'execute', input.contractId])
  .runner(localRunner);

const handleContract = H.flow('handle-contract')
  .input(contractSchema)
  .step('draft', drafter, ctx => ({
    task: `Draft ${ctx.unit.attributes.title} with ${ctx.unit.attributes.counterparty}.\nRedlines:\n${ctx.unit.attributes.redlines.join('\n')}\nCounsel notes:\n${ctx.unit.attributes.counselNotes.join('\n')}`,
  }))
  .halt('counsel', counselReview, {
    ask: ctx => `Review ${ctx.unit.attributes.title}:\n${ctx.steps.draft.document}`,
    skip: skipCounsel,
    facets: ctx => [category.of(ctx.unit.attributes.category)],
  })
  .exit('returned', ctx => ctx.steps.counsel.verdict === 'return')
  .halt('signoff', signoff, {
    ask: ctx => `Sign off ${ctx.unit.attributes.title} for $${ctx.unit.attributes.amountUsd}?`,
    facets: ctx => [category.of(ctx.unit.attributes.category)],
    escalate: { afterMinutes: 20, run: pageDeputy },
    timeout: {
      afterMinutes: 30,
      decide: ctx => ({ approve: ctx.unit.attributes.amountUsd < 500, note: 'resolved by timeout: approve under $500, else reject' }),
    },
  })
  .exit('rejected', ctx => !ctx.steps.signoff.approve)
  .step('execute', executeContract, ctx => ({ contractId: ctx.unit.attributes.contractId }), { afterCrash: 'park' })
  .exit('executed');

const contractEvents = webhook.json('contract-events', {
  port: H.slot.port(1),
  path: '/contracts',
  secret: H.env('CONTRACTS_WEBHOOK_SECRET'),
  payload: z.object({
    type: z.enum(['new', 'redline']),
    contractId: z.string(),
    region,
    title: z.string(),
    counterparty: z.string(),
    amountUsd: z.number(),
    category: category.schema,
    text: z.string(),
  }),
});

const redline = H.signal('redline').payload(z.object({ text: z.string() }));

const documents = ironclad.store({ workspace: 'legal', token: H.env('IRONCLAD_TOKEN') });

const contractLane = (name: string, laneRegion: 'eu' | 'us', retry: Retry) =>
  H.lane(name, contract)
    .supply(contractEvents, (event, to) =>
      event.region !== laneRegion
        ? to.skip()
        : event.type === 'new'
          ? to.create({
            contractId: event.contractId,
            title: event.title,
            counterparty: event.counterparty,
            amountUsd: event.amountUsd,
            category: event.category,
            region: event.region,
            redlines: [event.text],
            counselNotes: [],
          })
          : to.signal(redline, event.contractId, { text: event.text }))
    .supply(H.operator)
    .handler(handleContract, { exits: { returned: Returned, rejected: Rejected, executed: Executed } })
    .store(documents)
    .retry({ ...retry, exhausted: Stuck })
    .on(redline, {
      update: (attrs, payload) => ({ ...attrs, redlines: [...attrs.redlines, payload.text] }),
      restart: 'draft',
      at: ['counsel'],
    })
    .on(counselReview, {
      when: decision => decision.verdict === 'return',
      update: (attrs, decision) => ({ ...attrs, counselNotes: [...attrs.counselNotes, decision.notes] }),
      enter: Declined,
      count: 2,
    });

const contractsEu = contractLane('contracts-eu', 'eu', H.retry({ maxAttempts: 4, backoff: 'exponential', initialDelayMs: 60_000 }));
const contractsUs = contractLane('contracts-us', 'us', H.retry({ maxAttempts: 2 }));

const counselDashboard = http.controlApi('counsel-dashboard', {
  port: H.slot.port(2),
  token: H.env('COUNSEL_TOKEN'),
  grants: [H.ops.workRead, H.ops.resolve(counselReview)],
});

const financeSupervisor = claudeCode.supervisor('finance', {
  grants: [H.ops.workRead, H.ops.resolve(signoff)],
  port: H.slot.port(3),
});

const auditorApi = http.controlApi('auditor', {
  port: H.slot.port(4),
  token: H.env('AUDITOR_TOKEN'),
  grants: [H.ops.workRead, H.ops.telemetryRead],
});

const intakeApi = http.controlApi('intake', {
  port: H.slot.port(5),
  token: H.env('INTAKE_TOKEN'),
  grants: [H.ops.workCreate, H.ops.workSignal],
});

export const contracts = H.harness('contracts')
  .ledger(sqlite.ledger({ path: '.harness/ledger.sqlite' }))
  .lanes(contractsEu, contractsUs)
  .metrics(counselApprovals, signoffByTimeout)
  .scheduler(H.scheduler('contracts').standard(contractsEu, contractsUs).wip([contractsEu, contractsUs], 3))
  .clients(counselDashboard, financeSupervisor, auditorApi, intakeApi)
  .observers(markdown.board({ path: 'BOARD.md' }), markdown.telemetry({ path: 'TELEMETRY.md' }));
