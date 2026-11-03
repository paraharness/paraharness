import { z } from 'zod';
import { H } from 'harness-dsl';
import { sqlite } from 'harness-dsl/sqlite';
import { anthropic } from 'harness-dsl/anthropic';
import { claudeCode } from 'harness-dsl/claude-code';
import { http } from 'harness-dsl/http';
import { webhook } from 'harness-dsl/webhook';
import { ironclad } from 'harness-dsl/ironclad';
import { local } from 'harness-dsl/local';
import { markdown } from 'harness-dsl/markdown';

const workstation = local.runner('contracts-box').slots(4);

const api = anthropic.account('contracts-api', {
  apiKey: H.env('ANTHROPIC_API_KEY'),
  quota: sqlite.quota('contracts-quota', { path: './.harness/quota.sqlite' }),
});
const pool = H.pool('contracts-pool').accounts(api);
const opus = anthropic.model('opus', { id: 'claude-opus-4-1' });

const categorySchema = z.enum(['nda', 'msa', 'sow', 'dpa']);
const category = H.facet('contract-category', categorySchema);

const Received = H.state('Received', 'pending');
const NeedsAttention = H.state('NeedsAttention', 'waiting');
const Executed = H.terminal('Executed', 'success');
const Declined = H.terminal('Declined', 'failure');
const Rejected = H.terminal('Rejected', 'neutral');

const contractAttrs = z.object({
  contractId: z.string(),
  title: z.string(),
  amountUsd: z.number(),
  category: categorySchema,
  document: z.string(),
  redlines: z.array(z.string()),
});
const contract = H.kind('Contract')
  .attributes(contractAttrs)
  .states(Received, NeedsAttention, Executed, Declined, Rejected)
  .key(a => a.contractId);

const counsel = H.halt('counsel').decision(z.object({ action: z.enum(['approve', 'return']), notes: z.string() }));
const signoff = H.halt('signoff').decision(z.object({ approved: z.boolean() }));

const counselApprovals = H.metric('counsel-approvals', H.when.decision(contract, counsel))
  .samples(e => e.resolvedBy === 'human' ? [{ hit: e.decision.action === 'approve', facets: e.facets, halt: counsel }] : []);

const counselSkip = H.policy.halt('counsel-skip', contract, counsel, ctx => {
  const record = ctx.metrics.rate(counselApprovals, { facets: ctx.facets, window: { lastDays: 365 } });
  return record.samples >= 200 && record.hits === record.samples
    ? { action: 'approve', notes: `skipped: ${record.hits} of ${record.samples} approved in this category` }
    : undefined;
});

const drafterRole = H.role('contract-drafter')
  .intents('read', 'edit')
  .instructions('Draft the contract. Apply every counterparty redline and every counsel note from earlier rounds.');

const drafter = H.seat('contract-drafter')
  .role(drafterRole)
  .model(opus)
  .pool(pool)
  .output(z.object({ document: z.string() }));

const pageDeputy = H.command('page-finance-deputy').argv(['./scripts/page.sh', 'finance-deputy']).runner(workstation);

const executeContract = H.command('execute-contract')
  .input(z.object({ contractId: z.string(), document: z.string() }))
  .argv(i => ['./scripts/execute.sh', i.contractId, i.document])
  .runner(workstation);

const counselRound = z.object({ notes: z.string() });

const contractFlow = H.flow('contract')
  .input(contractAttrs)
  .loop('rounds', counselRound, round => round
    .step('draft', drafter, ctx => ({
      task: [
        `${ctx.unit.attributes.title}\n\n${ctx.unit.attributes.document}`,
        `Redlines:\n${ctx.unit.attributes.redlines.join('\n')}`,
        ...ctx.steps.rounds.map((r, i) => `Counsel return ${i + 1}: ${r.notes}`),
      ].join('\n\n'),
    }))
    .halt('counsel', counsel, {
      ask: ctx => ctx.steps.draft.document,
      skip: counselSkip,
      facets: ctx => [category.of(ctx.unit.attributes.category)],
    }),
  {
    max: 2,
    until: ctx => ctx.steps.counsel.action === 'approve',
    feed: ctx => ({ notes: ctx.steps.counsel.notes }),
  })
  .exit('declined', ctx => ctx.steps.counsel.action === 'return')
  .halt('signoff', signoff, {
    ask: ctx => `Sign off ${ctx.unit.attributes.title} for $${ctx.unit.attributes.amountUsd}?`,
    facets: ctx => [category.of(ctx.unit.attributes.category)],
    escalate: { afterMinutes: 20, run: pageDeputy },
    timeout: { afterMinutes: 30, decide: ctx => ({ approved: ctx.unit.attributes.amountUsd < 500 }) },
  })
  .exit('rejected', ctx => !ctx.steps.signoff.approved)
  .step('execute', executeContract, ctx => ({ contractId: ctx.unit.attributes.contractId, document: ctx.steps.draft.document }), {
    afterCrash: 'park',
  })
  .exit('executed');

const redline = H.signal('redline').payload(z.object({ text: z.string() }));

const contractEvents = webhook.json('contract-events', {
  port: H.slot.port(3),
  path: '/contracts',
  secret: H.env('CONTRACTS_WEBHOOK_SECRET'),
  payload: z.object({
    type: z.enum(['new', 'redline']),
    region: z.enum(['eu', 'us']),
    contractId: z.string(),
    title: z.string(),
    amountUsd: z.number(),
    category: categorySchema,
    document: z.string(),
    redline: z.string(),
  }),
});

const documents = ironclad.store({ workspace: 'legal', token: H.env('IRONCLAD_TOKEN') });
const exits = { declined: Declined, rejected: Rejected, executed: Executed };

const contractsEu = H.lane('contracts-eu', contract)
  .supply(contractEvents, (e, to) => e.region !== 'eu'
    ? to.skip()
    : e.type === 'new'
      ? to.create({ contractId: e.contractId, title: e.title, amountUsd: e.amountUsd, category: e.category, document: e.document, redlines: [] })
      : to.signal(redline, e.contractId, { text: e.redline }))
  .supply(H.operator)
  .store(documents)
  .handler(contractFlow, { exits })
  .retry({ maxAttempts: 4, backoff: 'exponential', initialDelayMs: 60000, exhausted: NeedsAttention })
  .on(redline, { update: (a, p) => ({ ...a, redlines: [...a.redlines, p.text] }), rewind: 'draft', at: ['counsel'] });

const contractsUs = H.lane('contracts-us', contract)
  .supply(contractEvents, (e, to) => e.region !== 'us'
    ? to.skip()
    : e.type === 'new'
      ? to.create({ contractId: e.contractId, title: e.title, amountUsd: e.amountUsd, category: e.category, document: e.document, redlines: [] })
      : to.signal(redline, e.contractId, { text: e.redline }))
  .supply(H.operator)
  .store(documents)
  .handler(contractFlow, { exits })
  .retry({ maxAttempts: 2, exhausted: NeedsAttention })
  .on(redline, { update: (a, p) => ({ ...a, redlines: [...a.redlines, p.text] }), rewind: 'draft', at: ['counsel'] });

const counselDashboard = http.controlApi('counsel-dashboard', {
  port: H.slot.port(1),
  token: H.env('COUNSEL_TOKEN'),
  grants: [H.ops.workRead, H.ops.resolve(counsel)],
});

const finance = claudeCode.supervisor('finance', {
  port: H.slot.port(0),
  grants: [H.ops.workRead, H.ops.resolve(signoff)],
});

const auditor = http.controlApi('decision-auditor', {
  port: H.slot.port(2),
  token: H.env('AUDITOR_TOKEN'),
  grants: [H.ops.workRead, H.ops.telemetryRead],
});

const legalOps = claudeCode.supervisor('legal-ops', {
  port: H.slot.port(4),
  grants: [H.ops.workRead, H.ops.workCreate, H.ops.workUpdate, H.ops.attemptsRecover, H.ops.telemetryRead],
});

export default H.harness('contracts')
  .ledger(sqlite.ledger({ path: './.harness/ledger.sqlite' }))
  .lanes(contractsEu, contractsUs)
  .metrics(counselApprovals)
  .scheduler(H.scheduler('contracts-scheduler').standard(contractsEu, contractsUs).wip([contractsEu, contractsUs], 3))
  .clients(counselDashboard, finance, auditor, legalOps)
  .observers(
    markdown.board({ path: './.harness/BOARD.md' }),
    markdown.telemetry({ path: './.harness/TELEMETRY.md' }),
  );
