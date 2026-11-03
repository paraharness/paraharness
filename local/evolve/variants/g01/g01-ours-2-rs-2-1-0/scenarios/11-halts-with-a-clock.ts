import { z } from 'zod';
import { H, type Backoff } from 'harness-dsl';
import { anthropic } from 'harness-dsl/anthropic';
import { claudeCode } from 'harness-dsl/claude-code';
import { sqlite } from 'harness-dsl/sqlite';
import { http } from 'harness-dsl/http';
import { rest } from 'harness-dsl/rest';
import { manual } from 'harness-dsl/supply';
import { runners } from 'harness-dsl/runners';
import { observers } from 'harness-dsl/observers';

const local = runners.local({ name: 'local', slots: 2 });

const api = H.account('api', anthropic.api({ apiKey: H.env('ANTHROPIC_API_KEY') }));
const sonnet = H.model('claude-sonnet-4-5').pricing(anthropic.pricing());
const pool = H.pool('contracts', [api]).serves(sonnet);

const category = H.facet('category');

const contract = z.object({
  contractId: z.string(),
  counterparty: z.string(),
  category: z.string(),
  amountUsd: z.number(),
  documentUrl: z.string(),
  redlines: z.array(z.string()),
});
const drafting = H.state('drafting').pending();
const executed = H.state('executed').terminal('success');
const declined = H.state('declined').terminal('failure');
const failed = H.state('failed').terminal('failure');
const contractKind = H.work('Contract').schema(contract).states(drafting, executed, declined, failed);

const counsel = H.halt('counsel')
  .context(z.object({ contractId: z.string(), category: z.string(), draftUrl: z.string(), summary: z.string() }))
  .decision(z.object({ action: z.enum(['approve', 'return']), notes: z.string() }))
  .ask(context => `Review ${context.contractId} (${context.category}): ${context.draftUrl}`);
const signoff = H.halt('signoff')
  .context(z.object({ contractId: z.string(), amountUsd: z.number(), summary: z.string() }))
  .decision(z.object({ approved: z.boolean() }))
  .ask(context => `Sign off ${context.contractId} for $${context.amountUsd}?`);

const counselDecisionTime = H.metric('counsel-time-to-decision', H.events.decisions(counsel))
  .median(event => event.waitedMs)
  .by('resolver')
  .window('calendarMonth');
const signoffDecisionTime = H.metric('signoff-time-to-decision', H.events.decisions(signoff))
  .median(event => event.waitedMs)
  .by('resolver')
  .window('calendarMonth');
const signoffTimeouts = H.metric('signoff-timeout-share', H.events.decisions(signoff))
  .rate(event => event.resolver === 'clock')
  .window('calendarMonth');
const retriesPerLane = H.metric('retries-per-lane', H.events.attempts())
  .sum(event => (event.retry > 0 ? 1 : 0))
  .by('lane')
  .window('calendarMonth');
const counselApprovals = H.metric('counsel-approval-rate', H.events.decisions(counsel))
  .rate(event => event.decision.action === 'approve')
  .by(category)
  .window('365d');

const counselSkip = H.policy.decision('counsel-skip-proven-category', counsel, choice => {
  const record = choice.metrics.read(counselApprovals, category.is(choice.context.category));
  return record.samples >= 200 && record.value === 1
    ? { action: 'approve', notes: `skipped: ${record.samples} approvals, no returns` }
    : undefined;
});

const contractDrafter = H.role('contract-drafter').promptFile('prompts/contract-drafter.md').intents(['read', 'web']);
const draftContract = H.skill('draft-contract')
  .input(z.object({ counterparty: z.string(), documentUrl: z.string(), redlines: z.array(z.string()) }))
  .output(z.object({ draftUrl: z.string(), summary: z.string() }))
  .prompt(input => `Draft for ${input.counterparty} from ${input.documentUrl}. Apply redlines:\n${input.redlines.join('\n')}`);
const drafter = H.seat('drafter').role(contractDrafter).skill(draftContract).models(sonnet);

const execute = H.command('execute-contract')
  .input(z.object({ contractId: z.string(), draftUrl: z.string() }))
  .output(z.object({ envelopeId: z.string() }))
  .runner(local)
  .effect('unrepeatable')
  .run(async (input, ctx) => {
    const result = await ctx.exec(['./bin/docs', 'execute', input.contractId, input.draftUrl]);
    return { envelopeId: result.stdout.trim() };
  });

const pageDeputy = H.command('page-finance-deputy')
  .input(z.object({ contractId: z.string() }))
  .output(z.object({ paged: z.boolean() }))
  .runner(local)
  .effect('repeatable')
  .run(async (input, ctx) => {
    const result = await ctx.exec(['./bin/page', 'finance-deputy', input.contractId]);
    return { paged: result.code === 0 };
  });

const contractFlow = H.flow('contract')
  .input(contract)
  .tag(category, state => state.input.category)
  .step('draft', drafter, state => ({ counterparty: state.input.counterparty, documentUrl: state.input.documentUrl, redlines: state.input.redlines }))
  .halt('counsel', counsel, state => ({ contractId: state.input.contractId, category: state.input.category, draftUrl: state.draft.draftUrl, summary: state.draft.summary }), { resolver: counselSkip })
  .when(state => state.counsel.action === 'return', flow => flow.exit('returned'))
  .halt('signoff', signoff, state => ({ contractId: state.input.contractId, amountUsd: state.input.amountUsd, summary: state.draft.summary }))
  .when(state => state.signoff.approved === false, flow => flow.exit('rejected'))
  .step('execute', execute, state => ({ contractId: state.input.contractId, draftUrl: state.draft.draftUrl }))
  .exit('executed');

const documents = rest.store({ name: 'documents', baseUrl: H.env('DOCS_URL'), token: H.env('DOCS_TOKEN'), path: '/contracts', schema: contract });

const contractLane = (region: 'eu' | 'us', retries: number, backoff: Backoff) =>
  H.lane(`contracts-${region}`)
    .of(contractKind)
    .from(
      http.webhook({
        name: `contracts-${region}-webhook`,
        path: `/contracts/${region}`,
        port: H.slot.port(0),
        secret: H.env('CONTRACT_WEBHOOK_SECRET'),
        body: contract,
        key: body => body.contractId,
        data: body => body,
        mode: 'upsert',
      }),
      manual(`operator-contracts-${region}`),
    )
    .store(documents)
    .handle(contractFlow, {
      exits: { returned: { to: drafting, atMost: 1, then: declined }, rejected: declined, executed },
      retry: { retries, backoff, exhausted: failed },
    })
    .wip(3);

const contractsEu = contractLane('eu', 3, { initial: '5m', factor: 2, max: '1h' });
const contractsUs = contractLane('us', 1, 'none');

const redlineTriggers = [contractsEu, contractsUs].map(lane =>
  H.trigger(`${lane.name}-redline`)
    .on(H.events.updates(lane))
    .do(lane.move(event => event.unit.key, drafting)),
);

const deputyPage = H.trigger('signoff-page-deputy')
  .on(H.time.after(signoff, '20m'))
  .do(H.call(pageDeputy, event => ({ contractId: event.unit.key })));

const signoffTimeout = H.trigger('signoff-timeout')
  .on(H.time.after(signoff, '30m'))
  .do(H.ops.resolve(signoff).with(event => ({ approved: event.context.amountUsd < 500 })));

const oldestFirst = H.policy.units('oldest-first', choice => [...choice.candidates].sort((a, b) => a.queuedAt.getTime() - b.queuedAt.getTime()));

const counselDashboard = http.client({ name: 'counsel-dashboard', port: H.slot.port(1), token: H.env('COUNSEL_TOKEN') });
const financeSession = claudeCode.client({ name: 'finance' });
const deputySession = claudeCode.client({ name: 'finance-deputy' });
const auditorClient = http.client({ name: 'auditor', port: H.slot.port(2), token: H.env('AUDITOR_TOKEN') });
const operatorClient = http.client({ name: 'operator', port: H.slot.port(3), token: H.env('OPERATOR_TOKEN') });

export const harness = H.harness('contracts')
  .ledger(sqlite.ledger('.harness/contracts-ledger.db'))
  .pools(pool)
  .lanes(contractsEu, contractsUs)
  .triggers(...redlineTriggers, deputyPage, signoffTimeout)
  .metrics(counselDecisionTime, signoffDecisionTime, signoffTimeouts, retriesPerLane, counselApprovals)
  .scheduler(oldestFirst)
  .grants(
    H.grant(counselDashboard, H.ops.resolve(counsel)),
    H.grant(financeSession, H.ops.resolve(signoff)),
    H.grant(deputySession, H.ops.resolve(signoff)),
    H.grant(auditorClient, H.ops.work.read, H.ops.telemetry.read),
    H.grant(operatorClient, H.ops.work.read, H.ops.work.write),
  )
  .observe(observers.board({ path: '.harness/board.md' }), observers.telemetry({ path: '.harness/telemetry.md' }));
