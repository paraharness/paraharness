import { H, type Halt, type Metrics, type SupplyOf } from 'harness-dsl';
import * as anthropic from 'harness-dsl/anthropic';
import * as claude from 'harness-dsl/claude-code';
import * as http from 'harness-dsl/http';
import * as sqlite from 'harness-dsl/sqlite';
import * as shell from 'harness-dsl/shell';
import * as markdown from 'harness-dsl/markdown';
import { z } from 'zod';

const account = anthropic.account('api', { apiKey: H.env('ANTHROPIC_API_KEY') });
const pool = H.pool('api-pool', [{ account, share: 1 }]);
const opus = anthropic.model('claude-opus');
const local = shell.local('local', { slots: 4 });

const category = H.facet('contract-category', z.string());

const drafting = H.state('drafting', 'pending');
const returned = H.state('returned', 'pending');
const executed = H.state('executed', 'terminal', 'success');
const declined = H.state('declined', 'terminal', 'failure');
const rejectedByFinance = H.state('rejected-by-finance', 'terminal', 'failure');
const stalled = H.state('stalled', 'terminal', 'failure');
const contract = H.kind('contract')
  .data(z.object({
    contractId: z.string(),
    counterparty: z.string(),
    title: z.string(),
    amountUsd: z.number(),
    category: z.string(),
    redlines: z.array(z.string()),
    counselNotes: z.array(z.string()),
    draft: z.string(),
  }))
  .states(drafting, returned, executed, declined, rejectedByFinance, stalled);

const drafterRole = H.role('contract-drafter')
  .input(z.object({ title: z.string(), counterparty: z.string(), redlines: z.array(z.string()), counselNotes: z.array(z.string()) }))
  .output(z.object({ draft: z.string() }))
  .prompt(input => `Draft ${input.title} with ${input.counterparty}.\nRedlines:\n${input.redlines.join('\n')}\nCounsel notes:\n${input.counselNotes.join('\n')}`);
const drafter = H.seat('contract-drafter', drafterRole).model(opus);

const counselDecision = z.object({ verdict: z.enum(['approve', 'return']), notes: z.string() });
const counselAbout = z.object({ category: z.string(), title: z.string(), draft: z.string() });
type CounselDecision = z.infer<typeof counselDecision>;
type CounselAbout = z.infer<typeof counselAbout>;

const counselSkip = H.policy.rule('counsel-skip', (about: CounselAbout, metrics: Metrics): CounselDecision | null => {
  const among = { entry: 'halt' as const, halt: counsel, status: 'resolved', resolver: 'human' as const, facets: [category.value(about.category)] };
  const record = metrics.rate({ among, count: { ...among, decision: { verdict: 'approve' } } });
  return record.samples >= 200 && record.hits === record.samples
    ? { verdict: 'approve', notes: `Skipped: ${record.samples} approvals, no returns in ${about.category}` }
    : null;
});
const counsel: Halt<CounselDecision, CounselAbout> = H.halt('counsel', counselDecision)
  .about(counselAbout)
  .policy(counselSkip);

const signoff = H.halt('signoff', z.object({ approve: z.boolean() }))
  .about(z.object({ title: z.string(), amountUsd: z.number() }))
  .timeout({ minutes: 30 }, about => ({ approve: about.amountUsd < 500 }));

const execute = H.command('execute-contract')
  .input(z.object({ contractId: z.string() }))
  .argv(input => ['./contracts/execute', input.contractId])
  .on(local)
  .recovery('park');
const pageDeputy = H.command('page-finance-deputy')
  .input(z.object({ unit: z.string() }))
  .argv(input => ['./pager/page', 'finance-deputy', input.unit])
  .on(local);

const monthStart = (now: Date) => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
const decisionReport = H.policy.rule('decision-report', (now: Date, metrics: Metrics): string => {
  const since = monthStart(now);
  const counselHuman = metrics.median({ of: 'decisionMs', among: { entry: 'halt', halt: counsel, status: 'resolved', resolver: 'human' }, since });
  const counselPolicy = metrics.median({ of: 'decisionMs', among: { entry: 'halt', halt: counsel, status: 'resolved', resolver: 'policy' }, since });
  const signoffHuman = metrics.median({ of: 'decisionMs', among: { entry: 'halt', halt: signoff, status: 'resolved', resolver: 'human' }, since });
  const byTimeout = metrics.rate({
    among: { entry: 'halt', halt: signoff, status: 'resolved' },
    count: { entry: 'halt', halt: signoff, status: 'resolved', resolver: 'clock' },
    since,
  });
  const euRetries = metrics.count({ of: { entry: 'attempt', status: 'retrying', lane: euContracts }, since });
  const usRetries = metrics.count({ of: { entry: 'attempt', status: 'retrying', lane: usContracts }, since });
  return [
    `counsel median by human ${counselHuman.value ?? 'n/a'} ms (n=${counselHuman.samples}), by policy ${counselPolicy.value ?? 'n/a'} ms (n=${counselPolicy.samples})`,
    `signoff median by human ${signoffHuman.value ?? 'n/a'} ms (n=${signoffHuman.samples}), resolved by timeout ${byTimeout.hits}/${byTimeout.samples}`,
    `retries this month: eu ${euRetries}, us ${usRetries}`,
  ].join('\n');
});

const handleContract = H.flow('handle-contract').for(contract).does(async ctx => {
  const data = ctx.unit.data;
  ctx.tag(category, data.category);
  const drafted = await ctx.run(drafter, {
    title: data.title,
    counterparty: data.counterparty,
    redlines: data.redlines,
    counselNotes: data.counselNotes,
  });
  if (!drafted.ok) return ctx.fail(drafted.error);
  await ctx.update({ draft: drafted.value.draft });
  const review = await ctx.halt(counsel, `Review ${data.title} with ${data.counterparty}`, {
    category: data.category,
    title: data.title,
    draft: drafted.value.draft,
  });
  if (review.verdict === 'return') {
    await ctx.update({ counselNotes: [...data.counselNotes, review.notes] });
    return 'returned';
  }
  const report = await ctx.decide(decisionReport, ctx.now());
  const signed = await ctx.halt(signoff, `Sign off ${data.title} for $${data.amountUsd}\n${report}`, {
    title: data.title,
    amountUsd: data.amountUsd,
  });
  if (!signed.approve) return 'rejected-by-finance';
  const done = await ctx.run(execute, { contractId: data.contractId });
  return done.ok ? 'executed' : ctx.fail(done.error);
});

const contractEvent = z.object({
  type: z.enum(['new', 'redline']),
  contractId: z.string(),
  counterparty: z.string(),
  title: z.string(),
  amountUsd: z.number(),
  category: z.string(),
  redlines: z.array(z.string()),
});
type ContractEvent = z.infer<typeof contractEvent>;
const toSupply = (body: ContractEvent): SupplyOf<typeof contract> => body.type === 'new'
  ? {
    create: {
      contractId: body.contractId,
      counterparty: body.counterparty,
      title: body.title,
      amountUsd: body.amountUsd,
      category: body.category,
      redlines: body.redlines,
      counselNotes: [],
      draft: '',
    },
    key: body.contractId,
  }
  : { update: body.contractId, patch: { redlines: body.redlines }, state: 'drafting', deferred: true };

const webhookSecret = H.env('CONTRACTS_WEBHOOK_SECRET');
const documents = http.store(contract, {
  url: 'https://docs.example.com/api/contracts',
  headers: { Authorization: H.env('DOCUMENTS_TOKEN') },
  stateField: 'status',
});

const backoff = (name: string, attempts: number) =>
  H.policy.retry(name, view => view.failures < attempts ? { retryInMs: 60_000 * 2 ** view.failures } : 'stop');

const euContracts = H.lane('contracts-eu', contract)
  .handler(handleContract)
  .suppliers(http.webhook(contract, { path: '/contracts/eu', secret: webhookSecret, body: contractEvent, read: toSupply }), H.operator)
  .store(documents)
  .wip(3)
  .retry(backoff('eu-three-retries', 3), 'stalled');
const usContracts = H.lane('contracts-us', contract)
  .handler(handleContract)
  .suppliers(http.webhook(contract, { path: '/contracts/us', secret: webhookSecret, body: contractEvent, read: toSupply }), H.operator)
  .store(documents)
  .wip(3)
  .retry(backoff('us-one-retry', 1), 'stalled');

const secondReturnDeclines = H.trigger(
  'second-return-declines',
  H.on.enters(contract, 'returned', { times: 2 }),
  (event, act) => act.move('declined'),
);
const pageFinanceDeputy = H.trigger(
  'page-finance-deputy',
  H.on.halted(signoff, { minutes: 20 }),
  (event, act) => act.run(pageDeputy, { unit: event.unit }),
);

export const harness = H.harness('contracts')
  .ledger(sqlite.ledger('./.harness/ledger.db'))
  .lanes(euContracts, usContracts)
  .pools(pool)
  .triggers(secondReturnDeclines, pageFinanceDeputy)
  .clients(
    http.control({ port: 8441, token: H.env('COUNSEL_TOKEN'), grants: [H.ops.readWork, H.ops.resolve(counsel)] }),
    claude.supervisor({ grants: [H.ops.readWork, H.ops.resolve(signoff)] }),
    http.control({ port: 8442, token: H.env('AUDITOR_TOKEN'), grants: [H.ops.readTelemetry] }),
  )
  .observers(markdown.board('./BOARD.md'), markdown.telemetry('./TELEMETRY.md'));
