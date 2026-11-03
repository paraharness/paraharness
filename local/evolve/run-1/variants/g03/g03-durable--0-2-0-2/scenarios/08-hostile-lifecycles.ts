import { z } from 'zod';
import { H } from 'harness-dsl';
import { sqlite } from 'harness-dsl/sqlite';
import { anthropic } from 'harness-dsl/anthropic';
import { claudeCode } from 'harness-dsl/claude-code';
import { webhook } from 'harness-dsl/webhook';
import { local } from 'harness-dsl/local';
import { markdown } from 'harness-dsl/markdown';

const ownStore = sqlite.store({ path: 'state/units.sqlite' });
const localRunner = local.runner('local');
const apiAccount = anthropic.account('anthropic-api', { apiKey: H.env('ANTHROPIC_API_KEY') });
const pool = H.pool('pool').accounts(apiAccount);
const sonnet = anthropic.model('sonnet', { id: 'claude-sonnet-4-5' });
const haiku = anthropic.model('haiku', { id: 'claude-haiku-4-5' });

const Failed = H.terminal('Failed', 'failure');
const Withdrawn = H.terminal('Withdrawn', 'neutral');

const experimentSchema = z.object({ experimentId: z.string(), hypothesis: z.string() });

const Proposed = H.state('Proposed', 'pending');
const Measuring = H.state('Measuring', 'active');
const BetweenMeasurements = H.state('BetweenMeasurements', 'waiting');
const AWins = H.terminal('AWins', 'neutral');
const BWins = H.terminal('BWins', 'neutral');
const Inconclusive = H.terminal('Inconclusive', 'neutral');

const Experiment = H.kind('Experiment')
  .attributes(experimentSchema)
  .states(Proposed, Measuring, BetweenMeasurements, AWins, BWins, Inconclusive, Failed, Withdrawn)
  .key((experiment) => experiment.experimentId)
  .initial(Proposed)
  .onAttemptFailed(Failed)
  .onCancelled(Withdrawn);

const measure = H.command('measure-experiment')
  .input(z.object({ experimentId: z.string() }))
  .argv((input) => ['experiments', 'measure', input.experimentId])
  .output(z.object({ a: z.number(), b: z.number() }))
  .runner(localRunner);

const judge = H.command('judge-experiment')
  .input(z.object({ experimentId: z.string() }))
  .argv((input) => ['experiments', 'judge', input.experimentId])
  .output(z.object({ winner: z.enum(['A', 'B', 'none']) }))
  .runner(localRunner);

const experimentFlow = H.flow('experiment')
  .input(experimentSchema)
  .loop(
    'hourly',
    (hour) =>
      hour
        .step('measure', measure, (ctx) => ({ experimentId: ctx.unit.attributes.experimentId }), {
          retry: { maxAttempts: 3, backoff: 'exponential', initialDelayMs: 60000 },
        })
        .wait('nextHour', { ms: 3600000 }),
    { max: 336 },
  )
  .step('judge', judge, (ctx) => ({ experimentId: ctx.unit.attributes.experimentId }))
  .exit('aWins', (ctx) => ctx.steps.judge.winner === 'A')
  .exit('bWins', (ctx) => ctx.steps.judge.winner === 'B')
  .exit('inconclusive');

const experiments = H.lane('experiments', Experiment)
  .supply(H.operator)
  .store(ownStore)
  .handler(experimentFlow, {
    exits: { aWins: AWins, bWins: BWins, inconclusive: Inconclusive },
    during: { measure: Measuring, judge: Measuring, nextHour: BetweenMeasurements },
  });

const tenancySchema = z.object({ customerId: z.string(), plan: z.string() });

const DueForReview = H.state('DueForReview', 'pending');
const Reviewing = H.state('Reviewing', 'active');
const AwaitingDecision = H.state('AwaitingDecision', 'waiting');
const Customer = H.state('Customer', 'waiting');
const Suspended = H.state('Suspended', 'waiting');
const ReviewFailed = H.state('ReviewFailed', 'waiting');
const Churned = H.terminal('Churned', 'neutral');

const Tenancy = H.kind('Tenancy')
  .attributes(tenancySchema)
  .states(DueForReview, Reviewing, AwaitingDecision, Customer, Suspended, ReviewFailed, Churned)
  .key((tenancy) => tenancy.customerId)
  .initial(DueForReview)
  .onAttemptFailed(ReviewFailed)
  .onCancelled(Customer);

const monthlyReview = H.signal('monthly-review');
const suspend = H.signal('suspend');
const reinstate = H.signal('reinstate');
const churn = H.signal('churn');

const usageReview = H.command('usage-review')
  .input(z.object({ customerId: z.string() }))
  .argv((input) => ['billing', 'usage', input.customerId, '--last-month'])
  .output(z.object({ usage: z.string() }))
  .runner(localRunner);

const accountAnalyst = H.role('account-analyst')
  .intents('read')
  .instructions('Summarise a customer month in plain language: usage trend, risks, upsell signals.');

const tenancySummarizer = H.agent('tenancy-summarizer').role(accountAnalyst).model(haiku).pool(pool);

const tenancyFlow = H.flow('tenancy-review')
  .input(tenancySchema)
  .step('usageReview', usageReview, (ctx) => ({ customerId: ctx.unit.attributes.customerId }))
  .step('summarize', tenancySummarizer, (ctx) => ({
    task: `Customer ${ctx.unit.attributes.customerId} on plan ${ctx.unit.attributes.plan}. Usage:\n${ctx.steps.usageReview.usage}`,
  }))
  .halt('decide', {
    ask: (ctx) => `Upsell ${ctx.unit.attributes.customerId}?\n\n${ctx.steps.summarize}`,
    decision: z.object({ upsell: z.boolean(), notes: z.string() }),
  })
  .exit('reviewed');

const tenancies = H.lane('tenancies', Tenancy)
  .supply(H.operator)
  .supply(H.clock('first-of-month').at('06:00', { on: 1, tz: 'UTC' }), (tick, to) =>
    to.signal(monthlyReview, (unit) => unit.state === 'Customer' || unit.state === 'ReviewFailed', {}),
  )
  .store(ownStore)
  .handler(tenancyFlow, {
    exits: { reviewed: Customer },
    during: { usageReview: Reviewing, summarize: Reviewing, decide: AwaitingDecision },
  })
  .on(monthlyReview, { enter: DueForReview })
  .on(suspend, { enter: Suspended })
  .on(reinstate, { enter: Customer })
  .on(churn, { enter: Churned });

const negotiationSchema = z.object({
  negotiationId: z.string(),
  vendor: z.string(),
  item: z.string(),
  expiresAt: z.string(),
  lastVendorOffer: z.string(),
});

const OurTurn = H.state('OurTurn', 'pending');
const Drafting = H.state('Drafting', 'active');
const TheirTurn = H.state('TheirTurn', 'waiting');
const Agreed = H.terminal('Agreed', 'success');
const WeWalkedAway = H.terminal('WeWalkedAway', 'neutral');
const TheyWalkedAway = H.terminal('TheyWalkedAway', 'failure');
const Expired = H.terminal('Expired', 'failure');

const Negotiation = H.kind('Negotiation')
  .attributes(negotiationSchema)
  .states(OurTurn, Drafting, TheirTurn, Agreed, WeWalkedAway, TheyWalkedAway, Expired, Failed, Withdrawn)
  .key((negotiation) => negotiation.negotiationId)
  .initial(OurTurn)
  .onAttemptFailed(Failed)
  .onCancelled(Withdrawn);

const vendorCountered = H.signal('vendor-countered').payload(z.object({ offer: z.string() }));
const vendorAccepted = H.signal('vendor-accepted');
const vendorWalkedAway = H.signal('vendor-walked-away');
const negotiationExpired = H.signal('negotiation-expired');

const negotiatorRole = H.role('negotiator')
  .intents('read')
  .instructions('Draft the next move within the mandate: offer, accept, or walk away.');

const negotiator = H.agent('negotiator')
  .role(negotiatorRole)
  .model(sonnet)
  .pool(pool)
  .output(z.object({ move: z.enum(['offer', 'accept', 'walkAway']), offer: z.string() }));

const sendOffer = H.command('send-offer')
  .input(z.object({ negotiationId: z.string(), offer: z.string(), accept: z.boolean() }))
  .argv((input) => ['procurement', 'send', input.negotiationId, input.accept ? '--accept' : '--offer', input.offer])
  .runner(localRunner);

const roundFlow = H.flow('negotiation-round')
  .input(negotiationSchema)
  .step('draftMove', negotiator, (ctx) => ({
    task: `Negotiating ${ctx.unit.attributes.item} with ${ctx.unit.attributes.vendor}. Their last offer: ${ctx.unit.attributes.lastVendorOffer || 'none yet'}.`,
  }))
  .exit('weWalkedAway', (ctx) => ctx.steps.draftMove.move === 'walkAway')
  .step(
    'sendMove',
    sendOffer,
    (ctx) => ({
      negotiationId: ctx.unit.attributes.negotiationId,
      offer: ctx.steps.draftMove.offer,
      accept: ctx.steps.draftMove.move === 'accept',
    }),
    { afterCrash: 'park' },
  )
  .exit('agreed', (ctx) => ctx.steps.draftMove.move === 'accept')
  .exit('offerSent');

const vendorReplies = webhook.json('vendor-replies', {
  port: H.slot.port(1),
  path: '/vendor-replies',
  secret: H.env('VENDOR_WEBHOOK_SECRET'),
  payload: z.object({
    negotiationId: z.string(),
    reply: z.enum(['counter', 'accept', 'walkAway']),
    offer: z.string(),
  }),
});

const negotiations = H.lane('negotiations', Negotiation)
  .supply(H.operator)
  .supply(vendorReplies, (reply, to) =>
    reply.reply === 'counter'
      ? to.signal(vendorCountered, reply.negotiationId, { offer: reply.offer })
      : reply.reply === 'accept'
        ? to.signal(vendorAccepted, reply.negotiationId, {})
        : to.signal(vendorWalkedAway, reply.negotiationId, {}),
  )
  .store(ownStore)
  .handler(roundFlow, {
    exits: { weWalkedAway: WeWalkedAway, agreed: Agreed, offerSent: TheirTurn },
    during: { draftMove: Drafting, sendMove: Drafting },
  })
  .on(vendorCountered, { update: (attrs, payload) => ({ ...attrs, lastVendorOffer: payload.offer }), enter: OurTurn })
  .on(vendorAccepted, { enter: Agreed })
  .on(vendorWalkedAway, { enter: TheyWalkedAway })
  .on(negotiationExpired, { enter: Expired });

const negotiationExpiry = H.trigger('negotiation-expiry')
  .on(H.when.timer(negotiations, { at: (unit) => new Date(unit.attributes.expiresAt) }))
  .signal(negotiationExpired, negotiations, (event) => ({ key: event.unit.key, payload: {} }));

const scheduler = H.scheduler('lifecycles')
  .priority(negotiations, tenancies, experiments)
  .admit(experiments, (ctx) => {
    const ended = ctx.metrics.outcomes({ of: experiments, window: { lastDays: 180 } });
    const inconclusiveShare = ended.terminal === 0 ? 0 : ended.byState.Inconclusive / ended.terminal;
    const running = ctx.count(experiments, 'active', 'waiting');
    return ended.samples < 10 || inconclusiveShare < 0.5 || running < 2;
  });

const supervisor = claudeCode.supervisor('owner-supervisor', {
  grants: [
    H.ops.workRead,
    H.ops.workCreate,
    H.ops.workSignal,
    H.ops.workCancel,
    H.ops.blockersResolve,
    H.ops.telemetryRead,
  ],
});

export const lifecycles = H.harness('lifecycles')
  .ledger(sqlite.ledger({ path: 'state/ledger.sqlite' }))
  .lanes(experiments, tenancies, negotiations)
  .triggers(negotiationExpiry)
  .scheduler(scheduler)
  .clients(supervisor)
  .observers(markdown.board({ path: 'BOARD.md' }), markdown.telemetry({ path: 'TELEMETRY.md' }));
