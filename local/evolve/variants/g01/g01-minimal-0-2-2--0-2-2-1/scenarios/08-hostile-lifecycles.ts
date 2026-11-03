import { H } from 'harness-dsl';
import type { SupplyOf } from 'harness-dsl';
import { z } from 'zod';
import * as anthropic from 'harness-dsl/anthropic';
import * as claude from 'harness-dsl/claude-code';
import * as sqlite from 'harness-dsl/sqlite';
import * as shell from 'harness-dsl/shell';
import * as http from 'harness-dsl/http';
import * as markdown from 'harness-dsl/markdown';

const box = shell.local('local', { slots: 4 });
const model = anthropic.model('claude-sonnet');
const api = anthropic.account('anthropic-api', { apiKey: H.env('ANTHROPIC_API_KEY') });

const experiment = H.kind('Experiment')
  .data(z.object({ name: z.string(), days: z.number() }))
  .states(
    H.state('scheduled', 'pending'),
    H.state('observing', 'waiting'),
    H.state('aWins', 'terminal', 'success'),
    H.state('bWins', 'terminal', 'success'),
    H.state('inconclusive', 'terminal', 'neutral')
  );

const measure = H.command('measureExperiment')
  .input(z.object({ name: z.string() }))
  .output(z.object({ a: z.number(), b: z.number() }))
  .argv((i) => ['./scripts/measure.sh', i.name])
  .on(box)
  .retries(2, { first: { minutes: 1 } });

const analyse = H.command('analyseExperiment')
  .input(z.object({ name: z.string() }))
  .output(z.object({ winner: z.enum(['a', 'b', 'none']) }))
  .argv((i) => ['./scripts/analyse.sh', i.name])
  .on(box);

const inconclusiveShare = H.policy.rule('inconclusiveShare', (input: { days: number }, metrics) =>
  metrics.rate({
    among: { entry: 'transition', kind: experiment, position: 'terminal' },
    count: { entry: 'transition', kind: experiment, state: 'inconclusive' },
    days: input.days,
  })
);

const observe = H.flow('observe')
  .for(experiment)
  .does(async (ctx) => {
    const history = await ctx.decide(inconclusiveShare, { days: 180 });
    const extendWeek = history.samples >= 10 && history.value !== null && history.value > 0.5;
    const hours = ctx.unit.data.days * 24 + (extendWeek ? 7 * 24 : 0);
    for (let hour = 0; hour < hours; hour++) {
      await ctx.run(measure, { name: ctx.unit.data.name });
      await ctx.wait('observing', { at: new Date(ctx.now().getTime() + 3_600_000) });
    }
    const verdict = await ctx.run(analyse, { name: ctx.unit.data.name });
    if (!verdict.ok) return ctx.fail(verdict.error);
    return verdict.value.winner === 'a' ? 'aWins' : verdict.value.winner === 'b' ? 'bWins' : 'inconclusive';
  });

const experiments = H.lane('experiments', experiment)
  .handler(observe)
  .suppliers(H.operator)
  .store(sqlite.store(experiment, './.harness/experiments.db'));

const tenancy = H.kind('Tenancy')
  .data(
    z.object({
      customer: z.string(),
      plan: z.string(),
      lastSummary: z.string(),
      lastDecision: z.enum(['none', 'upsell', 'hold']),
    })
  )
  .states(
    H.state('due', 'pending'),
    H.state('current', 'waiting'),
    H.state('suspended', 'waiting'),
    H.state('churned', 'terminal', 'neutral')
  );

const usageReport = H.command('usageReport')
  .input(z.object({ customer: z.string() }))
  .output(z.object({ seats: z.number(), apiCalls: z.number() }))
  .argv((i) => ['./scripts/usage.sh', i.customer])
  .on(box);

const accountManagerRole = H.role('accountManager')
  .input(z.object({ customer: z.string(), plan: z.string(), seats: z.number(), apiCalls: z.number() }))
  .output(z.object({ summary: z.string() }))
  .prompt((i) => `Summarise this month for ${i.customer} on ${i.plan}: ${i.seats} seats, ${i.apiCalls} API calls.`);

const accountManager = H.seat('accountManager', accountManagerRole).model(model);

const upsellDecision = H.halt('upsellDecision', z.object({ upsell: z.boolean(), note: z.string() })).about(
  z.object({ customer: z.string() })
);

const monthlyReview = H.flow('monthlyReview')
  .for(tenancy)
  .does(async (ctx) => {
    const { customer, plan } = ctx.unit.data;
    const usage = await ctx.run(usageReport, { customer });
    if (!usage.ok) return ctx.fail(usage.error);
    const summary = await ctx.run(accountManager, { customer, plan, seats: usage.value.seats, apiCalls: usage.value.apiCalls });
    if (!summary.ok) return ctx.fail(summary.error);
    const decision = await ctx.halt(upsellDecision, summary.value.summary, { customer });
    await ctx.update({ lastSummary: summary.value.summary, lastDecision: decision.upsell ? 'upsell' : 'hold' });
    return 'current';
  });

const firstOfMonth = H.clock('firstOfMonth', tenancy, { daily: '06:00' }, (tick) =>
  tick.now.getUTCDate() === 1
    ? tick.units.filter((u) => u.state === 'current').map((u): SupplyOf<typeof tenancy> => ({ update: u.key, state: 'due' }))
    : []
);

const billing = http.webhook(tenancy, {
  path: '/billing',
  secret: H.env('BILLING_WEBHOOK_SECRET'),
  body: z.object({
    customer: z.string(),
    plan: z.string(),
    event: z.enum(['signup', 'suspended', 'reinstated', 'churned']),
  }),
  read: (b): SupplyOf<typeof tenancy> | null =>
    b.event === 'signup'
      ? { create: { customer: b.customer, plan: b.plan, lastSummary: '', lastDecision: 'none' }, key: b.customer }
      : {
          update: b.customer,
          state: b.event === 'suspended' ? 'suspended' : b.event === 'reinstated' ? 'current' : 'churned',
          deferred: true,
        },
});

const tenancies = H.lane('tenancies', tenancy)
  .handler(monthlyReview)
  .suppliers(billing, firstOfMonth)
  .store(sqlite.store(tenancy, './.harness/tenancies.db'))
  .wip(3);

const negotiation = H.kind('Negotiation')
  .data(
    z.object({
      vendor: z.string(),
      item: z.string(),
      expiresAt: z.string(),
      vendorMessage: z.string(),
      ourLastOffer: z.string(),
    })
  )
  .states(
    H.state('drafting', 'pending'),
    H.state('awaitingVendor', 'waiting'),
    H.state('agreed', 'terminal', 'success'),
    H.state('weWalkedAway', 'terminal', 'neutral'),
    H.state('theyWalkedAway', 'terminal', 'failure'),
    H.state('expired', 'terminal', 'failure')
  );

const negotiatorRole = H.role('negotiator')
  .input(z.object({ vendor: z.string(), item: z.string(), vendorMessage: z.string(), ourLastOffer: z.string() }))
  .output(z.object({ action: z.enum(['offer', 'walkAway']), offer: z.string() }))
  .prompt((i) => `Vendor ${i.vendor} on ${i.item} said: ${i.vendorMessage}\nOur last offer: ${i.ourLastOffer}\nDraft the next offer or walk away.`);

const negotiator = H.seat('negotiator', negotiatorRole).model(model);

const sendOffer = H.command('sendOffer')
  .input(z.object({ vendor: z.string(), offer: z.string() }))
  .argv((i) => ['./scripts/send-offer.sh', i.vendor, i.offer])
  .on(box)
  .recovery('park');

const negotiationRound = H.flow('negotiationRound')
  .for(negotiation)
  .does(async (ctx) => {
    const next = await ctx.run(negotiator, {
      vendor: ctx.unit.data.vendor,
      item: ctx.unit.data.item,
      vendorMessage: ctx.unit.data.vendorMessage,
      ourLastOffer: ctx.unit.data.ourLastOffer,
    });
    if (!next.ok) return ctx.fail(next.error);
    if (next.value.action === 'walkAway') return 'weWalkedAway';
    const sent = await ctx.run(sendOffer, { vendor: ctx.unit.data.vendor, offer: next.value.offer });
    if (!sent.ok) return ctx.fail(sent.error);
    await ctx.update({ ourLastOffer: next.value.offer });
    return 'awaitingVendor';
  });

const vendorReplies = http.webhook(negotiation, {
  path: '/vendor-replies',
  secret: H.env('VENDOR_WEBHOOK_SECRET'),
  body: z.object({ negotiation: z.string(), status: z.enum(['counter', 'accepted', 'walkedAway']), message: z.string() }),
  read: (b) => ({
    update: b.negotiation,
    patch: { vendorMessage: b.message },
    state: b.status === 'accepted' ? 'agreed' : b.status === 'walkedAway' ? 'theyWalkedAway' : 'drafting',
    deferred: true,
  }),
});

const negotiations = H.lane('negotiations', negotiation)
  .handler(negotiationRound)
  .suppliers(H.operator, vendorReplies)
  .store(sqlite.store(negotiation, './.harness/negotiations.db'))
  .wip(2);

const negotiationExpires = H.trigger(
  'negotiationExpires',
  H.on.deadline(negotiation, (d) => new Date(d.expiresAt), ['drafting', 'awaitingVendor']),
  (event, act) => act.move('expired')
);

export const lifecycles = H.harness('lifecycles')
  .ledger(sqlite.ledger('./.harness/ledger.db'))
  .lanes(experiments, tenancies, negotiations)
  .pools(H.pool('accounts', [{ account: api, share: 1 }]))
  .triggers(negotiationExpires)
  .clients(
    claude.supervisor({
      grants: [H.ops.readWork, H.ops.writeWork, H.ops.resolve(upsellDecision, H.halts.interrupted), H.ops.readTelemetry],
    })
  )
  .observers(markdown.board('./BOARD.md'));
