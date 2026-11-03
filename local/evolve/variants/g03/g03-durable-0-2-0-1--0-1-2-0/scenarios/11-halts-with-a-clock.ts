import { z } from 'zod';
import { H, type Metrics, type Router, type Route } from 'harness-dsl';
import { anthropic } from 'harness-dsl/anthropic';
import { sqlite } from 'harness-dsl/sqlite';
import { local } from 'harness-dsl/local';
import { http } from 'harness-dsl/http';
import { claudeCode } from 'harness-dsl/claude-code';
import { webhook } from 'harness-dsl/webhook';
import { ironclad } from 'harness-dsl/ironclad';
import { markdown } from 'harness-dsl/markdown';

const CategorySchema = z.enum(['nda', 'msa', 'sow', 'dpa']);
const category = H.facet('category', CategorySchema.options);

const apiAccount = anthropic.account('contracts-api', {
  apiKey: H.env('ANTHROPIC_API_KEY'),
  quota: sqlite.quota('contracts-api', { path: '.harness/quota.db' }),
});
const drafterRole = H.role('contract-drafter').intents('read').instructions('Draft or revise the contract, applying every redline and counsel note.');
const drafterSeat = H.seat('contract-drafter')
  .role(drafterRole)
  .model(anthropic.model('opus', { id: 'claude-opus-4-1' }))
  .pool(H.pool('contracts').accounts(apiAccount));
const draftCall = H.call('draft-contract', drafterSeat);

const runner = local.runner('contracts-local');

const ContractAttrs = z.object({
  contractId: z.string(),
  title: z.string(),
  category: CategorySchema,
  amountUsd: z.number(),
  redlines: z.array(z.string()),
});
type ContractAttrs = z.infer<typeof ContractAttrs>;

const Received = H.state('Received', 'pending');
const Executed = H.terminal('Executed', 'success');
const Declined = H.terminal('Declined', 'failure');
const Rejected = H.terminal('Rejected', 'failure');
const Abandoned = H.terminal('Abandoned', 'failure');

const Contract = H.kind('Contract')
  .attributes(ContractAttrs)
  .states(Received, Executed, Declined, Rejected, Abandoned)
  .key(attrs => attrs.contractId)
  .initial(Received);

const counsel = H.halt('counsel').decision(z.object({ verdict: z.enum(['approve', 'return']), notes: z.string() }));
const signoff = H.halt('signoff').decision(z.object({ approved: z.boolean() }));

const counselApproval = H.metric('counsel-approval', H.when.decision(Contract, counsel)).samples(event =>
  event.resolvedBy === 'human' ? [{ hit: event.decision.verdict === 'approve', facets: event.facets, halt: counsel }] : []);

const skipCounselWhenProven = H.policy.halt('skip-counsel-when-proven', Contract, counsel).decide(ctx => {
  const record = ctx.metrics.rate(counselApproval, { facets: ctx.facets });
  return record.samples >= 200 && record.hits === record.samples
    ? { verdict: 'approve', notes: `skipped: ${record.samples} approvals, no returns` }
    : undefined;
});

const pageDeputy = H.command('page-finance-deputy').argv(['./contracts/page', 'finance-deputy']).runner(runner);
const executeContract = H.command('execute-contract')
  .input(z.object({ contractId: z.string() }))
  .argv(input => ['./contracts/execute', input.contractId])
  .runner(runner);

const contractFlow = H.flow('contract')
  .input(ContractAttrs)
  .loop(
    'reviews',
    { schema: z.array(z.string()), initial: [] },
    round =>
      round
        .step('draft', draftCall, ctx => ({
          text: [
            `Draft ${ctx.unit.attributes.title} (${ctx.unit.attributes.category}).`,
            `Redlines:\n${ctx.unit.attributes.redlines.join('\n')}`,
            `Counsel notes:\n${ctx.steps.reviews.join('\n')}`,
          ].join('\n\n'),
          facets: [category.of(ctx.unit.attributes.category)],
        }))
        .halt('counsel', counsel, {
          ask: ctx => `Review ${ctx.unit.attributes.title}:\n\n${ctx.steps.draft}`,
          skip: skipCounselWhenProven,
          facets: ctx => [category.of(ctx.unit.attributes.category)],
        }),
    {
      max: 2,
      span: 'unit',
      until: ctx => ctx.steps.counsel.verdict === 'approve',
      next: ctx => [...ctx.steps.reviews, ctx.steps.counsel.notes],
    },
  )
  .exit('declined', ctx => ctx.steps.counsel.verdict === 'return')
  .halt('signoff', signoff, {
    ask: ctx => `Sign off ${ctx.unit.attributes.title} for $${ctx.unit.attributes.amountUsd}?`,
    escalate: { afterMinutes: 20, run: pageDeputy },
    timeout: { afterMinutes: 30, decide: ctx => ({ approved: ctx.unit.attributes.amountUsd < 500 }) },
  })
  .exit('rejected', ctx => !ctx.steps.signoff.approved)
  .step('execute', executeContract, ctx => ({ contractId: ctx.unit.attributes.contractId }), { afterCrash: 'park' })
  .exit('executed');

const redline = H.signal('redline').payload(z.object({ text: z.string() }));

const Region = z.enum(['eu', 'us']);
const ContractEvent = z.discriminatedUnion('type', [
  z.object({ type: z.literal('created'), region: Region, contractId: z.string(), title: z.string(), category: CategorySchema, amountUsd: z.number() }),
  z.object({ type: z.literal('redline'), region: Region, contractId: z.string(), text: z.string() }),
]);
type ContractEvent = z.infer<typeof ContractEvent>;

const contractEvents = webhook.json('contract-events', {
  port: H.slot.port(3),
  path: '/contracts',
  secret: H.env('CONTRACTS_WEBHOOK_SECRET'),
  payload: ContractEvent,
});

const routeFor = (region: z.infer<typeof Region>) => (event: ContractEvent, to: Router<ContractAttrs>): Route => {
  if (event.region !== region) return to.skip();
  if (event.type === 'created') {
    return to.create({ contractId: event.contractId, title: event.title, category: event.category, amountUsd: event.amountUsd, redlines: [] });
  }
  return to.signal(redline, event.contractId, { text: event.text });
};

const documents = ironclad.store({ workspace: 'legal', token: H.env('DOCUMENT_SYSTEM_TOKEN') });

const contractsEu = H.lane('contracts-eu', Contract)
  .supply(H.operator)
  .supply(contractEvents, routeFor('eu'))
  .store(documents)
  .handler(contractFlow, { exits: { declined: Declined, rejected: Rejected, executed: Executed } })
  .retry({ maxAttempts: 3, backoff: 'exponential', initialDelayMs: 60000, exhausted: Abandoned })
  .on(redline, { update: (attrs, payload) => ({ ...attrs, redlines: [...attrs.redlines, payload.text] }), restart: 'draft', at: ['counsel'] });

const contractsUs = H.lane('contracts-us', Contract)
  .supply(H.operator)
  .supply(contractEvents, routeFor('us'))
  .store(documents)
  .handler(contractFlow, { exits: { declined: Declined, rejected: Rejected, executed: Executed } })
  .retry({ maxAttempts: 1, exhausted: Abandoned })
  .on(redline, { update: (attrs, payload) => ({ ...attrs, redlines: [...attrs.redlines, payload.text] }), restart: 'draft', at: ['counsel'] });

export const contractsReport = (metrics: Metrics) => {
  const month = { calendar: 'month' } as const satisfies { calendar: 'month' };
  const signoffs = metrics.decisions({ halt: signoff, window: month });
  const timedOut = signoffs.byResolver.filter(row => row.resolvedBy === 'timeout').reduce((sum, row) => sum + row.count, 0);
  return {
    counselDecisions: metrics.decisions({ halt: counsel, window: month }),
    signoffDecisions: signoffs,
    signoffTimeoutShare: { share: signoffs.samples === 0 ? 0 : timedOut / signoffs.samples, samples: signoffs.samples },
    retriesEu: metrics.attempts({ of: contractsEu, window: month }).retried,
    retriesUs: metrics.attempts({ of: contractsUs, window: month }).retried,
  };
};

export const harness = H.harness('contracts')
  .ledger(sqlite.ledger({ path: '.harness/ledger.db' }))
  .lanes(contractsEu, contractsUs)
  .metrics(counselApproval)
  .scheduler(H.scheduler('contracts').standard(contractsEu, contractsUs).wip([contractsEu, contractsUs], 3))
  .clients(
    http.controlApi('counsel-dashboard', { port: H.slot.port(1), token: H.env('COUNSEL_TOKEN'), grants: [H.ops.resolve(counsel)] }),
    claudeCode.supervisor('finance', { port: H.slot.port(2), grants: [H.ops.resolve(signoff)] }),
    http.controlApi('auditor', { port: H.slot.port(4), token: H.env('AUDITOR_TOKEN'), grants: [H.ops.workRead, H.ops.telemetryRead] }),
  )
  .observers(markdown.board({ path: 'BOARD.md' }));
