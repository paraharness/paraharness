import { z } from 'zod';
import { H } from 'harness-dsl';
import type { Kind, Metrics, PendingView, SchedulerView, SupplyOf } from 'harness-dsl';
import * as anthropic from 'harness-dsl/anthropic';
import * as claudeCode from 'harness-dsl/claude-code';
import * as http from 'harness-dsl/http';
import * as sqlite from 'harness-dsl/sqlite';
import * as jsonl from 'harness-dsl/jsonl';
import * as shell from 'harness-dsl/shell';
import * as markdown from 'harness-dsl/markdown';

const categorySchema = z.enum(['billing', 'shipping', 'refund', 'technical', 'other']);
type Category = z.infer<typeof categorySchema>;
const category = H.facet('category', categorySchema.options);

const fresh = H.state('new', 'pending');
const classifying = H.state('classifying', 'pending');
const drafting = H.state('drafting', 'active');
const awaitingApproval = H.state('awaiting-approval', 'active');
const sent = H.state('sent', 'waiting');
const closed = H.state('closed', 'terminal', 'success');
const escalated = H.state('escalated', 'terminal', 'neutral');

const Conversation = H.kind('Conversation')
  .data(z.object({
    customer: z.string(),
    subject: z.string(),
    lastMessage: z.string(),
    slaDueAt: z.string(),
    category: categorySchema.optional(),
    reply: z.string().optional(),
  }))
  .states(fresh, classifying, drafting, awaitingApproval, sent, closed, escalated);

const escalationOpen = H.state('escalation-open', 'pending');
const escalationHandling = H.state('escalation-handling', 'active');
const escalationHandled = H.state('escalation-handled', 'terminal', 'success');
const Escalation = H.kind('Escalation')
  .data(z.object({ conversation: z.string(), customer: z.string(), reason: z.string() }))
  .states(escalationOpen, escalationHandling, escalationHandled);

const auditOpen = H.state('audit-open', 'pending');
const auditInvestigating = H.state('audit-investigating', 'active');
const auditClosed = H.state('audit-closed', 'terminal', 'success');
const auditWithdrawn = H.state('audit-withdrawn', 'terminal', 'neutral');
const Audit = H.kind('Audit')
  .data(z.object({ category: categorySchema, openedAtRate: z.number() }))
  .states(auditOpen, auditInvestigating, auditClosed, auditWithdrawn);

const supportTaste = H.memory('support-taste', 'taste');
const supportExperience = H.memory('support-experience', 'experience');
const tasteArchive = H.archive('support-taste', supportTaste, jsonl.memory('support/taste.jsonl'));
const experienceArchive = H.archive('support-experience', supportExperience, jsonl.memory('support/experience.jsonl'));

const classifierRole = H.role('classifier')
  .input(z.object({ subject: z.string(), message: z.string() }))
  .output(z.object({ category: categorySchema }))
  .prompt(c => `Classify this support conversation.\nSubject: ${c.subject}\n${c.message}`);
const drafterRole = H.role('drafter')
  .input(z.object({ category: categorySchema, subject: z.string(), message: z.string() }))
  .output(z.object({ reply: z.string() }))
  .prompt(c => `Draft a reply for a ${c.category} conversation.\nSubject: ${c.subject}\n${c.message}`);

const classifier = H.agent('classifier', classifierRole).model(anthropic.model('claude-haiku-4'));
const drafter = H.agent('drafter', drafterRole)
  .model(anthropic.model('claude-sonnet-4'))
  .recalls(H.briefing('drafter-briefing', [tasteArchive, experienceArchive]));

const replyApproval = H.halt('reply-approval', z.object({ approved: z.boolean(), editedReply: z.string().optional() }));
const escalationResolution = H.halt('escalation-resolution', z.object({ resolution: z.string() }));
const auditFinding = H.halt('audit-finding', z.object({ finding: z.string() }));

const safeCategory = H.policy.rule('safe-category', (cat: Category, metrics: Metrics) => {
  const record = metrics.rate({
    among: { ...replyApproval.resolved(), facets: [category.is(cat)] },
    count: { ...replyApproval.resolved({ approved: true }), facets: [category.is(cat)] },
  });
  return record.samples >= 200 && record.hits === record.samples;
});

const local = shell.local('local', { slots: 4 });
const sendReply = H.command('send-reply')
  .input(z.object({ conversation: z.string(), reply: z.string() }))
  .argv(r => ['helpdesk-reply', r.conversation, r.reply])
  .on(local)
  .recovers('park');

const conversationFlow = H.flow('conversation').for(Conversation).does(async ctx => {
  const c = ctx.unit.data;
  const classified = await ctx.run(classifier, { subject: c.subject, message: c.lastMessage });
  if (!classified.ok) return ctx.fail(classified.error);
  const cat = classified.value.category;
  ctx.facet(category, cat);
  await ctx.update({ category: cat });
  await ctx.move('drafting');
  const drafted = await ctx.run(drafter, { category: cat, subject: c.subject, message: c.lastMessage });
  if (!drafted.ok) return ctx.fail(drafted.error);
  let reply = drafted.value.reply;
  const safe = await ctx.decide(safeCategory, cat);
  if (!safe) {
    await ctx.move('awaiting-approval');
    const review = await ctx.halt(replyApproval, reply);
    if (!review.approved) {
      await ctx.move('classifying');
      return ctx.fail('reviewer rejected the draft');
    }
    reply = review.editedReply ?? reply;
  }
  const delivered = await ctx.run(sendReply, { conversation: ctx.unit.key, reply });
  if (!delivered.ok) return ctx.fail(delivered.error);
  await ctx.update({ reply });
  return 'sent';
});

const escalationFlow = H.flow('escalation').for(Escalation).does(async ctx => {
  await ctx.move('escalation-handling');
  await ctx.halt(escalationResolution, `${ctx.unit.data.customer}: ${ctx.unit.data.reason}`);
  return 'escalation-handled';
});

const auditContext = H.policy.rule('audit-context', (input: { readonly category: Category; readonly since: Date }, metrics: Metrics) => {
  const opened = metrics.rateBy({
    among: { entry: 'transition', kind: Audit, state: auditOpen },
    count: { entry: 'transition', kind: Audit, state: auditOpen },
    by: category,
    since: input.since,
  });
  const paused = metrics.sum({ of: 'durationMs', among: { entry: 'lane', status: 'resumed', lane: conversationLane }, since: input.since });
  const forCategory = opened[input.category];
  return { auditsThisMonth: forCategory ? forCategory.hits : 0, pausedMsThisMonth: paused.value };
});

const auditFlow = H.flow('audit').for(Audit).does(async ctx => {
  ctx.facet(category, ctx.unit.data.category);
  await ctx.move('audit-investigating');
  const now = ctx.now();
  const context = await ctx.decide(auditContext, { category: ctx.unit.data.category, since: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)) });
  await ctx.halt(
    auditFinding,
    `Approvals for ${ctx.unit.data.category} fell to ${ctx.unit.data.openedAtRate}. Audits this month: ${context.auditsThisMonth}. Conversations lane paused ${Math.round(context.pausedMsThisMonth / 60000)} minutes this month.`
  );
  return 'audit-closed';
});

const helpdeskEvent = z.object({
  event: z.enum(['created', 'customer-reply', 'closed']),
  conversationId: z.string(),
  customer: z.string(),
  subject: z.string(),
  message: z.string(),
  slaDueAt: z.string(),
});
function readHelpdeskEvent(body: z.infer<typeof helpdeskEvent>): SupplyOf<typeof Conversation> {
  if (body.event === 'customer-reply') return { update: body.conversationId, patch: { lastMessage: body.message }, state: 'classifying' };
  if (body.event === 'closed') return { update: body.conversationId, state: 'closed' };
  return { create: { customer: body.customer, subject: body.subject, lastMessage: body.message, slaDueAt: body.slaDueAt }, key: body.conversationId };
}
const helpdeskList = z.object({
  conversations: z.array(z.object({ id: z.string(), customer: z.string(), subject: z.string(), message: z.string(), slaDueAt: z.string() })),
});
function readHelpdeskList(body: z.infer<typeof helpdeskList>): SupplyOf<typeof Conversation>[] {
  return body.conversations.map(c => ({ create: { customer: c.customer, subject: c.subject, lastMessage: c.message, slaDueAt: c.slaDueAt }, key: c.id }));
}

const helpdeskHeaders = { authorization: H.env('HELPDESK_TOKEN') };
const conversationLane = H.lane('conversations', Conversation)
  .handler(conversationFlow)
  .suppliers(
    http.webhook(Conversation, { path: '/helpdesk', secret: H.env('HELPDESK_WEBHOOK_SECRET'), body: helpdeskEvent, read: readHelpdeskEvent }),
    http.poll(Conversation, { url: 'https://helpdesk.example.com/api/open', every: { minutes: 15 }, headers: helpdeskHeaders, body: helpdeskList, read: readHelpdeskList })
  )
  .store(http.store(Conversation, { url: 'https://helpdesk.example.com/api/conversations', headers: helpdeskHeaders, stateField: 'harness_state' }))
  .maxUsdPerUnit(0.4);
const escalationLane = H.lane('escalations', Escalation).handler(escalationFlow);
const auditLane = H.lane('audits', Audit).handler(auditFlow);

const slaBreach = H.trigger(
  'sla-breach-escalates',
  H.on.deadline(Conversation, c => new Date(c.slaDueAt), ['new', 'classifying', 'drafting', 'awaiting-approval']),
  (event, act) => [
    act.create(escalationLane, { conversation: event.unit.key, customer: event.unit.data.customer, reason: 'SLA breached' }, `escalation-${event.unit.key}`),
    act.move('escalated'),
  ]
);

const approvalWatch = H.trigger(
  'approval-rate-watch',
  H.on.metric(
    metrics => metrics.rateBy({ among: replyApproval.resolved(), count: replyApproval.resolved({ approved: true }), by: category, days: 7 }),
    { trip: { below: 0.9 }, reset: { above: 0.95 }, minSamples: 50, group: category }
  ),
  (event, act) => {
    const key = `audit-${event.group}`;
    if (event.state === 'reset') return act.move(auditLane, key, 'audit-withdrawn');
    const rate = event.rate.value ?? 0;
    return [
      act.create(auditLane, { category: event.group, openedAtRate: rate }, key, [category.is(event.group)]),
      act.remember(experienceArchive, {
        text: `When drafting for ${event.group}, recall the stricter phrasing`,
        because: `approvals fell to ${rate.toFixed(2)} over ${event.rate.samples} samples`,
        status: 'candidate',
        when: { kinds: [Conversation], roles: [drafterRole], facets: [category.is(event.group)] },
      }),
    ];
  }
);

const modelErrorWatch = H.trigger(
  'model-error-pauses-conversations',
  H.on.metric(
    metrics => metrics.rate({
      among: { entry: 'invocation', mode: 'model', status: 'ended' },
      count: { entry: 'invocation', mode: 'model', status: 'ended', ok: false },
      hours: 1,
    }),
    { trip: { above: 0.2 }, reset: { below: 0.05 }, minSamples: 20 }
  ),
  (event, act) => (event.state === 'tripped' ? act.pause(conversationLane) : act.resume(conversationLane))
);

function pendingOf<T, S extends string>(view: SchedulerView, kind: Kind<T, S>): PendingView<T, S>[] {
  const found: PendingView<T, S>[] = [];
  for (const unit of view.pending) if (unit.is(kind)) found.push(unit);
  return found;
}

const timeToBreach = H.policy.scheduler('time-to-breach', view => ({
  start: [
    ...pendingOf(view, Escalation),
    ...pendingOf(view, Audit),
    ...pendingOf(view, Conversation).sort((x, y) => Date.parse(x.data.slaDueAt) - Date.parse(y.data.slaDueAt)),
  ],
}));

export const support = H.harness('support')
  .ledger(sqlite.ledger('support/ledger.db'))
  .lanes(conversationLane, escalationLane, auditLane)
  .pools(H.pool('api', [{ account: anthropic.account('support-api', { apiKey: H.env('ANTHROPIC_API_KEY') }), share: 1 }]))
  .triggers(slaBreach, approvalWatch, modelErrorWatch)
  .scheduler(timeToBreach)
  .clients(
    claudeCode.supervisor({
      grants: [H.ops.readWork, H.ops.writeWork, H.ops.resolveHalts, H.ops.readMemory, H.ops.writeMemory, H.ops.curateMemory, H.ops.readTelemetry],
    })
  )
  .observers(markdown.board('support/board.md'), markdown.telemetry('support/telemetry.md'));
