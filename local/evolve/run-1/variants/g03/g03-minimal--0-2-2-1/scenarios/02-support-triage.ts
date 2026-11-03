import { z } from 'zod';
import { H } from 'harness-dsl';
import type { PendingView } from 'harness-dsl';
import * as anthropic from 'harness-dsl/anthropic';
import * as claudeCode from 'harness-dsl/claude-code';
import * as http from 'harness-dsl/http';
import * as sqlite from 'harness-dsl/sqlite';
import * as jsonl from 'harness-dsl/jsonl';
import * as shell from 'harness-dsl/shell';
import * as markdown from 'harness-dsl/markdown';

const ConversationData = z.object({
  customer: z.string(),
  lastMessage: z.string(),
  slaDue: z.string(),
  category: z.string().optional(),
});

const HelpdeskConversation = z.object({
  id: z.string(),
  customer: z.string(),
  message: z.string(),
  slaDue: z.string(),
});

const HelpdeskEvent = z.object({
  type: z.enum(['created', 'replied', 'closed']),
  conversation: HelpdeskConversation,
});

const fresh = H.state('new', 'pending');
const classifying = H.state('classifying', 'active');
const drafting = H.state('drafting', 'active');
const awaitingApproval = H.state('awaiting-approval', 'active');
const sent = H.state('sent', 'terminal', 'success');
const closedByCustomer = H.state('closed-by-customer', 'terminal', 'neutral');
const escalated = H.state('escalated', 'terminal', 'failure');

const Conversation = H.kind('conversation')
  .data(ConversationData)
  .states(fresh, classifying, drafting, awaitingApproval, sent, closedByCustomer, escalated)
  .failsTo('escalated');

const escalationOpen = H.state('escalation-open', 'pending');
const escalationHandling = H.state('escalation-handling', 'active');
const escalationResolved = H.state('escalation-resolved', 'terminal', 'success');
const escalationDismissed = H.state('escalation-dismissed', 'terminal', 'neutral');

const Escalation = H.kind('escalation')
  .data(z.object({ conversation: z.string(), reason: z.string() }))
  .states(escalationOpen, escalationHandling, escalationResolved, escalationDismissed);

const classifyRole = H.role('classifier')
  .input(z.object({ message: z.string() }))
  .output(z.object({ category: z.string() }))
  .prompt((input) => `Classify this customer message into one support category.\n\n${input.message}`)
  .intents([]);

const draftRole = H.role('drafter')
  .input(z.object({ customer: z.string(), message: z.string(), category: z.string() }))
  .output(z.object({ reply: z.string() }))
  .prompt((input) => `Draft a reply to ${input.customer} about a ${input.category} request.\n\n${input.message}`)
  .intents([]);

const supportTaste = H.memory('support-taste', 'taste');
const supportExperience = H.memory('support-experience', 'experience');
const tasteJournal = H.library('support-taste-journal', supportTaste, jsonl.memory('.harness/support-taste.jsonl'));
const experienceJournal = H.library('support-experience-journal', supportExperience, jsonl.memory('.harness/support-experience.jsonl'));

const haiku = anthropic.model('claude-haiku-4-5');
const opus = anthropic.model('claude-opus-4-1');

const api = anthropic.account('anthropic-api', { apiKey: H.env('ANTHROPIC_API_KEY') });
const apiPool = H.pool('api', [{ account: api, share: 1 }]);

const classifier = H.agent('classifier', classifyRole).model(haiku);
const drafter = H.agent('drafter', draftRole).model(opus).recalls(tasteJournal, experienceJournal);

const local = shell.local('local', { slots: 4 });

const sendReply = H.command('send-reply')
  .input(z.object({ conversation: z.string(), reply: z.string() }))
  .argv((input) => ['helpdesk-cli', 'reply', input.conversation, '--body', input.reply, '--token', H.env('HELPDESK_TOKEN')])
  .on(local)
  .recovery('park');

const categoryTag = H.tag('category');

const replyApproval = H.halt('reply-approval', z.object({
  action: z.enum(['approve', 'edit', 'reject']),
  reply: z.string().optional(),
  lesson: z.string().optional(),
}));

const escalationHandled = H.halt('escalation-handled', z.object({
  outcome: z.enum(['resolved', 'dismissed']),
  note: z.string(),
}));

const safeToAutoSend = H.policy.rule('safe-to-auto-send', (category: string, metrics) => {
  const decided = replyApproval.resolved();
  const approvals = metrics.rateBy({ among: decided, count: replyApproval.resolved({ action: 'approve' }), by: categoryTag, days: 365 }).get(category);
  const rejections = metrics.rateBy({ among: decided, count: replyApproval.resolved({ action: 'reject' }), by: categoryTag, days: 365 }).get(category);
  const byModel = metrics.rateBy({ among: decided, count: replyApproval.resolved({ action: 'approve' }), by: { modelOf: drafter }, days: 30 }).get(opus);
  return approvals.hits >= 200 && rejections.hits === 0 && byModel.samples >= 50 && (byModel.value ?? 0) >= 0.9;
});

const replyToConversation = H.flow('reply-to-conversation')
  .for(Conversation)
  .does(async (ctx) => {
    await ctx.move('classifying');
    const classified = await ctx.run(classifier, { message: ctx.unit.data.lastMessage });
    if (!classified.ok) return ctx.fail(classified.error);
    const category = classified.value.category;
    ctx.tag(categoryTag, category);
    await ctx.update({ category });

    await ctx.move('drafting');
    const draft = await ctx.run(drafter, { customer: ctx.unit.data.customer, message: ctx.unit.data.lastMessage, category }, { scope: { skills: [category] } });
    if (!draft.ok) return ctx.fail(draft.error);

    let reply = draft.value.reply;
    if (!(await ctx.decide(safeToAutoSend, category))) {
      await ctx.move('awaiting-approval');
      const decision = await ctx.halt(replyApproval, reply);
      if (decision.lesson !== undefined) {
        await ctx.remember(tasteJournal, { text: decision.lesson, when: { kinds: [Conversation], roles: [draftRole], skills: [category] }, status: 'accepted' });
      }
      if (decision.action === 'reject') return 'escalated';
      if (decision.action === 'edit' && decision.reply !== undefined) reply = decision.reply;
    }

    const delivered = await ctx.run(sendReply, { conversation: ctx.unit.key, reply });
    return delivered.ok ? 'sent' : ctx.fail(delivered.error);
  });

const handleEscalation = H.flow('handle-escalation')
  .for(Escalation)
  .does(async (ctx) => {
    await ctx.move('escalation-handling');
    const handled = await ctx.halt(escalationHandled, `Conversation ${ctx.unit.data.conversation}: ${ctx.unit.data.reason}`);
    return handled.outcome === 'resolved' ? 'escalation-resolved' : 'escalation-dismissed';
  });

const helpdeskWebhook = http.webhook(Conversation, {
  path: '/helpdesk/events',
  secret: H.env('HELPDESK_WEBHOOK_SECRET'),
  body: HelpdeskEvent,
  read: (event) => {
    const conversation = event.conversation;
    if (event.type === 'created') {
      return { create: { customer: conversation.customer, lastMessage: conversation.message, slaDue: conversation.slaDue }, key: conversation.id };
    }
    if (event.type === 'replied') {
      return { update: conversation.id, patch: { lastMessage: conversation.message }, state: 'new' };
    }
    return { update: conversation.id, state: 'closed-by-customer' };
  },
});

const helpdeskPoll = http.poll(Conversation, {
  url: 'https://helpdesk.example.com/api/conversations?status=open',
  every: { minutes: 10 },
  headers: { authorization: H.env('HELPDESK_TOKEN') },
  body: z.object({ conversations: z.array(HelpdeskConversation) }),
  read: (page) => page.conversations.map((conversation) => ({
    create: { customer: conversation.customer, lastMessage: conversation.message, slaDue: conversation.slaDue },
    key: conversation.id,
  })),
});

const helpdeskStore = http.store(Conversation, {
  url: 'https://helpdesk.example.com/api/conversations',
  headers: { authorization: H.env('HELPDESK_TOKEN') },
  stateField: 'harness_state',
});

const conversationLane = H.lane('conversations', Conversation)
  .handler(replyToConversation)
  .suppliers(helpdeskWebhook, helpdeskPoll)
  .store(helpdeskStore)
  .maxUsdPerUnit(0.4);

const escalationLane = H.lane('escalations', Escalation).handler(handleEscalation);

const slaBreachEscalates = H.trigger('sla-breach-escalates',
  H.on.deadline(Conversation, (data) => new Date(data.slaDue), ['new', 'classifying', 'drafting', 'awaiting-approval']),
  (_event, act) => act.move('escalated'));

const escalatedOpensEscalation = H.trigger('escalated-opens-escalation', H.on.enters(Conversation, 'escalated'), (event, act) =>
  act.create(escalationLane, { conversation: event.unit.key, reason: `Escalated from ${event.unit.data.category ?? 'unclassified'} at ${event.at.toISOString()}` }, event.unit.key));

const timeToBreach = H.policy.scheduler('time-to-breach', ({ pending }) => {
  const due = (unit: PendingView): number => (unit.is(Conversation) ? new Date(unit.data.slaDue).getTime() : 0);
  return { start: [...pending].sort((a, b) => due(a) - due(b)) };
});

const supervisor = claudeCode.supervisor({
  grants: [H.ops.readWork, H.ops.writeWork, H.ops.resolveHalts, H.ops.readMemory, H.ops.writeMemory, H.ops.readTelemetry],
});

export const supportTriage = H.harness('support-triage')
  .ledger(sqlite.ledger('.harness/support.sqlite'))
  .lanes(conversationLane, escalationLane)
  .pools(apiPool)
  .triggers(slaBreachEscalates, escalatedOpensEscalation)
  .scheduler(timeToBreach)
  .clients(supervisor)
  .observers(markdown.board('BOARD.md'), markdown.telemetry('TELEMETRY.md'));

export const running = supportTriage.start();
