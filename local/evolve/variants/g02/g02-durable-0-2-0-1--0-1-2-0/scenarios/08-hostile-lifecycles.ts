import { z } from 'zod';
import { H } from 'harness-dsl';
import { sqlite } from 'harness-dsl/sqlite';
import { anthropic } from 'harness-dsl/anthropic';
import { claudeCode } from 'harness-dsl/claude-code';
import { webhook } from 'harness-dsl/webhook';
import { local } from 'harness-dsl/local';
import { markdown } from 'harness-dsl/markdown';

const workstation = local.runner('workstation').slots(4);
const store = sqlite.store({ path: './.harness/units.sqlite' });

const api = anthropic.account('procurement-api', {
  apiKey: H.env('ANTHROPIC_API_KEY'),
  quota: sqlite.quota('procurement-quota', { path: './.harness/quota.sqlite' }),
});
const pool = H.pool('api-pool').accounts(api);
const sonnet = anthropic.model('sonnet', { id: 'claude-sonnet-4-5' });

const NeedsOwner = H.state('NeedsOwner', 'waiting');

const Scheduled = H.state('Scheduled', 'pending');
const AWins = H.terminal('AWins', 'success');
const BWins = H.terminal('BWins', 'success');
const Inconclusive = H.terminal('Inconclusive', 'neutral');

const experimentAttrs = z.object({ experimentId: z.string(), hypothesis: z.string() });
const experiment = H.kind('Experiment')
  .attributes(experimentAttrs)
  .states(Scheduled, NeedsOwner, AWins, BWins, Inconclusive)
  .key(a => a.experimentId);

const hourlySample = z.object({ a: z.number(), b: z.number() });

const measure = H.command('measure-experiment')
  .input(z.object({ experimentId: z.string() }))
  .argv(i => ['./scripts/measure.sh', i.experimentId])
  .output(hourlySample)
  .runner(workstation);

const judge = H.command('judge-experiment')
  .input(z.object({ experimentId: z.string(), samples: z.array(hourlySample) }))
  .argv(i => ['./scripts/judge.sh', i.experimentId, JSON.stringify(i.samples)])
  .output(z.object({ winner: z.enum(['a', 'b', 'none']) }))
  .runner(workstation);

const runExperiment = H.flow('run-experiment')
  .input(experimentAttrs)
  .loop('hours', hourlySample, hour => hour
    .wait('hour', { ms: 3600000 })
    .step('measure', measure, ctx => ({ experimentId: ctx.unit.attributes.experimentId })),
  { max: 336, feed: ctx => ctx.steps.measure })
  .step('judge', judge, ctx => ({ experimentId: ctx.unit.attributes.experimentId, samples: [...ctx.steps.hours] }))
  .exit('aWins', ctx => ctx.steps.judge.winner === 'a')
  .exit('bWins', ctx => ctx.steps.judge.winner === 'b')
  .exit('inconclusive');

const experiments = H.lane('experiments', experiment)
  .supply(H.operator)
  .store(store)
  .handler(runExperiment, { exits: { aWins: AWins, bWins: BWins, inconclusive: Inconclusive } })
  .retry({ maxAttempts: 3, backoff: 'exponential', initialDelayMs: 600000, exhausted: NeedsOwner });

const Customer = H.state('Customer', 'waiting');
const ReviewDue = H.state('ReviewDue', 'pending');
const Suspended = H.state('Suspended', 'waiting');
const Churned = H.terminal('Churned', 'neutral');

const tenancyAttrs = z.object({ tenantId: z.string(), company: z.string(), nextReviewAt: z.string() });
const tenancy = H.kind('Tenancy')
  .attributes(tenancyAttrs)
  .states(ReviewDue, Customer, Suspended, Churned)
  .key(a => a.tenantId);

const reviewDue = H.signal('review-due').payload(z.object({ firedAt: z.string() }));
const suspend = H.signal('suspend');
const reinstate = H.signal('reinstate');
const churn = H.signal('churn');

const usageReport = H.command('usage-report')
  .input(z.object({ tenantId: z.string() }))
  .argv(i => ['./scripts/usage.sh', i.tenantId])
  .output(z.object({ report: z.string() }))
  .runner(workstation);

const accountManager = H.role('account-manager')
  .intents('read')
  .instructions('Summarise the month of usage for a human deciding whether to upsell.');

const summarizer = H.seat('usage-summarizer')
  .role(accountManager)
  .model(sonnet)
  .pool(pool)
  .output(z.object({ summary: z.string() }));

const upsell = H.halt('upsell').decision(z.object({ upsell: z.boolean(), notes: z.string() }));

const monthlyReview = H.flow('monthly-review')
  .input(tenancyAttrs)
  .step('usage', usageReport, ctx => ({ tenantId: ctx.unit.attributes.tenantId }))
  .step('summary', summarizer, ctx => ({ task: `${ctx.unit.attributes.company}\n\n${ctx.steps.usage.report}` }))
  .halt('upsell', upsell, { ask: ctx => `Upsell ${ctx.unit.attributes.company}?\n\n${ctx.steps.summary.summary}` })
  .exit('reviewed');

const tenancies = H.lane('tenancies', tenancy)
  .supply(H.operator)
  .store(store)
  .handler(monthlyReview, { exits: { reviewed: Customer } })
  .retry({ maxAttempts: 3, backoff: 'exponential', initialDelayMs: 3600000, exhausted: Customer })
  .on(reviewDue, {
    update: (a, p) => ({ ...a, nextReviewAt: H.nextTime('09:00', { on: 1, after: new Date(p.firedAt) }).toISOString() }),
    enter: ReviewDue,
  })
  .on(suspend, { enter: Suspended })
  .on(reinstate, { enter: Customer })
  .on(churn, { enter: Churned });

const monthlyReviewDue = H.trigger('monthly-review-due')
  .on(H.when.timer(tenancies, { in: Customer, at: u => new Date(u.attributes.nextReviewAt) }))
  .signal(reviewDue, tenancies, e => ({ key: e.unit.key, payload: { firedAt: e.at.toISOString() } }));

const OurMove = H.state('OurMove', 'pending');
const AwaitingVendor = H.state('AwaitingVendor', 'waiting');
const Agreed = H.terminal('Agreed', 'success');
const WalkedAwayByUs = H.terminal('WalkedAwayByUs', 'neutral');
const WalkedAwayByThem = H.terminal('WalkedAwayByThem', 'neutral');
const Expired = H.terminal('Expired', 'neutral');

const negotiationAttrs = z.object({
  negotiationId: z.string(),
  vendor: z.string(),
  item: z.string(),
  deadline: z.string(),
  history: z.array(z.string()),
});
const negotiation = H.kind('Negotiation')
  .attributes(negotiationAttrs)
  .states(OurMove, AwaitingVendor, NeedsOwner, Agreed, WalkedAwayByUs, WalkedAwayByThem, Expired)
  .key(a => a.negotiationId);

const vendorReplied = H.signal('vendor-replied').payload(z.object({ message: z.string() }));
const vendorWalkedAway = H.signal('vendor-walked-away');
const offerSent = H.signal('offer-sent').payload(z.object({ offer: z.string() }));
const negotiationExpired = H.signal('negotiation-expired');

const negotiator = H.role('negotiator')
  .intents('read')
  .instructions('Draft our next offer, accept the vendor terms, or walk away when the terms cannot meet our limits.');

const drafter = H.seat('offer-drafter')
  .role(negotiator)
  .model(sonnet)
  .pool(pool)
  .output(z.object({ action: z.enum(['offer', 'accept', 'walkAway']), offer: z.string() }));

const sendOffer = H.command('send-offer')
  .input(z.object({ negotiationId: z.string(), offer: z.string() }))
  .argv(i => ['./scripts/send-offer.sh', i.negotiationId, i.offer])
  .output(z.object({ offer: z.string() }))
  .runner(workstation);

const negotiationRound = H.flow('negotiation-round')
  .input(negotiationAttrs)
  .step('draft', drafter, ctx => ({
    task: `Vendor ${ctx.unit.attributes.vendor}, item ${ctx.unit.attributes.item}.\n\n${ctx.unit.attributes.history.join('\n')}`,
  }))
  .exit('agreed', ctx => ctx.steps.draft.action === 'accept')
  .exit('walkedAway', ctx => ctx.steps.draft.action === 'walkAway')
  .step('send', sendOffer, ctx => ({ negotiationId: ctx.unit.attributes.negotiationId, offer: ctx.steps.draft.offer }), { afterCrash: 'park' })
  .exit('offered');

const negotiations = H.lane('negotiations', negotiation)
  .supply(H.operator)
  .supply(webhook.json('vendor-replies', {
    port: H.slot.port(2),
    path: '/vendor-replies',
    secret: H.env('VENDOR_WEBHOOK_SECRET'),
    payload: z.object({ negotiationId: z.string(), type: z.enum(['reply', 'walkAway']), message: z.string() }),
  }), (reply, to) => reply.type === 'walkAway'
    ? to.signal(vendorWalkedAway, reply.negotiationId, {})
    : to.signal(vendorReplied, reply.negotiationId, { message: reply.message }))
  .store(store)
  .handler(negotiationRound, { exits: { agreed: Agreed, walkedAway: WalkedAwayByUs, offered: AwaitingVendor } })
  .retry({ maxAttempts: 3, backoff: 'exponential', initialDelayMs: 300000, exhausted: NeedsOwner })
  .on(vendorReplied, { update: (a, p) => ({ ...a, history: [...a.history, `vendor: ${p.message}`] }), enter: OurMove })
  .on(offerSent, { update: (a, p) => ({ ...a, history: [...a.history, `us: ${p.offer}`] }) })
  .on(vendorWalkedAway, { enter: WalkedAwayByThem })
  .on(negotiationExpired, { enter: Expired });

const offerSentIntoHistory = H.trigger('offer-sent-into-history')
  .on(H.when.step(negotiations, 'send', { if: e => e.ok }))
  .signal(offerSent, negotiations, e => e.output === undefined ? undefined : { key: e.unit.key, payload: { offer: e.output.offer } });

const negotiationDeadline = H.trigger('negotiation-deadline')
  .on(H.when.timer(negotiations, { in: [OurMove, AwaitingVendor], at: u => new Date(u.attributes.deadline) }))
  .signal(negotiationExpired, negotiations, e => ({ key: e.unit.key, payload: {} }));

const supervisor = claudeCode.supervisor('procurement-supervisor', {
  port: H.slot.port(0),
  grants: [H.ops.workRead, H.ops.workCreate, H.ops.workUpdate, H.ops.workCancel, H.ops.resolve(upsell), H.ops.attemptsRecover, H.ops.telemetryRead],
});

export default H.harness('lifecycles')
  .ledger(sqlite.ledger({ path: './.harness/ledger.sqlite' }))
  .lanes(experiments, tenancies, negotiations)
  .triggers(monthlyReviewDue, offerSentIntoHistory, negotiationDeadline)
  .scheduler(H.scheduler('lifecycle-scheduler')
    .standard(negotiations, tenancies, experiments)
    .admit(experiments, ctx => {
      const finished = ctx.metrics.outcomes({ of: experiments, window: { lastDays: 180 } });
      return finished.samples < 10 || finished.inState(Inconclusive) / finished.samples < 0.5;
    }))
  .clients(supervisor)
  .observers(markdown.board({ path: './.harness/BOARD.md' }));
