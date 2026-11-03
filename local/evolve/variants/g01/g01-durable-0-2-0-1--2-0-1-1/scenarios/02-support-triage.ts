import { H } from 'harness-dsl';
import type { FacetValue, Router } from 'harness-dsl';
import { z } from 'zod';
import { zendesk } from 'harness-dsl/zendesk';
import type { ZendeskEvent } from 'harness-dsl/zendesk';
import { anthropic } from 'harness-dsl/anthropic';
import { claudeCode } from 'harness-dsl/claude-code';
import { sqlite } from 'harness-dsl/sqlite';
import { jsonl } from 'harness-dsl/jsonl';
import { markdown } from 'harness-dsl/markdown';

const ConversationAttributes = z.object({
  ticketId: z.string(),
  subject: z.string(),
  message: z.string(),
  customerEmail: z.string(),
  priority: z.enum(['low', 'normal', 'high', 'urgent']),
  slaDueAt: z.string(),
});
type ConversationAttrs = z.infer<typeof ConversationAttributes>;

const EscalationAttributes = z.object({ ticketId: z.string(), subject: z.string(), reason: z.string() });

const Category = z.enum(['billing', 'refund', 'technical', 'account', 'other']);
const category = H.facet('category');

const New = H.state('New', 'pending');
const Classifying = H.state('Classifying', 'active');
const Drafting = H.state('Drafting', 'active');
const AwaitingApproval = H.state('AwaitingApproval', 'waiting');
const Sending = H.state('Sending', 'active');
const Sent = H.terminal('Sent', 'success');
const ClosedByCustomer = H.terminal('ClosedByCustomer', 'neutral');
const Escalated = H.terminal('Escalated', 'failure');

const Conversation = H.kind('Conversation')
  .attributes(ConversationAttributes)
  .states(New, Classifying, Drafting, AwaitingApproval, Sending, Sent, ClosedByCustomer, Escalated)
  .key(conversation => conversation.ticketId)
  .initial(New);

const EscalationOpen = H.state('EscalationOpen', 'pending');
const WithHuman = H.state('WithHuman', 'waiting');
const Unhandled = H.state('Unhandled', 'waiting');
const Handled = H.terminal('Handled', 'success');
const EscalationDropped = H.terminal('EscalationDropped', 'neutral');

const Escalation = H.kind('Escalation')
  .attributes(EscalationAttributes)
  .states(EscalationOpen, WithHuman, Unhandled, Handled, EscalationDropped)
  .key(escalation => escalation.ticketId)
  .initial(EscalationOpen);

const apiAccount = anthropic.account('support-api', { apiKey: H.env('ANTHROPIC_API_KEY') });
const pool = H.pool('support').accounts(apiAccount);
const haiku = anthropic.model('haiku', { id: 'claude-haiku-4-5' });
const sonnet = anthropic.model('sonnet', { id: 'claude-sonnet-4-5' });

const classifierRole = H.role('classifier').intents('read').instructions('Classify the conversation into one category.');
const drafterRole = H.role('drafter').intents('read').instructions('Draft a reply the reviewer can send unchanged.');
const reviewerRole = H.role('reviewer');

const classifier = H.seat('classifier').role(classifierRole).model(haiku).pool(pool).output(z.object({ category: Category }));
const drafter = H.seat('drafter').role(drafterRole).model(sonnet).pool(pool).output(z.object({ reply: z.string() }));

const ReplyApproval = H.halt('reply-approval').decision(
  z.object({ approved: z.boolean(), editedReply: z.string().optional(), notes: z.string().optional() }),
);
const EscalationHandled = H.halt('escalation-handled').decision(z.object({ resolution: z.string() }));

const categoryIn = (scope: readonly FacetValue[]) =>
  scope.find(value => value.facet === category.name)?.value ?? 'unclassified';

const approvals = H.metric('reply-approvals', H.when.decision(Conversation, ReplyApproval))
  .facets(category)
  .samples(event =>
    event.resolvedBy === 'human'
      ? [
          {
            hit: event.decision.approved,
            seat: drafter,
            model: event.seats.find(choice => choice.seat === drafter)?.model,
            facets: { category: categoryIn(event.scope) },
          },
        ]
      : [],
  );

const safeCategory = H.policy.halt('safe-category', Conversation, ReplyApproval, ctx => {
  const record = ctx.metrics.rate(approvals, { facets: { category: categoryIn(ctx.scope) } });
  return record.samples >= 200 && record.hits === record.samples ? { approved: true } : undefined;
});

const sendReply = H.command('send-reply')
  .input(z.object({ ticketId: z.string(), body: z.string() }))
  .argv(reply => ['helpdesk-reply', '--ticket', reply.ticketId, '--body', reply.body]);

const triage = H.flow('triage')
  .input(ConversationAttributes)
  .step('classify', classifier, ctx => ({
    task: `Classify this conversation.\nSubject: ${ctx.unit.attributes.subject}\n\n${ctx.unit.attributes.message}`,
  }))
  .loop(
    'drafting',
    drafting =>
      drafting
        .step('draft', drafter, ctx => ({
          task: `Draft a reply.\nSubject: ${ctx.unit.attributes.subject}\n\n${ctx.unit.attributes.message}`,
          facets: [category.is(ctx.steps.classify.category)],
        }))
        .halt('approval', ReplyApproval, {
          ask: ctx => ctx.steps.draft.reply,
          scope: ctx => [category.is(ctx.steps.classify.category)],
          skip: safeCategory,
        }),
    { max: 3, until: ctx => ctx.steps.approval.approved },
  )
  .exit('unapproved', ctx => ctx.steps.approval.approved === false)
  .step(
    'send',
    sendReply,
    ctx => ({ ticketId: ctx.unit.attributes.ticketId, body: ctx.steps.approval.editedReply ?? ctx.steps.draft.reply }),
    { afterCrash: 'park' },
  )
  .exit('sent');

const handleEscalation = H.flow('handle-escalation')
  .input(EscalationAttributes)
  .halt('handle', EscalationHandled, {
    ask: ctx => `Escalated ticket ${ctx.unit.attributes.ticketId}: ${ctx.unit.attributes.reason}`,
  })
  .exit('handled');

const CustomerReplied = H.signal('customer-replied').payload(z.object({ message: z.string() }));
const CustomerClosed = H.signal('customer-closed');
const SlaBreached = H.signal('sla-breached');

const slaHours = { low: 48, normal: 24, high: 8, urgent: 2 };

const routeTicket = (event: ZendeskEvent, to: Router<ConversationAttrs>) => {
  if (event.type === 'created') {
    return to.create({
      ticketId: event.ticketId,
      subject: event.subject,
      message: event.message,
      customerEmail: event.customerEmail,
      priority: event.priority,
      slaDueAt: new Date(event.createdAt.getTime() + slaHours[event.priority] * 3_600_000).toISOString(),
    });
  }
  if (event.type === 'replied') {
    return to.signal(CustomerReplied, event.ticketId, { message: event.message });
  }
  if (event.status === 'closed' || event.status === 'solved') {
    return to.signal(CustomerClosed, event.ticketId, {});
  }
  return to.skip();
};

const helpdeskToken = H.env('ZENDESK_TOKEN');

const conversations = H.lane('conversations', Conversation)
  .supply(zendesk.webhook({ port: H.slot.port(1), path: '/zendesk', secret: H.env('ZENDESK_WEBHOOK_SECRET') }), routeTicket)
  .supply(zendesk.poll({ subdomain: 'acme', token: helpdeskToken, everyMinutes: 10 }), routeTicket)
  .store(zendesk.store({ subdomain: 'acme', token: helpdeskToken }))
  .handler(triage, {
    exits: { unapproved: Escalated, sent: Sent },
    during: {
      classify: Classifying,
      draft: Drafting,
      approval: AwaitingApproval,
      send: Sending,
    },
    cancelled: ClosedByCustomer,
  })
  .retry({ maxAttempts: 3, backoff: 'exponential', initialDelayMs: 30_000, exhausted: Escalated })
  .on(CustomerReplied, {
    update: (attrs, reply) => ({ ...attrs, message: reply.message }),
    restart: { to: 'classify', at: ['approval'] },
  })
  .on(CustomerClosed, { enter: ClosedByCustomer })
  .on(SlaBreached, { enter: Escalated })
  .ceiling({ maxUsd: 0.4, onExceed: 'halt' });

const escalations = H.lane('escalations', Escalation)
  .handler(handleEscalation, {
    exits: { handled: Handled },
    during: { handle: WithHuman },
    cancelled: EscalationDropped,
  })
  .retry({ maxAttempts: 1, exhausted: Unhandled });

const slaBreach = H.when.timer(conversations, { at: unit => new Date(unit.attributes.slaDueAt) });

const breachEscalates = H.trigger('sla-breach-escalates')
  .on(slaBreach)
  .create(escalations, event => ({
    ticketId: event.unit.attributes.ticketId,
    subject: event.unit.attributes.subject,
    reason: `SLA breached at ${event.unit.attributes.slaDueAt}`,
  }))
  .signal(SlaBreached, conversations, event => ({ key: event.unit.key, payload: {} }));

const taste = H.journal('support-taste', H.memory('tone', 'taste'))
  .store(jsonl.memoryStore({ path: './memory/support-taste.jsonl' }))
  .recall({ by: 'specificity', limit: 10 })
  .readBy(drafterRole)
  .recordedBy(reviewerRole);

const experience = H.journal('support-experience', H.memory('support-lessons', 'experience'))
  .store(jsonl.memoryStore({ path: './memory/support-experience.jsonl' }))
  .recall({ by: 'specificity', limit: 8 })
  .readBy(drafterRole);

const editsBecomeTaste = H.trigger('reviewer-edits-become-taste')
  .on(H.when.decision(Conversation, ReplyApproval))
  .record(taste, event =>
    event.resolvedBy === 'human' && typeof event.decision.notes === 'string'
      ? {
          text: `When replying in ${categoryIn(event.scope)}, ${event.decision.notes}`,
          status: 'candidate',
          when: { roles: [drafterRole], facets: [category.is(categoryIn(event.scope))] },
        }
      : undefined,
  );

const scheduler = H.scheduler('support')
  .priority(escalations, conversations)
  .rank(conversations, unit => Date.parse(unit.attributes.slaDueAt));

const reviewerDesk = H.client('reviewer-desk', {
  transport: claudeCode.mcp('support-mcp'),
  grants: [
    H.ops.workRead,
    H.ops.workUpdate,
    H.ops.workCancel,
    H.ops.resolve(ReplyApproval, EscalationHandled),
    H.ops.attemptsRecover,
    H.ops.memoryWrite,
    H.ops.memoryCurate,
    H.ops.telemetryRead,
  ],
});

export const supportTriage = H.harness('support-triage')
  .ledger(sqlite.ledger({ path: './.harness/support.db' }))
  .lanes(conversations, escalations)
  .journals(taste, experience)
  .triggers(breachEscalates, editsBecomeTaste)
  .metrics(approvals)
  .scheduler(scheduler)
  .clients(reviewerDesk)
  .observers(markdown.board({ path: './BOARD.md' }), markdown.telemetry({ path: './TELEMETRY.md' }));

export const supervisor = claudeCode.session('reviewer', { clients: [reviewerDesk] });
