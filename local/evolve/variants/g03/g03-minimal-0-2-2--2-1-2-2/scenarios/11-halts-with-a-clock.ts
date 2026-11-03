import { z } from 'zod';
import { H } from 'harness-dsl';
import * as anthropic from 'harness-dsl/anthropic';
import * as sqlite from 'harness-dsl/sqlite';
import * as http from 'harness-dsl/http';
import * as shell from 'harness-dsl/shell';
import * as claude from 'harness-dsl/claude-code';
import * as markdown from 'harness-dsl/markdown';

const categories = z.enum(['nda', 'msa', 'purchase', 'licence']);
const category = H.facet('category', categories);

const api = anthropic.account('contracts-api', { apiKey: H.env('ANTHROPIC_API_KEY') });
const strong = anthropic.model('claude-sonnet-4-5');
const pool = H.pool('contracts-accounts', [{ account: api, share: 1 }]);
const local = shell.local('local', { slots: 4 });

const drafting = H.state('drafting', 'pending');
const returned = H.state('returned', 'pending');
const executed = H.state('executed', 'terminal', 'success');
const declined = H.state('declined', 'terminal', 'failure');
const rejected = H.state('rejected', 'terminal', 'failure');
const failed = H.state('failed', 'terminal', 'failure');

const contract = H.kind('contract')
  .data(z.object({
    title: z.string(),
    counterparty: z.string(),
    category: categories,
    amountUsd: z.number(),
    redlines: z.array(z.string()),
    counselNotes: z.string().optional(),
    documentUri: z.string().optional(),
  }))
  .states(drafting, returned, executed, declined, rejected, failed);

const draftRole = H.role('contract-drafter')
  .input(z.object({ title: z.string(), counterparty: z.string(), redlines: z.array(z.string()), counselNotes: z.string().optional() }))
  .output(z.object({ documentUri: z.string() }))
  .prompt(input => `Draft ${input.title} with ${input.counterparty}.\nRedlines:\n${input.redlines.join('\n')}\nCounsel: ${input.counselNotes ?? 'none'}`);

const drafter = H.seat('contract-drafter', draftRole).model(strong);

const counselDecision = z.object({ verdict: z.enum(['approve', 'return', 'reject']), notes: z.string().optional() });
const counselAbout = z.object({ category: categories, amountUsd: z.number() });
type CounselDecision = z.infer<typeof counselDecision>;
type CounselAbout = z.infer<typeof counselAbout>;

const counselQuestion = H.halt('counsel', counselDecision).about(counselAbout);

const counselSkip = H.policy.rule<CounselAbout, CounselDecision | null>('counsel-skip-proven-category', (about, metrics) => {
  const scope = [category.of(about.category)];
  const record = metrics.rate({
    among: { ...counselQuestion.resolved(), resolver: 'human', facets: scope },
    count: { ...counselQuestion.resolved({ verdict: 'approve' }), resolver: 'human', facets: scope },
  });
  return record.hits >= 200 && record.hits === record.samples
    ? { verdict: 'approve', notes: `skipped: ${record.hits} of ${record.samples} human reviews approved` }
    : null;
});

const counsel = counselQuestion.policy(counselSkip);

const signoff = H.halt('signoff', z.object({ approve: z.boolean() }))
  .about(z.object({ amountUsd: z.number() }))
  .timeout({ minutes: 30 }, about => ({ approve: about.amountUsd < 500 }));

const execute = H.command('execute-contract')
  .input(z.object({ contract: z.string(), documentUri: z.string() }))
  .argv(input => ['./bin/docsys-execute', input.contract, input.documentUri])
  .on(local)
  .recovery('park');

const pageDeputy = H.command('page-finance-deputy')
  .input(z.object({ contract: z.string(), amountUsd: z.number() }))
  .argv(input => ['./bin/page', 'finance-deputy', input.contract, String(input.amountUsd)])
  .on(local);

const handleContract = H.flow('handle-contract').for(contract).does(async ctx => {
  const data = ctx.unit.data;
  const draft = await ctx.run(drafter, { title: data.title, counterparty: data.counterparty, redlines: data.redlines, counselNotes: data.counselNotes });
  if (!draft.ok) return ctx.fail(draft.error);
  await ctx.update({ documentUri: draft.value.documentUri });
  const review = await ctx.halt(counsel, `Review ${data.title}: ${draft.value.documentUri}`, { category: data.category, amountUsd: data.amountUsd });
  if (review.verdict === 'return') {
    await ctx.update({ counselNotes: review.notes });
    return 'returned';
  }
  if (review.verdict === 'reject') return 'declined';
  const sign = await ctx.halt(signoff, `Sign off ${data.title} for $${data.amountUsd}`, { amountUsd: data.amountUsd });
  if (!sign.approve) return 'rejected';
  const done = await ctx.run(execute, { contract: ctx.unit.key, documentUri: draft.value.documentUri });
  if (!done.ok) return ctx.fail(done.error);
  return 'executed';
});

const contractBody = z.object({
  event: z.enum(['new', 'redline']),
  id: z.string(),
  title: z.string(),
  counterparty: z.string(),
  category: categories,
  amountUsd: z.number(),
  redlines: z.array(z.string()),
});

const regionHook = (region: string) => http.webhook(contract, {
  path: `/hooks/contracts/${region}`,
  secret: H.env('CONTRACTS_WEBHOOK_SECRET'),
  body: contractBody,
  read: body => body.event === 'new'
    ? {
        create: { title: body.title, counterparty: body.counterparty, category: body.category, amountUsd: body.amountUsd, redlines: body.redlines },
        key: body.id,
      }
    : { update: body.id, patch: { redlines: body.redlines }, state: 'drafting' },
});

const documentStore = http.store(contract, {
  url: 'https://docs.example.com/api/contracts',
  headers: { authorization: H.env('DOCSYS_TOKEN') },
  stateField: 'status',
});

const contractsEu = H.lane('contracts-eu', contract)
  .handler(handleContract)
  .retry({ times: 3, backoff: { first: { minutes: 1 }, factor: 2, max: { hours: 1 } }, exhausted: 'failed' })
  .suppliers(regionHook('eu'), H.operator)
  .store(documentStore)
  .wip(3)
  .facet(category, data => data.category);

const contractsUs = H.lane('contracts-us', contract)
  .handler(handleContract)
  .retry({ times: 1, exhausted: 'failed' })
  .suppliers(regionHook('us'), H.operator)
  .store(documentStore)
  .wip(3)
  .facet(category, data => data.category);

const secondReturnDeclines = H.trigger(
  'second-return-declines',
  H.on.enters(contract, 'returned', { times: 2 }),
  (_event, act) => act.move('declined'),
);

const deputyPage = H.trigger(
  'page-deputy-at-20-minutes',
  H.on.halted(signoff, { minutes: 20 }),
  (event, act) => act.run(pageDeputy, { contract: event.unit, amountUsd: event.about.amountUsd }),
);

export const contractReports = H.policy.rule('contract-reports', (since: Date, metrics) => ({
  counselMedianMs: {
    human: metrics.median({ of: 'decisionMs', among: { ...counsel.resolved(), resolver: 'human' }, since }),
    policy: metrics.median({ of: 'decisionMs', among: { ...counsel.resolved(), resolver: 'policy' }, since }),
  },
  signoffMedianMs: {
    human: metrics.median({ of: 'decisionMs', among: { ...signoff.resolved(), resolver: 'human' }, since }),
    clock: metrics.median({ of: 'decisionMs', among: { ...signoff.resolved(), resolver: 'clock' }, since }),
  },
  retries: {
    eu: metrics.count({ of: { entry: 'attempt', status: 'retrying', lane: contractsEu }, since }),
    us: metrics.count({ of: { entry: 'attempt', status: 'retrying', lane: contractsUs }, since }),
  },
  signoffTimeoutShare: metrics.rate({ among: signoff.resolved(), count: { ...signoff.resolved(), resolver: 'clock' }, since }),
}));

export const contracts = H.harness('contracts')
  .ledger(sqlite.ledger('./harness/contracts.sqlite'))
  .lanes(contractsEu, contractsUs)
  .pools(pool)
  .triggers(secondReturnDeclines, deputyPage)
  .clients(
    http.control({ port: 8441, token: H.env('COUNSEL_TOKEN'), grants: [H.ops.resolve(counsel)] }),
    claude.supervisor({ grants: [H.ops.resolve(signoff)] }),
    http.control({ port: 8442, token: H.env('AUDITOR_TOKEN'), grants: [H.ops.readTelemetry] }),
    http.control({
      port: 8443,
      token: H.env('OPERATOR_TOKEN'),
      grants: [H.ops.readWork, H.ops.writeWork, H.ops.resolve(H.halts.interrupted, H.halts.definitionChanged)],
    }),
  )
  .observers(markdown.board('./harness/BOARD.md'));
