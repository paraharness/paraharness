import { z } from 'zod';
import { H } from 'harness-dsl';
import * as claude from 'harness-dsl/claude-code';
import * as anthropic from 'harness-dsl/anthropic';
import * as sqlite from 'harness-dsl/sqlite';
import * as shell from 'harness-dsl/shell';
import * as http from 'harness-dsl/http';
import * as markdown from 'harness-dsl/markdown';

const local = shell.local('local', { slots: 4 });
const contractCategory = z.enum(['nda', 'msa', 'sow', 'other']);
const category = H.facet('contract-category', contractCategory);
const region = z.enum(['eu', 'us']);

const received = H.state('received', 'pending');
const redlined = H.state('redlined', 'pending');
const returned = H.state('returned', 'pending');
const executed = H.state('executed', 'terminal', 'success');
const rejected = H.state('rejected', 'terminal', 'neutral');
const declined = H.state('declined', 'terminal', 'failure');
const failed = H.state('failed', 'terminal', 'failure');
const contract = H.kind('Contract')
  .data(
    z.object({
      title: z.string(),
      counterparty: z.string(),
      amountUsd: z.number(),
      category: contractCategory,
      region,
      redline: z.string(),
      counselNotes: z.string(),
    })
  )
  .states(received, redlined, returned, executed, rejected, declined, failed);

const drafter = H.seat(
  'contract-drafter',
  H.role('contract-drafter')
    .input(z.object({ title: z.string(), counterparty: z.string(), amountUsd: z.number(), redline: z.string(), counselNotes: z.string() }))
    .output(z.object({ draft: z.string() }))
    .prompt(
      input =>
        `Draft ${input.title} with ${input.counterparty} for $${input.amountUsd}.\nRedline: ${input.redline}\nCounsel notes: ${input.counselNotes}`
    )
).model(anthropic.model('claude-sonnet-4-5'));

const counsel = H.halt('counsel', z.object({ verdict: z.enum(['approve', 'return']), notes: z.string() }))
  .about(z.object({ category: contractCategory, draft: z.string() }))
  .policy('trusted-category-skips-counsel', view => {
    const facets = [category.of(view.about.category)];
    const record = view.metrics.rate({
      among: { ...view.resolved(), resolver: 'human', facets },
      count: { ...view.resolved({ verdict: 'approve' }), resolver: 'human', facets },
    });
    return record.samples >= 200 && record.hits === record.samples
      ? { verdict: 'approve', notes: `counsel skipped: ${record.hits} of ${record.samples} approved` }
      : null;
  });

const signoff = H.halt('signoff', z.object({ approve: z.boolean() }))
  .about(z.object({ amountUsd: z.number() }))
  .timeout({ minutes: 30 }, about => ({ approve: about.amountUsd < 500 }));

const executeContract = H.command('execute-contract')
  .input(z.object({ title: z.string(), counterparty: z.string() }))
  .argv(input => ['docsys', 'execute', '--title', input.title, '--counterparty', input.counterparty])
  .on(local)
  .recovery('park');

const pageDeputy = H.command('page-deputy')
  .input(z.object({ unit: z.string(), amountUsd: z.number() }))
  .argv(input => ['pager', 'page', 'finance-deputy', `Contract ${input.unit} for $${input.amountUsd} awaits signoff`])
  .on(local);

export const decisionTimes = H.policy.rule('decision-times', z.object({ days: z.number() }), (input, metrics) => ({
  counselByHumanMs: metrics.median({ of: 'decisionMs', among: { entry: 'halt', status: 'resolved', halt: counsel, resolver: 'human' }, days: input.days }),
  counselByPolicyMs: metrics.median({ of: 'decisionMs', among: { entry: 'halt', status: 'resolved', halt: counsel, resolver: 'policy' }, days: input.days }),
  signoffByHumanMs: metrics.median({ of: 'decisionMs', among: { entry: 'halt', status: 'resolved', halt: signoff, resolver: 'human' }, days: input.days }),
  signoffByClockMs: metrics.median({ of: 'decisionMs', among: { entry: 'halt', status: 'resolved', halt: signoff, resolver: 'clock' }, days: input.days }),
  signoffTimeoutShare: metrics.rate({
    days: input.days,
    among: { entry: 'halt', status: 'resolved', halt: signoff },
    count: { entry: 'halt', status: 'resolved', halt: signoff, resolver: 'clock' },
  }),
}));

const handleContract = H.flow('handle-contract').for(contract).does(async ctx => {
  const data = ctx.unit.data;
  const drafted = await ctx.run(drafter, {
    title: data.title,
    counterparty: data.counterparty,
    amountUsd: data.amountUsd,
    redline: data.redline,
    counselNotes: data.counselNotes,
  });
  if (!drafted.ok) return ctx.fail(drafted);
  const review = await ctx.halt(counsel, `Review ${data.title} with ${data.counterparty}`, { category: data.category, draft: drafted.value.draft });
  if (review.verdict === 'return') {
    await ctx.update({ counselNotes: review.notes });
    return 'returned';
  }
  const times = await ctx.decide(decisionTimes, { days: 30 });
  const signed = await ctx.halt(
    signoff,
    `Sign off ${data.title} for $${data.amountUsd}; ${Math.round((times.signoffTimeoutShare.value ?? 0) * 100)}% of signoffs this month timed out`,
    { amountUsd: data.amountUsd }
  );
  if (!signed.approve) return 'rejected';
  const done = await ctx.run(executeContract, { title: data.title, counterparty: data.counterparty });
  if (!done.ok) return ctx.fail(done);
  return 'executed';
});

const contractEvent = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('new'),
    id: z.string(),
    region,
    title: z.string(),
    counterparty: z.string(),
    amountUsd: z.number(),
    category: contractCategory,
  }),
  z.object({ type: z.literal('redline'), id: z.string(), redline: z.string() }),
]);

const contractWebhook = (lane: 'eu' | 'us') =>
  http.webhook(contract, {
    path: `/contracts/${lane}`,
    secret: H.env('CONTRACTS_WEBHOOK_SECRET'),
    body: contractEvent,
    read: body =>
      body.type === 'redline'
        ? { update: body.id, patch: { redline: body.redline }, state: 'redlined' }
        : body.region === lane
          ? {
              create: {
                title: body.title,
                counterparty: body.counterparty,
                amountUsd: body.amountUsd,
                category: body.category,
                region: lane,
                redline: '',
                counselNotes: '',
              },
              key: body.id,
            }
          : null,
  });

const documents = http.store(contract, {
  url: 'https://docs.example.com/api/contracts',
  headers: { authorization: H.env('DOCUMENT_SYSTEM_TOKEN') },
  stateField: 'workflow_state',
});

const contractsEu = H.lane('contracts-eu', contract)
  .handler(handleContract)
  .retries(3, 'failed', { first: { minutes: 2 }, factor: 2, max: { minutes: 30 } })
  .suppliers(contractWebhook('eu'), H.operator)
  .store(documents)
  .wip(3)
  .facet(category, data => data.category);

const contractsUs = H.lane('contracts-us', contract)
  .handler(handleContract)
  .retries(1, 'failed')
  .suppliers(contractWebhook('us'), H.operator)
  .store(documents)
  .wip(3)
  .facet(category, data => data.category);

export const retriesThisMonth = H.policy.rule('retries-per-lane', z.object({ since: z.date() }), (input, metrics) => ({
  eu: metrics.count({ since: input.since, of: { entry: 'attempt', status: 'retrying', lane: contractsEu } }),
  us: metrics.count({ since: input.since, of: { entry: 'attempt', status: 'retrying', lane: contractsUs } }),
}));

const secondReturnDeclines = H.trigger(
  'second-return-declines',
  H.on.enters(contract, 'returned', { times: 2 }),
  (_event, act) => act.move('declined')
);

const deputyPage = H.trigger('page-finance-deputy', H.on.halted(signoff, { minutes: 20 }), (event, act) =>
  act.run(pageDeputy, { unit: event.unit, amountUsd: event.about.amountUsd })
);

export const harness = H.harness('contracts')
  .ledger(sqlite.ledger('/srv/contracts/ledger.sqlite'))
  .lanes(contractsEu, contractsUs)
  .pools(H.pool('api', [{ account: anthropic.account('api', { apiKey: H.env('ANTHROPIC_API_KEY') }), share: 1 }]))
  .triggers(secondReturnDeclines, deputyPage)
  .scheduler(H.policy.scheduler('oldest-first', view => ({ start: [...view.pending].sort((a, b) => b.waitedMs - a.waitedMs) })))
  .clients(
    http.control({ port: 8411, token: H.env('COUNSEL_TOKEN'), grants: [H.ops.resolve(counsel)] }),
    claude.supervisor({ grants: [H.ops.resolve(signoff)] }),
    http.control({ port: 8412, token: H.env('AUDITOR_TOKEN'), grants: [H.ops.readTelemetry] }),
    http.control({ port: 8410, token: H.env('OPERATOR_TOKEN'), grants: [H.ops.readWork, H.ops.writeWork] })
  )
  .observers(markdown.board('/srv/contracts/BOARD.md'), markdown.telemetry('/srv/contracts/TELEMETRY.md'));
