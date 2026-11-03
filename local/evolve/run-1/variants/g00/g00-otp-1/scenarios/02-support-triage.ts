import { z } from 'zod';
import { H, Candidate, Model, ModelChoice, PolicyEnv, SchedulingInput } from 'harness-dsl';
import * as zendesk from 'harness-dsl/zendesk';
import * as anthropic from 'harness-dsl/anthropic';
import * as claude from 'harness-dsl/claude-code';
import * as sqlite from 'harness-dsl/sqlite';
import * as jsonl from 'harness-dsl/jsonl';
import * as markdown from 'harness-dsl/markdown';

const New = H.state('new', 'pending');
const Classifying = H.state('classifying', 'active');
const Drafting = H.state('drafting', 'active');
const AwaitingApproval = H.state('awaiting-approval', 'active');
const Sent = H.state('sent', 'succeeded');
const ClosedByCustomer = H.state('closed-by-customer', 'concluded');
const Escalated = H.state('escalated', 'concluded');

const ConversationSchema = z.object({
  ticketId: z.number(),
  subject: z.string(),
  latestMessage: z.string(),
  requester: z.string(),
  slaDueAt: z.string(),
});
type ConversationData = z.infer<typeof ConversationSchema>;

const Conversation = H.work('Conversation', ConversationSchema)
  .states(New, Classifying, Drafting, AwaitingApproval, Sent, ClosedByCustomer, Escalated)
  .key(conversation => String(conversation.ticketId));

const EscalationOpen = H.state('open', 'pending');
const EscalationHandling = H.state('handling', 'active');
const EscalationResolved = H.state('resolved', 'succeeded');
const EscalationSchema = z.object({ ticketId: z.number(), reason: z.string() });
const Escalation = H.work('Escalation', EscalationSchema)
  .states(EscalationOpen, EscalationHandling, EscalationResolved)
  .key(escalation => `escalation-${escalation.ticketId}`);

const customerReplied = H.message('customer-replied', z.object({ text: z.string() }));
const customerClosed = H.message('customer-closed', z.object({}));

const slaHours: Readonly<Record<string, number>> = { urgent: 1, high: 4, normal: 24, low: 48 };
const toConversation = (ticket: zendesk.ZendeskTicket): ConversationData => ({
  ticketId: ticket.id,
  subject: ticket.subject,
  latestMessage: ticket.latestComment,
  requester: ticket.requesterEmail,
  slaDueAt: new Date(ticket.updatedAt.getTime() + (slaHours[ticket.priority] ?? 24) * 3600000).toISOString(),
});

const helpdeskToken = H.env('ZENDESK_TOKEN');

const webhook = zendesk.webhook<ConversationData>({
  secret: H.env('ZENDESK_WEBHOOK_SECRET'),
  port: H.slot.port(8443),
  route: event => {
    const key = String(event.ticket.id);
    if (event.type === 'ticket.created') return { create: toConversation(event.ticket) };
    if (event.byRequester && event.type === 'comment.added') {
      return H.deliver(customerReplied, key, { text: event.ticket.latestComment });
    }
    if (event.byRequester && event.ticket.status === 'closed') return H.deliver(customerClosed, key, {});
    return undefined;
  },
});
const missedTickets = zendesk.poll<ConversationData>({
  subdomain: 'acme',
  token: helpdeskToken,
  everyMinutes: 10,
  map: toConversation,
});
const helpdesk = zendesk.store<ConversationData>({
  subdomain: 'acme',
  token: helpdeskToken,
  map: toConversation,
  patch: (_conversation, state) => ({ status: state }),
});

const apiAccount = anthropic.apiKey('support-api', { key: H.env('ANTHROPIC_API_KEY') });
const apiPool = H.pool('support').accounts(apiAccount);
const haiku = anthropic.model('claude-haiku-4-5');
const sonnet = anthropic.model('claude-sonnet-4-5');
const opus = anthropic.model('claude-opus-4-1');

const approvals = H.metric('reply-approval', {
  count: { decision: 'approve', where: { approved: true } },
  of: { decision: 'approve' },
});

const drafterModel = H.policy('drafter-model', (_choice: ModelChoice, env: PolicyEnv): Model => {
  const cheaper = env.metrics.read(approvals, { model: sonnet, sinceDays: 30 });
  if (cheaper.samples < 50 || cheaper.rate === null) return sonnet;
  return cheaper.rate < 0.9 ? opus : sonnet;
});

const safeCategory = H.policy(
  'safe-category',
  (ctx: { readonly steps: { readonly classify: { readonly category: string } } }, env: PolicyEnv): boolean => {
    const record = env.metrics.read(approvals, { labels: { category: ctx.steps.classify.category } });
    return record.samples >= 200 && record.hits === record.samples;
  },
);

const tone = H.journal('reply-taste', H.memory.taste('reply-taste'))
  .store(jsonl.memory('.harness/reply-taste.jsonl'))
  .recall(H.policy.specificity({ limit: 15 }));
const supportExperience = H.journal('support-experience', H.memory.experience('support-experience'))
  .store(jsonl.memory('.harness/support-experience.jsonl'))
  .recall(H.policy.specificity({ limit: 10, trackRecord: true }));

const classifierRole = H.role('classifier').instructions('Classify the conversation into exactly one category.');
const drafterRole = H.role('drafter').instructions('Draft the next reply to the customer. Cite policy where it applies.');

const classifier = H.agent('classifier', classifierRole)
  .model(haiku)
  .pool(apiPool)
  .output(z.object({ category: z.enum(['billing', 'refund', 'shipping', 'technical', 'other']), summary: z.string() }));
const drafter = H.agent('drafter', drafterRole)
  .model(drafterModel)
  .pool(apiPool)
  .recall(tone, supportExperience)
  .output(z.object({ reply: z.string() }));

const sendReply = H.command('send-reply').run((input: { ticketId: number; body: string }) => [
  'helpdesk-reply',
  '--ticket',
  String(input.ticketId),
  '--body',
  input.body,
]);

const reply = H.flow<ConversationData>('reply')
  .exits('sent', 'rejected')
  .call('classify', classifier, ctx => `${ctx.unit.data.subject}\n\n${ctx.unit.data.latestMessage}`)
  .label(ctx => ({ category: ctx.steps.classify.category }))
  .call('draft', drafter, ctx =>
    `Category: ${ctx.steps.classify.category}\nSummary: ${ctx.steps.classify.summary}\n\nCustomer wrote:\n${ctx.unit.data.latestMessage}`,
  )
  .halt('approve', {
    ask: ctx => `Approve this reply to ${ctx.unit.data.requester}?\n\n${ctx.steps.draft.reply}`,
    decision: z.object({ approved: z.boolean(), editedReply: z.string().optional(), tasteNotes: z.array(z.string()) }),
    unless: { policy: safeCategory, assume: { approved: true, tasteNotes: [] } },
  })
  .record(tone, ctx =>
    ctx.steps.approve.tasteNotes.map(note => ({
      do: note,
      when: `drafting a ${ctx.steps.classify.category} reply`,
      because: 'the reviewer edited a draft this way',
    })),
  )
  .exitWhen(ctx => (ctx.steps.approve.approved ? undefined : 'rejected'))
  .call('send', sendReply, ctx => ({
    ticketId: ctx.unit.data.ticketId,
    body: ctx.steps.approve.editedReply ?? ctx.steps.draft.reply,
  }))
  .exit('sent');

const resolveByHand = H.flow<z.infer<typeof EscalationSchema>>('resolve-by-hand')
  .exits('resolved')
  .halt('resolve', {
    ask: ctx => `Ticket ${ctx.unit.data.ticketId} escalated: ${ctx.unit.data.reason}. Resolve it in the helpdesk, then record the outcome.`,
    decision: z.object({ resolution: z.string() }),
  })
  .exit('resolved');

const conversationLane = H.lane(Conversation)
  .supply(webhook, missedTickets)
  .store(helpdesk)
  .handler(reply)
  .exits({ sent: Sent, rejected: Escalated, crashed: Escalated })
  .phases({ classify: Classifying, draft: Drafting, approve: AwaitingApproval })
  .receive(customerReplied, (message, unit) =>
    unit.state === 'awaiting-approval'
      ? { cancel: true, to: Classifying, update: { latestMessage: message.text }, start: true }
      : unit.outcome === 'pending' || unit.outcome === 'active'
        ? { update: { latestMessage: message.text } }
        : undefined,
  )
  .receive(customerClosed, () => ({ cancel: true, to: ClosedByCustomer }))
  .deadline(unit => new Date(unit.data.slaDueAt))
  .costCeiling({ maxUsd: 0.4, onBreach: 'halt' });

const escalationLane = H.lane(Escalation)
  .handler(resolveByHand)
  .exits({ resolved: EscalationResolved, crashed: EscalationOpen })
  .phases({ resolve: EscalationHandling });

const slaBreachEscalates = H.trigger('sla-breach-escalates')
  .on(H.on.deadline(conversationLane, { while: [New, Classifying, Drafting, AwaitingApproval] }))
  .do(event => H.do.react(conversationLane, event.unit, { cancel: true, to: Escalated }));

const escalatedOpensEscalation = H.trigger('escalated-opens-escalation')
  .on(H.on.enter(Conversation, Escalated))
  .do(event => H.do.create(escalationLane, { ticketId: event.unit.data.ticketId, reason: `escalated from ${event.from}` }));

const deadlineOf = (candidate: Candidate): number => candidate.deadline?.getTime() ?? Number.MAX_SAFE_INTEGER;
const timeToBreach = H.policy('time-to-breach', (input: SchedulingInput, _env: PolicyEnv): readonly Candidate[] =>
  [...input.pending].sort((a, b) => deadlineOf(a) - deadlineOf(b)),
);

const reviewerGrant = H.grant(
  'reviewer',
  H.op.readWork,
  H.op.resolveBlocker,
  H.op.cancelWork,
  H.op.readMemory,
  H.op.writeMemory,
  H.op.readTelemetry,
);

export const supportTriage = H.harness('support-triage')
  .ledger(sqlite.ledger('.harness/ledger.db'))
  .lanes(conversationLane, escalationLane)
  .triggers(slaBreachEscalates, escalatedOpensEscalation)
  .scheduler(H.scheduler('support').order(timeToBreach))
  .clients(claude.supervisor({ grant: reviewerGrant }))
  .observe(markdown.board({ path: 'BOARD.md' }), markdown.telemetry({ path: 'TELEMETRY.md' }));

void supportTriage.start();
