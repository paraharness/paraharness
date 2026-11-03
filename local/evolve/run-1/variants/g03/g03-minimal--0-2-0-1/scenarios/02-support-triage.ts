import { z } from 'zod';
import { H, type Metrics } from 'harness-dsl';
import * as cc from 'harness-dsl/claude-code';
import * as anthropic from 'harness-dsl/anthropic';
import * as http from 'harness-dsl/http';
import * as sqlite from 'harness-dsl/sqlite';
import * as jsonl from 'harness-dsl/jsonl';
import * as shell from 'harness-dsl/shell';
import * as markdown from 'harness-dsl/markdown';

const fresh = H.state('new', 'pending');
const classifying = H.state('classifying', 'pending');
const drafting = H.state('drafting', 'active');
const awaitingApproval = H.state('awaitingApproval', 'active');
const sent = H.state('sent', 'terminal', 'success');
const closedByCustomer = H.state('closed', 'terminal', 'neutral');
const escalated = H.state('escalated', 'terminal', 'failure');
const open = H.state('open', 'pending');
const handling = H.state('handling', 'active');
const resolved = H.state('resolved', 'terminal', 'success');

const Conversation = H.kind('Conversation')
  .data(z.object({
    id: z.string(),
    subject: z.string(),
    lastMessage: z.string(),
    category: z.string().optional(),
    slaDue: z.string(),
  }))
  .states(fresh, classifying, drafting, awaitingApproval, sent, closedByCustomer, escalated)
  .failsTo('escalated', 'classifying');

const Escalation = H.kind('Escalation')
  .data(z.object({ conversation: z.string(), reason: z.string() }))
  .states(open, handling, resolved);

const category = H.tag('category');
const draftModel = H.tag('draft-model');

const classifierRole = H.role('classifier')
  .input(z.object({ subject: z.string(), message: z.string() }))
  .output(z.object({ category: z.string() }))
  .prompt((input) => `Classify this support message.\nSubject: ${input.subject}\n\n${input.message}`);

const drafterRole = H.role('drafter')
  .input(z.object({ subject: z.string(), message: z.string(), category: z.string() }))
  .output(z.object({ reply: z.string() }))
  .prompt((input) => `Draft a reply for a ${input.category} conversation.\nSubject: ${input.subject}\n\n${input.message}`);

const experience = H.memory('support-experience', 'experience');
const taste = H.memory('reply-taste', 'taste');
const supportExperience = H.archive('support-experience', experience, jsonl.memory('.harness/experience.jsonl'));
const replyTaste = H.archive('reply-taste', taste, jsonl.memory('.harness/taste.jsonl'));
const draftingBriefing = H.briefing('drafting-briefing', [replyTaste, supportExperience]);

const approval = H.halt('reply-approval', z.object({
  approved: z.boolean(),
  editedReply: z.string().optional(),
  notes: z.string().optional(),
}));
const escalationHandled = H.halt('escalation-handled', z.object({ resolution: z.string() }));

const haiku = anthropic.model('claude-haiku-4-5');
const sonnet = anthropic.model('claude-sonnet-4-5');
const opus = anthropic.model('claude-opus-4-1');

const drafterByApproval = H.policy.model('drafter-by-approval-rate', (choice) => {
  const rates = choice.metrics.rateBy({
    among: approval.resolved(),
    count: approval.resolved({ approved: true }),
    by: draftModel,
    days: 30,
  });
  const sonnetRate = rates[sonnet.name];
  const opusRate = rates[opus.name];
  if (!sonnetRate || sonnetRate.samples < 50) return sonnet;
  if (!opusRate || opusRate.samples < 50) return opus;
  return (opusRate.value ?? 0) > (sonnetRate.value ?? 0) ? opus : sonnet;
});

const safeCategory = H.policy.rule('safe-category', (input: { readonly category: string }, metrics: Metrics) => {
  const scope = [category.is(input.category)];
  const record = metrics.rate({
    among: { ...approval.resolved(), tags: scope },
    count: { ...approval.resolved({ approved: true }), tags: scope },
  });
  return record.samples >= 200 && record.hits === record.samples;
});

const classifier = H.agent('classifier', classifierRole).model(haiku);
const drafter = H.agent('drafter', drafterRole).model(drafterByApproval).recalls(draftingBriefing);

const local = shell.local('local', { slots: 4 });

const sendReply = H.command('send-reply')
  .input(z.object({ id: z.string(), reply: z.string() }))
  .argv((input) => ['helpdesk-reply', '--conversation', input.id, '--body', input.reply])
  .on(local)
  .recovers('park');

const triage = H.flow('triage')
  .for(Conversation)
  .does(async (ctx) => {
    const { subject, lastMessage } = ctx.unit.data;
    const classified = await ctx.run(classifier, { subject, message: lastMessage });
    if (!classified.ok) return ctx.fail(classified.error);
    const categoryName = classified.value.category;
    await ctx.tag(category, categoryName);
    await ctx.update({ category: categoryName });
    await ctx.move('drafting');
    const drafted = await ctx.run(
      drafter,
      { subject, message: lastMessage, category: categoryName },
      { scope: { tags: [category.is(categoryName)] } }
    );
    if (!drafted.ok) return ctx.fail(drafted.error);
    await ctx.tag(draftModel, drafted.model ?? 'unknown');
    let reply = drafted.value.reply;
    const safe = await ctx.decide(safeCategory, { category: categoryName });
    if (!safe) {
      await ctx.move('awaitingApproval');
      const verdict = await ctx.halt(approval, reply);
      if (verdict.notes) {
        await ctx.remember(replyTaste, {
          text: verdict.notes,
          status: 'candidate',
          when: { roles: [drafterRole] },
        });
      }
      if (!verdict.approved) return ctx.fail('reply rejected by reviewer', 'classifying');
      reply = verdict.editedReply ?? reply;
    }
    const delivery = await ctx.run(sendReply, { id: ctx.unit.data.id, reply });
    return delivery.ok ? 'sent' : ctx.fail(delivery.error);
  });

const escalationFlow = H.flow('escalation')
  .for(Escalation)
  .does(async (ctx) => {
    await ctx.move('handling');
    await ctx.halt(escalationHandled, `Escalated conversation ${ctx.unit.data.conversation}: ${ctx.unit.data.reason}`);
    return 'resolved';
  });

const helpdeskToken = H.env('HELPDESK_TOKEN');

const conversationSchema = z.object({ id: z.string(), subject: z.string(), slaDue: z.string() });

const helpdeskWebhook = http.webhook(Conversation, {
  path: '/helpdesk/events',
  secret: H.env('HELPDESK_WEBHOOK_SECRET'),
  body: z.object({
    event: z.enum(['created', 'replied', 'closed']),
    conversation: conversationSchema,
    message: z.string(),
  }),
  read: (body) => {
    if (body.event === 'created') {
      return {
        create: {
          id: body.conversation.id,
          subject: body.conversation.subject,
          lastMessage: body.message,
          slaDue: body.conversation.slaDue,
        },
        key: body.conversation.id,
      };
    }
    if (body.event === 'replied') {
      return { update: body.conversation.id, patch: { lastMessage: body.message }, state: 'classifying' };
    }
    return { update: body.conversation.id, state: 'closed' };
  },
});

const helpdeskPoll = http.poll(Conversation, {
  url: 'https://helpdesk.example.com/api/conversations?status=open',
  every: { minutes: 10 },
  headers: { authorization: helpdeskToken },
  body: z.object({
    conversations: z.array(conversationSchema.extend({ lastMessage: z.string() })),
  }),
  read: (body) =>
    body.conversations.map((conversation) => ({
      create: {
        id: conversation.id,
        subject: conversation.subject,
        lastMessage: conversation.lastMessage,
        slaDue: conversation.slaDue,
      },
      key: conversation.id,
    })),
});

const helpdeskStore = http.store(Conversation, {
  url: 'https://helpdesk.example.com/api/conversations',
  headers: { authorization: helpdeskToken },
  stateField: 'harness_state',
});

const conversations = H.lane('conversations', Conversation)
  .handler(triage)
  .suppliers(helpdeskWebhook, helpdeskPoll)
  .store(helpdeskStore)
  .maxUsdPerUnit(0.4);

const escalations = H.lane('escalations', Escalation).handler(escalationFlow);

const slaBreach = H.trigger(
  'sla-breach-escalates',
  H.on.deadline(Conversation, (data) => new Date(data.slaDue), ['new', 'classifying', 'drafting', 'awaitingApproval']),
  (event, act) => [
    act.create(escalations, { conversation: event.unit.data.id, reason: 'SLA breached' }, `sla:${event.unit.key}`),
    act.move('escalated'),
  ]
);

const timeToBreach = H.policy.scheduler('time-to-breach', (view) => {
  const dueAt = (data: unknown, created: Date): number => {
    const parsed = conversationSchema.safeParse(data);
    return parsed.success ? new Date(parsed.data.slaDue).getTime() : created.getTime();
  };
  return {
    start: [...view.pending].sort((a, b) => dueAt(a.data, a.created) - dueAt(b.data, b.created)),
  };
});

const supportApi = anthropic.account('support-api', { apiKey: H.env('ANTHROPIC_API_KEY') });

const supervisor = cc.supervisor({
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
  .pools(H.pool('support', [{ account: supportApi, share: 1 }]))
  .triggers(slaBreach)
  .scheduler(timeToBreach)
  .clients(supervisor)
  .observers(markdown.board('BOARD.md'), markdown.telemetry('TELEMETRY.md'));

export const running = supportTriage.start();
