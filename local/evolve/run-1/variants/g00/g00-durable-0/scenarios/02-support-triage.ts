import { z } from 'zod';
import { H, Metrics, Route, Router } from 'harness-dsl';
import { anthropic } from 'harness-dsl/anthropic';
import { claudeCode } from 'harness-dsl/claude-code';
import { zendesk, ZendeskEvent } from 'harness-dsl/zendesk';
import { webhook } from 'harness-dsl/webhook';
import { local } from 'harness-dsl/local';
import { sqlite } from 'harness-dsl/sqlite';
import { jsonl } from 'harness-dsl/jsonl';
import { markdown } from 'harness-dsl/markdown';

const conversation = z.object({
  ticketId: z.string(),
  subject: z.string(),
  message: z.string(),
  customerEmail: z.string(),
  slaDueAtMs: z.number(),
});
type ConversationAttrs = z.infer<typeof conversation>;

const New = H.state('New', 'pending');
const Classifying = H.state('Classifying', 'active');
const Drafting = H.state('Drafting', 'active');
const AwaitingApproval = H.state('AwaitingApproval', 'active');
const Sent = H.state('Sent', 'succeeded');
const ClosedByCustomer = H.state('ClosedByCustomer', 'ended');
const Escalated = H.state('Escalated', 'ended');
const Failed = H.state('Failed', 'failed');
const Cancelled = H.state('Cancelled', 'cancelled');
const Open = H.state('Open', 'pending');
const Handling = H.state('Handling', 'active');
const Resolved = H.state('Resolved', 'succeeded');

const Conversation = H.kind('Conversation')
  .attributes(conversation)
  .states(New, Classifying, Drafting, AwaitingApproval, Sent, ClosedByCustomer, Escalated, Failed, Cancelled)
  .key(a => a.ticketId);

const Escalation = H.kind('Escalation')
  .attributes(z.object({ ticketId: z.string(), reason: z.string() }))
  .states(Open, Handling, Resolved, Failed, Cancelled)
  .key(a => `escalation:${a.ticketId}`);

const customerReplied = H.signal('customer-replied').payload(z.object({ message: z.string() }));
const customerClosed = H.signal('customer-closed');
const slaBreached = H.signal('sla-breached');

const apiAccount = anthropic.account('anthropic-api', { apiKey: H.env('ANTHROPIC_API_KEY') });
const pool = H.pool('api-pool').accounts(apiAccount);
const haiku = anthropic.model('haiku', { id: 'claude-haiku-4-5', pool });
const sonnet = anthropic.model('sonnet', { id: 'claude-sonnet-4-5', pool });

const classifierRole = H.role('classifier').instructions('Assign one support category to the conversation.');
const drafterRole = H.role('drafter').intents('search').instructions('Draft a reply in the house tone.');
const reviewerRole = H.role('reviewer').instructions('Approve, edit or reject outgoing replies.');

const classifyAgent = H.agent('classify-agent')
  .role(classifierRole)
  .model(haiku)
  .budgetTokens(4000)
  .output(z.object({ category: z.string() }));

const draftAgent = H.agent('draft-agent')
  .role(drafterRole)
  .model(sonnet)
  .budgetTokens(20000)
  .output(z.object({ reply: z.string() }));

const sendReply = H.command('send-reply')
  .input(z.object({ ticketId: z.string(), reply: z.string() }))
  .argv(i => ['./bin/helpdesk-reply', i.ticketId, i.reply])
  .env({ HELPDESK_TOKEN: H.env('HELPDESK_TOKEN') })
  .runner(local.runner('local'));

const approvalDecision = z.object({
  approved: z.boolean(),
  category: z.string(),
  reply: z.string(),
  notes: z.string(),
  auto: z.boolean(),
});

function isSafeCategory(category: string, metrics: Metrics): boolean {
  const record = metrics.rate(approvals, { group: `category:${category}` });
  return record.samples >= 200 && record.successes === record.samples;
}

const triageFlow = H.flow('triage')
  .input(conversation)
  .step('classify', classifyAgent, ctx => ({
    task: `Classify:\n${ctx.unit.attributes.subject}\n\n${ctx.unit.attributes.message}`,
  }))
  .loop(
    'review',
    f => f
      .step('draft', draftAgent, ctx => ({
        task: `Reply to ${ctx.unit.attributes.customerEmail}:\n\n${ctx.unit.attributes.message}`,
        skills: [ctx.steps.classify.category],
      }))
      .halt('approval', {
        ask: ctx => `Approve the reply to ${ctx.unit.attributes.customerEmail} (${ctx.steps.classify.category}):\n\n${ctx.steps.draft.reply}`,
        decision: approvalDecision,
        skip: ctx =>
          isSafeCategory(ctx.steps.classify.category, ctx.metrics)
            ? { approved: true, category: ctx.steps.classify.category, reply: ctx.steps.draft.reply, notes: '', auto: true }
            : undefined,
      }),
    { max: 3, until: ctx => ctx.steps.approval.approved },
  )
  .exit('unapproved', ctx => !ctx.steps.approval.approved)
  .step('send', sendReply, ctx => ({ ticketId: ctx.unit.attributes.ticketId, reply: ctx.steps.approval.reply }), {
    retry: H.retry({ maxAttempts: 3, backoff: 'exponential', initialDelayMs: 5000 }),
  })
  .exit('sent');

const slaHours = { low: 48, normal: 24, high: 8, urgent: 2 };

const routeHelpdesk = (event: ZendeskEvent, to: Router<ConversationAttrs>): Route => {
  if (event.type === 'created') {
    return to.create({
      ticketId: event.ticketId,
      subject: event.subject,
      message: event.message,
      customerEmail: event.customerEmail,
      slaDueAtMs: event.createdAt.getTime() + slaHours[event.priority] * 3600000,
    });
  }
  if (event.type === 'replied') {
    return to.signal(customerReplied, event.ticketId, { message: event.message });
  }
  return to.skip();
};

const helpdeskStatus = webhook.json('helpdesk-status', {
  port: H.slot.port(1),
  path: '/helpdesk/status',
  secret: H.env('HELPDESK_STATUS_SECRET'),
  payload: z.object({ ticketId: z.string(), status: z.enum(['closed', 'reopened']) }),
});

const conversationLane = H.lane('conversations', Conversation)
  .supply(zendesk.webhook({ port: H.slot.port(0), path: '/helpdesk/events', secret: H.env('ZENDESK_WEBHOOK_SECRET') }), routeHelpdesk)
  .supply(zendesk.poll({ subdomain: 'acme', token: H.env('ZENDESK_TOKEN'), everyMinutes: 10 }), routeHelpdesk)
  .supply(helpdeskStatus, (event, to) =>
    event.status === 'closed' ? to.signal(customerClosed, event.ticketId, {}) : to.skip(),
  )
  .store(zendesk.store({ subdomain: 'acme', token: H.env('ZENDESK_TOKEN') }))
  .handler(triageFlow, {
    exits: { unapproved: Escalated, sent: Sent },
    during: { classify: Classifying, draft: Drafting, approval: AwaitingApproval },
    failure: Failed,
  })
  .on(customerReplied, {
    update: (attrs, payload) => ({ ...attrs, message: payload.message }),
    restart: 'classify',
  })
  .on(customerClosed, { enter: ClosedByCustomer })
  .on(slaBreached, { enter: Escalated })
  .ceiling({ maxUsd: 0.4, onExceed: 'halt' });

const escalationFlow = H.flow('escalation')
  .input(z.object({ ticketId: z.string(), reason: z.string() }))
  .halt('handle', {
    ask: ctx => `Ticket ${ctx.unit.attributes.ticketId} escalated: ${ctx.unit.attributes.reason}`,
    decision: z.object({ resolution: z.string() }),
  })
  .exit('resolved');

const escalationLane = H.lane('escalations', Escalation)
  .handler(escalationFlow, {
    exits: { resolved: Resolved },
    during: { handle: Handling },
    failure: Failed,
  });

const approvals = H.metric('approvals')
  .from(H.when.step(conversationLane, 'approval'))
  .samples(e =>
    e.output === undefined || e.output.auto
      ? []
      : [
          { group: `category:${e.output.category}`, success: e.output.approved },
          { group: `model:${e.models['draft']}`, success: e.output.approved },
        ],
  );

const breachEscalates = H.trigger('sla-breach-escalates')
  .on(H.when.timer(conversationLane, {
    at: unit => new Date(unit.attributes.slaDueAtMs),
    if: unit => unit.outcome === 'pending' || unit.outcome === 'active',
  }))
  .create(escalationLane, e => ({ ticketId: e.unit.attributes.ticketId, reason: 'SLA breached' }))
  .signal(slaBreached, () => ({}));

const experience = H.memory('experience').trust('experience');
const taste = H.memory('taste').trust('taste');
const mostSpecific = H.recall('most-specific', { by: 'specificity', limit: 6 });

const tasteJournal = H.journal('support-taste', taste)
  .store(jsonl.memoryStore({ path: '.harness/taste.jsonl' }))
  .recall(mostSpecific)
  .readBy(drafterRole)
  .writtenBy(reviewerRole);

const experienceJournal = H.journal('support-experience', experience)
  .store(jsonl.memoryStore({ path: '.harness/experience.jsonl' }))
  .recall(mostSpecific)
  .readBy(drafterRole);

const editsBecomeTaste = H.trigger('reviewer-edits-become-taste')
  .on(H.when.step(conversationLane, 'approval', {
    if: e => e.output !== undefined && !e.output.auto && e.output.notes.length > 0,
  }))
  .record(tasteJournal, e =>
    e.output === undefined
      ? undefined
      : { body: { text: e.output.notes }, when: { kinds: [Conversation], roles: [drafterRole] }, status: 'candidate' },
  );

const scheduler = H.scheduler('time-to-breach')
  .priority(escalationLane, conversationLane)
  .rank(conversationLane, unit => unit.attributes.slaDueAtMs);

const supervisor = claudeCode.supervisor('supervisor', {
  grants: [
    H.ops.workRead,
    H.ops.workCancel,
    H.ops.blockersResolve,
    H.ops.memoryRead,
    H.ops.memoryWrite,
    H.ops.telemetryRead,
  ],
});

export const supportTriage = H.harness('support-triage')
  .ledger(sqlite.ledger({ path: '.harness/ledger.db' }))
  .lanes(conversationLane, escalationLane)
  .journals(tasteJournal, experienceJournal)
  .triggers(breachEscalates, editsBecomeTaste)
  .metrics(approvals)
  .scheduler(scheduler)
  .clients(supervisor)
  .observers(markdown.board({ path: 'BOARD.md' }), markdown.telemetry({ path: 'TELEMETRY.md' }));

export const running = supportTriage.start();
