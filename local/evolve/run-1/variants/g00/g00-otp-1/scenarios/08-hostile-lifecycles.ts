import { z } from 'zod';
import { H, Candidate, PolicyEnv, SchedulingInput } from 'harness-dsl';
import * as anthropic from 'harness-dsl/anthropic';
import * as claude from 'harness-dsl/claude-code';
import * as sqlite from 'harness-dsl/sqlite';
import * as local from 'harness-dsl/local';
import * as http from 'harness-dsl/http';
import * as markdown from 'harness-dsl/markdown';

const apiAccount = anthropic.apiKey('business-api', { key: H.env('ANTHROPIC_API_KEY') });
const businessPool = H.pool('business').accounts(apiAccount);
const sonnet = anthropic.model('claude-sonnet-4-5');
const store = '.harness/units.db';

const Planned = H.state('planned', 'pending');
const Running = H.state('running', 'active');
const AWins = H.state('a-wins', 'concluded');
const BWins = H.state('b-wins', 'concluded');
const Inconclusive = H.state('inconclusive', 'concluded');
const ExperimentBroken = H.state('broken', 'failed');
const ExperimentSchema = z.object({ id: z.string(), hypothesis: z.string(), samplesPlanned: z.number() });
const Experiment = H.work('Experiment', ExperimentSchema)
  .states(Planned, Running, AWins, BWins, Inconclusive, ExperimentBroken)
  .key(experiment => experiment.id);

const sampleDue = H.message('sample-due', z.object({ at: z.string() }));
const collectSample = H.command('collect-sample')
  .run((input: { id: string }) => ['experiment-sample', input.id])
  .output(z.object({ a: z.number(), b: z.number() }));
const decideVerdict = H.command('decide-verdict')
  .run((input: { id: string }) => ['experiment-verdict', input.id])
  .output(z.object({ winner: z.enum(['a', 'b', 'none']) }));

const experimentRound = H.flow<z.infer<typeof ExperimentSchema>>('experiment-round')
  .exits('sampled', 'aWins', 'bWins', 'inconclusive')
  .call('sample', collectSample, ctx => ({ id: ctx.unit.data.id }))
  .exitWhen(ctx => (ctx.attempt < ctx.unit.data.samplesPlanned ? 'sampled' : undefined))
  .call('verdict', decideVerdict, ctx => ({ id: ctx.unit.data.id }))
  .exit(ctx => (ctx.steps.verdict.winner === 'a' ? 'aWins' : ctx.steps.verdict.winner === 'b' ? 'bWins' : 'inconclusive'));

const experimentLane = H.lane(Experiment)
  .supply(
    H.supply.operator(),
    H.supply.schedule(Experiment, { every: { hours: 1 } }).send(sampleDue, async tick =>
      (await tick.units.list({ outcome: 'active' })).map(unit => ({ key: unit.key, payload: { at: tick.now.toISOString() } })),
    ),
  )
  .store(sqlite.store(Experiment, store))
  .handler(experimentRound)
  .exits({ sampled: Running, aWins: AWins, bWins: BWins, inconclusive: Inconclusive, crashed: Running })
  .receive(sampleDue, (_sample, unit) => (unit.state === 'running' ? { start: true } : undefined))
  .runner(local.runner('local'));

const Onboarding = H.state('onboarding', 'pending');
const Customer = H.state('customer', 'active');
const UnderReview = H.state('under-review', 'active');
const Suspended = H.state('suspended', 'active');
const Churned = H.state('churned', 'concluded');
const TenancySchema = z.object({ customerId: z.string(), plan: z.string() });
const Tenancy = H.work('Tenancy', TenancySchema)
  .states(Onboarding, Customer, UnderReview, Suspended, Churned)
  .key(tenancy => tenancy.customerId);

const reviewDue = H.message('review-due', z.object({ month: z.string() }));
const suspended = H.message('suspended', z.object({ reason: z.string() }));
const reinstated = H.message('reinstated', z.object({}));
const churned = H.message('churned', z.object({ reason: z.string() }));

const BillingEvent = z.object({
  type: z.enum(['customer.created', 'customer.suspended', 'customer.reinstated', 'customer.churned']),
  customerId: z.string(),
  plan: z.string(),
  reason: z.string(),
});

const billingEvents = http.webhook<z.infer<typeof TenancySchema>>({
  port: H.slot.port(8601),
  path: '/billing',
  route: request => {
    const parsed = BillingEvent.safeParse(request.body);
    if (!parsed.success) return undefined;
    const event = parsed.data;
    if (event.type === 'customer.created') return { create: { customerId: event.customerId, plan: event.plan } };
    if (event.type === 'customer.suspended') return H.deliver(suspended, event.customerId, { reason: event.reason });
    if (event.type === 'customer.reinstated') return H.deliver(reinstated, event.customerId, {});
    return H.deliver(churned, event.customerId, { reason: event.reason });
  },
});

const usageReport = H.command('usage-report')
  .run((input: { customerId: string }) => ['usage-report', input.customerId])
  .output(z.object({ seats: z.number(), activeUsers: z.number(), spendUsd: z.number() }));
const openUpsell = H.command('open-upsell').run((input: { customerId: string; notes: string }) => [
  'crm-upsell',
  input.customerId,
  '--notes',
  input.notes,
]);
const accountAnalyst = H.agent('account-analyst', H.role('account-analyst').instructions('Summarize the month of usage and say whether an upsell fits.'))
  .model(sonnet)
  .pool(businessPool);

const monthlyReview = H.flow<z.infer<typeof TenancySchema>>('monthly-review')
  .exits('reviewed')
  .call('usage', usageReport, ctx => ({ customerId: ctx.unit.data.customerId }))
  .call('summary', accountAnalyst, ctx =>
    `Customer ${ctx.unit.data.customerId} on ${ctx.unit.data.plan}: ${ctx.steps.usage.seats} seats, ${ctx.steps.usage.activeUsers} active, $${ctx.steps.usage.spendUsd}.`,
  )
  .halt('decide', {
    ask: ctx => `Upsell ${ctx.unit.data.customerId}?\n\n${ctx.steps.summary}`,
    decision: z.object({ upsell: z.boolean(), notes: z.string() }),
  })
  .when('upsell', ctx => ctx.steps.decide.upsell, flow =>
    flow.call('openUpsell', openUpsell, ctx => ({ customerId: ctx.unit.data.customerId, notes: ctx.steps.decide.notes })),
  )
  .exit('reviewed');

const tenancyLane = H.lane(Tenancy)
  .supply(
    billingEvents,
    H.supply.schedule(Tenancy, { monthly: { day: 1, at: '08:00' } }).send(reviewDue, async tick =>
      (await tick.units.list({ outcome: 'active', where: unit => unit.state === 'customer' })).map(unit => ({
        key: unit.key,
        payload: { month: tick.now.toISOString().slice(0, 7) },
      })),
    ),
  )
  .store(sqlite.store(Tenancy, store))
  .handler(monthlyReview)
  .exits({ reviewed: Customer, crashed: Customer })
  .phases({ decide: UnderReview })
  .receive(reviewDue, (_due, unit) => (unit.state === 'customer' ? { start: true } : undefined))
  .receive(suspended, () => ({ cancel: true, to: Suspended }))
  .receive(reinstated, (_reinstatement, unit) => (unit.state === 'suspended' ? { to: Customer } : undefined))
  .receive(churned, () => ({ cancel: true, to: Churned }))
  .runner(local.runner('local'));

const Opening = H.state('opening', 'pending');
const Drafting = H.state('drafting', 'active');
const AwaitingVendor = H.state('awaiting-vendor', 'active');
const Agreed = H.state('agreed', 'succeeded');
const WeWalkedAway = H.state('walked-away-by-us', 'concluded');
const TheyWalkedAway = H.state('walked-away-by-them', 'concluded');
const Expired = H.state('expired', 'concluded');
const NegotiationSchema = z.object({
  id: z.string(),
  vendor: z.string(),
  item: z.string(),
  ourLimitUsd: z.number(),
  expiresAt: z.string(),
  lastVendorMessage: z.string().optional(),
});
const Negotiation = H.work('Negotiation', NegotiationSchema)
  .states(Opening, Drafting, AwaitingVendor, Agreed, WeWalkedAway, TheyWalkedAway, Expired)
  .key(negotiation => negotiation.id);

const vendorReplied = H.message('vendor-replied', z.object({ text: z.string(), verdict: z.enum(['counter', 'accepted', 'walked-away']) }));
const VendorReply = z.object({ negotiationId: z.string(), text: z.string(), verdict: z.enum(['counter', 'accepted', 'walked-away']) });

const vendorReplies = http.webhook<z.infer<typeof NegotiationSchema>>({
  port: H.slot.port(8602),
  path: '/vendor-replies',
  route: request => {
    const parsed = VendorReply.safeParse(request.body);
    return parsed.success
      ? H.deliver(vendorReplied, parsed.data.negotiationId, { text: parsed.data.text, verdict: parsed.data.verdict })
      : undefined;
  },
});

const negotiator = H.agent('negotiator', H.role('negotiator').instructions('Draft the next move. Never exceed our limit. Walk away when the deal cannot work.'))
  .model(sonnet)
  .pool(businessPool)
  .output(z.object({ move: z.enum(['offer', 'accept', 'walkAway']), message: z.string() }));
const sendToVendor = H.command('send-to-vendor').run((input: { id: string; message: string }) => [
  'procurement-send',
  input.id,
  '--message',
  input.message,
]);

const negotiationRound = H.flow<z.infer<typeof NegotiationSchema>>('negotiation-round')
  .exits('offered', 'agreed', 'walkedAway')
  .call('move', negotiator, ctx =>
    `Vendor ${ctx.unit.data.vendor}, item ${ctx.unit.data.item}, our limit $${ctx.unit.data.ourLimitUsd}, round ${ctx.attempt}.\nVendor said: ${ctx.unit.data.lastVendorMessage ?? '(nothing yet)'}`,
  )
  .call('send', sendToVendor, ctx => ({ id: ctx.unit.data.id, message: ctx.steps.move.message }))
  .exit(ctx => (ctx.steps.move.move === 'accept' ? 'agreed' : ctx.steps.move.move === 'walkAway' ? 'walkedAway' : 'offered'));

const negotiationLane = H.lane(Negotiation)
  .supply(H.supply.operator(), vendorReplies)
  .store(sqlite.store(Negotiation, store))
  .handler(negotiationRound)
  .exits({ offered: AwaitingVendor, agreed: Agreed, walkedAway: WeWalkedAway, crashed: Opening })
  .phases({ move: Drafting, send: Drafting })
  .receive(vendorReplied, reply =>
    reply.verdict === 'accepted'
      ? { cancel: true, to: Agreed }
      : reply.verdict === 'walked-away'
        ? { cancel: true, to: TheyWalkedAway }
        : { update: { lastVendorMessage: reply.text }, to: Drafting, start: true },
  )
  .deadline(unit => new Date(unit.data.expiresAt))
  .runner(local.runner('local'));

const negotiationExpires = H.trigger('negotiation-expires')
  .on(H.on.deadline(negotiationLane, { while: [Opening, Drafting, AwaitingVendor] }))
  .do(event => H.do.react(negotiationLane, event.unit, { cancel: true, to: Expired }));

const deadlineOf = (candidate: Candidate): number => candidate.deadline?.getTime() ?? Number.MAX_SAFE_INTEGER;
const lifecycleOrder = H.policy('lifecycle-order', (input: SchedulingInput, env: PolicyEnv): readonly Candidate[] => {
  const inconclusive = env.metrics.endedIn({ kind: Experiment, state: Inconclusive, sinceDays: 180 });
  const experimentsMostlyInconclusive = inconclusive.samples >= 10 && (inconclusive.rate ?? 0) >= 0.5;
  const rank = (candidate: Candidate): number =>
    experimentsMostlyInconclusive && candidate.lane === experimentLane.name && candidate.unit.state === 'planned' ? 1 : 0;
  return [...input.pending].sort((a, b) => rank(a) - rank(b) || deadlineOf(a) - deadlineOf(b));
});

const ownerGrant = H.grant(
  'business-owner',
  H.op.readWork,
  H.op.createWork,
  H.op.cancelWork,
  H.op.sendMessage,
  H.op.resolveBlocker,
  H.op.readTelemetry,
);

export const lifecycles = H.harness('lifecycles')
  .ledger(sqlite.ledger('.harness/ledger.db'))
  .lanes(experimentLane, tenancyLane, negotiationLane)
  .triggers(negotiationExpires)
  .scheduler(H.scheduler('lifecycles').order(lifecycleOrder))
  .clients(claude.supervisor({ grant: ownerGrant }))
  .observe(markdown.board({ path: 'BOARD.md' }), markdown.telemetry({ path: 'TELEMETRY.md' }));

void lifecycles.start();
