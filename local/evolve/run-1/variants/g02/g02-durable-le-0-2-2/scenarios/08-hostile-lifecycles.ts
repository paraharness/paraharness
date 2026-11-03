import { z } from 'zod';
import { H } from 'harness-dsl';
import { anthropic } from 'harness-dsl/anthropic';
import { claudeCode } from 'harness-dsl/claude-code';
import { local } from 'harness-dsl/local';
import { markdown } from 'harness-dsl/markdown';
import { sqlite } from 'harness-dsl/sqlite';
import { webhook } from 'harness-dsl/webhook';

const ops = local.runner('ops').slots(4);
const store = sqlite.store({ path: 'business/units.sqlite' });

const sonnet = anthropic.model('sonnet', { id: 'claude-sonnet-4-5' });
const businessAccount = anthropic.account('business', { apiKey: H.env('ANTHROPIC_API_KEY') });
const pool = H.pool('business').accounts(businessAccount).serves(sonnet);

const experiment = z.object({ name: z.string(), metric: z.string() });

const Queued = H.state('queued', 'pending');
const AWins = H.terminal('a-wins', 'success');
const BWins = H.terminal('b-wins', 'success');
const Inconclusive = H.terminal('inconclusive', 'neutral');
const Stopped = H.terminal('stopped', 'neutral');

const Experiment = H.kind('Experiment')
  .attributes(experiment)
  .states(Queued, AWins, BWins, Inconclusive, Stopped)
  .key(e => e.name)
  .initial(Queued)
  .onCancelled(Stopped);

const collect = H.command('collect-experiment-metric')
  .input(z.object({ experiment: z.string(), metric: z.string() }))
  .argv(target => ['experiment-metric', '--experiment', target.experiment, '--metric', target.metric])
  .output(z.object({ a: z.number(), b: z.number(), samples: z.number() }))
  .runner(ops);

const conclude = H.command('conclude-experiment')
  .input(z.object({ experiment: z.string() }))
  .argv(target => ['experiment-conclude', '--experiment', target.experiment])
  .output(z.object({ winner: z.enum(['a', 'b', 'inconclusive']) }))
  .runner(ops);

const experimentFlow = H.flow('experiment')
  .input(experiment)
  .loop(
    'hourly',
    flow =>
      flow
        .wait('nextHour', { ms: 3_600_000 })
        .step('collect', collect, ctx => ({
          experiment: ctx.unit.attributes.name,
          metric: ctx.unit.attributes.metric,
        })),
    { max: 336 },
  )
  .step('conclude', conclude, ctx => ({ experiment: ctx.unit.attributes.name }))
  .exit('aWins', ctx => ctx.steps.conclude.winner === 'a')
  .exit('bWins', ctx => ctx.steps.conclude.winner === 'b')
  .exit('inconclusive');

const experiments = H.lane('experiments', Experiment)
  .supply(H.operator)
  .store(store)
  .handler(experimentFlow, { exits: { aWins: AWins, bWins: BWins, inconclusive: Inconclusive } });

const tenancy = z.object({ customerId: z.string(), plan: z.string() });

const Current = H.state('current', 'waiting');
const Suspended = H.state('suspended', 'waiting');
const Churned = H.terminal('churned', 'neutral');

const Tenancy = H.kind('Tenancy')
  .attributes(tenancy)
  .states(Current, Suspended, Churned)
  .key(t => t.customerId)
  .initial(Current);

const MonthlyReview = H.signal('monthly-review').payload(z.object({ month: z.string() }));
const Suspend = H.signal('suspend');
const Reinstate = H.signal('reinstate');
const Churn = H.signal('churn');

const accountManager = H.role('account-manager')
  .intents('read')
  .instructions('Summarise the tenancy usage for the month and say whether an upsell conversation is warranted.');
const summarizer = H.agent('tenancy-summarizer').role(accountManager).model(sonnet);

const usage = H.command('tenancy-usage')
  .input(z.object({ customerId: z.string() }))
  .argv(target => ['usage-report', '--customer', target.customerId])
  .output(z.object({ seats: z.number(), activeUsers: z.number(), spendUsd: z.number() }))
  .runner(ops);

const tenancyFlow = H.flow('tenancy-review')
  .input(tenancy)
  .step('usage', usage, ctx => ({ customerId: ctx.unit.attributes.customerId }))
  .step('summary', summarizer, ctx => ({
    task: `Customer ${ctx.unit.attributes.customerId} on plan ${ctx.unit.attributes.plan}: ${ctx.steps.usage.activeUsers} of ${ctx.steps.usage.seats} seats active, $${ctx.steps.usage.spendUsd} spent this month.`,
  }))
  .halt('decision', z.object({ decision: z.enum(['upsell', 'hold']), note: z.string() }), {
    ask: ctx => `Upsell ${ctx.unit.attributes.customerId}?\n\n${ctx.steps.summary}`,
  })
  .exit('reviewed');

const billingEvent = z.object({
  type: z.enum(['signedUp', 'suspended', 'reinstated', 'churned']),
  customerId: z.string(),
  plan: z.string(),
});

const tenancies = H.lane('tenancies', Tenancy)
  .supply(
    webhook.json('billing', {
      port: H.slot.port(0),
      path: '/billing',
      secret: H.env('BILLING_WEBHOOK_SECRET'),
      payload: billingEvent,
    }),
    (event, to) => {
      if (event.type === 'signedUp') return to.create({ customerId: event.customerId, plan: event.plan });
      if (event.type === 'suspended') return to.signal(Suspend, event.customerId, {});
      if (event.type === 'reinstated') return to.signal(Reinstate, event.customerId, {});
      return to.signal(Churn, event.customerId, {});
    },
  )
  .supply(H.clock('monthly-review').monthly(1, '09:00', { tz: 'Europe/London' }), (tick, to) =>
    to.signal(MonthlyReview, unit => unit.state === 'current', { month: tick.at.toISOString().slice(0, 7) }),
  )
  .store(store)
  .handler(tenancyFlow, { exits: { reviewed: Current } })
  .on(MonthlyReview, { restart: 'usage' })
  .on(Suspend, { enter: Suspended })
  .on(Reinstate, { enter: Current })
  .on(Churn, { enter: Churned });

const negotiation = z.object({
  vendor: z.string(),
  item: z.string(),
  ourLimitUsd: z.number(),
  expiresAt: z.string(),
  lastVendorMessage: z.string(),
  round: z.number(),
});

const Drafting = H.state('drafting', 'pending');
const AwaitingVendor = H.state('awaiting-vendor', 'waiting');
const Agreed = H.terminal('agreed', 'success');
const WalkedAway = H.terminal('walked-away', 'neutral');
const TheyWalkedAway = H.terminal('vendor-walked-away', 'failure');
const Expired = H.terminal('expired', 'failure');
const NegotiationWithdrawn = H.terminal('negotiation-withdrawn', 'neutral');

const Negotiation = H.kind('Negotiation')
  .attributes(negotiation)
  .states(Drafting, AwaitingVendor, Agreed, WalkedAway, TheyWalkedAway, Expired, NegotiationWithdrawn)
  .key(n => `${n.vendor}:${n.item}`)
  .initial(Drafting)
  .onCancelled(NegotiationWithdrawn);

const VendorCountered = H.signal('vendor-countered').payload(z.object({ message: z.string() }));
const VendorAccepted = H.signal('vendor-accepted');
const VendorWalkedAway = H.signal('vendor-walked-away');
const Expire = H.signal('negotiation-expired');

const negotiator = H.role('negotiator')
  .intents('read')
  .instructions('Draft the next offer. Never exceed our limit. Explain the concession you make, if any.');
const negotiatorAgent = H.agent('negotiator')
  .role(negotiator)
  .model(sonnet)
  .output(z.object({ offer: z.string(), rationale: z.string() }));

const sendOffer = H.command('send-offer')
  .input(z.object({ vendor: z.string(), offer: z.string() }))
  .argv(message => ['procurement-send', '--vendor', message.vendor, '--body', message.offer])
  .runner(ops);

const negotiationFlow = H.flow('negotiation-round')
  .input(negotiation)
  .step('draftOffer', negotiatorAgent, ctx => ({
    task: `Round ${ctx.unit.attributes.round} with ${ctx.unit.attributes.vendor} for ${ctx.unit.attributes.item}. Our limit is $${ctx.unit.attributes.ourLimitUsd}. Their last message:\n\n${ctx.unit.attributes.lastVendorMessage}`,
  }))
  .halt('decide', z.object({ action: z.enum(['send', 'walkAway']), offer: z.string() }), {
    ask: ctx =>
      `Send this offer to ${ctx.unit.attributes.vendor}, or walk away?\n\n${ctx.steps.draftOffer.offer}\n\n${ctx.steps.draftOffer.rationale}`,
  })
  .exit('walkAway', ctx => ctx.steps.decide.action === 'walkAway')
  .step('send', sendOffer, ctx => ({ vendor: ctx.unit.attributes.vendor, offer: ctx.steps.decide.offer }))
  .exit('sent');

const vendorReply = z.object({
  negotiation: z.string(),
  verdict: z.enum(['countered', 'accepted', 'walkedAway']),
  message: z.string(),
});

const negotiations = H.lane('negotiations', Negotiation)
  .supply(H.operator)
  .supply(
    webhook.json('vendor-replies', {
      port: H.slot.port(1),
      path: '/vendor-replies',
      secret: H.env('VENDOR_WEBHOOK_SECRET'),
      payload: vendorReply,
    }),
    (reply, to) => {
      if (reply.verdict === 'accepted') return to.signal(VendorAccepted, reply.negotiation, {});
      if (reply.verdict === 'walkedAway') return to.signal(VendorWalkedAway, reply.negotiation, {});
      return to.signal(VendorCountered, reply.negotiation, { message: reply.message });
    },
  )
  .store(store)
  .handler(negotiationFlow, { exits: { walkAway: WalkedAway, sent: AwaitingVendor } })
  .on(VendorCountered, {
    update: (n, reply) => ({ ...n, lastVendorMessage: reply.message, round: n.round + 1 }),
    restart: 'draftOffer',
  })
  .on(VendorAccepted, { enter: Agreed })
  .on(VendorWalkedAway, { enter: TheyWalkedAway })
  .on(Expire, { enter: Expired });

const negotiationExpiry = H.trigger(
  'negotiation-expiry',
  H.when.timer(negotiations, { at: unit => new Date(unit.attributes.expiresAt) }),
).signal(Expire, negotiations, event =>
  event.unit.position === 'terminal' ? undefined : { key: event.unit.key, payload: {} },
);

const scheduler = H.scheduler('business')
  .priority(negotiations, tenancies, experiments)
  .admit(experiments, ctx => {
    const past = ctx.metrics.outcomes({ of: experiments, window: { lastDays: 180 } });
    return past.samples < 10 || past.byState.inconclusive / past.samples < 0.5;
  });

export default H.harness('business')
  .ledger(sqlite.ledger({ path: 'business/ledger.sqlite' }))
  .pools(pool)
  .lanes(experiments, tenancies, negotiations)
  .triggers(negotiationExpiry)
  .scheduler(scheduler)
  .clients(
    claudeCode.supervisor('business-desk', {
      grants: [
        H.ops.workRead,
        H.ops.workCreate,
        H.ops.workCancel,
        H.ops.workSignal,
        H.ops.blockersResolve,
        H.ops.telemetryRead,
      ],
    }),
  )
  .observers(markdown.board({ path: 'business/BOARD.md' }), markdown.telemetry({ path: 'business/TELEMETRY.md' }));
