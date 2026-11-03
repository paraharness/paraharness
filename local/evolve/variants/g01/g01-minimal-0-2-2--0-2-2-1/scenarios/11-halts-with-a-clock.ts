import { H } from 'harness-dsl';
import type { Metrics, PendingView, SupplyOf } from 'harness-dsl';
import { z } from 'zod';
import * as anthropic from 'harness-dsl/anthropic';
import * as claude from 'harness-dsl/claude-code';
import * as sqlite from 'harness-dsl/sqlite';
import * as shell from 'harness-dsl/shell';
import * as http from 'harness-dsl/http';
import * as markdown from 'harness-dsl/markdown';

const box = shell.local('local', { slots: 3 });
const api = anthropic.account('anthropic-api', { apiKey: H.env('ANTHROPIC_API_KEY') });

const categorySchema = z.enum(['nda', 'msa', 'order', 'lease']);
const category = H.facet('category', categorySchema);

const contract = H.kind('Contract')
  .data(
    z.object({
      id: z.string(),
      title: z.string(),
      category: categorySchema,
      amountUsd: z.number(),
      latestRedline: z.string(),
      counselNotes: z.string(),
      draft: z.string(),
    })
  )
  .states(
    H.state('received', 'pending'),
    H.state('returned', 'pending'),
    H.state('executed', 'terminal', 'success'),
    H.state('declined', 'terminal', 'failure'),
    H.state('stalled', 'terminal', 'failure')
  );

const drafterRole = H.role('contractDrafter')
  .input(z.object({ title: z.string(), latestRedline: z.string(), counselNotes: z.string() }))
  .output(z.object({ draft: z.string() }))
  .prompt((i) => `Draft "${i.title}".\nCounterparty redline: ${i.latestRedline}\nCounsel notes: ${i.counselNotes}`);

const drafter = H.seat('drafter', drafterRole).model(anthropic.model('claude-opus'));

const counselDecision = z.object({ verdict: z.enum(['approve', 'return']), notes: z.string() });
const counselAbout = z.object({ category: categorySchema });
const counselReview = H.halt('counsel', counselDecision).about(counselAbout);

const skipCounselForProvenCategory = H.policy.rule(
  'skipCounselForProvenCategory',
  (about: z.infer<typeof counselAbout>, metrics): z.infer<typeof counselDecision> | null => {
    const record = metrics.rate({
      among: { ...counselReview.resolved(), resolver: 'human', facets: [category.of(about.category)] },
      count: { ...counselReview.resolved({ verdict: 'approve' }), resolver: 'human', facets: [category.of(about.category)] },
    });
    return record.samples >= 200 && record.hits === record.samples
      ? { verdict: 'approve', notes: `counsel skipped: ${record.hits} of ${record.samples} approved` }
      : null;
  }
);
const counsel = counselReview.policy(skipCounselForProvenCategory);

const signoff = H.halt('signoff', z.object({ approved: z.boolean() }))
  .about(z.object({ amountUsd: z.number() }))
  .timeout({ minutes: 30 }, (about) => ({ approved: about.amountUsd < 500 }));

const signoffHistory = H.policy.rule('signoffHistory', (input: { days: number }, metrics) =>
  metrics.rate({ among: signoff.resolved(), count: { ...signoff.resolved(), resolver: 'clock' }, days: input.days })
);

const execute = H.command('executeContract')
  .input(z.object({ id: z.string() }))
  .argv((i) => ['./scripts/execute-contract.sh', i.id])
  .on(box)
  .recovery('park');

const pageDeputy = H.command('pageDeputy')
  .input(z.object({ unit: z.string(), amountUsd: z.number() }))
  .argv((i) => ['./scripts/page-deputy.sh', i.unit, String(i.amountUsd)])
  .on(box);

const handleContract = H.flow('handleContract')
  .for(contract)
  .does(async (ctx) => {
    const data = ctx.unit.data;
    await ctx.facet(category, data.category);
    const drafted = await ctx.run(drafter, {
      title: data.title,
      latestRedline: data.latestRedline,
      counselNotes: data.counselNotes,
    });
    if (!drafted.ok) return ctx.fail(drafted.error);
    await ctx.update({ draft: drafted.value.draft });
    const review = await ctx.halt(counsel, drafted.value.draft, { category: data.category });
    if (review.verdict === 'return') {
      await ctx.update({ counselNotes: review.notes });
      return 'returned';
    }
    const timeouts = await ctx.decide(signoffHistory, { days: 30 });
    const signed = await ctx.halt(
      signoff,
      `${data.title}: $${data.amountUsd}. Recent signoffs resolved by timeout: ${timeouts.hits} of ${timeouts.samples}.`,
      { amountUsd: data.amountUsd }
    );
    if (!signed.approved) return 'declined';
    const executed = await ctx.run(execute, { id: data.id });
    if (!executed.ok) return ctx.fail(executed.error);
    return 'executed';
  });

const contractEvent = z.object({
  contractId: z.string(),
  event: z.enum(['created', 'redline']),
  title: z.string(),
  category: categorySchema,
  amountUsd: z.number(),
  text: z.string(),
});

const readContractEvent = (b: z.infer<typeof contractEvent>): SupplyOf<typeof contract> =>
  b.event === 'created'
    ? {
        create: {
          id: b.contractId,
          title: b.title,
          category: b.category,
          amountUsd: b.amountUsd,
          latestRedline: b.text,
          counselNotes: '',
          draft: '',
        },
        key: b.contractId,
      }
    : { update: b.contractId, patch: { latestRedline: b.text }, state: 'received', deferred: true };

const documents = http.store(contract, {
  url: 'https://docs.example.com/api/contracts',
  headers: { Authorization: H.env('DOCUMENTS_TOKEN') },
  stateField: 'harness_state',
});

const contractsEu = H.lane('contracts-eu', contract)
  .handler(handleContract)
  .suppliers(
    http.webhook(contract, { path: '/contracts/eu', secret: H.env('CONTRACTS_EU_SECRET'), body: contractEvent, read: readContractEvent }),
    H.operator
  )
  .store(documents)
  .wip(3)
  .retries(3, { backoff: { first: { minutes: 5 }, factor: 2, max: { hours: 2 } }, exhausted: 'stalled' });

const contractsUs = H.lane('contracts-us', contract)
  .handler(handleContract)
  .suppliers(
    http.webhook(contract, { path: '/contracts/us', secret: H.env('CONTRACTS_US_SECRET'), body: contractEvent, read: readContractEvent }),
    H.operator
  )
  .store(documents)
  .wip(3)
  .retries(1, { exhausted: 'stalled' });

const declineAfterSecondReturn = H.trigger(
  'declineAfterSecondReturn',
  H.on.enters(contract, 'returned', { times: 2 }),
  (event, act) => act.move('declined')
);

const pageDeputyAtTwentyMinutes = H.trigger('pageDeputyAtTwentyMinutes', H.on.halted(signoff, { minutes: 20 }), (event, act) =>
  act.run(pageDeputy, { unit: event.unit, amountUsd: event.about.amountUsd })
);

export const contractReport = (metrics: Metrics, monthStart: Date) => ({
  counselByHuman: metrics.median({ of: 'decisionMs', among: { ...counsel.resolved(), resolver: 'human' }, since: monthStart }),
  counselByPolicy: metrics.median({ of: 'decisionMs', among: { ...counsel.resolved(), resolver: 'policy' }, since: monthStart }),
  signoffByHuman: metrics.median({ of: 'decisionMs', among: { ...signoff.resolved(), resolver: 'human' }, since: monthStart }),
  signoffByClock: metrics.median({ of: 'decisionMs', among: { ...signoff.resolved(), resolver: 'clock' }, since: monthStart }),
  retriesEu: metrics.count({ of: { entry: 'attempt', status: 'retrying', lane: contractsEu }, since: monthStart }),
  retriesUs: metrics.count({ of: { entry: 'attempt', status: 'retrying', lane: contractsUs }, since: monthStart }),
  signoffTimeoutShare: metrics.rate({ among: signoff.resolved(), count: { ...signoff.resolved(), resolver: 'clock' }, since: monthStart }),
});

const contractOrder = H.policy.scheduler('largestFirstUnlessFinanceIsAway', (view) => {
  const timeouts = view.metrics.rate({ among: signoff.resolved(), count: { ...signoff.resolved(), resolver: 'clock' }, days: 1 });
  const financeAway = timeouts.samples >= 20 && timeouts.value !== null && timeouts.value > 0.5;
  const amount = (p: PendingView) => (p.is(contract) ? p.data.amountUsd : 0);
  return {
    start: [...view.pending].filter((p) => !financeAway || amount(p) < 500).sort((a, b) => amount(b) - amount(a)),
  };
});

export const contracts = H.harness('contracts')
  .ledger(sqlite.ledger('./.harness/ledger.db'))
  .lanes(contractsEu, contractsUs)
  .pools(H.pool('accounts', [{ account: api, share: 1 }]))
  .triggers(declineAfterSecondReturn, pageDeputyAtTwentyMinutes)
  .scheduler(contractOrder)
  .clients(
    http.control({ port: 8081, token: H.env('COUNSEL_TOKEN'), grants: [H.ops.resolve(counsel)] }),
    claude.supervisor({ grants: [H.ops.resolve(signoff)] }),
    http.control({ port: 8082, token: H.env('AUDITOR_TOKEN'), grants: [H.ops.readWork, H.ops.readTelemetry] })
  )
  .observers(markdown.board('./BOARD.md'), markdown.telemetry('./TELEMETRY.md'));
