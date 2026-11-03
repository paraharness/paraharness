import { H, type EntryFilter, type Rate } from 'harness-dsl';
import * as cc from 'harness-dsl/claude-code';
import * as anthropic from 'harness-dsl/anthropic';
import * as http from 'harness-dsl/http';
import * as sqlite from 'harness-dsl/sqlite';
import * as jsonl from 'harness-dsl/jsonl';
import * as shell from 'harness-dsl/shell';
import * as markdown from 'harness-dsl/markdown';
import { z } from 'zod';

const conversationPayload = z.object({
  id: z.string(),
  customer: z.string(),
  subject: z.string(),
  messages: z.array(z.string()),
  slaDueAt: z.string(),
});

export const Conversation = H.kind('Conversation')
  .data(conversationPayload.extend({ category: z.string().optional() }))
  .states(
    [
      H.state('new', 'pending'),
      H.state('classifying', 'active'),
      H.state('drafting', 'active'),
      H.state('awaiting-approval', 'active'),
      H.state('sent', 'terminal', 'success'),
      H.state('closed-by-customer', 'terminal', 'neutral'),
      H.state('escalated', 'terminal', 'neutral'),
    ],
    { initial: 'new', afterFailure: 'escalated' }
  );

export const Escalation = H.kind('Escalation')
  .data(z.object({ conversation: z.string(), customer: z.string(), reason: z.string(), resolution: z.string().optional() }))
  .states(
    [H.state('open', 'pending'), H.state('handling', 'active'), H.state('resolved', 'terminal', 'success')],
    { initial: 'open', afterFailure: 'open' }
  );

const classifierRole = H.role('classifier')
  .input(z.object({ subject: z.string(), messages: z.array(z.string()) }))
  .output(z.object({ category: z.string() }))
  .prompt(i => `Classify this support conversation into one category.\nSubject: ${i.subject}\n\n${i.messages.join('\n---\n')}`);

const drafterRole = H.role('drafter')
  .input(z.object({ category: z.string(), messages: z.array(z.string()), notes: z.array(z.string()) }))
  .output(z.object({ reply: z.string() }))
  .prompt(i => `Draft a reply for a ${i.category} conversation.\n\n${i.messages.join('\n---\n')}\n\nReviewer notes:\n${i.notes.join('\n')}`);

const taste = H.memory('taste', 'owner');
const experience = H.memory('experience', 'fallible');

const mostSpecificFirst = H.policy.recall('most-specific-then-track-record', view =>
  [...view.items]
    .sort((a, b) => b.specificity - a.specificity || (b.trackRecord.value ?? 0) - (a.trackRecord.value ?? 0))
    .slice(0, 10)
);

const tasteLibrary = H.library('reply-taste', taste, jsonl.memory('.harness/taste.jsonl')).recall(mostSpecificFirst);
const experienceLibrary = H.library('support-experience', experience, jsonl.memory('.harness/experience.jsonl')).recall(mostSpecificFirst);

const haiku = anthropic.model('claude-haiku-4-5');
const sonnet = anthropic.model('claude-sonnet-4-5');
const opus = anthropic.model('claude-opus-4-1');

const resolvedApprovals: EntryFilter = { entry: 'halt', halt: 'approve-reply', status: 'resolved' };
const approvedReplies: EntryFilter = { ...resolvedApprovals, decision: { approved: true } };
const unsampled: Rate = { value: null, hits: 0, samples: 0 };

const drafterModel = H.policy.model('higher-approval-rate-drafter', choice => {
  const byModel = choice.metrics.rateBy({ among: resolvedApprovals, count: approvedReplies, by: { tag: 'drafter' }, days: 30 });
  const sonnetRate = byModel[sonnet.name] ?? unsampled;
  const opusRate = byModel[opus.name] ?? unsampled;
  if (sonnetRate.samples < 50 || opusRate.samples < 50) return sonnetRate.samples <= opusRate.samples ? sonnet : opus;
  return (opusRate.value ?? 0) > (sonnetRate.value ?? 0) ? opus : sonnet;
});

const classifier = H.agent('classifier', classifierRole).model(haiku);
const drafter = H.agent('drafter', drafterRole).model(drafterModel).recalls(tasteLibrary, experienceLibrary);

const safeCategory = H.policy.rule('safe-category-after-200-clean-approvals', (input: { readonly category: string }, metrics) => {
  const record = metrics.rate({
    among: { ...resolvedApprovals, tags: { category: input.category } },
    count: { ...approvedReplies, tags: { category: input.category } },
  });
  return record.hits >= 200 && record.hits === record.samples;
});

const local = shell.local('local', { slots: 4 });

const sendReply = H.command('send-reply')
  .input(z.object({ conversation: z.string(), reply: z.string() }))
  .argv(i => ['helpdesk', 'reply', '--token', H.env('HELPDESK_TOKEN'), i.conversation, i.reply])
  .on(local);

const triage = H.flow('triage-and-reply')
  .for(Conversation)
  .does(async ctx => {
    await ctx.move('classifying');
    const { id, subject, messages } = ctx.unit.data;
    const classified = await ctx.run(classifier, { subject, messages });
    if (!classified.ok) return ctx.fail(classified.error);
    const category = classified.value.category;
    await ctx.update({ category });
    ctx.tag({ category });

    let notes: string[] = [];
    for (let draftNumber = 1; draftNumber <= 3; draftNumber++) {
      await ctx.move('drafting');
      const drafted = await ctx.run(drafter, { category, messages, notes }, { scope: { skills: [category] } });
      if (!drafted.ok) return ctx.fail(drafted.error);
      ctx.tag({ drafter: drafted.model ?? 'unknown' });

      if (await ctx.decide(safeCategory, { category })) {
        const sent = await ctx.run(sendReply, { conversation: id, reply: drafted.value.reply });
        return sent.ok ? 'sent' : ctx.fail(sent.error);
      }

      await ctx.move('awaiting-approval');
      const review = await ctx.halt({
        name: 'approve-reply',
        show: drafted.value.reply,
        decision: z.object({
          approved: z.boolean(),
          editedReply: z.string().optional(),
          notes: z.string().optional(),
          tasteNote: z.string().optional(),
        }),
      });
      if (review.tasteNote) {
        await ctx.remember(tasteLibrary, {
          text: review.tasteNote,
          when: { kinds: [Conversation.name], roles: [drafterRole.name] },
          status: 'accepted',
        });
      }
      if (review.approved) {
        const sent = await ctx.run(sendReply, { conversation: id, reply: review.editedReply ?? drafted.value.reply });
        return sent.ok ? 'sent' : ctx.fail(sent.error);
      }
      notes = [...notes, review.notes ?? 'returned without notes'];
    }
    return 'escalated';
  });

const humanEscalation = H.flow('human-escalation')
  .for(Escalation)
  .does(async ctx => {
    await ctx.move('handling');
    const outcome = await ctx.halt({
      name: 'handle-escalation',
      show: `${ctx.unit.data.customer}: ${ctx.unit.data.reason}`,
      decision: z.object({ resolution: z.string() }),
    });
    await ctx.update({ resolution: outcome.resolution });
    return 'resolved';
  });

const helpdeskAuth = H.env('HELPDESK_AUTH');

const helpdeskWebhook = http.webhook(Conversation, {
  path: '/hooks/helpdesk',
  secret: H.env('HELPDESK_WEBHOOK_SECRET'),
  body: z.object({ type: z.enum(['created', 'customer_replied', 'closed']), conversation: conversationPayload }),
  read: body => {
    const conversation = body.conversation;
    if (body.type === 'created') return { create: conversation, key: conversation.id };
    if (body.type === 'customer_replied') {
      return { update: conversation.id, patch: { messages: conversation.messages }, state: 'new' };
    }
    return { update: conversation.id, state: 'closed-by-customer' };
  },
});

const helpdeskPoll = http.poll(Conversation, {
  url: 'https://helpdesk.example.com/api/conversations?status=open',
  every: { minutes: 10 },
  headers: { Authorization: helpdeskAuth },
  body: z.object({ conversations: z.array(conversationPayload) }),
  read: body => body.conversations.map(conversation => ({ create: conversation, key: conversation.id })),
});

const helpdeskStore = http.store(Conversation, {
  url: 'https://helpdesk.example.com/api/conversations',
  headers: { Authorization: helpdeskAuth },
  stateField: 'harness_state',
});

const conversationLane = H.lane('conversations', Conversation)
  .handler(triage)
  .suppliers(helpdeskWebhook, helpdeskPoll)
  .store(helpdeskStore)
  .maxUsdPerUnit(0.4);

const escalationLane = H.lane('escalations', Escalation).handler(humanEscalation);

const slaBreachEscalates = H.trigger(
  'sla-breach-escalates',
  H.on.deadline(Conversation, data => new Date(data.slaDueAt), ['new', 'classifying', 'drafting', 'awaiting-approval']),
  (_event, act) => act.move('escalated')
);

const escalatedOpensEscalation = H.trigger('escalated-opens-escalation', H.on.enters(Conversation, 'escalated'), (event, act) =>
  act.create(
    escalationLane,
    {
      conversation: event.unit.data.id,
      customer: event.unit.data.customer,
      reason: `escalated from ${event.unit.data.subject}`,
    },
    { key: `escalation-${event.unit.data.id}`, tags: { category: event.unit.data.category ?? 'unclassified' } }
  )
);

const scheduler = H.policy.scheduler('escalations-then-time-to-breach', view => {
  const timeToBreachMs = (unit: (typeof view.pending)[number]) =>
    unit.is(Conversation) ? Date.parse(unit.data.slaDueAt) - view.now.getTime() : -Infinity;
  return { start: [...view.pending].sort((a, b) => timeToBreachMs(a) - timeToBreachMs(b)) };
});

const apiAccount = anthropic.account('anthropic-api', { apiKey: H.env('ANTHROPIC_API_KEY') });
const firstEligible = H.policy.account('first-eligible', choice => choice.accounts.find(view => view.eligible)?.account ?? null);

const supervisor = cc.supervisor({
  grants: [H.ops.readWork, H.ops.writeWork, H.ops.resolveHalts, H.ops.writeMemory, H.ops.readMemory, H.ops.readTelemetry],
});

export const supportTriage = H.harness('support-triage')
  .ledger(sqlite.ledger('.harness/ledger.db'))
  .lanes(conversationLane, escalationLane)
  .pools(H.pool('anthropic', [{ account: apiAccount, share: 1 }], firstEligible))
  .triggers(slaBreachEscalates, escalatedOpensEscalation)
  .scheduler(scheduler)
  .clients(supervisor)
  .observers(markdown.board('BOARD.md'), markdown.telemetry('TELEMETRY.md'));
