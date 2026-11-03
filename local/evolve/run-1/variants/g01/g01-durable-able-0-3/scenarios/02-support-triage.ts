import { z } from 'zod';
import { H, AnyMetric, Metrics, Route, Router } from 'harness-dsl';
import { sqlite } from 'harness-dsl/sqlite';
import { jsonl } from 'harness-dsl/jsonl';
import { anthropic } from 'harness-dsl/anthropic';
import { claudeCode } from 'harness-dsl/claude-code';
import { zendesk, ZendeskEvent } from 'harness-dsl/zendesk';
import { local } from 'harness-dsl/local';
import { markdown } from 'harness-dsl/markdown';

const New = H.state('New', 'pending');
const Classifying = H.state('Classifying', 'active');
const Drafting = H.state('Drafting', 'active');
const AwaitingApproval = H.state('AwaitingApproval', 'active');
const Sent = H.state('Sent', 'terminal', 'success');
const ClosedByCustomer = H.state('ClosedByCustomer', 'terminal', 'neutral');
const Escalated = H.state('Escalated', 'terminal', 'failure');

const conversationAttrs = z.object({
  ticketId: z.string(),
  subject: z.string(),
  message: z.string(),
  customerEmail: z.string(),
  slaDueAt: z.date(),
});

const Conversation = H.kind('Conversation')
  .attributes(conversationAttrs)
  .states(New, Classifying, Drafting, AwaitingApproval, Sent, ClosedByCustomer, Escalated)
  .key(a => a.ticketId);

type ConversationAttrs = z.infer<typeof conversationAttrs>;
type ConversationState = NonNullable<(typeof Conversation)['_types']>['states'];

const EscalationOpen = H.state('EscalationOpen', 'pending');
const EscalationHandling = H.state('EscalationHandling', 'active');
const EscalationResolved = H.state('EscalationResolved', 'terminal', 'success');

const escalationAttrs = z.object({ ticketId: z.string(), reason: z.string() });

const Escalation = H.kind('Escalation')
  .attributes(escalationAttrs)
  .states(EscalationOpen, EscalationHandling, EscalationResolved)
  .key(a => a.ticketId);

const customerReplied = H.signal('customerReplied').payload(z.object({ message: z.string() }));
const customerClosed = H.signal('customerClosed');
const slaBreached = H.signal('slaBreached');

const apiAccount = anthropic.account('support-api', { apiKey: H.env('ANTHROPIC_API_KEY') });
const haiku = anthropic.model('haiku', { id: 'claude-haiku-4-5' });
const sonnet = anthropic.model('sonnet', { id: 'claude-sonnet-4-5' });

const classifierRole = H.role('classifier').intents('read').instructions('Assign the conversation one category.');
const drafterRole = H.role('drafter').intents('read').instructions('Draft the reply to the customer.');

const classifier = H.agent('classifier')
  .role(classifierRole)
  .model(haiku)
  .output(z.object({ category: z.string(), confidence: z.number() }));

const drafter = H.agent('drafter')
  .role(drafterRole)
  .model(sonnet)
  .output(z.object({ reply: z.string() }));

const Taste = H.memory('replyTaste').body(z.object({ preference: z.string() })).trust('taste');
const Experience = H.memory('supportExperience')
  .body(z.object({ do: z.string(), when: z.string(), because: z.string() }))
  .trust('experience');

const taste = H.journal('replyTaste', Taste)
  .store(jsonl.memoryStore({ path: '.harness/memory/taste.jsonl' }))
  .recall(H.recall('broadTaste', { by: 'specificity', limit: 10 }))
  .readBy(drafterRole);

const experience = H.journal('supportExperience', Experience)
  .store(jsonl.memoryStore({ path: '.harness/memory/experience.jsonl' }))
  .recall(H.recall('specificExperience', { by: 'specificity', limit: 6 }))
  .readBy(drafterRole);

const approvalDecision = z.object({
  approved: z.boolean(),
  editedReply: z.string().optional(),
  note: z.string().optional(),
});

function categoryIsSafe(metrics: Metrics, category: string): boolean {
  const approvals = metrics.rate(approvalByCategory, { group: category });
  return approvals.samples >= 200 && approvals.successes === approvals.samples;
}

const sendReply = H.command('sendReply')
  .input(z.object({ ticketId: z.string(), reply: z.string() }))
  .argv(i => ['./bin/helpdesk-reply', i.ticketId, i.reply])
  .env({ HELPDESK_TOKEN: H.env('HELPDESK_TOKEN') })
  .runner(local.runner('local'));

const conversationFlow = H.flow('conversation')
  .input(conversationAttrs)
  .step('classify', classifier, ctx => ({ task: `Classify: ${ctx.unit.attributes.subject}\n${ctx.unit.attributes.message}` }))
  .loop('drafting', flow => flow
    .step('draft', drafter, ctx => ({
      task: `Reply to: ${ctx.unit.attributes.message}`,
      skills: [ctx.steps.classify.category],
    }))
    .halt('approval', {
      ask: ctx => `Approve this reply to ticket ${ctx.unit.attributes.ticketId}:\n\n${ctx.steps.draft.reply}`,
      decision: approvalDecision,
      skip: ctx => categoryIsSafe(ctx.metrics, ctx.steps.classify.category) ? { approved: true } : undefined,
    }),
  { max: 3, until: ctx => ctx.steps.approval.approved })
  .exit('unapproved', ctx => !ctx.steps.approval.approved)
  .step('send', sendReply, ctx => ({
    ticketId: ctx.unit.attributes.ticketId,
    reply: ctx.steps.approval.editedReply ?? ctx.steps.draft.reply,
  }))
  .exit('sent');

const slaHours = { low: 24, normal: 8, high: 4, urgent: 1 };

function routeHelpdesk(event: ZendeskEvent, to: Router<ConversationAttrs, ConversationState>): Route {
  switch (event.type) {
    case 'created':
      return to.create({
        ticketId: event.ticketId,
        subject: event.subject,
        message: event.message,
        customerEmail: event.customerEmail,
        slaDueAt: new Date(event.createdAt.getTime() + slaHours[event.priority] * 3600000),
      });
    case 'replied':
      return to.signal(customerReplied, event.ticketId, { message: event.message });
    case 'closed':
      return to.signal(customerClosed, event.ticketId, {});
    case 'updated':
      return to.skip();
  }
}

const helpdeskToken = H.env('ZENDESK_TOKEN');

const conversations = H.lane('conversations', Conversation)
  .supply(zendesk.webhook({ port: H.slot.port(1), path: '/helpdesk', secret: H.env('ZENDESK_WEBHOOK_SECRET') }), routeHelpdesk)
  .supply(zendesk.poll({ subdomain: 'acme', token: helpdeskToken, everyMinutes: 10 }), routeHelpdesk)
  .store(zendesk.store({ subdomain: 'acme', token: helpdeskToken }))
  .handler(conversationFlow, {
    during: { classify: Classifying, draft: Drafting, approval: AwaitingApproval },
    exits: { sent: Sent, unapproved: Escalated },
    failure: New,
  })
  .on(customerReplied, { update: (attrs, reply) => ({ ...attrs, message: reply.message }), restart: 'classify' })
  .on(customerClosed, { enter: ClosedByCustomer })
  .on(slaBreached, { enter: Escalated })
  .ceiling({ maxUsd: 0.4, onExceed: 'halt' });

const escalationFlow = H.flow('escalation')
  .input(escalationAttrs)
  .halt('handle', {
    ask: ctx => `Ticket ${ctx.unit.attributes.ticketId} escalated: ${ctx.unit.attributes.reason}`,
    decision: z.object({ resolution: z.string() }),
  })
  .exit('resolved');

const escalations = H.lane('escalations', Escalation)
  .handler(escalationFlow, {
    during: { handle: EscalationHandling },
    exits: { resolved: EscalationResolved },
    failure: EscalationOpen,
  });

const approvalByCategory: AnyMetric = H.metric('approvalByCategory')
  .from(H.when.step(conversations, 'approval'))
  .samples(e => {
    const classified = e.steps.classify;
    return classified === undefined || e.output === undefined
      ? []
      : [{ group: classified.category, success: e.output.approved }];
  });

const approvalByModel: AnyMetric = H.metric('approvalByModel')
  .from(H.when.step(conversations, 'approval'))
  .samples(e => e.output === undefined ? [] : [{ group: e.models.draft ?? 'unknown', success: e.output.approved }]);

const slaBreach = H.trigger('slaBreach')
  .on(H.when.timer(conversations, {
    at: unit => unit.attributes.slaDueAt,
    if: unit => unit.position !== 'terminal',
  }))
  .create(escalations, e => ({
    ticketId: e.unit.attributes.ticketId,
    reason: `SLA breached at ${e.at.toISOString()}`,
  }))
  .signal(slaBreached, e => ({ unit: e.unit, payload: {} }));

const tasteFromEdits = H.trigger('tasteFromReviewerEdits')
  .on(H.when.step(conversations, 'approval'))
  .record(taste, e => {
    const note = e.output?.note;
    return note === undefined
      ? undefined
      : { body: { preference: note }, when: { roles: [drafterRole] }, status: 'candidate' };
  });

const scheduler = H.scheduler('support')
  .priority(escalations, conversations)
  .rank(conversations, unit => unit.attributes.slaDueAt.getTime());

const reviewer = claudeCode.supervisor('reviewer', {
  grants: [
    H.ops.workRead,
    H.ops.workUpdate,
    H.ops.blockersResolve,
    H.ops.memoryRead,
    H.ops.memoryWrite,
    H.ops.memoryCurate,
    H.ops.telemetryRead,
  ],
});

export const supportTriage = H.harness('support-triage')
  .ledger(sqlite.ledger({ path: '.harness/ledger.sqlite' }))
  .pool(H.pool('support').accounts(apiAccount))
  .lanes(conversations, escalations)
  .journals(taste, experience)
  .metrics(approvalByCategory, approvalByModel)
  .triggers(slaBreach, tasteFromEdits)
  .scheduler(scheduler)
  .clients(reviewer)
  .observers(markdown.board({ path: '.harness/BOARD.md' }), markdown.telemetry({ path: '.harness/TELEMETRY.md' }));
