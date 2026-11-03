import { z } from 'zod';
import { H } from 'harness-dsl';
import type { Router, Route } from 'harness-dsl';
import { zendesk } from 'harness-dsl/zendesk';
import type { ZendeskEvent } from 'harness-dsl/zendesk';
import { anthropic } from 'harness-dsl/anthropic';
import { sqlite } from 'harness-dsl/sqlite';
import { jsonl } from 'harness-dsl/jsonl';
import { local } from 'harness-dsl/local';
import { claudeCode } from 'harness-dsl/claude-code';
import { markdown } from 'harness-dsl/markdown';

const conversation = z.object({
  ticketId: z.string(),
  subject: z.string(),
  message: z.string(),
  customerEmail: z.string(),
  slaDeadline: z.string(),
  escalationReason: z.string().optional(),
});
type ConversationAttrs = z.infer<typeof conversation>;
const escalation = z.object({ ticketId: z.string(), subject: z.string(), reason: z.string() });

const categories = z.enum(['billing', 'refund', 'technical', 'account', 'other']);
const category = H.facet('category', categories);

const New = H.state('New', 'pending');
const Sent = H.state('Sent', 'waiting');
const ClosedByCustomer = H.terminal('ClosedByCustomer', 'success');
const Escalated = H.terminal('Escalated', 'failure');
const Conversation = H.kind('Conversation')
  .attributes(conversation)
  .states(New, Sent, ClosedByCustomer, Escalated)
  .key(a => a.ticketId);

const EscalationOpen = H.state('EscalationOpen', 'pending');
const EscalationHandled = H.terminal('EscalationHandled', 'success');
const EscalationDropped = H.terminal('EscalationDropped', 'failure');
const Escalation = H.kind('Escalation')
  .attributes(escalation)
  .states(EscalationOpen, EscalationHandled, EscalationDropped)
  .key(a => a.ticketId);

const customerReplied = H.signal('customer-replied').payload(z.object({ message: z.string() }));
const customerClosed = H.signal('customer-closed');
const slaBreached = H.signal('sla-breached');

const slaHours = { low: 48, normal: 24, high: 8, urgent: 2 };

const routeTicket = (event: ZendeskEvent, to: Router<ConversationAttrs>): Route => {
  if (event.status === 'solved' || event.status === 'closed') return to.signal(customerClosed, event.ticketId, {});
  if (event.type === 'created') {
    return to.create({
      ticketId: event.ticketId,
      subject: event.subject,
      message: event.message,
      customerEmail: event.customerEmail,
      slaDeadline: new Date(event.createdAt.getTime() + slaHours[event.priority] * 3600000).toISOString(),
    });
  }
  if (event.type === 'replied') return to.signal(customerReplied, event.ticketId, { message: event.message });
  return to.skip();
};

const quota = sqlite.quota('support-quota', { path: '.harness/quota.db' });
const apiAccount = anthropic.account('support-api', { apiKey: H.env('ANTHROPIC_API_KEY'), quota });
const api = H.pool('support-api').accounts(apiAccount);
const haiku = anthropic.model('haiku', { id: 'claude-haiku-4-5' });
const sonnet = anthropic.model('sonnet', { id: 'claude-sonnet-4-5' });

const classifier = H.role('classifier').intents('read').instructions('Classify the conversation into one category.');
const drafter = H.role('drafter').intents('read').instructions('Draft a reply in the house tone, addressing every point the customer raised.');
const reviewer = H.role('reviewer');

const classifierSeat = H.seat('classifier').role(classifier).model(haiku).pool(api).output(z.object({ category: categories }));
const drafterSeat = H.seat('drafter').role(drafter).model(sonnet).pool(api).output(z.object({ reply: z.string() }));

const approval = H.halt('reply-approval').decision(z.object({
  approved: z.boolean(),
  editedReply: z.string().optional(),
  notes: z.string().optional(),
}));
const costCeiling = H.halt('conversation-cost').decision(H.ceilingDecision);
const escalationHandled = H.halt('escalation-handled').decision(z.object({
  outcome: z.enum(['handled', 'dropped']),
  notes: z.string(),
}));

const approvals = H.metric('reply-approvals', H.when.decision(Conversation, approval)).samples(event =>
  event.resolvedBy === 'human'
    ? [{ hit: event.decision.approved, facets: event.facets, seat: drafterSeat, model: event.modelOf(drafterSeat) }]
    : []);

const safeCategory = H.policy.halt('safe-category-skips-approval', Conversation, approval, ({ facets, metrics }) => {
  const record = metrics.rate(approvals, { facets });
  return record.samples >= 200 && record.hits === record.samples ? { approved: true } : undefined;
});

const sendReply = H.command('send-reply')
  .input(z.object({ ticketId: z.string(), reply: z.string() }))
  .argv(i => ['./bin/helpdesk-reply', '--ticket', i.ticketId, '--body', i.reply])
  .runner(local.runner('local'));

const reply = H.flow('reply')
  .input(conversation)
  .step('classify', classifierSeat, ctx => ({
    task: `Classify this conversation.\n\n${ctx.unit.attributes.subject}\n\n${ctx.unit.attributes.message}`,
  }))
  .loop(
    'drafts',
    z.object({ draft: z.string(), notes: z.string() }),
    body => body
      .step('draft', drafterSeat, ctx => ({
        task: [
          `Draft a reply to this ${ctx.steps.classify.category} conversation.`,
          ctx.unit.attributes.message,
          ...ctx.steps.drafts.map(d => `A reviewer rejected:\n${d.draft}\nNotes: ${d.notes}`),
        ].join('\n\n'),
        skills: [ctx.steps.classify.category],
      }))
      .halt('approve', approval, {
        ask: ctx => ctx.steps.draft.reply,
        skip: safeCategory,
        facets: ctx => [category.of(ctx.steps.classify.category)],
      }),
    {
      max: 3,
      until: ctx => ctx.steps.approve.approved,
      feed: ctx => ({ draft: ctx.steps.draft.reply, notes: ctx.steps.approve.notes ?? '' }),
    },
  )
  .exit('unapproved', ctx => !ctx.steps.approve.approved)
  .step('send', sendReply, ctx => ({
    ticketId: ctx.unit.attributes.ticketId,
    reply: ctx.steps.approve.editedReply ?? ctx.steps.draft.reply,
  }), { afterCrash: 'park' })
  .exit('sent');

const handleEscalation = H.flow('handle-escalation')
  .input(escalation)
  .halt('handle', escalationHandled, {
    ask: ctx => `Ticket ${ctx.unit.attributes.ticketId} escalated (${ctx.unit.attributes.reason}): ${ctx.unit.attributes.subject}`,
  })
  .exit('handled', ctx => ctx.steps.handle.outcome === 'handled')
  .exit('dropped');

const helpdeskToken = H.env('ZENDESK_TOKEN');

const conversations = H.lane('conversations', Conversation)
  .supply(zendesk.webhook({ port: H.slot.port(2), path: '/helpdesk', secret: H.env('ZENDESK_WEBHOOK_SECRET') }), routeTicket)
  .supply(zendesk.poll({ subdomain: 'acme', token: helpdeskToken, everyMinutes: 10 }), routeTicket)
  .store(zendesk.store({ subdomain: 'acme', token: helpdeskToken }))
  .handler(reply, { exits: { sent: Sent, unapproved: Escalated } })
  .retry({ maxAttempts: 3, backoff: 'exponential', initialDelayMs: 30000, exhausted: Escalated })
  .ceiling({ maxUsd: 0.4, halt: costCeiling })
  .on(customerReplied, { update: (attrs, payload) => ({ ...attrs, message: payload.message }), enter: New })
  .on(customerClosed, { enter: ClosedByCustomer })
  .on(slaBreached, { update: attrs => ({ ...attrs, escalationReason: 'SLA breached' }), enter: Escalated });

const escalations = H.lane('escalations', Escalation)
  .handler(handleEscalation, { exits: { handled: EscalationHandled, dropped: EscalationDropped } })
  .retry({ maxAttempts: 1, exhausted: EscalationDropped });

const slaBreach = H.trigger('sla-breach-escalates')
  .on(H.when.timer(conversations, { in: New, at: unit => new Date(unit.attributes.slaDeadline) }))
  .signal(slaBreached, conversations, event => ({ key: event.unit.key, payload: {} }));

const openEscalation = H.trigger('escalated-conversation-opens-escalation')
  .on(H.when.transition(conversations, { to: Escalated }))
  .create(escalations, event => ({
    ticketId: event.unit.attributes.ticketId,
    subject: event.unit.attributes.subject,
    reason: event.unit.attributes.escalationReason ?? 'reply not approved or handling failed',
  }));

const tasteJournal = H.journal('support-taste', H.memory('taste', 'taste'))
  .store(jsonl.memoryStore({ path: '.harness/taste.jsonl' }))
  .recall({ by: 'specificity', limit: 10 })
  .readBy(drafter)
  .recordedBy(reviewer);

const experienceJournal = H.journal('support-experience', H.memory('experience', 'experience'))
  .store(jsonl.memoryStore({ path: '.harness/experience.jsonl' }))
  .recall({ by: 'specificity', limit: 10 })
  .readBy(drafter)
  .recordedBy(reviewer);

const reviewerTaste = H.trigger('reviewer-notes-become-taste')
  .on(H.when.decision(Conversation, approval))
  .record(tasteJournal, event =>
    event.resolvedBy === 'human' && event.decision.notes
      ? { text: event.decision.notes, status: 'candidate', when: { roles: [drafter] } }
      : undefined);

const scheduler = H.scheduler('support')
  .fixedDate(conversations, unit => new Date(unit.attributes.slaDeadline))
  .standard(escalations);

const supervisor = claudeCode.supervisor('reviewer', {
  port: H.slot.port(1),
  grants: [
    H.ops.workRead,
    H.ops.workUpdate,
    H.ops.resolve(approval, costCeiling, escalationHandled),
    H.ops.memoryWrite,
    H.ops.memoryCurate,
    H.ops.telemetryRead,
  ],
});

const harness = H.harness('support-triage')
  .ledger(sqlite.ledger({ path: '.harness/ledger.db' }))
  .lanes(conversations, escalations)
  .journals(tasteJournal, experienceJournal)
  .triggers(slaBreach, openEscalation, reviewerTaste)
  .metrics(approvals)
  .scheduler(scheduler)
  .clients(supervisor)
  .observers(markdown.board({ path: 'BOARD.md' }), markdown.telemetry({ path: 'TELEMETRY.md' }));

void harness.start();
