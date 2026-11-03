import { H } from 'harness-dsl';
import type { PendingView } from 'harness-dsl';
import { z } from 'zod';
import * as anthropic from 'harness-dsl/anthropic';
import * as cc from 'harness-dsl/claude-code';
import * as http from 'harness-dsl/http';
import * as shell from 'harness-dsl/shell';
import * as sqlite from 'harness-dsl/sqlite';
import * as jsonl from 'harness-dsl/jsonl';
import * as markdown from 'harness-dsl/markdown';

const fresh = H.state('new', 'pending');
const classifying = H.state('classifying', 'pending');
const drafting = H.state('drafting', 'pending');
const awaitingApproval = H.state('awaiting-approval', 'active');
const sent = H.state('sent', 'terminal', 'success');
const closedByCustomer = H.state('closed-by-customer', 'terminal', 'neutral');
const escalated = H.state('escalated', 'terminal', 'failure');
const open = H.state('open', 'pending');
const handled = H.state('handled', 'terminal', 'success');

const Conversation = H.kind('Conversation')
  .data(
    z.object({
      conversationId: z.string(),
      subject: z.string(),
      latestMessage: z.string(),
      slaDueAt: z.string(),
      category: z.string().optional(),
      reviewNotes: z.string().optional(),
    })
  )
  .states(fresh, classifying, drafting, awaitingApproval, sent, closedByCustomer, escalated)
  .failsTo('escalated', 'drafting');

const Escalation = H.kind('Escalation')
  .data(z.object({ conversationId: z.string(), reason: z.string(), resolution: z.string().optional() }))
  .states(open, handled);

const categoryTag = H.tag('category');
const modelTag = H.tag('model');

const taste = H.memory('reply-taste', 'taste');
const experience = H.memory('support-experience', 'experience');
const tasteArchive = H.archive('taste', taste, jsonl.memory('memory/taste.jsonl'));
const experienceArchive = H.archive('experience', experience, jsonl.memory('memory/experience.jsonl'));
const drafterBriefing = H.briefing('drafter-briefing', [tasteArchive, experienceArchive]);

const haiku = anthropic.model('claude-haiku-4-5');
const sonnet = anthropic.model('claude-sonnet-4-5');
const opus = anthropic.model('claude-opus-4-1');

const approval = H.halt(
  'reply-approval',
  z.object({ approved: z.boolean(), reply: z.string().optional(), notes: z.string().optional() })
);
const escalationResolution = H.halt('escalation-resolution', z.object({ resolution: z.string() }));

const drafterModel = H.policy.model('drafter-by-approval-rate', (choice) => {
  const byModel = choice.metrics.rateBy({
    among: approval.resolved(),
    count: approval.resolved({ approved: true }),
    by: modelTag,
    days: 30,
  });
  const current = byModel.of(sonnet);
  return current.samples >= 100 && (current.value ?? 1) < 0.8 ? opus : sonnet;
});

const autoSend = H.policy.rule(
  'auto-send-safe-category',
  { input: z.object({ category: z.string() }), output: z.boolean() },
  (input, metrics) => {
    const scope = { tags: [categoryTag.is(input.category)] };
    const record = metrics.rate({
      among: { ...approval.resolved(), ...scope },
      count: { ...approval.resolved({ approved: true }), ...scope },
    });
    return record.hits >= 200 && record.hits === record.samples;
  }
);

const classifierRole = H.role('classifier')
  .input(z.object({ subject: z.string(), message: z.string() }))
  .output(z.object({ category: z.enum(['billing', 'refund', 'shipping', 'account', 'general']) }))
  .prompt((input) => `Classify this support conversation.\nSubject: ${input.subject}\n\n${input.message}`)
  .intents([]);

const drafterRole = H.role('drafter')
  .input(z.object({ subject: z.string(), message: z.string(), category: z.string(), notes: z.string() }))
  .output(z.object({ reply: z.string() }))
  .prompt(
    (input) =>
      `Draft a reply for a ${input.category} conversation.\nSubject: ${input.subject}\n\n${input.message}\n\nReviewer notes: ${input.notes}`
  )
  .intents([]);

const classifier = H.agent('classifier', classifierRole).model(haiku);
const drafter = H.agent('drafter', drafterRole).model(drafterModel).recalls(drafterBriefing);

const localRunner = shell.local('local', { slots: 4 });
const helpdeskToken = H.env('HELPDESK_TOKEN');

const sendReply = H.command('send-reply')
  .input(z.object({ conversationId: z.string(), reply: z.string() }))
  .argv((input) => ['helpdesk', 'reply', '--conversation', input.conversationId, '--body', input.reply])
  .on(localRunner)
  .recovers('park');

const triage = H.flow('triage')
  .for(Conversation)
  .does(async (ctx) => {
    await ctx.move('classifying');
    const classified = await ctx.run(classifier, {
      subject: ctx.unit.data.subject,
      message: ctx.unit.data.latestMessage,
    });
    if (classified.ok === false) return ctx.fail(classified.error);
    await ctx.update({ category: classified.value.category });
    return 'drafting';
  })
  .phase('drafting', async (ctx) => {
    const { conversationId, subject, latestMessage } = ctx.unit.data;
    const category = ctx.unit.data.category ?? 'general';
    ctx.tag(categoryTag, category);
    const draft = await ctx.run(drafter, {
      subject,
      message: latestMessage,
      category,
      notes: ctx.unit.data.reviewNotes ?? '',
    });
    if (draft.ok === false) return ctx.fail(draft.error);
    ctx.tag(modelTag, draft.model);
    let reply = draft.value.reply;
    const safe = await ctx.decide(autoSend, { category });
    if (safe === false) {
      await ctx.move('awaiting-approval');
      const review = await ctx.halt(approval, reply);
      if (review.notes) {
        await ctx.remember(tasteArchive, {
          text: review.notes,
          because: `reviewer edit on a ${category} reply`,
          when: { roles: [drafterRole], tags: [categoryTag.is(category)] },
          status: 'candidate',
        });
      }
      if (review.approved === false) {
        await ctx.update({ reviewNotes: review.notes ?? 'rejected without notes' });
        return ctx.fail('reply rejected by reviewer', 'drafting');
      }
      reply = review.reply ?? reply;
    }
    const delivered = await ctx.run(sendReply, { conversationId, reply });
    if (delivered.ok === false) return ctx.fail(delivered.error);
    return 'sent';
  });

const escalationFlow = H.flow('escalation')
  .for(Escalation)
  .does(async (ctx) => {
    const outcome = await ctx.halt(
      escalationResolution,
      `Conversation ${ctx.unit.data.conversationId} escalated: ${ctx.unit.data.reason}`
    );
    await ctx.update({ resolution: outcome.resolution });
    return 'handled';
  });

const webhook = http.webhook(Conversation, {
  path: '/helpdesk/events',
  secret: H.env('HELPDESK_WEBHOOK_SECRET'),
  body: z.object({
    event: z.enum(['conversation.created', 'message.created', 'conversation.closed']),
    conversation: z.object({ id: z.string(), subject: z.string(), slaDueAt: z.string() }),
    message: z.object({ body: z.string(), author: z.enum(['customer', 'agent']) }),
  }),
  read: (body) => {
    if (body.event === 'conversation.closed') return { update: body.conversation.id, state: 'closed-by-customer' };
    if (body.message.author === 'agent') return null;
    if (body.event === 'conversation.created') {
      return {
        create: {
          conversationId: body.conversation.id,
          subject: body.conversation.subject,
          latestMessage: body.message.body,
          slaDueAt: body.conversation.slaDueAt,
        },
        key: body.conversation.id,
      };
    }
    return { update: body.conversation.id, patch: { latestMessage: body.message.body }, state: 'classifying' };
  },
});

const missedPoll = http.poll(Conversation, {
  url: 'https://helpdesk.example.com/api/conversations?status=open',
  every: { minutes: 10 },
  headers: { 'X-Api-Key': helpdeskToken },
  body: z.object({
    conversations: z.array(
      z.object({ id: z.string(), subject: z.string(), lastMessage: z.string(), slaDueAt: z.string() })
    ),
  }),
  read: (body) =>
    body.conversations.map((item) => ({
      create: {
        conversationId: item.id,
        subject: item.subject,
        latestMessage: item.lastMessage,
        slaDueAt: item.slaDueAt,
      },
      key: item.id,
    })),
});

const helpdeskStore = http.store(Conversation, {
  url: 'https://helpdesk.example.com/api/conversations',
  headers: { 'X-Api-Key': helpdeskToken },
  stateField: 'harness_state',
});

const conversations = H.lane('conversations', Conversation)
  .handler(triage)
  .suppliers(webhook, missedPoll)
  .store(helpdeskStore)
  .maxUsdPerUnit(0.4);

const escalations = H.lane('escalations', Escalation).handler(escalationFlow);

const slaBreach = H.trigger(
  'sla-breach-escalates',
  H.on.deadline(Conversation, (data) => new Date(data.slaDueAt), ['new', 'classifying', 'drafting', 'awaiting-approval']),
  (event, act) => [
    act.move('escalated'),
    act.create(
      escalations,
      { conversationId: event.unit.data.conversationId, reason: 'SLA breached' },
      `escalation-${event.unit.data.conversationId}`
    ),
  ]
);

const timeToBreach = H.policy.scheduler('time-to-breach', (view) => {
  const dueAt = (unit: PendingView): number => (unit.is(Conversation) ? Date.parse(unit.data.slaDueAt) : 0);
  return { start: [...view.pending].sort((a, b) => dueAt(a) - dueAt(b)) };
});

const supportPool = H.pool('support', [
  { account: anthropic.account('support-api', { apiKey: H.env('ANTHROPIC_API_KEY') }), share: 1 },
]);

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
  .pools(supportPool)
  .triggers(slaBreach)
  .scheduler(timeToBreach)
  .clients(supervisor)
  .observers(markdown.board('BOARD.md'), markdown.telemetry('TELEMETRY.md'));
