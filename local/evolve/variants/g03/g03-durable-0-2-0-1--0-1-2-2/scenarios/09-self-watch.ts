import { z } from 'zod';
import { H, Route, Router } from 'harness-dsl';
import { anthropic } from 'harness-dsl/anthropic';
import { claudeCode } from 'harness-dsl/claude-code';
import { sqlite } from 'harness-dsl/sqlite';
import { jsonl } from 'harness-dsl/jsonl';
import { local } from 'harness-dsl/local';
import { zendesk, ZendeskEvent } from 'harness-dsl/zendesk';
import { markdown } from 'harness-dsl/markdown';

const categoryName = z.enum(['billing', 'refund', 'shipping', 'account', 'other']);
const category = H.resources('category', categoryName.options);

const supportApi = anthropic.account('support-api', {
  apiKey: H.env('ANTHROPIC_API_KEY'),
  quota: sqlite.quota('support-api', { path: '/srv/support/quota.sqlite' }),
});
const haiku = anthropic.model('haiku', { id: 'claude-haiku-4-5' });
const sonnet = anthropic.model('sonnet', { id: 'claude-sonnet-4-5' });
const pool = H.pool('support').accounts(supportApi);
const sender = local.runner('sender').slots(4);

const classifierRole = H.role('classifier')
  .intents('read')
  .instructions('Classify the conversation into one category.')
  .output(z.object({ category: categoryName }));
const drafterRole = H.role('drafter')
  .intents('read', 'search')
  .instructions('Draft a reply to the customer in our voice.')
  .output(z.object({ reply: z.string() }));
const reviewerRole = H.role('reviewer');

const classifier = H.seat('classifier').role(classifierRole).model(haiku).pool(pool);
const drafter = H.seat('drafter').role(drafterRole).model(sonnet).pool(pool);

const taste = H.journal('support-taste', H.memory('support-taste', 'taste'))
  .store(jsonl.memoryStore({ path: '/srv/support/taste.jsonl' }))
  .recall({ by: 'specificity', limit: 10 })
  .readBy(drafterRole)
  .recordedBy(reviewerRole);

const experience = H.journal('support-experience', H.memory('support-experience', 'experience'))
  .store(jsonl.memoryStore({ path: '/srv/support/experience.jsonl' }))
  .recall({ by: 'specificity', limit: 8 })
  .readBy(drafterRole);

const approvalDecision = z.object({ approved: z.boolean(), editedReply: z.string().optional() });
type Approval = z.infer<typeof approvalDecision>;
const approval = H.halt('reply-approval').decision(approvalDecision);
const costCeiling = H.halt('cost-ceiling').decision(H.ceilingDecision);
const escalationHandled = H.halt('escalation-handled').decision(z.object({ resolution: z.string() }));
const auditFindings = H.halt('audit-findings').decision(z.object({ findings: z.string() }));

const New = H.state('New', 'pending');
const Sent = H.terminal('Sent', 'success');
const ClosedByCustomer = H.terminal('ClosedByCustomer', 'neutral');
const Escalated = H.terminal('Escalated', 'neutral');
const Unanswered = H.terminal('Unanswered', 'failure');
const conversationAttrs = z.object({
  ticketId: z.string(),
  subject: z.string(),
  message: z.string(),
  customerEmail: z.string(),
  slaDeadline: z.coerce.date(),
});
const Conversation = H.kind('Conversation')
  .attributes(conversationAttrs)
  .states(New, Sent, ClosedByCustomer, Escalated, Unanswered)
  .key(attrs => attrs.ticketId)
  .initial(New);

const AuditOpen = H.state('AuditOpen', 'pending');
const AuditClosed = H.terminal('AuditClosed', 'success');
const AuditCancelled = H.terminal('AuditCancelled', 'neutral');
const auditAttrs = z.object({ category: categoryName, rate: z.number(), samples: z.number() });
const Audit = H.kind('Audit')
  .attributes(auditAttrs)
  .states(AuditOpen, AuditClosed, AuditCancelled)
  .key(attrs => attrs.category)
  .initial(AuditOpen);

const EscalationOpen = H.state('EscalationOpen', 'pending');
const EscalationHandled = H.terminal('EscalationHandled', 'success');
const EscalationDropped = H.terminal('EscalationDropped', 'neutral');
const escalationAttrs = z.object({ ticketId: z.string(), reason: z.string() });
const Escalation = H.kind('Escalation')
  .attributes(escalationAttrs)
  .states(EscalationOpen, EscalationHandled, EscalationDropped)
  .key(attrs => attrs.ticketId)
  .initial(EscalationOpen);

const reviewAudit = H.flow('review-audit')
  .input(auditAttrs)
  .halt('review', auditFindings, {
    ask: ctx => `Approvals for ${ctx.unit.attributes.category} fell to ${ctx.unit.attributes.rate.toFixed(2)} over ${ctx.unit.attributes.samples} samples. What went wrong?`,
    resources: ctx => [category.of(ctx.unit.attributes.category)],
  })
  .exit('closed');

const audits = H.lane('audits', Audit)
  .handler(reviewAudit, { exits: { closed: AuditClosed } })
  .retry({ maxAttempts: 1, exhausted: AuditCancelled })
  .on(H.cancel, { enter: AuditCancelled });

const auditsOpened = H.metric('audits-opened', H.when.transition(audits, { to: AuditOpen })).amounts(event => [
  { amount: 1, resources: [category.of(event.unit.attributes.category)] },
]);

const approvals = H.metric('reply-approvals', H.when.decision(Conversation, approval)).samples(event =>
  event.resolvedBy === 'human'
    ? event.seats
        .filter(assignment => assignment.seat === drafter)
        .map(assignment => ({
          hit: event.decision.approved,
          halt: event.halt,
          resources: event.resources,
          seat: assignment.seat,
          model: assignment.model,
        }))
    : [],
);

const safeCategorySkip = H.policy.halt('safe-category-skip', Conversation, approval).decide((ctx): Approval | undefined => {
  const record = ctx.metrics.rate(approvals, { halt: approval, resources: ctx.resources });
  const auditsThisMonth = ctx.metrics.total(auditsOpened, { resources: ctx.resources, window: { calendar: 'month' } });
  const pausedThisMonth = ctx.metrics.paused({ lane: conversations, window: { calendar: 'month' } });
  const provenSafe = record.samples >= 200 && record.hits === record.samples;
  return provenSafe && auditsThisMonth.total === 0 && pausedThisMonth.totalMs < 3_600_000 ? { approved: true } : undefined;
});

const sendReply = H.command('send-reply')
  .input(z.object({ ticketId: z.string(), reply: z.string() }))
  .argv(reply => ['./support/send.sh', reply.ticketId, reply.reply])
  .runner(sender);

const answer = H.flow('answer')
  .input(conversationAttrs)
  .step('classify', classifier, ctx => ({ task: `Classify: ${ctx.unit.attributes.subject}\n${ctx.unit.attributes.message}` }))
  .loop(
    'drafts',
    body =>
      body
        .step('draft', drafter, ctx => ({
          task: `Reply to ${ctx.unit.attributes.customerEmail}: ${ctx.unit.attributes.message}`,
          resources: [category.of(ctx.steps.classify.category)],
        }))
        .halt('approve', approval, {
          ask: ctx => `Approve this reply?\n${ctx.steps.draft.reply}`,
          skip: safeCategorySkip,
          resources: ctx => [category.of(ctx.steps.classify.category)],
        }),
    { max: 3, until: ctx => ctx.steps.approve.approved },
  )
  .exit('unapproved', ctx => !ctx.steps.approve.approved)
  .step(
    'send',
    sendReply,
    ctx => ({ ticketId: ctx.unit.attributes.ticketId, reply: ctx.steps.approve.editedReply ?? ctx.steps.draft.reply }),
    { afterCrash: 'park' },
  )
  .exit('sent');

const customerReplied = H.signal('customer-replied').payload(z.object({ message: z.string() }));
const customerClosed = H.signal('customer-closed');
const escalate = H.signal('escalate');

const slaHours = { low: 48, normal: 24, high: 8, urgent: 2 };

const routeTicket = (event: ZendeskEvent, to: Router<z.infer<typeof conversationAttrs>>): Route =>
  event.type === 'created'
    ? to.create({
        ticketId: event.ticketId,
        subject: event.subject,
        message: event.message,
        customerEmail: event.customerEmail,
        slaDeadline: new Date(event.createdAt.getTime() + slaHours[event.priority] * 3_600_000),
      })
    : event.type === 'replied'
      ? to.signal(customerReplied, event.ticketId, { message: event.message })
      : event.status === 'solved' || event.status === 'closed'
        ? to.signal(customerClosed, event.ticketId, {})
        : to.skip();

const helpdeskToken = H.env('ZENDESK_TOKEN');

const conversations = H.lane('conversations', Conversation)
  .supply(zendesk.webhook({ port: H.slot.port(1), path: '/zendesk', secret: H.env('ZENDESK_WEBHOOK_SECRET') }), routeTicket)
  .supply(zendesk.poll({ subdomain: 'acme', token: helpdeskToken, everyMinutes: 10 }), routeTicket)
  .handler(answer, { exits: { unapproved: Escalated, sent: Sent } })
  .store(zendesk.store({ subdomain: 'acme', token: helpdeskToken }))
  .retry({ maxAttempts: 3, backoff: 'exponential', initialDelayMs: 60_000, exhausted: Unanswered })
  .ceiling({ maxUsd: 0.4, onExceed: costCeiling })
  .on(customerReplied, { update: (attrs, reply) => ({ ...attrs, message: reply.message }), enter: New })
  .on(customerClosed, { enter: ClosedByCustomer })
  .on(escalate, { enter: Escalated });

const handleEscalation = H.flow('handle-escalation')
  .input(escalationAttrs)
  .halt('handle', escalationHandled, { ask: ctx => `Ticket ${ctx.unit.attributes.ticketId} escalated: ${ctx.unit.attributes.reason}` })
  .exit('handled');

const escalations = H.lane('escalations', Escalation)
  .handler(handleEscalation, { exits: { handled: EscalationHandled } })
  .retry({ maxAttempts: 1, exhausted: EscalationDropped });

const slaBreached = H.trigger('sla-breached')
  .on(H.when.timer(conversations, { at: unit => unit.attributes.slaDeadline }))
  .signal(escalate, conversations, event => ({ key: event.unit.key, payload: {} }));

const escalationFiled = H.trigger('escalation-filed')
  .on(H.when.transition(conversations, { to: Escalated }))
  .create(escalations, event => ({ ticketId: event.unit.attributes.ticketId, reason: 'SLA breached or reply never approved' }));

const editsBecomeTaste = H.trigger('edits-become-taste')
  .on(H.when.decision(Conversation, approval))
  .record(taste, event =>
    event.decision.editedReply === undefined
      ? undefined
      : { text: `Prefer phrasing like the reviewer's edit: "${event.decision.editedReply}"`, status: 'candidate' },
  );

const approvalBand = {
  window: { lastDays: 7 },
  minSamples: 50,
  enter: { below: 0.9 },
  exit: { above: 0.95 },
  per: category,
};

const approvalsFell = H.trigger('approvals-fell')
  .on(H.when.crossing(approvals, approvalBand, 'entered'))
  .create(audits, event => ({ category: event.resource.value, rate: event.rate, samples: event.samples }))
  .record(experience, event => ({
    text: `When drafting for ${event.resource.value}, recall the stricter phrasing, because approvals fell to ${event.rate.toFixed(2)}.`,
    when: { roles: [drafterRole], resources: [event.resource] },
    status: 'candidate',
  }));

const approvalsRecovered = H.trigger('approvals-recovered')
  .on(H.when.crossing(approvals, approvalBand, 'exited'))
  .signal(H.cancel, audits, event => ({
    key: event.resource.value,
    payload: { reason: `approvals recovered to ${event.rate.toFixed(2)} over ${event.samples} samples` },
  }));

const modelErrors = H.metric('model-errors', H.when.invocation({ lanes: [conversations] })).samples(event => [
  { hit: !event.ok, seat: event.seat, model: event.model },
]);

const errorBand = { window: { lastHours: 1 }, minSamples: 20, enter: { above: 0.2 }, exit: { below: 0.05 } };

const pauseOnModelErrors = H.trigger('pause-on-model-errors')
  .on(H.when.crossing(modelErrors, errorBand, 'entered'))
  .pause(conversations, event => `model error rate ${event.rate.toFixed(2)} over ${event.samples} invocations`);

const resumeOnRecovery = H.trigger('resume-on-recovery')
  .on(H.when.crossing(modelErrors, errorBand, 'exited'))
  .resume(conversations, event => `model error rate back to ${event.rate.toFixed(2)} over ${event.samples} invocations`);

const reviewer = claudeCode.supervisor('reviewer', {
  port: H.slot.port(2),
  grants: [
    H.ops.workRead,
    H.ops.workUpdate,
    H.ops.resolve(approval, costCeiling, escalationHandled, auditFindings),
    H.ops.memoryWrite,
    H.ops.memoryCurate,
    H.ops.lanesPause,
    H.ops.telemetryRead,
  ],
});

const scheduler = H.scheduler('support')
  .expedite(escalations)
  .fixedDate(conversations, unit => unit.attributes.slaDeadline)
  .standard(audits);

export const harness = H.harness('support')
  .ledger(sqlite.ledger({ path: '/srv/support/ledger.sqlite' }))
  .lanes(conversations, audits, escalations)
  .journals(taste, experience)
  .triggers(slaBreached, escalationFiled, editsBecomeTaste, approvalsFell, approvalsRecovered, pauseOnModelErrors, resumeOnRecovery)
  .metrics(approvals, auditsOpened, modelErrors)
  .scheduler(scheduler)
  .clients(reviewer)
  .observers(markdown.board({ path: '/srv/support/BOARD.md' }), markdown.telemetry({ path: '/srv/support/TELEMETRY.md' }));

void harness.start();
