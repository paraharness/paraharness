import { H } from 'harness-dsl';
import type { Metrics } from 'harness-dsl';
import { z } from 'zod';
import * as anthropic from 'harness-dsl/anthropic';
import * as claudeCode from 'harness-dsl/claude-code';
import * as http from 'harness-dsl/http';
import * as sqlite from 'harness-dsl/sqlite';
import * as shell from 'harness-dsl/shell';
import * as markdown from 'harness-dsl/markdown';

const category = z.enum(['nda', 'msa', 'sow', 'dpa']);

const received = H.state('received', 'pending');
const redlined = H.state('redlined', 'pending');
const returned = H.state('returned', 'pending');
const executed = H.state('executed', 'terminal', 'success');
const rejected = H.state('rejected', 'terminal', 'failure');
const declined = H.state('declined', 'terminal', 'failure');
const failed = H.state('failed', 'terminal', 'failure');

const Contract = H.kind('Contract')
  .data(z.object({
    title: z.string(),
    category,
    amountUsd: z.number(),
    terms: z.string(),
    redlines: z.array(z.string()),
    counselNotes: z.string().optional(),
    documentUrl: z.string().optional(),
  }))
  .states(received, redlined, returned, executed, rejected, declined, failed);

const counselDecision = z.object({
  verdict: z.enum(['approve', 'return']),
  notes: z.string().optional(),
});
type CounselDecision = z.infer<typeof counselDecision>;

const counselAbout = z.object({ category, amountUsd: z.number() });
type CounselAbout = z.infer<typeof counselAbout>;

const counsel = H.halt('counsel', counselDecision)
  .about(counselAbout)
  .policy(H.policy.rule('skip-counsel-for-proven-categories', skipCounsel));

function skipCounsel(about: CounselAbout, metrics: Metrics): CounselDecision | null {
  const record = metrics.rate({
    among: { ...counsel.resolved(), resolver: 'human', tags: { category: about.category } },
    count: { ...counsel.resolved({ verdict: 'approve' }), resolver: 'human', tags: { category: about.category } },
  });
  return record.hits >= 200 && record.hits === record.samples ? { verdict: 'approve' } : null;
}

const signoff = H.halt('signoff', z.object({ verdict: z.enum(['approve', 'reject']) }))
  .about(z.object({ amountUsd: z.number() }))
  .timeout({ minutes: 30 }, about => ({ verdict: about.amountUsd < 500 ? 'approve' : 'reject' }));

const local = shell.local('contracts-local', { slots: 2 });

const drafterRole = H.role('contract-drafter')
  .input(z.object({
    title: z.string(),
    terms: z.string(),
    redlines: z.array(z.string()),
    counselNotes: z.string(),
  }))
  .output(z.object({ documentUrl: z.string() }))
  .prompt(input => `Draft the contract "${input.title}" on these terms:\n${input.terms}\nApply the counterparty redlines:\n${input.redlines.join('\n')}\nAddress counsel's notes:\n${input.counselNotes}`);

const drafter = H.agent('drafter', drafterRole).model(anthropic.model('claude-opus-4'));

const executeContract = H.command('execute-contract')
  .input(z.object({ contractId: z.string(), documentUrl: z.string() }))
  .argv(input => ['contracts', 'execute', '--id', input.contractId, '--document', input.documentUrl])
  .on(local)
  .recovery('park');

const pageDeputy = H.command('page-finance-deputy')
  .input(z.object({ unit: z.string(), amountUsd: z.number() }))
  .argv(input => ['pager', 'send', '--team', 'finance-deputy', '--contract', input.unit, '--amount', String(input.amountUsd)])
  .on(local);

const contractFlow = H.flow('contract').for(Contract).does(async ctx => {
  const data = ctx.unit.data;
  const draft = await ctx.run(drafter, {
    title: data.title,
    terms: data.terms,
    redlines: data.redlines,
    counselNotes: data.counselNotes ?? '',
  });
  if (!draft.ok) return ctx.fail(draft.error);
  await ctx.update({ documentUrl: draft.value.documentUrl });
  ctx.tag({ category: data.category });

  const review = await ctx.halt(counsel, `Review "${data.title}": ${draft.value.documentUrl}`, {
    category: data.category,
    amountUsd: data.amountUsd,
  });
  if (review.verdict === 'return') {
    await ctx.update({ counselNotes: review.notes });
    return 'returned';
  }

  const approval = await ctx.halt(signoff, `Sign off "${data.title}" for $${data.amountUsd}`, { amountUsd: data.amountUsd });
  if (approval.verdict === 'reject') return 'rejected';

  const done = await ctx.run(executeContract, { contractId: ctx.unit.key, documentUrl: draft.value.documentUrl });
  if (!done.ok) return ctx.fail(done.error);
  return 'executed';
});

const contractEvent = z.discriminatedUnion('event', [
  z.object({
    event: z.literal('created'),
    contractId: z.string(),
    title: z.string(),
    category,
    amountUsd: z.number(),
    terms: z.string(),
  }),
  z.object({
    event: z.literal('redline'),
    contractId: z.string(),
    redlines: z.array(z.string()),
  }),
]);

function contractWebhook(region: 'eu' | 'us') {
  return http.webhook(Contract, {
    path: `/contracts/${region}`,
    secret: H.env('DOCUMENTS_WEBHOOK_SECRET'),
    body: contractEvent,
    read: body => body.event === 'created'
      ? {
          create: {
            title: body.title,
            category: body.category,
            amountUsd: body.amountUsd,
            terms: body.terms,
            redlines: [],
          },
          key: body.contractId,
        }
      : { update: body.contractId, patch: { redlines: body.redlines }, state: 'redlined', deferred: true },
  });
}

const documents = http.store(Contract, {
  url: 'https://documents.example.com/api/contracts',
  headers: { Authorization: H.env('DOCUMENTS_TOKEN') },
  stateField: 'status',
});

const euRetry = H.policy.retry('eu-three-with-backoff', view =>
  view.failures <= 3 ? { retryInMs: 60_000 * 2 ** (view.failures - 1) } : 'stop');
const usRetry = H.policy.retry('us-once', view =>
  view.failures <= 1 ? { retryInMs: 60_000 } : 'stop');

const contractsEu = H.lane('contracts-eu', Contract)
  .handler(contractFlow)
  .suppliers(contractWebhook('eu'), H.operator)
  .store(documents)
  .wip(3)
  .retry(euRetry, 'failed');

const contractsUs = H.lane('contracts-us', Contract)
  .handler(contractFlow)
  .suppliers(contractWebhook('us'), H.operator)
  .store(documents)
  .wip(3)
  .retry(usRetry, 'failed');

const declineOnSecondReturn = H.trigger(
  'decline-on-second-return',
  H.on.enters(Contract, 'returned', { times: 2 }),
  (_, act) => act.move('declined'),
);

const pageDeputyOnSlowSignoff = H.trigger(
  'page-deputy-on-slow-signoff',
  H.on.halted(signoff, { minutes: 20 }),
  (event, act) => act.run(pageDeputy, { unit: event.unit, amountUsd: event.about.amountUsd }),
);

const oldestFirst = H.policy.scheduler('oldest-first', view => ({
  start: [...view.pending].sort((a, b) => b.waitedMs - a.waitedMs),
}));

const pool = H.pool('contracts-api', [
  { account: anthropic.account('contracts-api', { apiKey: H.env('ANTHROPIC_API_KEY') }), share: 1 },
]);

const counselDashboard = http.control({
  port: 8441,
  token: H.env('COUNSEL_DASHBOARD_TOKEN'),
  grants: [H.ops.readWork, H.ops.resolve(counsel)],
});

const financeSupervisor = claudeCode.supervisor({
  grants: [H.ops.readWork, H.ops.resolve(signoff)],
});

const auditorDashboard = http.control({
  port: 8442,
  token: H.env('AUDITOR_DASHBOARD_TOKEN'),
  grants: [H.ops.readWork, H.ops.readTelemetry],
});

export function contractTelemetry(metrics: Metrics, since: Date) {
  return {
    counselByHuman: metrics.median({ of: 'decisionMs', among: { ...counsel.resolved(), resolver: 'human' }, since }),
    counselByPolicy: metrics.median({ of: 'decisionMs', among: { ...counsel.resolved(), resolver: 'policy' }, since }),
    signoffByHuman: metrics.median({ of: 'decisionMs', among: { ...signoff.resolved(), resolver: 'human' }, since }),
    signoffByClock: metrics.median({ of: 'decisionMs', among: { ...signoff.resolved(), resolver: 'clock' }, since }),
    retriesEu: metrics.count({ of: { entry: 'attempt', status: 'retrying', lane: contractsEu }, since }),
    retriesUs: metrics.count({ of: { entry: 'attempt', status: 'retrying', lane: contractsUs }, since }),
    signoffTimeoutShare: metrics.rate({
      among: signoff.resolved(),
      count: { ...signoff.resolved(), resolver: 'clock' },
      since,
    }),
  };
}

export const contracts = H.harness('contracts')
  .ledger(sqlite.ledger('contracts.db'))
  .lanes(contractsEu, contractsUs)
  .pools(pool)
  .triggers(declineOnSecondReturn, pageDeputyOnSlowSignoff)
  .scheduler(oldestFirst)
  .clients(counselDashboard, financeSupervisor, auditorDashboard)
  .observers(markdown.board('board.md'), markdown.telemetry('telemetry.md'));
