import { H } from 'harness-dsl';
import type { PendingView } from 'harness-dsl';
import { z } from 'zod';
import * as anthropic from 'harness-dsl/anthropic';
import * as claudeCode from 'harness-dsl/claude-code';
import * as http from 'harness-dsl/http';
import * as sqlite from 'harness-dsl/sqlite';
import * as jsonl from 'harness-dsl/jsonl';
import * as shell from 'harness-dsl/shell';
import * as markdown from 'harness-dsl/markdown';

const Conversation = H.kind('Conversation')
  .data(
    z.object({
      customer: z.string(),
      latest: z.string(),
      slaDue: z.date(),
      category: z.string().optional(),
    })
  )
  .states(
    [
      H.state.pending('new'),
      H.state.active('classifying'),
      H.state.active('drafting'),
      H.state.active('awaiting-approval'),
      H.state.terminal('sent', 'success'),
      H.state.terminal('closed-by-customer', 'neutral'),
      H.state.terminal('escalated', 'failure'),
    ],
    'new'
  );

const Escalation = H.kind('Escalation')
  .data(z.object({ conversation: z.string(), reason: z.string() }))
  .states(
    [
      H.state.pending('open'),
      H.state.active('with-human'),
      H.state.terminal('resolved', 'success'),
    ],
    'open'
  );

const Taste = H.memory('taste', 'owner');
const Experience = H.memory('experience', 'fallible');

const specificFirst = H.policy.recall('specific-then-proven', view =>
  [...view.items]
    .sort(
      (a, b) =>
        b.specificity - a.specificity ||
        (b.trackRecord.value ?? 0.5) - (a.trackRecord.value ?? 0.5)
    )
    .slice(0, 10)
);

const taste = H.library('reply-taste', Taste, jsonl.memory('memory/taste.jsonl')).recall(specificFirst);
const experience = H.library('support-experience', Experience, jsonl.memory('memory/experience.jsonl')).recall(specificFirst);

const haiku = anthropic.model('claude-haiku-4-5');
const sonnet = anthropic.model('claude-sonnet-4-5');

const categorySchema = z.enum(['billing', 'refund', 'bug', 'howto', 'other']);

const classifierRole = H.role('classifier')
  .input(z.object({ message: z.string() }))
  .output(z.object({ category: categorySchema }))
  .prompt(input => `Classify this customer message:\n\n${input.message}`);

const drafterRole = H.role('drafter')
  .input(z.object({ message: z.string(), category: categorySchema }))
  .output(z.object({ reply: z.string() }))
  .prompt(input => `Draft a reply to this ${input.category} conversation:\n\n${input.message}`);

const classifier = H.agent('classifier', classifierRole).model(haiku);
const drafter = H.agent('drafter', drafterRole).model(sonnet).recalls(taste, experience);

const local = shell.local('local', { slots: 4 });

const sendReply = H.command('send-reply')
  .input(z.object({ conversation: z.string(), text: z.string() }))
  .argv(input => ['helpdesk', 'reply', input.conversation, '--text', input.text])
  .on(local)
  .restart('park');

const safeToSend = H.policy.rule(
  'safe-after-200-clean-approvals',
  (draft: { readonly category: string; readonly model: string }, metrics) => {
    const approvals = metrics.rate({
      among: {
        entry: 'halt',
        halt: 'approve-reply',
        status: 'resolved',
        tags: { category: draft.category, model: draft.model },
      },
      count: { decision: { approved: true } },
    });
    return approvals.samples >= 200 && approvals.hits === approvals.samples;
  }
);

const approvalSchema = z.object({
  approved: z.boolean(),
  editedReply: z.string().optional(),
  tasteNote: z.string().optional(),
});

const conversationFlow = H.flow('triage-and-reply')
  .for(Conversation)
  .does(async ctx => {
    const message = ctx.unit.data.latest;
    await ctx.move('classifying');
    const classified = await ctx.run(classifier, { message });
    if (!classified.ok) return ctx.fail(classified.error);
    const category = classified.value.category;
    ctx.tag({ category });
    await ctx.update({ category });

    await ctx.move('drafting');
    const draft = await ctx.run(drafter, { message, category }, { scope: { skills: [category] } });
    if (!draft.ok) return ctx.fail(draft.error);
    const model = draft.model ?? sonnet.name;
    ctx.tag({ model });

    let reply = draft.value.reply;
    const safe = await ctx.decide(safeToSend, { category, model });
    if (!safe) {
      await ctx.move('awaiting-approval');
      const decision = await ctx.halt({ name: 'approve-reply', show: reply, decision: approvalSchema });
      if (decision.tasteNote) {
        await ctx.remember(taste, { text: decision.tasteNote, when: { roles: [drafterRole] } });
      }
      if (!decision.approved) return 'new';
      reply = decision.editedReply ?? reply;
    }

    const sent = await ctx.run(sendReply, { conversation: ctx.unit.key, text: reply });
    if (!sent.ok) return ctx.fail(sent.error);
    return 'sent';
  });

const escalationFlow = H.flow('human-escalation')
  .for(Escalation)
  .does(async ctx => {
    await ctx.move('with-human');
    await ctx.halt({
      name: 'handle-escalation',
      show: `Conversation ${ctx.unit.data.conversation}: ${ctx.unit.data.reason}`,
      decision: z.object({ resolution: z.string() }),
    });
    return 'resolved';
  });

const helpdeskToken = H.env('HELPDESK_TOKEN');

const helpdeskWebhook = http.webhook(Conversation, {
  path: '/hooks/helpdesk',
  secret: H.env('HELPDESK_WEBHOOK_SECRET'),
  body: z.object({
    event: z.enum(['created', 'replied', 'closed']),
    conversationId: z.string(),
    customer: z.string(),
    text: z.string(),
    slaDue: z.string(),
  }),
  read: body =>
    body.event === 'created'
      ? {
          create: { customer: body.customer, latest: body.text, slaDue: new Date(body.slaDue) },
          key: body.conversationId,
        }
      : body.event === 'replied'
        ? { update: body.conversationId, patch: { latest: body.text }, state: 'new' }
        : { update: body.conversationId, state: 'closed-by-customer' },
});

const helpdeskPoll = http.poll(Conversation, {
  url: 'https://helpdesk.example.com/api/conversations?status=open',
  every: { minutes: 10 },
  headers: { Authorization: helpdeskToken },
  body: z.object({
    conversations: z.array(
      z.object({ id: z.string(), customer: z.string(), lastMessage: z.string(), slaDue: z.string() })
    ),
  }),
  read: body =>
    body.conversations.map(conversation => ({
      create: {
        customer: conversation.customer,
        latest: conversation.lastMessage,
        slaDue: new Date(conversation.slaDue),
      },
      key: conversation.id,
    })),
});

const helpdeskStore = http.store(Conversation, {
  url: 'https://helpdesk.example.com/api/conversations',
  headers: { Authorization: helpdeskToken },
  stateField: 'harness_state',
});

const conversations = H.lane('conversations', Conversation)
  .handler(conversationFlow)
  .suppliers(helpdeskWebhook, helpdeskPoll)
  .store(helpdeskStore)
  .maxUsdPerUnit(0.4);

const escalations = H.lane('escalations', Escalation).handler(escalationFlow);

const slaBreach = H.trigger(
  'sla-breach-escalates',
  H.on.deadline(Conversation, data => data.slaDue, ['new', 'classifying', 'drafting', 'awaiting-approval']),
  (event, act) => [
    act.create(
      escalations,
      { conversation: event.unit.key, reason: `SLA breached at ${event.at.toISOString()}` },
      { key: `escalation-${event.unit.key}` }
    ),
    act.move('escalated'),
  ]
);

const timeToBreach = H.policy.scheduler('time-to-breach', view => {
  const due = (unit: PendingView) => (unit.is(Conversation) ? unit.data.slaDue.getTime() : view.now.getTime());
  return { start: [...view.pending].sort((a, b) => due(a) - due(b)) };
});

const pool = H.pool(
  'api',
  [{ account: anthropic.account('support-api', { apiKey: H.env('ANTHROPIC_API_KEY') }), share: 1 }],
  H.policy.account('first-eligible', choice => {
    const eligible = choice.accounts.find(view => view.eligible);
    return eligible ? eligible.account : null;
  })
);

const supervisor = claudeCode.supervisor({
  grants: [
    H.ops.readWork,
    H.ops.writeWork,
    H.ops.resolveHalts,
    H.ops.readMemory,
    H.ops.writeMemory,
    H.ops.readTelemetry,
  ],
});

export const supportTriage = H.harness('support-triage')
  .ledger(sqlite.ledger('.harness/ledger.sqlite'))
  .lanes(conversations, escalations)
  .pools(pool)
  .triggers(slaBreach)
  .scheduler(timeToBreach)
  .clients(supervisor)
  .observers(markdown.board('BOARD.md'));
