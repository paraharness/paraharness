import { z } from 'zod';
import { H, type Halt } from 'harness-dsl';
import { claudeCode } from 'harness-dsl/claude-code';
import { anthropic } from 'harness-dsl/anthropic';
import { sqlite } from 'harness-dsl/sqlite';
import { http } from 'harness-dsl/http';
import { supply } from 'harness-dsl/supply';
import { policies } from 'harness-dsl/policies';
import { observers } from 'harness-dsl/observers';

const docsUrl = H.env('DOCUMENT_SYSTEM_URL');
const docsToken = H.env('DOCUMENT_SYSTEM_TOKEN');
const local = H.runner.local('worker', { slots: 4 });

const apiAccount = H.account('anthropic-api', anthropic.api({ apiKey: H.env('ANTHROPIC_API_KEY') }));
const opus = H.model('claude-opus-4-1').pricing(anthropic.pricing());
const pool = H.pool('api', [apiAccount]).serves(opus).policy(policies.soonestExpiring());

const contractCategory = H.facet('contract-category');

const received = H.state('received').pending();
const drafting = H.state('drafting').active();
const executed = H.state('executed').terminal('success');
const declined = H.state('declined').terminal('failure');
const rejectedByFinance = H.state('rejected-by-finance').terminal('failure');
const draftingFailed = H.state('drafting-failed').terminal('failure');

const contractSchema = z.object({
  contractId: z.string(),
  counterparty: z.string(),
  category: z.string(),
  amountUsd: z.number(),
  terms: z.string(),
  redlines: z.array(z.string()),
});
const contract = H.work('contract')
  .schema(contractSchema)
  .states(received, drafting, executed, declined, rejectedByFinance, draftingFailed);

const drafterRole = H.role('contract-drafter').prompt('Draft the contract, applying every counterparty redline.');
const draftContract = H.skill('draft-contract')
  .input(contractSchema)
  .output(z.object({ document: z.string() }))
  .prompt(i => `Contract with ${i.counterparty} for $${i.amountUsd}.\nTerms: ${i.terms}\nRedlines:\n${i.redlines.join('\n')}`);
const drafter = H.seat('contract-drafter').role(drafterRole).models(opus);

const counselDecision = z.object({ verdict: z.enum(['approve', 'return']), notes: z.string() });

const counsel = H.halt('counsel')
  .context(z.object({ contractId: z.string(), category: z.string(), document: z.string() }))
  .ask(c => `Review contract ${c.contractId} (${c.category}).`)
  .decision(counselDecision);

const signoff = H.halt('signoff')
  .context(z.object({ contractId: z.string(), amountUsd: z.number(), document: z.string() }))
  .ask(c => `Sign off contract ${c.contractId} for $${c.amountUsd}?`)
  .decision(z.object({ approve: z.boolean(), note: z.string() }));

const executeContract = H.command('execute-contract')
  .input(z.object({ contractId: z.string(), document: z.string() }))
  .output(z.object({ executionId: z.string() }))
  .runner(local)
  .effect('unrepeatable')
  .detect(async (i, ctx) => {
    const response = await fetch(`${ctx.resolve(docsUrl)}/contracts/${i.contractId}/execution`, {
      headers: { authorization: `Bearer ${ctx.resolve(docsToken)}` },
    });
    if (!response.ok) return undefined;
    return z.object({ executionId: z.string() }).parse(await response.json());
  })
  .run(async (i, ctx) => {
    const response = await fetch(`${ctx.resolve(docsUrl)}/contracts/${i.contractId}/execution`, {
      method: 'POST',
      headers: { authorization: `Bearer ${ctx.resolve(docsToken)}` },
      body: JSON.stringify({ document: i.document }),
    });
    return z.object({ executionId: z.string() }).parse(await response.json());
  });

const pageDeputy = H.command('page-finance-deputy')
  .input(z.object({ contractId: z.string(), address: z.string() }))
  .runner(local)
  .run(async (i, ctx) => {
    const result = await ctx.sh(`pager notify finance-deputy "signoff pending for ${i.contractId} at ${i.address}"`);
    if (result.code !== 0) throw new Error(result.stderr);
  });

const contractFlow = H.flow('contract')
  .input(contractSchema)
  .step('draft', drafter.call(draftContract))
  .halt('counsel', counsel, s => ({ contractId: s.input.contractId, category: s.input.category, document: s.steps.draft.document }))
  .when(s => s.steps.counsel.verdict === 'return', f => f.exit('returned'))
  .halt('signoff', signoff, s => ({ contractId: s.input.contractId, amountUsd: s.input.amountUsd, document: s.steps.draft.document }))
  .when(s => !s.steps.signoff.approve, f => f.exit('rejected'))
  .step('execute', executeContract, s => ({ contractId: s.input.contractId, document: s.steps.draft.document }))
  .exit('executed');

const documentStore = http.store({
  load: async (unit, ctx) => {
    const response = await fetch(`${ctx.resolve(docsUrl)}/contracts/${unit.key}`, {
      headers: { authorization: `Bearer ${ctx.resolve(docsToken)}` },
    });
    if (!response.ok) return undefined;
    const stored = contractSchema.extend({ harnessState: z.string() }).parse(await response.json());
    return { data: stored, state: stored.harnessState };
  },
  save: async (unit, change, ctx) => {
    await fetch(`${ctx.resolve(docsUrl)}/contracts/${unit.key}/harness`, {
      method: 'PUT',
      headers: { authorization: `Bearer ${ctx.resolve(docsToken)}` },
      body: JSON.stringify(change),
    });
  },
});

const contractWebhook = (region: string) =>
  http
    .webhook({ path: `/contracts/${region}`, schema: contractSchema, secret: H.env('DOCUMENT_SYSTEM_WEBHOOK_SECRET') })
    .key(d => d.contractId);

const contractExits = {
  returned: { to: received, maxTimes: 1, then: declined },
  rejected: rejectedByFinance,
  executed,
};

const contractsEu = H.lane('contracts-eu')
  .of(contract)
  .from(contractWebhook('eu'), supply.manual(contractSchema).key(d => d.contractId))
  .store(documentStore)
  .facet(contractCategory, d => d.category)
  .wip(3)
  .handle(contractFlow, {
    exits: contractExits,
    retry: { tries: 3, backoff: 'exponential', delaySeconds: 60, exhausted: draftingFailed },
  });

const contractsUs = H.lane('contracts-us')
  .of(contract)
  .from(contractWebhook('us'), supply.manual(contractSchema).key(d => d.contractId))
  .store(documentStore)
  .facet(contractCategory, d => d.category)
  .wip(3)
  .handle(contractFlow, {
    exits: contractExits,
    retry: { tries: 1, backoff: 'none', exhausted: draftingFailed },
  });

const counselApprovals = H.metric('counsel-human-approvals').count(
  H.events.decisions(counsel, { match: d => d.verdict === 'approve', resolver: 'human' }),
);
const counselReturns = H.metric('counsel-human-returns').count(
  H.events.decisions(counsel, { match: d => d.verdict === 'return', resolver: 'human' }),
);

const counselSkip = H.policy.halt(
  'counsel-skip-proven-category',
  counsel,
  ({ context, metrics }): z.output<typeof counselDecision> | undefined => {
    const where = { facet: { facet: contractCategory, value: context.category } };
    const approved = metrics.read(counselApprovals, { where });
    const returned = metrics.read(counselReturns, { where });
    return (approved.value ?? 0) >= 200 && (returned.value ?? 0) === 0
      ? { verdict: 'approve', notes: `skipped: ${approved.samples} approvals, ${returned.samples} returns` }
      : undefined;
  },
);

const skipProvenCounsel = H.trigger('skip-proven-counsel').on(H.opened(counsel)).do(H.resolve(counsel, counselSkip));

const pageDeputyAt20m = H.trigger('page-deputy-at-20m')
  .on(H.opened(signoff).after('20m'))
  .do(H.run(pageDeputy, p => ({ contractId: p.context.contractId, address: p.address })));

const signoffTimeout = H.trigger('signoff-timeout')
  .on(H.opened(signoff).after('30m'))
  .do(
    H.resolve(signoff, p =>
      p.context.amountUsd < 500
        ? { approve: true, note: 'approved by timeout under $500' }
        : { approve: false, note: 'rejected by timeout at or over $500' },
    ),
  );

const decisionTime = <C, D>(halt: Halt<C, D>, resolver: 'human' | 'policy' | 'clock') =>
  H.metric(`${halt.name}-${resolver}-decision-seconds`).median(H.events.decisions(halt, { resolver }), 'waitSeconds');

const counselHumanTime = decisionTime(counsel, 'human');
const counselPolicyTime = decisionTime(counsel, 'policy');
const signoffHumanTime = decisionTime(signoff, 'human');
const signoffClockTime = decisionTime(signoff, 'clock');
const failedAttempts = H.metric('failed-attempts').count(H.events.attempts({ outcome: 'failed' }));
const signoffTimeoutShare = H.metric('signoff-timeout-share').rate(
  H.events.decisions(signoff, { resolver: 'clock' }),
  H.events.decisions(signoff),
);

const longestWaiting = H.policy.schedule('longest-waiting', ({ candidates }) =>
  [...candidates].sort((a, b) => Number(b.resuming) - Number(a.resuming) || b.waitingSeconds - a.waitingSeconds),
);

export default H.harness('contracts')
  .ledger(sqlite.ledger('.harness/ledger.db'))
  .pools(pool)
  .lanes(contractsEu, contractsUs)
  .triggers(skipProvenCounsel, pageDeputyAt20m, signoffTimeout)
  .schedule(longestWaiting)
  .grants(
    H.grant(http.client('counsel-dashboard', { port: 8443, token: H.env('COUNSEL_DASHBOARD_TOKEN') }), H.ops.resolve(counsel)),
    H.grant(claudeCode.client('finance-supervisor'), H.ops.resolve(signoff)),
    H.grant(claudeCode.client('finance-deputy-supervisor'), H.ops.resolve(signoff)),
    H.grant(http.client('decision-auditor', { port: 8444, token: H.env('AUDITOR_TOKEN') }), H.ops.work.read, H.ops.telemetry.read),
    H.grant(http.client('contracts-operator', { port: 8445, token: H.env('OPERATOR_TOKEN') }), H.ops.work.read, H.ops.work.write),
  )
  .metrics(
    counselApprovals,
    counselReturns,
    counselHumanTime,
    counselPolicyTime,
    signoffHumanTime,
    signoffClockTime,
    failedAttempts,
    signoffTimeoutShare,
  )
  .observe(observers.board({ path: '.harness/board.md' }), observers.telemetry({ path: '.harness/telemetry.md' }));
