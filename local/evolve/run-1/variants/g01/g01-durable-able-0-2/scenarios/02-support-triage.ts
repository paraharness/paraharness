import { z } from 'zod';
import { H, Router, Route } from 'harness-dsl';
import { sqlite } from 'harness-dsl/sqlite';
import { jsonl } from 'harness-dsl/jsonl';
import { anthropic } from 'harness-dsl/anthropic';
import { claudeCode } from 'harness-dsl/claude-code';
import { zendesk, ZendeskEvent } from 'harness-dsl/zendesk';
import { local } from 'harness-dsl/local';
import { markdown } from 'harness-dsl/markdown';

const ConversationSchema = z.object({
  ticketId: z.string(),
  subject: z.string(),
  message: z.string(),
  customerEmail: z.string(),
  slaDueAtMs: z.number(),
});
type ConversationAttrs = z.infer<typeof ConversationSchema>;

const EscalationSchema = z.object({
  ticketId: z.string(),
  reason: z.string(),
});

const New = H.state('New', 'pending');
const Classifying = H.state('Classifying', 'active');
const Drafting = H.state('Drafting', 'active');
const AwaitingApproval = H.state('AwaitingApproval', 'active');
const Sent = H.terminal('Sent', 'success');
const ClosedByCustomer = H.terminal('ClosedByCustomer', 'neutral');
const Escalated = H.terminal('Escalated', 'failure');
const Withdrawn = H.terminal('Withdrawn', 'neutral');

const Conversation = H.kind('Conversation')
  .attributes(ConversationSchema)
  .states(New, Classifying, Drafting, AwaitingApproval, Sent, ClosedByCustomer, Escalated, Withdrawn)
  .key(a => a.ticketId)
  .initial(New)
  .onAttemptFailed(Escalated)
  .onCancelled(Withdrawn);

const EscalationOpen = H.state('EscalationOpen', 'pending');
const WithHuman = H.state('WithHuman', 'active');
const EscalationResolved = H.terminal('EscalationResolved', 'success');

const Escalation = H.kind('Escalation')
  .attributes(EscalationSchema)
  .states(EscalationOpen, WithHuman, EscalationResolved)
  .key(a => a.ticketId)
  .initial(EscalationOpen);

const customerReplied = H.signal('customerReplied').payload(z.object({ message: z.string() }));
const closedByCustomer = H.signal('closedByCustomer');
const slaBreached = H.signal('slaBreached');

const apiAccount = anthropic.account('support-api', { apiKey: H.env('ANTHROPIC_API_KEY') });
const supportPool = H.pool('support').accounts(apiAccount);

const haiku = anthropic.model('haiku', { id: 'claude-haiku-4-5' });
const sonnet = anthropic.model('sonnet', { id: 'claude-sonnet-4-5' });

const classifierRole = H.role('classifier')
  .instructions('Classify the customer conversation into one support category.');

const drafterRole = H.role('drafter')
  .intents('search')
  .instructions('Draft the reply to the customer in the house tone.');

const classifier = H.agent('classifier')
  .role(classifierRole)
  .model(haiku)
  .output(z.object({ category: z.string() }));

const drafter = H.agent('drafter')
  .role(drafterRole)
  .model(sonnet)
  .output(z.object({ reply: z.string() }));

const Taste = H.memory('replyTaste').trust('taste');
const Experience = H.memory('supportExperience').trust('experience');
const bySpecificity = H.recall('bySpecificity', { by: 'specificity', limit: 10 });

const tasteJournal = H.journal('replyTaste', Taste)
  .store(jsonl.memoryStore({ path: '.harness/memory/taste.jsonl' }))
  .recall(bySpecificity)
  .readBy(drafterRole);

const experienceJournal = H.journal('supportExperience', Experience)
  .store(jsonl.memoryStore({ path: '.harness/memory/experience.jsonl' }))
  .recall(bySpecificity)
  .readBy(drafterRole);

const ApprovalDecision = z.object({
  action: z.enum(['approve', 'edit', 'reject', 'autoApprove']),
  reply: z.string(),
  notes: z.string().optional(),
});
type ApprovalDecisionValue = z.infer<typeof ApprovalDecision>;

const sendReply = H.command('sendHelpdeskReply')
  .input(z.object({ ticketId: z.string(), reply: z.string() }))
  .argv(i => ['helpdesk-reply', '--ticket', i.ticketId, '--body', i.reply])
  .env({ HELPDESK_TOKEN: H.env('ZENDESK_TOKEN') })
  .runner(local.runner('local'));

const conversationFlow = H.flow('triageConversation')
  .input(ConversationSchema)
  .step('classify', classifier, ctx => ({
    task: `Subject: ${ctx.unit.attributes.subject}\n\n${ctx.unit.attributes.message}`,
  }))
  .step('draft', drafter, ctx => ({
    task: `Reply to: ${ctx.unit.attributes.message}`,
    skills: [ctx.steps.classify.category],
  }))
  .halt('approval', {
    ask: ctx => `Approve this ${ctx.steps.classify.category} reply to ${ctx.unit.attributes.customerEmail}:\n\n${ctx.steps.draft.reply}`,
    decision: ApprovalDecision,
    skip: (ctx): ApprovalDecisionValue | undefined => {
      const record = ctx.metrics.rate(approvalRate, { group: `category:${ctx.steps.classify.category}` });
      return record.samples >= 200 && record.hits === record.samples
        ? { action: 'autoApprove', reply: ctx.steps.draft.reply }
        : undefined;
    },
  })
  .exit('rejected', ctx => ctx.steps.approval.action === 'reject')
  .step('send', sendReply, ctx => ({
    ticketId: ctx.unit.attributes.ticketId,
    reply: ctx.steps.approval.reply,
  }))
  .exit('sent');

const slaMs = (priority: ZendeskEvent['priority']): number =>
  priority === 'urgent' ? 3_600_000 : priority === 'high' ? 4 * 3_600_000 : 24 * 3_600_000;

const routeConversation = (event: ZendeskEvent, to: Router<ConversationAttrs, string>): Route => {
  if (event.status === 'solved' || event.status === 'closed') {
    return to.signal(closedByCustomer, event.ticketId, {});
  }
  if (event.type === 'replied') {
    return to.signal(customerReplied, event.ticketId, { message: event.message });
  }
  return to.create({
    ticketId: event.ticketId,
    subject: event.subject,
    message: event.message,
    customerEmail: event.customerEmail,
    slaDueAtMs: event.createdAt.getTime() + slaMs(event.priority),
  });
};

const conversations = H.lane('conversations', Conversation)
  .supply(zendesk.webhook({ port: H.slot.port(1), path: '/helpdesk', secret: H.env('ZENDESK_WEBHOOK_SECRET') }), routeConversation)
  .supply(zendesk.poll({ subdomain: 'acme', token: H.env('ZENDESK_TOKEN'), everyMinutes: 10 }), routeConversation)
  .store(zendesk.store({ subdomain: 'acme', token: H.env('ZENDESK_TOKEN') }))
  .handler(conversationFlow, {
    exits: { rejected: New, sent: Sent },
    during: { classify: Classifying, draft: Drafting, approval: AwaitingApproval },
  })
  .on(customerReplied, {
    update: (attrs, payload) => ({ ...attrs, message: payload.message }),
    restart: 'classify',
    enter: Classifying,
  })
  .on(closedByCustomer, { enter: ClosedByCustomer })
  .on(slaBreached, { enter: Escalated })
  .ceiling({ maxUsd: 0.4, onExceed: 'halt' });

const escalationFlow = H.flow('humanEscalation')
  .input(EscalationSchema)
  .halt('resolve', {
    ask: ctx => `Ticket ${ctx.unit.attributes.ticketId} escalated: ${ctx.unit.attributes.reason}. Resolve it with the customer.`,
    decision: z.object({ resolution: z.string() }),
  })
  .exit('resolved');

const escalations = H.lane('escalations', Escalation)
  .supply(H.operator)
  .handler(escalationFlow, {
    exits: { resolved: EscalationResolved },
    during: { resolve: WithHuman },
  });

const approvalRate = H.metric('approvalRate')
  .from(H.when.step(conversations, 'approval'))
  .samples(e => {
    const decision = e.output;
    const category = e.outputs.classify?.category;
    if (decision === undefined || decision.action === 'autoApprove' || category === undefined) {
      return [];
    }
    const hit = decision.action === 'approve';
    return [
      { group: `category:${category}`, hit },
      { group: `model:${e.models.draft ?? 'unknown'}`, hit },
    ];
  });

const slaBreachMarksEscalated = H.trigger('slaBreachMarksEscalated')
  .on(H.when.timer(conversations, { at: u => new Date(u.attributes.slaDueAtMs) }))
  .signal(slaBreached, conversations, e => ({ key: e.unit.key, payload: {} }));

const escalatedOpensEscalation = H.trigger('escalatedOpensEscalation')
  .on(H.when.transition(conversations, { to: Escalated }))
  .create(escalations, e => ({
    ticketId: e.unit.attributes.ticketId,
    reason: e.unit.attributes.slaDueAtMs <= e.at.getTime() ? 'SLA breached' : 'handling failed',
  }));

const reviewerEditsBecomeTaste = H.trigger('reviewerEditsBecomeTaste')
  .on(H.when.step(conversations, 'approval', { if: e => e.output?.action === 'edit' }))
  .record(tasteJournal, e => {
    const notes = e.output?.notes;
    const category = e.outputs.classify?.category;
    return notes === undefined || notes.length === 0
      ? undefined
      : {
          body: { text: notes },
          when: { roles: [drafterRole], skills: category === undefined ? [] : [category] },
          status: 'candidate',
        };
  });

const scheduler = H.scheduler('support')
  .priority(escalations, conversations)
  .rank(conversations, u => u.attributes.slaDueAtMs);

const supervisor = claudeCode.supervisor('reviewer', {
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

export const harness = H.harness('support-triage')
  .ledger(sqlite.ledger({ path: '.harness/ledger.sqlite' }))
  .pools(supportPool)
  .lanes(conversations, escalations)
  .journals(tasteJournal, experienceJournal)
  .metrics(approvalRate)
  .triggers(slaBreachMarksEscalated, escalatedOpensEscalation, reviewerEditsBecomeTaste)
  .scheduler(scheduler)
  .clients(supervisor)
  .observers(
    markdown.board({ path: '.harness/board.md' }),
    markdown.telemetry({ path: '.harness/telemetry.md' }),
  );

export const running = harness.start();
