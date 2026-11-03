import { z } from 'zod';
import { H, Router, Route } from 'harness-dsl';
import { sqlite } from 'harness-dsl/sqlite';
import { jsonl } from 'harness-dsl/jsonl';
import { anthropic } from 'harness-dsl/anthropic';
import { claudeCode } from 'harness-dsl/claude-code';
import { zendesk, ZendeskEvent } from 'harness-dsl/zendesk';
import { local } from 'harness-dsl/local';
import { markdown } from 'harness-dsl/markdown';

const Category = z.enum(['billing', 'refund', 'shipping', 'account', 'other']);
const category = H.facet('category', Category.options);

const ConversationAttrs = z.object({
  ticketId: z.string(),
  subject: z.string(),
  message: z.string(),
  customerEmail: z.string(),
  slaDueAt: z.string(),
});
type ConversationAttrs = z.infer<typeof ConversationAttrs>;

const New = H.state('new', 'pending');
const Sent = H.terminal('sent', 'success');
const ClosedByCustomer = H.terminal('closed-by-customer', 'neutral');
const Escalated = H.terminal('escalated', 'failure');

const Conversation = H.kind('Conversation')
  .attributes(ConversationAttrs)
  .states(New, Sent, ClosedByCustomer, Escalated)
  .key(attrs => attrs.ticketId)
  .initial(New);

const EscalationAttrs = z.object({ ticketId: z.string(), reason: z.string() });
const Open = H.state('open', 'pending');
const Handled = H.terminal('handled', 'success');
const Unhandled = H.terminal('unhandled', 'failure');

const Escalation = H.kind('Escalation')
  .attributes(EscalationAttrs)
  .states(Open, Handled, Unhandled)
  .key(attrs => attrs.ticketId)
  .initial(Open);

const customerReplied = H.signal('customer-replied').payload(z.object({ message: z.string() }));
const customerClosed = H.signal('customer-closed');
const slaBreached = H.signal('sla-breached');

const quota = sqlite.quota('support-quota', { path: '.harness/quota.sqlite' });
const apiAccount = anthropic.account('support-api', { apiKey: H.env('ANTHROPIC_API_KEY'), quota });
const haiku = anthropic.model('haiku', { id: 'claude-haiku-4-5' });
const sonnet = anthropic.model('sonnet', { id: 'claude-sonnet-4-5' });
const apiPool = H.pool('support-api').accounts(apiAccount);

const classifierRole = H.role('classifier')
  .intents('read')
  .instructions('Classify the conversation into exactly one category.');
const drafterRole = H.role('drafter')
  .intents('read', 'search')
  .instructions('Draft a reply in the house tone. Cite policy where it applies.');
const reviewerRole = H.role('reviewer')
  .intents('read', 'record')
  .instructions('Approve, edit or reject outgoing replies.');

const classifier = H.seat('classifier')
  .role(classifierRole)
  .model(haiku)
  .pool(apiPool)
  .output(z.object({ category: Category }));

const drafter = H.seat('drafter')
  .role(drafterRole)
  .model(sonnet)
  .pool(apiPool)
  .output(z.object({ reply: z.string() }));

const replyApproval = H.halt('reply-approval').decision(
  z.object({ approved: z.boolean(), editedReply: z.string().optional(), notes: z.string().optional() }),
);
const costCeiling = H.halt('cost-ceiling').decision(H.ceilingDecision);
const escalationHandled = H.halt('escalation-handled').decision(z.object({ resolution: z.string() }));

const approvals = H.metric('reply-approval', H.when.decision(Conversation, replyApproval)).samples(event =>
  event.resolvedBy === 'human'
    ? [{ hit: event.decision.approved, seat: drafter, model: event.modelFor(drafter), facets: event.facets }]
    : [],
);

const safeCategoryApproves = H.policy.halt('safe-category-approves', Conversation, replyApproval).decide(ctx => {
  const record = ctx.metrics.rate(approvals, { facets: ctx.facets });
  return record.samples >= 200 && record.hits === record.samples ? { approved: true } : undefined;
});

const sendReply = H.command('send-reply')
  .input(z.object({ ticketId: z.string(), reply: z.string() }))
  .argv(input => ['helpdesk-reply', input.ticketId, input.reply])
  .runner(local.runner('local'));

const triage = H.flow('triage')
  .input(ConversationAttrs)
  .step('classify', classifier, ctx => ({
    task: `Classify this conversation.\n\nSubject: ${ctx.unit.attributes.subject}\n\n${ctx.unit.attributes.message}`,
  }))
  .step('draft', drafter, ctx => ({
    task: `Draft a reply for a ${ctx.steps.classify.category} conversation:\n\n${ctx.unit.attributes.message}`,
    skills: [ctx.steps.classify.category],
  }))
  .halt('approval', replyApproval, {
    ask: ctx => `Approve this reply to ${ctx.unit.attributes.customerEmail}?\n\n${ctx.steps.draft.reply}`,
    facets: ctx => [category.of(ctx.steps.classify.category)],
    skip: safeCategoryApproves,
  })
  .exit('rejected', ctx => !ctx.steps.approval.approved)
  .step('send', sendReply, ctx => ({
    ticketId: ctx.unit.attributes.ticketId,
    reply: ctx.steps.approval.editedReply ?? ctx.steps.draft.reply,
  }))
  .exit('sent');

const slaHours = { low: 48, normal: 24, high: 8, urgent: 2 };

const routeHelpdesk = (event: ZendeskEvent, to: Router<ConversationAttrs>): Route => {
  if (event.status === 'closed' || event.status === 'solved') return to.signal(customerClosed, event.ticketId, {});
  if (event.type === 'replied') return to.signal(customerReplied, event.ticketId, { message: event.message });
  if (event.type === 'created')
    return to.create({
      ticketId: event.ticketId,
      subject: event.subject,
      message: event.message,
      customerEmail: event.customerEmail,
      slaDueAt: new Date(event.createdAt.getTime() + slaHours[event.priority] * 3_600_000).toISOString(),
    });
  return to.skip();
};

const conversations = H.lane('conversations', Conversation)
  .supply(
    zendesk.webhook({ port: H.slot.port(1), path: '/helpdesk', secret: H.env('ZENDESK_WEBHOOK_SECRET') }),
    routeHelpdesk,
  )
  .supply(zendesk.poll({ subdomain: 'acme', token: H.env('ZENDESK_TOKEN'), everyMinutes: 15 }), routeHelpdesk)
  .handler(triage, { exits: { rejected: New, sent: Sent } })
  .store(zendesk.store({ subdomain: 'acme', token: H.env('ZENDESK_TOKEN') }))
  .retry({ maxAttempts: 3, backoff: 'exponential', initialDelayMs: 30_000, exhausted: Escalated })
  .ceiling({ maxUsd: 0.4, onExceed: costCeiling })
  .on(customerReplied, {
    update: (attrs, payload) => ({ ...attrs, message: payload.message }),
    enter: New,
    at: ['approval'],
  })
  .on(customerClosed, { enter: ClosedByCustomer })
  .on(slaBreached, { enter: Escalated });

const humanEscalation = H.flow('human-escalation')
  .input(EscalationAttrs)
  .halt('handle', escalationHandled, {
    ask: ctx => `Ticket ${ctx.unit.attributes.ticketId} was escalated: ${ctx.unit.attributes.reason}`,
  })
  .exit('handled');

const escalations = H.lane('escalations', Escalation)
  .handler(humanEscalation, { exits: { handled: Handled } })
  .retry({ maxAttempts: 2, exhausted: Unhandled });

const slaBreachEscalates = H.trigger('sla-breach-escalates')
  .on(
    H.when.timer(conversations, {
      at: unit => (unit.position === 'terminal' ? undefined : new Date(unit.attributes.slaDueAt)),
    }),
  )
  .create(escalations, event => ({
    ticketId: event.unit.attributes.ticketId,
    reason: `SLA breached at ${event.deadline.toISOString()}`,
  }))
  .signal(slaBreached, conversations, event => ({ key: event.unit.key, payload: {} }));

const tone = H.journal('reply-taste', H.memory('reply-taste', 'taste'))
  .store(jsonl.memoryStore({ path: '.harness/taste.jsonl' }))
  .recall({ by: 'specificity', limit: 15 })
  .readBy(drafterRole)
  .recordedBy(reviewerRole);

const supportExperience = H.journal('support-experience', H.memory('support-experience', 'experience'))
  .store(jsonl.memoryStore({ path: '.harness/experience.jsonl' }))
  .recall({ by: 'specificity', limit: 10 })
  .readBy(drafterRole)
  .recordedBy(reviewerRole);

const reviewerEditsBecomeTaste = H.trigger('reviewer-edits-become-taste')
  .on(H.when.decision(Conversation, replyApproval))
  .record(tone, event =>
    event.resolvedBy === 'human' && event.decision.notes !== undefined
      ? { text: event.decision.notes, when: { roles: [drafterRole] }, status: 'candidate' }
      : undefined,
  );

const scheduler = H.scheduler('support')
  .fixedDate(conversations, unit => new Date(unit.attributes.slaDueAt))
  .standard(escalations);

const supervisor = claudeCode.supervisor('reviewer-supervisor', {
  port: H.slot.port(0),
  grants: [
    H.ops.workRead,
    H.ops.workUpdate,
    H.ops.resolve(replyApproval, costCeiling, escalationHandled),
    H.ops.memoryRead,
    H.ops.memoryWrite,
    H.ops.memoryCurate,
    H.ops.telemetryRead,
  ],
});

export default H.harness('support-triage')
  .ledger(sqlite.ledger({ path: '.harness/ledger.sqlite' }))
  .lanes(conversations, escalations)
  .journals(tone, supportExperience)
  .triggers(slaBreachEscalates, reviewerEditsBecomeTaste)
  .metrics(approvals)
  .scheduler(scheduler)
  .clients(supervisor)
  .observers(markdown.board({ path: 'BOARD.md' }), markdown.telemetry({ path: 'TELEMETRY.md' }));
