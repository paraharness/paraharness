import { z } from 'zod';
import { H } from 'harness-dsl';
import { anthropic } from 'harness-dsl/anthropic';
import { claudeCode } from 'harness-dsl/claude-code';
import { sqlite } from 'harness-dsl/sqlite';
import { http } from 'harness-dsl/http';
import { supply } from 'harness-dsl/supply';
import { policies } from 'harness-dsl/policies';
import { observers } from 'harness-dsl/observers';

const apiAccount = H.account('anthropic-api', anthropic.api({ apiKey: H.env('ANTHROPIC_API_KEY') }));
const opus = H.model('claude-opus-4-1').pricing(anthropic.pricing());
const apiPool = H.pool('api', [apiAccount]).serves(opus).policy(policies.soonestExpiring());

const category = H.facet('contract-category');

const received = H.state('received').pending();
const drafting = H.state('drafting').active();
const executed = H.state('executed').terminal('success');
const declined = H.state('declined').terminal('failure');
const rejectedByFinance = H.state('rejected-by-finance').terminal('failure');
const failed = H.state('failed').terminal('failure');
const withdrawn = H.state('withdrawn').terminal('neutral');

const contractSchema = z.object({
  contractId: z.string(),
  counterparty: z.string(),
  category: z.string(),
  amountUsd: z.number(),
  redline: z.string(),
});
const contractKind = H.work('Contract').schema(contractSchema).states(received, drafting, executed, declined, rejectedByFinance, failed, withdrawn);

const documentsUrl = H.env('DOCUMENTS_URL');
const documentsToken = H.env('DOCUMENTS_TOKEN');
const documentStore = http.store({
  load: async (unit, ctx) => {
    const response = await fetch(`${ctx.resolve(documentsUrl)}/contracts/${unit.key}`, {
      headers: { authorization: `Bearer ${ctx.resolve(documentsToken)}` },
    });
    return response.ok ? z.object({ data: contractSchema, state: z.string() }).parse(await response.json()) : undefined;
  },
  save: async (unit, change, ctx) => {
    await fetch(`${ctx.resolve(documentsUrl)}/contracts/${unit.key}`, {
      method: 'PUT',
      headers: { authorization: `Bearer ${ctx.resolve(documentsToken)}`, 'content-type': 'application/json' },
      body: JSON.stringify(change),
    });
  },
});

const drafterRole = H.role('contract-drafter').promptFile('prompts/contract-drafter.md').intents(['read']);
const drafter = H.agent('contract-drafter').role(drafterRole).model(opus);
const draftContract = H.skill('draft-contract')
  .input(z.object({ counterparty: z.string(), amountUsd: z.number(), redline: z.string() }))
  .output(z.object({ text: z.string() }))
  .prompt((i) => `Draft the contract with ${i.counterparty} for $${i.amountUsd}. Latest redline:\n${i.redline}`);

const counselDecision = z.object({ verdict: z.enum(['approve', 'return']), notes: z.string() });

const counselReview = H.halt('counsel-review')
  .context(z.object({ contractId: z.string(), category: z.string(), draft: z.string() }))
  .ask((c) => `Review contract ${c.contractId} (${c.category}).`)
  .decision(counselDecision);

const financeSignoff = H.halt('finance-signoff')
  .context(z.object({ contractId: z.string(), amountUsd: z.number() }))
  .ask((c) => `Sign off contract ${c.contractId} for $${c.amountUsd}?`)
  .decision(z.object({ approved: z.boolean(), note: z.string() }));

const executeContract = H.command('execute-contract')
  .input(z.object({ contractId: z.string(), text: z.string() }))
  .effect('unrepeatable')
  .run(async (i, ctx) => {
    const response = await fetch(`${ctx.resolve(documentsUrl)}/contracts/${i.contractId}/execute`, {
      method: 'POST',
      headers: { authorization: `Bearer ${ctx.resolve(documentsToken)}`, 'content-type': 'application/json' },
      body: JSON.stringify({ text: i.text }),
    });
    if (!response.ok) throw new Error(`execution refused: ${response.status}`);
  });

const pageDeputy = H.command('page-finance-deputy')
  .input(z.object({ contractId: z.string(), amountUsd: z.number() }))
  .effect('repeatable')
  .run(async (i, ctx) => {
    await fetch(ctx.resolve(H.env('PAGER_URL')), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ to: 'finance-deputy', text: `Signoff for ${i.contractId} ($${i.amountUsd}) has waited 20 minutes.` }),
    });
  });

const handleContract = H.flow('contract')
  .input(contractSchema)
  .step('draft', drafter.call(draftContract), (s) => ({
    counterparty: s.input.counterparty,
    amountUsd: s.input.amountUsd,
    redline: s.input.redline,
  }))
  .halt('counsel', counselReview, (s) => ({ contractId: s.input.contractId, category: s.input.category, draft: s.steps.draft.text }))
  .when((s) => s.steps.counsel.verdict === 'return', (f) => f.exit('returnedByCounsel'))
  .halt('signoff', financeSignoff, (s) => ({ contractId: s.input.contractId, amountUsd: s.input.amountUsd }))
  .when((s) => !s.steps.signoff.approved, (f) => f.exit('rejectedByFinance'))
  .step('execute', executeContract, (s) => ({ contractId: s.input.contractId, text: s.steps.draft.text }))
  .exit('executed');

const contractLane = (region: string, tries: number, backoff: 'exponential' | 'none') =>
  H.lane(`contracts-${region}`)
    .of(contractKind)
    .from(
      http.webhook({ path: `/contracts/${region}`, schema: contractSchema, secret: H.env('CONTRACTS_WEBHOOK_SECRET') }).key((d) => d.contractId),
      supply.manual(),
    )
    .store(documentStore)
    .handle(handleContract)
    .exits({
      executed,
      rejectedByFinance,
      returnedByCounsel: { to: received, maxTimes: 1, then: declined },
    })
    .retry({ tries, backoff, delaySeconds: 120, exhausted: failed })
    .wip(3)
    .facet(category, (d) => d.category);

const contractsEu = contractLane('eu', 3, 'exponential');
const contractsUs = contractLane('us', 1, 'none');

const humanCounselApprovals = H.metric('counsel-human-approvals').count(
  H.events.decisions(counselReview, { match: (d) => d.verdict === 'approve', resolver: 'human' }),
);
const counselReturns = H.metric('counsel-returns').count(H.events.decisions(counselReview, { match: (d) => d.verdict === 'return' }));

const provenCategorySkipsCounsel = H.policy.halt('proven-category-skips-counsel', counselReview, ({ context, metrics }) => {
  const where = { facet: { facet: category, value: context.category } };
  const approved = metrics.read(humanCounselApprovals, { where });
  const returned = metrics.read(counselReturns, { where });
  const skip: z.output<typeof counselDecision> = {
    verdict: 'approve',
    notes: `category ${context.category}: ${approved.value ?? 0} approvals over ${approved.samples} samples, no returns`,
  };
  return (approved.value ?? 0) >= 200 && (returned.value ?? 0) === 0 ? skip : undefined;
});

const counselSkip = H.trigger('counsel-skip-for-proven-category')
  .on(counselReview.opened())
  .do(H.ops.resolve(counselReview).by(provenCategorySkipsCounsel));

const signoffDeputyPage = H.trigger('signoff-deputy-page')
  .on(financeSignoff.opened().after('20m'))
  .do(pageDeputy.with((p) => ({ contractId: p.context.contractId, amountUsd: p.context.amountUsd })));

const signoffTimeout = H.trigger('signoff-timeout')
  .on(financeSignoff.opened().after('30m'))
  .do(
    H.ops.resolve(financeSignoff).with((p) => ({
      approved: p.context.amountUsd < 500,
      note: p.context.amountUsd < 500 ? 'approved by timeout under $500' : 'rejected by timeout at $500 or more',
    })),
  );

const counselDecisionSeconds = H.metric('counsel-decision-seconds').median(H.events.decisions(counselReview), 'waitSeconds');
const signoffDecisionSeconds = H.metric('signoff-decision-seconds').median(H.events.decisions(financeSignoff), 'waitSeconds');
const failedAttempts = H.metric('failed-attempts').count(H.events.attempts({ outcome: 'failed' }));
const signoffTimeoutShare = H.metric('signoff-timeout-share').rate(
  H.events.decisions(financeSignoff, { resolver: 'clock' }),
  H.events.decisions(financeSignoff),
);

export const contracts = H.harness('contracts')
  .ledger(sqlite.ledger('.harness/ledger.sqlite'))
  .pools(apiPool)
  .lanes(contractsEu, contractsUs)
  .triggers(counselSkip, signoffDeputyPage, signoffTimeout)
  .scheduler(H.scheduler().policy(H.policy.schedule('oldest-first', ({ candidates }) => [...candidates].sort((a, b) => b.waitingSeconds - a.waitingSeconds))))
  .grants(
    H.grant(http.client('counsel-dashboard', { port: 8443, token: H.env('COUNSEL_TOKEN') }), H.ops.resolve(counselReview)),
    H.grant(claudeCode.client('finance', { session: 'finance' }), H.ops.resolve(financeSignoff)),
    H.grant(claudeCode.client('finance-deputy', { session: 'finance-deputy' }), H.ops.resolve(financeSignoff)),
    H.grant(http.client('auditor', { port: 8444, token: H.env('AUDITOR_TOKEN') }), H.ops.work.read, H.ops.telemetry.read),
    H.grant(http.client('operator', { port: 8445, token: H.env('OPERATOR_TOKEN') }), H.ops.work.read, H.ops.work.write),
  )
  .metrics(counselDecisionSeconds, signoffDecisionSeconds, failedAttempts, signoffTimeoutShare)
  .observe(observers.board({ path: '.harness/board.md' }), observers.telemetry({ path: '.harness/telemetry.md' }));
