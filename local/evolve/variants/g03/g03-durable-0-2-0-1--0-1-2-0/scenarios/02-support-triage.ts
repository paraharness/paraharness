import { H, Route, Router } from 'harness-dsl';
import { z } from 'zod';
import { sqlite } from 'harness-dsl/sqlite';
import { jsonl } from 'harness-dsl/jsonl';
import { anthropic } from 'harness-dsl/anthropic';
import { claudeCode } from 'harness-dsl/claude-code';
import { zendesk, ZendeskEvent } from 'harness-dsl/zendesk';
import { markdown } from 'harness-dsl/markdown';

const categorySchema = z.enum(['billing', 'refund', 'technical', 'account', 'other']);
const category = H.facet('category', categorySchema.options);

const conversationSchema = z.object({
  ticketId: z.string(),
  subject: z.string(),
  message: z.string(),
  customerEmail: z.string(),
  slaDeadline: z.string(),
});
type ConversationAttributes = z.infer<typeof conversationSchema>;

const New = H.state('New', 'pending');
const Sent = H.terminal('Sent', 'success');
const ClosedByCustomer = H.terminal('ClosedByCustomer', 'neutral');
const Escalated = H.terminal('Escalated', 'failure');

const Conversation = H.kind('Conversation')
  .attributes(conversationSchema)
  .states(New, Sent, ClosedByCustomer, Escalated)
  .key(a => a.ticketId)
  .initial(New);

const EscalationOpen = H.state('EscalationOpen', 'pending');
const EscalationHandled = H.terminal('EscalationHandled', 'success');
const EscalationDropped = H.terminal('EscalationDropped', 'neutral');

const Escalation = H.kind('Escalation')
  .attributes(z.object({ ticketId: z.string(), subject: z.string(), reason: z.string() }))
  .states(EscalationOpen, EscalationHandled, EscalationDropped)
  .key(a => a.ticketId)
  .initial(EscalationOpen);

const customerReplied = H.signal('customer-replied').payload(z.object({ message: z.string() }));
const customerClosed = H.signal('customer-closed');
const slaBreached = H.signal('sla-breached');

const quota = sqlite.quota('support-quota', { path: './.harness/quota.sqlite' });
const api = anthropic.account('anthropic-api', { apiKey: H.env('ANTHROPIC_API_KEY'), quota });
const pool = H.pool('support').accounts(api);

const haiku = anthropic.model('haiku', { id: 'claude-haiku-4-5' });
const sonnet = anthropic.model('sonnet', { id: 'claude-sonnet-4-5' });

const classifier = H.role('classifier').intents('read').instructions('Assign exactly one category to the conversation.');
const drafter = H.role('drafter').intents('read').instructions('Draft the next reply to the customer.');
const reviewer = H.role('reviewer').intents('record').instructions('Approve or edit outgoing replies.');

const classifierSeat = H.seat('classifier').role(classifier).model(haiku).pool(pool);
const drafterSeat = H.seat('drafter').role(drafter).model(sonnet).pool(pool);

const classifyCall = H.call('classify', classifierSeat).output(z.object({ category: categorySchema }));
const draftCall = H.call('draft', drafterSeat).output(z.object({ reply: z.string() }));

const approval = H.halt('reply-approval').decision(
  z.object({ approve: z.boolean(), editedReply: z.string().optional(), notes: z.string().optional() }),
);
const costCeiling = H.halt('conversation-cost-ceiling').decision(H.ceilingDecision);
const escalationHandling = H.halt('escalation-handling').decision(z.object({ resolution: z.string() }));

const safeCategory = H.policy.halt('safe-category', Conversation, approval).decide(ctx => {
  const approvals = ctx.metrics.rate(approvalRate, { facets: ctx.facets });
  return approvals.hits >= 200 && approvals.hits === approvals.samples ? { approve: true } : undefined;
});

const helpdeskToken = H.env('ZENDESK_TOKEN');
const sendReply = H.command('send-reply')
  .input(z.object({ ticketId: z.string(), reply: z.string() }))
  .argv(i => ['helpdesk-reply', '--ticket', i.ticketId, '--body', i.reply]);

const conversationFlow = H.flow('conversation')
  .input(conversationSchema)
  .step('classify', classifyCall, ctx => ({
    text: `Classify this conversation.\nSubject: ${ctx.unit.attributes.subject}\n\n${ctx.unit.attributes.message}`,
  }))
  .loop(
    'drafts',
    { schema: z.array(z.string()), initial: [] },
    round =>
      round
        .step('draft', draftCall, ctx => ({
          text: `Reply to the customer about "${ctx.unit.attributes.subject}" (${ctx.steps.classify.category}).\n\n${ctx.unit.attributes.message}\n\nReviewer notes so far: ${ctx.steps.drafts.join('; ')}`,
        }))
        .halt('approval', approval, {
          ask: ctx => `Approve this reply to ticket ${ctx.unit.key}:\n\n${ctx.steps.draft.reply}`,
          skip: safeCategory,
          facets: ctx => [category.of(ctx.steps.classify.category)],
        }),
    {
      max: 3,
      until: ctx => ctx.steps.approval.approve,
      next: ctx => [...ctx.steps.drafts, ctx.steps.approval.notes ?? 'rejected without notes'],
    },
  )
  .exit('notApproved', ctx => !ctx.steps.approval.approve)
  .step(
    'send',
    sendReply,
    ctx => ({ ticketId: ctx.unit.attributes.ticketId, reply: ctx.steps.approval.editedReply ?? ctx.steps.draft.reply }),
    { afterCrash: 'park' },
  )
  .exit('sent');

const slaHours: Record<ZendeskEvent['priority'], number> = { urgent: 1, high: 4, normal: 24, low: 72 };

function routeTicket(event: ZendeskEvent, to: Router<ConversationAttributes>): Route {
  if (event.type === 'created') {
    return to.create({
      ticketId: event.ticketId,
      subject: event.subject,
      message: event.message,
      customerEmail: event.customerEmail,
      slaDeadline: new Date(event.createdAt.getTime() + slaHours[event.priority] * 3_600_000).toISOString(),
    });
  }
  if (event.status === 'closed' || event.status === 'solved') return to.signal(customerClosed, event.ticketId, {});
  if (event.type === 'replied') return to.signal(customerReplied, event.ticketId, { message: event.message });
  return to.skip();
}

const conversations = H.lane('conversations', Conversation)
  .supply(zendesk.webhook({ port: H.slot.port(0), path: '/zendesk', secret: H.env('ZENDESK_WEBHOOK_SECRET') }), routeTicket)
  .supply(zendesk.poll({ subdomain: 'acme', token: helpdeskToken, everyMinutes: 10 }), routeTicket)
  .handler(conversationFlow, { exits: { notApproved: Escalated, sent: Sent } })
  .store(zendesk.store({ subdomain: 'acme', token: helpdeskToken }))
  .retry({ maxAttempts: 2, backoff: 'exponential', initialDelayMs: 30_000, exhausted: Escalated })
  .ceiling({ maxUsd: 0.4, onExceed: costCeiling })
  .on(customerReplied, {
    update: (attributes, payload) => ({ ...attributes, message: payload.message }),
    restart: 'classify',
    at: ['approval'],
  })
  .on(customerClosed, { enter: ClosedByCustomer })
  .on(slaBreached, { enter: Escalated });

const escalationFlow = H.flow('escalation')
  .halt('handle', escalationHandling, {
    ask: ctx => `Ticket ${ctx.unit.key} breached its SLA. Handle it with the customer and record the resolution.`,
  })
  .exit('handled');

const escalations = H.lane('escalations', Escalation)
  .handler(escalationFlow, { exits: { handled: EscalationHandled } })
  .store(zendesk.store({ subdomain: 'acme', token: helpdeskToken }))
  .retry({ maxAttempts: 1, exhausted: EscalationDropped });

const approvalRate = H.metric('approval-rate', H.when.decision(Conversation, approval)).samples(e =>
  e.resolvedBy === 'human'
    ? [{ hit: e.decision.approve, facets: e.facets, seat: drafterSeat, model: e.modelOf(drafterSeat) }]
    : [],
);

const slaBreach = H.trigger('sla-breach-escalates')
  .on(
    H.when.timer(conversations, {
      at: unit => (unit.position === 'terminal' ? undefined : new Date(unit.attributes.slaDeadline)),
    }),
  )
  .create(escalations, e => ({
    ticketId: e.unit.attributes.ticketId,
    subject: e.unit.attributes.subject,
    reason: `SLA deadline ${e.unit.attributes.slaDeadline} passed`,
  }))
  .signal(slaBreached, conversations, e => ({ key: e.unit.key, payload: {} }));

const tasteKind = H.memory('support-taste', 'taste');
const experienceKind = H.memory('support-experience', 'experience');

const taste = H.journal('support-taste', tasteKind)
  .store(jsonl.memoryStore({ path: './memory/taste.jsonl' }))
  .recall({ by: 'specificity', limit: 10 })
  .readBy(drafter)
  .recordedBy(reviewer);

const experience = H.journal('support-experience', experienceKind)
  .store(jsonl.memoryStore({ path: './memory/experience.jsonl' }))
  .recall({ by: 'specificity', limit: 8 })
  .readBy(drafter);

const reviewerEdits = H.trigger('reviewer-notes-become-taste')
  .on(H.when.decision(Conversation, approval))
  .record(taste, e =>
    e.resolvedBy === 'human' && e.decision.notes !== undefined
      ? { text: e.decision.notes, status: 'candidate', when: { kinds: [Conversation], roles: [drafter] } }
      : undefined,
  );

const scheduler = H.scheduler('support')
  .fixedDate(conversations, unit => new Date(unit.attributes.slaDeadline))
  .standard(escalations);

const reviewerConsole = claudeCode.supervisor('reviewer-console', {
  grants: [
    H.ops.workRead,
    H.ops.workUpdate,
    H.ops.resolve(approval, costCeiling, escalationHandling),
    H.ops.memoryRead,
    H.ops.memoryWrite,
    H.ops.telemetryRead,
  ],
});

const support = H.harness('support-triage')
  .ledger(sqlite.ledger({ path: './.harness/ledger.sqlite' }))
  .lanes(conversations, escalations)
  .journals(taste, experience)
  .triggers(slaBreach, reviewerEdits)
  .metrics(approvalRate)
  .scheduler(scheduler)
  .clients(reviewerConsole)
  .observers(markdown.board({ path: './BOARD.md' }), markdown.telemetry({ path: './TELEMETRY.md' }));

void support.start();
