import { z } from 'zod';
import { H } from 'harness-dsl';
import { sqlite } from 'harness-dsl/sqlite';
import { claudeCode } from 'harness-dsl/claude-code';
import { webhook } from 'harness-dsl/webhook';
import { local } from 'harness-dsl/local';
import { markdown } from 'harness-dsl/markdown';

const runner = local.runner('local').slots(4);
const store = sqlite.store({ path: './.harness/units.sqlite' });

const quota = sqlite.quota('subscriptions', { path: './.harness/quota.sqlite' });
const subscription = claudeCode.subscription('subscription', { token: H.env('CLAUDE_TOKEN'), quota });
const sonnet = claudeCode.model('sonnet', { id: 'claude-sonnet-4-5' });
const pool = H.pool('subscriptions').accounts(subscription);

const experimentAttrs = z.object({ name: z.string(), variantA: z.string(), variantB: z.string() });
const ExperimentScheduled = H.state('ExperimentScheduled', 'pending');
const AWins = H.terminal('AWins', 'neutral');
const BWins = H.terminal('BWins', 'neutral');
const Inconclusive = H.terminal('Inconclusive', 'neutral');
const InstrumentationBroken = H.terminal('InstrumentationBroken', 'failure');
const Experiment = H.kind('Experiment')
  .attributes(experimentAttrs)
  .states(ExperimentScheduled, AWins, BWins, Inconclusive, InstrumentationBroken)
  .key(a => a.name)
  .initial(ExperimentScheduled);

const measure = H.command('measure-experiment')
  .input(z.object({ experiment: z.string() }))
  .argv(i => ['./experiments/measure.sh', i.experiment])
  .runner(runner);
const judge = H.command('judge-experiment')
  .input(z.object({ experiment: z.string() }))
  .argv(i => ['./experiments/judge.sh', i.experiment])
  .output(z.object({ winner: z.enum(['A', 'B', 'none']) }))
  .runner(runner);

const experimentFlow = H.flow('experiment')
  .input(experimentAttrs)
  .loop(
    'hourly',
    round => round
      .step('measure', measure, ctx => ({ experiment: ctx.unit.key }), {
        retry: { maxAttempts: 3, backoff: 'exponential', initialDelayMs: 60_000 },
        afterCrash: 'rerun',
      })
      .wait('nextHour', { ms: 3_600_000 }),
    { max: 336 },
  )
  .step('judge', judge, ctx => ({ experiment: ctx.unit.key }), { afterCrash: 'rerun' })
  .exit('aWins', ctx => ctx.steps.judge.winner === 'A')
  .exit('bWins', ctx => ctx.steps.judge.winner === 'B')
  .exit('inconclusive');

const experiments = H.lane('experiments', Experiment)
  .supply(H.operator)
  .store(store)
  .handler(experimentFlow, { exits: { aWins: AWins, bWins: BWins, inconclusive: Inconclusive } })
  .retry({ maxAttempts: 2, backoff: 'exponential', initialDelayMs: 600_000, exhausted: InstrumentationBroken });

const tenancyAttrs = z.object({ customerId: z.string(), plan: z.string() });
const ReviewDue = H.state('ReviewDue', 'pending');
const Current = H.state('Current', 'waiting');
const Suspended = H.state('Suspended', 'waiting');
const Churned = H.terminal('Churned', 'neutral');
const Tenancy = H.kind('Tenancy')
  .attributes(tenancyAttrs)
  .states(ReviewDue, Current, Suspended, Churned)
  .key(a => a.customerId)
  .initial(ReviewDue);

const reviewDue = H.signal('review-due');
const suspend = H.signal('suspend').payload(z.object({ reason: z.string() }));
const reinstate = H.signal('reinstate');
const churn = H.signal('churn').payload(z.object({ reason: z.string() }));

const accountManagerRole = H.role('account-manager').intents('read').instructions('Summarize a tenancy month: usage, trend, risks, upsell signals.');
const summarizer = H.seat('tenancy-summarizer').role(accountManagerRole).model(sonnet).pool(pool)
  .output(z.object({ summary: z.string(), upsellSignal: z.boolean() }));
const usageReport = H.command('usage-report')
  .input(z.object({ customerId: z.string() }))
  .argv(i => ['./billing/usage.sh', i.customerId])
  .runner(runner);
const upsellDecision = H.halt('upsell-decision').decision(z.object({ upsell: z.boolean(), note: z.string() }));

const tenancyReview = H.flow('tenancy-review')
  .input(tenancyAttrs)
  .step('usage', usageReport, ctx => ({ customerId: ctx.unit.attributes.customerId }), { afterCrash: 'rerun' })
  .step('summary', summarizer, ctx => ({ task: `Monthly review of ${ctx.unit.attributes.customerId} on ${ctx.unit.attributes.plan}.\nUsage:\n${ctx.steps.usage.stdout}` }), { afterCrash: 'askDriver' })
  .halt('decide', upsellDecision, { ask: ctx => `Upsell ${ctx.unit.attributes.customerId}? ${ctx.steps.summary.summary}` })
  .exit('reviewed');

const tenancies = H.lane('tenancies', Tenancy)
  .supply(H.operator)
  .store(store)
  .handler(tenancyReview, { exits: { reviewed: Current } })
  .retry({ maxAttempts: 3, backoff: 'exponential', initialDelayMs: 3_600_000, exhausted: Current })
  .on(reviewDue, { enter: ReviewDue })
  .on(suspend, { enter: Suspended })
  .on(reinstate, { enter: Current })
  .on(churn, { enter: Churned });

const monthlyReview = H.trigger('monthly-tenancy-review')
  .on(H.when.tick(H.clock('monthly').at('09:00', { on: 1, tz: 'Europe/Berlin' }), tenancies, { in: Current }))
  .signal(reviewDue, tenancies, e => ({ key: e.unit.key, payload: {} }));

const negotiationAttrs = z.object({
  reference: z.string(),
  vendor: z.string(),
  item: z.string(),
  deadline: z.coerce.date(),
  vendorOffers: z.array(z.string()),
});
const OurMove = H.state('OurMove', 'pending');
const AwaitingVendor = H.state('AwaitingVendor', 'waiting');
const NegotiationStalled = H.state('NegotiationStalled', 'waiting');
const Agreed = H.terminal('Agreed', 'success');
const WeWalkedAway = H.terminal('WeWalkedAway', 'neutral');
const TheyWalkedAway = H.terminal('TheyWalkedAway', 'neutral');
const Expired = H.terminal('Expired', 'neutral');
const Negotiation = H.kind('Negotiation')
  .attributes(negotiationAttrs)
  .states(OurMove, AwaitingVendor, NegotiationStalled, Agreed, WeWalkedAway, TheyWalkedAway, Expired)
  .key(a => a.reference)
  .initial(OurMove);

const vendorCountered = H.signal('vendor-countered').payload(z.object({ offer: z.string() }));
const vendorAccepted = H.signal('vendor-accepted');
const vendorWalkedAway = H.signal('vendor-walked-away').payload(z.object({ reason: z.string() }));
const negotiationExpired = H.signal('negotiation-expired');

const negotiatorRole = H.role('negotiator').intents('read').instructions('Draft the next procurement move: counter-offer, accept, or walk away.');
const negotiator = H.seat('negotiator').role(negotiatorRole).model(sonnet).pool(pool)
  .output(z.object({ action: z.enum(['offer', 'accept', 'walkAway']), message: z.string() }));
const sendToVendor = H.command('send-to-vendor')
  .input(z.object({ vendor: z.string(), reference: z.string(), message: z.string() }))
  .argv(i => ['./procurement/send.sh', i.vendor, i.reference, i.message])
  .runner(runner);

const negotiationRound = H.flow('negotiation-round')
  .input(negotiationAttrs)
  .step('propose', negotiator, ctx => ({
    task: `Negotiate ${ctx.unit.attributes.item} with ${ctx.unit.attributes.vendor}. Vendor offers so far: ${ctx.unit.attributes.vendorOffers.join(' | ') || 'none'}.`,
  }), { afterCrash: 'askDriver' })
  .exit('walkedAway', ctx => ctx.steps.propose.action === 'walkAway')
  .step('send', sendToVendor, ctx => ({ vendor: ctx.unit.attributes.vendor, reference: ctx.unit.key, message: ctx.steps.propose.message }), { afterCrash: 'park' })
  .exit('accepted', ctx => ctx.steps.propose.action === 'accept')
  .exit('offered');

const vendorReplies = webhook.json('vendor-replies', {
  port: H.slot.port(1),
  path: '/vendor-replies',
  secret: H.env('VENDOR_WEBHOOK_SECRET'),
  payload: z.object({ reference: z.string(), type: z.enum(['counter', 'accepted', 'walkedAway']), text: z.string() }),
});

const negotiations = H.lane('negotiations', Negotiation)
  .supply(H.operator)
  .supply(vendorReplies, (reply, to) =>
    reply.type === 'counter' ? to.signal(vendorCountered, reply.reference, { offer: reply.text })
      : reply.type === 'accepted' ? to.signal(vendorAccepted, reply.reference, {})
        : to.signal(vendorWalkedAway, reply.reference, { reason: reply.text }))
  .store(store)
  .handler(negotiationRound, { exits: { walkedAway: WeWalkedAway, accepted: Agreed, offered: AwaitingVendor } })
  .retry({ maxAttempts: 3, backoff: 'exponential', initialDelayMs: 900_000, exhausted: NegotiationStalled })
  .on(vendorCountered, { update: (a, p) => ({ ...a, vendorOffers: [...a.vendorOffers, p.offer] }), enter: OurMove })
  .on(vendorAccepted, { enter: Agreed })
  .on(vendorWalkedAway, { enter: TheyWalkedAway })
  .on(negotiationExpired, { enter: Expired });

const negotiationExpiry = H.trigger('negotiation-expiry')
  .on(H.when.timer(negotiations, { at: u => u.attributes.deadline }))
  .signal(negotiationExpired, negotiations, e => ({ key: e.unit.key, payload: {} }));

const supervisor = claudeCode.supervisor('supervisor', {
  port: H.slot.port(2),
  grants: [H.ops.workRead, H.ops.workCreate, H.ops.workSignal, H.ops.resolve(upsellDecision), H.ops.attemptsRecover, H.ops.telemetryRead],
});

export const lifecyclesHarness = H.harness('lifecycles')
  .ledger(sqlite.ledger({ path: './.harness/ledger.sqlite' }))
  .lanes(experiments, tenancies, negotiations)
  .triggers(monthlyReview, negotiationExpiry)
  .scheduler(H.scheduler('lifecycles')
    .standard(negotiations, tenancies, experiments)
    .admit(experiments, ctx => {
      const ended = ctx.metrics.outcomes({ of: experiments, window: { lastDays: 90 } });
      const inconclusiveShare = ended.terminal === 0 ? 0 : ended.count(Inconclusive) / ended.terminal;
      return ended.samples < 10 || inconclusiveShare <= 0.5 || ctx.count(experiments, 'active', 'waiting') === 0;
    }))
  .clients(supervisor)
  .observers(markdown.board({ path: './BOARD.md' }), markdown.telemetry({ path: './TELEMETRY.md' }));
