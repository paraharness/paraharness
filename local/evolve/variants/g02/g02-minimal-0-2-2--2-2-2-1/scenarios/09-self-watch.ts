import { z } from 'zod';
import { H } from 'harness-dsl';
import type { Metrics, PendingView, SupplyOf } from 'harness-dsl';
import * as cc from 'harness-dsl/claude-code';
import * as anthropic from 'harness-dsl/anthropic';
import * as sqlite from 'harness-dsl/sqlite';
import * as jsonl from 'harness-dsl/jsonl';
import * as shell from 'harness-dsl/shell';
import * as http from 'harness-dsl/http';
import * as markdown from 'harness-dsl/markdown';

const local = shell.local('local', { slots: 4 });
const apiAccount = anthropic.account('anthropic-api', { apiKey: H.env('ANTHROPIC_API_KEY') });
const haiku = anthropic.model('claude-haiku-4-5');
const sonnet = anthropic.model('claude-sonnet-4-5');

const categoryFacet = H.facet('category', z.string());

const fresh = H.state('new', 'pending');
const classifying = H.state('classifying', 'pending');
const drafting = H.state('drafting', 'pending');
const sent = H.state('sent', 'terminal', 'success');
const closedByCustomer = H.state('closed-by-customer', 'terminal', 'neutral');
const escalated = H.state('escalated', 'terminal', 'failure');

const conversation = H.kind('conversation')
  .data(z.object({
    conversationId: z.string(),
    customerMessage: z.string(),
    slaDueAt: z.string(),
    category: z.string().optional(),
    reviewerNotes: z.string().optional(),
  }))
  .states(fresh, classifying, drafting, sent, closedByCustomer, escalated);

const escalationOpen = H.state('open', 'pending');
const escalationResolved = H.state('resolved', 'terminal', 'success');
const escalationRefunded = H.state('refunded', 'terminal', 'neutral');
const escalation = H.kind('escalation')
  .data(z.object({ conversationId: z.string(), reason: z.string() }))
  .states(escalationOpen, escalationResolved, escalationRefunded);

const auditOpen = H.state('open', 'pending');
const auditClosed = H.state('closed', 'terminal', 'success');
const auditCancelled = H.state('cancelled', 'terminal', 'neutral');
const audit = H.kind('audit')
  .data(z.object({ category: z.string(), rateAtOpen: z.number().nullable() }))
  .states(auditOpen, auditClosed, auditCancelled);

const taste = H.memory('reply-taste', 'taste');
const experience = H.memory('drafting-experience', 'experience');
const replyTaste = H.journal('reply-taste', taste, jsonl.memory('support/.harness/taste.jsonl'));
const draftingExperience = H.journal('drafting-experience', experience, jsonl.memory('support/.harness/experience.jsonl'));

const classifierRole = H.role('classifier')
  .input(z.object({ message: z.string() }))
  .output(z.object({ category: z.string() }))
  .prompt(i => `Classify this customer message into one category:\n${i.message}`);
const drafterRole = H.role('drafter')
  .input(z.object({ message: z.string(), category: z.string(), reviewerNotes: z.string() }))
  .output(z.object({ reply: z.string() }))
  .prompt(i => `Draft a reply (${i.category}) to:\n${i.message}\nReviewer notes: ${i.reviewerNotes}`);

const classifier = H.seat('classifier', classifierRole).model(haiku);
const drafter = H.seat('drafter', drafterRole).model(sonnet).recalls(replyTaste, draftingExperience);

const helpdeskHeaders = { Authorization: H.env('HELPDESK_TOKEN') };

const sendReply = H.command('send-reply')
  .input(z.object({ conversationId: z.string(), reply: z.string() }))
  .argv(i => ['./helpdesk/send-reply.sh', i.conversationId, i.reply])
  .on(local)
  .recovery('park');

const approvalDecision = z.object({ approve: z.boolean(), notes: z.string() });
const approvalAbout = z.object({ category: z.string(), draft: z.string() });
type ApprovalDecision = z.infer<typeof approvalDecision>;
type ApprovalAbout = z.infer<typeof approvalAbout>;

const safeCategory = H.policy.rule(
  'safe-category',
  (about: ApprovalAbout, metrics: Metrics): ApprovalDecision | null => {
    const inCategory = [categoryFacet.value(about.category)];
    const human = metrics.rate({
      among: { ...approval.resolved({ by: 'human' }), facets: inCategory },
      count: { ...approval.resolved({ match: { approve: true }, by: 'human' }), facets: inCategory },
    });
    return human.samples >= 200 && human.hits === human.samples ? { approve: true, notes: 'safe category' } : null;
  }
);

const approval = H.halt('approval', approvalDecision).about(approvalAbout).policy(safeCategory);

const costCeiling = H.halt('cost-ceiling', z.object({ continue: z.boolean() }))
  .about(z.object({ spentUsd: z.number(), limitUsd: z.number() }));

const answerConversation = H.flow('answer-conversation')
  .for(conversation)
  .does(async ctx => {
    const d = ctx.unit.data;
    let category = d.category ?? '';
    if (ctx.unit.state !== 'drafting' || category === '') {
      const classified = await ctx.call(classifier, { message: d.customerMessage });
      if (!classified.ok) return ctx.fail(classified.error);
      category = classified.value.category;
      await ctx.update({ category });
    }
    ctx.tag(categoryFacet, category);
    const drafted = await ctx.call(
      drafter,
      { message: d.customerMessage, category, reviewerNotes: d.reviewerNotes ?? '' },
      { scope: { facets: [categoryFacet.value(category)] } }
    );
    if (!drafted.ok) return ctx.fail(drafted.error);
    const decision = await ctx.halt(approval, drafted.value.reply, { category, draft: drafted.value.reply });
    if (!decision.approve) {
      await ctx.update({ reviewerNotes: decision.notes });
      return 'drafting';
    }
    const delivered = await ctx.call(sendReply, { conversationId: d.conversationId, reply: drafted.value.reply });
    if (!delivered.ok) return ctx.fail(delivered.error);
    return 'sent';
  })
  .maxUsdPerUnit(0.4, costCeiling);

const escalationHandled = H.halt('escalation-handled', z.object({ outcome: z.enum(['resolved', 'refunded']), note: z.string() }))
  .about(z.object({ conversationId: z.string(), reason: z.string() }));

const handleEscalation = H.flow('handle-escalation').for(escalation).does(async ctx => {
  const handled = await ctx.halt(escalationHandled, `Conversation ${ctx.unit.data.conversationId} escalated`, ctx.unit.data);
  return handled.outcome === 'refunded' ? 'refunded' : 'resolved';
});

const auditReview = H.halt('audit-review', z.object({ findings: z.string() }))
  .about(z.object({ category: z.string(), rateAtOpen: z.number().nullable() }));

const runAudit = H.flow('run-audit').for(audit).does(async ctx => {
  await ctx.halt(auditReview, `Approvals slipped for ${ctx.unit.data.category}`, ctx.unit.data);
  return 'closed';
});

const helpdeskEvents = http.webhook(conversation, {
  path: '/helpdesk',
  secret: H.env('HELPDESK_WEBHOOK_SECRET'),
  body: z.discriminatedUnion('type', [
    z.object({ type: z.literal('opened'), conversationId: z.string(), message: z.string(), slaDueAt: z.string() }),
    z.object({ type: z.literal('replied'), conversationId: z.string(), message: z.string() }),
    z.object({ type: z.literal('closed'), conversationId: z.string() }),
  ]),
  read: body =>
    body.type === 'opened'
      ? { create: { conversationId: body.conversationId, customerMessage: body.message, slaDueAt: body.slaDueAt }, key: body.conversationId }
      : body.type === 'replied'
        ? { update: body.conversationId, patch: { customerMessage: body.message }, state: 'classifying' }
        : { update: body.conversationId, state: 'closed-by-customer' },
});

const helpdeskSweep = http.poll(conversation, {
  url: 'https://helpdesk.example.com/api/conversations?status=open',
  every: { minutes: 10 },
  headers: helpdeskHeaders,
  body: z.object({ conversations: z.array(z.object({ id: z.string(), message: z.string(), slaDueAt: z.string() })) }),
  read: body => body.conversations.map((c): SupplyOf<typeof conversation> => ({
    create: { conversationId: c.id, customerMessage: c.message, slaDueAt: c.slaDueAt },
    key: c.id,
  })),
});

const conversations = H.lane('conversations', conversation)
  .handler(answerConversation)
  .suppliers(helpdeskEvents, helpdeskSweep)
  .store(http.store(conversation, {
    url: 'https://helpdesk.example.com/api/conversations',
    headers: helpdeskHeaders,
    stateField: 'harness_state',
  }))
  .wip(6)
  .retry(H.retry('conversation-retry', { retries: 2, backoff: { initialMs: 30_000, factor: 2 } }), 'escalated');

const escalations = H.lane('escalations', escalation)
  .handler(handleEscalation)
  .store(sqlite.store(escalation, 'support/.harness/store.sqlite'));

const audits = H.lane('audits', audit)
  .handler(runAudit)
  .store(sqlite.store(audit, 'support/.harness/store.sqlite'));

const slaBreachEscalates = H.trigger(
  'sla-breach-escalates',
  H.on.deadline(conversation, d => new Date(d.slaDueAt), ['new', 'classifying', 'drafting']),
  (event, act) => [
    act.create(escalations, { conversationId: event.unit.data.conversationId, reason: 'SLA breached' }, `escalation-${event.unit.key}`),
    act.move('escalated'),
  ]
);

const auditKey = (category: string): string => `audit-${category}`;

const approvalSlipped = H.trigger(
  'approval-slipped',
  H.on.metric(
    m => m.rateBy({
      among: approval.resolved(),
      count: approval.resolved({ match: { approve: true } }),
      by: categoryFacet,
      days: 7,
    }),
    { trip: { below: 0.9 }, reset: { above: 0.95 }, minSamples: 50 }
  ),
  (event, act) =>
    event.state === 'tripped'
      ? [
          act.create(audits, { category: event.group, rateAtOpen: event.rate.value }, auditKey(event.group)),
          act.remember(draftingExperience, {
            text: `When drafting for ${event.group}, recall the stricter phrasing`,
            because: `approvals fell to ${event.rate.value ?? 'unknown'} over ${event.rate.samples} samples`,
            when: { roles: [drafterRole], facets: [categoryFacet.value(event.group)] },
            status: 'candidate',
          }),
        ]
      : act.move(audits, auditKey(event.group), 'cancelled')
);

const modelErrorsPause = H.trigger(
  'model-errors-pause-conversations',
  H.on.metric(
    m => m.rate({
      among: { entry: 'invocation', status: 'ended', mode: 'model', lane: conversations },
      count: { entry: 'invocation', status: 'ended', mode: 'model', lane: conversations, ok: false },
      hours: 1,
    }),
    { trip: { above: 0.2 }, reset: { below: 0.05 }, minSamples: 20 }
  ),
  (event, act) => (event.state === 'tripped' ? act.pause(conversations) : act.resume(conversations))
);

const selfWatch = H.report('self-watch', (m, now) => {
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const firings = m.rateBy({
    among: { entry: 'firing', trigger: approvalSlipped, status: 'tripped' },
    count: { entry: 'firing', trigger: approvalSlipped, status: 'tripped' },
    by: 'group',
    since: monthStart,
  });
  const auditsOpenedThisMonthByCategory: Record<string, number> = {};
  for (const [category, opened] of Object.entries(firings)) auditsOpenedThisMonthByCategory[category] = opened.samples;
  return {
    auditsOpenedThisMonthByCategory,
    conversationsPausedMsTotal: m.sum({ of: 'durationMs', among: { entry: 'lane', lane: conversations, status: 'resumed' } }),
    approvalRateByCategory: m.rateBy({
      among: approval.resolved(),
      count: approval.resolved({ match: { approve: true } }),
      by: categoryFacet,
      days: 7,
    }),
    approvalRateByDrafterModel: m.rateBy({
      among: approval.resolved(),
      count: approval.resolved({ match: { approve: true } }),
      by: { modelOf: drafter },
      days: 30,
    }),
  };
});

const breachInMs = (unit: PendingView, now: Date): number =>
  unit.is(conversation) ? Date.parse(unit.data.slaDueAt) - now.getTime() : 0;

const timeToBreach = H.policy.scheduler('time-to-breach', view => ({
  start: [...view.pending].sort((a, b) => breachInMs(a, view.now) - breachInMs(b, view.now)),
}));

export const support = H.harness('support')
  .ledger(sqlite.ledger('support/.harness/ledger.sqlite'))
  .lanes(conversations, escalations, audits)
  .pools(H.pool('api', [{ account: apiAccount, share: 1 }]))
  .triggers(slaBreachEscalates, approvalSlipped, modelErrorsPause)
  .scheduler(timeToBreach)
  .reports(selfWatch)
  .clients(cc.supervisor({
    grants: [
      H.ops.readWork,
      H.ops.writeWork,
      H.ops.resolve(approval, costCeiling, escalationHandled, auditReview, H.parked),
      H.ops.readMemory,
      H.ops.writeMemory,
      H.ops.curateMemory,
      H.ops.readTelemetry,
    ],
  }))
  .observers(markdown.board('support/BOARD.md'), markdown.telemetry('support/TELEMETRY.md'));
