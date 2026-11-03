import { z } from 'zod';
import { H } from 'harness-dsl';
import type { Metrics, Rate, SupplyOf } from 'harness-dsl';
import * as claude from 'harness-dsl/claude-code';
import * as anthropic from 'harness-dsl/anthropic';
import * as sqlite from 'harness-dsl/sqlite';
import * as shell from 'harness-dsl/shell';
import * as http from 'harness-dsl/http';
import * as markdown from 'harness-dsl/markdown';

const categorySchema = z.enum(['nda', 'msa', 'order-form', 'licensing']);
type Category = z.infer<typeof categorySchema>;
const category = H.facet('contract-category', categorySchema);

const contract = H.kind('contract')
  .data(
    z.object({
      title: z.string(),
      counterparty: z.string(),
      category: categorySchema,
      amountUsd: z.number(),
      body: z.string(),
      redline: z.string().optional(),
      counselNotes: z.string().optional(),
    })
  )
  .states(
    H.state('drafting', 'pending'),
    H.state('returned', 'pending'),
    H.state('executed', 'terminal', 'success'),
    H.state('declined', 'terminal', 'failure'),
    H.state('rejected', 'terminal', 'failure'),
    H.state('abandoned', 'terminal', 'failure')
  );

const local = shell.local('local', { slots: 2 });
const sonnet = anthropic.model('claude-sonnet-4-5');
const apiAccount = anthropic.account('anthropic-api', { apiKey: H.env('ANTHROPIC_API_KEY') });

const drafterRole = H.role('contract-drafter')
  .input(z.object({ title: z.string(), body: z.string(), redline: z.string(), counselNotes: z.string() }))
  .output(z.object({ draft: z.string(), summary: z.string() }))
  .prompt(
    (input) => `Draft "${input.title}".\n${input.body}\nCounterparty redline:\n${input.redline}\nCounsel notes:\n${input.counselNotes}`
  );

const drafter = H.seat('contract-drafter', drafterRole).model(sonnet);

const counselDecisionSchema = z.object({ verdict: z.enum(['approve', 'return']), notes: z.string().optional() });
type CounselDecision = z.infer<typeof counselDecisionSchema>;
const counselAboutSchema = z.object({ category: categorySchema, summary: z.string() });
type CounselAbout = z.infer<typeof counselAboutSchema>;

function humanCounselRecord(metrics: Metrics, of: Category): Rate {
  return metrics.rate({
    among: { ...counsel.resolved(), resolver: 'human', facets: [category.of(of)] },
    count: { ...counsel.resolved({ verdict: 'approve' }), resolver: 'human', facets: [category.of(of)] },
    days: 365,
  });
}

const provenCategorySkipsCounsel = H.policy.rule<CounselAbout, CounselDecision | null>(
  'proven-category-skips-counsel',
  (about, metrics) => {
    const record = humanCounselRecord(metrics, about.category);
    return record.samples >= 200 && record.hits === record.samples ? { verdict: 'approve' } : null;
  }
);

const counsel = H.halt('counsel', counselDecisionSchema).about(counselAboutSchema).policy(provenCategorySkipsCounsel);

const signoff = H.halt('signoff', z.object({ approve: z.boolean() }))
  .about(z.object({ amountUsd: z.number() }))
  .timeout({ minutes: 30 }, (about) => ({ approve: about.amountUsd < 500 }));

const execute = H.command('execute-contract')
  .input(z.object({ contract: z.string(), draft: z.string() }))
  .argv((input) => ['docsys', 'execute', '--contract', input.contract, '--draft', input.draft])
  .on(local)
  .recovery('park');

const pageDeputy = H.command('page-finance-deputy')
  .input(z.object({ unit: z.string(), amountUsd: z.number() }))
  .argv((input) => ['pager', 'page', '--rota', 'finance-deputy', '--text', `Signoff waiting on ${input.unit} ($${input.amountUsd})`])
  .on(local);

const formatMean = (label: string, value: number | null, samples: number): string =>
  `${label}: ${value === null ? 'n/a' : Math.round(value / 60_000)} min (n=${samples})`;

const signoffContext = H.policy.rule('signoff-context', (input: { readonly since: Date }, metrics) => {
  const counselHuman = metrics.median({ of: 'decisionMs', among: { ...counsel.resolved(), resolver: 'human' }, since: input.since });
  const signoffHuman = metrics.median({ of: 'decisionMs', among: { ...signoff.resolved(), resolver: 'human' }, since: input.since });
  const signoffClock = metrics.median({ of: 'decisionMs', among: { ...signoff.resolved(), resolver: 'clock' }, since: input.since });
  const byTimeout = metrics.rate({
    among: signoff.resolved(),
    count: { ...signoff.resolved(), resolver: 'clock' },
    since: input.since,
  });
  const euRetries = metrics.count({ of: { entry: 'attempt', status: 'retrying', lane: euLane }, since: input.since });
  const usRetries = metrics.count({ of: { entry: 'attempt', status: 'retrying', lane: usLane }, since: input.since });
  return [
    formatMean('counsel, human', counselHuman.value, counselHuman.samples),
    formatMean('signoff, human', signoffHuman.value, signoffHuman.samples),
    formatMean('signoff, timeout', signoffClock.value, signoffClock.samples),
    `signoff resolved by timeout: ${byTimeout.hits}/${byTimeout.samples}`,
    `retries this month: eu ${euRetries}, us ${usRetries}`,
  ].join('\n');
});

const contractFlow = H.flow('contract').for(contract).does(async (ctx) => {
  const data = ctx.unit.data;
  const drafted = await ctx.run(drafter, {
    title: data.title,
    body: data.body,
    redline: data.redline ?? '',
    counselNotes: data.counselNotes ?? '',
  });
  if (!drafted.ok) return ctx.fail(drafted.error);
  const review = await ctx.halt(counsel, drafted.value.draft, { category: data.category, summary: drafted.value.summary });
  if (review.verdict === 'return') {
    await ctx.update({ counselNotes: review.notes ?? '' });
    return 'returned';
  }
  const now = ctx.now();
  const context = await ctx.decide(signoffContext, { since: new Date(now.getFullYear(), now.getMonth(), 1) });
  const signed = await ctx.halt(signoff, `${drafted.value.summary}\n\n${context}`, { amountUsd: data.amountUsd });
  if (!signed.approve) return 'rejected';
  const executed = await ctx.run(execute, { contract: ctx.unit.key, draft: drafted.value.draft });
  if (!executed.ok) return ctx.fail(executed.error);
  return 'executed';
});

const contractEventSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('new'),
    contract: z.string(),
    title: z.string(),
    counterparty: z.string(),
    category: categorySchema,
    amountUsd: z.number(),
    body: z.string(),
  }),
  z.object({ type: z.literal('redline'), contract: z.string(), text: z.string() }),
]);
type ContractEvent = z.infer<typeof contractEventSchema>;

const readContractEvent = (event: ContractEvent): SupplyOf<typeof contract> =>
  event.type === 'new'
    ? {
        create: {
          title: event.title,
          counterparty: event.counterparty,
          category: event.category,
          amountUsd: event.amountUsd,
          body: event.body,
        },
        key: event.contract,
      }
    : { update: event.contract, patch: { redline: event.text }, state: 'drafting' };

const contractWebhook = (region: string) =>
  http.webhook(contract, {
    path: `/contracts/${region}`,
    secret: H.env('CONTRACTS_WEBHOOK_SECRET'),
    body: contractEventSchema,
    read: readContractEvent,
  });

const documentSystem = http.store(contract, {
  url: 'https://documents.example.com/api/contracts',
  headers: { Authorization: H.env('DOCUMENTS_TOKEN') },
  stateField: 'workflow_state',
});

const euLane = H.lane('contracts-eu', contract)
  .handler(contractFlow, { retries: 3, backoff: { first: { minutes: 2 }, factor: 2, max: { hours: 1 } }, exhausted: 'abandoned' })
  .suppliers(contractWebhook('eu'), H.operator)
  .store(documentSystem)
  .wip(3)
  .facet(category, (data) => data.category);

const usLane = H.lane('contracts-us', contract)
  .handler(contractFlow, { retries: 1, exhausted: 'abandoned' })
  .suppliers(contractWebhook('us'), H.operator)
  .store(documentSystem)
  .wip(3)
  .facet(category, (data) => data.category);

const secondReturnDeclines = H.trigger('second-return-declines', H.on.enters(contract, 'returned', { times: 2 }), (_, act) =>
  act.move('declined')
);

const deputyAtTwentyMinutes = H.trigger('page-deputy-at-twenty-minutes', H.on.halted(signoff, { minutes: 20 }), (event, act) =>
  act.run(pageDeputy, { unit: event.unit, amountUsd: event.about.amountUsd })
);

const counselDashboard = http.control({
  port: 8801,
  token: H.env('COUNSEL_DASHBOARD_TOKEN'),
  grants: [H.ops.resolve(counsel)],
});

const financeSupervisor = claude.supervisor({ grants: [H.ops.resolve(signoff)] });

const auditorClient = http.control({
  port: 8802,
  token: H.env('AUDITOR_TOKEN'),
  grants: [H.ops.readWork, H.ops.readTelemetry],
});

const operationsClient = http.control({
  port: 8803,
  token: H.env('OPERATIONS_TOKEN'),
  grants: [H.ops.readWork, H.ops.writeWork, H.ops.resolve(H.halts.interrupted, H.halts.definitionChanged)],
});

export const contractsHarness = H.harness('contracts')
  .ledger(sqlite.ledger('/srv/contracts/.harness/ledger.sqlite'))
  .lanes(euLane, usLane)
  .pools(H.pool('api', [{ account: apiAccount, share: 1 }]))
  .triggers(secondReturnDeclines, deputyAtTwentyMinutes)
  .clients(counselDashboard, financeSupervisor, auditorClient, operationsClient)
  .observers(markdown.board('/srv/contracts/.harness/board.md'), markdown.telemetry('/srv/contracts/.harness/telemetry.md'));
