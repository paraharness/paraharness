import { z } from 'zod';
import { H } from 'harness-dsl';
import { sqlite } from 'harness-dsl/sqlite';
import { jsonl } from 'harness-dsl/jsonl';
import { anthropic } from 'harness-dsl/anthropic';
import { claudeCode } from 'harness-dsl/claude-code';
import { zendesk } from 'harness-dsl/zendesk';
import { local } from 'harness-dsl/local';
import { markdown } from 'harness-dsl/markdown';

const categories = H.facet('category', ['billing', 'refund', 'technical', 'account', 'other']);

const New = H.state('New', 'pending');
const AwaitingCustomer = H.state('AwaitingCustomer', 'waiting');
const ClosedByCustomer = H.terminal('ClosedByCustomer', 'success');
const Escalated = H.terminal('Escalated', 'failure');
const EscalationOpen = H.state('EscalationOpen', 'pending');
const EscalationResolved = H.terminal('EscalationResolved', 'success');
const EscalationReferred = H.terminal('EscalationReferred', 'neutral');

const conversationAttrs = z.object({
  ticketId: z.string(),
  subject: z.string(),
  customerEmail: z.string(),
  lastMessage: z.string(),
  slaDeadline: z.string(),
});

const conversationKind = H.kind('Conversation')
  .attributes(conversationAttrs)
  .states(New, AwaitingCustomer, ClosedByCustomer, Escalated)
  .key(a => a.ticketId)
  .initial(New);

const escalationAttrs = z.object({ ticketId: z.string(), subject: z.string(), reason: z.string() });

const escalationKind = H.kind('Escalation')
  .attributes(escalationAttrs)
  .states(EscalationOpen, EscalationResolved, EscalationReferred)
  .key(a => a.ticketId)
  .initial(EscalationOpen);

const customerReplied = H.signal('customer-replied').payload(z.object({ message: z.string() }));
const customerClosed = H.signal('customer-closed');
const slaBreached = H.signal('sla-breached');

const approval = H.halt('reply-approval')
  .decision(z.object({ verdict: z.enum(['approve', 'reject']), editedReply: z.string().optional() }));
const costCeiling = H.halt('conversation-cost-ceiling').decision(H.ceilingDecision);
const escalationHandling = H.halt('escalation-handling')
  .decision(z.object({ outcome: z.enum(['resolved', 'referred']), note: z.string() }));

const helpdeskQuota = sqlite.quota('anthropic-quota', { path: '.harness/quota.sqlite' });
const apiAccount = anthropic.account('support-api', { apiKey: H.env('ANTHROPIC_API_KEY'), quota: helpdeskQuota });
const supportPool = H.pool('support').accounts(apiAccount);

const haiku = anthropic.model('haiku', { id: 'claude-haiku-4-5' });
const sonnet = anthropic.model('sonnet', { id: 'claude-sonnet-4-5' });

const classifierRole = H.role('classifier').intents('read').instructions('Classify the conversation into one category.');
const drafterRole = H.role('drafter').intents('read', 'search').instructions('Draft the next reply to the customer.');
const reviewerRole = H.role('reviewer').intents('read', 'record').instructions('Approve or edit outgoing replies.');

const classifier = H.seat('classifier')
  .role(classifierRole)
  .model(haiku)
  .pool(supportPool)
  .output(z.object({ category: categories.schema }));

const drafter = H.seat('drafter')
  .role(drafterRole)
  .model(sonnet)
  .pool(supportPool)
  .output(z.object({ reply: z.string() }));

const taste = H.journal('support-taste', H.memory('support-taste', 'taste'))
  .store(jsonl.memoryStore({ path: '.harness/memory/taste.jsonl' }))
  .recall({ by: 'specificity', limit: 10 })
  .readBy(drafterRole)
  .recordedBy(reviewerRole);

const experience = H.journal('support-experience', H.memory('support-experience', 'experience'))
  .store(jsonl.memoryStore({ path: '.harness/memory/experience.jsonl' }))
  .recall({ by: 'specificity', limit: 8 })
  .readBy(drafterRole);

const approvalRate = H.metric('approval-rate', H.when.decision(conversationKind, approval))
  .samples(e => {
    const category = e.facet(categories);
    return e.resolvedBy === 'human'
      ? [{
          hit: e.decision.verdict === 'approve',
          model: e.modelOf(drafter),
          facets: category === undefined ? [] : [categories.of(category)],
        }]
      : [];
  });

const safeCategory = H.policy.halt('safe-category', conversationKind, approval)
  .decide(ctx => {
    const category = ctx.facet(categories);
    if (category === undefined) return undefined;
    const approvals = ctx.metrics.rate(approvalRate, { facets: [categories.of(category)] });
    return approvals.samples >= 200 && approvals.hits === approvals.samples ? { verdict: 'approve' } : undefined;
  });

const sendReply = H.command('send-reply')
  .input(z.object({ ticketId: z.string(), body: z.string() }))
  .argv(i => ['./bin/helpdesk-send', i.ticketId, i.body])
  .runner(local.runner('local'));

const triage = H.flow('triage')
  .input(conversationAttrs)
  .step('classify', classifier, ctx => ({
    task: `Classify this conversation.\nSubject: ${ctx.unit.attributes.subject}\n\n${ctx.unit.attributes.lastMessage}`,
  }))
  .step('draft', drafter, ctx => ({
    task: `Draft a reply in category ${ctx.steps.classify.category}.\nSubject: ${ctx.unit.attributes.subject}\n\n${ctx.unit.attributes.lastMessage}`,
  }))
  .halt('approval', approval, {
    ask: ctx => `Approve this reply to ${ctx.unit.attributes.customerEmail}:\n\n${ctx.steps.draft.reply}`,
    facets: ctx => [categories.of(ctx.steps.classify.category)],
    skip: safeCategory,
  })
  .exit('rejected', ctx => ctx.steps.approval.verdict === 'reject')
  .step('send', sendReply, ctx => ({
    ticketId: ctx.unit.attributes.ticketId,
    body: ctx.steps.approval.editedReply ?? ctx.steps.draft.reply,
  }), { afterCrash: 'park' })
  .exit('sent');

const handleEscalation = H.flow('handle-escalation')
  .input(escalationAttrs)
  .halt('handle', escalationHandling, {
    ask: ctx => `Ticket ${ctx.unit.attributes.ticketId} escalated: ${ctx.unit.attributes.reason}`,
  })
  .exit('resolved', ctx => ctx.steps.handle.outcome === 'resolved')
  .exit('referred');

const slaHours = { low: 48, normal: 24, high: 8, urgent: 2 };

const helpdeskStore = zendesk.store({ subdomain: 'acme', token: H.env('ZENDESK_TOKEN') });

const conversations = H.lane('conversations', conversationKind)
  .supply([
    zendesk.webhook({ port: H.slot.port(0), path: '/zendesk', secret: H.env('ZENDESK_WEBHOOK_SECRET') }),
    zendesk.poll({ subdomain: 'acme', token: H.env('ZENDESK_TOKEN'), everyMinutes: 10 }),
  ], (event, to) =>
    event.status === 'closed' || event.status === 'solved'
      ? to.signal(customerClosed, event.ticketId, {})
      : event.type === 'created'
        ? to.create({
            ticketId: event.ticketId,
            subject: event.subject,
            customerEmail: event.customerEmail,
            lastMessage: event.message,
            slaDeadline: new Date(event.createdAt.getTime() + slaHours[event.priority] * 3_600_000).toISOString(),
          })
        : event.type === 'replied'
          ? to.signal(customerReplied, event.ticketId, { message: event.message })
          : to.skip())
  .handler(triage, { exits: { sent: AwaitingCustomer, rejected: Escalated } })
  .store(helpdeskStore)
  .retry({ maxAttempts: 3, backoff: 'exponential', initialDelayMs: 30_000, exhausted: Escalated })
  .on(customerReplied, { update: (a, p) => ({ ...a, lastMessage: p.message }), enter: New })
  .on(customerClosed, { enter: ClosedByCustomer })
  .on(slaBreached, { enter: Escalated })
  .ceiling({ maxUsd: 0.4, onExceed: costCeiling });

const escalations = H.lane('escalations', escalationKind)
  .handler(handleEscalation, { exits: { resolved: EscalationResolved, referred: EscalationReferred } })
  .store(helpdeskStore)
  .retry({ maxAttempts: 1, exhausted: EscalationReferred });

const slaBreachEscalates = H.trigger('sla-breach-escalates')
  .on(H.when.timer(conversations, {
    reads: ['slaDeadline'],
    at: view => new Date(view.attributes.slaDeadline),
  }))
  .create(escalations, e => ({
    ticketId: e.unit.attributes.ticketId,
    subject: e.unit.attributes.subject,
    reason: `SLA breached at ${e.at.toISOString()}`,
  }))
  .signal(slaBreached, conversations, e => ({ key: e.unit.key, payload: {} }));

const editsBecomeTaste = H.trigger('reviewer-edits-become-taste')
  .on(H.when.decision(conversationKind, approval))
  .record(taste, e => e.decision.editedReply === undefined
    ? undefined
    : {
        text: `When drafting a reply like this, prefer the reviewer's wording "${e.decision.editedReply}", because the reviewer rewrote the draft to it.`,
        when: { roles: [drafterRole] },
        status: 'candidate',
      });

const scheduler = H.scheduler('support')
  .fixedDate(conversations, unit => new Date(unit.attributes.slaDeadline))
  .standard(escalations);

const reviewerDesk = claudeCode.supervisor('reviewer-desk', {
  grants: [
    H.ops.workRead,
    H.ops.workUpdate,
    H.ops.resolve(approval, costCeiling, escalationHandling),
    H.ops.memoryRead,
    H.ops.memoryWrite,
    H.ops.memoryCurate,
    H.ops.telemetryRead,
  ],
});

export const harness = H.harness('support-triage')
  .ledger(sqlite.ledger({ path: '.harness/ledger.sqlite' }))
  .lanes(conversations, escalations)
  .journals(taste, experience)
  .triggers(slaBreachEscalates, editsBecomeTaste)
  .metrics(approvalRate)
  .scheduler(scheduler)
  .clients(reviewerDesk)
  .observers(markdown.board({ path: 'BOARD.md' }), markdown.telemetry({ path: 'TELEMETRY.md' }));

void harness.start();
