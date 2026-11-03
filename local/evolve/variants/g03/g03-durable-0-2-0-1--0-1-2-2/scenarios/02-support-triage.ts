import { z } from 'zod';
import { H, Router, Route } from 'harness-dsl';
import { anthropic } from 'harness-dsl/anthropic';
import { claudeCode } from 'harness-dsl/claude-code';
import { sqlite } from 'harness-dsl/sqlite';
import { jsonl } from 'harness-dsl/jsonl';
import { local } from 'harness-dsl/local';
import { markdown } from 'harness-dsl/markdown';
import { zendesk, ZendeskEvent } from 'harness-dsl/zendesk';

const categoryEnum = z.enum(['billing', 'refund', 'shipping', 'account', 'other']);
const category = H.resources('category', categoryEnum.options);

const conversationAttrs = z.object({
  ticketId: z.string(),
  subject: z.string(),
  message: z.string(),
  customerEmail: z.string(),
  slaDeadline: z.date(),
});
type ConversationAttrs = z.infer<typeof conversationAttrs>;

const New = H.state('New', 'pending');
const Sent = H.terminal('Sent', 'success');
const ClosedByCustomer = H.terminal('ClosedByCustomer', 'neutral');
const Escalated = H.terminal('Escalated', 'failure');

const Conversation = H.kind('Conversation')
  .attributes(conversationAttrs)
  .states(New, Sent, ClosedByCustomer, Escalated)
  .key(a => a.ticketId)
  .initial(New);

const escalationAttrs = z.object({ conversationKey: z.string(), subject: z.string(), reason: z.string() });
const EscalationOpen = H.state('EscalationOpen', 'pending');
const EscalationHandled = H.terminal('EscalationHandled', 'success');
const EscalationDropped = H.terminal('EscalationDropped', 'failure');
const Escalation = H.kind('Escalation')
  .attributes(escalationAttrs)
  .states(EscalationOpen, EscalationHandled, EscalationDropped)
  .key(a => a.conversationKey)
  .initial(EscalationOpen);

const customerReplied = H.signal('customer-replied').payload(z.object({ message: z.string() }));
const closedByCustomer = H.signal('closed-by-customer');
const slaBreached = H.signal('sla-breached');

const replyApproval = H.halt('reply-approval').decision(
  z.object({
    verdict: z.enum(['approve', 'reject']),
    editedReply: z.string().optional(),
    notes: z.string().optional(),
    tasteNote: z.string().optional(),
  }),
);
const costCeiling = H.halt('conversation-cost-ceiling').decision(H.ceilingDecision);
const escalationHandled = H.halt('escalation-handled').decision(z.object({ resolution: z.string() }));

const apiQuota = sqlite.quota('anthropic-api', { path: 'quota.sqlite' });
const apiAccount = anthropic.account('anthropic-api', { apiKey: H.env('ANTHROPIC_API_KEY'), quota: apiQuota });
const apiPool = H.pool('api').accounts(apiAccount);

const haiku = anthropic.model('haiku', { id: 'claude-haiku-4-5' });
const sonnet = anthropic.model('sonnet', { id: 'claude-sonnet-4-5' });

const classifierRole = H.role('classifier')
  .intents('read')
  .instructions('Classify the customer conversation into one category.')
  .output(z.object({ category: categoryEnum }));
const drafterRole = H.role('drafter')
  .intents('read', 'search')
  .instructions('Draft a reply to the customer that follows house tone and policy.')
  .output(z.object({ reply: z.string() }));
const reviewerRole = H.role('reviewer').intents('record').instructions('Approve, edit or reject outgoing replies.');

const classifier = H.seat('classifier').role(classifierRole).model(haiku).pool(apiPool);
const drafter = H.seat('drafter').role(drafterRole).model(sonnet).pool(apiPool);

const approvalRate = H.metric('approval-rate', H.when.decision(Conversation, replyApproval)).samples(e =>
  e.resolvedBy === 'human'
    ? [
        {
          hit: e.decision.verdict === 'approve',
          halt: e.halt,
          resources: e.resources,
          seat: drafter,
          model: e.seats.find(a => a.seat === drafter)?.model,
        },
      ]
    : [],
);

const safeSamplesRequired = 200;

const safeCategorySkipsApproval = H.policy.halt('safe-category-skips-approval', Conversation, replyApproval).decide(ctx => {
  const record = ctx.metrics.rate(approvalRate, { resources: ctx.resources });
  return record.samples >= safeSamplesRequired && record.hits === record.samples ? { verdict: 'approve' } : undefined;
});

const localRunner = local.runner('local');
const sendReply = H.command('send-reply')
  .input(z.object({ ticketId: z.string(), reply: z.string() }))
  .argv(i => ['./helpdesk/send-reply', '--ticket', i.ticketId, '--body', i.reply])
  .runner(localRunner);

const triage = H.flow('triage')
  .input(conversationAttrs)
  .step('classify', classifier, ctx => ({
    task: `Subject: ${ctx.unit.attributes.subject}\n\n${ctx.unit.attributes.message}`,
  }))
  .loop(
    'drafting',
    z.object({ notes: z.array(z.string()) }),
    round =>
      round
        .step('draft', drafter, ctx => ({
          task: [
            `Reply to ${ctx.unit.attributes.customerEmail} about "${ctx.unit.attributes.subject}".`,
            ctx.unit.attributes.message,
            ...(ctx.steps.drafting?.notes ?? []).map(n => `Reviewer note: ${n}`),
          ].join('\n\n'),
          resources: [category.of(ctx.steps.classify.category)],
        }))
        .halt('approval', replyApproval, {
          ask: ctx => ctx.steps.draft.reply,
          skip: safeCategorySkipsApproval,
          resources: ctx => [category.of(ctx.steps.classify.category)],
        }),
    {
      max: 3,
      until: ctx => ctx.steps.approval.verdict === 'approve',
      carry: ctx => ({
        notes: [
          ...(ctx.steps.drafting?.notes ?? []),
          ...(ctx.steps.approval.notes === undefined ? [] : [ctx.steps.approval.notes]),
        ],
      }),
    },
  )
  .exit('unapproved', ctx => ctx.steps.approval.verdict === 'reject')
  .step(
    'send',
    sendReply,
    ctx => ({ ticketId: ctx.unit.attributes.ticketId, reply: ctx.steps.approval.editedReply ?? ctx.steps.draft.reply }),
    { afterCrash: 'park' },
  )
  .exit('sent');

const slaHoursByPriority = { low: 48, normal: 24, high: 8, urgent: 2 };
const hourMs = 3_600_000;

const routeHelpdesk = (event: ZendeskEvent, to: Router<ConversationAttrs>): Route => {
  if (event.status === 'closed' || event.status === 'solved') return to.signal(closedByCustomer, event.ticketId, {});
  if (event.type === 'replied') return to.signal(customerReplied, event.ticketId, { message: event.message });
  if (event.type === 'created') {
    return to.create({
      ticketId: event.ticketId,
      subject: event.subject,
      message: event.message,
      customerEmail: event.customerEmail,
      slaDeadline: new Date(event.createdAt.getTime() + slaHoursByPriority[event.priority] * hourMs),
    });
  }
  return to.skip();
};

const subdomain = 'acme';
const helpdeskToken = H.env('ZENDESK_TOKEN');

const conversations = H.lane('conversations', Conversation)
  .supply(zendesk.webhook({ port: H.slot.port(1), path: '/helpdesk', secret: H.env('ZENDESK_WEBHOOK_SECRET') }), routeHelpdesk)
  .supply(zendesk.poll({ subdomain, token: helpdeskToken, everyMinutes: 10 }), routeHelpdesk)
  .handler(triage, { exits: { sent: Sent, unapproved: Escalated } })
  .store(zendesk.store({ subdomain, token: helpdeskToken }))
  .retry({ maxAttempts: 2, backoff: 'exponential', initialDelayMs: 30_000, exhausted: Escalated })
  .on(customerReplied, { update: (a, p) => ({ ...a, message: p.message }), enter: New, at: ['approval'] })
  .on(closedByCustomer, { enter: ClosedByCustomer })
  .on(slaBreached, { enter: Escalated })
  .ceiling({ maxUsd: 0.4, onExceed: costCeiling });

const handleEscalation = H.flow('handle-escalation')
  .input(escalationAttrs)
  .halt('humanResolution', escalationHandled, {
    ask: ctx => `Conversation ${ctx.unit.attributes.conversationKey} escalated (${ctx.unit.attributes.reason}): ${ctx.unit.attributes.subject}`,
  })
  .exit('handled');

const escalations = H.lane('escalations', Escalation)
  .handler(handleEscalation, { exits: { handled: EscalationHandled } })
  .retry({ maxAttempts: 1, exhausted: EscalationDropped });

const slaBreachEscalates = H.trigger('sla-breach-escalates')
  .on(H.when.timer(conversations, { at: u => u.attributes.slaDeadline }))
  .create(escalations, e => ({ conversationKey: e.unit.key, subject: e.unit.attributes.subject, reason: 'SLA breached' }))
  .signal(slaBreached, conversations, e => ({ key: e.unit.key, payload: {} }));

const taste = H.journal('support-taste', H.memory('taste', 'taste'))
  .store(jsonl.memoryStore({ path: 'memory/taste.jsonl' }))
  .recall({ by: 'specificity', limit: 10 })
  .readBy(drafterRole)
  .recordedBy(reviewerRole);

const experience = H.journal('support-experience', H.memory('experience', 'experience'))
  .store(jsonl.memoryStore({ path: 'memory/experience.jsonl' }))
  .recall({ by: 'specificity', limit: 10 })
  .readBy(drafterRole);

const reviewerEditsBecomeTaste = H.trigger('reviewer-edits-become-taste')
  .on(H.when.decision(Conversation, replyApproval))
  .record(taste, e =>
    e.decision.tasteNote === undefined
      ? undefined
      : { text: e.decision.tasteNote, status: 'candidate', when: { roles: [drafterRole], resources: e.resources } },
  );

const scheduler = H.scheduler('support')
  .expedite(escalations)
  .fixedDate(conversations, u => u.attributes.slaDeadline);

const reviewer = claudeCode.supervisor('reviewer', {
  grants: [
    H.ops.workRead,
    H.ops.workUpdate,
    H.ops.resolve(replyApproval, costCeiling, escalationHandled),
    H.ops.memoryRead,
    H.ops.memoryWrite,
    H.ops.telemetryRead,
  ],
});

export const harness = H.harness('support-triage')
  .ledger(sqlite.ledger({ path: 'support.sqlite' }))
  .lanes(conversations, escalations)
  .journals(taste, experience)
  .triggers(slaBreachEscalates, reviewerEditsBecomeTaste)
  .metrics(approvalRate)
  .scheduler(scheduler)
  .clients(reviewer)
  .observers(markdown.board({ path: 'BOARD.md' }), markdown.telemetry({ path: 'TELEMETRY.md' }));
