import { z } from 'zod';
import { H } from 'harness-dsl';
import type { PendingView, Rate, Supply, StateOf } from 'harness-dsl';
import * as claudeCode from 'harness-dsl/claude-code';
import * as anthropic from 'harness-dsl/anthropic';
import * as sqlite from 'harness-dsl/sqlite';
import * as jsonl from 'harness-dsl/jsonl';
import * as shell from 'harness-dsl/shell';
import * as http from 'harness-dsl/http';
import * as markdown from 'harness-dsl/markdown';

const New = H.state('new', 'pending');
const Classifying = H.state('classifying', 'active');
const Drafting = H.state('drafting', 'active');
const AwaitingApproval = H.state('awaiting-approval', 'active');
const Sent = H.state('sent', 'terminal', 'success');
const ClosedByCustomer = H.state('closed-by-customer', 'terminal', 'neutral');
const Escalated = H.state('escalated', 'terminal', 'failure');

const conversationData = z.object({
  conversationId: z.string(),
  customer: z.string(),
  subject: z.string(),
  lastMessage: z.string(),
  category: z.string().optional(),
  slaDueAt: z.coerce.date(),
});
type ConversationData = z.infer<typeof conversationData>;

const Conversation = H.kind('Conversation')
  .data(conversationData)
  .states([New, Classifying, Drafting, AwaitingApproval, Sent, ClosedByCustomer, Escalated], {
    initial: 'new',
    afterFailure: 'escalated',
    afterCancel: 'new',
  });
type ConversationState = StateOf<typeof Conversation>;

const Open = H.state('open', 'pending');
const Handling = H.state('handling', 'active');
const Handled = H.state('handled', 'terminal', 'success');
const Unhandled = H.state('unhandled', 'terminal', 'failure');
const Withdrawn = H.state('withdrawn', 'terminal', 'neutral');

const Escalation = H.kind('Escalation')
  .data(z.object({ conversationId: z.string(), subject: z.string(), reason: z.string() }))
  .states([Open, Handling, Handled, Unhandled, Withdrawn], {
    initial: 'open',
    afterFailure: 'unhandled',
    afterCancel: 'withdrawn',
  });

const classifierRole = H.role('classifier')
  .input(z.object({ subject: z.string(), message: z.string() }))
  .output(z.object({ category: z.string(), summary: z.string() }))
  .prompt(input => `Classify this customer conversation into one support category.\n\nSubject: ${input.subject}\n\n${input.message}`)
  .intents([]);

const drafterRole = H.role('drafter')
  .input(z.object({ subject: z.string(), message: z.string(), category: z.string(), summary: z.string() }))
  .output(z.object({ reply: z.string() }))
  .prompt(input => `Draft a reply for a "${input.category}" conversation.\n\nSummary: ${input.summary}\n\nSubject: ${input.subject}\n\nCustomer wrote:\n${input.message}`)
  .intents([]);

const taste = H.memory('taste', 'owner');
const experience = H.memory('experience', 'fallible');

const specificityThenRecord = H.policy.recall('specificity-then-record', view =>
  [...view.items]
    .filter(item => item.status === 'accepted')
    .sort((a, b) =>
      b.specificity - a.specificity || (b.trackRecord.value ?? 0) - (a.trackRecord.value ?? 0))
    .slice(0, 10));

const replyTaste = H.library('reply-taste', taste, jsonl.memory('memory/taste.jsonl')).recall(specificityThenRecord);
const supportExperience = H.library('support-experience', experience, jsonl.memory('memory/experience.jsonl'))
  .recall(specificityThenRecord);

const haiku = anthropic.model('claude-haiku-4-5');
const sonnet = anthropic.model('claude-sonnet-4-5');
const opus = anthropic.model('claude-opus-4-1');

const unsampled: Rate = { value: null, hits: 0, samples: 0 };

const approvals = { entry: 'halt', halt: 'approve-reply', status: 'resolved' } as const satisfies object;

const drafterModel = H.policy.model('drafter-by-approval-rate', choice => {
  const byModel = choice.metrics.rateBy({
    among: { entry: 'halt', halt: 'approve-reply', status: 'resolved' },
    count: { entry: 'halt', halt: 'approve-reply', status: 'resolved', decision: { approved: true } },
    by: { tag: 'draftModel' },
    days: 30,
  });
  const sonnetRate = byModel[sonnet.name] ?? unsampled;
  if (sonnetRate.samples < 50 || sonnetRate.value === null) return sonnet;
  return sonnetRate.value < 0.8 ? opus : sonnet;
});

const classifier = H.agent('classifier', classifierRole).model(haiku);

const drafter = H.agent('drafter', drafterRole)
  .model(drafterModel)
  .recalls(replyTaste, supportExperience);

const safeToAutoSend = H.policy.rule('safe-category', (input: { category: string }, metrics) => {
  const rate = metrics.rate({
    among: { entry: 'halt', halt: 'approve-reply', status: 'resolved', tags: { category: input.category } },
    count: {
      entry: 'halt',
      halt: 'approve-reply',
      status: 'resolved',
      tags: { category: input.category },
      decision: { approved: true },
    },
    days: 365,
  });
  return rate.samples >= 200 && rate.hits === rate.samples;
});

const local = shell.local('local', { slots: 4 });

const sendReply = H.command('send-reply')
  .input(z.object({ conversationId: z.string(), body: z.string() }))
  .argv(input => ['helpdesk-reply', '--conversation', input.conversationId, '--body', input.body])
  .on(local);

const approvalDecision = z.object({
  approved: z.boolean(),
  editedReply: z.string().optional(),
  notes: z.string().optional(),
});

const triageFlow = H.flow('triage')
  .for(Conversation)
  .does(async ctx => {
    await ctx.move('classifying');
    const { conversationId, subject, lastMessage } = ctx.unit.data;
    const classified = await ctx.run(classifier, { subject, message: lastMessage });
    if (!classified.ok) return ctx.fail(classified.error);
    const category = classified.value.category;
    await ctx.update({ category });
    ctx.tag({ category });

    await ctx.move('drafting');
    const drafted = await ctx.run(drafter, { subject, message: lastMessage, category, summary: classified.value.summary }, {
      scope: { skills: [category] },
    });
    if (!drafted.ok) return ctx.fail(drafted.error);
    ctx.tag({ draftModel: drafted.model ?? 'unknown' });

    let reply = drafted.value.reply;
    const autoSend = await ctx.decide(safeToAutoSend, { category });
    if (!autoSend) {
      await ctx.move('awaiting-approval');
      const decision = await ctx.halt({
        name: 'approve-reply',
        show: `Category: ${category}\n\nCustomer:\n${lastMessage}\n\nDraft:\n${reply}`,
        decision: approvalDecision,
      });
      if (decision.notes) {
        await ctx.remember(replyTaste, {
          text: `When drafting a ${category} reply, ${decision.notes}`,
          because: 'the reviewer edited a draft to say so',
          when: { roles: ['drafter'], skills: [category] },
          status: 'candidate',
        });
      }
      if (!decision.approved) return ctx.fail('reviewer rejected the draft');
      reply = decision.editedReply ?? reply;
    }

    const sent = await ctx.run(sendReply, { conversationId, body: reply });
    return sent.ok ? 'sent' : ctx.fail(sent.error);
  });

const escalationFlow = H.flow('escalation')
  .for(Escalation)
  .does(async ctx => {
    await ctx.move('handling');
    const decision = await ctx.halt({
      name: 'handle-escalation',
      show: `Conversation ${ctx.unit.data.conversationId}: ${ctx.unit.data.subject}\nReason: ${ctx.unit.data.reason}`,
      decision: z.object({ handled: z.boolean(), note: z.string() }),
    });
    return decision.handled ? 'handled' : 'withdrawn';
  });

const webhookBody = z.object({
  event: z.enum(['conversation.created', 'message.created', 'conversation.closed']),
  conversation: z.object({
    id: z.string(),
    customer_email: z.string(),
    subject: z.string(),
    sla_due_at: z.string(),
  }),
  message: z.object({ body: z.string() }).optional(),
});

const helpdeskHeaders = { Authorization: H.env('HELPDESK_TOKEN') };

const helpdeskWebhook = http.webhook(Conversation, {
  path: '/hooks/helpdesk',
  secret: H.env('HELPDESK_WEBHOOK_SECRET'),
  body: webhookBody,
  read: body => {
    if (body.event === 'conversation.created') {
      return {
        create: {
          conversationId: body.conversation.id,
          customer: body.conversation.customer_email,
          subject: body.conversation.subject,
          lastMessage: body.message ? body.message.body : '',
          slaDueAt: new Date(body.conversation.sla_due_at),
        },
        key: body.conversation.id,
      };
    }
    if (body.event === 'message.created') {
      return {
        update: body.conversation.id,
        patch: { lastMessage: body.message ? body.message.body : '' },
        state: 'new',
      };
    }
    return { update: body.conversation.id, state: 'closed-by-customer' };
  },
});

const pollBody = z.object({
  conversations: z.array(z.object({
    id: z.string(),
    customer_email: z.string(),
    subject: z.string(),
    last_message: z.string(),
    sla_due_at: z.string(),
  })),
});

const helpdeskPoll = http.poll(Conversation, {
  url: 'https://helpdesk.example.com/api/conversations?status=open',
  every: { minutes: 10 },
  headers: helpdeskHeaders,
  body: pollBody,
  read: body => body.conversations.map((c): Supply<ConversationData, ConversationState> => ({
    create: {
      conversationId: c.id,
      customer: c.customer_email,
      subject: c.subject,
      lastMessage: c.last_message,
      slaDueAt: new Date(c.sla_due_at),
    },
    key: c.id,
  })),
});

const helpdeskStore = http.store(Conversation, {
  url: 'https://helpdesk.example.com/api/conversations',
  headers: helpdeskHeaders,
  stateField: 'harness_state',
});

const conversations = H.lane('conversations', Conversation)
  .handler(triageFlow)
  .suppliers(helpdeskWebhook, helpdeskPoll)
  .store(helpdeskStore)
  .maxUsdPerUnit(0.4);

const escalations = H.lane('escalations', Escalation)
  .handler(escalationFlow)
  .suppliers(H.operator);

const slaBreachEscalates = H.trigger(
  'sla-breach-escalates',
  H.on.deadline(Conversation, data => data.slaDueAt, ['new', 'classifying', 'drafting', 'awaiting-approval']),
  (event, act) => [
    act.create(escalations, {
      conversationId: event.unit.data.conversationId,
      subject: event.unit.data.subject,
      reason: `SLA breached at ${event.at.toISOString()}`,
    }, `sla-${event.unit.key}`),
    act.move('escalated'),
  ],
);

const timeToBreachMs = (unit: PendingView, now: Date): number =>
  unit.is(Conversation) ? unit.data.slaDueAt.getTime() - now.getTime() : Number.NEGATIVE_INFINITY;

const byTimeToBreach = H.policy.scheduler('escalations-then-time-to-breach', view => ({
  start: [...view.pending].sort((a, b) => timeToBreachMs(a, view.now) - timeToBreachMs(b, view.now)),
}));

const apiPool = H.pool('anthropic', [
  { account: anthropic.account('support-api', { apiKey: H.env('ANTHROPIC_API_KEY') }), share: 1 },
], H.policy.account('first-eligible', choice => {
  const eligible = choice.accounts.find(view => view.eligible);
  return eligible ? eligible.account : null;
}));

const supervisor = claudeCode.supervisor({
  grants: [
    H.ops.readWork,
    H.ops.writeWork,
    H.ops.resolveHalts,
    H.ops.readMemory,
    H.ops.writeMemory,
    H.ops.curateMemory,
    H.ops.readTelemetry,
  ],
});

export default H.harness('support-triage')
  .ledger(sqlite.ledger('.harness/support-ledger.sqlite'))
  .lanes(conversations, escalations)
  .pools(apiPool)
  .triggers(slaBreachEscalates)
  .scheduler(byTimeToBreach)
  .clients(supervisor)
  .observers(markdown.board('BOARD.md'), markdown.telemetry('TELEMETRY.md'));

export const approvalFilter = approvals;
