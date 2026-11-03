import { z } from 'zod';
import { H } from 'harness-dsl';
import { sqlite } from 'harness-dsl/sqlite';
import { anthropic } from 'harness-dsl/anthropic';
import { local } from 'harness-dsl/local';
import { http } from 'harness-dsl/http';
import { webhook } from 'harness-dsl/webhook';
import { markdown } from 'harness-dsl/markdown';

const localRunner = local.runner('local');
const harnessStore = sqlite.store({ path: '.harness/store.db' });
const quota = sqlite.quota('api-quota', { path: '.harness/quota.db' });
const apiAccount = anthropic.account('api', { apiKey: H.env('ANTHROPIC_API_KEY'), quota });
const apiPool = H.pool('api').accounts(apiAccount);
const sonnet = anthropic.model('sonnet', { id: 'claude-sonnet-4-5' });

const experimentSchema = z.object({ slug: z.string(), hypothesis: z.string() });

const Proposed = H.state('Proposed', 'pending');
const AWins = H.terminal('AWins', 'success');
const BWins = H.terminal('BWins', 'success');
const Inconclusive = H.terminal('Inconclusive', 'neutral');
const ExperimentBroken = H.terminal('ExperimentBroken', 'failure');

const experimentKind = H.kind('Experiment')
  .attributes(experimentSchema)
  .states(Proposed, AWins, BWins, Inconclusive, ExperimentBroken)
  .key(a => a.slug)
  .initial(Proposed);

const measure = H.command('measure-experiment')
  .input(z.object({ slug: z.string() }))
  .argv(i => ['./scripts/experiment-measure', i.slug])
  .output(z.object({ a: z.number(), b: z.number() }))
  .runner(localRunner);

const tally = z.object({ a: z.number(), b: z.number(), hours: z.number() });

const decideWinner = H.command('decide-winner')
  .input(tally)
  .argv(i => ['./scripts/experiment-decide', String(i.a), String(i.b), String(i.hours)])
  .output(z.object({ winner: z.enum(['a', 'b', 'none']) }))
  .runner(localRunner);

const runExperiment = H.flow('run-experiment')
  .input(experimentSchema)
  .loop('hourly', { schema: tally, initial: { a: 0, b: 0, hours: 0 } }, f => f
    .step('measure', measure, ctx => ({ slug: ctx.unit.attributes.slug }))
    .wait('nextHour', { ms: 3_600_000 }),
  {
    max: 336,
    next: ctx => ({
      a: ctx.steps.hourly.a + ctx.steps.measure.a,
      b: ctx.steps.hourly.b + ctx.steps.measure.b,
      hours: ctx.steps.hourly.hours + 1,
    }),
  })
  .step('decide', decideWinner, ctx => ctx.steps.hourly)
  .exit('aWins', ctx => ctx.steps.decide.winner === 'a')
  .exit('bWins', ctx => ctx.steps.decide.winner === 'b')
  .exit('inconclusive');

const experimentLane = H.lane('experiments', experimentKind)
  .supply(H.operator)
  .handler(runExperiment, { exits: { aWins: AWins, bWins: BWins, inconclusive: Inconclusive } })
  .store(harnessStore)
  .retry({ maxAttempts: 2, exhausted: ExperimentBroken });

const tenancySchema = z.object({ customerId: z.string(), customerName: z.string(), plan: z.string() });

const ReviewDue = H.state('ReviewDue', 'pending');
const Current = H.state('Current', 'waiting');
const Suspended = H.state('Suspended', 'waiting');
const Churned = H.terminal('Churned', 'neutral');

const tenancyKind = H.kind('Tenancy')
  .attributes(tenancySchema)
  .states(ReviewDue, Current, Suspended, Churned)
  .key(a => a.customerId)
  .initial(ReviewDue);

const reviewDue = H.signal('reviewDue');
const suspend = H.signal('suspend');
const reinstate = H.signal('reinstate');
const churn = H.signal('churn');

const upsellHalt = H.halt('upsell').decision(z.object({ upsell: z.boolean(), note: z.string() }));

const analystRole = H.role('account-analyst').intents('read').instructions('Summarise the month of usage and what it suggests for the plan.');
const analyst = H.seat('account-analyst').role(analystRole).model(sonnet).pool(apiPool);

const usageReport = H.command('usage-report')
  .input(z.object({ customerId: z.string() }))
  .argv(i => ['./scripts/usage-report', i.customerId])
  .runner(localRunner);

const monthlyReview = H.flow('monthly-review')
  .input(tenancySchema)
  .step('usage', usageReport, ctx => ({ customerId: ctx.unit.attributes.customerId }))
  .step('summary', analyst, ctx => ({ task: `Summarise usage for ${ctx.unit.attributes.customerName} on ${ctx.unit.attributes.plan}:\n${ctx.steps.usage.stdout}` }))
  .halt('upsell', upsellHalt, { ask: ctx => ctx.steps.summary })
  .exit('reviewed');

const billingEvents = webhook.json('billing-events', {
  port: H.slot.port(1),
  path: '/billing',
  secret: H.env('BILLING_WEBHOOK_SECRET'),
  payload: z.object({
    event: z.enum(['signed', 'suspended', 'reinstated', 'churned']),
    customerId: z.string(),
    customerName: z.string(),
    plan: z.string(),
  }),
});

const tenancyLane = H.lane('tenancies', tenancyKind)
  .supply(billingEvents, (e, to) =>
    e.event === 'signed' ? to.create({ customerId: e.customerId, customerName: e.customerName, plan: e.plan })
      : e.event === 'suspended' ? to.signal(suspend, e.customerId, {})
        : e.event === 'reinstated' ? to.signal(reinstate, e.customerId, {})
          : to.signal(churn, e.customerId, {}))
  .handler(monthlyReview, { exits: { reviewed: Current } })
  .store(harnessStore)
  .retry({ maxAttempts: 3, backoff: 'exponential', initialDelayMs: 3_600_000, exhausted: Current })
  .on(reviewDue, { enter: ReviewDue })
  .on(suspend, { enter: Suspended })
  .on(reinstate, { enter: Current })
  .on(churn, { enter: Churned });

const monthly = H.clock('monthly').at('09:00', { on: 1, tz: 'Europe/London' });

const monthlyReviews = H.trigger('monthly-reviews')
  .on(H.when.sweep(tenancyLane, { every: monthly, in: Current }))
  .signal(reviewDue, tenancyLane, e => ({ key: e.unit.key, payload: {} }));

const negotiationSchema = z.object({
  negotiationId: z.string(),
  vendor: z.string(),
  item: z.string(),
  deadline: z.string(),
  history: z.array(z.string()),
});

const Drafting = H.state('Drafting', 'pending');
const AwaitingVendor = H.state('AwaitingVendor', 'waiting');
const Agreed = H.terminal('Agreed', 'success');
const WalkedAwayByUs = H.terminal('WalkedAwayByUs', 'neutral');
const WalkedAwayByThem = H.terminal('WalkedAwayByThem', 'neutral');
const Expired = H.terminal('Expired', 'neutral');
const NegotiationBroken = H.terminal('NegotiationBroken', 'failure');

const negotiationKind = H.kind('Negotiation')
  .attributes(negotiationSchema)
  .states(Drafting, AwaitingVendor, Agreed, WalkedAwayByUs, WalkedAwayByThem, Expired, NegotiationBroken)
  .key(a => a.negotiationId)
  .initial(Drafting);

const vendorCountered = H.signal('vendorCountered').payload(z.object({ message: z.string() }));
const vendorAccepted = H.signal('vendorAccepted').payload(z.object({ message: z.string() }));
const vendorWalkedAway = H.signal('vendorWalkedAway').payload(z.object({ message: z.string() }));
const expire = H.signal('expire');

const offerHalt = H.halt('offer').decision(z.object({ action: z.enum(['send', 'walkAway']), offer: z.string() }));

const negotiatorRole = H.role('negotiator').intents('read').instructions('Draft the next offer from the history of the negotiation.');
const negotiator = H.seat('negotiator')
  .role(negotiatorRole)
  .model(sonnet)
  .pool(apiPool)
  .output(z.object({ offer: z.string(), rationale: z.string() }));

const sendOffer = H.command('send-offer')
  .input(z.object({ negotiationId: z.string(), offer: z.string() }))
  .argv(i => ['./scripts/send-offer', i.negotiationId, i.offer])
  .runner(localRunner);

const negotiationRound = H.flow('negotiation-round')
  .input(negotiationSchema)
  .step('draft', negotiator, ctx => ({ task: `Next offer to ${ctx.unit.attributes.vendor} for ${ctx.unit.attributes.item}. History:\n${ctx.unit.attributes.history.join('\n')}` }))
  .halt('offer', offerHalt, { ask: ctx => `${ctx.steps.draft.offer}\n\n${ctx.steps.draft.rationale}` })
  .exit('walkedAway', ctx => ctx.steps.offer.action === 'walkAway')
  .step('send', sendOffer, ctx => ({ negotiationId: ctx.unit.attributes.negotiationId, offer: ctx.steps.offer.offer }), { afterCrash: 'park' })
  .exit('sent', {
    update: ctx => ({ history: [...ctx.unit.attributes.history, `us: ${ctx.steps.offer.offer}`] }),
  });

const vendorReplies = webhook.json('vendor-replies', {
  port: H.slot.port(1),
  path: '/vendor',
  secret: H.env('VENDOR_WEBHOOK_SECRET'),
  payload: z.object({ negotiationId: z.string(), reply: z.enum(['counter', 'accept', 'walkAway']), message: z.string() }),
});

const negotiationLane = H.lane('negotiations', negotiationKind)
  .supply(H.operator)
  .supply(vendorReplies, (e, to) =>
    e.reply === 'counter' ? to.signal(vendorCountered, e.negotiationId, { message: e.message })
      : e.reply === 'accept' ? to.signal(vendorAccepted, e.negotiationId, { message: e.message })
        : to.signal(vendorWalkedAway, e.negotiationId, { message: e.message }))
  .handler(negotiationRound, { exits: { sent: AwaitingVendor, walkedAway: WalkedAwayByUs } })
  .store(harnessStore)
  .retry({ maxAttempts: 3, backoff: 'exponential', initialDelayMs: 300_000, exhausted: NegotiationBroken })
  .on(vendorCountered, { update: (a, p) => ({ ...a, history: [...a.history, `them: ${p.message}`] }), enter: Drafting })
  .on(vendorAccepted, { update: (a, p) => ({ ...a, history: [...a.history, `them: ${p.message}`] }), enter: Agreed })
  .on(vendorWalkedAway, { update: (a, p) => ({ ...a, history: [...a.history, `them: ${p.message}`] }), enter: WalkedAwayByThem })
  .on(expire, { enter: Expired });

const negotiationExpiry = H.trigger('negotiation-expiry')
  .on(H.when.timer(negotiationLane, { reads: ['deadline'], at: v => new Date(v.attributes.deadline) }))
  .signal(expire, negotiationLane, e => ({ key: e.unit.key, payload: {} }));

const operatorApi = http.controlApi('operator-api', {
  port: H.slot.port(2),
  token: H.env('CONTROL_API_TOKEN'),
  grants: [H.ops.workRead, H.ops.workCreate, H.ops.workSignal, H.ops.resolve(upsellHalt, offerHalt), H.ops.telemetryRead],
});

export const harness = H.harness('lifecycles')
  .ledger(sqlite.ledger({ path: '.harness/ledger.db' }))
  .lanes(experimentLane, tenancyLane, negotiationLane)
  .triggers(monthlyReviews, negotiationExpiry)
  .scheduler(H.scheduler('lifecycles-scheduler')
    .standard(negotiationLane, tenancyLane, experimentLane)
    .wip(experimentLane, 4)
    .admit(experimentLane, ctx => {
      const record = ctx.metrics.outcomes({ of: experimentLane, window: { lastDays: 90 } });
      return record.terminal < 10 || record.count(Inconclusive) / record.terminal < 0.5;
    }))
  .clients(operatorApi)
  .observers(markdown.board({ path: 'BOARD.md' }), markdown.telemetry({ path: 'TELEMETRY.md' }));

void harness.start();
