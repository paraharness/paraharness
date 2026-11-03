import { z } from 'zod';
import { H, Router, Route } from 'harness-dsl';
import { sqlite } from 'harness-dsl/sqlite';
import { jsonl } from 'harness-dsl/jsonl';
import { anthropic } from 'harness-dsl/anthropic';
import { claudeCode } from 'harness-dsl/claude-code';
import { local } from 'harness-dsl/local';
import { zendesk, ZendeskEvent } from 'harness-dsl/zendesk';
import { markdown } from 'harness-dsl/markdown';

const quota = sqlite.quota('support-quota', { path: './state/quota.sqlite' });
const apiAccount = anthropic.account('support-api', { apiKey: H.env('ANTHROPIC_API_KEY'), quota });
const haiku = anthropic.model('haiku', { id: 'claude-haiku-4-5' });
const sonnet = anthropic.model('sonnet', { id: 'claude-sonnet-4-5' });
const apiPool = H.pool('support-api').accounts(apiAccount);

const Conversation = z.object({
  ticketId: z.string(),
  subject: z.string(),
  customerEmail: z.string(),
  lastMessage: z.string(),
  slaDue: z.string(),
});
type ConversationAttrs = z.infer<typeof Conversation>;

const Escalation = z.object({ ticketId: z.string(), subject: z.string(), reason: z.string() });

const New = H.state('New', 'pending');
const AwaitingCustomer = H.state('AwaitingCustomer', 'waiting');
const NeedsHuman = H.state('NeedsHuman', 'waiting');
const ClosedByCustomer = H.terminal('ClosedByCustomer', 'success');
const Escalated = H.terminal('Escalated', 'failure');

const conversationKind = H.kind('Conversation')
  .attributes(Conversation)
  .states(New, AwaitingCustomer, NeedsHuman, ClosedByCustomer, Escalated)
  .key(attrs => attrs.ticketId)
  .initial(New);

const EscalationOpen = H.state('EscalationOpen', 'pending');
const EscalationUnhandled = H.state('EscalationUnhandled', 'waiting');
const EscalationResolved = H.terminal('EscalationResolved', 'success');
const EscalationDismissed = H.terminal('EscalationDismissed', 'neutral');

const escalationKind = H.kind('Escalation')
  .attributes(Escalation)
  .states(EscalationOpen, EscalationUnhandled, EscalationResolved, EscalationDismissed)
  .key(attrs => attrs.ticketId)
  .initial(EscalationOpen);

const customerReplied = H.signal('customer-replied').payload(z.object({ message: z.string() }));
const customerClosed = H.signal('customer-closed');
const slaBreached = H.signal('sla-breached');

const category = H.facet('category');

const classifierRole = H.role('classifier').intents('read').instructions('Classify the conversation into one category.');
const drafterRole = H.role('drafter').intents('read').instructions('Draft the next reply to the customer.');
const reviewerRole = H.role('reviewer');

const classifier = H.seat('classifier')
  .role(classifierRole)
  .model(haiku)
  .pool(apiPool)
  .output(z.object({ category: z.enum(['billing', 'refund', 'technical', 'account', 'other']), summary: z.string() }));

const drafter = H.seat('drafter')
  .role(drafterRole)
  .model(sonnet)
  .pool(apiPool)
  .output(z.object({ reply: z.string() }));

const approval = H.halt('reply-approval').decision(
  z.object({ verdict: z.enum(['approve', 'reject']), editedReply: z.string().optional() }),
);
const costCeiling = H.halt('conversation-cost-ceiling').decision(H.ceilingDecision);
const escalationHandled = H.halt('escalation-handled').decision(
  z.object({ outcome: z.enum(['resolved', 'dismissed']), note: z.string() }),
);

const approvalRate = H.metric('approval-rate', H.when.decision(conversationKind, approval)).samples(event =>
  event.resolvedBy === 'human'
    ? [
        {
          hit: event.decision.verdict === 'approve',
          halt: approval,
          facets: event.facets,
          model: event.seats.find(assignment => assignment.seat.name === drafter.name)?.model,
        },
      ]
    : [],
);

const safeCategory = H.policy.halt('safe-category-auto-approve', conversationKind, approval).decide(ctx => {
  const record = ctx.metrics.rate(approvalRate, { facets: ctx.facets });
  return record.samples >= 200 && record.hits === record.samples ? { verdict: 'approve' } : undefined;
});

const localRunner = local.runner('local').slots(4);
const sendReply = H.command('send-reply')
  .input(z.object({ ticketId: z.string(), body: z.string() }))
  .argv(input => ['./bin/helpdesk-reply', input.ticketId, input.body])
  .runner(localRunner);

const triage = H.flow('triage')
  .input(Conversation)
  .step('classify', classifier, ctx => ({ task: `Classify: ${ctx.unit.attributes.subject}\n\n${ctx.unit.attributes.lastMessage}` }))
  .step('draft', drafter, ctx => ({
    task: `Draft a reply in category ${ctx.steps.classify.category}.\nSummary: ${ctx.steps.classify.summary}\nCustomer wrote: ${ctx.unit.attributes.lastMessage}`,
  }))
  .halt('approval', approval, {
    ask: ctx => `Approve this reply to ${ctx.unit.attributes.customerEmail}?\n\n${ctx.steps.draft.reply}`,
    facets: ctx => [category.of(ctx.steps.classify.category)],
    skip: safeCategory,
  })
  .exit('rejected', ctx => ctx.steps.approval.verdict === 'reject')
  .step('send', sendReply, ctx => ({
    ticketId: ctx.unit.attributes.ticketId,
    body: ctx.steps.approval.editedReply ?? ctx.steps.draft.reply,
  }), { afterCrash: 'park' })
  .exit('sent');

const slaHours = { low: 48, normal: 24, high: 8, urgent: 2 };

const routeHelpdesk = (event: ZendeskEvent, to: Router<ConversationAttrs>): Route => {
  if (event.type === 'created') {
    return to.create({
      ticketId: event.ticketId,
      subject: event.subject,
      customerEmail: event.customerEmail,
      lastMessage: event.message,
      slaDue: new Date(event.createdAt.getTime() + slaHours[event.priority] * 3_600_000).toISOString(),
    });
  }
  if (event.status === 'closed' || event.status === 'solved') {
    return to.signal(customerClosed, event.ticketId, {});
  }
  if (event.type === 'replied') {
    return to.signal(customerReplied, event.ticketId, { message: event.message });
  }
  return to.skip();
};

const conversationLane = H.lane('conversations', conversationKind)
  .handler(triage, { exits: { rejected: NeedsHuman, sent: AwaitingCustomer } })
  .store(zendesk.store({ subdomain: 'acme', token: H.env('ZENDESK_TOKEN') }))
  .retry({ maxAttempts: 3, backoff: 'exponential', initialDelayMs: 30_000, exhausted: NeedsHuman })
  .ceiling({ maxUsd: 0.4, onExceed: costCeiling })
  .on(customerReplied, { update: (attrs, payload) => ({ ...attrs, lastMessage: payload.message }), enter: New })
  .on(customerClosed, { enter: ClosedByCustomer })
  .on(slaBreached, { enter: Escalated })
  .supply(zendesk.webhook({ port: H.slot.port(1), path: '/helpdesk', secret: H.env('ZENDESK_WEBHOOK_SECRET') }), routeHelpdesk)
  .supply(zendesk.poll({ subdomain: 'acme', token: H.env('ZENDESK_TOKEN'), everyMinutes: 10 }), routeHelpdesk);

const handleEscalation = H.flow('handle-escalation')
  .input(Escalation)
  .halt('handle', escalationHandled, {
    ask: ctx => `SLA breached on ticket ${ctx.unit.attributes.ticketId} (${ctx.unit.attributes.subject}): ${ctx.unit.attributes.reason}`,
  })
  .exit('resolved', ctx => ctx.steps.handle.outcome === 'resolved')
  .exit('dismissed');

const escalationLane = H.lane('escalations', escalationKind)
  .handler(handleEscalation, { exits: { resolved: EscalationResolved, dismissed: EscalationDismissed } })
  .retry({ maxAttempts: 1, exhausted: EscalationUnhandled });

const slaBreach = H.trigger('sla-breach')
  .on(H.when.timer(conversationLane, { at: unit => new Date(unit.attributes.slaDue) }))
  .create(escalationLane, event =>
    event.unit.state === 'AwaitingCustomer'
      ? undefined
      : {
          ticketId: event.unit.attributes.ticketId,
          subject: event.unit.attributes.subject,
          reason: `No reply sent by ${event.unit.attributes.slaDue}`,
        },
  )
  .signal(slaBreached, conversationLane, event =>
    event.unit.state === 'AwaitingCustomer' ? undefined : { key: event.unit.key, payload: {} },
  );

const taste = H.journal('reply-taste', H.memory('reply-taste', 'taste'))
  .store(jsonl.memoryStore({ path: './memory/taste.jsonl' }))
  .recall({ by: 'specificity', limit: 10 })
  .readBy(drafterRole)
  .recordedBy(reviewerRole);

const experience = H.journal('support-experience', H.memory('support-experience', 'experience'))
  .store(jsonl.memoryStore({ path: './memory/experience.jsonl' }))
  .recall({ by: 'specificity', limit: 8 })
  .readBy(drafterRole)
  .recordedBy(reviewerRole);

const editsBecomeTaste = H.trigger('reviewer-edits-become-taste')
  .on(H.when.decision(conversationKind, approval))
  .record(taste, event =>
    event.decision.editedReply === undefined
      ? undefined
      : {
          text: `When drafting a ${event.facets.map(facet => facet.value).join(', ')} reply, write it the way the reviewer did ("${event.decision.editedReply}"), because the reviewer rewrote the draft`,
          status: 'candidate',
          when: { roles: [drafterRole] },
        },
  );

const scheduler = H.scheduler('support')
  .fixedDate(conversationLane, unit => new Date(unit.attributes.slaDue))
  .standard(escalationLane)
  .wip(conversationLane, 6);

const supervisor = claudeCode.supervisor('reviewer-desk', {
  port: H.slot.port(0),
  grants: [
    H.ops.workRead,
    H.ops.workUpdate,
    H.ops.attemptsRecover,
    H.ops.resolve(approval, costCeiling, escalationHandled),
    H.ops.memoryRead,
    H.ops.memoryWrite,
    H.ops.telemetryRead,
  ],
});

export default H.harness('support-triage')
  .ledger(sqlite.ledger({ path: './state/ledger.sqlite' }))
  .lanes(conversationLane, escalationLane)
  .journals(taste, experience)
  .triggers(slaBreach, editsBecomeTaste)
  .metrics(approvalRate)
  .scheduler(scheduler)
  .clients(supervisor)
  .observers(markdown.board({ path: './BOARD.md' }), markdown.telemetry({ path: './TELEMETRY.md' }));
