import { z } from 'zod';
import { H, MetricRef, Retry } from 'harness-dsl';
import { sqlite } from 'harness-dsl/sqlite';
import { anthropic } from 'harness-dsl/anthropic';
import { claudeCode } from 'harness-dsl/claude-code';
import { http } from 'harness-dsl/http';
import { webhook } from 'harness-dsl/webhook';
import { ironclad } from 'harness-dsl/ironclad';
import { local } from 'harness-dsl/local';
import { markdown } from 'harness-dsl/markdown';

const quota = sqlite.quota('contracts-quota', { path: './.harness/quota.sqlite' });
const api = anthropic.account('api', { apiKey: H.env('ANTHROPIC_API_KEY'), quota });
const sonnet = anthropic.model('sonnet', { id: 'claude-sonnet-4-5' });
const firstEligible = H.policy.account('first-eligible', ctx =>
  ctx.candidates.find(c => c.cooldownUntil === undefined || c.cooldownUntil <= ctx.now),
);
const pool = H.pool('contracts-pool').accounts(api).drain(firstEligible);
const runner = local.runner('local');

const category = H.facet('category');

const counselDecision = z.object({ verdict: z.enum(['approve', 'return']), notes: z.string() });
type CounselDecision = z.infer<typeof counselDecision>;

const counsel = H.halt('counsel').decision(counselDecision);
const signoff = H.halt('signoff').decision(z.object({ approved: z.boolean() }));

const redline = H.signal('redline').payload(z.object({ text: z.string() }));

const drafterRole = H.role('contract-drafter').intents('read').instructions('Draft the contract and apply every pending redline.');
const drafter = H.seat('contract-drafter').role(drafterRole).model(sonnet).pool(pool).output(z.object({ document: z.string() }));

const skipCounsel = H.policy.halt(
  'skip-counsel-for-proven-category',
  counsel,
  z.object({ category: z.string() }),
  (ctx): CounselDecision | undefined => {
    const record = ctx.metrics.rate(counselApprovals, { by: { facets: [category.of(ctx.input.category)] } });
    return record.samples >= 200 && record.hits === record.samples
      ? { verdict: 'approve', notes: `skipped by policy: ${record.samples} approvals, no returns` }
      : undefined;
  },
);

const pageDeputy = H.command('page-finance-deputy').argv(['./bin/page', 'finance-deputy']).runner(runner);

const execute = H.command('execute-contract')
  .input(z.object({ contractId: z.string() }))
  .argv(i => ['./bin/execute', i.contractId])
  .runner(runner);

const contractAttrs = z.object({
  contractId: z.string(),
  counterparty: z.string(),
  category: z.string(),
  amountUsd: z.number(),
  redlines: z.array(z.string()),
});

const Received = H.state('Received', 'pending');
const Drafting = H.state('Drafting', 'active');
const WithCounsel = H.state('WithCounsel', 'waiting');
const AwaitingSignoff = H.state('AwaitingSignoff', 'waiting');
const Executing = H.state('Executing', 'active');
const Executed = H.terminal('Executed', 'success');
const Declined = H.terminal('Declined', 'failure');
const SignoffRejected = H.terminal('SignoffRejected', 'failure');
const DraftFailed = H.terminal('DraftFailed', 'failure');

const Contract = H.kind('Contract')
  .attributes(contractAttrs)
  .states(Received, Drafting, WithCounsel, AwaitingSignoff, Executing, Executed, Declined, SignoffRejected, DraftFailed)
  .key(a => a.contractId)
  .initial(Received);

const contractFlow = H.flow('contract')
  .input(contractAttrs)
  .loop(
    'counselRounds',
    f =>
      f
        .step('draft', drafter, ctx => ({
          task: `Draft contract ${ctx.unit.attributes.contractId} with ${ctx.unit.attributes.counterparty}. Redlines:\n${ctx.unit.attributes.redlines.join('\n')}`,
        }))
        .halt('counsel', counsel, {
          ask: ctx => ctx.steps.draft.document,
          skip: { by: skipCounsel, input: ctx => ({ category: ctx.unit.attributes.category }) },
        }),
    { max: 2, until: ctx => ctx.steps.counsel.verdict === 'approve' },
  )
  .exit('declined', ctx => ctx.steps.counsel.verdict === 'return')
  .halt('signoff', signoff, {
    ask: ctx => `Sign off contract ${ctx.unit.attributes.contractId} for ${ctx.unit.attributes.amountUsd} USD`,
    timeout: { afterMinutes: 30, decide: ctx => ({ approved: ctx.unit.attributes.amountUsd < 500 }) },
    escalate: { afterMinutes: 20, run: pageDeputy },
  })
  .exit('rejected', ctx => !ctx.steps.signoff.approved)
  .step('execute', execute, ctx => ({ contractId: ctx.unit.attributes.contractId }), { afterCrash: 'park' })
  .exit('executed');

const contractEvents = webhook.json('contract-events', {
  port: H.slot.port(1),
  path: '/contracts',
  secret: H.env('CONTRACTS_SECRET'),
  payload: z.discriminatedUnion('type', [
    z.object({
      type: z.literal('new'),
      region: z.enum(['eu', 'us']),
      contractId: z.string(),
      counterparty: z.string(),
      category: z.string(),
      amountUsd: z.number(),
    }),
    z.object({ type: z.literal('redline'), contractId: z.string(), text: z.string() }),
  ]),
});

const documents = ironclad.store({ workspace: 'legal', token: H.env('DOCUMENTS_TOKEN') });

const contractLane = (name: string, region: 'eu' | 'us', retry: Retry) =>
  H.lane(name, Contract)
    .supply(contractEvents, (e, to) =>
      e.type === 'redline'
        ? to.signal(redline, e.contractId, { text: e.text })
        : e.region === region
          ? to.create({ contractId: e.contractId, counterparty: e.counterparty, category: e.category, amountUsd: e.amountUsd, redlines: [] })
          : to.skip(),
    )
    .supply(H.operator)
    .store(documents)
    .handler(contractFlow, {
      exits: { declined: Declined, rejected: SignoffRejected, executed: Executed },
      during: { draft: Drafting, execute: Executing, counsel: WithCounsel, signoff: AwaitingSignoff },
    })
    .retry({ ...retry, exhausted: DraftFailed })
    .on(redline, {
      update: (a, p) => ({ ...a, redlines: [...a.redlines, p.text] }),
      restart: { to: 'draft', at: ['counsel'] },
    });

const contractsEu = contractLane('contracts-eu', 'eu', { maxAttempts: 4, backoff: 'exponential', initialDelayMs: 60000 });
const contractsUs = contractLane('contracts-us', 'us', { maxAttempts: 2, backoff: 'fixed', initialDelayMs: 60000 });

const counselApprovals: MetricRef<'rate'> = H.metric('counsel-approvals', H.when.decision([contractsEu, contractsUs], counsel))
  .facets(category)
  .samples(e =>
    e.resolvedBy === 'human' ? [{ hit: e.decision.verdict === 'approve', by: { facets: [category.of(e.unit.attributes.category)] } }] : [],
  );

const signoffByTimeout = H.metric('signoff-resolved-by-timeout', H.when.decision([contractsEu, contractsUs], signoff)).samples(e => [
  { hit: e.resolvedBy === 'timeout' },
]);

void H.harness('contracts')
  .ledger(sqlite.ledger({ path: './.harness/ledger.sqlite' }))
  .lanes(contractsEu, contractsUs)
  .metrics(counselApprovals, signoffByTimeout)
  .scheduler(H.scheduler('contracts').priority(contractsEu, contractsUs).wip(contractsEu, 3).wip(contractsUs, 3))
  .clients(
    http.controlApi('counsel-dashboard', {
      port: H.slot.port(2),
      token: H.env('COUNSEL_TOKEN'),
      grants: [H.ops.workRead, H.ops.resolve(counsel)],
    }),
    claudeCode.supervisor('finance').client('finance-supervisor', { grants: [H.ops.workRead, H.ops.resolve(signoff)] }),
    http.controlApi('decision-auditor', {
      port: H.slot.port(3),
      token: H.env('AUDITOR_TOKEN'),
      grants: [H.ops.workRead, H.ops.telemetryRead],
    }),
  )
  .observers(markdown.board({ path: './BOARD.md' }), markdown.telemetry({ path: './TELEMETRY.md' }))
  .start();
