import { z } from 'zod';
import { H, Metrics, MetricRef, Route, Router } from 'harness-dsl';
import { anthropic } from 'harness-dsl/anthropic';
import { claudeCode } from 'harness-dsl/claude-code';
import { jsonl } from 'harness-dsl/jsonl';
import { local } from 'harness-dsl/local';
import { markdown } from 'harness-dsl/markdown';
import { sqlite } from 'harness-dsl/sqlite';
import { zendesk, ZendeskEvent } from 'harness-dsl/zendesk';

const conversationSchema = z.object({
  ticketId: z.string(),
  subject: z.string(),
  message: z.string(),
  customerEmail: z.string(),
  slaDueAt: z.string(),
});
type ConversationAttrs = z.infer<typeof conversationSchema>;

const escalationSchema = z.object({
  ticketId: z.string(),
  subject: z.string(),
  reason: z.string(),
});

const New = H.state('New', 'pending');
const Classifying = H.state('Classifying', 'active');
const Drafting = H.state('Drafting', 'active');
const AwaitingApproval = H.state('AwaitingApproval', 'active');
const Sent = H.terminal('Sent', 'success');
const ClosedByCustomer = H.terminal('ClosedByCustomer', 'neutral');
const Escalated = H.terminal('Escalated', 'failure');
const SlaBreached = H.terminal('SlaBreached', 'failure');

const Open = H.state('Open', 'pending');
const Handling = H.state('Handling', 'active');
const Resolved = H.terminal('Resolved', 'success');

const Conversation = H.kind('Conversation')
  .attributes(conversationSchema)
  .states(New, Classifying, Drafting, AwaitingApproval, Sent, ClosedByCustomer, Escalated, SlaBreached)
  .key(attrs => attrs.ticketId)
  .initial(New);

const Escalation = H.kind('Escalation')
  .attributes(escalationSchema)
  .states(Open, Handling, Resolved)
  .key(attrs => attrs.ticketId)
  .initial(Open);

const customerReplied = H.signal('customer-replied').payload(z.object({ message: z.string() }));
const customerClosed = H.signal('customer-closed');
const slaBreached = H.signal('sla-breached');

const apiAccount = anthropic.account('anthropic-api', { apiKey: H.env('ANTHROPIC_API_KEY') });
const apiPool = H.pool('api').accounts(apiAccount);
const haiku = anthropic.model('haiku', { id: 'claude-haiku-4-5' });
const sonnet = anthropic.model('sonnet', { id: 'claude-sonnet-4-5' });

const classifierRole = H.role('classifier')
  .intents('read')
  .instructions('Classify the customer conversation into one support category.');

const drafterRole = H.role('drafter')
  .intents('read')
  .instructions('Draft a reply to the customer in the house tone.');

const classifier = H.agent('classifier')
  .role(classifierRole)
  .model(haiku)
  .pool(apiPool)
  .output(z.object({ category: z.string(), summary: z.string() }));

const drafter = H.agent('drafter')
  .role(drafterRole)
  .model(sonnet)
  .pool(apiPool)
  .output(z.object({ reply: z.string() }));

const sendReply = H.command('send-reply')
  .input(z.object({ ticketId: z.string(), reply: z.string() }))
  .argv(input => ['helpdesk', 'reply', input.ticketId, '--body', input.reply])
  .runner(local.runner('local'));

const approvalDecision = z.object({
  action: z.enum(['approve', 'revise', 'escalate']),
  reply: z.string().optional(),
  notes: z.string().optional(),
  auto: z.boolean().optional(),
});

const autoApproval: z.infer<typeof approvalDecision> = { action: 'approve', auto: true };

function isSafeCategory(metrics: Metrics, category: string): boolean {
  const record = metrics.rate(approvalByCategory, { group: category });
  return record.samples >= 200 && record.hits === record.samples;
}

const triageFlow = H.flow('triage')
  .input(conversationSchema)
  .step('classify', classifier, ctx => ({
    task: `Classify this conversation.\nSubject: ${ctx.unit.attributes.subject}\n\n${ctx.unit.attributes.message}`,
  }))
  .loop(
    'review',
    flow => flow
      .step('draft', drafter, ctx => ({
        task: `Draft a reply for a ${ctx.steps.classify.category} conversation.\nSummary: ${ctx.steps.classify.summary}\n\nCustomer wrote:\n${ctx.unit.attributes.message}`,
        skills: [ctx.steps.classify.category],
      }))
      .halt('approval', {
        ask: ctx => `Approve the reply to ticket ${ctx.unit.attributes.ticketId} (${ctx.steps.classify.category}):\n\n${ctx.steps.draft.reply}`,
        decision: approvalDecision,
        skip: ctx => isSafeCategory(ctx.metrics, ctx.steps.classify.category) ? autoApproval : undefined,
      }),
    { max: 3, until: ctx => ctx.steps.approval.action !== 'revise' },
  )
  .exit('escalated', ctx => ctx.steps.approval.action !== 'approve')
  .step('send', sendReply, ctx => ({
    ticketId: ctx.unit.attributes.ticketId,
    reply: ctx.steps.approval.reply ?? ctx.steps.draft.reply,
  }))
  .exit('sent');

const escalationFlow = H.flow('escalation')
  .input(escalationSchema)
  .halt('handle', {
    ask: ctx => `Escalated ticket ${ctx.unit.attributes.ticketId} "${ctx.unit.attributes.subject}": ${ctx.unit.attributes.reason}`,
    decision: z.object({ resolution: z.string() }),
  })
  .exit('resolved');

const slaHours: Record<ZendeskEvent['priority'], number> = { low: 72, normal: 24, high: 4, urgent: 1 };

function routeHelpdesk(event: ZendeskEvent, to: Router<ConversationAttrs, string>): Route {
  if (event.status === 'solved' || event.status === 'closed') {
    return to.signal(customerClosed, event.ticketId, {});
  }
  if (event.type === 'created') {
    return to.create({
      ticketId: event.ticketId,
      subject: event.subject,
      message: event.message,
      customerEmail: event.customerEmail,
      slaDueAt: new Date(event.createdAt.getTime() + slaHours[event.priority] * 3600000).toISOString(),
    });
  }
  if (event.type === 'replied') {
    return to.signal(customerReplied, event.ticketId, { message: event.message });
  }
  return to.skip();
}

const helpdeskToken = H.env('ZENDESK_TOKEN');

const conversations = H.lane('conversations', Conversation)
  .supply(zendesk.webhook({ port: H.slot.port(0), path: '/helpdesk', secret: H.env('ZENDESK_WEBHOOK_SECRET') }), routeHelpdesk)
  .supply(zendesk.poll({ subdomain: 'acme', token: helpdeskToken, everyMinutes: 10 }), routeHelpdesk)
  .store(zendesk.store({ subdomain: 'acme', token: helpdeskToken }))
  .handler(triageFlow, {
    exits: { escalated: Escalated, sent: Sent },
    during: { classify: Classifying, draft: Drafting, approval: AwaitingApproval },
  })
  .on(customerReplied, {
    update: (attrs, payload) => ({ ...attrs, message: payload.message }),
    restart: 'classify',
  })
  .on(customerClosed, { enter: ClosedByCustomer })
  .on(slaBreached, { enter: SlaBreached })
  .ceiling({ maxUsd: 0.4, onExceed: 'halt' });

const escalations = H.lane('escalations', Escalation)
  .handler(escalationFlow, { exits: { resolved: Resolved }, during: { handle: Handling } });

const approvalByCategory: MetricRef<'rate'> = H.metric('approval-by-category', H.when.step(conversations, 'approval'))
  .samples(event => event.output === undefined || event.output.auto
    ? []
    : [{ group: event.outputs.classify?.category ?? 'unclassified', hit: event.output.action === 'approve' }]);

const approvalByModel: MetricRef<'rate'> = H.metric('approval-by-model', H.when.step(conversations, 'approval'))
  .samples(event => event.output === undefined || event.output.auto
    ? []
    : [{ group: event.models.draft ?? 'unknown', hit: event.output.action === 'approve' }]);

const taste = H.journal('support-taste', H.memory('taste', 'taste'))
  .store(jsonl.memoryStore({ path: 'memory/taste.jsonl' }))
  .recall({ by: 'specificity', limit: 12 })
  .readBy(drafterRole);

const experience = H.journal('support-experience', H.memory('experience', 'experience'))
  .store(jsonl.memoryStore({ path: 'memory/experience.jsonl' }))
  .recall({ by: 'specificity', limit: 8 })
  .readBy(drafterRole);

const slaBreach = H.trigger('sla-breach')
  .on(H.when.timer(conversations, { at: unit => new Date(unit.attributes.slaDueAt) }))
  .create(escalations, event => ({
    ticketId: event.unit.attributes.ticketId,
    subject: event.unit.attributes.subject,
    reason: `SLA breached at ${event.at.toISOString()} while ${event.unit.state}`,
  }))
  .signal(slaBreached, conversations, event => ({ key: event.unit.key, payload: {} }));

const reviewerNotesBecomeTaste = H.trigger('reviewer-notes-become-taste')
  .on(H.when.step(conversations, 'approval', { if: event => event.output?.notes !== undefined }))
  .record(taste, event => event.output?.notes
    ? { text: event.output.notes, status: 'candidate', when: { roles: [drafterRole] } }
    : undefined);

const scheduler = H.scheduler('time-to-breach')
  .priority(escalations, conversations)
  .rank(conversations, unit => Date.parse(unit.attributes.slaDueAt));

const reviewer = claudeCode.supervisor('reviewer', {
  grants: [
    H.ops.workRead,
    H.ops.blockersResolve,
    H.ops.memoryRead,
    H.ops.memoryWrite,
    H.ops.memoryCurate,
    H.ops.telemetryRead,
  ],
});

export const harness = H.harness('support-triage')
  .ledger(sqlite.ledger({ path: '.harness/ledger.db' }))
  .lanes(conversations, escalations)
  .journals(taste, experience)
  .triggers(slaBreach, reviewerNotesBecomeTaste)
  .metrics(approvalByCategory, approvalByModel)
  .scheduler(scheduler)
  .clients(reviewer)
  .observers(markdown.board({ path: 'BOARD.md' }), markdown.telemetry({ path: 'TELEMETRY.md' }));

void harness.start();
