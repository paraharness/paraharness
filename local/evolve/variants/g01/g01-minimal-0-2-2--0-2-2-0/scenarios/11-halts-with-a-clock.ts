import { H, type Halt } from 'harness-dsl';
import { z } from 'zod';
import * as claudeCode from 'harness-dsl/claude-code';
import * as anthropic from 'harness-dsl/anthropic';
import * as sqlite from 'harness-dsl/sqlite';
import * as shell from 'harness-dsl/shell';
import * as http from 'harness-dsl/http';
import * as markdown from 'harness-dsl/markdown';

const apiAccount = anthropic.account('api', { apiKey: H.env('ANTHROPIC_API_KEY') });
const sonnet = anthropic.model('claude-sonnet-4-5');
const apiPool = H.pool('api', [{ account: apiAccount, share: 1 }]);
const localRunner = shell.local('local', { slots: 4 });

const categories = z.enum(['nda', 'msa', 'order-form', 'amendment']);
const contractCategory = H.facet('contract-category', categories);

const received = H.state('received', 'pending');
const returned = H.state('returned', 'pending');
const executed = H.state('executed', 'terminal', 'success');
const rejected = H.state('rejected', 'terminal', 'failure');
const declined = H.state('declined', 'terminal', 'failure');
const stalled = H.state('stalled', 'terminal', 'failure');

const contract = H.kind('Contract')
  .data(
    z.object({
      id: z.string(),
      title: z.string(),
      category: categories,
      amountUsd: z.number(),
      latestRedline: z.string().optional()
    })
  )
  .states(received, returned, executed, rejected, declined, stalled);

const drafterRole = H.role('contract-drafter')
  .input(z.object({ title: z.string(), category: categories, redline: z.string().optional() }))
  .output(z.object({ document: z.string() }))
  .prompt(input => `Draft the ${input.category} "${input.title}". Apply this counterparty redline: ${input.redline ?? 'none'}`);

const drafter = H.seat('contract-drafter', drafterRole).model(sonnet);

const counselDecision = z.object({ approved: z.boolean(), notes: z.string() });
const counselAbout = z.object({ category: categories });

const counsel: Halt<z.infer<typeof counselDecision>, z.infer<typeof counselAbout>> = H.halt('counsel', counselDecision)
  .about(counselAbout)
  .policy(
    H.policy.rule('skip-counsel-for-proven-category', (about: z.infer<typeof counselAbout>, metrics) => {
      const record = metrics.rate({
        days: 365,
        among: { entry: 'halt', halt: counsel, status: 'resolved', resolver: 'human', facets: [contractCategory.of(about.category)] },
        count: {
          entry: 'halt',
          halt: counsel,
          status: 'resolved',
          resolver: 'human',
          facets: [contractCategory.of(about.category)],
          decision: { approved: true }
        }
      });
      return record.samples >= 200 && record.hits === record.samples ? { approved: true, notes: 'skipped: proven category' } : null;
    })
  );

const signoff = H.halt('signoff', z.object({ approve: z.boolean() }))
  .about(z.object({ amountUsd: z.number() }))
  .timeout({ minutes: 30 }, about => ({ approve: about.amountUsd < 500 }));

const executeContract = H.command('execute-contract')
  .input(z.object({ id: z.string(), document: z.string() }))
  .argv(input => ['./contracts/execute', input.id, input.document])
  .on(localRunner)
  .recovery('park');

const pageDeputy = H.command('page-finance-deputy')
  .input(z.object({ unit: z.string(), amountUsd: z.number() }))
  .argv(input => ['./contracts/page-deputy', input.unit, String(input.amountUsd)])
  .on(localRunner);

const handleContract = H.flow('handle-contract')
  .for(contract)
  .does(async ctx => {
    ctx.tag(contractCategory.of(ctx.unit.data.category));
    const drafted = await ctx.run(drafter, {
      title: ctx.unit.data.title,
      category: ctx.unit.data.category,
      redline: ctx.unit.data.latestRedline
    });
    if (!drafted.ok) return ctx.fail(drafted.error);
    const review = await ctx.halt(counsel, drafted.value.document, { category: ctx.unit.data.category });
    if (!review.approved) return 'returned';
    const sign = await ctx.halt(signoff, `Sign off ${ctx.unit.data.title} for $${ctx.unit.data.amountUsd}`, { amountUsd: ctx.unit.data.amountUsd });
    if (!sign.approve) return 'rejected';
    const done = await ctx.run(executeContract, { id: ctx.unit.data.id, document: drafted.value.document });
    if (!done.ok) return ctx.fail(done.error);
    return 'executed';
  });

const contractWebhook = (region: string) =>
  http.webhook(contract, {
    path: `/contracts/${region}`,
    secret: H.env('DOCUMENT_SYSTEM_WEBHOOK_SECRET'),
    body: z.object({
      event: z.enum(['created', 'redlined']),
      contract: z.object({ id: z.string(), title: z.string(), category: categories, amountUsd: z.number() }),
      redline: z.string().optional()
    }),
    read: body =>
      body.event === 'created'
        ? { create: { ...body.contract }, key: body.contract.id }
        : { update: body.contract.id, patch: { latestRedline: body.redline }, state: 'received', deferred: true }
  });

const documentStore = http.store(contract, {
  url: 'https://documents.example.com/api/contracts',
  headers: { authorization: H.env('DOCUMENT_SYSTEM_TOKEN') },
  stateField: 'workflow_state'
});

const euRetry = H.policy.attemptRetry('eu-three-with-backoff', view =>
  view.failedAttempts >= 4 ? 'stop' : { retryInMs: 60_000 * 2 ** (view.failedAttempts - 1) }
);
const usRetry = H.policy.attemptRetry('us-once', view => (view.failedAttempts >= 2 ? 'stop' : { retryInMs: 5 * 60_000 }));

const euLane = H.lane('contracts-eu', contract)
  .handler(handleContract)
  .suppliers(contractWebhook('eu'), H.operator)
  .store(documentStore)
  .wip(3)
  .retry(euRetry, 'stalled');
const usLane = H.lane('contracts-us', contract)
  .handler(handleContract)
  .suppliers(contractWebhook('us'), H.operator)
  .store(documentStore)
  .wip(3)
  .retry(usRetry, 'stalled');

const secondReturnDeclines = H.trigger('second-return-declines', H.on.enters(contract, 'returned', { times: 2 }), (_event, act) =>
  act.move('declined')
);

const pageDeputyAtTwenty = H.trigger('page-deputy-at-twenty-minutes', H.on.halted(signoff, { minutes: 20 }), (event, act) =>
  act.run(pageDeputy, { unit: event.unit, amountUsd: event.about.amountUsd })
);

export const medianDecision = H.policy.rule(
  'median-time-to-decision',
  (query: { resolver: 'human' | 'policy' | 'clock'; days: number }, metrics) => ({
    counsel: metrics.median({ of: 'decisionMs', days: query.days, among: { entry: 'halt', halt: counsel, status: 'resolved', resolver: query.resolver } }),
    signoff: metrics.median({ of: 'decisionMs', days: query.days, among: { entry: 'halt', halt: signoff, status: 'resolved', resolver: query.resolver } })
  })
);

export const retriesThisMonth = H.policy.rule('retries-per-lane-this-month', (query: { since: Date }, metrics) => ({
  eu: metrics.count({ of: { entry: 'attempt', status: 'retrying', lane: euLane }, since: query.since }),
  us: metrics.count({ of: { entry: 'attempt', status: 'retrying', lane: usLane }, since: query.since })
}));

export const signoffTimeoutShare = H.policy.rule('signoff-timeout-share', (query: { days: number }, metrics) =>
  metrics.rate({
    days: query.days,
    among: { entry: 'halt', halt: signoff, status: 'resolved' },
    count: { entry: 'halt', halt: signoff, status: 'resolved', resolver: 'clock' }
  })
);

export const harness = H.harness('contracts')
  .ledger(sqlite.ledger('.harness/ledger.db'))
  .lanes(euLane, usLane)
  .pools(apiPool)
  .triggers(secondReturnDeclines, pageDeputyAtTwenty)
  .clients(
    http.control({ port: 7420, token: H.env('COUNSEL_DASHBOARD_TOKEN'), grants: [H.ops.resolve(counsel)] }),
    claudeCode.supervisor({ grants: [H.ops.resolve(signoff)] }),
    http.control({ port: 7421, token: H.env('AUDITOR_TOKEN'), grants: [H.ops.readWork, H.ops.readTelemetry] }),
    http.control({ port: 7422, token: H.env('OPERATOR_TOKEN'), grants: [H.ops.readWork, H.ops.writeWork] })
  )
  .observers(markdown.board('BOARD.md'), markdown.telemetry('TELEMETRY.md'));
