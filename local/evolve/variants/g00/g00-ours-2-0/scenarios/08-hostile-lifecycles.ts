import { z } from 'zod';
import { H } from 'harness-dsl';
import { anthropic } from 'harness-dsl/anthropic';
import { sqlite } from 'harness-dsl/sqlite';
import { http } from 'harness-dsl/http';
import { supply } from 'harness-dsl/supply';
import { policies } from 'harness-dsl/policies';
import { observers } from 'harness-dsl/observers';

const apiAccount = H.account('anthropic-api', anthropic.api({ apiKey: H.env('ANTHROPIC_API_KEY') }));
const sonnet = H.model('claude-sonnet-4-5').pricing(anthropic.pricing());
const apiPool = H.pool('api', [apiAccount]).serves(sonnet).policy(policies.soonestExpiring());
const store = sqlite.store('/srv/biz/.harness/units.sqlite');

const queued = H.state('queued').pending();
const running = H.state('running').active();
const aWins = H.state('a-wins').terminal('success');
const bWins = H.state('b-wins').terminal('success');
const inconclusive = H.state('inconclusive').terminal('neutral');
const experimentBroken = H.state('experiment-broken').terminal('failure');

const experimentSchema = z.object({ experimentId: z.string(), hypothesis: z.string() });
const experimentKind = H.work('Experiment').schema(experimentSchema).states(queued, running, aWins, bWins, inconclusive, experimentBroken);

const hourlySample = z.object({ finished: z.boolean(), winner: z.enum(['A', 'B', 'none']) });
const twoWeekObservation = H.job('two-week-observation')
  .input(experimentSchema)
  .output(z.object({ winner: z.enum(['A', 'B', 'none']) }))
  .submit(async (i, ctx) => {
    await ctx.sh(`experiments start ${i.experimentId} --days 14`);
    return i.experimentId;
  })
  .collect(async (ref, ctx) => {
    const sample = hourlySample.parse(JSON.parse((await ctx.sh(`experiments sample ${ref} --json`)).stdout));
    return sample.finished ? { status: 'done', output: { winner: sample.winner } } : { status: 'running' };
  })
  .poll('1h');

const observeExperiment = H.flow('observe-experiment')
  .input(experimentSchema)
  .step('observe', twoWeekObservation)
  .exit((s) => (s.steps.observe.winner === 'A' ? 'aWins' : s.steps.observe.winner === 'B' ? 'bWins' : 'inconclusive'));

const experiments = H.lane('experiments')
  .of(experimentKind)
  .from(supply.manual())
  .store(store)
  .handle(observeExperiment)
  .exits({ aWins, bWins, inconclusive })
  .retry({ tries: 2, backoff: 'exponential', delaySeconds: 600, exhausted: experimentBroken });

const due = H.state('due').pending();
const reviewing = H.state('reviewing').active();
const current = H.state('current').waiting();
const suspended = H.state('suspended').waiting();
const reviewStalled = H.state('review-stalled').waiting();
const churned = H.state('churned').terminal('neutral');

const tenancySchema = z.object({ tenantId: z.string(), customer: z.string(), reviewMonth: z.string() });
const tenancyKind = H.work('Tenancy').schema(tenancySchema).states(due, reviewing, current, suspended, reviewStalled, churned);

const crmUrl = H.env('CRM_URL');
const monthlyReview = supply
  .schedule({
    cron: '0 6 1 * *',
    units: async (now, ctx) => {
      const response = await fetch(`${ctx.resolve(crmUrl)}/tenants`);
      return z
        .array(z.object({ tenantId: z.string() }))
        .parse(await response.json())
        .map((tenant) => ({ tenantId: tenant.tenantId, reviewMonth: now.toISOString().slice(0, 7) }));
    },
  })
  .key((d) => d.tenantId)
  .updatesOnly();

const usageSchema = z.object({ seats: z.number(), monthlyUsd: z.number(), trend: z.string() });
const usageReview = H.command('usage-review')
  .input(z.object({ tenantId: z.string() }))
  .output(usageSchema)
  .effect('repeatable')
  .run(async (i, ctx) => usageSchema.parse(JSON.parse((await ctx.sh(`billing usage ${i.tenantId} --json`)).stdout)));

const analystRole = H.role('account-analyst').prompt('Summarise a tenant month for an account manager.').intents(['read']);
const accountAnalyst = H.agent('account-analyst').role(analystRole).model(sonnet);
const summarizeUsage = H.skill('summarize-usage')
  .input(z.object({ customer: z.string(), usage: usageSchema }))
  .output(z.object({ text: z.string() }))
  .prompt((i) => `Customer ${i.customer}: ${i.usage.seats} seats, $${i.usage.monthlyUsd} per month, trend ${i.usage.trend}.`);

const accountDecision = H.halt('account-decision')
  .context(z.object({ customer: z.string(), summary: z.string() }))
  .ask((c) => `How do we proceed with ${c.customer}?\n\n${c.summary}`)
  .decision(z.object({ action: z.enum(['retain', 'upsell', 'suspend', 'churn']), note: z.string() }));

const reviewTenancy = H.flow('review-tenancy')
  .input(tenancySchema)
  .step('usage', usageReview, (s) => ({ tenantId: s.input.tenantId }))
  .step('summary', accountAnalyst.call(summarizeUsage), (s) => ({ customer: s.input.customer, usage: s.steps.usage }))
  .halt('decision', accountDecision, (s) => ({ customer: s.input.customer, summary: s.steps.summary.text }))
  .exit((s) =>
    s.steps.decision.action === 'churn' ? 'churned' : s.steps.decision.action === 'suspend' ? 'suspended' : 'reviewed',
  );

const tenancies = H.lane('tenancies')
  .of(tenancyKind)
  .from(supply.manual(), monthlyReview)
  .store(store)
  .handle(reviewTenancy)
  .exits({ reviewed: current, suspended, churned })
  .retry({ tries: 2, backoff: 'exponential', delaySeconds: 3600, exhausted: reviewStalled });

const open = H.state('open').pending();
const drafting = H.state('drafting').active();
const awaitingVendor = H.state('awaiting-vendor').waiting();
const agreed = H.state('agreed').terminal('success');
const weWalkedAway = H.state('we-walked-away').terminal('neutral');
const theyWalkedAway = H.state('they-walked-away').terminal('neutral');
const expired = H.state('expired').terminal('neutral');
const negotiationStalled = H.state('negotiation-stalled').terminal('failure');

const negotiationSchema = z.object({
  negotiationId: z.string(),
  vendor: z.string(),
  item: z.string(),
  targetUsd: z.number(),
  expiresAt: z.string(),
  vendorStatus: z.enum(['none', 'countered', 'accepted', 'walkedAway']),
  vendorMessage: z.string(),
});
const negotiationKind = H.work('Negotiation')
  .schema(negotiationSchema)
  .states(open, drafting, awaitingVendor, agreed, weWalkedAway, theyWalkedAway, expired, negotiationStalled);

const vendorReplies = http
  .webhook({
    path: '/vendors/replies',
    schema: z.object({ negotiationId: z.string(), status: z.enum(['countered', 'accepted', 'walkedAway']), message: z.string() }),
    secret: H.env('VENDOR_WEBHOOK_SECRET'),
  })
  .map((reply) => ({ negotiationId: reply.negotiationId, vendorStatus: reply.status, vendorMessage: reply.message }))
  .key((d) => d.negotiationId)
  .updatesOnly();

const negotiatorRole = H.role('negotiator').promptFile('prompts/negotiator.md').intents(['read']);
const negotiator = H.agent('negotiator').role(negotiatorRole).model(sonnet);
const draftOffer = H.skill('draft-offer')
  .input(z.object({ vendor: z.string(), item: z.string(), targetUsd: z.number(), vendorMessage: z.string() }))
  .output(z.object({ action: z.enum(['offer', 'walkAway']), amountUsd: z.number(), message: z.string() }))
  .prompt((i) => `Vendor ${i.vendor} on ${i.item}, our target $${i.targetUsd}. Their last message: ${i.vendorMessage}`);

const sendOffer = H.command('send-offer')
  .input(z.object({ negotiationId: z.string(), amountUsd: z.number(), message: z.string() }))
  .effect('unrepeatable')
  .run(async (i, ctx) => {
    const result = await ctx.sh(`procurement send-offer ${i.negotiationId} --amount ${i.amountUsd}`, { stdin: i.message });
    if (result.code !== 0) throw new Error(result.stderr);
  });

const negotiationRound = H.flow('negotiation-round')
  .input(negotiationSchema)
  .when((s) => s.input.vendorStatus === 'accepted', (f) => f.exit('agreed'))
  .when((s) => s.input.vendorStatus === 'walkedAway', (f) => f.exit('theyWalkedAway'))
  .step('offer', negotiator.call(draftOffer), (s) => ({
    vendor: s.input.vendor,
    item: s.input.item,
    targetUsd: s.input.targetUsd,
    vendorMessage: s.input.vendorMessage,
  }))
  .when((s) => s.steps.offer.action === 'walkAway', (f) => f.exit('weWalkedAway'))
  .step('send', sendOffer, (s) => ({
    negotiationId: s.input.negotiationId,
    amountUsd: s.steps.offer.amountUsd,
    message: s.steps.offer.message,
  }))
  .exit('offered');

const negotiations = H.lane('negotiations')
  .of(negotiationKind)
  .from(supply.manual(), vendorReplies)
  .store(store)
  .handle(negotiationRound)
  .exits({ agreed, theyWalkedAway, weWalkedAway, offered: awaitingVendor })
  .retry({ tries: 2, backoff: 'exponential', delaySeconds: 900, exhausted: negotiationStalled });

const negotiationExpiry = H.trigger('negotiation-expiry')
  .on(negotiations.due((u) => new Date(u.data.expiresAt)))
  .do(negotiations.move(expired));

const inconclusiveRate = H.metric('experiment-inconclusive-rate').rate(H.events.entered(inconclusive), H.events.terminal());

const lifecyclePriority = H.policy.schedule('decisions-before-experiments', ({ candidates, metrics }) => {
  const reading = metrics.read(inconclusiveRate, { window: '30d', where: { kind: experimentKind } });
  const experimentsLast = reading.samples >= 10 && (reading.value ?? 0) >= 0.5;
  const rank = (lane: string) => (lane === negotiations.name ? 0 : lane === tenancies.name ? 1 : experimentsLast ? 3 : 2);
  return [...candidates].sort((a, b) => rank(a.lane.name) - rank(b.lane.name) || b.waitingSeconds - a.waitingSeconds);
});

export const business = H.harness('business')
  .ledger(sqlite.ledger('/srv/biz/.harness/ledger.sqlite'))
  .pools(apiPool)
  .lanes(experiments, tenancies, negotiations)
  .triggers(negotiationExpiry)
  .scheduler(H.scheduler().policy(lifecyclePriority))
  .grants(
    H.grant(
      http.client('operator', { port: 8710, token: H.env('OPERATOR_TOKEN') }),
      H.ops.work.read,
      H.ops.work.write,
      H.ops.resolve(accountDecision),
      H.ops.telemetry.read,
    ),
  )
  .metrics(inconclusiveRate)
  .observe(observers.board({ path: '/srv/biz/.harness/board.md' }));
