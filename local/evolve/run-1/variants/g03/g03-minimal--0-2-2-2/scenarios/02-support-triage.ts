import { z } from 'zod';
import { H } from 'harness-dsl';
import type { Metrics, Model, PendingView } from 'harness-dsl';
import type { ModelChoice } from 'harness-dsl/kernel';
import * as claude from 'harness-dsl/claude-code';
import * as anthropic from 'harness-dsl/anthropic';
import * as http from 'harness-dsl/http';
import * as sqlite from 'harness-dsl/sqlite';
import * as jsonl from 'harness-dsl/jsonl';
import * as shell from 'harness-dsl/shell';
import * as markdown from 'harness-dsl/markdown';

const conversation = z.object({
  subject: z.string(),
  latestMessage: z.string(),
  category: z.string().optional(),
  slaDueAt: z.date(),
});

const fresh = H.state('new', 'pending');
const classifying = H.state('classifying', 'active');
const drafting = H.state('drafting', 'active');
const awaitingApproval = H.state('awaiting-approval', 'active');
const sent = H.state('sent', 'terminal', 'success');
const closedByCustomer = H.state('closed-by-customer', 'terminal', 'neutral');
const escalated = H.state('escalated', 'terminal', 'failure');
const Conversation = H.kind('conversation')
  .data(conversation)
  .states(fresh, classifying, drafting, awaitingApproval, sent, closedByCustomer, escalated);

const raised = H.state('raised', 'pending');
const withHuman = H.state('with-human', 'active');
const resolved = H.state('resolved', 'terminal', 'success');
const Escalation = H.kind('escalation')
  .data(z.object({ conversation: z.string(), subject: z.string() }))
  .states(raised, withHuman, resolved);

const taste = H.memory('reply-taste', 'taste');
const experience = H.memory('support-experience', 'experience');
const tasteLibrary = H.library('reply-taste', taste, jsonl.memory('.harness/taste.jsonl'));
const experienceLibrary = H.library('support-experience', experience, jsonl.memory('.harness/experience.jsonl'));

const replyApproval = H.halt(
  'reply-approval',
  z.object({ approved: z.boolean(), editedReply: z.string().optional(), notes: z.string().optional() })
);
const escalationResolution = H.halt('escalation-resolution', z.object({ resolution: z.string() }));

const cheapModel = anthropic.model('claude-haiku-4-5');
const strongModel = anthropic.model('claude-sonnet-4-5');
const alternateModel = anthropic.model('claude-opus-4-1');

const apiAccount = anthropic.account('anthropic-api', { apiKey: H.env('ANTHROPIC_API_KEY') });
const pool = H.pool('anthropic', [{ account: apiAccount, share: 1 }]);

const local = shell.local('local', { slots: 4 });

const classifierRole = H.role('classifier')
  .input(z.object({ subject: z.string(), message: z.string() }))
  .output(z.object({ category: z.string() }))
  .prompt((input) => `Classify this support conversation.\nSubject: ${input.subject}\n${input.message}`);

const drafterRole = H.role('drafter')
  .input(z.object({ subject: z.string(), message: z.string(), category: z.string() }))
  .output(z.object({ reply: z.string() }))
  .prompt((input) => `Draft a reply for a ${input.category} conversation.\nSubject: ${input.subject}\n${input.message}`);

const classifier = H.agent('classifier', classifierRole).model(cheapModel);

const drafterModel = H.policy.model('drafter-model', (choice: ModelChoice): Model => {
  const approvals = choice.metrics.rateBy({
    among: replyApproval.resolved(),
    count: replyApproval.resolved({ approved: true }),
    by: { modelOf: drafter },
    days: 30,
  });
  const primary = approvals.of(strongModel);
  if (primary.samples < 50 || primary.value === null || primary.value >= 0.85) return strongModel;
  const alternate = approvals.of(alternateModel);
  if (alternate.samples < 50) return alternateModel;
  return (alternate.value ?? 0) > primary.value ? alternateModel : strongModel;
});

const drafter = H.agent('drafter', drafterRole).model(drafterModel).recalls(tasteLibrary, experienceLibrary);

const safeCategory = H.policy.rule('safe-category', (category: string, metrics: Metrics) => {
  const rate = metrics
    .rateBy({
      among: replyApproval.resolved(),
      count: replyApproval.resolved({ approved: true }),
      by: { tag: 'category' },
      days: 365,
    })
    .of(category);
  return rate.samples >= 200 && rate.hits === rate.samples;
});

const sendReply = H.command('send-reply')
  .input(z.object({ conversation: z.string(), reply: z.string() }))
  .argv((input) => ['helpdesk-reply', '--conversation', input.conversation, '--body', input.reply])
  .on(local);

const conversationWork = H.flow('conversation-work')
  .for(Conversation)
  .phases('classifying', 'drafting', 'awaitingApproval')
  .exits('sent', 'escalate')
  .does(async (ctx) => {
    await ctx.move('classifying');
    const message = { subject: ctx.unit.data.subject, message: ctx.unit.data.latestMessage };
    const classified = await ctx.run(classifier, message);
    if (!classified.ok) return ctx.fail(classified.error);
    const category = classified.value.category;
    ctx.tag({ category });
    await ctx.update({ category });
    await ctx.move('drafting');
    const drafted = await ctx.run(drafter, { ...message, category }, { scope: { skills: [category] } });
    if (!drafted.ok) return ctx.fail(drafted.error);
    let reply = drafted.value.reply;
    const safe = await ctx.decide(safeCategory, category);
    if (!safe) {
      await ctx.move('awaitingApproval');
      const decision = await ctx.halt(replyApproval, reply);
      if (decision.notes !== undefined) {
        await ctx.remember(tasteLibrary, {
          text: `When replying in ${category}: ${decision.notes}`,
          because: 'the reviewer corrected a draft this way',
          when: { roles: [drafterRole], skills: [category] },
          status: 'candidate',
        });
      }
      if (!decision.approved) return 'escalate';
      if (decision.editedReply !== undefined) reply = decision.editedReply;
    }
    const delivered = await ctx.run(sendReply, { conversation: ctx.unit.key, reply });
    if (!delivered.ok) return ctx.fail(delivered.error);
    return 'sent';
  });

const escalationWork = H.flow('escalation-work')
  .for(Escalation)
  .phases('withHuman')
  .exits('resolved')
  .does(async (ctx) => {
    await ctx.move('withHuman');
    await ctx.halt(escalationResolution, `Conversation ${ctx.unit.data.conversation}: ${ctx.unit.data.subject}`);
    return 'resolved';
  });

const helpdeskAuth = H.env('HELPDESK_AUTH_HEADER');

const helpdeskEvent = z.object({
  event: z.enum(['conversation.created', 'message.created', 'conversation.closed']),
  conversation: z.object({ id: z.string(), subject: z.string(), slaDueAt: z.string() }),
  message: z.string(),
});

const helpdeskWebhook = http.webhook(Conversation, {
  path: '/helpdesk',
  secret: H.env('HELPDESK_WEBHOOK_SECRET'),
  body: helpdeskEvent,
  read: (body) => {
    if (body.event === 'conversation.created') {
      return {
        create: {
          subject: body.conversation.subject,
          latestMessage: body.message,
          slaDueAt: new Date(body.conversation.slaDueAt),
        },
        key: body.conversation.id,
      };
    }
    if (body.event === 'message.created') {
      return { update: body.conversation.id, patch: { latestMessage: body.message }, state: 'new' };
    }
    return { update: body.conversation.id, state: 'closed-by-customer' };
  },
});

const helpdeskList = z.object({
  conversations: z.array(
    z.object({ id: z.string(), subject: z.string(), lastMessage: z.string(), slaDueAt: z.string() })
  ),
});

const helpdeskPoll = http.poll(Conversation, {
  url: 'https://helpdesk.example.com/api/conversations?status=open',
  every: { minutes: 10 },
  headers: { authorization: helpdeskAuth },
  body: helpdeskList,
  read: (body) =>
    body.conversations.map((item) => ({
      create: { subject: item.subject, latestMessage: item.lastMessage, slaDueAt: new Date(item.slaDueAt) },
      key: item.id,
    })),
});

const helpdeskStore = http.store(Conversation, {
  url: 'https://helpdesk.example.com/api/conversations',
  headers: { authorization: helpdeskAuth },
  stateField: 'status',
});

const conversations = H.lane('conversations', Conversation)
  .handler(conversationWork, { classifying, drafting, awaitingApproval, sent, escalate: escalated })
  .suppliers(helpdeskWebhook, helpdeskPoll)
  .store(helpdeskStore)
  .maxUsdPerUnit(0.4);

const escalations = H.lane('escalations', Escalation).handler(escalationWork, { withHuman, resolved });

const slaBreach = H.trigger(
  'sla-breach-escalates',
  H.on.deadline(Conversation, (data) => data.slaDueAt, ['new', 'classifying', 'drafting', 'awaiting-approval']),
  (_event, act) => act.move('escalated')
);

const escalationOpens = H.trigger('escalation-opens-unit', H.on.enters(Conversation, 'escalated'), (event, act) =>
  act.create(
    escalations,
    { conversation: event.unit.key, subject: event.unit.data.subject },
    `escalation-${event.unit.key}`
  )
);

const timeToBreach = H.policy.scheduler('time-to-breach', ({ pending }) => {
  const first: PendingView[] = [];
  const timed: { readonly unit: PendingView; readonly dueMs: number }[] = [];
  for (const unit of pending) {
    if (unit.is(Conversation)) timed.push({ unit, dueMs: unit.data.slaDueAt.getTime() });
    else first.push(unit);
  }
  timed.sort((a, b) => a.dueMs - b.dueMs);
  return { start: [...first, ...timed.map((entry) => entry.unit)] };
});

const supervisor = claude.supervisor({
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

export const supportTriage = H.harness('support-triage')
  .ledger(sqlite.ledger('.harness/ledger.db'))
  .lanes(conversations, escalations)
  .pools(pool)
  .triggers(slaBreach, escalationOpens)
  .scheduler(timeToBreach)
  .clients(supervisor)
  .observers(markdown.board('BOARD.md'), markdown.telemetry('TELEMETRY.md'));

export const running = supportTriage.start();
