import { z } from 'zod';
import { H, Route, Router } from 'harness-dsl';
import { anthropic } from 'harness-dsl/anthropic';
import { claudeCode } from 'harness-dsl/claude-code';
import { sqlite } from 'harness-dsl/sqlite';
import { jsonl } from 'harness-dsl/jsonl';
import { zendesk, ZendeskEvent } from 'harness-dsl/zendesk';
import { local } from 'harness-dsl/local';
import { markdown } from 'harness-dsl/markdown';

const categorySchema = z.enum(['billing', 'refund', 'technical', 'account', 'other']);
const conversationItem = z.object({
  ticketId: z.string(),
  subject: z.string(),
  message: z.string(),
  customerEmail: z.string(),
  slaDueAt: z.string(),
});
type ConversationItem = z.infer<typeof conversationItem>;
const escalationItem = z.object({ ticketId: z.string(), subject: z.string(), reason: z.string() });

const New = H.state('New', 'pending');
const Sent = H.terminal('Sent', 'success');
const ClosedByCustomer = H.terminal('ClosedByCustomer', 'neutral');
const Escalated = H.terminal('Escalated', 'failure');
const EscalationOpen = H.state('EscalationOpen', 'pending');
const EscalationHandled = H.terminal('EscalationHandled', 'success');
const EscalationAbandoned = H.terminal('EscalationAbandoned', 'failure');

const Conversation = H.kind('Conversation')
  .attributes(conversationItem)
  .states(New, Sent, ClosedByCustomer, Escalated)
  .key(a => a.ticketId)
  .initial(New);
const Escalation = H.kind('Escalation')
  .attributes(escalationItem)
  .states(EscalationOpen, EscalationHandled, EscalationAbandoned)
  .key(a => a.ticketId)
  .initial(EscalationOpen);

const customerReplied = H.signal('customer-replied').payload(z.object({ message: z.string() }));
const customerClosed = H.signal('customer-closed');

const replyApproval = H.halt('reply-approval').decision(
  z.object({ approved: z.boolean(), reply: z.string().optional(), notes: z.string().optional() }),
);
const costCeiling = H.halt('conversation-cost-ceiling').decision(H.ceilingDecision);
const escalationHandled = H.halt('escalation-handled').decision(z.object({ resolution: z.string() }));

const category = H.facet('category', categorySchema.options);

const supportQuota = sqlite.quota('support-api', { path: './.harness/quota.sqlite' });
const supportAccount = anthropic.account('support-api', { apiKey: H.env('ANTHROPIC_API_KEY'), quota: supportQuota });
const supportPool = H.pool('support').accounts(supportAccount);
const cheapModel = anthropic.model('haiku', { id: 'claude-haiku-4-5' });
const strongModel = anthropic.model('sonnet', { id: 'claude-sonnet-4-5' });

const classifierRole = H.role('classifier')
  .intents('read')
  .instructions('Classify the customer message into exactly one category.');
const drafterRole = H.role('drafter')
  .intents('read', 'search')
  .instructions('Draft a reply the customer can act on. Follow recalled tone and policy guidance.');
const reviewerRole = H.role('reviewer').intents('record').instructions('Approve, edit or reject drafted replies.');

const classifier = H.seat('classifier')
  .role(classifierRole)
  .model(cheapModel)
  .pool(supportPool)
  .output(z.object({ category: categorySchema }));
const drafter = H.seat('drafter')
  .role(drafterRole)
  .model(strongModel)
  .pool(supportPool)
  .output(z.object({ reply: z.string() }));

const approvalRate = H.metric('reply-approval-rate', H.when.decision(Conversation, replyApproval)).samples(e =>
  e.resolvedBy === 'human' ? [{ hit: e.decision.approved, facets: e.facets, model: e.modelOf(drafter) }] : [],
);

const safeCategory = H.policy.halt('safe-category-skip', Conversation, replyApproval).decide(ctx => {
  const value = ctx.facets.find(f => f.facet === category);
  if (value === undefined) return undefined;
  const record = ctx.metrics.rate(approvalRate, { facets: [value] });
  return record.samples >= 200 && record.hits === record.samples ? { approved: true } : undefined;
});

const sendReply = H.command('send-reply')
  .input(z.object({ ticketId: z.string(), body: z.string() }))
  .argv(i => ['./scripts/send-reply.sh', i.ticketId, i.body])
  .runner(local.runner('local'));

const triage = H.flow('triage')
  .input(conversationItem)
  .step('classify', classifier, ctx => ({
    task: `Subject: ${ctx.unit.attributes.subject}\n\n${ctx.unit.attributes.message}`,
  }))
  .step('draft', drafter, ctx => ({
    task: `Draft a reply to ${ctx.unit.attributes.customerEmail}.\nCategory: ${ctx.steps.classify.category}\nSubject: ${ctx.unit.attributes.subject}\n\n${ctx.unit.attributes.message}`,
    skills: [ctx.steps.classify.category],
  }))
  .halt('approval', replyApproval, {
    ask: ctx => `Approve this reply to ${ctx.unit.attributes.customerEmail}?\n\n${ctx.steps.draft.reply}`,
    facets: ctx => [category.of(ctx.steps.classify.category)],
    skip: safeCategory,
  })
  .exit('declined', ctx => !ctx.steps.approval.approved)
  .step(
    'send',
    sendReply,
    ctx => ({ ticketId: ctx.unit.attributes.ticketId, body: ctx.steps.approval.reply ?? ctx.steps.draft.reply }),
    { afterCrash: 'park' },
  )
  .exit('sent');

const slaHours: Record<ZendeskEvent['priority'], number> = { low: 48, normal: 24, high: 8, urgent: 2 };

const routeTicket = (e: ZendeskEvent, to: Router<ConversationItem>): Route | readonly Route[] => {
  if (e.status === 'solved' || e.status === 'closed') return to.signal(customerClosed, e.ticketId, {});
  const attrs = {
    ticketId: e.ticketId,
    subject: e.subject,
    message: e.message,
    customerEmail: e.customerEmail,
    slaDueAt: new Date(e.createdAt.getTime() + slaHours[e.priority] * 3600000).toISOString(),
  };
  if (e.type === 'created') return to.create(attrs);
  if (e.type === 'replied') return [to.signal(customerReplied, e.ticketId, { message: e.message }), to.create(attrs)];
  return to.skip();
};

const helpdeskToken = H.env('ZENDESK_TOKEN');
const helpdeskStore = zendesk.store({ subdomain: 'acme', token: helpdeskToken });

const conversationLane = H.lane('conversations', Conversation)
  .supply(zendesk.webhook({ port: H.slot.port(1), path: '/zendesk', secret: H.env('ZENDESK_WEBHOOK_SECRET') }), routeTicket)
  .supply(zendesk.poll({ subdomain: 'acme', token: helpdeskToken, everyMinutes: 10 }), routeTicket)
  .handler(triage, { exits: { declined: Escalated, sent: Sent } })
  .store(helpdeskStore)
  .retry({ maxAttempts: 3, backoff: 'exponential', initialDelayMs: 30000, exhausted: Escalated })
  .ceiling({ maxUsd: 0.4, onExceed: costCeiling })
  .on(customerReplied, {
    update: (attrs, payload) => ({ ...attrs, message: payload.message }),
    enter: New,
    at: ['approval'],
  })
  .on(customerClosed, { enter: ClosedByCustomer })
  .on(H.cancel, { enter: Escalated });

const escalationFlow = H.flow('escalation-human')
  .input(escalationItem)
  .halt('handle', escalationHandled, {
    ask: ctx => `Ticket ${ctx.unit.attributes.ticketId} (${ctx.unit.attributes.subject}) escalated: ${ctx.unit.attributes.reason}`,
  })
  .exit('handled');

const escalationLane = H.lane('escalations', Escalation)
  .handler(escalationFlow, { exits: { handled: EscalationHandled } })
  .store(helpdeskStore)
  .retry({ maxAttempts: 1, exhausted: EscalationAbandoned });

const slaBreached = H.trigger('sla-breached')
  .on(H.when.timer(conversationLane, { at: u => new Date(u.attributes.slaDueAt) }))
  .create(escalationLane, e => ({
    ticketId: e.unit.attributes.ticketId,
    subject: e.unit.attributes.subject,
    reason: `SLA breached at ${e.at.toISOString()}`,
  }))
  .signal(H.cancel, conversationLane, e => ({ key: e.unit.key, payload: { reason: 'SLA breached' } }));

const tasteJournal = H.journal('reply-taste', H.memory('reply-taste', 'taste'))
  .store(jsonl.memoryStore({ path: './memory/taste.jsonl' }))
  .recall({ by: 'specificity', limit: 15 })
  .readBy(drafterRole)
  .recordedBy(reviewerRole);

const experienceJournal = H.journal('support-experience', H.memory('support-experience', 'experience'))
  .store(jsonl.memoryStore({ path: './memory/experience.jsonl' }))
  .recall({ by: 'specificity', limit: 10 })
  .readBy(drafterRole);

const editsBecomeTaste = H.trigger('reviewer-edits-become-taste')
  .on(H.when.decision(Conversation, replyApproval))
  .record(tasteJournal, e => {
    const edited = e.decision.reply;
    return e.resolvedBy === 'human' && edited !== undefined
      ? {
          text: `When drafting a reply about "${e.unit.attributes.subject}", phrase it as the reviewer did: ${edited}, because the reviewer rewrote the draft to this.`,
          status: 'candidate',
          when: { kinds: [Conversation], roles: [drafterRole] },
        }
      : undefined;
  });

const scheduler = H.scheduler('support')
  .fixedDate(conversationLane, u => new Date(u.attributes.slaDueAt))
  .standard(escalationLane);

const supervisor = claudeCode.supervisor('reviewer', {
  grants: [
    H.ops.workRead,
    H.ops.resolve(replyApproval, costCeiling, escalationHandled),
    H.ops.memoryRead,
    H.ops.memoryWrite,
    H.ops.telemetryRead,
  ],
  port: H.slot.port(0),
});

export const support = H.harness('support-triage')
  .ledger(sqlite.ledger({ path: './.harness/ledger.sqlite' }))
  .lanes(conversationLane, escalationLane)
  .journals(tasteJournal, experienceJournal)
  .triggers(slaBreached, editsBecomeTaste)
  .metrics(approvalRate)
  .scheduler(scheduler)
  .clients(supervisor)
  .observers(markdown.board({ path: './BOARD.md' }));

void support.start();
