import { z } from 'zod';
import { H, Band, Route, Router } from 'harness-dsl';
import { sqlite } from 'harness-dsl/sqlite';
import { jsonl } from 'harness-dsl/jsonl';
import { claudeCode } from 'harness-dsl/claude-code';
import { zendesk, ZendeskEvent } from 'harness-dsl/zendesk';
import { local } from 'harness-dsl/local';
import { markdown } from 'harness-dsl/markdown';

const categorySchema = z.enum(['billing', 'shipping', 'refunds', 'account']);
const category = H.facet('category', categorySchema.options);
const categoryScope = H.resources('conversation-category', categorySchema.options);

const conversationAttrs = z.object({
  ticketId: z.string(),
  subject: z.string(),
  message: z.string(),
  customerEmail: z.string(),
  slaDueAt: z.coerce.date(),
});
type ConversationAttrs = z.infer<typeof conversationAttrs>;

const New = H.state('New', 'pending');
const Sent = H.state('Sent', 'waiting');
const ClosedByCustomer = H.terminal('ClosedByCustomer', 'success');
const Escalated = H.terminal('Escalated', 'failure');
const Conversation = H.kind('Conversation')
  .attributes(conversationAttrs)
  .states(New, Sent, ClosedByCustomer, Escalated)
  .key(a => a.ticketId)
  .initial(New);

const customerReplied = H.signal('customer-replied').payload(z.object({ message: z.string() }));
const customerClosed = H.signal('customer-closed');
const escalate = H.signal('escalate');

const quota = sqlite.quota('support-subscriptions', { path: './.harness/quota.sqlite' });
const subscription = claudeCode.subscription('support', { token: H.env('CLAUDE_TOKEN'), quota });
const pool = H.pool('support').accounts(subscription);
const haiku = claudeCode.model('haiku', { id: 'claude-haiku-4-5' });
const sonnet = claudeCode.model('sonnet', { id: 'claude-sonnet-4-5' });
const opus = claudeCode.model('opus', { id: 'claude-opus-4-1' });

const classifierRole = H.role('classifier').intents('read').instructions('Classify the conversation into one category.');
const drafterRole = H.role('drafter').intents('read').instructions('Draft the reply to the customer.');
const reviewerRole = H.role('reviewer').intents('record').instructions('Approve or edit drafted replies.');

const approval = H.halt('reply-approval').decision(z.object({ approved: z.boolean(), reply: z.string().optional() }));
const costCeiling = H.halt('cost-ceiling').decision(H.ceilingDecision);
const escalationHandle = H.halt('escalation-handle').decision(z.object({ resolution: z.string() }));
const auditReview = H.halt('audit-review').decision(z.object({ findings: z.string() }));

const approvalRate = H.metric('approval-rate', H.when.decision(Conversation, approval)).samples(e =>
  e.resolvedBy === 'human' ? [{ hit: e.decision.approved, facets: e.facets, model: e.modelOf(drafter) }] : []);

const approvalBand = {
  window: { lastDays: 7 },
  minSamples: 50,
  enter: { below: 0.9 },
  exit: { above: 0.95 },
  per: category,
};
const approvalDropped = H.when.crossing(approvalRate, approvalBand, 'entered');
const approvalRecovered = H.when.crossing(approvalRate, approvalBand, 'exited');
const auditsOpened = H.metric('audits-opened', approvalDropped).amounts(e => [{ amount: 1, facets: [e.group] }]);

const modelErrorRate = H.metric('model-error-rate', H.when.invocation({ lanes: [conversationsRef()] }))
  .samples(e => (e.model ? [{ hit: !e.ok, model: e.model }] : []));
function conversationsRef() {
  return conversations;
}
const errorBand: Band = { window: { lastHours: 1 }, minSamples: 20, enter: { above: 0.2 }, exit: { below: 0.05 } };

const drafterModel = H.policy.model('drafter-model', [sonnet, opus], ctx => {
  const paused = ctx.metrics.paused({ lane: conversations, window: { calendar: 'week' } });
  return paused.totalMs > 3_600_000 ? opus : sonnet;
});

const classifier = H.seat('classifier').role(classifierRole).model(haiku).pool(pool).output(z.object({ category: categorySchema }));
const drafter = H.seat('drafter').role(drafterRole).model(drafterModel).pool(pool).output(z.object({ reply: z.string() }));

const safeCategory = H.policy.halt('safe-category', Conversation, approval).decide(ctx => {
  const facet = ctx.facets.find(f => f.facet === category);
  if (facet === undefined) return undefined;
  const approvals = ctx.metrics.rate(approvalRate, { facets: [facet] });
  const audited = ctx.metrics.total(auditsOpened, { facets: [facet], window: { calendar: 'month' } });
  return approvals.samples >= 200 && approvals.hits === approvals.samples && audited.total === 0 ? { approved: true } : undefined;
});

const sendReply = H.command('send-reply')
  .input(z.object({ ticketId: z.string(), reply: z.string() }))
  .argv(i => ['./helpdesk/send-reply.sh', i.ticketId, i.reply])
  .runner(local.runner('local'));

const conversationFlow = H.flow('conversation')
  .input(conversationAttrs)
  .step('classify', classifier, ctx => ({ task: `Classify: ${ctx.unit.attributes.subject}\n${ctx.unit.attributes.message}` }))
  .step('draft', drafter, ctx => ({
    task: `Reply to ${ctx.unit.attributes.customerEmail} about ${ctx.unit.attributes.subject}:\n${ctx.unit.attributes.message}`,
    resources: [categoryScope.of(ctx.steps.classify.category)],
  }))
  .halt('approval', approval, {
    ask: ctx => `Approve this reply?\n${ctx.steps.draft.reply}`,
    facets: ctx => [category.of(ctx.steps.classify.category)],
    skip: safeCategory,
  })
  .exit('handover', ctx => !ctx.steps.approval.approved)
  .step('send', sendReply, ctx => ({ ticketId: ctx.unit.attributes.ticketId, reply: ctx.steps.approval.reply ?? ctx.steps.draft.reply }), { afterCrash: 'park' })
  .exit('sent');

const slaHours: Record<ZendeskEvent['priority'], number> = { low: 48, normal: 24, high: 8, urgent: 2 };
function routeTicket(e: ZendeskEvent, to: Router<ConversationAttrs>): Route {
  if (e.type === 'created') {
    return to.create({
      ticketId: e.ticketId,
      subject: e.subject,
      message: e.message,
      customerEmail: e.customerEmail,
      slaDueAt: new Date(e.createdAt.getTime() + slaHours[e.priority] * 3_600_000),
    });
  }
  if (e.status === 'solved' || e.status === 'closed') return to.signal(customerClosed, e.ticketId, {});
  if (e.type === 'replied') return to.signal(customerReplied, e.ticketId, { message: e.message });
  return to.skip();
}

const conversations = H.lane('conversations', Conversation)
  .supply(zendesk.webhook({ port: H.slot.port(1), path: '/helpdesk', secret: H.env('HELPDESK_WEBHOOK_SECRET') }), routeTicket)
  .supply(zendesk.poll({ subdomain: 'acme', token: H.env('HELPDESK_TOKEN'), everyMinutes: 10 }), routeTicket)
  .store(zendesk.store({ subdomain: 'acme', token: H.env('HELPDESK_TOKEN') }))
  .handler(conversationFlow, { exits: { sent: Sent, handover: Escalated } })
  .retry({ maxAttempts: 3, backoff: 'exponential', initialDelayMs: 30_000, exhausted: Escalated })
  .ceiling({ maxUsd: 0.4, onExceed: costCeiling })
  .on(customerReplied, { update: (a, p) => ({ ...a, message: p.message }), enter: New, at: ['approval'] })
  .on(customerClosed, { enter: ClosedByCustomer })
  .on(escalate, { enter: Escalated });

const escalationAttrs = z.object({ ticketId: z.string(), subject: z.string(), breachedAt: z.coerce.date() });
const EscalationOpen = H.state('EscalationOpen', 'pending');
const EscalationStalled = H.state('EscalationStalled', 'waiting');
const EscalationHandled = H.terminal('EscalationHandled', 'success');
const Escalation = H.kind('Escalation')
  .attributes(escalationAttrs)
  .states(EscalationOpen, EscalationStalled, EscalationHandled)
  .key(a => a.ticketId)
  .initial(EscalationOpen);

const escalationFlow = H.flow('escalation')
  .input(escalationAttrs)
  .halt('handle', escalationHandle, { ask: ctx => `SLA breached on ${ctx.unit.attributes.ticketId}: ${ctx.unit.attributes.subject}` })
  .exit('handled');

const escalations = H.lane('escalations', Escalation)
  .handler(escalationFlow, { exits: { handled: EscalationHandled } })
  .retry({ maxAttempts: 1, exhausted: EscalationStalled });

const auditAttrs = z.object({ category: categorySchema });
const AuditOpen = H.state('AuditOpen', 'pending');
const AuditStalled = H.state('AuditStalled', 'waiting');
const AuditClosed = H.terminal('AuditClosed', 'success');
const AuditCancelled = H.terminal('AuditCancelled', 'neutral');
const Audit = H.kind('Audit')
  .attributes(auditAttrs)
  .states(AuditOpen, AuditStalled, AuditClosed, AuditCancelled)
  .key(a => a.category)
  .initial(AuditOpen);

const auditFlow = H.flow('audit')
  .input(auditAttrs)
  .halt('review', auditReview, { ask: ctx => `Approval rate for ${ctx.unit.attributes.category} fell below 0.9. Audit the recent drafts.` })
  .exit('closed');

const audits = H.lane('audits', Audit)
  .handler(auditFlow, { exits: { closed: AuditClosed } })
  .retry({ maxAttempts: 1, exhausted: AuditStalled })
  .on(H.cancel, { enter: AuditCancelled });

const taste = H.journal('taste', H.memory('taste', 'taste'))
  .store(jsonl.memoryStore({ path: './.harness/taste.jsonl' }))
  .recall({ by: 'specificity', limit: 10 })
  .readBy(drafterRole)
  .recordedBy(reviewerRole);
const experience = H.journal('experience', H.memory('experience', 'experience'))
  .store(jsonl.memoryStore({ path: './.harness/experience.jsonl' }))
  .recall({ by: 'specificity', limit: 10 })
  .readBy(drafterRole);

const slaBreach = H.trigger('sla-breach')
  .on(H.when.timer(conversations, { at: u => (u.position === 'terminal' || u.state === Sent ? undefined : u.attributes.slaDueAt) }))
  .create(escalations, e => ({ ticketId: e.unit.attributes.ticketId, subject: e.unit.attributes.subject, breachedAt: e.at }))
  .signal(escalate, conversations, e => ({ key: e.unit.key, payload: {} }));

const openAudit = H.trigger('open-audit')
  .on(approvalDropped)
  .create(audits, e => ({ category: e.group.value }))
  .record(experience, e => ({
    text: `When drafting for ${e.group.value}, recall the stricter phrasing, because approvals fell to ${e.rate.toFixed(2)}.`,
    when: { roles: [drafterRole], kinds: [Conversation], resources: [categoryScope.of(e.group.value)] },
    status: 'candidate',
  }));

const closeAudit = H.trigger('close-audit')
  .on(approvalRecovered)
  .signal(H.cancel, audits, e => ({ key: e.group.value, payload: { reason: `approval rate recovered to ${e.rate.toFixed(2)} over ${e.samples} samples` } }));

const pauseOnModelErrors = H.trigger('pause-on-model-errors')
  .on(H.when.crossing(modelErrorRate, errorBand, 'entered'))
  .pause(conversations, e => `model error rate ${e.rate.toFixed(2)} over ${e.samples} invocations in the last hour`);

const resumeOnModelRecovery = H.trigger('resume-on-model-recovery')
  .on(H.when.crossing(modelErrorRate, errorBand, 'exited'))
  .resume(conversations, e => `model error rate recovered to ${e.rate.toFixed(2)} over ${e.samples} invocations`);

const reviewer = claudeCode.supervisor('reviewer', {
  port: H.slot.port(2),
  grants: [
    H.ops.workRead, H.ops.workUpdate, H.ops.workSignal,
    H.ops.resolve(approval, costCeiling, escalationHandle, auditReview),
    H.ops.memoryRead, H.ops.memoryWrite, H.ops.memoryCurate,
    H.ops.lanesPause, H.ops.telemetryRead,
  ],
});

export const supportHarness = H.harness('support')
  .ledger(sqlite.ledger({ path: './.harness/ledger.sqlite' }))
  .lanes(conversations, escalations, audits)
  .journals(taste, experience)
  .triggers(slaBreach, openAudit, closeAudit, pauseOnModelErrors, resumeOnModelRecovery)
  .metrics(approvalRate, auditsOpened, modelErrorRate)
  .scheduler(H.scheduler('support')
    .fixedDate(conversations, u => u.attributes.slaDueAt)
    .standard(escalations, audits))
  .clients(reviewer)
  .observers(markdown.board({ path: './BOARD.md' }), markdown.telemetry({ path: './TELEMETRY.md' }));
