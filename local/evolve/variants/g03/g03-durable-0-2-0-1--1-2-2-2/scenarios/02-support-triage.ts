import { z } from 'zod';
import { H } from 'harness-dsl';
import { sqlite } from 'harness-dsl/sqlite';
import { jsonl } from 'harness-dsl/jsonl';
import { anthropic } from 'harness-dsl/anthropic';
import { claudeCode } from 'harness-dsl/claude-code';
import { zendesk } from 'harness-dsl/zendesk';
import { markdown } from 'harness-dsl/markdown';

const category = H.facet('category', ['billing', 'shipping', 'account', 'refund', 'other']);

const conversationAttrs = z.object({
  ticketId: z.string(),
  subject: z.string(),
  message: z.string(),
  customerEmail: z.string(),
  slaDue: z.string(),
});

const New = H.state('new', 'pending');
const Sent = H.terminal('sent', 'success');
const ClosedByCustomer = H.terminal('closed-by-customer', 'neutral');
const Escalated = H.terminal('escalated', 'failure');
const conversationKind = H.kind('Conversation')
  .attributes(conversationAttrs)
  .states(New, Sent, ClosedByCustomer, Escalated)
  .key(a => a.ticketId)
  .initial(New);

const escalationAttrs = z.object({ ticketId: z.string(), reason: z.string() });
const EscalationOpen = H.state('escalation-open', 'pending');
const EscalationResolved = H.terminal('resolved', 'success');
const EscalationUnhandled = H.terminal('unhandled', 'failure');
const escalationKind = H.kind('Escalation')
  .attributes(escalationAttrs)
  .states(EscalationOpen, EscalationResolved, EscalationUnhandled)
  .key(a => a.ticketId)
  .initial(EscalationOpen);

const customerReplied = H.signal('customer-replied').payload(z.object({ message: z.string() }));
const customerClosed = H.signal('customer-closed');
const slaBreached = H.signal('sla-breached');

const replyApproval = H.halt('reply-approval').decision(z.object({ approved: z.boolean(), editedReply: z.string().optional() }));
const conversationCost = H.halt('conversation-cost').decision(H.ceilingDecision);
const escalationHandled = H.halt('escalation-handled').decision(z.object({ resolution: z.string() }));

const classifierRole = H.role('classifier').intents('read').instructions('Classify the conversation into one category.');
const drafterRole = H.role('drafter').intents('read').instructions('Draft a reply in the house tone.');
const reviewerRole = H.role('reviewer').instructions('Approve or edit outgoing replies.');

const quota = sqlite.quota('support-quota', { path: '.harness/quota.db' });
const supportAccount = anthropic.account('support-api', { apiKey: H.env('ANTHROPIC_API_KEY'), quota });
const supportPool = H.pool('support').accounts(supportAccount);
const haiku = anthropic.model('haiku', { id: 'claude-haiku-4-5' });
const sonnet = anthropic.model('sonnet', { id: 'claude-sonnet-4-5' });

const classifier = H.seat('classifier')
  .role(classifierRole)
  .model(haiku)
  .pool(supportPool)
  .output(z.object({ category: category.schema }));

const drafter = H.seat('drafter')
  .role(drafterRole)
  .model(sonnet)
  .pool(supportPool)
  .output(z.object({ reply: z.string() }));

const taste = H.journal('support-taste', H.memory('taste', 'taste'))
  .store(jsonl.memoryStore({ path: '.harness/taste.jsonl' }))
  .recall({ by: 'specificity', limit: 10 })
  .readBy(drafterRole)
  .recordedBy(reviewerRole);

const experience = H.journal('support-experience', H.memory('experience', 'experience'))
  .store(jsonl.memoryStore({ path: '.harness/experience.jsonl' }))
  .recall({ by: 'specificity', limit: 8 })
  .readBy(drafterRole);

const approvalRate = H.metric('reply-approval', H.when.decision(conversationKind, replyApproval))
  .samples(e => (e.resolvedBy === 'human'
    ? [{ hit: e.decision.approved, model: e.modelOf(drafter), facets: e.facets }]
    : []));

const safeCategory = H.policy.halt('safe-category-auto-approve', conversationKind, replyApproval).decide(ctx => {
  const value = ctx.facet(category);
  if (value === undefined) return undefined;
  const approvals = ctx.metrics.rate(approvalRate, { facets: [category.of(value)] });
  return approvals.samples >= 200 && approvals.hits === approvals.samples ? { approved: true } : undefined;
});

const sendReply = H.command('send-reply')
  .input(z.object({ ticketId: z.string(), reply: z.string() }))
  .argv(i => ['./bin/send-reply', i.ticketId, i.reply]);

const triage = H.flow('triage')
  .input(conversationAttrs)
  .step('classify', classifier, ctx => ({
    task: `Classify this conversation.\nSubject: ${ctx.unit.attributes.subject}\n\n${ctx.unit.attributes.message}`,
  }))
  .step('draft', drafter, ctx => ({
    task: `Draft a reply to ${ctx.unit.attributes.customerEmail}.\nSubject: ${ctx.unit.attributes.subject}\n\n${ctx.unit.attributes.message}`,
    skills: [ctx.steps.classify.category],
  }))
  .halt('approve', replyApproval, {
    ask: ctx => `Approve this reply to ${ctx.unit.attributes.customerEmail}?\n\n${ctx.steps.draft.reply}`,
    skip: safeCategory,
    facets: ctx => [category.of(ctx.steps.classify.category)],
  })
  .exit('rejected', ctx => !ctx.steps.approve.approved)
  .step('send', sendReply, ctx => ({
    ticketId: ctx.unit.attributes.ticketId,
    reply: ctx.steps.approve.editedReply ?? ctx.steps.draft.reply,
  }), { afterCrash: 'park' })
  .exit('sent');

const slaMinutes = { low: 1440, normal: 480, high: 120, urgent: 30 };
const helpdeskToken = H.env('ZENDESK_TOKEN');

const conversationLane = H.lane('conversations', conversationKind)
  .supply([
    zendesk.webhook({ port: H.slot.port(1), path: '/helpdesk', secret: H.env('ZENDESK_WEBHOOK_SECRET') }),
    zendesk.poll({ subdomain: 'acme', token: helpdeskToken, everyMinutes: 10 }),
  ], (event, to) => {
    if (event.type === 'created') {
      return to.create({
        ticketId: event.ticketId,
        subject: event.subject,
        message: event.message,
        customerEmail: event.customerEmail,
        slaDue: new Date(event.createdAt.getTime() + slaMinutes[event.priority] * 60000).toISOString(),
      });
    }
    if (event.status === 'closed' || event.status === 'solved') return to.signal(customerClosed, event.ticketId, {});
    if (event.type === 'replied') return to.signal(customerReplied, event.ticketId, { message: event.message });
    return to.skip();
  })
  .handler(triage, {
    exits: {
      rejected: { to: New, limit: { count: 3, then: Escalated } },
      sent: Sent,
    },
  })
  .store(zendesk.store({ subdomain: 'acme', token: helpdeskToken }))
  .retry({ maxAttempts: 3, backoff: 'exponential', initialDelayMs: 30000, exhausted: Escalated })
  .ceiling({ maxUsd: 0.4, onExceed: conversationCost })
  .on(customerReplied, { update: (a, p) => ({ ...a, message: p.message }), enter: New, at: ['approve'] })
  .on(customerClosed, { enter: ClosedByCustomer })
  .on(slaBreached, { enter: Escalated });

const escalationFlow = H.flow('escalation')
  .input(escalationAttrs)
  .halt('handle', escalationHandled, {
    ask: ctx => `Ticket ${ctx.unit.attributes.ticketId} needs a human: ${ctx.unit.attributes.reason}`,
  })
  .exit('resolved');

const escalationLane = H.lane('escalations', escalationKind)
  .handler(escalationFlow, { exits: { resolved: EscalationResolved } })
  .retry({ maxAttempts: 1, exhausted: EscalationUnhandled });

const slaBreach = H.trigger('sla-breach')
  .on(H.when.timer(conversationLane, { reads: ['slaDue'], at: view => new Date(view.attributes.slaDue) }))
  .signal(slaBreached, conversationLane, e => ({ key: e.unit.key, payload: {} }));

const escalate = H.trigger('escalate-conversation')
  .on(H.when.transition(conversationLane, { to: Escalated }))
  .create(escalationLane, e => ({
    ticketId: e.unit.attributes.ticketId,
    reason: `Conversation "${e.unit.attributes.subject}" escalated after ${e.unit.attempts} attempts`,
  }));

const reviewerEditsBecomeTaste = H.trigger('reviewer-edits-become-taste')
  .on(H.when.decision(conversationKind, replyApproval))
  .record(taste, e => (e.resolvedBy === 'human' && e.decision.editedReply !== undefined
    ? {
      text: `When drafting replies, match the reviewer's approved phrasing, as in: "${e.decision.editedReply}"`,
      status: 'candidate',
      when: { roles: [drafterRole] },
    }
    : undefined));

const scheduler = H.scheduler('support')
  .expedite(escalationLane)
  .fixedDate(conversationLane, unit => new Date(unit.attributes.slaDue))
  .wip(conversationLane, 8);

const supervisor = claudeCode.supervisor('reviewer-console', {
  port: H.slot.port(0),
  grants: [
    H.ops.workRead,
    H.ops.resolve(replyApproval, conversationCost, escalationHandled),
    H.ops.memoryRead,
    H.ops.memoryWrite,
    H.ops.telemetryRead,
  ],
});

export default H.harness('support-triage')
  .ledger(sqlite.ledger({ path: '.harness/ledger.db' }))
  .lanes(conversationLane, escalationLane)
  .journals(taste, experience)
  .triggers(slaBreach, escalate, reviewerEditsBecomeTaste)
  .metrics(approvalRate)
  .scheduler(scheduler)
  .clients(supervisor)
  .observers(markdown.board({ path: 'BOARD.md' }), markdown.telemetry({ path: 'TELEMETRY.md' }));
