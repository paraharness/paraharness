import { z } from 'zod';
import { H } from 'harness-dsl';
import { claudeCode } from 'harness-dsl/claude-code';
import { anthropic } from 'harness-dsl/anthropic';
import { sqlite } from 'harness-dsl/sqlite';
import { http } from 'harness-dsl/http';
import { rest } from 'harness-dsl/rest';
import { manual } from 'harness-dsl/supply';
import { policies } from 'harness-dsl/policies';
import { observers } from 'harness-dsl/observers';

const api = H.account('anthropic-api', anthropic.api({ apiKey: H.env('ANTHROPIC_API_KEY') }));
const sonnet = H.model('claude-sonnet-4-5').pricing(anthropic.pricing());
const pool = H.pool('api', [api]).serves(sonnet).policy(policies.soonestReset());

const category = H.facet('contract-category');

const queued = H.state('queued').pending();
const inProgress = H.state('in-progress').active();
const stalled = H.state('stalled').waiting();
const executed = H.state('executed').terminal('success');
const declined = H.state('declined').terminal('failure');

const contractSchema = z.object({
  contractId: z.string(),
  title: z.string(),
  counterparty: z.string(),
  category: z.string(),
  amountUsd: z.number(),
  redlines: z.array(z.string()),
});
const contract = H.work('Contract').schema(contractSchema).states(queued, inProgress, stalled, executed, declined);

const counsel = H.halt('counsel')
  .context(z.object({ contractId: z.string(), title: z.string(), category: z.string(), draft: z.string() }))
  .decision(z.object({ verdict: z.enum(['approve', 'return']), notes: z.string() }))
  .ask(c => `Review contract ${c.title} (${c.category}).`);

const signoff = H.halt('signoff')
  .context(z.object({ contractId: z.string(), counterparty: z.string(), amountUsd: z.number() }))
  .decision(z.object({ approved: z.boolean() }))
  .ask(c => `Sign off ${c.contractId} with ${c.counterparty} for $${c.amountUsd}?`);

export const counselApprovals = H.metric('counsel-approvals', H.events.decisions(counsel).where(e => e.resolver === 'human'))
  .rate(e => e.decision.verdict === 'approve')
  .by(category)
  .window('365d');

const counselSkip = H.policy.decision('counsel-skip-proven-category', counsel, ({ context, metrics }) => {
  const reading = metrics.read(counselApprovals, { 'contract-category': context.category });
  return reading.samples >= 200 && reading.value === 1
    ? { verdict: 'approve', notes: `skipped: ${reading.samples} approvals, no returns` }
    : undefined;
});

const drafterRole = H.role('contract-drafter').prompt('Draft the contract, applying every counterparty redline.').intents(['read']);
const draftSkill = H.skill('draft-contract')
  .input(z.object({ title: z.string(), counterparty: z.string(), amountUsd: z.number(), redlines: z.array(z.string()) }))
  .output(z.object({ text: z.string() }))
  .prompt(i => `Draft "${i.title}" with ${i.counterparty} for $${i.amountUsd}. Redlines:\n${i.redlines.join('\n')}`);
const drafter = H.seat('contract-drafter').role(drafterRole).skill(draftSkill).models(sonnet);

const execute = H.command('execute-contract')
  .input(z.object({ contractId: z.string() }))
  .output(z.object({ envelopeId: z.string() }))
  .effect('unrepeatable')
  .detect(async (input, ctx) => {
    const found = await ctx.exec(['docsys', 'find-envelope', input.contractId]);
    return found.code === 0 && found.stdout.trim() ? { envelopeId: found.stdout.trim() } : undefined;
  })
  .run(async (input, ctx) => {
    const result = await ctx.exec(['docsys', 'execute', input.contractId]);
    return { envelopeId: result.stdout.trim() };
  });

const pageDeputy = H.command('page-finance-deputy')
  .input(z.object({ contractId: z.string(), amountUsd: z.number() }))
  .output(z.object({ paged: z.boolean() }))
  .effect('repeatable')
  .run(async (input, ctx) => {
    const result = await ctx.exec(['pager', 'page', 'finance-deputy', `signoff ${input.contractId} $${input.amountUsd}`]);
    return { paged: result.code === 0 };
  });

const contractFlow = H.flow('contract')
  .input(contractSchema)
  .tag(category, s => s.input.category)
  .step('draft', drafter, s => ({
    title: s.input.title,
    counterparty: s.input.counterparty,
    amountUsd: s.input.amountUsd,
    redlines: s.input.redlines,
  }))
  .halt(
    'counsel',
    counsel,
    s => ({ contractId: s.input.contractId, title: s.input.title, category: s.input.category, draft: s.draft.text }),
    { resolver: counselSkip },
  )
  .when(s => s.counsel.verdict === 'return', f => f.exit('returned'))
  .halt('signoff', signoff, s => ({ contractId: s.input.contractId, counterparty: s.input.counterparty, amountUsd: s.input.amountUsd }))
  .when(s => !s.signoff.approved, f => f.exit('rejected'))
  .step('execute', execute, s => ({ contractId: s.input.contractId }))
  .exit('executed');

const docsysUrl = H.env('DOCSYS_URL');
const docsysToken = H.env('DOCSYS_TOKEN');

const contractWebhook = (region: 'eu' | 'us') =>
  http.webhook({
    name: `docsys-${region}`,
    path: `/webhooks/contracts/${region}`,
    port: H.slot.port(0),
    secret: H.env('DOCSYS_WEBHOOK_SECRET'),
    body: contractSchema,
    key: b => b.contractId,
    data: b => b,
    mode: 'upsert',
  });

const contractsEu = H.lane('contracts-eu')
  .of(contract)
  .from(contractWebhook('eu'), manual('operator-eu'))
  .store(rest.store({ name: 'docsys-eu', baseUrl: docsysUrl, token: docsysToken, path: '/contracts/eu', schema: contractSchema }))
  .handle(contractFlow, {
    exits: { executed, returned: { to: queued, atMost: 1, then: declined }, rejected: declined },
    retry: { retries: 3, backoff: { initial: '1m', factor: 2, max: '30m' }, exhausted: stalled },
  })
  .wip(3);

const contractsUs = H.lane('contracts-us')
  .of(contract)
  .from(contractWebhook('us'), manual('operator-us'))
  .store(rest.store({ name: 'docsys-us', baseUrl: docsysUrl, token: docsysToken, path: '/contracts/us', schema: contractSchema }))
  .handle(contractFlow, {
    exits: { executed, returned: { to: queued, atMost: 1, then: declined }, rejected: declined },
    retry: { retries: 1, backoff: { initial: '5m', factor: 1 }, exhausted: stalled },
  })
  .wip(3);

const triggers = [
  H.trigger('signoff-deputy-page')
    .on(H.time.after(signoff, '20m'))
    .do(H.call(pageDeputy, e => ({ contractId: e.context.contractId, amountUsd: e.context.amountUsd }))),
  H.trigger('signoff-timeout')
    .on(H.time.after(signoff, '30m'))
    .do(H.ops.resolve(signoff).with(e => ({ approved: e.context.amountUsd < 500 }))),
  H.trigger('redline-eu-at-counsel')
    .on(H.events.updates(contractsEu))
    .do(contractsEu.move({ halted: counsel, key: e => e.unit.key }, queued)),
  H.trigger('redline-us-at-counsel')
    .on(H.events.updates(contractsUs))
    .do(contractsUs.move({ halted: counsel, key: e => e.unit.key }, queued)),
];

export const counselTimeToDecision = H.metric('counsel-time-to-decision', H.events.decisions(counsel))
  .median(e => e.waitedMs)
  .by('resolver')
  .window('30d');
export const signoffTimeToDecision = H.metric('signoff-time-to-decision', H.events.decisions(signoff))
  .median(e => e.waitedMs)
  .by('resolver')
  .window('30d');
export const retriesPerLane = H.metric('retries-per-lane', H.events.attempts())
  .sum(e => (e.retry > 0 ? 1 : 0))
  .by('lane')
  .window('calendarMonth');
export const signoffTimeoutShare = H.metric('signoff-timeout-share', H.events.decisions(signoff))
  .rate(e => e.resolver === 'clock')
  .window('calendarMonth');

const order = H.policy.units('largest-first', ({ candidates }) => {
  const amount = (c: (typeof candidates)[number]) =>
    contractsEu.holds(c) ? c.data.amountUsd : contractsUs.holds(c) ? c.data.amountUsd : 0;
  return [...candidates].sort((a, b) => amount(b) - amount(a) || a.queuedAt.getTime() - b.queuedAt.getTime());
});

export const harness = H.harness('contracts')
  .ledger(sqlite.ledger('./contracts/ledger.sqlite'))
  .pools(pool)
  .lanes(contractsEu, contractsUs)
  .triggers(...triggers)
  .scheduler(order)
  .grants(
    H.grant(http.client({ name: 'counsel-dashboard', port: 8443, token: H.env('COUNSEL_TOKEN') }), H.ops.resolve(counsel)),
    H.grant(claudeCode.client({ name: 'finance' }), H.ops.resolve(signoff)),
    H.grant(claudeCode.client({ name: 'finance-deputy' }), H.ops.resolve(signoff)),
    H.grant(http.client({ name: 'auditor', port: 8444, token: H.env('AUDITOR_TOKEN') }), H.ops.work.read, H.ops.telemetry.read),
    H.grant(claudeCode.client({ name: 'operator' }), H.ops.work.read, H.ops.work.write, H.ops.attempts.manage),
  )
  .observe(observers.board({ path: './contracts/BOARD.md' }), observers.telemetry({ path: './contracts/TELEMETRY.md' }));

export const running = harness.start();
