import { z } from 'zod';
import { H } from 'harness-dsl';
import { sqlite } from 'harness-dsl/sqlite';
import { anthropic } from 'harness-dsl/anthropic';
import { claudeCode } from 'harness-dsl/claude-code';
import { webhook } from 'harness-dsl/webhook';
import { local } from 'harness-dsl/local';
import { markdown } from 'harness-dsl/markdown';

const quota = sqlite.quota('lifecycles-quota', { path: './.harness/quota.sqlite' });
const apiAccount = anthropic.account('api', { apiKey: H.env('ANTHROPIC_API_KEY'), quota });
const sonnet = anthropic.model('sonnet', { id: 'claude-sonnet-4-5' });
const pool = H.pool('api-pool').accounts(apiAccount);

const runner = local.runner('local').slots(4);
const harnessStore = sqlite.store({ path: './.harness/units.sqlite' });

const proposed = H.state('Proposed', 'pending');
const aWins = H.terminal('AWins', 'success');
const bWins = H.terminal('BWins', 'success');
const inconclusive = H.terminal('Inconclusive', 'neutral');
const aborted = H.terminal('Aborted', 'failure');

const experimentAttrs = z.object({ name: z.string(), hypothesis: z.string() });

const experiment = H.kind('Experiment')
  .attributes(experimentAttrs)
  .states(proposed, aWins, bWins, inconclusive, aborted)
  .key(a => a.name)
  .initial(proposed);

const measure = H.command('experiment-measure')
  .input(z.object({ experiment: z.string() }))
  .argv(input => ['experiments', 'measure', input.experiment])
  .output(z.object({ a: z.number(), b: z.number() }))
  .runner(runner);

const judge = H.command('experiment-verdict')
  .input(z.object({ experiment: z.string() }))
  .argv(input => ['experiments', 'verdict', input.experiment])
  .output(z.object({ winner: z.enum(['a', 'b', 'none']) }))
  .runner(runner);

const runExperiment = H.flow('run-experiment')
  .input(experimentAttrs)
  .loop(
    'hourly',
    flow => flow
      .step('measure', measure, ctx => ({ experiment: ctx.unit.attributes.name }), { afterCrash: 'rerun' })
      .wait('nextHour', { ms: 3600000 }),
    { max: 336 },
  )
  .step('verdict', judge, ctx => ({ experiment: ctx.unit.attributes.name }), { afterCrash: 'rerun' })
  .exit('aWins', ctx => ctx.steps.verdict.winner === 'a')
  .exit('bWins', ctx => ctx.steps.verdict.winner === 'b')
  .exit('inconclusive');

const experiments = H.lane('experiments', experiment)
  .supply(H.operator)
  .handler(runExperiment, { exits: { aWins, bWins, inconclusive } })
  .store(harnessStore)
  .retry({ maxAttempts: 3, backoff: 'exponential', initialDelayMs: 600000, exhausted: aborted })
  .on(H.cancel, { enter: aborted });

const reviewDue = H.state('ReviewDue', 'pending');
const customer = H.state('Customer', 'waiting');
const suspended = H.state('Suspended', 'waiting');
const churned = H.terminal('Churned', 'neutral');

const tenancyAttrs = z.object({ customerId: z.string(), plan: z.string() });

const tenancy = H.kind('Tenancy')
  .attributes(tenancyAttrs)
  .states(reviewDue, customer, suspended, churned)
  .key(a => a.customerId)
  .initial(reviewDue);

const reviewSignal = H.signal('review-due');
const suspendSignal = H.signal('suspend');
const reinstateSignal = H.signal('reinstate');
const churnSignal = H.signal('churn');

const usageReport = H.command('usage-report')
  .input(z.object({ customerId: z.string() }))
  .argv(input => ['billing', 'usage', input.customerId])
  .output(z.object({ seats: z.number(), spendUsd: z.number(), trend: z.string() }))
  .runner(runner);

const accountManager = H.role('account-manager')
  .intents('read')
  .instructions('Summarise the month of usage in plain language for the upsell decision.');

const summarySeat = H.seat('tenancy-summarizer').role(accountManager).model(sonnet).pool(pool);

const upsell = H.halt('upsell').decision(z.object({ upsell: z.boolean(), note: z.string() }));

const reviewTenancy = H.flow('review-tenancy')
  .input(tenancyAttrs)
  .step('usage', usageReport, ctx => ({ customerId: ctx.unit.attributes.customerId }), { afterCrash: 'rerun' })
  .step('summary', summarySeat, ctx => ({
    task: `Customer ${ctx.unit.attributes.customerId} on ${ctx.unit.attributes.plan}: ${ctx.steps.usage.seats} seats, $${ctx.steps.usage.spendUsd}, ${ctx.steps.usage.trend}.`,
  }))
  .halt('upsell', upsell, { ask: ctx => ctx.steps.summary })
  .exit('reviewed');

const monthly = H.clock('monthly').at('09:00', { on: 1, tz: 'Europe/London' });

const tenancies = H.lane('tenancies', tenancy)
  .supply(H.operator)
  .supply(sqlite.scan('tenancy-scan', { path: './.harness/units.sqlite', kind: 'Tenancy', schedule: monthly }), (stored, to) =>
    stored.state === 'Customer' ? to.signal(reviewSignal, stored.key, {}) : to.skip())
  .handler(reviewTenancy, { exits: { reviewed: customer } })
  .store(harnessStore)
  .retry({ maxAttempts: 3, backoff: 'exponential', initialDelayMs: 3600000, exhausted: customer })
  .on(reviewSignal, { enter: reviewDue })
  .on(suspendSignal, { enter: suspended })
  .on(reinstateSignal, { enter: customer })
  .on(churnSignal, { enter: churned });

const ourMove = H.state('OurMove', 'pending');
const theirMove = H.state('TheirMove', 'waiting');
const stalled = H.state('Stalled', 'waiting');
const agreed = H.terminal('Agreed', 'success');
const walkedAwayByUs = H.terminal('WalkedAwayByUs', 'neutral');
const walkedAwayByThem = H.terminal('WalkedAwayByThem', 'failure');
const expired = H.terminal('Expired', 'failure');

const negotiationAttrs = z.object({
  negotiationId: z.string(),
  vendor: z.string(),
  item: z.string(),
  deadline: z.string(),
  lastVendorMessage: z.string(),
});

const negotiation = H.kind('Negotiation')
  .attributes(negotiationAttrs)
  .states(ourMove, theirMove, stalled, agreed, walkedAwayByUs, walkedAwayByThem, expired)
  .key(a => a.negotiationId)
  .initial(ourMove);

const vendorReplied = H.signal('vendor-replied').payload(z.object({ message: z.string() }));
const vendorWalkedAway = H.signal('vendor-walked-away');
const vendorAgreed = H.signal('vendor-agreed');
const expire = H.signal('expire');

const negotiator = H.role('negotiator')
  .intents('read')
  .instructions('Draft the next offer, or recommend walking away when the terms cannot meet our floor.');

const negotiatorSeat = H.seat('negotiator')
  .role(negotiator)
  .model(sonnet)
  .pool(pool)
  .output(z.object({ offer: z.string(), walkAway: z.boolean() }));

const walkAway = H.halt('walk-away').decision(z.object({ confirmed: z.boolean() }));

const sendOffer = H.command('send-offer')
  .input(z.object({ negotiationId: z.string(), offer: z.string() }))
  .argv(input => ['procurement', 'send-offer', input.negotiationId, input.offer])
  .runner(runner);

const offerSent = H.command('offer-sent')
  .input(z.object({ negotiationId: z.string(), offer: z.string() }))
  .argv(input => ['procurement', 'offer-sent', input.negotiationId])
  .output(z.boolean())
  .runner(runner);

const negotiationRound = H.flow('negotiation-round')
  .input(negotiationAttrs)
  .step('draft', negotiatorSeat, ctx => ({
    task: `Negotiate ${ctx.unit.attributes.item} with ${ctx.unit.attributes.vendor}. Their last message: ${ctx.unit.attributes.lastVendorMessage}`,
  }), { afterCrash: 'askDriver' })
  .halt('confirmWalkAway', walkAway, {
    when: ctx => ctx.steps.draft.walkAway,
    ask: ctx => `Walk away from ${ctx.unit.attributes.vendor}? Draft offer was: ${ctx.steps.draft.offer}`,
  })
  .exit('walkAway', ctx => ctx.steps.confirmWalkAway?.confirmed === true)
  .step('send', sendOffer, ctx => ({ negotiationId: ctx.unit.attributes.negotiationId, offer: ctx.steps.draft.offer }), {
    afterCrash: 'park',
    alreadyDone: offerSent,
  })
  .exit('offered');

const vendorReplies = webhook.json('vendor-replies', {
  port: H.slot.port(3),
  path: '/vendor/replies',
  secret: H.env('VENDOR_WEBHOOK_SECRET'),
  payload: z.object({
    negotiationId: z.string(),
    message: z.string(),
    outcome: z.enum(['counter', 'agree', 'walkAway']),
  }),
});

const negotiations = H.lane('negotiations', negotiation)
  .supply(H.operator)
  .supply(vendorReplies, (reply, to) =>
    reply.outcome === 'walkAway'
      ? to.signal(vendorWalkedAway, reply.negotiationId, {})
      : reply.outcome === 'agree'
        ? to.signal(vendorAgreed, reply.negotiationId, {})
        : to.signal(vendorReplied, reply.negotiationId, { message: reply.message }))
  .handler(negotiationRound, { exits: { walkAway: walkedAwayByUs, offered: theirMove } })
  .store(harnessStore)
  .retry({ maxAttempts: 3, backoff: 'exponential', initialDelayMs: 600000, exhausted: stalled })
  .on(vendorReplied, { update: (attrs, reply) => ({ ...attrs, lastVendorMessage: reply.message }), enter: ourMove })
  .on(vendorAgreed, { enter: agreed })
  .on(vendorWalkedAway, { enter: walkedAwayByThem })
  .on(expire, { enter: expired });

const negotiationExpiry = H.trigger('negotiation-expiry')
  .on(H.when.timer(negotiations, {
    at: unit => (unit.position === 'terminal' ? undefined : new Date(unit.attributes.deadline)),
  }))
  .signal(expire, negotiations, event => ({ key: event.unit.key, payload: {} }));

const supervisor = claudeCode.supervisor('lifecycles-supervisor', {
  port: H.slot.port(1),
  grants: [
    H.ops.workRead,
    H.ops.workCreate,
    H.ops.workSignal,
    H.ops.workCancel,
    H.ops.attemptsRecover,
    H.ops.resolve(upsell, walkAway),
    H.ops.telemetryRead,
  ],
});

export const harness = H.harness('lifecycles')
  .ledger(sqlite.ledger({ path: './.harness/ledger.sqlite' }))
  .lanes(experiments, tenancies, negotiations)
  .triggers(negotiationExpiry)
  .scheduler(
    H.scheduler('lifecycles-scheduler')
      .standard(negotiations, tenancies, experiments)
      .wip(experiments, 5)
      .admit(experiments, ctx => {
        const ended = ctx.metrics.outcomes({ of: experiments, window: { lastDays: 180 } });
        return ended.terminal < 10 || ended.byState.Inconclusive / ended.terminal < 0.5;
      }),
  )
  .clients(supervisor)
  .observers(
    markdown.board({ path: './.harness/board.md' }),
    markdown.telemetry({ path: './.harness/telemetry.md' }),
  );
