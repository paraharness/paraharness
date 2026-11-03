import { z } from 'zod';
import { H } from 'harness-dsl';
import { anthropic } from 'harness-dsl/anthropic';
import { claudeCode } from 'harness-dsl/claude-code';
import { sqlite } from 'harness-dsl/sqlite';
import { http } from 'harness-dsl/http';
import { shell } from 'harness-dsl/shell';
import { markdown } from 'harness-dsl/markdown';

const api = anthropic.account({ name: 'ops-api', key: H.env('ANTHROPIC_API_KEY') });
const sonnet = anthropic.model({ name: 'sonnet', id: 'claude-sonnet-4-5', account: api, price: { inputUsdPerMTok: 3, outputUsdPerMTok: 15 } });
const local = shell.local({ name: 'local', slots: 4 });
const hourMs = 3_600_000;

const Experiment = H.kind('Experiment', {
  data: z.object({ experimentId: z.string(), hypothesis: z.string(), endsAt: z.string() }),
  states: {
    proposed: 'pending',
    measuring: 'active',
    resting: 'pending',
    aWins: 'concluded',
    bWins: 'concluded',
    inconclusive: 'concluded',
    withdrawn: 'cancelled',
  },
  initial: 'proposed',
});

const Measurement = z.object({ aConversions: z.number(), aVisitors: z.number(), bConversions: z.number(), bVisitors: z.number() });

const verdict = (m: z.infer<typeof Measurement>): 'aWins' | 'bWins' | 'inconclusive' => {
  if (m.aVisitors === 0 || m.bVisitors === 0) return 'inconclusive';
  const pa = m.aConversions / m.aVisitors;
  const pb = m.bConversions / m.bVisitors;
  const pooled = (m.aConversions + m.bConversions) / (m.aVisitors + m.bVisitors);
  const se = Math.sqrt(pooled * (1 - pooled) * (1 / m.aVisitors + 1 / m.bVisitors));
  if (se === 0) return 'inconclusive';
  const zScore = (pa - pb) / se;
  return zScore > 1.96 ? 'aWins' : zScore < -1.96 ? 'bWins' : 'inconclusive';
};

const experimentFlow = H.flow('experiment-hour', { kinds: [Experiment] })
  .mark('measuring')
  .step('measure', (ctx) => H.command('experiment-metric', { argv: ['bin/experiment-metric', ctx.unit.data.experimentId], output: Measurement }), {
    retry: { maxRetries: 2, backoff: 'fixed', baseSeconds: 300 },
  })
  .end((ctx) => (ctx.now.getTime() >= Date.parse(ctx.unit.data.endsAt) ? verdict(ctx.out.measure) : 'resting'), {
    resumeAt: (ctx) => new Date(ctx.now.getTime() + hourMs),
  });

const experimentLane = H.lane(Experiment)
  .from(H.operator)
  .store(sqlite.store(Experiment, { path: '.harness/experiments.sqlite' }))
  .handle(experimentFlow)
  .states({
    measuring: 'measuring',
    resting: 'resting',
    aWins: 'aWins',
    bWins: 'bWins',
    inconclusive: 'inconclusive',
    failed: 'resting',
    cancelled: 'withdrawn',
  })
  .runOn(local);

const TenancyStatus = z.enum(['active', 'suspended', 'churned']);

const Tenancy = H.kind('Tenancy', {
  data: z.object({ customer: z.string(), plan: z.string(), seats: z.number(), status: TenancyStatus }),
  states: {
    signedUp: 'pending',
    reviewing: 'active',
    current: 'pending',
    suspended: 'pending',
    churned: 'concluded',
  },
  initial: 'signedUp',
  tags: (tenancy) => [tenancy.plan],
});

const BillingEvent = z.object({ customer: z.string(), plan: z.string(), seats: z.number(), status: TenancyStatus });

const billingWebhook = http.webhook(Tenancy, {
  path: '/billing',
  port: H.slot.port(8701),
  secret: H.env('BILLING_WEBHOOK_SECRET'),
  parse: (body) => {
    const parsed = BillingEvent.safeParse(body);
    return parsed.success ? [{ key: `tenancy-${parsed.data.customer}`, data: parsed.data, mode: 'upsert' }] : [];
  },
});

const accountManager = H.role('accountManager', {
  instructions: "Summarize the tenancy's month: usage against plan, risks, and whether an upsell is warranted.",
  intents: ['read'],
});

const UsageReport = z.object({ activeSeats: z.number(), usagePct: z.number(), notes: z.array(z.string()) });

const firstOfNextMonth = (now: Date) => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1, 6));

const tenancyFlow = H.flow('tenancy-review', { kinds: [Tenancy] })
  .end(
    (ctx) => (ctx.unit.data.status === 'churned' ? 'churned' : ctx.unit.data.status === 'suspended' ? 'suspended' : undefined),
    { resumeOnUpdate: true },
  )
  .mark('reviewing')
  .step('usage', (ctx) => H.command('usage-review', { argv: ['bin/usage-review', ctx.unit.data.customer], output: UsageReport }))
  .step('summary', (ctx) =>
    H.ask(accountManager, {
      prompt: `Customer ${ctx.unit.data.customer} on ${ctx.unit.data.plan} with ${ctx.unit.data.seats} seats.\nUsage: ${JSON.stringify(ctx.out.usage)}`,
      output: z.object({ summary: z.string(), upsellCase: z.string() }),
    }),
  )
  .halt('upsell', {
    question: (ctx) => `${ctx.out.summary.summary}\n\nUpsell case: ${ctx.out.summary.upsellCase}\n\nUpsell ${ctx.unit.data.customer}?`,
    decision: z.object({ upsell: z.boolean(), note: z.string() }),
  })
  .step('recordDecision', (ctx) =>
    H.command('record-upsell-decision', {
      argv: ['bin/record-upsell-decision', ctx.unit.data.customer, ctx.out.upsell !== undefined && ctx.out.upsell.upsell ? 'upsell' : 'hold'],
    }),
  )
  .end('current', { resumeAt: (ctx) => firstOfNextMonth(ctx.now), resumeOnUpdate: true });

const tenancyLane = H.lane(Tenancy)
  .from(billingWebhook)
  .store(sqlite.store(Tenancy, { path: '.harness/tenancies.sqlite' }))
  .handle(tenancyFlow)
  .cast({ accountManager: sonnet })
  .states({ churned: 'churned', suspended: 'suspended', reviewing: 'reviewing', current: 'current', failed: 'current', cancelled: 'current' })
  .runOn(local);

const Negotiation = H.kind('Negotiation', {
  data: z.object({
    vendor: z.string(),
    item: z.string(),
    targetUsd: z.number(),
    walkAwayUsd: z.number(),
    expiresAt: z.string(),
    vendorStance: z.enum(['none', 'countered', 'accepted', 'walkedAway']),
    lastVendorMessage: z.string(),
  }),
  states: {
    opening: 'pending',
    drafting: 'active',
    awaitingVendor: 'pending',
    agreed: 'succeeded',
    walkedAwayByUs: 'concluded',
    walkedAwayByThem: 'concluded',
    expired: 'concluded',
    withdrawn: 'cancelled',
  },
  initial: 'opening',
});

const VendorReply = z.object({
  negotiationId: z.string(),
  stance: z.enum(['countered', 'accepted', 'walkedAway']),
  message: z.string(),
});

const vendorReplies = http.webhook(Negotiation, {
  path: '/vendor-replies',
  port: H.slot.port(8702),
  secret: H.env('VENDOR_WEBHOOK_SECRET'),
  parse: (body) => {
    const parsed = VendorReply.safeParse(body);
    return parsed.success
      ? [{ key: parsed.data.negotiationId, mode: 'update', patch: { vendorStance: parsed.data.stance, lastVendorMessage: parsed.data.message } }]
      : [];
  },
});

const negotiator = H.role('negotiator', {
  instructions: 'Draft the next offer toward the target price. Walk away only when the vendor cannot meet the walk-away price.',
  intents: ['read'],
});

const Offer = z.object({ action: z.enum(['offer', 'walkAway']), amountUsd: z.number(), message: z.string() });

const negotiationFlow = H.flow('negotiation-round', { kinds: [Negotiation] })
  .end((ctx) =>
    ctx.unit.data.vendorStance === 'accepted' ? 'agreed' : ctx.unit.data.vendorStance === 'walkedAway' ? 'walkedAwayByThem' : undefined,
  )
  .mark('drafting')
  .step('offer', (ctx) =>
    H.ask(negotiator, {
      prompt: `Vendor ${ctx.unit.data.vendor}, item ${ctx.unit.data.item}. Target $${ctx.unit.data.targetUsd}, walk away above $${ctx.unit.data.walkAwayUsd}.\nVendor's last message: ${ctx.unit.data.lastVendorMessage}`,
      output: Offer,
    }),
  )
  .end((ctx) => (ctx.out.offer.action === 'walkAway' ? 'walkedAwayByUs' : undefined), { note: (ctx) => ctx.out.offer.message })
  .step('send', (ctx) =>
    H.command('send-offer', {
      argv: ['bin/send-offer', ctx.unit.key, String(ctx.out.offer.amountUsd)],
      env: { OFFER_MESSAGE: ctx.out.offer.message },
    }),
  )
  .end('awaitingVendor', { resumeOnUpdate: true });

const negotiationLane = H.lane(Negotiation)
  .from(H.operator, vendorReplies)
  .store(sqlite.store(Negotiation, { path: '.harness/negotiations.sqlite' }))
  .handle(negotiationFlow)
  .cast({ negotiator: sonnet })
  .states({
    agreed: 'agreed',
    walkedAwayByThem: 'walkedAwayByThem',
    drafting: 'drafting',
    walkedAwayByUs: 'walkedAwayByUs',
    awaitingVendor: 'awaitingVendor',
    failed: 'opening',
    cancelled: 'withdrawn',
  })
  .runOn(local);

const negotiationExpires = H.trigger(
  'negotiation-expires',
  H.when.overdue(Negotiation, { in: ['opening', 'drafting', 'awaitingVendor'], at: (unit) => new Date(unit.data.expiresAt) }),
  (then) => then.cancel('expired'),
);

const projections = H.trigger('projections', H.when.transition(), (then) => [
  then.run(markdown.board({ path: 'BOARD.md' })),
  then.run(markdown.telemetry({ path: 'TELEMETRY.md', sinceDays: 90 })),
]);

const inconclusiveAware = H.policy.order('inconclusive-aware', (ctx) => {
  const experiments = ctx.metrics.outcomes({ kind: Experiment, sinceDays: 365 });
  const inconclusiveRate = experiments.samples === 0 ? 0 : experiments.byState.inconclusive / experiments.samples;
  const deferNewExperiments = experiments.samples >= 10 && inconclusiveRate > 0.5;
  const rank = (kind: string, state: string) => (deferNewExperiments && kind === Experiment.name && state === 'proposed' ? 1 : 0);
  return {
    order: [...ctx.pending].sort((a, b) => rank(a.kind, a.state) - rank(b.kind, b.state) || b.waitingSeconds - a.waitingSeconds),
  };
});

const supervisor = claudeCode.supervisor({
  name: 'business-supervisor',
  endpoint: H.slot.port(7408),
  grants: [H.op.readWork, H.op.createWork, H.op.writeWork, H.op.cancelWork, H.op.resolveBlocker, H.op.readTelemetry],
});

export const hostile = H.harness('hostile-lifecycles')
  .ledger(sqlite.ledger({ path: '.harness/ledger.sqlite' }))
  .lanes(experimentLane, tenancyLane, negotiationLane)
  .triggers(negotiationExpires, projections)
  .scheduler(inconclusiveAware)
  .clients(supervisor);

export const running = hostile.start();
