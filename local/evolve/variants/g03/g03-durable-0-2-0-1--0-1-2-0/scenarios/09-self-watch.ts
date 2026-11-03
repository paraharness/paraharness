import { z } from 'zod';
import { H, type Metrics, type Router, type Route, type FacetBand, type Band } from 'harness-dsl';
import { anthropic } from 'harness-dsl/anthropic';
import { sqlite } from 'harness-dsl/sqlite';
import { jsonl } from 'harness-dsl/jsonl';
import { local } from 'harness-dsl/local';
import { claudeCode } from 'harness-dsl/claude-code';
import { markdown } from 'harness-dsl/markdown';
import { zendesk, type ZendeskEvent } from 'harness-dsl/zendesk';

const CategorySchema = z.enum(['billing', 'refund', 'shipping', 'account']);
type Category = z.infer<typeof CategorySchema>;
const category = H.facet('category', CategorySchema.options);

const apiAccount = anthropic.account('support-api', {
  apiKey: H.env('ANTHROPIC_API_KEY'),
  quota: sqlite.quota('support-api', { path: '.harness/quota.db' }),
});
const haiku = anthropic.model('haiku', { id: 'claude-haiku-4-5' });
const sonnet = anthropic.model('sonnet', { id: 'claude-sonnet-4-5' });
const pool = H.pool('support').accounts(apiAccount);

const classifier = H.role('classifier').intents('read').instructions('Classify the conversation into one category.');
const drafter = H.role('drafter').intents('read').instructions('Draft the reply to the customer.');
const reviewer = H.role('reviewer').intents('read', 'record').instructions('Approve or edit outgoing replies.');

const classifierSeat = H.seat('classifier').role(classifier).model(haiku).pool(pool);
const drafterSeat = H.seat('drafter').role(drafter).model(sonnet).pool(pool);

const classify = H.call('classify', classifierSeat).output(z.object({ category: CategorySchema }));
const draftReply = H.call('draft-reply', drafterSeat);

const taste = H.journal('support-taste', H.memory('taste', 'taste'))
  .store(jsonl.memoryStore({ path: '.harness/taste.jsonl' }))
  .recall({ by: 'specificity', limit: 10 })
  .readBy(drafter)
  .recordedBy(reviewer);
const experience = H.journal('support-experience', H.memory('experience', 'experience'))
  .store(jsonl.memoryStore({ path: '.harness/experience.jsonl' }))
  .recall({ by: 'specificity', limit: 10 })
  .readBy(drafter);

const ConversationAttrs = z.object({
  ticketId: z.string(),
  subject: z.string(),
  customerEmail: z.string(),
  messages: z.array(z.string()),
  slaDeadline: z.string(),
});
type ConversationAttrs = z.infer<typeof ConversationAttrs>;

const New = H.state('New', 'pending');
const AwaitingCustomer = H.state('AwaitingCustomer', 'waiting');
const ClosedByCustomer = H.terminal('ClosedByCustomer', 'success');
const Escalated = H.terminal('Escalated', 'neutral');

const Conversation = H.kind('Conversation')
  .attributes(ConversationAttrs)
  .states(New, AwaitingCustomer, ClosedByCustomer, Escalated)
  .key(attrs => attrs.ticketId)
  .initial(New);

const replyApproval = H.halt('reply-approval').decision(z.object({ approved: z.boolean(), editedReply: z.string().optional() }));
const costCeiling = H.halt('conversation-cost-ceiling').decision(H.ceilingDecision);

const approvalRate = H.metric('approval-rate', H.when.decision(Conversation, replyApproval)).samples(event =>
  event.resolvedBy === 'human'
    ? [{ hit: event.decision.approved, facets: event.facets, seat: drafterSeat, model: event.modelOf(drafterSeat) }]
    : []);

const safeCategory = H.policy.halt('safe-category', Conversation, replyApproval).decide(ctx => {
  const record = ctx.metrics.rate(approvalRate, { facets: ctx.facets });
  return record.samples >= 200 && record.hits === record.samples ? { approved: true } : undefined;
});

const sendReply = H.command('send-reply')
  .input(z.object({ ticketId: z.string(), reply: z.string() }))
  .argv(input => ['./support/send-reply', input.ticketId, input.reply])
  .runner(local.runner('support-local'));

const answerConversation = H.flow('answer-conversation')
  .input(ConversationAttrs)
  .step('classify', classify, ctx => ({ text: `${ctx.unit.attributes.subject}\n\n${ctx.unit.attributes.messages.join('\n---\n')}` }))
  .step('draft', draftReply, ctx => ({
    text: `Reply to the customer.\n\n${ctx.unit.attributes.messages.join('\n---\n')}`,
    facets: [category.of(ctx.steps.classify.category)],
  }))
  .halt('approve', replyApproval, {
    ask: ctx => ctx.steps.draft,
    skip: safeCategory,
    facets: ctx => [category.of(ctx.steps.classify.category)],
  })
  .exit('rejected', ctx => !ctx.steps.approve.approved)
  .step('send', sendReply, ctx => ({ ticketId: ctx.unit.attributes.ticketId, reply: ctx.steps.approve.editedReply ?? ctx.steps.draft }), {
    afterCrash: 'park',
  })
  .exit('sent');

const customerReplied = H.signal('customer-replied').payload(z.object({ message: z.string() }));
const customerClosed = H.signal('customer-closed');
const slaEscalated = H.signal('sla-escalated');

const slaHours: Record<ZendeskEvent['priority'], number> = { urgent: 1, high: 4, normal: 24, low: 48 };

const routeHelpdesk = (event: ZendeskEvent, to: Router<ConversationAttrs>): Route => {
  if (event.type === 'created') {
    return to.create({
      ticketId: event.ticketId,
      subject: event.subject,
      customerEmail: event.customerEmail,
      messages: [event.message],
      slaDeadline: new Date(event.createdAt.getTime() + slaHours[event.priority] * 3600000).toISOString(),
    });
  }
  if (event.status === 'solved' || event.status === 'closed') return to.signal(customerClosed, event.ticketId, {});
  return to.signal(customerReplied, event.ticketId, { message: event.message });
};

const conversations = H.lane('conversations', Conversation)
  .supply(zendesk.webhook({ port: H.slot.port(2), path: '/helpdesk', secret: H.env('HELPDESK_WEBHOOK_SECRET') }), routeHelpdesk)
  .supply(zendesk.poll({ subdomain: 'acme', token: H.env('HELPDESK_TOKEN'), everyMinutes: 10 }), routeHelpdesk)
  .store(zendesk.store({ subdomain: 'acme', token: H.env('HELPDESK_TOKEN') }))
  .handler(answerConversation, { exits: { sent: AwaitingCustomer, rejected: New } })
  .retry({ maxAttempts: 2, backoff: 'exponential', initialDelayMs: 60000, exhausted: Escalated })
  .ceiling({ maxUsd: 0.4, onExceed: costCeiling })
  .on(customerReplied, {
    update: (attrs, payload) => ({ ...attrs, messages: [...attrs.messages, payload.message] }),
    restart: 'classify',
    at: ['approve'],
    enter: New,
  })
  .on(customerClosed, { enter: ClosedByCustomer })
  .on(slaEscalated, { enter: Escalated });

const EscalationAttrs = z.object({ ticketId: z.string(), reason: z.string() });
const EscalationOpen = H.state('EscalationOpen', 'pending');
const EscalationStuck = H.state('EscalationStuck', 'waiting');
const EscalationHandled = H.terminal('EscalationHandled', 'success');
const Escalation = H.kind('Escalation')
  .attributes(EscalationAttrs)
  .states(EscalationOpen, EscalationStuck, EscalationHandled)
  .key(attrs => attrs.ticketId)
  .initial(EscalationOpen);

const escalationHandled = H.halt('escalation-handled').decision(z.object({ resolution: z.string() }));
const handleEscalation = H.flow('handle-escalation')
  .input(EscalationAttrs)
  .halt('handle', escalationHandled, { ask: ctx => `Ticket ${ctx.unit.attributes.ticketId} escalated: ${ctx.unit.attributes.reason}` })
  .exit('handled');

const escalations = H.lane('escalations', Escalation)
  .handler(handleEscalation, { exits: { handled: EscalationHandled } })
  .retry({ maxAttempts: 1, exhausted: EscalationStuck });

const AuditAttrs = z.object({ category: CategorySchema, rate: z.number(), samples: z.number() });
const AuditOpen = H.state('AuditOpen', 'pending');
const AuditStuck = H.state('AuditStuck', 'waiting');
const AuditClosed = H.terminal('AuditClosed', 'success');
const AuditCancelled = H.terminal('AuditCancelled', 'neutral');
const Audit = H.kind('Audit')
  .attributes(AuditAttrs)
  .states(AuditOpen, AuditStuck, AuditClosed, AuditCancelled)
  .key(attrs => attrs.category)
  .initial(AuditOpen);

const auditFinding = H.halt('audit-finding').decision(z.object({ finding: z.string(), actionTaken: z.string() }));
const categoryAudit = H.flow('category-audit')
  .input(AuditAttrs)
  .halt('review', auditFinding, {
    ask: ctx => `Approvals for ${ctx.unit.attributes.category} fell to ${ctx.unit.attributes.rate.toFixed(2)} over ${ctx.unit.attributes.samples} samples.`,
    facets: ctx => [category.of(ctx.unit.attributes.category)],
  })
  .exit('closed');

const audits = H.lane('audits', Audit)
  .handler(categoryAudit, { exits: { closed: AuditClosed } })
  .retry({ maxAttempts: 1, exhausted: AuditStuck })
  .on(H.cancel, { enter: AuditCancelled });

const approvalBand: FacetBand<Category> = {
  window: { lastDays: 7 },
  minSamples: 50,
  enter: { below: 0.9 },
  exit: { above: 0.95 },
  per: category,
};

const approvalsFell = H.trigger('approvals-fell')
  .on(H.when.crossing(approvalRate, approvalBand, 'entered'))
  .create(audits, event => ({ category: event.value, rate: event.rate, samples: event.samples }))
  .record(experience, event => ({
    text: `When drafting for ${event.value}, recall the stricter phrasing, because approvals fell to ${event.rate.toFixed(2)}.`,
    when: { roles: [drafter], facets: [category.of(event.value)] },
    status: 'candidate',
  }));

const approvalsRecovered = H.trigger('approvals-recovered')
  .on(H.when.crossing(approvalRate, approvalBand, 'exited'))
  .signal(H.cancel, audits, event => ({
    key: event.value,
    payload: { reason: `approvals recovered to ${event.rate.toFixed(2)} over ${event.samples} samples` },
  }));

const modelErrorRate = H.metric('model-error-rate', H.when.invocation({ lanes: [conversations] })).samples(event => [
  { hit: !event.ok, seat: event.seat, model: event.model },
]);

const errorBand: Band = { window: { lastHours: 1 }, minSamples: 20, enter: { above: 0.2 }, exit: { below: 0.05 } };

const pauseOnModelErrors = H.trigger('pause-on-model-errors')
  .on(H.when.crossing(modelErrorRate, errorBand, 'entered'))
  .pause(conversations, event => `model error rate ${event.rate.toFixed(3)} over ${event.samples} invocations`);

const resumeOnRecovery = H.trigger('resume-on-recovery')
  .on(H.when.crossing(modelErrorRate, errorBand, 'exited'))
  .resume(conversations, event => `model error rate ${event.rate.toFixed(3)} over ${event.samples} invocations`);

const slaBreach = H.trigger('sla-breach')
  .on(H.when.timer(conversations, { at: unit => (unit.state === New ? new Date(unit.attributes.slaDeadline) : undefined) }))
  .create(escalations, event => ({ ticketId: event.unit.attributes.ticketId, reason: `SLA breached at ${event.at.toISOString()}` }))
  .signal(slaEscalated, conversations, event => ({ key: event.unit.key, payload: {} }));

const auditsOpened = H.metric('audits-opened', H.when.transition(audits, { to: AuditOpen })).amounts(event => [
  { amount: 1, facets: [category.of(event.unit.attributes.category)] },
]);

export const auditsOpenedThisMonth = (metrics: Metrics, which: Category) =>
  metrics.total(auditsOpened, { facets: [category.of(which)], window: { calendar: 'month' } });

export const conversationsPausedThisMonth = (metrics: Metrics) =>
  metrics.paused({ lane: conversations, window: { calendar: 'month' } });

export const harness = H.harness('support-self-watch')
  .ledger(sqlite.ledger({ path: '.harness/ledger.db' }))
  .lanes(conversations, escalations, audits)
  .journals(taste, experience)
  .triggers(approvalsFell, approvalsRecovered, pauseOnModelErrors, resumeOnRecovery, slaBreach)
  .metrics(approvalRate, modelErrorRate, auditsOpened)
  .scheduler(
    H.scheduler('support')
      .expedite(escalations)
      .fixedDate(conversations, unit => new Date(unit.attributes.slaDeadline))
      .standard(audits),
  )
  .clients(
    claudeCode.supervisor('reviewer', {
      port: H.slot.port(1),
      grants: [
        H.ops.workRead,
        H.ops.workUpdate,
        H.ops.resolve(replyApproval, costCeiling, escalationHandled, auditFinding),
        H.ops.memoryWrite,
        H.ops.memoryCurate,
        H.ops.telemetryRead,
      ],
    }),
  )
  .observers(markdown.board({ path: 'BOARD.md' }), markdown.telemetry({ path: 'TELEMETRY.md' }));
