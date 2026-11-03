import { z } from 'zod';
import { H, type Halt } from 'harness-dsl';
import type { ResolveContext, ResolverSort } from 'harness-dsl/kernel';
import { claudeCode } from 'harness-dsl/claude-code';
import { anthropic } from 'harness-dsl/anthropic';
import { sqlite } from 'harness-dsl/sqlite';
import { http } from 'harness-dsl/http';
import { supply } from 'harness-dsl/supply';
import { observers } from 'harness-dsl/observers';

const docsUrl = H.env('DOCUMENT_SYSTEM_URL');
const docsToken = H.env('DOCUMENT_SYSTEM_TOKEN');

const documents = (ctx: ResolveContext, path: string, init?: { readonly method: string; readonly body: string }) =>
  fetch(`${ctx.resolve(docsUrl)}${path}`, {
    method: init?.method ?? 'GET',
    body: init?.body,
    headers: { authorization: `Bearer ${ctx.resolve(docsToken)}`, 'content-type': 'application/json' },
  });

const local = H.runner.local('local', { slots: 4 });
const api = H.account('anthropic-api', anthropic.api({ apiKey: H.env('ANTHROPIC_API_KEY') }));
const sonnet = H.model('claude-sonnet-4-5').pricing(anthropic.pricing());

const contractSchema = z.object({
  contractId: z.string(),
  counterparty: z.string(),
  category: z.enum(['nda', 'supply', 'services', 'licence']),
  amountUsd: z.number(),
  redline: z.string(),
});
type ContractData = z.infer<typeof contractSchema>;

const received = H.state('received').pending();
const inProgress = H.state('in-progress').active();
const executed = H.state('executed').terminal('success');
const declined = H.state('declined').terminal('failure');
const rejected = H.state('rejected').terminal('failure');
const abandoned = H.state('abandoned').terminal('failure');
const contract = H.work('contract').schema(contractSchema).states(received, inProgress, executed, declined, rejected, abandoned);

const contractCategory = H.facet('contract-category');

const drafterRole = H.role('contract-drafter').promptFile('./prompts/contract-drafter.md').intents(['read']);
const drafter = H.seat('contract-drafter').role(drafterRole).models(sonnet);

const draftContract = H.skill('draft-contract')
  .input(z.object({ counterparty: z.string(), category: z.string(), amountUsd: z.number(), redline: z.string() }))
  .output(z.object({ documentText: z.string(), summary: z.string() }))
  .prompt(i => `Draft a ${i.category} contract with ${i.counterparty} for $${i.amountUsd}.\n\nLatest redline:\n${i.redline}`);

const counselDecision = z.object({ verdict: z.enum(['approve', 'return']), notes: z.string().optional() });
type CounselDecision = z.infer<typeof counselDecision>;

const counsel = H.halt('counsel')
  .context(z.object({ contractId: z.string(), category: z.string(), summary: z.string() }))
  .ask(c => `Review contract ${c.contractId} (${c.category}):\n${c.summary}`)
  .decision(counselDecision);

const signoff = H.halt('signoff')
  .context(z.object({ contractId: z.string(), amountUsd: z.number() }))
  .ask(c => `Sign off contract ${c.contractId} for $${c.amountUsd}?`)
  .decision(z.object({ approved: z.boolean() }));

const executeContract = H.command('execute-contract')
  .input(z.object({ contractId: z.string(), documentText: z.string() }))
  .runner(local)
  .effect('unrepeatable')
  .run(async (input, ctx) => {
    const res = await documents(ctx, `/contracts/${input.contractId}/execute`, { method: 'POST', body: JSON.stringify({ text: input.documentText }) });
    if (res.ok) return;
    throw new Error(`execution refused: ${res.status}`);
  });

const pageDeputy = H.command('page-finance-deputy')
  .input(z.object({ contractId: z.string() }))
  .runner(local)
  .run(async (input, ctx) => {
    const result = await ctx.sh(`./scripts/page.sh finance-deputy "signoff waiting on ${input.contractId}"`);
    if (result.code === 0) return;
    throw new Error(result.stderr);
  });

const contractFlow = H.flow('contract')
  .input(contractSchema)
  .step('draft', drafter.call(draftContract), s => ({
    counterparty: s.input.counterparty, category: s.input.category, amountUsd: s.input.amountUsd, redline: s.input.redline,
  }))
  .halt('counsel', counsel, s => ({ contractId: s.input.contractId, category: s.input.category, summary: s.steps.draft.summary }))
  .when(s => s.steps.counsel.verdict === 'return', f => f.exit('returned'))
  .halt('signoff', signoff, s => ({ contractId: s.input.contractId, amountUsd: s.input.amountUsd }))
  .when(s => s.steps.signoff.approved === false, f => f.exit('rejected'))
  .step('execute', executeContract, s => ({ contractId: s.input.contractId, documentText: s.steps.draft.documentText }))
  .exit('executed');

const documentRecord = z.object({ state: z.string(), contract: contractSchema });
const documentStore = http.store({
  load: async (unit, ctx) => {
    const res = await documents(ctx, `/contracts/${unit.key}`);
    if (res.status === 404) return undefined;
    const record = documentRecord.parse(await res.json());
    return { data: record.contract, state: record.state };
  },
  save: async (unit, change, ctx) => {
    await documents(ctx, `/contracts/${unit.key}/harness-state`, { method: 'PUT', body: JSON.stringify(change) });
  },
});

const contractLane = (name: string, region: string, retry: { readonly tries: number; readonly backoff: 'none' | 'exponential' }) =>
  H.lane(name)
    .of(contract)
    .from(
      http.webhook({ path: `/contracts/${region}`, schema: contractSchema, secret: H.env('DOCUMENT_WEBHOOK_SECRET') }).key(d => d.contractId),
      supply.manual<ContractData>().key(d => d.contractId),
    )
    .store(documentStore)
    .handle(contractFlow)
    .exits({
      returned: { to: received, maxTimes: 1, then: declined },
      rejected,
      executed,
      failed: { tries: retry.tries, backoff: retry.backoff, delaySeconds: 120, then: abandoned },
    })
    .facet(contractCategory, d => d.category)
    .wip(3);

const contractsEu = contractLane('contracts-eu', 'eu', { tries: 4, backoff: 'exponential' });
const contractsUs = contractLane('contracts-us', 'us', { tries: 2, backoff: 'none' });

const counselApprovalRate = H.metric('counsel-approval-rate').rate(
  H.events.decisions(counsel, { match: d => d.verdict === 'approve', resolver: 'human' }),
  H.events.decisions(counsel, { resolver: 'human' }),
);

const skipCounsel = H.policy.halt('skip-counsel-for-proven-category', counsel, (input): CounselDecision | undefined => {
  const reading = input.metrics.read(counselApprovalRate, {
    where: { facet: { facet: contractCategory, value: input.context.category } },
  });
  return reading.samples >= 200 && reading.value === 1 ? { verdict: 'approve' } : undefined;
});

const counselSkip = H.trigger('counsel-skip-by-policy').on(counsel.opened()).do(H.ops.resolve(counsel).by(skipCounsel));

const signoffDeputy = H.trigger('signoff-page-deputy')
  .on(signoff.opened().after('20m'))
  .do(pageDeputy.with(p => ({ contractId: p.context.contractId })));

const signoffTimeout = H.trigger('signoff-timeout')
  .on(signoff.opened().after('30m'))
  .do(H.ops.resolve(signoff).with(p => ({ approved: p.context.amountUsd < 500 })));

const decisionWait = <C, D>(name: string, halt: Halt<C, D>, resolver: ResolverSort) =>
  H.metric(name).median(H.events.decisions(halt, { resolver }), 'waitSeconds');

const counselWaitHuman = decisionWait('counsel-wait-human', counsel, 'human');
const counselWaitPolicy = decisionWait('counsel-wait-policy', counsel, 'policy');
const signoffWaitHuman = decisionWait('signoff-wait-human', signoff, 'human');
const signoffWaitClock = decisionWait('signoff-wait-clock', signoff, 'clock');
const failedAttempts = H.metric('failed-attempts').count(H.events.attempts({ outcome: 'failed' }));
const signoffTimeoutShare = H.metric('signoff-timeout-share').rate(
  H.events.decisions(signoff, { resolver: 'clock' }),
  H.events.decisions(signoff),
);

const counselDashboard = http.client('counsel-dashboard', { port: 8750, token: H.env('COUNSEL_TOKEN') });
const finance = claudeCode.client('finance', { session: 'finance' });
const financeDeputy = claudeCode.client('finance-deputy', { session: 'finance-deputy' });
const decisionAuditor = http.client('decision-auditor', { port: 8751, token: H.env('AUDITOR_TOKEN') });
const supervisor = claudeCode.client('contracts-supervisor', { session: 'contracts' });

export const harness = H.harness('contracts')
  .ledger(sqlite.ledger('./contracts/.harness/ledger.sqlite'))
  .pools(H.pool('api', [api]).serves(sonnet))
  .lanes(contractsEu, contractsUs)
  .triggers(counselSkip, signoffDeputy, signoffTimeout)
  .scheduler(H.scheduler().policy(H.policy.schedule('oldest-first', input =>
    [...input.candidates].sort((a, b) => b.waitingSeconds - a.waitingSeconds))))
  .grants(
    H.grant(counselDashboard, H.ops.resolve(counsel)),
    H.grant(finance, H.ops.resolve(signoff)),
    H.grant(financeDeputy, H.ops.resolve(signoff)),
    H.grant(decisionAuditor, H.ops.work.read, H.ops.telemetry.read),
    H.grant(supervisor, H.ops.work.read, H.ops.work.write, H.ops.telemetry.read),
  )
  .metrics(counselApprovalRate, counselWaitHuman, counselWaitPolicy, signoffWaitHuman, signoffWaitClock, failedAttempts, signoffTimeoutShare)
  .observe(observers.board({ path: './contracts/BOARD.md' }), observers.telemetry({ path: './contracts/TELEMETRY.md' }));
