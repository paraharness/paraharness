import { z } from 'zod';
import { H } from 'harness-dsl';
import type { Metrics, SupplyOf } from 'harness-dsl';
import * as cc from 'harness-dsl/claude-code';
import * as anthropic from 'harness-dsl/anthropic';
import * as sqlite from 'harness-dsl/sqlite';
import * as shell from 'harness-dsl/shell';
import * as http from 'harness-dsl/http';
import * as markdown from 'harness-dsl/markdown';

const local = shell.local('local', { slots: 4 });
const apiAccount = anthropic.account('anthropic-api', { apiKey: H.env('ANTHROPIC_API_KEY') });
const opus = anthropic.model('claude-opus-4-1');

const categoryFacet = H.facet('category', z.string());

const drafting = H.state('drafting', 'pending');
const returned = H.state('returned', 'pending');
const executed = H.state('executed', 'terminal', 'success');
const declined = H.state('declined', 'terminal', 'failure');
const rejected = H.state('rejected', 'terminal', 'failure');
const abandoned = H.state('abandoned', 'terminal', 'failure');

const contract = H.kind('contract')
  .data(z.object({
    title: z.string(),
    terms: z.string(),
    category: z.string(),
    valueUsd: z.number(),
    latestRedline: z.string().optional(),
    counselNotes: z.string().optional(),
    documentUrl: z.string().optional(),
  }))
  .states(drafting, returned, executed, declined, rejected, abandoned);

const drafterRole = H.role('contract-drafter')
  .input(z.object({ title: z.string(), terms: z.string(), latestRedline: z.string(), counselNotes: z.string() }))
  .output(z.object({ documentUrl: z.string() }))
  .prompt(i => `Draft "${i.title}" with terms:\n${i.terms}\nApply redline: ${i.latestRedline}\nCounsel notes: ${i.counselNotes}`);
const drafter = H.seat('contract-drafter', drafterRole).model(opus);

const counselDecision = z.object({ verdict: z.enum(['approve', 'return']), notes: z.string() });
const counselAbout = z.object({ category: z.string(), title: z.string(), documentUrl: z.string() });
type CounselDecision = z.infer<typeof counselDecision>;
type CounselAbout = z.infer<typeof counselAbout>;

const provenCategorySkipsCounsel = H.policy.rule(
  'proven-category-skips-counsel',
  (about: CounselAbout, metrics: Metrics): CounselDecision | null => {
    const inCategory = [categoryFacet.value(about.category)];
    const human = metrics.rate({
      among: { ...counsel.resolved({ by: 'human' }), facets: inCategory },
      count: { ...counsel.resolved({ match: { verdict: 'approve' }, by: 'human' }), facets: inCategory },
    });
    return human.samples >= 200 && human.hits === human.samples ? { verdict: 'approve', notes: 'proven category' } : null;
  }
);

const counsel = H.halt('counsel', counselDecision).about(counselAbout).policy(provenCategorySkipsCounsel);

const signoff = H.halt('signoff', z.object({ approve: z.boolean() }))
  .about(z.object({ title: z.string(), valueUsd: z.number() }))
  .timeout({ minutes: 30 }, about => ({ approve: about.valueUsd < 500 }));

const executeContract = H.command('execute-contract')
  .input(z.object({ documentUrl: z.string() }))
  .argv(i => ['./contracts/execute.sh', i.documentUrl])
  .on(local)
  .recovery('park');

const pageDeputy = H.command('page-finance-deputy')
  .input(z.object({ unit: z.string() }))
  .argv(i => ['./ops/page.sh', 'finance-deputy', i.unit])
  .on(local);

const handleContract = H.flow('handle-contract').for(contract).does(async ctx => {
  const d = ctx.unit.data;
  ctx.tag(categoryFacet, d.category);
  const drafted = await ctx.call(drafter, {
    title: d.title,
    terms: d.terms,
    latestRedline: d.latestRedline ?? '',
    counselNotes: d.counselNotes ?? '',
  });
  if (!drafted.ok) return ctx.fail(drafted.error);
  await ctx.update({ documentUrl: drafted.value.documentUrl });
  const review = await ctx.halt(counsel, `Review ${d.title}`, {
    category: d.category,
    title: d.title,
    documentUrl: drafted.value.documentUrl,
  });
  if (review.verdict === 'return') {
    await ctx.update({ counselNotes: review.notes });
    return 'returned';
  }
  const signed = await ctx.halt(signoff, `Sign off ${d.title} for $${d.valueUsd}`, { title: d.title, valueUsd: d.valueUsd });
  if (!signed.approve) return 'rejected';
  const done = await ctx.call(executeContract, { documentUrl: drafted.value.documentUrl });
  if (!done.ok) return ctx.fail(done.error);
  return 'executed';
});

const region = z.enum(['eu', 'us']);
const contractEvent = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('new'),
    region,
    contractId: z.string(),
    title: z.string(),
    terms: z.string(),
    category: z.string(),
    valueUsd: z.number(),
  }),
  z.object({ type: z.literal('redline'), region, contractId: z.string(), text: z.string() }),
]);
type ContractEvent = z.infer<typeof contractEvent>;

const fromWebhook = (lane: 'eu' | 'us') => (event: ContractEvent): SupplyOf<typeof contract> | null => {
  if (event.region !== lane) return null;
  if (event.type === 'redline') {
    return { update: event.contractId, patch: { latestRedline: event.text }, state: 'drafting', postpone: true };
  }
  return {
    create: { title: event.title, terms: event.terms, category: event.category, valueUsd: event.valueUsd },
    key: event.contractId,
  };
};

const documentHeaders = { Authorization: H.env('DOCUMENT_SYSTEM_TOKEN') };
const documentStore = http.store(contract, {
  url: 'https://docs.example.com/api/contracts',
  headers: documentHeaders,
  stateField: 'harness_state',
});
const webhookSecret = H.env('CONTRACTS_WEBHOOK_SECRET');

const contractsEu = H.lane('contracts-eu', contract)
  .handler(handleContract)
  .suppliers(http.webhook(contract, { path: '/contracts/eu', secret: webhookSecret, body: contractEvent, read: fromWebhook('eu') }), H.operator)
  .store(documentStore)
  .wip(3)
  .retry(H.retry('eu-three-retries', { retries: 3, backoff: { initialMs: 60_000, factor: 2 } }), 'abandoned');

const contractsUs = H.lane('contracts-us', contract)
  .handler(handleContract)
  .suppliers(http.webhook(contract, { path: '/contracts/us', secret: webhookSecret, body: contractEvent, read: fromWebhook('us') }), H.operator)
  .store(documentStore)
  .wip(3)
  .retry(H.retry('us-one-retry', { retries: 1, backoff: { initialMs: 60_000 } }), 'abandoned');

const secondReturnDeclines = H.trigger(
  'second-return-declines',
  H.on.enters(contract, 'returned', { times: 2 }),
  (event, act) => act.move('declined')
);

const deputyPagedAtTwentyMinutes = H.trigger(
  'deputy-paged-at-twenty-minutes',
  H.on.halted(signoff, { minutes: 20 }),
  (event, act) => act.call(pageDeputy, { unit: event.unit })
);

const contractDecisions = H.report('contract-decisions', (m, now) => {
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  return {
    medianDecisionMsByHalt: m.medianBy({ of: 'decisionMs', among: { entry: 'halt', status: 'resolved' }, by: 'halt', days: 30 }),
    medianDecisionMsByResolver: m.medianBy({ of: 'decisionMs', among: { entry: 'halt', status: 'resolved' }, by: 'resolver', days: 30 }),
    retriesEuThisMonth: m.count({ of: { entry: 'attempt', status: 'retrying', lane: contractsEu }, since: monthStart }),
    retriesUsThisMonth: m.count({ of: { entry: 'attempt', status: 'retrying', lane: contractsUs }, since: monthStart }),
    signoffResolvedByTimeout: m.rate({ among: signoff.resolved(), count: signoff.resolved({ by: 'clock' }), days: 30 }),
  };
});

export const contracts = H.harness('contracts')
  .ledger(sqlite.ledger('contracts/.harness/ledger.sqlite'))
  .lanes(contractsEu, contractsUs)
  .pools(H.pool('api', [{ account: apiAccount, share: 1 }]))
  .triggers(secondReturnDeclines, deputyPagedAtTwentyMinutes)
  .reports(contractDecisions)
  .clients(
    http.control({ port: 8443, token: H.env('COUNSEL_TOKEN'), grants: [H.ops.resolve(counsel)] }),
    cc.supervisor({ grants: [H.ops.resolve(signoff)] }),
    http.control({ port: 8444, token: H.env('AUDITOR_TOKEN'), grants: [H.ops.readTelemetry] }),
    http.control({
      port: 8445,
      token: H.env('OPERATIONS_TOKEN'),
      grants: [H.ops.readWork, H.ops.writeWork, H.ops.resolve(H.parked)],
    })
  )
  .observers(markdown.board('contracts/BOARD.md'), markdown.telemetry('contracts/TELEMETRY.md'));
