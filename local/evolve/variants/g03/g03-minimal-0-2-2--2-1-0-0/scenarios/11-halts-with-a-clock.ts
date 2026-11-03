import { H } from 'harness-dsl';
import { z } from 'zod';
import * as claudeCode from 'harness-dsl/claude-code';
import * as anthropic from 'harness-dsl/anthropic';
import * as sqlite from 'harness-dsl/sqlite';
import * as shell from 'harness-dsl/shell';
import * as http from 'harness-dsl/http';
import * as markdown from 'harness-dsl/markdown';

const local = shell.local('contracts-local', { slots: 3 });
const opus = anthropic.model('claude-opus-4-1');

const contractCategories = z.enum(['nda', 'msa', 'procurement']);
const category = H.facet('contract-category', contractCategories);

const received = H.state('received', 'pending');
const returned = H.state('returned', 'pending');
const stalled = H.state('stalled', 'waiting');
const executed = H.state('executed', 'terminal', 'success');
const declined = H.state('declined', 'terminal', 'failure');
const rejected = H.state('rejected', 'terminal', 'failure');

const contract = H.kind('Contract')
  .data(
    z.object({
      title: z.string(),
      counterparty: z.string(),
      documentId: z.string(),
      category: contractCategories,
      valueUsd: z.number(),
      latestRedline: z.string().optional(),
    })
  )
  .states(received, returned, stalled, executed, declined, rejected);

const drafterRole = H.role('contract-drafter')
  .input(z.object({ documentId: z.string(), counterparty: z.string(), redline: z.string() }))
  .output(z.object({ summary: z.string() }))
  .prompt((input) => `Draft the contract ${input.documentId} for ${input.counterparty}, applying every redline up to ${input.redline}.`);

const drafter = H.seat('contract-drafter', drafterRole).model(opus).on(local);

const counsel = H.halt('counsel', z.object({ verdict: z.enum(['approve', 'return']), notes: z.string() }))
  .about(z.object({ category: contractCategories, documentId: z.string() }))
  .policy('counsel-skip-proven-category', (about, metrics, self) => {
    const scope = { resolver: 'human' as const, facets: [category.of(about.category)] };
    const history = metrics.rate({
      among: { ...self.resolved(), ...scope },
      count: { ...self.resolved({ verdict: 'approve' }), ...scope },
    });
    return history.samples >= 200 && history.hits === history.samples
      ? { verdict: 'approve', notes: `skipped: ${history.hits}/${history.samples} human approvals` }
      : null;
  });

const signoff = H.halt('signoff', z.object({ approved: z.boolean(), note: z.string().optional() }))
  .about(z.object({ valueUsd: z.number() }))
  .timeout({ minutes: 30 }, (about) => ({ approved: about.valueUsd < 500, note: 'resolved by timeout' }));

const execute = H.command('execute-contract')
  .input(z.object({ documentId: z.string() }))
  .argv((input) => ['docsys', 'execute', input.documentId])
  .on(local)
  .recovery('park');

const pageDeputy = H.command('page-finance-deputy')
  .input(z.object({ unit: z.string(), valueUsd: z.number() }))
  .argv((input) => ['pager', 'notify', 'finance-deputy', `signoff pending for ${input.unit} ($${input.valueUsd})`])
  .on(local)
  .recovery('rerun');

const negotiateContract = H.flow('negotiate-contract')
  .for(contract)
  .does(async (ctx) => {
    const data = ctx.unit.data;
    const drafted = await ctx.run(drafter, { documentId: data.documentId, counterparty: data.counterparty, redline: data.latestRedline ?? 'none' });
    if (!drafted.ok) return ctx.fail(drafted.error);
    const review = await ctx.halt(counsel, drafted.value.summary, { category: data.category, documentId: data.documentId });
    if (review.verdict === 'return') return 'returned';
    const signed = await ctx.halt(signoff, `${data.title}: $${data.valueUsd}`, { valueUsd: data.valueUsd });
    if (!signed.approved) return 'rejected';
    const done = await ctx.run(execute, { documentId: data.documentId });
    if (!done.ok) return ctx.fail(done.error);
    return 'executed';
  });

const contractEvent = z.object({
  contract: z.string(),
  event: z.enum(['created', 'redline']),
  title: z.string(),
  counterparty: z.string(),
  documentId: z.string(),
  category: contractCategories,
  valueUsd: z.number(),
  redline: z.string().optional(),
});

const contractWebhook = (region: string) =>
  http.webhook(contract, {
    path: `/contracts/${region}`,
    secret: H.env('CONTRACTS_WEBHOOK_SECRET'),
    body: contractEvent,
    read: (body, supply) =>
      body.event === 'created'
        ? supply.create(
            { title: body.title, counterparty: body.counterparty, documentId: body.documentId, category: body.category, valueUsd: body.valueUsd },
            { key: body.contract }
          )
        : supply.update(body.contract, { patch: { latestRedline: body.redline }, state: 'received', cancels: ['waiting'] }),
  });

const documentStore = http.store(contract, {
  url: 'https://docs.example.com/api/contracts',
  headers: { authorization: H.env('DOCSYS_TOKEN') },
  stateField: 'harness_state',
});

const contractsEu = H.lane('contracts-eu', contract)
  .handler(negotiateContract)
  .retries(3, { backoff: { first: { minutes: 5 }, factor: 2, max: { hours: 2 } }, exhausted: 'stalled' })
  .suppliers(contractWebhook('eu'), H.operator)
  .store(documentStore)
  .wip(3)
  .facet(category, (data) => data.category);

const contractsUs = H.lane('contracts-us', contract)
  .handler(negotiateContract)
  .retries(1, { exhausted: 'declined' })
  .suppliers(contractWebhook('us'), H.operator)
  .store(documentStore)
  .wip(3)
  .facet(category, (data) => data.category);

const returnsBound = H.trigger('second-return-declines', H.on.enters(contract, 'returned', { times: 2 }), (_event, act) => act.move('declined'));

const deputyPage = H.trigger('signoff-deputy-page', H.on.halted(signoff, { minutes: 20 }), (event, act) =>
  act.run(pageDeputy, { unit: event.unit, valueUsd: event.about.valueUsd })
);

export const decisionTimes = H.policy.rule('median-time-to-decision', z.object({ resolver: z.enum(['human', 'policy', 'clock']) }), (input, metrics) => ({
  counsel: metrics.median({ of: 'decisionMs', among: { ...counsel.resolved(), resolver: input.resolver } }),
  signoff: metrics.median({ of: 'decisionMs', among: { ...signoff.resolved(), resolver: input.resolver } }),
}));

export const retriesThisMonth = H.policy.rule('retries-per-lane-this-month', z.object({}), (_input, metrics) => ({
  eu: metrics.count({ of: { entry: 'attempt', status: 'retrying', lane: contractsEu }, period: 'thisMonth' }),
  us: metrics.count({ of: { entry: 'attempt', status: 'retrying', lane: contractsUs }, period: 'thisMonth' }),
}));

export const signoffTimeoutShare = H.policy.rule('signoff-timeout-share', z.object({ days: z.number() }), (input, metrics) =>
  metrics.rate({ days: input.days, among: signoff.resolved(), count: { ...signoff.resolved(), resolver: 'clock' } })
);

export const harness = H.harness('contracts')
  .ledger(sqlite.ledger('contracts/.harness/ledger.sqlite'))
  .pools(H.pool('contracts-accounts', [{ account: anthropic.account('contracts-api', { apiKey: H.env('ANTHROPIC_API_KEY') }), share: 1 }]).serves(opus))
  .lanes(contractsEu, contractsUs)
  .triggers(returnsBound, deputyPage)
  .scheduler(
    H.policy.scheduler('drafting-wip-three', (view) => {
      const drafting = view.live.filter((unit) => unit.position === 'active').length;
      return { start: view.sorted(() => 0).slice(0, Math.max(0, 3 - drafting)) };
    })
  )
  .clients(
    http.control({ port: 8401, token: H.env('COUNSEL_TOKEN'), grants: [H.ops.resolve(counsel)] }),
    claudeCode.supervisor({ grants: [H.ops.resolve(signoff)] }),
    http.control({ port: 8402, token: H.env('AUDITOR_TOKEN'), grants: [H.ops.readWork, H.ops.readTelemetry] }),
    http.control({
      port: 8403,
      token: H.env('OPERATOR_TOKEN'),
      grants: [H.ops.readWork, H.ops.writeWork, H.ops.resolve(H.halts.interrupted, H.halts.definitionChanged)],
    })
  )
  .observers(markdown.board('contracts/BOARD.md'), markdown.telemetry('contracts/TELEMETRY.md'));
