import { H } from 'harness-dsl';
import type { Metrics, Rate, SupplyOf } from 'harness-dsl';
import { z } from 'zod';
import * as anthropic from 'harness-dsl/anthropic';
import * as claudeCode from 'harness-dsl/claude-code';
import * as sqlite from 'harness-dsl/sqlite';
import * as shell from 'harness-dsl/shell';
import * as http from 'harness-dsl/http';
import * as markdown from 'harness-dsl/markdown';

const sonnet = anthropic.model('claude-sonnet-4-5');
const api = anthropic.account('anthropic-api', { apiKey: H.env('ANTHROPIC_API_KEY') });

const local = shell.local('local', { slots: 3 });

const categories = z.enum(['nda', 'msa', 'order-form', 'amendment']);
type Category = z.infer<typeof categories>;
const categoryFacet = H.facet('contract-category', categories);

const regions = z.enum(['eu', 'us']);
type Region = z.infer<typeof regions>;

const open = H.state('open', 'pending');
const returned = H.state('returned', 'pending');
const executed = H.state('executed', 'terminal', 'success');
const rejected = H.state('rejected', 'terminal', 'failure');
const declined = H.state('declined', 'terminal', 'failure');
const failed = H.state('failed', 'terminal', 'failure');

const contract = H.kind('Contract')
  .data(z.object({
    counterparty: z.string(),
    region: regions,
    category: categories,
    amountUsd: z.number(),
    latestRedline: z.string().optional(),
    draft: z.string().optional(),
  }))
  .states(open, returned, executed, rejected, declined, failed);

const contractEvent = z.discriminatedUnion('event', [
  z.object({ event: z.literal('new'), contract: z.string(), counterparty: z.string(), category: categories, amountUsd: z.number() }),
  z.object({ event: z.literal('redline'), contract: z.string(), text: z.string() }),
]);
type ContractEvent = z.infer<typeof contractEvent>;

const fromDocuments = (region: Region, event: ContractEvent): SupplyOf<typeof contract> =>
  event.event === 'new'
    ? {
        create: { counterparty: event.counterparty, region, category: event.category, amountUsd: event.amountUsd },
        key: event.contract,
      }
    : { update: event.contract, patch: { latestRedline: event.text }, state: 'open', cancels: ['waiting'] };

const contractWebhook = (region: Region) =>
  http.webhook(contract, {
    path: `/contracts/${region}`,
    secret: H.env('DOCUMENTS_WEBHOOK_SECRET'),
    body: contractEvent,
    read: event => fromDocuments(region, event),
  });

const documentStore = http.store(contract, {
  url: 'https://documents.example.com/api/contracts',
  headers: { authorization: H.env('DOCUMENTS_AUTH_HEADER') },
  stateField: 'workflow_state',
});

const drafting = H.role('contract-drafter')
  .input(z.object({ counterparty: z.string(), category: categories, redline: z.string() }))
  .output(z.object({ text: z.string() }))
  .prompt(input => `Draft the ${input.category} for ${input.counterparty}. Apply this redline if present:\n${input.redline}`);

const drafter = H.seat('contract-drafter', drafting).model(sonnet);

const counselDecision = z.object({ verdict: z.enum(['approve', 'return']), notes: z.string().optional() });
type CounselDecision = z.infer<typeof counselDecision>;
const counselAbout = z.object({ category: categories });
type CounselAbout = z.infer<typeof counselAbout>;

function counselRecord(metrics: Metrics, value: Category): Rate {
  const scope = [categoryFacet.of(value)];
  return metrics.rate({
    among: { ...counsel.resolved(), resolver: 'human', facets: scope },
    count: { ...counsel.resolved({ verdict: 'approve' }), resolver: 'human', facets: scope },
  });
}

const skipProvenCategory = H.policy.rule('skip-counsel-for-proven-category', (about: CounselAbout, metrics: Metrics): CounselDecision | null => {
  const record = counselRecord(metrics, about.category);
  return record.samples >= 200 && record.hits === record.samples
    ? { verdict: 'approve', notes: `skipped: ${record.hits} approvals of ${record.samples}` }
    : null;
});

const counsel = H.halt('counsel', counselDecision).about(counselAbout).policy(skipProvenCategory);

const signoff = H.halt('signoff', z.object({ approve: z.boolean() }))
  .about(z.object({ amountUsd: z.number() }))
  .timeout({ minutes: 30 }, about => ({ approve: about.amountUsd < 500 }));

const execute = H.command('execute-contract')
  .input(z.object({ counterparty: z.string(), document: z.string() }))
  .argv(input => ['documents', 'execute', '--counterparty', input.counterparty, '--document', input.document])
  .on(local)
  .recovery('park');

const pageDeputy = H.command('page-finance-deputy')
  .input(z.object({ unit: z.string(), amountUsd: z.number() }))
  .argv(input => ['pager', 'send', '--team', 'finance-deputy', '--text', `Signoff waiting on ${input.unit} (${input.amountUsd} USD)`])
  .on(local)
  .recovery('rerun');

const handleContract = H.flow('handle-contract').for(contract).does(async ctx => {
  const { counterparty, category, amountUsd, latestRedline } = ctx.unit.data;
  const drafted = await ctx.run(drafter, { counterparty, category, redline: latestRedline ?? '' });
  if (!drafted.ok) return ctx.fail(drafted.error);
  await ctx.update({ draft: drafted.value.text });
  const review = await ctx.halt(counsel, drafted.value.text, { category });
  if (review.verdict === 'return') {
    await ctx.update({ latestRedline: review.notes ?? '' });
    return 'returned';
  }
  const signed = await ctx.halt(signoff, `${counterparty}: ${amountUsd} USD`, { amountUsd });
  if (!signed.approve) return 'rejected';
  const done = await ctx.run(execute, { counterparty, document: drafted.value.text });
  return done.ok ? 'executed' : ctx.fail(done.error);
});

const contractsEu = H.lane('contracts-eu', contract)
  .handler(handleContract)
  .attempts(4, { backoff: { first: { minutes: 5 }, factor: 2, max: { hours: 1 } }, exhausted: 'failed' })
  .suppliers(contractWebhook('eu'), H.operator)
  .store(documentStore)
  .wip(3)
  .facet(categoryFacet, data => data.category);

const contractsUs = H.lane('contracts-us', contract)
  .handler(handleContract)
  .attempts(2, { exhausted: 'failed' })
  .suppliers(contractWebhook('us'), H.operator)
  .store(documentStore)
  .wip(3)
  .facet(categoryFacet, data => data.category);

const declineAfterSecondReturn = H.trigger(
  'decline-after-second-return',
  H.on.enters(contract, 'returned', { times: 2 }),
  (_event, act) => act.move('declined')
);

const pageDeputyAfterTwentyMinutes = H.trigger('page-deputy', H.on.halted(signoff, { minutes: 20 }), (event, act) =>
  act.run(pageDeputy, { unit: event.unit, amountUsd: event.about.amountUsd })
);

export const contractTelemetry = H.policy.rule('contract-telemetry', (since: Date, metrics: Metrics) => ({
  counselByHuman: metrics.median({ of: 'decisionMs', among: { ...counsel.resolved(), resolver: 'human' }, since }),
  counselByPolicy: metrics.median({ of: 'decisionMs', among: { ...counsel.resolved(), resolver: 'policy' }, since }),
  signoffByHuman: metrics.median({ of: 'decisionMs', among: { ...signoff.resolved(), resolver: 'human' }, since }),
  signoffByClock: metrics.median({ of: 'decisionMs', among: { ...signoff.resolved(), resolver: 'clock' }, since }),
  retriesEu: metrics.count({ of: { entry: 'attempt', status: 'retrying', lane: contractsEu }, since }),
  retriesUs: metrics.count({ of: { entry: 'attempt', status: 'retrying', lane: contractsUs }, since }),
  signoffTimeoutShare: metrics.rate({ among: signoff.resolved(), count: { ...signoff.resolved(), resolver: 'clock' }, since }),
}));

export const contracts = H.harness('contracts')
  .ledger(sqlite.ledger('.harness/ledger.db'))
  .lanes(contractsEu, contractsUs)
  .pools(H.pool('api', [{ account: api, share: 1, serves: [sonnet] }]))
  .triggers(declineAfterSecondReturn, pageDeputyAfterTwentyMinutes)
  .clients(
    http.control({ port: 7401, token: H.env('COUNSEL_DASHBOARD_TOKEN'), grants: [H.ops.resolve(counsel)] }),
    claudeCode.supervisor({ grants: [H.ops.resolve(signoff)] }),
    http.control({ port: 7402, token: H.env('AUDITOR_TOKEN'), grants: [H.ops.readTelemetry] }),
    http.control({
      port: 7403,
      token: H.env('OPERATOR_TOKEN'),
      grants: [H.ops.readWork, H.ops.writeWork, H.ops.resolve(H.halts.interrupted, H.halts.definitionChanged)],
    })
  )
  .observers(markdown.board('BOARD.md'), markdown.telemetry('TELEMETRY.md'));
