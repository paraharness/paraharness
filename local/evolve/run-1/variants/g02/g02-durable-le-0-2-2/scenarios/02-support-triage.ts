import { z } from 'zod';
import { H } from 'harness-dsl';
import { anthropic } from 'harness-dsl/anthropic';
import { claudeCode } from 'harness-dsl/claude-code';
import { zendesk } from 'harness-dsl/zendesk';
import { local } from 'harness-dsl/local';
import { sqlite } from 'harness-dsl/sqlite';
import { jsonl } from 'harness-dsl/jsonl';
import { markdown } from 'harness-dsl/markdown';

const ConversationSchema = z.object({
  ticketId: z.string(),
  subject: z.string(),
  message: z.string(),
  customerEmail: z.string(),
  slaDueAt: z.string(),
});

const EscalationSchema = z.object({
  ticketId: z.string(),
  subject: z.string(),
  reason: z.string(),
});

const New = H.state('New', 'pending');
const Sent = H.terminal('Sent', 'success');
const ClosedByCustomer = H.terminal('ClosedByCustomer', 'neutral');
const Escalated = H.terminal('Escalated', 'failure');
const Rejected = H.terminal('Rejected', 'failure');
const Cancelled = H.terminal('Cancelled', 'neutral');

const Open = H.state('Open', 'pending');
const Resolved = H.terminal('Resolved', 'success');

export const Conversation = H.kind('Conversation')
  .attributes(ConversationSchema)
  .states(New, Sent, ClosedByCustomer, Escalated, Rejected, Cancelled)
  .key(conversation => conversation.ticketId)
  .initial(New)
  .onCancelled(Cancelled);

export const Escalation = H.kind('Escalation')
  .attributes(EscalationSchema)
  .states(Open, Resolved, Cancelled)
  .key(escalation => escalation.ticketId)
  .initial(Open)
  .onCancelled(Cancelled);

const customerReplied = H.signal('customerReplied').payload(z.object({ message: z.string() }));
const customerClosed = H.signal('customerClosed');
const escalate = H.signal('escalate');

const apiAccount = anthropic.account('support-api', { apiKey: H.env('ANTHROPIC_API_KEY') });
const haiku = anthropic.model('haiku', { id: 'claude-haiku-4-5' });
const sonnet = anthropic.model('sonnet', { id: 'claude-sonnet-4-5' });

const supportPool = H.pool('support').accounts(apiAccount).serves(haiku, sonnet);

const classifierRole = H.role('classifier')
  .intents('read')
  .instructions('Assign the conversation one category and summarise what the customer wants.');

export const drafterRole = H.role('drafter')
  .intents('read', 'search')
  .instructions('Draft the reply the support team would send. Follow the recalled tone and policies.');

const Category = z.enum(['billing', 'refund', 'shipping', 'account', 'other']);

const classifier = H.agent('classifier')
  .role(classifierRole)
  .model(haiku)
  .output(z.object({ category: Category, summary: z.string() }))
  .budgetTokens(8_000);

const drafter = H.agent('drafter')
  .role(drafterRole)
  .model(sonnet)
  .output(z.object({ reply: z.string() }))
  .budgetTokens(30_000);

const helpdeskToken = H.env('ZENDESK_TOKEN');

const sendReply = H.command('sendReply')
  .input(z.object({ ticketId: z.string(), reply: z.string() }))
  .argv(input => ['./bin/helpdesk-reply', '--ticket', input.ticketId, '--body', input.reply])
  .env({ HELPDESK_TOKEN: helpdeskToken })
  .runner(local.runner('local').slots(8));

export const approvalByCategory = H.metric('approvalByCategory', 'rate');
export const approvalByModel = H.metric('approvalByModel', 'rate');

const Approval = z.object({
  action: z.enum(['send', 'reject']),
  reply: z.string(),
  notes: z.string().optional(),
});

const conversationFlow = H.flow('conversation')
  .input(ConversationSchema)
  .step('classify', classifier, ctx => ({
    task: `Classify this customer message.\nSubject: ${ctx.unit.attributes.subject}\n\n${ctx.unit.attributes.message}`,
  }))
  .step('draft', drafter, ctx => ({
    task: `Draft a reply to ${ctx.unit.attributes.customerEmail} about "${ctx.unit.attributes.subject}".\nTheir request: ${ctx.steps.classify.summary}\n\nTheir message:\n${ctx.unit.attributes.message}`,
    skills: [ctx.steps.classify.category],
  }))
  .halt('approval', Approval, {
    ask: ctx => `Send this ${ctx.steps.classify.category} reply to ${ctx.unit.attributes.customerEmail}? Edit the reply if needed.\n\n${ctx.steps.draft.reply}`,
    skip: ctx => {
      const record = ctx.metrics.rate(approvalByCategory, { group: ctx.steps.classify.category });
      return record.samples >= 200 && record.hits === record.samples
        ? { action: 'send', reply: ctx.steps.draft.reply }
        : undefined;
    },
  })
  .exit('rejected', ctx => ctx.steps.approval.action === 'reject')
  .step('send', sendReply, ctx => ({ ticketId: ctx.unit.attributes.ticketId, reply: ctx.steps.approval.reply }), {
    afterCrash: 'park',
  })
  .exit('sent');

const escalationFlow = H.flow('escalation')
  .input(EscalationSchema)
  .halt('resolution', z.object({ resolution: z.string() }), {
    ask: ctx => `Take over ticket ${ctx.unit.attributes.ticketId} (${ctx.unit.attributes.reason}): ${ctx.unit.attributes.subject}`,
  })
  .exit('resolved');

const helpdesk = zendesk.store({ subdomain: 'acme', token: helpdeskToken });

export const conversations = H.lane('conversations', Conversation)
  .supply(
    [
      zendesk.webhook({ port: H.slot.port(0), path: '/helpdesk', secret: H.env('ZENDESK_WEBHOOK_SECRET') }),
      zendesk.poll({ subdomain: 'acme', token: helpdeskToken, everyMinutes: 10 }),
    ],
    (event, to) => {
      if (event.status === 'closed') return to.signal(customerClosed, event.ticketId, {});
      if (event.type === 'replied') return to.signal(customerReplied, event.ticketId, { message: event.message });
      if (event.type !== 'created') return to.skip();
      const slaHours = { low: 24, normal: 8, high: 4, urgent: 1 }[event.priority];
      return to.create({
        ticketId: event.ticketId,
        subject: event.subject,
        message: event.message,
        customerEmail: event.customerEmail,
        slaDueAt: new Date(event.createdAt.getTime() + slaHours * 3_600_000).toISOString(),
      });
    },
  )
  .store(helpdesk)
  .handler(conversationFlow, { exits: { rejected: Rejected, sent: Sent } })
  .on(customerReplied, { update: (attrs, reply) => ({ ...attrs, message: reply.message }), restart: 'classify' })
  .on(customerClosed, { enter: ClosedByCustomer })
  .on(escalate, { enter: Escalated })
  .ceiling({ maxUsd: 0.4, onExceed: 'halt' });

export const escalations = H.lane('escalations', Escalation)
  .supply(H.operator)
  .store(helpdesk)
  .handler(escalationFlow, { exits: { resolved: Resolved } });

const slaBreachEscalates = H.trigger('slaBreachEscalates', H.when.timer(conversations, {
  at: unit => new Date(unit.attributes.slaDueAt),
}))
  .create(escalations, event => ({
    ticketId: event.unit.attributes.ticketId,
    subject: event.unit.attributes.subject,
    reason: 'SLA breached',
  }))
  .signal(escalate, conversations, event => ({ key: event.unit.key, payload: {} }));

const rejectionEscalates = H.trigger('rejectionEscalates', H.when.transition(conversations, { to: Rejected }))
  .create(escalations, event => ({
    ticketId: event.unit.attributes.ticketId,
    subject: event.unit.attributes.subject,
    reason: 'Reply rejected by the reviewer',
  }));

const Taste = H.memory('taste').trust('taste');
const Experience = H.memory('experience')
  .body(z.object({ do: z.string(), when: z.string(), because: z.string() }))
  .trust('experience');

const mostSpecific = H.recall('mostSpecific', { by: 'specificity', limit: 10 });

export const taste = H.journal('supportTaste', Taste)
  .store(jsonl.memoryStore({ path: '.harness/taste.jsonl' }))
  .recall(mostSpecific)
  .readBy(drafterRole);

export const experience = H.journal('supportExperience', Experience)
  .store(jsonl.memoryStore({ path: '.harness/experience.jsonl' }))
  .recall(mostSpecific)
  .readBy(drafterRole);

const reviewerEditsBecomeTaste = H.trigger('reviewerEditsBecomeTaste', H.when.step(conversations, 'approval'))
  .record(taste, event =>
    event.output === undefined || event.decidedBy === undefined || event.output.reply === event.outputs.draft?.reply
      ? undefined
      : {
        body: {
          text: `Prefer phrasing like "${event.output.reply}" over "${event.outputs.draft?.reply ?? ''}"${event.output.notes === undefined ? '' : `, because ${event.output.notes}`}`,
        },
        when: { kinds: [Conversation], roles: [drafterRole] },
        status: 'candidate',
      });

export const approvalByCategoryFromReviews = approvalByCategory.from(H.when.step(conversations, 'approval'), event => [
  event.output === undefined || event.decidedBy === undefined
    ? undefined
    : { group: event.outputs.classify?.category ?? 'unclassified', hit: event.output.action === 'send' },
]);

export const approvalByModelFromReviews = approvalByModel.from(H.when.step(conversations, 'approval'), event => [
  event.output === undefined || event.decidedBy === undefined
    ? undefined
    : { group: event.models.draft ?? 'unknown', hit: event.output.action === 'send' },
]);

const scheduler = H.scheduler('timeToBreach')
  .priority(escalations, conversations)
  .rank(conversations, unit => new Date(unit.attributes.slaDueAt).getTime());

const supervisor = claudeCode.supervisor('reviewer', {
  grants: [
    H.ops.workRead,
    H.ops.workUpdate,
    H.ops.workSignal,
    H.ops.workCancel,
    H.ops.blockersResolve,
    H.ops.memoryRead,
    H.ops.memoryWrite,
    H.ops.memoryCurate,
    H.ops.telemetryRead,
  ],
});

export const supportTriage = H.harness('supportTriage')
  .ledger(sqlite.ledger({ path: '.harness/ledger.sqlite' }))
  .pools(supportPool)
  .lanes(conversations, escalations)
  .journals(taste, experience)
  .triggers(slaBreachEscalates, rejectionEscalates, reviewerEditsBecomeTaste)
  .metrics(approvalByCategoryFromReviews, approvalByModelFromReviews)
  .scheduler(scheduler)
  .clients(supervisor)
  .observers(markdown.board({ path: 'BOARD.md' }), markdown.telemetry({ path: 'TELEMETRY.md' }));
