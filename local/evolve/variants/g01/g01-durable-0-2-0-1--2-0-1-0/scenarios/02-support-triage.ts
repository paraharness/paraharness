import { z } from 'zod';
import { H, Router, Route } from 'harness-dsl';
import { zendesk, ZendeskEvent } from 'harness-dsl/zendesk';
import { anthropic } from 'harness-dsl/anthropic';
import { claudeCode } from 'harness-dsl/claude-code';
import { sqlite } from 'harness-dsl/sqlite';
import { jsonl } from 'harness-dsl/jsonl';
import { local } from 'harness-dsl/local';
import { markdown } from 'harness-dsl/markdown';

const workstation = local.runner('support-box').slots(8);

const conversationSchema = z.object({
  ticketId: z.string(),
  subject: z.string(),
  message: z.string(),
  customerEmail: z.string(),
  slaDueAt: z.string(),
});
type ConversationAttrs = z.infer<typeof conversationSchema>;

const slaHours = { low: 48, normal: 24, high: 8, urgent: 2 };

const customerReplied = H.signal('customer-replied').payload(z.object({ message: z.string() }));
const customerClosed = H.signal('customer-closed');
const slaBreached = H.signal('sla-breached');

function routeTicket<SN extends string, StepN extends string>(
  event: ZendeskEvent,
  to: Router<ConversationAttrs, SN, StepN>,
): Route {
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
    return to.signal(customerReplied, event.ticketId, { message: event.message });
  }
  return to.skip();
}

const quota = sqlite.quota('support-quota', { path: '.harness/quota.sqlite' });
const apiAccount = anthropic.account('support-api', { apiKey: H.env('ANTHROPIC_API_KEY'), quota });
const api = H.pool('support-api').accounts(apiAccount);
const haiku = anthropic.model('haiku', { id: 'claude-haiku-4-5' });
const sonnet = anthropic.model('sonnet', { id: 'claude-sonnet-4-5' });

const classifierRole = H.role('classifier')
  .intents('read')
  .instructions('Classify the customer message into exactly one category.');
const drafterRole = H.role('drafter')
  .intents('read', 'search')
  .instructions('Draft a reply to the customer in the house tone.');
const reviewerRole = H.role('reviewer').instructions('Approve, edit or reject outgoing replies.');

const taste = H.memory('support-taste', 'taste');
const experience = H.memory('support-experience', 'experience');

const tasteJournal = H.journal('support-taste', taste)
  .store(jsonl.memoryStore({ path: 'memory/taste.jsonl' }))
  .recall({ by: 'specificity', limit: 15 })
  .readBy(drafterRole)
  .recordedBy(reviewerRole);

const experienceJournal = H.journal('support-experience', experience)
  .store(jsonl.memoryStore({ path: 'memory/experience.jsonl' }))
  .recall({ by: 'specificity', limit: 10 })
  .readBy(drafterRole);

const classifier = H.seat('classifier')
  .role(classifierRole)
  .model(haiku)
  .pool(api)
  .output(z.object({ category: z.string() }));

const drafter = H.seat('drafter')
  .role(drafterRole)
  .model(sonnet)
  .pool(api)
  .output(z.object({ reply: z.string() }));

const replyApproval = H.halt('reply-approval').decision(
  z.object({ approved: z.boolean(), reply: z.string().optional() }),
);

const costCeiling = H.halt('conversation-cost-ceiling').decision(
  z.discriminatedUnion('action', [
    z.object({ action: z.literal('raise'), maxUsd: z.number() }),
    z.object({ action: z.literal('fail') }),
  ]),
);

const escalationHandled = H.halt('escalation-handled').decision(z.object({ resolution: z.string() }));

const category = H.facet('category');

const safeCategory = H.policy.halt(
  'safe-category',
  replyApproval,
  z.object({ category: z.string() }),
  ({ input, metrics }) => {
    const record = metrics.rate(approvalRate, { by: { facets: [category.of(input.category)] } });
    return record.samples >= 200 && record.hits === record.samples ? { approved: true } : undefined;
  },
);

const sendReply = H.command('send-reply')
  .input(z.object({ ticketId: z.string(), reply: z.string() }))
  .argv((input) => ['./bin/helpdesk-reply', input.ticketId, input.reply])
  .runner(workstation);

const triage = H.flow('triage')
  .input(conversationSchema)
  .step('classify', classifier, (ctx) => ({
    task: `Classify this support conversation.\nSubject: ${ctx.unit.attributes.subject}\n${ctx.unit.attributes.message}`,
  }))
  .loop(
    'revise',
    (revision) =>
      revision
        .step('draft', drafter, (ctx) => ({
          task: `Draft revision ${ctx.iteration + 1} of a reply in category ${ctx.steps.classify.category}.\nCustomer wrote: ${ctx.unit.attributes.message}`,
          skills: [ctx.steps.classify.category],
        }))
        .halt('approval', replyApproval, {
          ask: (ctx) => `Approve this reply to ${ctx.unit.attributes.customerEmail}:\n\n${ctx.steps.draft.reply}`,
          skip: { by: safeCategory, input: (ctx) => ({ category: ctx.steps.classify.category }) },
        }),
    { max: 3, until: (ctx) => ctx.steps.approval.approved },
  )
  .exit('unapproved', (ctx) => !ctx.steps.approval.approved)
  .step(
    'send',
    sendReply,
    (ctx) => ({
      ticketId: ctx.unit.attributes.ticketId,
      reply: ctx.steps.approval.reply ?? ctx.steps.draft.reply,
    }),
    { afterCrash: 'park' },
  )
  .exit('sent');

const New = H.state('New', 'pending');
const Classifying = H.state('Classifying', 'active');
const Drafting = H.state('Drafting', 'active');
const AwaitingApproval = H.state('AwaitingApproval', 'waiting');
const Sent = H.terminal('Sent', 'success');
const ClosedByCustomer = H.terminal('ClosedByCustomer', 'neutral');
const Escalated = H.terminal('Escalated', 'failure');

const Conversation = H.kind('Conversation')
  .attributes(conversationSchema)
  .states(New, Classifying, Drafting, AwaitingApproval, Sent, ClosedByCustomer, Escalated)
  .key((conversation) => conversation.ticketId)
  .initial(New);

const helpdesk = zendesk.store({ subdomain: 'acme', token: H.env('HELPDESK_TOKEN') });

const conversations = H.lane('conversations', Conversation)
  .supply(
    zendesk.webhook({ port: H.slot.port(1), path: '/helpdesk', secret: H.env('HELPDESK_WEBHOOK_SECRET') }),
    (event, to) => routeTicket(event, to),
  )
  .supply(
    zendesk.poll({ subdomain: 'acme', token: H.env('HELPDESK_TOKEN'), everyMinutes: 10 }),
    (event, to) => routeTicket(event, to),
  )
  .store(helpdesk)
  .handler(triage, {
    exits: { unapproved: Escalated, sent: Sent },
    during: { classify: Classifying, draft: Drafting, approval: AwaitingApproval },
  })
  .retry({ maxAttempts: 3, backoff: 'exponential', initialDelayMs: 30_000, exhausted: Escalated })
  .on(customerReplied, {
    update: (attrs, payload) => ({ ...attrs, message: payload.message }),
    restart: { to: 'classify', at: ['approval'] },
  })
  .on(customerClosed, { enter: ClosedByCustomer })
  .on(slaBreached, { enter: Escalated })
  .ceiling({ maxUsd: 0.4, onExceed: costCeiling });

const escalationSchema = z.object({ ticketId: z.string(), subject: z.string(), reason: z.string() });

const EscalationOpen = H.state('EscalationOpen', 'pending');
const WithSupportLead = H.state('WithSupportLead', 'waiting');
const EscalationResolved = H.terminal('EscalationResolved', 'success');
const EscalationAbandoned = H.terminal('EscalationAbandoned', 'failure');

const Escalation = H.kind('Escalation')
  .attributes(escalationSchema)
  .states(EscalationOpen, WithSupportLead, EscalationResolved, EscalationAbandoned)
  .key((escalation) => escalation.ticketId)
  .initial(EscalationOpen);

const escalationDesk = H.flow('escalation-desk')
  .input(escalationSchema)
  .halt('handle', escalationHandled, {
    ask: (ctx) => `Ticket ${ctx.unit.attributes.ticketId} ("${ctx.unit.attributes.subject}") escalated: ${ctx.unit.attributes.reason}`,
  })
  .exit('handled');

const escalations = H.lane('escalations', Escalation)
  .store(helpdesk)
  .handler(escalationDesk, { exits: { handled: EscalationResolved }, during: { handle: WithSupportLead } })
  .retry({ maxAttempts: 1, backoff: 'fixed', initialDelayMs: 0, exhausted: EscalationAbandoned });

const slaBreachEscalates = H.trigger('sla-breach-escalates')
  .on(
    H.when.timer(conversations, {
      at: (unit) => (unit.position === 'terminal' ? undefined : new Date(unit.attributes.slaDueAt)),
    }),
  )
  .create(escalations, (event) => ({
    ticketId: event.unit.attributes.ticketId,
    subject: event.unit.attributes.subject,
    reason: `SLA breached at ${event.at.toISOString()}`,
  }))
  .signal(slaBreached, conversations, (event) => ({ key: event.unit.key, payload: {} }));

const reviewerEditsBecomeTaste = H.trigger('reviewer-edits-become-taste')
  .on(H.when.decision(conversations, replyApproval))
  .record(tasteJournal, (event) => {
    const edited = event.decision.reply;
    const drafted = event.outputs.draft?.reply;
    const chosenCategory = event.outputs.classify?.category ?? 'general';
    return event.resolvedBy === 'human' && edited !== undefined && edited !== drafted
      ? {
          text: `When replying in ${chosenCategory}, phrase it like "${edited}" because the reviewer rewrote "${drafted ?? ''}" that way.`,
          status: 'candidate',
          when: { roles: [drafterRole], skills: [chosenCategory] },
        }
      : undefined;
  });

const approvalRate = H.metric('reply-approval-rate', H.when.decision(conversations, replyApproval))
  .facets(category)
  .samples((event) =>
    event.resolvedBy === 'human'
      ? [
          {
            hit: event.decision.approved,
            by: {
              seat: drafter,
              model: event.invocations.draft?.model,
              facets: [category.of(event.outputs.classify?.category ?? 'unclassified')],
            },
          },
        ]
      : [],
  );

const scheduler = H.scheduler('support')
  .priority(escalations, conversations)
  .rank(conversations, (unit) => Date.parse(unit.attributes.slaDueAt));

const reviewer = claudeCode.supervisor('reviewer').client('support-reviewer', {
  grants: [
    H.ops.workRead,
    H.ops.workUpdate,
    H.ops.resolve(replyApproval),
    H.ops.resolve(costCeiling),
    H.ops.resolve(escalationHandled),
    H.ops.memoryRead,
    H.ops.memoryWrite,
    H.ops.telemetryRead,
  ],
  port: H.slot.port(2),
});

export const harness = H.harness('support-triage')
  .ledger(sqlite.ledger({ path: '.harness/ledger.sqlite' }))
  .lanes(conversations, escalations)
  .journals(tasteJournal, experienceJournal)
  .triggers(slaBreachEscalates, reviewerEditsBecomeTaste)
  .metrics(approvalRate)
  .scheduler(scheduler)
  .clients(reviewer)
  .observers(markdown.board({ path: 'BOARD.md' }), markdown.telemetry({ path: 'TELEMETRY.md' }));

void harness.start();
