import { z } from 'zod';
import { H } from 'harness-dsl';
import type { Halt, Mean, Metrics, SupplyOf } from 'harness-dsl';
import * as anthropic from 'harness-dsl/anthropic';
import * as claudeCode from 'harness-dsl/claude-code';
import * as http from 'harness-dsl/http';
import * as sqlite from 'harness-dsl/sqlite';
import * as shell from 'harness-dsl/shell';
import * as markdown from 'harness-dsl/markdown';

const apiAccount = anthropic.account('contracts-api', { apiKey: H.env('ANTHROPIC_API_KEY') });
const sonnet = anthropic.model('claude-sonnet-4-5');
const runner = shell.local('contracts-shell', { slots: 4 });

const categorySchema = z.enum(['nda', 'msa', 'order-form', 'amendment']);
const categoryFacet = H.facet('contract-category', categorySchema);

const received = H.state('received', 'pending');
const redlined = H.state('redlined', 'pending');
const returned = H.state('returned', 'pending');
const executed = H.state('executed', 'terminal', 'success');
const declined = H.state('declined', 'terminal', 'failure');
const stalled = H.state('stalled', 'terminal', 'failure');

const contract = H.kind('contract')
  .data(z.object({
    title: z.string(),
    counterparty: z.string(),
    category: categorySchema,
    amountUsd: z.number(),
    documentId: z.string(),
    latestRedline: z.string().optional(),
    counselNotes: z.string().optional(),
  }))
  .states(received, redlined, returned, executed, declined, stalled);

const contractBody = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('new'),
    contractId: z.string(),
    title: z.string(),
    counterparty: z.string(),
    category: categorySchema,
    amountUsd: z.number(),
  }),
  z.object({ type: z.literal('redline'), contractId: z.string(), text: z.string() }),
]);

const readContract = (body: z.infer<typeof contractBody>): SupplyOf<typeof contract> =>
  body.type === 'new'
    ? {
        create: {
          title: body.title,
          counterparty: body.counterparty,
          category: body.category,
          amountUsd: body.amountUsd,
          documentId: body.contractId,
        },
        key: body.contractId,
      }
    : { update: body.contractId, patch: { latestRedline: body.text }, state: 'redlined', deferred: true };

const euWebhook = http.webhook(contract, {
  path: '/contracts/eu',
  secret: H.env('CONTRACTS_WEBHOOK_SECRET'),
  body: contractBody,
  read: readContract,
});
const usWebhook = http.webhook(contract, {
  path: '/contracts/us',
  secret: H.env('CONTRACTS_WEBHOOK_SECRET'),
  body: contractBody,
  read: readContract,
});

const documentStore = http.store(contract, {
  url: 'https://documents.example.com/api/contracts',
  headers: { Authorization: H.env('DOCUMENTS_TOKEN') },
  stateField: 'status',
});

const drafterRole = H.role('contract-drafter')
  .input(z.object({
    title: z.string(),
    counterparty: z.string(),
    amountUsd: z.number(),
    redline: z.string(),
    counselNotes: z.string(),
  }))
  .output(z.object({ revision: z.string() }))
  .prompt(input =>
    `Draft "${input.title}" with ${input.counterparty} for $${input.amountUsd}.\nRedline: ${input.redline}\nCounsel notes: ${input.counselNotes}`
  );

const drafter = H.seat('contract-drafter', drafterRole).model(sonnet);

const counselDecision = z.object({ action: z.enum(['approve', 'return']), notes: z.string().optional() });
const counselAbout = z.object({ category: categorySchema, amountUsd: z.number() });
type CounselDecision = z.infer<typeof counselDecision>;
type CounselAbout = z.infer<typeof counselAbout>;

const counsel: Halt<CounselDecision, CounselAbout> = H.halt('counsel', counselDecision)
  .about(counselAbout)
  .policy(
    H.policy.rule('skip-counsel-for-proven-category', (about: CounselAbout, metrics: Metrics): CounselDecision | null => {
      const record = metrics.rate({
        among: { entry: 'halt', halt: counsel, status: 'resolved', resolver: 'human', facets: [categoryFacet.value(about.category)] },
        count: {
          entry: 'halt',
          halt: counsel,
          status: 'resolved',
          resolver: 'human',
          facets: [categoryFacet.value(about.category)],
          decision: { action: 'approve' },
        },
      });
      return record.samples >= 200 && record.hits === record.samples ? { action: 'approve' } : null;
    })
  );

const signoff = H.halt('signoff', z.object({ approve: z.boolean() }))
  .about(z.object({ amountUsd: z.number() }))
  .timeout({ minutes: 30 }, about => ({ approve: about.amountUsd < 500 }));

const pageDeputy = H.command('page-finance-deputy')
  .input(z.object({ unit: z.string() }))
  .argv(input => ['pager', 'notify', 'finance-deputy', `signoff waiting on ${input.unit}`])
  .on(runner)
  .recovery('rerun');

const executeContract = H.command('execute-contract')
  .input(z.object({ documentId: z.string() }))
  .argv(input => ['documents', 'execute', input.documentId])
  .on(runner)
  .recovery('park');

const contractFlow = H.flow('contract-flow')
  .for(contract)
  .does(async ctx => {
    const data = ctx.unit.data;
    ctx.tag(categoryFacet, data.category);
    const drafted = await ctx.run(drafter, {
      title: data.title,
      counterparty: data.counterparty,
      amountUsd: data.amountUsd,
      redline: data.latestRedline ?? '',
      counselNotes: data.counselNotes ?? '',
    });
    if (!drafted.ok) return ctx.fail(drafted.error);
    const review = await ctx.halt(counsel, drafted.value.revision, { category: data.category, amountUsd: data.amountUsd });
    if (review.action === 'return') {
      await ctx.update({ counselNotes: review.notes ?? '' });
      return 'returned';
    }
    const decision = await ctx.halt(signoff, `Sign off ${data.title} for $${data.amountUsd}`, { amountUsd: data.amountUsd });
    if (!decision.approve) return 'declined';
    const done = await ctx.run(executeContract, { documentId: data.documentId });
    if (!done.ok) return ctx.fail(done.error);
    return 'executed';
  });

const euAllowance = H.allowance('contracts-eu-allowance', contract)
  .retry(H.policy.retry('contracts-eu-retry', { retries: 3, firstDelayMs: 60_000, factor: 2 }), 'stalled');
const usAllowance = H.allowance('contracts-us-allowance', contract)
  .retry(H.policy.retry('contracts-us-retry', { retries: 1, firstDelayMs: 60_000 }), 'stalled');

const contractsEu = H.lane('contracts-eu', contract)
  .handler(contractFlow)
  .suppliers(euWebhook, H.operator)
  .store(documentStore)
  .wip(3)
  .allowance(euAllowance);
const contractsUs = H.lane('contracts-us', contract)
  .handler(contractFlow)
  .suppliers(usWebhook, H.operator)
  .store(documentStore)
  .wip(3)
  .allowance(usAllowance);

const secondReturnDeclines = H.trigger(
  'second-return-declines',
  H.on.enters(contract, 'returned', { times: 2 }),
  (event, act) => act.move('declined')
);

const deputyPage = H.trigger(
  'signoff-deputy-page',
  H.on.halted(signoff, { minutes: 20 }),
  (event, act) => act.run(pageDeputy, { unit: event.unit })
);

const resolvers: readonly ('human' | 'policy' | 'clock')[] = ['human', 'policy', 'clock'];

const contractTelemetry = H.report('contract-telemetry', (metrics, now) => {
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const decisionTimes: Record<string, Mean> = {};
  for (const halt of [counsel, signoff]) {
    for (const resolver of resolvers) {
      decisionTimes[`decision-ms/${halt.name}/${resolver}`] = metrics.median({
        of: 'decisionMs',
        among: { entry: 'halt', halt, status: 'resolved', resolver },
        days: 30,
      });
    }
  }
  return {
    ...decisionTimes,
    retriesEuThisMonth: metrics.count({ of: { entry: 'attempt', lane: contractsEu, status: 'retrying' }, since: monthStart }),
    retriesUsThisMonth: metrics.count({ of: { entry: 'attempt', lane: contractsUs, status: 'retrying' }, since: monthStart }),
    signoffTimeoutShare: metrics.rate({
      among: { entry: 'halt', halt: signoff, status: 'resolved' },
      count: { entry: 'halt', halt: signoff, status: 'resolved', resolver: 'clock' },
      days: 30,
    }),
  };
});

const counselDashboard = http.control({
  port: 8443,
  token: H.env('COUNSEL_TOKEN'),
  grants: [H.ops.resolve(counsel)],
});

const financeSupervisor = claudeCode.supervisor({ grants: [H.ops.resolve(signoff)] });

const auditorClient = http.control({
  port: 8444,
  token: H.env('AUDITOR_TOKEN'),
  grants: [H.ops.readWork, H.ops.readTelemetry],
});

const operationsConsole = http.control({
  port: 8445,
  token: H.env('OPERATIONS_TOKEN'),
  grants: [H.ops.readWork, H.ops.writeWork, H.ops.resolve(H.halts.changed, H.halts.interrupted)],
});

export const contractsHarness = H.harness('contracts')
  .ledger(sqlite.ledger('/srv/contracts/ledger.sqlite'))
  .lanes(contractsEu, contractsUs)
  .pools(H.pool('contracts-pool', [{ account: apiAccount, share: 1 }]))
  .triggers(secondReturnDeclines, deputyPage)
  .reports(contractTelemetry)
  .clients(counselDashboard, financeSupervisor, auditorClient, operationsConsole)
  .observers(markdown.board('/srv/contracts/BOARD.md'), markdown.telemetry('/srv/contracts/TELEMETRY.md'));
