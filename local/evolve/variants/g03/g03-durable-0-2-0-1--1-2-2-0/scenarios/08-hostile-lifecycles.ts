import { z } from 'zod';
import { H } from 'harness-dsl';
import { sqlite } from 'harness-dsl/sqlite';
import { anthropic } from 'harness-dsl/anthropic';
import { claudeCode } from 'harness-dsl/claude-code';
import { webhook } from 'harness-dsl/webhook';
import { local } from 'harness-dsl/local';
import { markdown } from 'harness-dsl/markdown';

const quota = sqlite.quota('lifecycles-quota', { path: './.harness/quota.sqlite' });
const api = anthropic.account('anthropic-api', { apiKey: H.env('ANTHROPIC_API_KEY'), quota });
const sonnet = anthropic.model('sonnet', { id: 'claude-sonnet-4-5' });
const pool = H.pool('api-pool').accounts(api);
const localRunner = local.runner('local');

const experimentAttrs = z.object({ experimentId: z.string(), hypothesis: z.string() });

const Scheduled = H.state('scheduled', 'pending');
const AWins = H.terminal('a-wins', 'success');
const BWins = H.terminal('b-wins', 'success');
const Inconclusive = H.terminal('inconclusive', 'neutral');
const Aborted = H.terminal('aborted', 'failure');

const experiment = H.kind('Experiment')
  .attributes(experimentAttrs)
  .states(Scheduled, AWins, BWins, Inconclusive, Aborted)
  .key(a => a.experimentId)
  .initial(Scheduled);

const sampleMetric = H.command('sample-experiment')
  .input(z.object({ experimentId: z.string() }))
  .argv(i => ['experiments', 'sample', i.experimentId])
  .runner(localRunner);

const analyse = H.command('analyse-experiment')
  .input(z.object({ experimentId: z.string() }))
  .argv(i => ['experiments', 'analyse', i.experimentId])
  .output(z.object({ winner: z.enum(['a', 'b', 'none']) }))
  .runner(localRunner);

const runExperiment = H.flow('run-experiment')
  .input(experimentAttrs)
  .loop(
    'hourly',
    hour => hour
      .wait('nextHour', { ms: 3_600_000 })
      .step('sample', sampleMetric, ctx => ({ experimentId: ctx.unit.attributes.experimentId })),
    { max: 14 * 24 },
  )
  .step('analyse', analyse, ctx => ({ experimentId: ctx.unit.attributes.experimentId }))
  .exit('aWins', ctx => ctx.steps.analyse.winner === 'a')
  .exit('bWins', ctx => ctx.steps.analyse.winner === 'b')
  .exit('inconclusive');

const experiments = H.lane('experiments', experiment)
  .supply(H.operator)
  .store(sqlite.store({ path: './.harness/units.sqlite' }))
  .handler(runExperiment, { exits: { aWins: AWins, bWins: BWins, inconclusive: Inconclusive } })
  .retry({ maxAttempts: 2, exhausted: Aborted });

const tenancyAttrs = z.object({
  tenantId: z.string(),
  customer: z.string(),
  lastDecision: z.enum(['none', 'upsell', 'hold']),
});

const ReviewDue = H.state('review-due', 'pending');
const Current = H.state('current', 'waiting');
const Suspended = H.state('suspended', 'waiting');
const Churned = H.terminal('churned', 'neutral');

const tenancy = H.kind('Tenancy')
  .attributes(tenancyAttrs)
  .states(ReviewDue, Current, Suspended, Churned)
  .key(a => a.tenantId)
  .initial(ReviewDue);

const reviewDue = H.signal('review-due');
const suspend = H.signal('suspend');
const reinstate = H.signal('reinstate');
const churn = H.signal('churn');

const usageReview = H.command('usage-review')
  .input(z.object({ tenantId: z.string() }))
  .argv(i => ['billing', 'usage', i.tenantId])
  .output(z.object({ seats: z.number(), spendUsd: z.number() }))
  .runner(localRunner);

const accountManager = H.role('account-manager').intents('read').instructions('Summarize the month of usage for a human deciding on an upsell.');
const tenancySummarizer = H.seat('tenancy-summarizer').role(accountManager).model(sonnet).pool(pool);

const upsellDecision = H.halt('upsell-decision').decision(z.object({ upsell: z.boolean(), note: z.string() }));

const monthlyReview = H.flow('monthly-review')
  .input(tenancyAttrs)
  .step('usage', usageReview, ctx => ({ tenantId: ctx.unit.attributes.tenantId }))
  .step('summary', tenancySummarizer, ctx => ({
    task: `Summarize ${ctx.unit.attributes.customer}: ${ctx.steps.usage.seats} seats, $${ctx.steps.usage.spendUsd}. Last decision: ${ctx.unit.attributes.lastDecision}.`,
  }))
  .halt('upsell', upsellDecision, {
    ask: ctx => `Upsell ${ctx.unit.attributes.customer}?\n${ctx.steps.summary}`,
    annotate: (attrs, decision) => ({ lastDecision: decision.upsell ? 'upsell' : 'hold' }),
  })
  .exit('reviewed');

const tenancies = H.lane('tenancies', tenancy)
  .supply(H.operator)
  .store(sqlite.store({ path: './.harness/units.sqlite' }))
  .handler(monthlyReview, { exits: { reviewed: Current } })
  .retry({ maxAttempts: 3, backoff: 'exponential', initialDelayMs: 600_000, exhausted: Current })
  .on(reviewDue, { enter: ReviewDue })
  .on(suspend, { enter: Suspended })
  .on(reinstate, { enter: Current })
  .on(churn, { enter: Churned });

const monthly = H.clock('monthly').at('09:00', { on: 1, tz: 'Europe/Berlin' });

const negotiationAttrs = z.object({
  negotiationId: z.string(),
  vendor: z.string(),
  item: z.string(),
  deadline: z.string(),
  lastVendorMessage: z.string(),
});

const OurMove = H.state('our-move', 'pending');
const TheirMove = H.state('their-move', 'waiting');
const Agreed = H.terminal('agreed', 'success');
const WalkedAwayByUs = H.terminal('walked-away-by-us', 'neutral');
const WalkedAwayByThem = H.terminal('walked-away-by-them', 'neutral');
const Expired = H.terminal('expired', 'neutral');

const negotiation = H.kind('Negotiation')
  .attributes(negotiationAttrs)
  .states(OurMove, TheirMove, Agreed, WalkedAwayByUs, WalkedAwayByThem, Expired)
  .key(a => a.negotiationId)
  .initial(OurMove);

const vendorCountered = H.signal('vendor-countered').payload(z.object({ message: z.string() }));
const vendorAccepted = H.signal('vendor-accepted');
const vendorWalkedAway = H.signal('vendor-walked-away');
const expire = H.signal('expire');

const negotiatorRole = H.role('negotiator').intents('read').instructions('Draft the next offer within the mandate.');
const negotiator = H.seat('negotiator').role(negotiatorRole).model(sonnet).pool(pool);

const ourMove = H.halt('our-move').decision(z.object({ action: z.enum(['send', 'accept', 'walkAway']) }));

const sendOffer = H.command('send-offer')
  .input(z.object({ negotiationId: z.string(), offer: z.string() }))
  .argv(i => ['procurement', 'send-offer', i.negotiationId, i.offer])
  .runner(localRunner);

const negotiationRound = H.flow('negotiation-round')
  .input(negotiationAttrs)
  .step('draft', negotiator, ctx => ({
    task: `Draft our next offer to ${ctx.unit.attributes.vendor} for ${ctx.unit.attributes.item}. Their last message: ${ctx.unit.attributes.lastVendorMessage}`,
  }))
  .halt('decide', ourMove, { ask: ctx => `Send this offer, accept their last terms, or walk away?\n${ctx.steps.draft}` })
  .exit('walkedAway', ctx => ctx.steps.decide.action === 'walkAway')
  .exit('agreed', ctx => ctx.steps.decide.action === 'accept')
  .step('send', sendOffer, ctx => ({ negotiationId: ctx.unit.attributes.negotiationId, offer: ctx.steps.draft }))
  .exit('sent');

const vendorReplies = webhook.json('vendor-replies', {
  port: H.slot.port(2),
  path: '/vendor-replies',
  secret: H.env('VENDOR_WEBHOOK_SECRET'),
  payload: z.object({ negotiationId: z.string(), reply: z.enum(['counter', 'accept', 'walkAway']), message: z.string() }),
});

const negotiations = H.lane('negotiations', negotiation)
  .supply(H.operator)
  .supply(vendorReplies, (reply, to) =>
    reply.reply === 'counter'
      ? to.signal(vendorCountered, reply.negotiationId, { message: reply.message })
      : reply.reply === 'accept'
        ? to.signal(vendorAccepted, reply.negotiationId, {})
        : to.signal(vendorWalkedAway, reply.negotiationId, {}))
  .store(sqlite.store({ path: './.harness/units.sqlite' }))
  .handler(negotiationRound, { exits: { walkedAway: WalkedAwayByUs, agreed: Agreed, sent: TheirMove } })
  .retry({ maxAttempts: 3, backoff: 'exponential', initialDelayMs: 300_000, exhausted: TheirMove })
  .on(vendorCountered, { update: (attrs, payload) => ({ ...attrs, lastVendorMessage: payload.message }), enter: OurMove })
  .on(vendorAccepted, { enter: Agreed })
  .on(vendorWalkedAway, { enter: WalkedAwayByThem })
  .on(expire, { enter: Expired });

const monthlyTenancyReview = H.trigger('monthly-tenancy-review')
  .on(H.when.sweep(tenancies, { every: monthly, in: Current }))
  .signal(reviewDue, tenancies, event => ({ key: event.unit.key, payload: {} }));

const negotiationExpiry = H.trigger('negotiation-expiry')
  .on(H.when.timer(negotiations, { reads: ['deadline'], at: view => new Date(view.attributes.deadline) }))
  .signal(expire, negotiations, event => ({ key: event.unit.key, payload: {} }));

const scheduler = H.scheduler('lifecycles')
  .standard(experiments, tenancies, negotiations)
  .admit(experiments, ctx => {
    const record = ctx.metrics.outcomes({ of: experiments, window: { lastDays: 180 } });
    const inconclusiveShare = record.terminal === 0 ? 0 : record.count(Inconclusive) / record.terminal;
    return record.samples < 10 || inconclusiveShare < 0.6 || ctx.count(experiments, 'active', 'waiting') < 2;
  });

const supervisor = claudeCode.supervisor('lifecycles-supervisor', {
  port: H.slot.port(1),
  grants: [
    H.ops.workRead,
    H.ops.workCreate,
    H.ops.workSignal,
    H.ops.resolve(upsellDecision, ourMove),
    H.ops.telemetryRead,
  ],
});

void H.harness('lifecycles')
  .ledger(sqlite.ledger({ path: './.harness/ledger.sqlite' }))
  .lanes(experiments, tenancies, negotiations)
  .triggers(monthlyTenancyReview, negotiationExpiry)
  .scheduler(scheduler)
  .clients(supervisor)
  .observers(markdown.board({ path: './.harness/board.md' }), markdown.telemetry({ path: './.harness/telemetry.md' }))
  .start();
