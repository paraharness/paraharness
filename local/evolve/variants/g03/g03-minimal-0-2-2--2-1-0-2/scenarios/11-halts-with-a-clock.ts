import { z } from 'zod';
import { H } from 'harness-dsl';
import * as anthropic from 'harness-dsl/anthropic';
import * as claudeCode from 'harness-dsl/claude-code';
import * as sqlite from 'harness-dsl/sqlite';
import * as shell from 'harness-dsl/shell';
import * as http from 'harness-dsl/http';
import * as markdown from 'harness-dsl/markdown';

const sonnet = anthropic.model('claude-sonnet-4-5');
const api = anthropic.account('contracts-api', { apiKey: H.env('ANTHROPIC_API_KEY'), serves: [sonnet] });

const local = shell.local('local', { slots: 4 });

const categoryValues = z.enum(['nda', 'msa', 'sow']);
const contractCategory = H.facet('contract-category', categoryValues);

const received = H.state('received', 'pending');
const returned = H.state('returned', 'pending');
const executed = H.state('executed', 'terminal', 'success');
const declined = H.state('declined', 'terminal', 'failure');
const abandoned = H.state('abandoned', 'terminal', 'failure');

const contract = H.kind('contract')
  .data(z.object({
    title: z.string(),
    counterparty: z.string(),
    amountUsd: z.number(),
    category: categoryValues,
    latestRedline: z.string().optional(),
    counselNotes: z.string().optional(),
  }))
  .states(received, returned, executed, declined, abandoned);

const draftRole = H.role('draft-contract')
  .input(z.object({ title: z.string(), counterparty: z.string(), redline: z.string(), counselNotes: z.string() }))
  .output(z.object({ document: z.string() }))
  .prompt(i => `Draft "${i.title}" with ${i.counterparty}.\nRedline: ${i.redline}\nCounsel notes: ${i.counselNotes}`);

const drafter = H.seat('contract-drafter', draftRole).model(sonnet);

const counselAbout = z.object({ category: categoryValues, document: z.string() });
type CounselAbout = z.infer<typeof counselAbout>;
const counselQuestion = H.halt('counsel', z.object({ verdict: z.enum(['approve', 'return', 'reject']), notes: z.string() })).about(counselAbout);

const counselSkip = H.policy.rule('counsel-skip', (about: CounselAbout, metrics) => {
  const facets = [contractCategory.of(about.category)];
  const approved = metrics.count({ of: { ...counselQuestion.resolved({ verdict: 'approve' }), resolver: 'human', facets } });
  const rejected = metrics.count({ of: { ...counselQuestion.resolved({ verdict: 'reject' }), facets } });
  return approved >= 200 && rejected === 0 ? { verdict: 'approve' as const, notes: 'skipped: category has a clean record' } : null;
});

const counsel = counselQuestion.policy(counselSkip);

const signoff = H.halt('signoff', z.object({ approve: z.boolean() }))
  .about(z.object({ amountUsd: z.number() }))
  .timeout({ minutes: 30 }, about => ({ approve: about.amountUsd < 500 }));

const executeContract = H.command('execute-contract')
  .input(z.object({ contract: z.string() }))
  .argv(i => ['docsys', 'execute', i.contract])
  .on(local)
  .recovery('park');

const pageDeputy = H.command('page-finance-deputy')
  .input(z.object({ unit: z.string(), amountUsd: z.number() }))
  .argv(i => ['pager', 'notify', '--team', 'finance-deputy', '--unit', i.unit, '--amount', String(i.amountUsd)])
  .on(local);

const contractFlow = H.flow('contract-flow')
  .for(contract)
  .does(async ctx => {
    const data = ctx.unit.data;
    const drafted = await ctx.run(drafter, {
      title: data.title,
      counterparty: data.counterparty,
      redline: data.latestRedline ?? '',
      counselNotes: data.counselNotes ?? '',
    });
    if (!drafted.ok) return ctx.fail(drafted.error);
    const review = await ctx.halt(counsel, `Review ${data.title}`, { category: data.category, document: drafted.value.document });
    if (review.verdict === 'return') {
      await ctx.update({ counselNotes: review.notes });
      return 'returned';
    }
    if (review.verdict === 'reject') return 'declined';
    const sign = await ctx.halt(signoff, `Sign off ${data.title} for $${data.amountUsd}`, { amountUsd: data.amountUsd });
    if (!sign.approve) return 'declined';
    const done = await ctx.run(executeContract, { contract: ctx.unit.key });
    return done.ok ? 'executed' : ctx.fail(done.error);
  });

const contractWebhook = (region: string) =>
  http.webhook(contract, {
    path: `/contracts/${region}`,
    secret: H.env('DOCSYS_WEBHOOK_SECRET'),
    body: z.discriminatedUnion('event', [
      z.object({ event: z.literal('new'), id: z.string(), title: z.string(), counterparty: z.string(), amountUsd: z.number(), category: categoryValues }),
      z.object({ event: z.literal('redline'), id: z.string(), text: z.string() }),
    ]),
    read: body =>
      body.event === 'new'
        ? { create: { title: body.title, counterparty: body.counterparty, amountUsd: body.amountUsd, category: body.category }, key: body.id }
        : { update: body.id, patch: { latestRedline: body.text }, state: 'received', cancels: ['waiting'] },
  });

const documentStore = http.store(contract, {
  url: 'https://docsys.example.com/api/contracts',
  headers: { authorization: H.env('DOCSYS_TOKEN') },
  stateField: 'status',
});

const contractsEu = H.lane('contracts-eu', contract)
  .handler(contractFlow)
  .retries(3, { backoff: { first: { minutes: 5 }, factor: 2 }, exhausted: 'abandoned' })
  .suppliers(contractWebhook('eu'), H.operator)
  .store(documentStore)
  .wip(3)
  .facet(contractCategory, d => d.category);

const contractsUs = H.lane('contracts-us', contract)
  .handler(contractFlow)
  .retries(1, { exhausted: 'abandoned' })
  .suppliers(contractWebhook('us'), H.operator)
  .store(documentStore)
  .wip(3)
  .facet(contractCategory, d => d.category);

const secondReturnDeclines = H.trigger('second-return-declines', H.on.enters(contract, 'returned', { times: 2 }), (_event, act) =>
  act.move('declined')
);

const deputyPage = H.trigger('page-deputy-on-slow-signoff', H.on.halted(signoff, { minutes: 20 }), (event, act) =>
  act.run(pageDeputy, { unit: event.unit, amountUsd: event.about.amountUsd })
);

const resolvers: readonly ('human' | 'policy' | 'clock')[] = ['human', 'policy', 'clock'];

export const contractReport = H.policy.rule('contract-report', (_input: { readonly days: number }, metrics) => ({
  decisionTimes: [counsel, signoff].flatMap(halt =>
    resolvers.map(resolver => ({
      halt: halt.name,
      resolver,
      median: metrics.median({ of: 'decisionMs', among: { entry: 'halt', status: 'resolved', halt, resolver }, days: _input.days }),
    }))
  ),
  retries: [contractsEu, contractsUs].map(lane => ({
    lane: lane.name,
    count: metrics.count({ of: { entry: 'attempt', status: 'retrying', lane }, days: _input.days }),
  })),
  signoffByTimeout: metrics.rate({ among: signoff.resolved(), count: { ...signoff.resolved(), resolver: 'clock' }, days: _input.days }),
}));

export default H.harness('contracts')
  .ledger(sqlite.ledger('.harness/ledger.db'))
  .lanes(contractsEu, contractsUs)
  .pools(H.pool('contracts-api', [{ account: api, share: 1 }]))
  .triggers(secondReturnDeclines, deputyPage)
  .clients(
    http.control({ port: 8401, token: H.env('COUNSEL_DASHBOARD_TOKEN'), grants: [H.ops.resolve(counsel)] }),
    claudeCode.supervisor({ grants: [H.ops.resolve(signoff)] }),
    http.control({ port: 8402, token: H.env('AUDITOR_TOKEN'), grants: [H.ops.readTelemetry] }),
    http.control({ port: 8403, token: H.env('OPERATOR_TOKEN'), grants: [H.ops.readWork, H.ops.writeWork, H.ops.resolve(H.halts.interrupted, H.halts.definitionChanged)] })
  )
  .observers(markdown.board('.harness/board.md'), markdown.telemetry('.harness/telemetry.md'));
