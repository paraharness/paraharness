import { z } from 'zod';
import { H } from 'harness-dsl';
import type { HaltOpenEvent } from 'harness-dsl/kernel';
import { claudeCode } from 'harness-dsl/claude-code';
import { anthropic } from 'harness-dsl/anthropic';
import { sqlite } from 'harness-dsl/sqlite';
import { http } from 'harness-dsl/http';
import { rest } from 'harness-dsl/rest';
import { manual } from 'harness-dsl/supply';
import { runners } from 'harness-dsl/runners';
import { policies } from 'harness-dsl/policies';
import { observers } from 'harness-dsl/observers';

const category = H.facet('category');
const local = runners.local({ name: 'contracts-host', slots: 2 });

const subscription = H.account('claude-max', claudeCode.driver({ configDir: '~/.claude' }));
const opus = H.model('claude-opus-4-1').pricing(anthropic.pricing());
const pool = H.pool('contracts', [subscription]).serves(opus).policy(policies.soonestReset());

const contractSchema = z.object({
  title: z.string(),
  counterparty: z.string(),
  amountUsd: z.number(),
  category: z.string(),
  redlines: z.array(z.string()),
});
type Contract = z.output<typeof contractSchema>;

const drafting = H.state('drafting').pending();
const executed = H.state('executed').terminal('success');
const rejected = H.state('rejected').terminal('failure');
const declined = H.state('declined').terminal('failure');
const failed = H.state('failed').terminal('failure');
const contract = H.work('Contract').schema(contractSchema).states(drafting, executed, rejected, declined, failed);

const drafterRole = H.role('contract-drafter').prompt('Draft the contract, applying every redline.');
const draftSkill = H.skill('draft-contract')
  .input(z.object({ title: z.string(), counterparty: z.string(), redlines: z.array(z.string()) }))
  .output(z.object({ document: z.string() }));
const drafter = H.seat('contract-drafter').role(drafterRole).skill(draftSkill).models(opus);

const counselDecision = z.object({ verdict: z.enum(['approve', 'return']), notes: z.string() });
type CounselDecision = z.output<typeof counselDecision>;
const counsel = H.halt('counsel')
  .context(z.object({ title: z.string(), counterparty: z.string(), category: z.string(), document: z.string() }))
  .decision(counselDecision)
  .ask(c => `Counsel review of ${c.title} with ${c.counterparty}`);

const signoffContext = z.object({ title: z.string(), amountUsd: z.number() });
type SignoffContext = z.output<typeof signoffContext>;
const signoff = H.halt('signoff')
  .context(signoffContext)
  .decision(z.object({ approve: z.boolean() }))
  .ask(c => `Finance sign-off for ${c.title}, $${c.amountUsd}`);

const counselApprovals = H.metric('counsel-approval-rate', H.events.decisions(counsel).where(e => e.resolver === 'human'))
  .rate(e => e.decision.verdict === 'approve')
  .by(category)
  .window('365d');

const skipCounsel = H.policy.decision('skip-counsel-for-proven-categories', counsel, (choice): CounselDecision | undefined => {
  const reading = choice.metrics.read(counselApprovals, category.is(choice.context.category));
  return reading.samples >= 200 && reading.value === 1
    ? { verdict: 'approve', notes: `skipped by policy: ${reading.samples} approvals, none returned` }
    : undefined;
});

const execute = H.command('execute-contract')
  .input(z.object({ title: z.string(), document: z.string() }))
  .output(z.object({ envelopeId: z.string() }))
  .runner(local)
  .effect('unrepeatable')
  .detect(async (input, ctx) => {
    const found = await ctx.exec(['docs', 'envelope', 'find', '--attempt', ctx.attempt]);
    const id = found.stdout.trim();
    return id === '' ? undefined : { envelopeId: id };
  })
  .run(async (input, ctx) => {
    const sent = await ctx.exec(['docs', 'envelope', 'send', input.title, '--attempt', ctx.attempt], { stdin: input.document });
    return { envelopeId: sent.stdout.trim() };
  });

const pageDeputy = H.command('page-deputy')
  .input(signoffContext)
  .output(z.object({ paged: z.boolean() }))
  .runner(local)
  .effect('repeatable')
  .run(async (input, ctx) => {
    const result = await ctx.exec(['pager', 'notify', 'finance-deputy', `Sign-off pending: ${input.title} ($${input.amountUsd})`]);
    return { paged: result.code === 0 };
  });

const contractFlow = H.flow('contract')
  .input(contractSchema)
  .tag(category, s => s.input.category)
  .step('draft', drafter, s => ({ title: s.input.title, counterparty: s.input.counterparty, redlines: s.input.redlines }))
  .halt('counsel', counsel, s => ({ title: s.input.title, counterparty: s.input.counterparty, category: s.input.category, document: s.draft.document }), { resolver: skipCounsel })
  .when(s => s.counsel.verdict === 'return', f => f.exit('returned'))
  .halt('signoff', signoff, s => ({ title: s.input.title, amountUsd: s.input.amountUsd }))
  .when(s => !s.signoff.approve, f => f.exit('rejected'))
  .step('execute', execute, s => ({ title: s.input.title, document: s.draft.document }))
  .exit('executed');

const contractBody = z.object({
  id: z.string(),
  title: z.string(),
  counterparty: z.string(),
  amountUsd: z.number(),
  category: z.string(),
  redline: z.string().optional(),
});

const contractWebhook = (region: 'eu' | 'us', port: number) =>
  http.webhook({
    name: `contracts-${region}-webhook`,
    path: `/contracts/${region}`,
    port: H.slot.port(port),
    secret: H.env('DOCS_WEBHOOK_SECRET'),
    body: contractBody,
    key: b => b.id,
    data: (b, current: Contract | undefined) => ({
      title: b.title,
      counterparty: b.counterparty,
      amountUsd: b.amountUsd,
      category: b.category,
      redlines: [...(current?.redlines ?? []), ...(b.redline === undefined ? [] : [b.redline])],
    }),
  });

const documents = rest.store({ name: 'documents', baseUrl: H.env('DOCS_URL'), token: H.env('DOCS_TOKEN'), path: '/contracts', schema: contractSchema });

const contractsEu = H.lane('contracts-eu').of(contract)
  .from(contractWebhook('eu', 0), manual('legal-ops-eu'))
  .store(documents)
  .handle(contractFlow, {
    exits: { returned: { to: drafting, atMost: 1, then: declined }, rejected, executed },
    retry: { retries: 3, backoff: { initial: '1m', factor: 2, max: '30m' }, exhausted: failed },
  })
  .wip(3);

const contractsUs = H.lane('contracts-us').of(contract)
  .from(contractWebhook('us', 1), manual('legal-ops-us'))
  .store(documents)
  .handle(contractFlow, {
    exits: { returned: { to: drafting, atMost: 1, then: declined }, rejected, executed },
    retry: { retries: 1, exhausted: failed },
  })
  .wip(3);

const triggers = [
  H.trigger('page-deputy-at-20m').on(H.time.after(signoff, '20m')).do(
    H.call(pageDeputy, (e: HaltOpenEvent<SignoffContext>) => e.context),
  ),
  H.trigger('signoff-default-at-30m').on(H.time.after(signoff, '30m')).do(
    H.ops.resolve(signoff).with(e => ({ approve: e.context.amountUsd < 500 })),
  ),
  H.trigger('redline-redrafts-eu').on(H.events.updates(contractsEu)).do(contractsEu.move({ halted: counsel, key: e => e.unit.key }, drafting)),
  H.trigger('redline-redrafts-us').on(H.events.updates(contractsUs)).do(contractsUs.move({ halted: counsel, key: e => e.unit.key }, drafting)),
];

export const counselTimeToDecision = H.metric('counsel-time-to-decision', H.events.decisions(counsel)).median(e => e.waitedMs).by('resolver');
export const signoffTimeToDecision = H.metric('signoff-time-to-decision', H.events.decisions(signoff)).median(e => e.waitedMs).by('resolver');
export const retriesPerLane = H.metric('retries-per-lane', H.events.attempts().where(e => e.retry > 0)).count().by('lane').window('calendarMonth');
export const signoffTimeoutShare = H.metric('signoff-timeout-share', H.events.decisions(signoff)).rate(e => e.resolver === 'clock').window('30d');

const counselDashboard = http.client({ name: 'counsel-dashboard', port: H.slot.port(2), token: H.env('COUNSEL_TOKEN') });
const finance = claudeCode.client({ name: 'finance' });
const financeDeputy = claudeCode.client({ name: 'finance-deputy' });
const auditor = http.client({ name: 'auditor', port: H.slot.port(3), token: H.env('AUDITOR_TOKEN') });
const legalOps = claudeCode.client({ name: 'legal-ops' });

export const harness = H.harness('contracts')
  .ledger(sqlite.ledger('./.harness/ledger.sqlite'))
  .pools(pool)
  .lanes(contractsEu, contractsUs)
  .triggers(...triggers)
  .scheduler(H.policy.units('oldest-first', choice => [...choice.candidates].sort((a, b) => a.queuedAt.getTime() - b.queuedAt.getTime())))
  .grants(
    H.grant(counselDashboard, H.ops.resolve(counsel)),
    H.grant(finance, H.ops.resolve(signoff)),
    H.grant(financeDeputy, H.ops.resolve(signoff)),
    H.grant(auditor, H.ops.telemetry.read),
    H.grant(legalOps, H.ops.work.read, H.ops.work.write, H.ops.attempts.manage),
  )
  .observe(observers.board({ path: './BOARD.md' }), observers.telemetry({ path: './TELEMETRY.md' }));
