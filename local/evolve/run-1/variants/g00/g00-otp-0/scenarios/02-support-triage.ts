import { z } from 'zod';
import { H } from 'harness-dsl';
import type { PendingView } from 'harness-dsl';
import { sqlite } from 'harness-dsl/sqlite';
import { jsonl } from 'harness-dsl/jsonl';
import { anthropic } from 'harness-dsl/anthropic';
import { claudeCode } from 'harness-dsl/claude-code';
import { zendesk } from 'harness-dsl/zendesk';
import type { ZendeskTicket } from 'harness-dsl/zendesk';
import { shell } from 'harness-dsl/shell';
import { markdown } from 'harness-dsl/markdown';

const New = H.state('new', 'runnable');
const Classifying = H.state('classifying', 'runnable');
const Drafting = H.state('drafting', 'runnable');
const AwaitingApproval = H.state('awaiting-approval', 'runnable');
const Sent = H.state('sent', 'waiting');
const ClosedByCustomer = H.state('closed-by-customer', 'succeeded');
const Escalated = H.state('escalated', 'failed');
const Cancelled = H.state('cancelled', 'cancelled');
const Open = H.state('open', 'runnable');
const Handled = H.state('handled', 'succeeded');

const conversationData = z.object({
  ticketId: z.string(),
  subject: z.string(),
  customerEmail: z.string(),
  messages: z.array(z.string()),
  slaDueAt: z.string(),
  category: z.string().nullable(),
  draft: z.string().nullable(),
});
type ConversationData = z.infer<typeof conversationData>;

const openStates = [New, Classifying, Drafting, AwaitingApproval];

const Conversation = H.kind('Conversation', { data: conversationData, key: (conversation) => conversation.ticketId })
  .states([New, Classifying, Drafting, AwaitingApproval, Sent, ClosedByCustomer, Escalated, Cancelled], { initial: New })
  .messages({
    customerReplied: z.object({ message: z.string(), slaDueAt: z.string() }),
    closedByCustomer: z.object({}),
  })
  .timeout(openStates, H.time.deadline((conversation: ConversationData) => new Date(conversation.slaDueAt)), 'slaBreached')
  .on('customerReplied', {
    from: [Drafting, AwaitingApproval, Sent],
    to: Classifying,
    attempt: 'cancel',
    update: (conversation, reply) => ({
      ...conversation,
      messages: [...conversation.messages, reply.message],
      slaDueAt: reply.slaDueAt,
      draft: null,
    }),
  })
  .on('closedByCustomer', { from: [...openStates, Sent], to: ClosedByCustomer, attempt: 'cancel' })
  .on('slaBreached', { from: openStates, to: Escalated, attempt: 'cancel' })
  .on('cancel', { from: [...openStates, Sent], to: Cancelled, attempt: 'cancel' });

const Escalation = H.kind('Escalation', {
  data: z.object({ ticketId: z.string(), subject: z.string(), reason: z.string() }),
  key: (escalation) => escalation.ticketId,
})
  .states([Open, Handled, Cancelled], { initial: Open })
  .on('cancel', { from: [Open], to: Cancelled, attempt: 'cancel' });

const Taste = H.memory('taste', { authority: 'owner' });
const Experience = H.memory('experience', { authority: 'observed' });

const tasteJournal = H.journal('reply-taste', Taste)
  .store(jsonl.store('memory/taste.jsonl'))
  .recall(H.recall.bySpecificity({ limit: 15 }));
const experienceJournal = H.journal('support-experience', Experience)
  .store(jsonl.store('memory/experience.jsonl'))
  .recall(H.recall.bySpecificity({ limit: 10 }));

const apiAccount = anthropic.apiKey('support-api', { key: H.env('ANTHROPIC_API_KEY') });
const supportPool = H.pool('support').accounts([{ account: apiAccount, share: 1 }]);

const haiku = anthropic.model('claude-haiku-4-5');
const sonnet = anthropic.model('claude-sonnet-4-5');
const opus = anthropic.model('claude-opus-4-1');

const approval = z.object({
  approved: z.boolean(),
  editedReply: z.string().nullable(),
  notes: z.string().nullable(),
});

const approvalByCategory = H.metric('approval-by-category', {
  kind: Conversation,
  sample: (sample) => {
    const decision = sample.decision('approve', approval);
    return decision === null ? null : decision.approved;
  },
  group: (sample) => sample.unit.data.category ?? 'uncategorised',
});

const approvalByModel = H.metric('approval-by-model', {
  kind: Conversation,
  sample: (sample) => {
    const decision = sample.decision('approve', approval);
    return decision === null ? null : decision.approved;
  },
  group: (sample) => sample.invocations.find((invocation) => invocation.executable === 'drafter')?.model ?? 'unknown',
});

const drafterModel = H.choose('drafter-model', [sonnet, opus], (_query, context) => {
  const current = context.metrics.read(approvalByModel, { days: 30, group: sonnet.name });
  return current.samples >= 50 && current.value !== null && current.value < 0.7 ? opus : sonnet;
});

const safeCategory = H.policy('safe-category', (input: { category: string }, context) => {
  const rate = context.metrics.read(approvalByCategory, { days: 365, group: input.category });
  return rate.samples >= 200 && rate.value === 1;
});

const classifierRole = H.role('classifier', {
  prompt: 'Classify the customer conversation into one support category.',
  intents: [],
  input: z.object({ subject: z.string(), messages: z.array(z.string()) }),
  output: z.object({ category: z.string() }),
});

const drafterRole = H.role('drafter', {
  prompt: 'Draft the next reply to the customer in the house tone.',
  intents: [],
  input: z.object({ subject: z.string(), messages: z.array(z.string()), category: z.string() }),
  output: z.object({ reply: z.string() }),
});

const classifier = H.agent('classifier', classifierRole).model(haiku).pool(supportPool);
const drafter = H.agent('drafter', drafterRole).model(drafterModel).pool(supportPool).recall(tasteJournal, experienceJournal);

const sendReply = H.command('send-reply', {
  input: z.object({ ticketId: z.string(), reply: z.string() }),
  argv: (input) => ['helpdesk-reply', '--ticket', input.ticketId, '--body', input.reply],
  runner: shell.local({ slots: 4 }),
});

const classify = H.flow(
  'classify',
  {
    input: z.object({ subject: z.string(), messages: z.array(z.string()) }),
    writes: z.object({ category: z.string() }),
    exits: ['classified'],
  },
  async (ctx) => {
    const result = await ctx.run('classify', classifier, { subject: ctx.input.subject, messages: ctx.input.messages });
    return ctx.exit('classified', { category: result.category });
  },
);

const draftReply = H.flow(
  'draft-reply',
  {
    input: z.object({ subject: z.string(), messages: z.array(z.string()), category: z.string().nullable() }),
    writes: z.object({ draft: z.string() }),
    exits: ['drafted'],
  },
  async (ctx) => {
    const result = await ctx.run('draft', drafter, {
      subject: ctx.input.subject,
      messages: ctx.input.messages,
      category: ctx.input.category ?? 'uncategorised',
    });
    return ctx.exit('drafted', { draft: result.reply });
  },
);

const approveAndSend = H.flow(
  'approve-and-send',
  {
    input: z.object({ ticketId: z.string(), category: z.string().nullable(), draft: z.string().nullable() }),
    writes: z.object({ draft: z.string() }),
    exits: ['sent', 'rejected'],
  },
  async (ctx) => {
    const draft = ctx.input.draft ?? '';
    const safe = await ctx.decide('safe-category', safeCategory, { category: ctx.input.category ?? 'uncategorised' });
    let reply = draft;
    if (safe === false) {
      const review = await ctx.halt('approve', {
        question: `Send this reply on ticket ${ctx.input.ticketId}?`,
        report: draft,
        decision: approval,
      });
      if (review.approved === false) {
        return ctx.exit('rejected');
      }
      reply = review.editedReply ?? draft;
    }
    await ctx.run('send', sendReply, { ticketId: ctx.input.ticketId, reply });
    return ctx.exit('sent', { draft: reply });
  },
);

const handleEscalation = H.flow(
  'handle-escalation',
  { input: z.object({ ticketId: z.string(), subject: z.string(), reason: z.string() }), exits: ['handled'] },
  async (ctx) => {
    await ctx.halt('handle', {
      question: `Ticket ${ctx.input.ticketId} "${ctx.input.subject}" escalated: ${ctx.input.reason}. Record the resolution.`,
      decision: z.object({ resolution: z.string() }),
    });
    return ctx.exit('handled');
  },
);

const slaHours = { low: 48, normal: 24, high: 4, urgent: 1 };

const fromTicket = (ticket: ZendeskTicket): ConversationData => ({
  ticketId: ticket.id,
  subject: ticket.subject,
  customerEmail: ticket.requesterEmail,
  messages: [ticket.latestComment],
  slaDueAt: new Date(ticket.createdAt.getTime() + slaHours[ticket.priority] * 3_600_000).toISOString(),
  category: null,
  draft: null,
});

const helpdeskToken = H.env('ZENDESK_TOKEN');

const helpdeskEvents = zendesk
  .webhook({ port: H.slot.port(0), path: '/helpdesk', secret: H.env('ZENDESK_WEBHOOK_SECRET') })
  .to(Conversation, (event, unit) => {
    if (event.type === 'ticket.created') {
      return unit.create(fromTicket(event.ticket));
    }
    if (event.authorIsCustomer) {
      return unit.send(event.ticket.id, 'customerReplied', {
        message: event.ticket.latestComment,
        slaDueAt: new Date(Date.now() + slaHours[event.ticket.priority] * 3_600_000).toISOString(),
      });
    }
    return [];
  });

const helpdeskPoll = zendesk
  .tickets({ subdomain: 'acme', token: helpdeskToken, every: H.time.every({ minutes: 15 }) })
  .to(Conversation, (ticket, unit) => unit.create(fromTicket(ticket)));

const conversationLane = H.lane('conversations', Conversation)
  .supply(helpdeskEvents, helpdeskPoll)
  .store(zendesk.store({ subdomain: 'acme', token: helpdeskToken }))
  .handle(New, classify, { exits: { classified: Drafting } })
  .handle(Classifying, classify, { exits: { classified: Drafting } })
  .handle(Drafting, draftReply, { exits: { drafted: AwaitingApproval } })
  .handle(AwaitingApproval, approveAndSend, { exits: { sent: Sent, rejected: Drafting } })
  .limit({ wip: 20, queue: 500, maxUsdPerUnit: 0.4 });

const escalationLane = H.lane('escalations', Escalation).handle(Open, handleEscalation, { exits: { handled: Handled } });

const slaBreachEscalates = H.trigger('sla-breach-escalates')
  .on(H.when.event(Conversation, 'slaBreached'))
  .create(escalationLane, (breach) => ({
    ticketId: breach.unit.data.ticketId,
    subject: breach.unit.data.subject,
    reason: `SLA breached at ${breach.payload.at.toISOString()}`,
  }));

const reviewerNotesBecomeTaste = H.trigger('reviewer-notes-become-taste')
  .on(H.when.decided(Conversation, 'approve', approval))
  .where((decided) => decided.decision.notes !== null)
  .note(tasteJournal, (decided) => ({
    do: decided.decision.notes ?? '',
    condition: `when drafting replies in category ${decided.unit.data.category ?? 'uncategorised'}`,
    because: `reviewer ${decided.by} edited a draft this way`,
    when: { roles: [drafterRole] },
    status: 'candidate',
  }));

const timeToBreach = (unit: PendingView) =>
  unit.is(Escalation) ? 0 : unit.nextTimeoutAt === null ? Number.MAX_SAFE_INTEGER : unit.nextTimeoutAt.getTime();

const scheduler = H.scheduler('time-to-breach', (query) => ({
  order: [...query.pending].sort((a, b) => timeToBreach(a) - timeToBreach(b)),
}));

const supervisor = H.client('supervisor', claudeCode.session()).grant([
  H.ops.readWork,
  H.ops.writeWork,
  H.ops.resolveBlockers,
  H.ops.readMemory,
  H.ops.writeMemory,
  H.ops.curateMemory,
  H.ops.readTelemetry,
]);

export const harness = H.harness('support-triage')
  .ledger(sqlite.ledger('support-ledger.db'))
  .lanes([conversationLane, escalationLane])
  .journals([tasteJournal, experienceJournal])
  .triggers([slaBreachEscalates, reviewerNotesBecomeTaste])
  .scheduler(scheduler)
  .clients([supervisor])
  .observers([markdown.board('BOARD.md'), markdown.telemetry('TELEMETRY.md')]);
