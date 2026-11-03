import { H, type PendingView } from 'harness-dsl';
import { z } from 'zod';
import * as anthropic from 'harness-dsl/anthropic';
import * as http from 'harness-dsl/http';
import * as sqlite from 'harness-dsl/sqlite';
import * as jsonl from 'harness-dsl/jsonl';
import * as shell from 'harness-dsl/shell';
import * as cc from 'harness-dsl/claude-code';
import * as markdown from 'harness-dsl/markdown';

export const fresh = H.state('new', 'pending');
export const classifying = H.state('classifying', 'pending');
export const drafting = H.state('drafting', 'active');
export const awaitingApproval = H.state('awaitingApproval', 'active');
export const sent = H.state('sent', 'terminal', 'success');
export const closedByCustomer = H.state('closedByCustomer', 'terminal', 'neutral');
export const escalated = H.state('escalated', 'terminal', 'failure');

export const Conversation = H.kind('Conversation')
  .data(z.object({
    conversationId: z.string(),
    customerMessage: z.string(),
    slaDue: z.string(),
    category: z.string().optional(),
    draft: z.string().optional(),
  }))
  .states(fresh, classifying, drafting, awaitingApproval, sent, closedByCustomer, escalated);

export const escalationOpen = H.state('escalationOpen', 'pending');
export const escalationResolved = H.state('escalationResolved', 'terminal', 'success');

export const Escalation = H.kind('Escalation')
  .data(z.object({ conversationId: z.string(), reason: z.string() }))
  .states(escalationOpen, escalationResolved);

export const category = H.tag('category');
export const draftModel = H.tag('draft-model');

export const approveReply = H.halt('approve-reply', z.object({
  approved: z.boolean(),
  editedReply: z.string().optional(),
  tasteNote: z.string().optional(),
}));
export const resolveEscalation = H.halt('resolve-escalation', z.object({ note: z.string() }));

export const classifierRole = H.role('classifier')
  .input(z.object({ message: z.string() }))
  .output(z.object({ category: z.string() }))
  .prompt((input) => `Classify this customer message into one support category.\n\n${input.message}`);

export const drafterRole = H.role('drafter')
  .input(z.object({ message: z.string(), category: z.string() }))
  .output(z.object({ reply: z.string() }))
  .prompt((input) => `Draft a reply for a ${input.category} conversation.\n\nCustomer wrote:\n${input.message}`);

export const taste = H.memory('reply-taste', 'taste');
export const experience = H.memory('support-experience', 'experience');
export const tasteArchive = H.archive('reply-taste', taste, jsonl.memory('.harness/taste.jsonl'));
export const experienceArchive = H.archive('support-experience', experience, jsonl.memory('.harness/experience.jsonl'));
export const drafterBriefing = H.briefing('drafter-briefing', [tasteArchive, experienceArchive]);

export const apiAccount = anthropic.account('anthropic-api', { apiKey: H.env('ANTHROPIC_API_KEY') });
export const supportPool = H.pool('support', [{ account: apiAccount, share: 1 }]);

export const cheapModel = anthropic.model('claude-haiku');
export const strongModel = anthropic.model('claude-sonnet');

export const classifier = H.agent('classifier', classifierRole).model(cheapModel);
export const drafter = H.agent('drafter', drafterRole).model(strongModel).recalls(drafterBriefing);

export const local = shell.local('local', { slots: 4 });

const replyInput = z.object({ conversationId: z.string(), reply: z.string() });

export const replyPosted = H.command('reply-posted')
  .input(replyInput)
  .output(z.boolean())
  .argv((input) => ['helpdesk', 'has-reply', '--conversation', input.conversationId, '--body', input.reply])
  .on(local)
  .recovers('rerun');

export const sendReply = H.command('send-reply')
  .input(replyInput)
  .argv((input) => ['helpdesk', 'reply', '--conversation', input.conversationId, '--body', input.reply])
  .on(local)
  .recovers(replyPosted);

export const safeToAutoSend = H.policy.rule('safe-to-auto-send', (input: { readonly category: string; readonly model: string }, metrics) => {
  const scope = [category.is(input.category), draftModel.is(input.model)];
  const record = metrics.rate({
    among: { ...approveReply.resolved(), tags: scope },
    count: { ...approveReply.resolved({ approved: true }), tags: scope },
    days: 90,
  });
  return record.samples >= 200 && record.hits === record.samples;
});

export const conversationFlow = H.flow('triage-and-reply')
  .for(Conversation)
  .does(async (ctx) => {
    const { conversationId, customerMessage } = ctx.unit.data;
    const classified = await ctx.run(classifier, { message: customerMessage });
    if (classified.ok === false) return ctx.fail(classified.error);
    const topic = classified.value.category;
    ctx.tag(category, topic);
    await ctx.update({ category: topic });
    await ctx.move('drafting');
    const drafted = await ctx.run(drafter, { message: customerMessage, category: topic });
    if (drafted.ok === false) return ctx.fail(drafted.error);
    const model = drafted.model ?? strongModel.name;
    ctx.tag(draftModel, model);
    await ctx.update({ draft: drafted.value.reply });
    let reply = drafted.value.reply;
    const safe = await ctx.decide(safeToAutoSend, { category: topic, model });
    if (safe === false) {
      await ctx.move('awaitingApproval');
      const review = await ctx.halt(approveReply, reply);
      if (review.tasteNote) {
        await ctx.remember(tasteArchive, {
          text: review.tasteNote,
          because: 'the reviewer edited a draft this way',
          when: { roles: [drafterRole.name] },
          status: 'candidate',
        });
      }
      if (review.approved === false) return 'classifying';
      reply = review.editedReply ?? reply;
    }
    const posted = await ctx.run(sendReply, { conversationId, reply });
    if (posted.ok === false) return ctx.fail(posted.error);
    return 'sent';
  });

const helpdeskHeaders = { authorization: H.env('HELPDESK_TOKEN') };

export const helpdeskWebhook = http.webhook(Conversation, {
  path: '/helpdesk/events',
  secret: H.env('HELPDESK_WEBHOOK_SECRET'),
  body: z.object({
    event: z.enum(['created', 'replied', 'closed']),
    conversationId: z.string(),
    message: z.string(),
    slaDue: z.string(),
  }),
  read: (body) => {
    if (body.event === 'created') {
      return {
        create: { conversationId: body.conversationId, customerMessage: body.message, slaDue: body.slaDue },
        key: body.conversationId,
      };
    }
    if (body.event === 'replied') {
      return { update: body.conversationId, patch: { customerMessage: body.message }, state: 'classifying' };
    }
    return { update: body.conversationId, state: 'closedByCustomer' };
  },
});

export const helpdeskPoll = http.poll(Conversation, {
  url: 'https://helpdesk.example.com/api/conversations?status=open',
  every: { minutes: 10 },
  headers: helpdeskHeaders,
  body: z.object({
    conversations: z.array(z.object({ id: z.string(), message: z.string(), slaDue: z.string() })),
  }),
  read: (body) => body.conversations.map((c) => ({
    create: { conversationId: c.id, customerMessage: c.message, slaDue: c.slaDue },
    key: c.id,
  })),
});

export const helpdeskStore = http.store(Conversation, {
  url: 'https://helpdesk.example.com/api/conversations',
  headers: helpdeskHeaders,
  stateField: 'harness_state',
});

export const conversationLane = H.lane('conversations', Conversation)
  .handler(conversationFlow)
  .suppliers(helpdeskWebhook, helpdeskPoll)
  .store(helpdeskStore)
  .maxUsdPerUnit(0.4);

export const escalationFlow = H.flow('human-escalation')
  .for(Escalation)
  .does(async (ctx) => {
    await ctx.halt(resolveEscalation, `Conversation ${ctx.unit.data.conversationId}: ${ctx.unit.data.reason}`);
    return 'escalationResolved';
  });

export const escalationLane = H.lane('escalations', Escalation).handler(escalationFlow);

export const slaBreach = H.trigger(
  'sla-breach-escalates',
  H.on.deadline(Conversation, (data) => new Date(data.slaDue), ['new', 'classifying', 'drafting', 'awaitingApproval']),
  (event, act) => [
    act.move('escalated'),
    act.create(
      escalationLane,
      { conversationId: event.unit.data.conversationId, reason: `SLA breached at ${event.at.toISOString()}` },
      event.unit.data.conversationId,
    ),
  ],
);

const dueAt = (unit: PendingView): number => {
  if (unit.is(Conversation)) return Date.parse(unit.data.slaDue);
  return Number.NEGATIVE_INFINITY;
};

export const timeToBreach = H.policy.scheduler('time-to-breach', (view) => ({
  start: [...view.pending].sort((a, b) => dueAt(a) - dueAt(b)),
}));

export const supervisor = cc.supervisor({
  grants: [H.ops.readWork, H.ops.writeWork, H.ops.resolveHalts, H.ops.writeMemory, H.ops.readTelemetry],
});

export const supportTriage = H.harness('support-triage')
  .ledger(sqlite.ledger('.harness/ledger.db'))
  .lanes(conversationLane, escalationLane)
  .pools(supportPool)
  .triggers(slaBreach)
  .scheduler(timeToBreach)
  .clients(supervisor)
  .observers(markdown.board('BOARD.md'), markdown.telemetry('TELEMETRY.md'));
