import { z } from 'zod';
import { H } from 'harness-dsl';
import type { Metrics, Measurement } from 'harness-dsl';
import * as anthropic from 'harness-dsl/anthropic';
import * as claudeCode from 'harness-dsl/claude-code';
import * as sqlite from 'harness-dsl/sqlite';
import * as shell from 'harness-dsl/shell';
import * as http from 'harness-dsl/http';
import * as markdown from 'harness-dsl/markdown';

const local = shell.local('local', { slots: 4 });
const apiAccount = anthropic.account('anthropic-api', { apiKey: H.env('ANTHROPIC_API_KEY') });
const draftModel = anthropic.model('claude-opus-4-1');
const categoryFacet = H.facet('contract-category', z.string());

const open = H.state('open', 'pending');
const returned = H.state('returned', 'pending');
const executed = H.state('executed', 'terminal', 'success');
const declined = H.state('declined', 'terminal', 'failure');
const refused = H.state('refused-by-finance', 'terminal', 'neutral');
const stalled = H.state('stalled', 'terminal', 'failure');

const contract = H.kind('contract')
  .data(
    z.object({
      title: z.string(),
      counterparty: z.string(),
      category: z.string(),
      amountUsd: z.number(),
      redlines: z.array(z.string()),
      counselNotes: z.string().optional(),
    })
  )
  .states(open, returned, executed, declined, refused, stalled);

const drafterRole = H.role('contract-drafter')
  .input(
    z.object({ title: z.string(), counterparty: z.string(), redlines: z.array(z.string()), counselNotes: z.string() })
  )
  .output(z.object({ document: z.string() }))
  .prompt(
    input =>
      `Draft "${input.title}" with ${input.counterparty}.\nRedlines:\n${input.redlines.join('\n')}\nCounsel notes: ${input.counselNotes}`
  );

const drafter = H.seat('contract-drafter', drafterRole).model(draftModel);

const counselDecision = z.object({ action: z.enum(['approve', 'return']), notes: z.string().optional() });
const counselAbout = z.object({ category: z.string(), title: z.string(), document: z.string() });
type CounselDecision = z.infer<typeof counselDecision>;
type CounselAbout = z.infer<typeof counselAbout>;

const skipCounselForProvenCategory = H.policy.rule(
  'skip-counsel-for-proven-category',
  (about: CounselAbout, metrics: Metrics): CounselDecision | null => {
    const inCategory = [categoryFacet.value(about.category)];
    const record = metrics.rate({
      among: { ...counsel.resolved(undefined, 'human'), facets: inCategory },
      count: { ...counsel.resolved({ action: 'return' }, 'human'), facets: inCategory },
    });
    return record.samples >= 200 && record.hits === 0 ? { action: 'approve' } : null;
  }
);

const counsel = H.halt('counsel', counselDecision).about(counselAbout).policy(skipCounselForProvenCategory);

const signoff = H.halt('signoff', z.object({ approved: z.boolean() }))
  .about(z.object({ title: z.string(), amountUsd: z.number() }))
  .timeout({ minutes: 30 }, about => ({ approved: about.amountUsd < 500 }));

const execute = H.command('execute-contract')
  .input(z.object({ contract: z.string(), document: z.string() }))
  .argv(input => ['docsys', 'execute', input.contract])
  .on(local)
  .recovery('park');

const pageDeputy = H.command('page-deputy')
  .input(z.object({ unit: z.string(), title: z.string() }))
  .argv(input => ['pager', 'notify', 'finance-deputy', input.unit, input.title])
  .on(local);

const handleContract = H.flow('handle-contract')
  .for(contract)
  .does(async ctx => {
    const data = ctx.unit.data;
    ctx.tag(categoryFacet, data.category);
    const draft = await ctx.run(drafter, {
      title: data.title,
      counterparty: data.counterparty,
      redlines: data.redlines,
      counselNotes: data.counselNotes ?? '',
    });
    if (draft.ok === false) return ctx.fail(draft.error);
    const review = await ctx.halt(counsel, draft.value.document, {
      category: data.category,
      title: data.title,
      document: draft.value.document,
    });
    if (review.action === 'return') {
      await ctx.update({ counselNotes: review.notes ?? '' });
      return 'returned';
    }
    const signed = await ctx.halt(signoff, `Sign off ${data.title} for $${data.amountUsd}`, {
      title: data.title,
      amountUsd: data.amountUsd,
    });
    if (signed.approved === false) return 'refused-by-finance';
    const done = await ctx.run(execute, { contract: ctx.unit.key, document: draft.value.document });
    if (done.ok === false) return ctx.fail(done.error);
    return 'executed';
  });

const contractEvent = z.object({
  contract: z.string(),
  event: z.enum(['new', 'redline']),
  title: z.string().optional(),
  counterparty: z.string().optional(),
  category: z.string().optional(),
  amountUsd: z.number().optional(),
  redlines: z.array(z.string()),
});

function contractWebhook(path: string) {
  return http.webhook(contract, {
    path,
    secret: H.env('DOCSYS_WEBHOOK_SECRET'),
    body: contractEvent,
    read: body =>
      body.event === 'new'
        ? {
            create: {
              title: body.title ?? body.contract,
              counterparty: body.counterparty ?? '',
              category: body.category ?? 'uncategorized',
              amountUsd: body.amountUsd ?? 0,
              redlines: body.redlines,
            },
            key: body.contract,
          }
        : { update: body.contract, patch: { redlines: body.redlines }, state: 'open', deferred: true },
  });
}

const documentStore = http.store(contract, {
  url: 'https://docsys.example.com/api/contracts',
  headers: { Authorization: H.env('DOCSYS_TOKEN') },
  stateField: 'harness_state',
});

const contractsEu = H.lane('contracts-eu', contract)
  .handler(handleContract)
  .suppliers(contractWebhook('/contracts/eu'), H.operator)
  .store(documentStore)
  .wip(3)
  .retry(H.retry({ times: 3, firstDelayMs: 60000, factor: 2 }), 'stalled');

const contractsUs = H.lane('contracts-us', contract)
  .handler(handleContract)
  .suppliers(contractWebhook('/contracts/us'), H.operator)
  .store(documentStore)
  .wip(3)
  .retry(H.retry({ times: 1 }), 'stalled');

const secondReturnDeclines = H.trigger(
  'second-return-declines',
  H.on.enters(contract, 'returned', { times: 2 }),
  (_event, act) => act.move('declined')
);

const deputyAfterTwentyMinutes = H.trigger('page-finance-deputy', H.on.halted(signoff, { minutes: 20 }), (event, act) =>
  act.run(pageDeputy, { unit: event.unit, title: event.about.title })
);

const decisionReport = H.report('contract-decisions', (metrics, now) => {
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const values: Record<string, Measurement> = {};
  const resolvers = ['human', 'policy', 'clock'] satisfies ('human' | 'policy' | 'clock')[];
  for (const halt of [counsel, signoff]) {
    for (const resolver of resolvers) {
      values[`medianDecisionMs.${halt.name}.${resolver}`] = metrics.median({
        of: 'decisionMs',
        among: { entry: 'halt', status: 'resolved', halt, resolver },
        since: monthStart,
      });
    }
  }
  for (const lane of [contractsEu, contractsUs]) {
    values[`retriesThisMonth.${lane.name}`] = metrics.count({
      of: { entry: 'attempt', status: 'retrying', lane },
      since: monthStart,
    });
  }
  values['signoffResolvedByTimeout'] = metrics.rate({
    among: signoff.resolved(),
    count: signoff.resolved(undefined, 'clock'),
    since: monthStart,
  });
  return values;
});

export const contracts = H.harness('contracts')
  .ledger(sqlite.ledger('/srv/contracts/ledger.db'))
  .lanes(contractsEu, contractsUs)
  .pools(H.pool('api', [{ account: apiAccount, share: 1 }]))
  .triggers(secondReturnDeclines, deputyAfterTwentyMinutes)
  .reports(decisionReport)
  .clients(
    http.control({ port: 8441, token: H.env('COUNSEL_TOKEN'), grants: [H.ops.resolve(counsel)] }),
    claudeCode.supervisor({ grants: [H.ops.resolve(signoff)] }),
    http.control({ port: 8442, token: H.env('AUDITOR_TOKEN'), grants: [H.ops.readTelemetry] }),
    http.control({
      port: 8443,
      token: H.env('OPERATOR_TOKEN'),
      grants: [H.ops.readWork, H.ops.writeWork, H.ops.resolve(H.parked)],
    })
  )
  .observers(markdown.board('/srv/contracts/BOARD.md'), markdown.telemetry('/srv/contracts/TELEMETRY.md'));

export const running = contracts.start();
