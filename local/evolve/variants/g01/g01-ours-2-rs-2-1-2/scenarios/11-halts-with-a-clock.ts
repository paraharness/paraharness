import { z } from 'zod';
import { H, type Backoff } from 'harness-dsl';
import { anthropic } from 'harness-dsl/anthropic';
import { claudeCode } from 'harness-dsl/claude-code';
import { sqlite } from 'harness-dsl/sqlite';
import { http } from 'harness-dsl/http';
import { rest } from 'harness-dsl/rest';
import { manual } from 'harness-dsl/supply';
import { policies } from 'harness-dsl/policies';
import { observers } from 'harness-dsl/observers';

const api = H.account('anthropic-api', anthropic.api({ apiKey: H.env('ANTHROPIC_API_KEY') }));
const sonnet = H.model('claude-sonnet-4-5').pricing(anthropic.pricing());

const category = H.resource('contract-category');

const contractSchema = z.object({
  id: z.string(),
  counterparty: z.string(),
  category: z.string(),
  amountUsd: z.number(),
  document: z.string(),
  redlines: z.array(z.string()),
});
const queued = H.state('queued').pending();
const executed = H.state('executed').terminal('success');
const declined = H.state('declined').terminal('failure');
const rejectedByFinance = H.state('rejected-by-finance').terminal('failure');
const abandoned = H.state('abandoned').terminal('failure');
const contract = H.work('Contract').schema(contractSchema).states(queued, executed, declined, rejectedByFinance, abandoned);

const drafter = H.role('contract-drafter').promptFile('./prompts/contract-drafter.md');
const draftContract = H.skill('draft-contract')
  .input(z.object({ counterparty: z.string(), document: z.string(), redlines: z.array(z.string()) }))
  .output(z.object({ text: z.string() }))
  .prompt(i => `Draft for ${i.counterparty}. Apply redlines:\n${i.redlines.join('\n')}\n\n${i.document}`);
const drafterSeat = H.seat('contract-drafter').role(drafter).skill(draftContract).models(sonnet);

const counselDecision = z.object({ verdict: z.enum(['approve', 'return']), notes: z.string() });
type CounselDecision = z.infer<typeof counselDecision>;

const counsel = H.halt('counsel')
  .context(z.object({ contract: z.string(), category: z.string(), draft: z.string() }))
  .decision(counselDecision);
const signoff = H.halt('signoff')
  .context(z.object({ contract: z.string(), amountUsd: z.number() }))
  .decision(z.object({ approved: z.boolean() }));

const counselApprovals = H.metric('counsel-approvals', H.events.decisions(counsel).where(e => e.resolver === 'human'))
  .rate(e => e.decision.verdict === 'approve')
  .by(category)
  .window('365d');

const skipCounsel = H.policy.decision('skip-counsel-for-proven-category', counsel, (c): CounselDecision | undefined => {
  const reading = c.metrics.read(counselApprovals, category.is(c.context.category));
  const proven = reading.samples >= 200 && reading.value === 1;
  return proven ? { verdict: 'approve', notes: `category proven: ${reading.samples} approvals, no rejections` } : undefined;
});

const executeContract = H.command('execute-contract')
  .input(z.object({ contract: z.string(), text: z.string() }))
  .output(z.object({ envelope: z.string() }))
  .effect('unrepeatable')
  .run(async (input, ctx) => {
    const signed = await ctx.exec(['docsys', 'execute', input.contract], { stdin: input.text });
    return { envelope: signed.stdout.trim() };
  });

const pageDeputy = H.command('page-deputy')
  .input(z.object({ contract: z.string(), openedAt: z.string() }))
  .output(z.object({ paged: z.boolean() }))
  .effect('unrepeatable')
  .run(async (input, ctx) => {
    const paged = await ctx.exec(['pager', 'notify', 'finance-deputy', `Signoff on ${input.contract} open since ${input.openedAt}`]);
    return { paged: paged.code === 0 };
  });

const contractFlow = H.flow('contract')
  .input(contractSchema)
  .tag(category, s => s.input.category)
  .step('draft', drafterSeat, s => ({ counterparty: s.input.counterparty, document: s.input.document, redlines: s.input.redlines }))
  .halt('counsel', counsel, s => ({ contract: s.input.id, category: s.input.category, draft: s.draft.text }), { resolver: skipCounsel })
  .when(s => s.counsel.verdict === 'return', f => f.exit('returned'))
  .halt('signoff', signoff, s => ({ contract: s.input.id, amountUsd: s.input.amountUsd }))
  .when(s => !s.signoff.approved, f => f.exit('rejected'))
  .step('execute', executeContract, s => ({ contract: s.input.id, text: s.draft.text }))
  .exit('executed');

const documentSystem = rest.store({ name: 'document-system', baseUrl: H.env('DOCSYS_URL'), token: H.env('DOCSYS_TOKEN'), path: '/contracts', schema: contractSchema });

function contractLane<N extends string>(name: N, retries: number, backoff: Backoff) {
  return H.lane(name)
    .of(contract)
    .from(
      http.webhook({ name: `${name}-webhook`, path: `/contracts/${name}`, port: H.slot.port(0), secret: H.env('DOCSYS_SECRET'), body: contractSchema, key: b => b.id, data: b => b, mode: 'upsert' }),
      manual(`${name}-operator`),
    )
    .store(documentSystem)
    .handle(contractFlow, {
      exits: { returned: { to: queued, atMost: 1, then: declined }, rejected: rejectedByFinance, executed },
      retry: { retries, backoff, exhausted: abandoned },
    })
    .wip(3);
}

const contractsEu = contractLane('contracts-eu', 3, { initial: '5m', factor: 2, max: '2h' });
const contractsUs = contractLane('contracts-us', 1, { initial: '5m', factor: 1 });

const triggers = [
  H.trigger('eu-redline-at-counsel')
    .on(H.events.updates(contractsEu))
    .do(contractsEu.cancel({ halted: counsel, key: e => e.unit.key }, queued)),
  H.trigger('us-redline-at-counsel')
    .on(H.events.updates(contractsUs))
    .do(contractsUs.cancel({ halted: counsel, key: e => e.unit.key }, queued)),
  H.trigger('signoff-deputy')
    .on(H.time.after(signoff, '20m'))
    .do(H.call(pageDeputy, e => ({ contract: e.context.contract, openedAt: e.openedAt.toISOString() }))),
  H.trigger('signoff-timeout')
    .on(H.time.after(signoff, '30m'))
    .do(H.ops.resolve(signoff).with(e => ({ approved: e.context.amountUsd < 500 }))),
];

export const counselDecisionTime = H.metric('counsel-time-to-decision', H.events.decisions(counsel))
  .median(e => e.waitedMs)
  .by('resolver')
  .window('30d');
export const signoffDecisionTime = H.metric('signoff-time-to-decision', H.events.decisions(signoff))
  .median(e => e.waitedMs)
  .by('resolver')
  .window('30d');
export const retriesPerLane = H.metric('retries-per-lane', H.events.attempts().where(e => e.retry > 0))
  .count()
  .by('lane')
  .window('calendarMonth');
export const signoffTimeoutShare = H.metric('signoff-timeout-share', H.events.decisions(signoff))
  .rate(e => e.resolver === 'clock')
  .window('calendarMonth');

const pool = H.pool('api', [api]).serves(sonnet).policy(policies.soonestReset());

const fifo = H.policy.units('fifo', c => [...c.candidates].sort((a, b) => a.queuedAt.getTime() - b.queuedAt.getTime()));

export const contracts = H.harness('contracts')
  .ledger(sqlite.ledger('./.harness/ledger.sqlite'))
  .pools(pool)
  .lanes(contractsEu, contractsUs)
  .triggers(...triggers)
  .scheduler(fifo)
  .grants(
    H.grant(http.client({ name: 'counsel-dashboard', port: H.slot.port(1), token: H.env('COUNSEL_TOKEN') }), H.ops.resolve(counsel)),
    H.grant(claudeCode.client({ name: 'finance' }), H.ops.resolve(signoff)),
    H.grant(http.client({ name: 'auditor', port: H.slot.port(2), token: H.env('AUDITOR_TOKEN') }), H.ops.telemetry.read, H.ops.work.read),
  )
  .observe(observers.board({ path: './BOARD.md' }), observers.telemetry({ path: './TELEMETRY.md' }));
