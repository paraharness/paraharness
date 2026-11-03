import { H } from 'harness-dsl';
import * as claudeCode from 'harness-dsl/claude-code';
import * as anthropic from 'harness-dsl/anthropic';
import * as sqlite from 'harness-dsl/sqlite';
import * as shell from 'harness-dsl/shell';
import * as http from 'harness-dsl/http';
import * as markdown from 'harness-dsl/markdown';
import { z } from 'zod';

const local = shell.local('local', { slots: 4 });
const apiAccount = anthropic.account('api', { apiKey: H.env('ANTHROPIC_API_KEY') });
const sonnet = anthropic.model('claude-sonnet');
const apiPool = H.pool('api', [{ account: apiAccount, share: 1 }]);

const categorySchema = z.enum(['nda', 'msa', 'procurement', 'licensing']);
type ContractCategory = z.infer<typeof categorySchema>;
const contractCategory = H.facet('contract-category', categorySchema);

const received = H.state('received', 'pending');
const redlined = H.state('redlined', 'pending');
const returned = H.state('returned', 'pending');
const executed = H.state('executed', 'terminal', 'success');
const rejected = H.state('rejected', 'terminal', 'failure');
const declined = H.state('declined', 'terminal', 'failure');
const stuck = H.state('stuck', 'terminal', 'failure');
const contract = H.kind('Contract')
  .data(z.object({
    title: z.string(),
    counterparty: z.string(),
    amountUsd: z.number(),
    category: categorySchema,
    latestRedline: z.string().optional(),
    counselNotes: z.string().optional(),
    draft: z.string().optional(),
  }))
  .states(received, redlined, returned, executed, rejected, declined, stuck);

const contractEvent = z.discriminatedUnion('event', [
  z.object({
    event: z.literal('created'),
    contractId: z.string(),
    title: z.string(),
    counterparty: z.string(),
    amountUsd: z.number(),
    category: categorySchema,
  }),
  z.object({ event: z.literal('redline'), contractId: z.string(), redline: z.string() }),
]);

const contractWebhook = (region: string) =>
  http.webhook(contract, {
    path: `/contracts/${region}`,
    secret: H.env('DOCS_WEBHOOK_SECRET'),
    body: contractEvent,
    read: body =>
      body.event === 'created'
        ? {
            create: { title: body.title, counterparty: body.counterparty, amountUsd: body.amountUsd, category: body.category },
            key: body.contractId,
          }
        : { update: body.contractId, patch: { latestRedline: body.redline }, state: 'redlined' },
  });

const documentStore = http.store(contract, {
  url: 'https://docs.example.com/api/contracts',
  headers: { Authorization: H.env('DOCS_TOKEN') },
  stateField: 'workflow_state',
});

const draftRole = H.role('draft-contract')
  .input(z.object({
    title: z.string(),
    counterparty: z.string(),
    redline: z.string().optional(),
    counselNotes: z.string().optional(),
  }))
  .output(z.object({ document: z.string() }))
  .prompt(input => `Draft "${input.title}" with ${input.counterparty}. Redline: ${input.redline ?? 'none'}. Counsel notes: ${input.counselNotes ?? 'none'}.`);

const drafter = H.seat('contract-drafter', draftRole).model(sonnet);

const counselDecision = z.object({ verdict: z.enum(['approve', 'return']), notes: z.string() });
type CounselDecision = z.infer<typeof counselDecision>;

const counselAsk = H.halt('counsel', counselDecision).about(z.object({ category: categorySchema }));

const counselSkip = H.policy.rule<{ readonly category: ContractCategory }, CounselDecision | null>('counsel-skip', (about, metrics) => {
  const history = metrics.rate({
    among: { entry: 'halt', halt: counselAsk, status: 'resolved', resolver: 'human', facets: [contractCategory.of(about.category)] },
    count: {
      entry: 'halt',
      halt: counselAsk,
      status: 'resolved',
      resolver: 'human',
      decision: { verdict: 'return' },
      facets: [contractCategory.of(about.category)],
    },
  });
  return history.samples >= 200 && history.hits === 0 ? { verdict: 'approve', notes: 'skipped by counsel-skip policy' } : null;
});

const counsel = counselAsk.policy(counselSkip);

const signoff = H.halt('signoff', z.object({ approved: z.boolean() }))
  .about(z.object({ amountUsd: z.number() }))
  .timeout({ minutes: 30 }, about => ({ approved: about.amountUsd < 500 }));

const execute = H.command('execute-contract')
  .input(z.object({ contractId: z.string() }))
  .argv(input => ['bin/execute-contract', input.contractId])
  .on(local)
  .recovery('park');

const pageDeputy = H.command('page-finance-deputy')
  .input(z.object({ unit: z.string() }))
  .argv(input => ['bin/page', 'finance-deputy', input.unit])
  .on(local);

const contractFlow = H.flow('contract-round').for(contract).does(async ctx => {
  const data = ctx.unit.data;
  const drafted = await ctx.run(drafter, {
    title: data.title,
    counterparty: data.counterparty,
    redline: data.latestRedline,
    counselNotes: data.counselNotes,
  });
  if (!drafted.ok) return ctx.fail(drafted.error);
  await ctx.update({ draft: drafted.value.document });
  const review = await ctx.halt(counsel, `Review ${data.title} with ${data.counterparty}`, { category: data.category });
  if (review.verdict === 'return') {
    await ctx.update({ counselNotes: review.notes });
    return 'returned';
  }
  const signed = await ctx.halt(signoff, `Sign off ${data.title} for $${data.amountUsd}`, { amountUsd: data.amountUsd });
  if (!signed.approved) return 'rejected';
  const done = await ctx.run(execute, { contractId: ctx.unit.key });
  if (!done.ok) return ctx.fail(done.error);
  return 'executed';
});

const contractsEu = H.lane('contracts-eu', contract)
  .handler(contractFlow, { retries: 3, backoff: { first: { minutes: 1 }, factor: 2, max: { minutes: 30 } }, exhausted: 'stuck' })
  .suppliers(contractWebhook('eu'), H.operator)
  .store(documentStore)
  .wip(3)
  .facet(contractCategory, data => data.category);

const contractsUs = H.lane('contracts-us', contract)
  .handler(contractFlow, { retries: 1, exhausted: 'stuck' })
  .suppliers(contractWebhook('us'), H.operator)
  .store(documentStore)
  .wip(3)
  .facet(contractCategory, data => data.category);

const secondReturnDeclines = H.trigger(
  'second-return-declines',
  H.on.enters(contract, 'returned', { times: 2 }),
  (_event, act) => act.move('declined')
);

const deputyPage = H.trigger('signoff-deputy-page', H.on.halted(signoff, { minutes: 20 }), (event, act) =>
  act.run(pageDeputy, { unit: event.unit })
);

export const decisionReport = H.policy.rule('decision-report', (_input: { readonly month: string }, metrics) => ({
  counselByHuman: metrics.median({ of: 'decisionMs', among: { entry: 'halt', halt: counsel, status: 'resolved', resolver: 'human' }, days: 30 }),
  counselByPolicy: metrics.median({ of: 'decisionMs', among: { entry: 'halt', halt: counsel, status: 'resolved', resolver: 'policy' }, days: 30 }),
  signoffByHuman: metrics.median({ of: 'decisionMs', among: { entry: 'halt', halt: signoff, status: 'resolved', resolver: 'human' }, days: 30 }),
  signoffByClock: metrics.median({ of: 'decisionMs', among: { entry: 'halt', halt: signoff, status: 'resolved', resolver: 'clock' }, days: 30 }),
  retriesEu: metrics.count({ of: { entry: 'attempt', status: 'retrying', lane: contractsEu }, days: 30 }),
  retriesUs: metrics.count({ of: { entry: 'attempt', status: 'retrying', lane: contractsUs }, days: 30 }),
  signoffTimeoutShare: metrics.rate({
    among: { entry: 'halt', halt: signoff, status: 'resolved' },
    count: { entry: 'halt', halt: signoff, status: 'resolved', resolver: 'clock' },
    days: 30,
  }),
}));

const counselDashboard = http.control({
  port: 8401,
  token: H.env('COUNSEL_TOKEN'),
  grants: [H.ops.resolve(counsel)],
});

const financeSupervisor = claudeCode.supervisor({
  grants: [H.ops.resolve(signoff)],
});

const auditorClient = http.control({
  port: 8402,
  token: H.env('AUDITOR_TOKEN'),
  grants: [H.ops.readTelemetry],
});

const operatorConsole = http.control({
  port: 8403,
  token: H.env('OPERATOR_TOKEN'),
  grants: [H.ops.readWork, H.ops.writeWork, H.ops.resolve(H.halts.interrupted, H.halts.definitionChanged)],
});

export const contracts = H.harness('contracts')
  .ledger(sqlite.ledger('.harness/ledger.sqlite'))
  .lanes(contractsEu, contractsUs)
  .pools(apiPool)
  .triggers(secondReturnDeclines, deputyPage)
  .clients(counselDashboard, financeSupervisor, auditorClient, operatorConsole)
  .observers(markdown.board('BOARD.md'), markdown.telemetry('TELEMETRY.md'));
