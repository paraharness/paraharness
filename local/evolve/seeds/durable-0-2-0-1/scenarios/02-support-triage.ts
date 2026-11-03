import { z } from 'zod';
import { H, type MetricRef, type Metrics, type Route, type Router } from 'harness-dsl';
import { sqlite } from 'harness-dsl/sqlite';
import { jsonl } from 'harness-dsl/jsonl';
import { claudeCode } from 'harness-dsl/claude-code';
import { anthropic } from 'harness-dsl/anthropic';
import { zendesk, type ZendeskEvent } from 'harness-dsl/zendesk';
import { local } from 'harness-dsl/local';
import { markdown } from 'harness-dsl/markdown';

const conversationAttrs = z.object({
  ticketId: z.string(),
  subject: z.string(),
  message: z.string(),
  customerEmail: z.string(),
  slaDueAt: z.string(),
});
type ConversationAttrs = z.infer<typeof conversationAttrs>;

const escalationAttrs = z.object({ ticketId: z.string(), subject: z.string(), reason: z.string() });

const New = H.state('New', 'pending');
const Classifying = H.state('Classifying', 'active');
const Drafting = H.state('Drafting', 'active');
const AwaitingApproval = H.state('AwaitingApproval', 'waiting');
const Sending = H.state('Sending', 'active');
const Sent = H.terminal('Sent', 'success');
const ClosedByCustomer = H.terminal('ClosedByCustomer', 'neutral');
const Escalated = H.terminal('Escalated', 'failure');

const Conversation = H.kind('Conversation')
  .attributes(conversationAttrs)
  .states(New, Classifying, Drafting, AwaitingApproval, Sending, Sent, ClosedByCustomer, Escalated)
  .key((attrs) => attrs.ticketId)
  .initial(New);

const EscalationOpen = H.state('EscalationOpen', 'pending');
const WithHuman = H.state('WithHuman', 'waiting');
const Handled = H.terminal('Handled', 'success');
const Unhandled = H.terminal('Unhandled', 'failure');

const Escalation = H.kind('Escalation')
  .attributes(escalationAttrs)
  .states(EscalationOpen, WithHuman, Handled, Unhandled)
  .key((attrs) => attrs.ticketId)
  .initial(EscalationOpen);

const replyDuringApproval = H.signal('replyDuringApproval').payload(z.object({ message: z.string() }));
const replyNoted = H.signal('replyNoted').payload(z.object({ message: z.string() }));
const customerClosed = H.signal('customerClosed');
const slaBreached = H.signal('slaBreached');

const classifierRole = H.role('classifier').intents('read').instructions('Assign the conversation one support category.');
const drafterRole = H.role('drafter').intents('read', 'search').instructions('Draft the next reply to the customer.');
const reviewerRole = H.role('reviewer').instructions('Approve, edit or reject outgoing replies.');

const apiAccount = anthropic.account('support-api', { apiKey: H.env('ANTHROPIC_API_KEY') });
const support = H.pool('support').accounts(apiAccount);

const haiku = anthropic.model('haiku', { id: 'claude-haiku-4-5' });
const sonnet = anthropic.model('sonnet', { id: 'claude-sonnet-4-5' });

const classifier = H.agent('classifier')
  .role(classifierRole)
  .model(haiku)
  .pool(support)
  .output(z.object({ category: z.string() }));

const drafter = H.agent('drafter')
  .role(drafterRole)
  .model(sonnet)
  .pool(support)
  .output(z.object({ reply: z.string() }));

const localRunner = local.runner('local');

const sendReply = H.command('send-reply')
  .input(z.object({ ticketId: z.string(), reply: z.string() }))
  .argv((input) => ['./support/send-reply.sh', input.ticketId, input.reply])
  .runner(localRunner);

const approvalDecision = z.object({
  approved: z.boolean(),
  reply: z.string(),
  notes: z.string().optional(),
  auto: z.boolean().optional(),
});

function isSafeCategory(metrics: Metrics, category: string): boolean {
  const approvals = metrics.rate(humanApprovalByCategory, { group: category });
  return approvals.samples >= 200 && approvals.hits === approvals.samples;
}

const triage = H.flow('triage')
  .input(conversationAttrs)
  .step('classify', classifier, (ctx) => ({
    task: `Classify this conversation.\n\nSubject: ${ctx.unit.attributes.subject}\n\n${ctx.unit.attributes.message}`,
  }))
  .loop(
    'drafting',
    (round) =>
      round
        .step('draft', drafter, (ctx) => ({
          task: `Draft a reply to ${ctx.unit.attributes.customerEmail}.\n\nSubject: ${ctx.unit.attributes.subject}\n\n${ctx.unit.attributes.message}`,
          skills: [ctx.steps.classify.category],
        }))
        .halt('approval', {
          ask: (ctx) => `Approve this reply in category ${ctx.steps.classify.category}:\n\n${ctx.steps.draft.reply}`,
          decision: approvalDecision,
          skip: (ctx) =>
            isSafeCategory(ctx.metrics, ctx.steps.classify.category)
              ? { approved: true, reply: ctx.steps.draft.reply, auto: true }
              : undefined,
        }),
    { max: 3, until: (ctx) => ctx.steps.approval.approved },
  )
  .exit('unapproved', (ctx) => !ctx.steps.approval.approved)
  .step('send', sendReply, (ctx) => ({ ticketId: ctx.unit.attributes.ticketId, reply: ctx.steps.approval.reply }), {
    afterCrash: 'park',
  })
  .exit('sent');

const humanEscalation = H.flow('human-escalation')
  .input(escalationAttrs)
  .halt('handle', {
    ask: (ctx) =>
      `Conversation ${ctx.unit.attributes.ticketId} (${ctx.unit.attributes.subject}) was escalated: ${ctx.unit.attributes.reason}. Resolve it with the customer and record what you did.`,
    decision: z.object({ resolution: z.string() }),
  })
  .exit('handled');

const slaHours = { low: 48, normal: 24, high: 8, urgent: 2 };

function routeHelpdesk(event: ZendeskEvent, to: Router<ConversationAttrs, string>): Route | readonly Route[] {
  if (event.type === 'created') {
    return to.create({
      ticketId: event.ticketId,
      subject: event.subject,
      message: event.message,
      customerEmail: event.customerEmail,
      slaDueAt: new Date(event.createdAt.getTime() + slaHours[event.priority] * 3_600_000).toISOString(),
    });
  }
  if (event.status === 'solved' || event.status === 'closed') {
    return to.signal(customerClosed, event.ticketId, {});
  }
  if (event.type === 'replied') {
    return [
      to.signal(
        replyDuringApproval,
        (unit) => unit.key === event.ticketId && unit.attempt?.step === 'approval',
        { message: event.message },
      ),
      to.signal(
        replyNoted,
        (unit) => unit.key === event.ticketId && unit.attempt?.step !== 'approval',
        { message: event.message },
      ),
    ];
  }
  return to.skip();
}

const escalations = H.lane('escalations', Escalation)
  .handler(humanEscalation, { exits: { handled: Handled }, during: { handle: WithHuman } })
  .retry({ maxAttempts: 2, backoff: 'fixed', initialDelayMs: 60_000, exhausted: Unhandled });

const conversations = H.lane('conversations', Conversation)
  .supply(
    zendesk.webhook({ port: H.slot.port(0), path: '/helpdesk', secret: H.env('ZENDESK_WEBHOOK_SECRET') }),
    routeHelpdesk,
  )
  .supply(zendesk.poll({ subdomain: 'acme', token: H.env('ZENDESK_TOKEN'), everyMinutes: 10 }), routeHelpdesk)
  .store(zendesk.store({ subdomain: 'acme', token: H.env('ZENDESK_TOKEN') }))
  .handler(triage, {
    exits: { unapproved: Escalated, sent: Sent },
    during: { classify: Classifying, draft: Drafting, approval: AwaitingApproval, send: Sending },
  })
  .retry({ maxAttempts: 3, backoff: 'exponential', initialDelayMs: 30_000, exhausted: Escalated })
  .ceiling({ maxUsd: 0.4, onExceed: 'halt' })
  .on(replyDuringApproval, {
    update: (attrs, payload) => ({ ...attrs, message: payload.message }),
    restart: 'classify',
  })
  .on(replyNoted, { update: (attrs, payload) => ({ ...attrs, message: payload.message }) })
  .on(customerClosed, { enter: ClosedByCustomer })
  .on(slaBreached, { enter: Escalated });

const humanApprovalByCategory: MetricRef<'rate'> = H.metric(
  'human-approval-by-category',
  H.when.step(conversations, 'approval'),
).samples((event) =>
  event.output === undefined || event.output.auto === true
    ? []
    : [{ group: event.outputs.classify?.category ?? 'unclassified', hit: event.output.approved }],
);

const humanApprovalByModel: MetricRef<'rate'> = H.metric(
  'human-approval-by-model',
  H.when.step(conversations, 'approval'),
).samples((event) =>
  event.output === undefined || event.output.auto === true
    ? []
    : [{ group: event.models.draft ?? 'unknown', hit: event.output.approved }],
);

const supportTaste = H.journal('support-taste', H.memory('support-taste', 'taste'))
  .store(jsonl.memoryStore({ path: '.harness/taste.jsonl' }))
  .recall({ by: 'specificity', limit: 10 })
  .readBy(drafterRole)
  .recordedBy(reviewerRole);

const supportExperience = H.journal('support-experience', H.memory('support-experience', 'experience'))
  .store(jsonl.memoryStore({ path: '.harness/experience.jsonl' }))
  .recall({ by: 'specificity', limit: 10 })
  .readBy(drafterRole)
  .recordedBy(reviewerRole);

const slaBreachEscalates = H.trigger('sla-breach-escalates')
  .on(H.when.timer(conversations, { at: (unit) => new Date(unit.attributes.slaDueAt) }))
  .create(escalations, (event) => ({
    ticketId: event.unit.attributes.ticketId,
    subject: event.unit.attributes.subject,
    reason: `SLA breached at ${event.at.toISOString()}`,
  }))
  .signal(slaBreached, conversations, (event) => ({ key: event.unit.key, payload: {} }));

const escalatedConversationNeedsHuman = H.trigger('escalated-conversation-needs-human')
  .on(H.when.transition(conversations, { to: Escalated }))
  .create(escalations, (event) => ({
    ticketId: event.unit.attributes.ticketId,
    subject: event.unit.attributes.subject,
    reason: 'no approved reply could be sent',
  }));

const reviewerNotesBecomeTaste = H.trigger('reviewer-notes-become-taste')
  .on(H.when.step(conversations, 'approval'))
  .record(supportTaste, (event) => {
    const notes = event.output?.notes;
    const category = event.outputs.classify?.category;
    return notes === undefined
      ? undefined
      : {
          text: notes,
          when: { kinds: [Conversation], roles: [drafterRole], skills: category === undefined ? [] : [category] },
          status: 'candidate',
        };
  });

const scheduler = H.scheduler('support')
  .priority(escalations, conversations)
  .rank(conversations, (unit) => new Date(unit.attributes.slaDueAt).getTime());

const supervisor = claudeCode.supervisor('reviewer-supervisor', {
  grants: [
    H.ops.workRead,
    H.ops.workUpdate,
    H.ops.workCancel,
    H.ops.blockersResolve,
    H.ops.memoryRead,
    H.ops.memoryWrite,
    H.ops.memoryCurate,
    H.ops.telemetryRead,
  ],
});

export const supportTriage = H.harness('support-triage')
  .ledger(sqlite.ledger({ path: '.harness/ledger.db' }))
  .lanes(conversations, escalations)
  .journals(supportTaste, supportExperience)
  .triggers(slaBreachEscalates, escalatedConversationNeedsHuman, reviewerNotesBecomeTaste)
  .metrics(humanApprovalByCategory, humanApprovalByModel)
  .scheduler(scheduler)
  .clients(supervisor)
  .observers(markdown.board({ path: '.harness/BOARD.md' }), markdown.telemetry({ path: '.harness/TELEMETRY.md' }));

void supportTriage.start();
