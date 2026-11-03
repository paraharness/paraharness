import { z } from 'zod';
import { H } from 'harness-dsl';
import { anthropic } from 'harness-dsl/anthropic';
import { claudeCode } from 'harness-dsl/claude-code';
import { sqlite } from 'harness-dsl/sqlite';
import { http } from 'harness-dsl/http';
import { supply } from 'harness-dsl/supply';
import { policies } from 'harness-dsl/policies';
import { observers } from 'harness-dsl/observers';

const docsUrl = H.env('DOCUMENT_SYSTEM_URL');
const docsToken = H.env('DOCUMENT_SYSTEM_TOKEN');

const local = H.runner.local('local', { slots: 4 });
const opus = H.model('claude-opus-4-1').pricing(anthropic.pricing());
const subscription = H.account('max-1', claudeCode.driver({ configDir: H.env('CLAUDE_CONFIG_MAX_1') }));
const api = H.account('api', anthropic.api({ apiKey: H.env('ANTHROPIC_API_KEY') }));

const contractSchema = z.object({
  id: z.string(),
  title: z.string(),
  counterparty: z.string(),
  category: z.string(),
  amountUsd: z.number(),
  redline: z.string().optional(),
});

const received = H.state('received').pending();
const drafting = H.state('drafting').active();
const executed = H.state('executed').terminal('success');
const declined = H.state('declined').terminal('failure');
const rejected = H.state('rejected').terminal('failure');
const failed = H.state('failed').terminal('failure');

const contract = H.work('contract').schema(contractSchema).states(received, drafting, executed, declined, rejected, failed);

const draftsmanRole = H.role('contract-drafter').prompt('Draft the contract, applying every counterparty redline.').intents(['read']);

const draftSkill = H.skill('draft-contract')
  .input(z.object({ title: z.string(), counterparty: z.string(), redline: z.string() }))
  .output(z.object({ text: z.string() }))
  .prompt(i => `Contract ${i.title} with ${i.counterparty}.\nRedline to apply:\n${i.redline}`);

const drafter = H.seat('contract-drafter').role(draftsmanRole).models(opus);

const counsel = H.halt('counsel')
  .context(z.object({ title: z.string(), counterparty: z.string(), category: z.string(), draft: z.string() }))
  .ask(c => `Review ${c.title} with ${c.counterparty}.`)
  .decision(z.object({ action: z.enum(['approve', 'return']), notes: z.string() }));

const signoff = H.halt('signoff')
  .context(z.object({ title: z.string(), amountUsd: z.number() }))
  .ask(c => `Sign off ${c.title} for $${c.amountUsd}?`)
  .decision(z.object({ approved: z.boolean() }));

const execute = H.command('execute-contract')
  .input(z.object({ id: z.string(), text: z.string() }))
  .runner(local)
  .effect('unrepeatable')
  .run(async (input, ctx) => {
    const response = await fetch(`${ctx.resolve(docsUrl)}/contracts/${input.id}/execute`, {
      method: 'POST',
      headers: { authorization: `Bearer ${ctx.resolve(docsToken)}`, 'content-type': 'application/json' },
      body: JSON.stringify({ text: input.text }),
    });
    if (!response.ok) throw new Error(`document system answered ${response.status}`);
  });

const pageDeputy = H.command('page-finance-deputy')
  .input(z.object({ title: z.string(), amountUsd: z.number() }))
  .runner(local)
  .run(async (input, ctx) => {
    const result = await ctx.sh(`./bin/page finance-deputy "Sign-off waiting 20 minutes: ${input.title} ($${input.amountUsd})"`);
    if (result.code !== 0) throw new Error(result.stderr);
  });

const handleContract = H.flow('handle-contract')
  .input(contractSchema)
  .step('draft', drafter.call(draftSkill), s => ({
    title: s.input.title,
    counterparty: s.input.counterparty,
    redline: s.input.redline ?? '',
  }))
  .halt('counsel', counsel, s => ({
    title: s.input.title,
    counterparty: s.input.counterparty,
    category: s.input.category,
    draft: s.steps.draft.text,
  }))
  .when(s => s.steps.counsel.action === 'return', f => f.exit('returned'))
  .halt('signoff', signoff, s => ({ title: s.input.title, amountUsd: s.input.amountUsd }))
  .when(s => !s.steps.signoff.approved, f => f.exit('rejected'))
  .step('execute', execute, s => ({ id: s.input.id, text: s.steps.draft.text }))
  .exit('executed');

const contractExits = {
  returned: { to: received, maxTimes: 1, then: declined },
  rejected,
  executed,
};

const euHandler = H.handler('handle-contract-eu')
  .of(contract)
  .flow(handleContract)
  .exits(contractExits)
  .retry({ tries: 3, backoff: 'exponential', delaySeconds: 60, exhausted: failed });

const usHandler = H.handler('handle-contract-us')
  .of(contract)
  .flow(handleContract)
  .exits(contractExits)
  .retry({ tries: 1, backoff: 'none', exhausted: failed });

const storedContract = z.object({ data: contractSchema, state: z.string() });

const documentStore = http.store({
  load: async (unit, ctx) => {
    const response = await fetch(`${ctx.resolve(docsUrl)}/contracts/${unit.key}`, {
      headers: { authorization: `Bearer ${ctx.resolve(docsToken)}` },
    });
    if (!response.ok) return undefined;
    const stored = storedContract.parse(await response.json());
    return { data: stored.data, state: stored.state };
  },
  save: async (unit, change, ctx) => {
    const response = await fetch(`${ctx.resolve(docsUrl)}/contracts/${unit.key}`, {
      method: 'PUT',
      headers: { authorization: `Bearer ${ctx.resolve(docsToken)}`, 'content-type': 'application/json' },
      body: JSON.stringify(change),
    });
    if (!response.ok) throw new Error(`document system answered ${response.status}`);
  },
});

const webhookSecret = H.env('CONTRACT_WEBHOOK_SECRET');

const newContracts = (region: string) =>
  http.webhook({ path: `/${region}/contracts`, schema: contractSchema, secret: webhookSecret }).key(d => d.id);

const redlines = (region: string) =>
  http
    .webhook({
      path: `/${region}/redlines`,
      schema: z.object({ contractId: z.string(), text: z.string() }),
      secret: webhookSecret,
    })
    .map(r => ({ id: r.contractId, redline: r.text }))
    .key(d => d.id)
    .updatesOnly();

const category = H.facet('contract-category');

const eu = H.lane('contracts-eu', euHandler)
  .from(newContracts('eu'), redlines('eu'), supply.manual())
  .store(documentStore)
  .wip(3)
  .facet(category, d => d.category);

const us = H.lane('contracts-us', usHandler)
  .from(newContracts('us'), redlines('us'), supply.manual())
  .store(documentStore)
  .wip(3)
  .facet(category, d => d.category);

const redlineWhileWaitingOnCounsel = [eu, us].map(lane =>
  H.trigger(`${lane.name}-redline-reenters-draft`)
    .on(lane.updated())
    .when(p => p.attempt !== undefined && p.attempt.step === 'counsel' && p.unit.data.redline !== p.previous.redline)
    .do(lane.move(received)),
);

const redlineDuringDraft = H.trigger('redline-during-draft-reenters-at-counsel')
  .on(counsel.opened())
  .when(p => p.unit.updatedAt.getTime() > p.attempt.startedAt.getTime())
  .do(eu.move(received), us.move(received));

const signoffTimeout = H.trigger('signoff-timeout')
  .on(signoff.opened().after('30m'))
  .do(H.ops.resolve(signoff).with(p => ({ approved: p.context.amountUsd < 500 })));

const signoffDeputy = H.trigger('signoff-page-deputy')
  .on(signoff.opened().after('20m'))
  .do(pageDeputy.with(p => ({ title: p.context.title, amountUsd: p.context.amountUsd })));

const counselApproval = H.metric('counsel-approval-rate').rate(
  H.events.decisions(counsel, { match: d => d.action === 'approve' }),
  H.events.decisions(counsel),
);

const provenCategory = H.policy.halt('skip-counsel-for-proven-category', counsel, input => {
  const reading = input.metrics.read(counselApproval, {
    where: { facet: { facet: category, value: input.context.category } },
  });
  return reading.samples >= 200 && reading.value === 1
    ? { action: 'approve', notes: `skipped: ${reading.samples} approvals, no returns` }
    : undefined;
});

const skipCounsel = H.trigger('skip-counsel').on(counsel.opened()).do(H.ops.resolve(counsel).by(provenCategory));

const counselByHuman = H.metric('counsel-decision-time-human').median(H.events.decisions(counsel, { resolver: 'human' }), 'waitSeconds');
const counselByPolicy = H.metric('counsel-decision-time-policy').median(H.events.decisions(counsel, { resolver: 'policy' }), 'waitSeconds');
const signoffByHuman = H.metric('signoff-decision-time-human').median(H.events.decisions(signoff, { resolver: 'human' }), 'waitSeconds');
const signoffByClock = H.metric('signoff-decision-time-clock').median(H.events.decisions(signoff, { resolver: 'clock' }), 'waitSeconds');
const retriesPerLane = H.metric('retries').count(H.events.attempts({ outcome: 'failed' }));
const signoffTimeoutShare = H.metric('signoff-timeout-share').rate(
  H.events.decisions(signoff, { resolver: 'clock' }),
  H.events.decisions(signoff),
);

const counselDashboard = http.client('counsel-dashboard', { port: 8441, token: H.env('COUNSEL_TOKEN') });
const finance = claudeCode.client('finance', { session: 'finance' });
const financeDeputy = claudeCode.client('finance-deputy', { session: 'finance-deputy' });
const auditorClient = http.client('decision-auditor', { port: 8442, token: H.env('AUDITOR_TOKEN') });

export const contracts = H.harness('contracts')
  .ledger(sqlite.ledger('./contracts/.harness/ledger.sqlite'))
  .pools(H.pool('drafting', [subscription]).serves(opus).policy(policies.soonestExpiring()).fallback(api))
  .lanes(eu, us)
  .triggers(...redlineWhileWaitingOnCounsel, redlineDuringDraft, signoffTimeout, signoffDeputy, skipCounsel)
  .scheduler(H.scheduler().policy(H.policy.schedule('oldest-first', input => [...input.candidates].sort((a, b) => b.waitingSeconds - a.waitingSeconds))))
  .grants(
    H.grant(counselDashboard, H.ops.resolve(counsel)),
    H.grant(finance, H.ops.resolve(signoff)),
    H.grant(financeDeputy, H.ops.resolve(signoff)),
    H.grant(auditorClient, H.ops.telemetry.read),
  )
  .metrics(counselApproval, counselByHuman, counselByPolicy, signoffByHuman, signoffByClock, retriesPerLane, signoffTimeoutShare)
  .observe(observers.board({ path: './contracts/BOARD.md' }), observers.telemetry({ path: './contracts/TELEMETRY.md' }));
