import { H } from 'harness-dsl';
import type { Metrics } from 'harness-dsl';
import { z } from 'zod';
import { webhook, store, control } from 'harness-dsl/http';
import { supervisor } from 'harness-dsl/claude-code';
import { account, model } from 'harness-dsl/anthropic';
import { ledger } from 'harness-dsl/sqlite';
import { local } from 'harness-dsl/shell';
import { board } from 'harness-dsl/markdown';

const shell = local('contracts-shell', { slots: 3 });
const api = account('contracts-api', { apiKey: H.env('ANTHROPIC_API_KEY') });
const sonnet = model('claude-sonnet-4-5');

const contractCategory = z.enum(['nda', 'msa', 'sow', 'dpa']);
const category = H.facet('contract-category', contractCategory);

const received = H.state('received', 'pending');
const returned = H.state('returned', 'pending');
const executed = H.state('executed', 'terminal', 'success');
const rejected = H.state('rejected', 'terminal', 'neutral');
const declined = H.state('declined', 'terminal', 'failure');
const stuck = H.state('stuck', 'terminal', 'failure');
const contract = H.kind('contract')
  .data(
    z.object({
      title: z.string(),
      counterparty: z.string(),
      category: contractCategory,
      valueUsd: z.number(),
      documentId: z.string(),
      latestRedline: z.string().optional(),
    })
  )
  .states(received, returned, executed, rejected, declined, stuck);

const draftRole = H.role('draft-contract')
  .input(
    z.object({
      title: z.string(),
      counterparty: z.string(),
      category: contractCategory,
      documentId: z.string(),
      latestRedline: z.string().optional(),
    })
  )
  .output(z.object({ summary: z.string() }))
  .prompt(
    input =>
      `Draft ${input.category} "${input.title}" with ${input.counterparty} in document ${input.documentId}. Apply redline: ${input.latestRedline ?? 'none'}`
  )
  .intents(['read', 'edit']);
const drafter = H.seat('contract-drafter', draftRole).model(sonnet);

const counselDecision = z.object({ verdict: z.enum(['approve', 'return']), notes: z.string() });
const counselAbout = z.object({ category: contractCategory, documentId: z.string() });
const counselQuestion = H.halt('counsel', counselDecision).about(counselAbout);
const counselSkip = H.policy.rule(
  'counsel-skip',
  (about: z.infer<typeof counselAbout>, metrics: Metrics): z.infer<typeof counselDecision> | null => {
    const facets = [category.of(about.category)];
    const approvals = metrics.rate({
      among: { ...counselQuestion.resolved(), resolver: 'human', facets },
      count: { ...counselQuestion.resolved({ verdict: 'approve' }), resolver: 'human', facets },
    });
    return approvals.samples >= 200 && approvals.hits === approvals.samples
      ? { verdict: 'approve', notes: `skipped by policy: ${approvals.hits} of ${approvals.samples} approved` }
      : null;
  }
);
const counsel = counselQuestion.policy(counselSkip);

const signoff = H.halt('signoff', z.object({ approve: z.boolean() }))
  .about(z.object({ valueUsd: z.number() }))
  .timeout({ minutes: 30 }, about => ({ approve: about.valueUsd < 500 }));

const execute = H.command('execute-contract')
  .input(z.object({ documentId: z.string() }))
  .argv(input => ['docsys-execute', input.documentId])
  .on(shell)
  .recovery('park');
const pageDeputy = H.command('page-finance-deputy')
  .input(z.object({ unit: z.string(), valueUsd: z.number() }))
  .argv(input => ['pager', 'finance-deputy', `Sign-off pending for ${input.unit} ($${input.valueUsd})`])
  .on(shell);

const contractFlow = H.flow('contract')
  .for(contract)
  .does(async ctx => {
    const data = ctx.unit.data;
    const drafted = await ctx.run(drafter, data);
    if (!drafted.ok) return ctx.fail(drafted.error);
    const review = await ctx.halt(counsel, drafted.value.summary, { category: data.category, documentId: data.documentId });
    if (review.verdict === 'return') return 'returned';
    const signed = await ctx.halt(signoff, `Sign off ${data.title} for $${data.valueUsd}`, { valueUsd: data.valueUsd });
    if (!signed.approve) return 'rejected';
    const done = await ctx.run(execute, { documentId: data.documentId });
    if (!done.ok) return ctx.fail(done.error);
    return 'executed';
  });

const contractEvent = z.discriminatedUnion('event', [
  z.object({
    event: z.literal('new'),
    contract: z.string(),
    title: z.string(),
    counterparty: z.string(),
    category: contractCategory,
    valueUsd: z.number(),
    documentId: z.string(),
  }),
  z.object({ event: z.literal('redline'), contract: z.string(), text: z.string() }),
]);

const contractHook = (region: 'eu' | 'us') =>
  webhook(contract, {
    path: `/contracts/${region}`,
    secret: H.env('CONTRACTS_WEBHOOK_SECRET'),
    body: contractEvent,
    read: body =>
      body.event === 'new'
        ? {
            create: {
              title: body.title,
              counterparty: body.counterparty,
              category: body.category,
              valueUsd: body.valueUsd,
              documentId: body.documentId,
            },
            key: body.contract,
          }
        : { update: body.contract, patch: { latestRedline: body.text }, cancels: ['waiting'] },
  });

const documents = store(contract, {
  url: 'https://docs.example.com/api/contracts',
  headers: { Authorization: H.env('DOCUMENTS_TOKEN') },
  stateField: 'harness_state',
});

const euLane = H.lane('contracts-eu', contract)
  .handler(contractFlow)
  .retries(3, { backoff: { first: { minutes: 10 }, factor: 2 }, exhausted: 'stuck' })
  .suppliers(contractHook('eu'), H.operator)
  .store(documents)
  .wip(3)
  .facet(category, data => data.category);
const usLane = H.lane('contracts-us', contract)
  .handler(contractFlow)
  .retries(1, { exhausted: 'stuck' })
  .suppliers(contractHook('us'), H.operator)
  .store(documents)
  .wip(3)
  .facet(category, data => data.category);

const secondReturnDeclines = H.trigger('second-return-declines', H.on.enters(contract, 'returned', { times: 2 }), (_event, act) =>
  act.move('declined')
);
const deputyPage = H.trigger('page-deputy-at-twenty-minutes', H.on.halted(signoff, { minutes: 20 }), (event, act) =>
  act.run(pageDeputy, { unit: event.unit, valueUsd: event.about.valueUsd })
);

export const decisionReport = H.policy.rule('decision-report', (ask: { readonly since: Date }, metrics: Metrics) => ({
  counselByHuman: metrics.median({ of: 'decisionMs', since: ask.since, among: { ...counsel.resolved(), resolver: 'human' } }),
  counselByPolicy: metrics.median({ of: 'decisionMs', since: ask.since, among: { ...counsel.resolved(), resolver: 'policy' } }),
  signoffByHuman: metrics.median({ of: 'decisionMs', since: ask.since, among: { ...signoff.resolved(), resolver: 'human' } }),
  signoffByClock: metrics.median({ of: 'decisionMs', since: ask.since, among: { ...signoff.resolved(), resolver: 'clock' } }),
  euRetries: metrics.count({ since: ask.since, of: { entry: 'attempt', status: 'retrying', lane: euLane } }),
  usRetries: metrics.count({ since: ask.since, of: { entry: 'attempt', status: 'retrying', lane: usLane } }),
  signoffTimeoutShare: metrics.rate({
    since: ask.since,
    among: signoff.resolved(),
    count: { ...signoff.resolved(), resolver: 'clock' },
  }),
}));

export default H.harness('contracts')
  .ledger(ledger('/srv/contracts/ledger.sqlite'))
  .lanes(euLane, usLane)
  .pools(H.pool('contracts-api-pool', [{ account: api, share: 1 }]))
  .triggers(secondReturnDeclines, deputyPage)
  .clients(
    control({ port: 7411, token: H.env('COUNSEL_DASHBOARD_TOKEN'), grants: [H.ops.resolve(counsel)] }),
    supervisor({ grants: [H.ops.resolve(signoff)] }),
    control({ port: 7412, token: H.env('FINANCE_DEPUTY_TOKEN'), grants: [H.ops.resolve(signoff)] }),
    control({ port: 7413, token: H.env('AUDITOR_TOKEN'), grants: [H.ops.readWork, H.ops.readTelemetry] }),
    control({
      port: 7414,
      token: H.env('CONTRACTS_OWNER_TOKEN'),
      grants: [H.ops.readWork, H.ops.writeWork, H.ops.resolve(H.halts.interrupted, H.halts.definitionChanged)],
    })
  )
  .observers(board('/srv/contracts/BOARD.md'));
