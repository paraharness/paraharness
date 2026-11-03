import { z } from 'zod';
import { H, Retry } from 'harness-dsl';
import { sqlite } from 'harness-dsl/sqlite';
import { claudeCode } from 'harness-dsl/claude-code';
import { ironclad } from 'harness-dsl/ironclad';
import { webhook } from 'harness-dsl/webhook';
import { http } from 'harness-dsl/http';
import { local } from 'harness-dsl/local';
import { markdown } from 'harness-dsl/markdown';

const localRunner = local.runner('local');
const quota = sqlite.quota('contracts-quota', { path: '.harness/quota.db' });
const subscription = claudeCode.subscription('contracts-max', { token: H.env('CLAUDE_MAX_TOKEN'), quota });
const draftingPool = H.pool('drafting').accounts(subscription);
const opus = claudeCode.model('opus', { id: 'claude-opus-4-1' });

const category = H.facet('contract-category', ['nda', 'msa', 'sow', 'procurement']);

const contractEvent = z.object({
  type: z.enum(['new', 'redline']),
  contractId: z.string(),
  region: z.enum(['eu', 'us']),
  title: z.string(),
  category: category.schema,
  valueUsd: z.number(),
  text: z.string(),
});

type Region = z.infer<typeof contractEvent>['region'];

const contractSchema = z.object({
  contractId: z.string(),
  region: z.enum(['eu', 'us']),
  title: z.string(),
  category: category.schema,
  valueUsd: z.number(),
  body: z.string(),
  redlines: z.array(z.string()),
  counselNotes: z.array(z.string()),
});

const Received = H.state('Received', 'pending');
const Returned = H.state('Returned', 'pending');
const Executed = H.terminal('Executed', 'success');
const Rejected = H.terminal('Rejected', 'failure');
const Declined = H.terminal('Declined', 'failure');
const Failed = H.terminal('Failed', 'failure');

const contractKind = H.kind('Contract')
  .attributes(contractSchema)
  .states(Received, Returned, Executed, Rejected, Declined, Failed)
  .key(a => a.contractId)
  .initial(Received);

const counselHalt = H.halt('counsel').decision(z.object({ verdict: z.enum(['approve', 'return']), notes: z.string() }));
const signoffHalt = H.halt('signoff').decision(z.object({ approve: z.boolean() }));

const counselApproval = H.metric('counsel-approval', H.when.decision(contractKind, counselHalt))
  .samples(e => e.resolvedBy === 'human' ? [{ hit: e.decision.verdict === 'approve', facets: e.facets }] : []);

const signoffTimeouts = H.metric('signoff-timeouts', H.when.decision(contractKind, signoffHalt))
  .samples(e => [{ hit: e.resolvedBy === 'timeout', halt: signoffHalt }]);

const skipCounsel = H.policy.halt('skip-counsel', contractKind, counselHalt).decide(ctx => {
  const value = ctx.facet(category);
  if (value === undefined) return undefined;
  const record = ctx.metrics.rate(counselApproval, { facets: [category.of(value)] });
  return record.samples >= 200 && record.hits === record.samples
    ? { verdict: 'approve', notes: `Skipped: ${record.hits}/${record.samples} approved in ${value}` }
    : undefined;
});

const drafterRole = H.role('contract-drafter').intents('read', 'edit').instructions('Draft the contract, applying every redline and counsel note.');
const drafter = H.seat('contract-drafter')
  .role(drafterRole)
  .model(opus)
  .pool(draftingPool)
  .output(z.object({ body: z.string() }));

const pageDeputy = H.command('page-finance-deputy').argv(['./scripts/page', 'finance-deputy']).runner(localRunner);

const executeContract = H.command('execute-contract')
  .input(z.object({ contractId: z.string(), body: z.string() }))
  .argv(i => ['./scripts/execute-contract', i.contractId])
  .runner(localRunner);

const negotiateContract = H.flow('negotiate-contract')
  .input(contractSchema)
  .step('draft', drafter, ctx => ({
    task: `Draft ${ctx.unit.attributes.title}.\nRedlines:\n${ctx.unit.attributes.redlines.join('\n')}\nCounsel notes:\n${ctx.unit.attributes.counselNotes.join('\n')}`,
  }))
  .halt('counsel', counselHalt, {
    ask: ctx => ctx.steps.draft.body,
    skip: skipCounsel,
    facets: ctx => [category.of(ctx.unit.attributes.category)],
  })
  .exit('returned', {
    when: ctx => ctx.steps.counsel.verdict === 'return',
    update: ctx => ({ counselNotes: [...ctx.unit.attributes.counselNotes, ctx.steps.counsel.notes] }),
  })
  .halt('signoff', signoffHalt, {
    ask: ctx => `Sign off ${ctx.unit.attributes.title} (${ctx.unit.attributes.valueUsd} USD)?`,
    escalate: { afterMinutes: 20, run: pageDeputy },
    timeout: { afterMinutes: 30, decide: ctx => ({ approve: ctx.unit.attributes.valueUsd < 500 }) },
  })
  .exit('rejected', ctx => !ctx.steps.signoff.approve)
  .step('execute', executeContract, ctx => ({ contractId: ctx.unit.attributes.contractId, body: ctx.steps.draft.body }), { afterCrash: 'park' })
  .exit('executed');

const contractEvents = webhook.json('contract-events', {
  port: H.slot.port(1),
  path: '/contracts',
  secret: H.env('CONTRACT_WEBHOOK_SECRET'),
  payload: contractEvent,
});

const redline = H.signal('redline').payload(z.object({ text: z.string() }));
const documentStore = ironclad.store({ workspace: 'legal', token: H.env('DOCUMENT_SYSTEM_TOKEN') });

function contractLane(name: string, region: Region, retry: Retry) {
  return H.lane(name, contractKind)
    .supply(H.operator)
    .supply(contractEvents, (e, to) =>
      e.region !== region ? to.skip()
        : e.type === 'new' ? to.create({
          contractId: e.contractId,
          region: e.region,
          title: e.title,
          category: e.category,
          valueUsd: e.valueUsd,
          body: e.text,
          redlines: [],
          counselNotes: [],
        })
          : to.signal(redline, e.contractId, { text: e.text }))
    .handler(negotiateContract, {
      exits: {
        executed: Executed,
        rejected: Rejected,
        returned: { to: Returned, bound: { times: 2, to: Declined } },
      },
    })
    .store(documentStore)
    .retry({ ...retry, exhausted: Failed })
    .on(redline, { update: (a, p) => ({ ...a, redlines: [...a.redlines, p.text] }), restart: 'draft', at: ['counsel'] });
}

const euLane = contractLane('contracts-eu', 'eu', H.retry({ maxAttempts: 4, backoff: 'exponential', initialDelayMs: 60_000 }));
const usLane = contractLane('contracts-us', 'us', H.retry({ maxAttempts: 2, backoff: 'fixed', initialDelayMs: 60_000 }));

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

export const harness = H.harness('contracts')
  .ledger(sqlite.ledger({ path: '.harness/ledger.db' }))
  .lanes(euLane, usLane)
  .metrics(counselApproval, signoffTimeouts)
  .scheduler(H.scheduler('contracts-scheduler')
    .standard(euLane, usLane)
    .wip([euLane, usLane], 3))
  .clients(counselDashboard, financeSupervisor, auditorApi)
  .observers(markdown.board({ path: 'BOARD.md' }), markdown.telemetry({ path: 'TELEMETRY.md' }));

void harness.start();
