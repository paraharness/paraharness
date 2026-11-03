import { z } from 'zod';
import { H } from 'harness-dsl';
import type { Halt, HaltRef, Metrics } from 'harness-dsl';
import * as anthropic from 'harness-dsl/anthropic';
import * as claude from 'harness-dsl/claude-code';
import * as http from 'harness-dsl/http';
import * as sqlite from 'harness-dsl/sqlite';
import * as shell from 'harness-dsl/shell';
import * as markdown from 'harness-dsl/markdown';

const apiAccount = anthropic.account('anthropic-api', { apiKey: H.env('ANTHROPIC_API_KEY') });
const sonnet = anthropic.model('claude-sonnet-4');
const pool = H.pool('accounts', [{ account: apiAccount, share: 1 }]);
const localRunner = shell.local('local', { slots: 4 });

const categories = z.enum(['nda', 'msa', 'order-form', 'licence']);
const category = H.facet('contract-category', categories);

const contract = H.kind('contract')
  .data(
    z.object({
      title: z.string(),
      counterparty: z.string(),
      category: categories,
      valueUsd: z.number(),
      redlines: z.array(z.string()),
      draftUrl: z.string().optional(),
      counselNotes: z.string().optional(),
    })
  )
  .states(
    H.state('received', 'pending'),
    H.state('returned', 'pending'),
    H.state('executed', 'terminal', 'success'),
    H.state('rejected', 'terminal', 'neutral'),
    H.state('declined', 'terminal', 'failure'),
    H.state('stalled', 'terminal', 'failure')
  );

const drafterRole = H.role('contract-drafter')
  .input(
    z.object({
      title: z.string(),
      counterparty: z.string(),
      redlines: z.array(z.string()),
      counselNotes: z.string().optional(),
    })
  )
  .output(z.object({ draftUrl: z.string(), summary: z.string() }))
  .prompt(
    input =>
      `Draft "${input.title}" with ${input.counterparty}.\nRedlines:\n${input.redlines.join('\n')}\nCounsel notes: ${input.counselNotes ?? 'none'}`
  );
const drafter = H.seat('contract-drafter', drafterRole).model(sonnet);

const counselDecision = z.object({ verdict: z.enum(['approve', 'return']), notes: z.string() });
const counselAbout = z.object({ category: categories, title: z.string() });
type CounselDecision = z.infer<typeof counselDecision>;
type CounselAbout = z.infer<typeof counselAbout>;

const skipCounsel = H.policy.rule(
  'skip-counsel-for-proven-categories',
  (about: CounselAbout, metrics: Metrics): CounselDecision | null => {
    const history = metrics.rate({
      among: { entry: 'halt', halt: counsel, status: 'resolved', resolver: 'human', facets: [category.of(about.category)] },
      count: { ...counsel.resolved({ verdict: 'approve' }), resolver: 'human', facets: [category.of(about.category)] },
    });
    return history.samples >= 200 && history.hits === history.samples
      ? { verdict: 'approve', notes: `skipped: ${history.hits} of ${history.samples} approved` }
      : null;
  }
);

const counsel: Halt<CounselDecision, CounselAbout> = H.halt('counsel', counselDecision).about(counselAbout).policy(skipCounsel);

const signoff = H.halt('signoff', z.object({ approve: z.boolean(), note: z.string().optional() }))
  .about(z.object({ title: z.string(), valueUsd: z.number() }))
  .timeout({ minutes: 30 }, about => ({ approve: about.valueUsd < 500, note: 'resolved by timeout' }));

const execute = H.command('execute-contract')
  .input(z.object({ contract: z.string(), draftUrl: z.string() }))
  .argv(input => ['./contracts/execute.sh', input.contract, input.draftUrl])
  .on(localRunner)
  .recovery('park');

const pageDeputy = H.command('page-finance-deputy')
  .input(z.object({ contract: z.string(), title: z.string() }))
  .argv(input => ['./contracts/page-deputy.sh', input.contract, input.title])
  .on(localRunner);

const handleContract = H.flow('handle-contract')
  .for(contract)
  .does(async ctx => {
    const draft = await ctx.run(drafter, {
      title: ctx.unit.data.title,
      counterparty: ctx.unit.data.counterparty,
      redlines: ctx.unit.data.redlines,
      counselNotes: ctx.unit.data.counselNotes,
    });
    if (!draft.ok) return ctx.fail(draft.error);
    await ctx.update({ draftUrl: draft.value.draftUrl });
    const review = await ctx.halt(counsel, `Draft ${draft.value.draftUrl}: ${draft.value.summary}`, {
      category: ctx.unit.data.category,
      title: ctx.unit.data.title,
    });
    if (review.verdict === 'return') {
      await ctx.update({ counselNotes: review.notes });
      return 'returned';
    }
    const approval = await ctx.halt(signoff, `Sign off "${ctx.unit.data.title}" for $${ctx.unit.data.valueUsd}`, {
      title: ctx.unit.data.title,
      valueUsd: ctx.unit.data.valueUsd,
    });
    if (!approval.approve) return 'rejected';
    const executed = await ctx.run(execute, { contract: ctx.unit.key, draftUrl: draft.value.draftUrl });
    return executed.ok ? 'executed' : ctx.fail(executed.error);
  });

const contractEvent = z.object({
  event: z.enum(['new', 'redline']),
  contractId: z.string(),
  title: z.string(),
  counterparty: z.string(),
  category: categories,
  valueUsd: z.number(),
  redlines: z.array(z.string()),
});

const contractHook = (region: string) =>
  http.webhook(contract, {
    path: `/contracts/${region}`,
    secret: H.env(`CONTRACTS_${region.toUpperCase()}_SECRET`),
    body: contractEvent,
    read: body =>
      body.event === 'new'
        ? {
            create: {
              title: body.title,
              counterparty: body.counterparty,
              category: body.category,
              valueUsd: body.valueUsd,
              redlines: body.redlines,
            },
            key: body.contractId,
          }
        : {
            update: body.contractId,
            patch: { redlines: body.redlines },
            state: 'received',
            whileRunning: 'defer',
            whileWaiting: 'cancel',
          },
  });

const documentStore = http.store(contract, {
  url: 'https://documents.example.com/api/contracts',
  headers: { authorization: H.env('DOCUMENTS_TOKEN') },
  stateField: 'workflow_state',
});

const contractsEu = H.lane('contracts-eu', contract)
  .handler(handleContract)
  .retries(3, { backoff: { first: { minutes: 5 }, factor: 2 }, exhausted: 'stalled' })
  .suppliers(contractHook('eu'), H.operator)
  .store(documentStore)
  .wip(3)
  .reentries('returned', { max: 2, then: 'declined' })
  .facet(category, data => data.category);

const contractsUs = H.lane('contracts-us', contract)
  .handler(handleContract)
  .retries(1, { exhausted: 'stalled' })
  .suppliers(contractHook('us'), H.operator)
  .store(documentStore)
  .wip(3)
  .reentries('returned', { max: 2, then: 'declined' })
  .facet(category, data => data.category);

const deputyPage = H.trigger('page-finance-deputy', H.on.halted(signoff, { minutes: 20 }), (event, act) =>
  act.run(pageDeputy, { contract: event.unit, title: event.about.title })
);

const counselDashboard = http.control('counsel-dashboard', {
  port: 8443,
  token: H.env('COUNSEL_DASHBOARD_TOKEN'),
  grants: [H.ops.resolve(counsel)],
});
const finance = claude.supervisor('finance', { grants: [H.ops.resolve(signoff)] });
const financeDeputy = claude.supervisor('finance-deputy', { grants: [H.ops.resolve(signoff)] });
const decisionAuditor = http.control('decision-auditor', {
  port: 8444,
  token: H.env('AUDITOR_TOKEN'),
  grants: [H.ops.readWork, H.ops.readTelemetry],
});
const operations = claude.supervisor('contracts-operations', {
  grants: [
    H.ops.readWork,
    H.ops.writeWork,
    H.ops.resolve(H.halts.interrupted, H.halts.definitionChanged, H.halts.costCeiling),
    H.ops.readTelemetry,
  ],
});

export const contractReport = H.policy.rule('contract-report', (input: { readonly since: Date }, metrics: Metrics) => {
  const decisionTime = (halt: HaltRef, resolver: 'human' | 'policy' | 'clock') =>
    metrics.median({ of: 'decisionMs', among: { entry: 'halt', halt, status: 'resolved', resolver }, since: input.since });
  const clientTime = (client: { readonly name: string }) =>
    metrics.median({ of: 'decisionMs', among: { entry: 'halt', halt: signoff, status: 'resolved', client }, since: input.since });
  return {
    counselByHuman: decisionTime(counsel, 'human'),
    counselByPolicy: decisionTime(counsel, 'policy'),
    signoffByHuman: decisionTime(signoff, 'human'),
    signoffByClock: decisionTime(signoff, 'clock'),
    signoffByFinance: clientTime(finance),
    signoffByDeputy: clientTime(financeDeputy),
    retriesEu: metrics.count({ of: { entry: 'attempt', status: 'retrying', lane: contractsEu }, since: input.since }),
    retriesUs: metrics.count({ of: { entry: 'attempt', status: 'retrying', lane: contractsUs }, since: input.since }),
    signoffTimeoutShare: metrics.rate({
      among: { entry: 'halt', halt: signoff, status: 'resolved' },
      count: { entry: 'halt', halt: signoff, status: 'resolved', resolver: 'clock' },
      since: input.since,
    }),
  };
});

export const contracts = H.harness('contracts')
  .ledger(sqlite.ledger('.harness/ledger.sqlite'))
  .lanes(contractsEu, contractsUs)
  .pools(pool)
  .triggers(deputyPage)
  .scheduler(H.policy.scheduler('oldest-first', view => ({ start: [...view.pending].sort((a, b) => b.waitedMs - a.waitedMs) })))
  .clients(counselDashboard, finance, financeDeputy, decisionAuditor, operations)
  .observers(markdown.board('.harness/board.md'), markdown.telemetry('.harness/telemetry.md'));
