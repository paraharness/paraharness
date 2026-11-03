import { z } from 'zod';
import { H, PendingView, Metrics } from 'harness-dsl';
import * as anthropic from 'harness-dsl/anthropic';
import * as http from 'harness-dsl/http';
import * as sqlite from 'harness-dsl/sqlite';
import * as jsonl from 'harness-dsl/jsonl';
import * as shell from 'harness-dsl/shell';
import * as claudeCode from 'harness-dsl/claude-code';
import * as markdown from 'harness-dsl/markdown';

const conversation = z.object({
  conversationId: z.string(),
  customer: z.string(),
  message: z.string(),
  slaDueAt: z.string(),
  category: z.string().optional(),
});

const Conversation = H.kind('Conversation').data(conversation).states({
  new: 'pending',
  classifying: 'pending',
  drafting: 'active',
  'awaiting-approval': 'active',
  sent: 'succeeded',
  'closed-by-customer': 'ended',
  escalated: 'ended',
}, 'new');

const Escalation = H.kind('Escalation').data(z.object({
  conversationId: z.string(),
  reason: z.string(),
})).states({
  open: 'pending',
  handling: 'active',
  resolved: 'succeeded',
  abandoned: 'failed',
}, 'open');

const Taste = H.memory('taste', 'owner');
const Experience = H.memory('experience', 'fallible');
const taste = H.library('reply-taste', Taste, jsonl.memory('memory/taste.jsonl'));
const experience = H.library('support-experience', Experience, jsonl.memory('memory/experience.jsonl'));

const haiku = anthropic.model('claude-haiku');
const sonnet = anthropic.model('claude-sonnet');
const opus = anthropic.model('claude-opus');

const classifierRole = H.role('classifier')
  .input(z.object({ customer: z.string(), message: z.string() }))
  .output(z.object({ category: z.string() }))
  .prompt(input => `Classify this message from ${input.customer} into one support category:\n\n${input.message}`);

const drafterRole = H.role('drafter')
  .input(z.object({ customer: z.string(), message: z.string(), category: z.string() }))
  .output(z.object({ reply: z.string() }))
  .prompt(input => `Draft a reply to ${input.customer} about a ${input.category} issue:\n\n${input.message}`);

const draftApprovalRate = (metrics: Metrics) => metrics.rateBy({
  among: { entry: 'halt', halt: 'approve-reply', status: 'resolved' },
  count: { entry: 'halt', halt: 'approve-reply', status: 'resolved', decision: { approved: true } },
  by: { tag: 'draftModel' },
  days: 30,
});

const drafterModel = H.policy.model('drafter-model', choice => {
  const byModel = draftApprovalRate(choice.metrics);
  const challenger = byModel[opus.name];
  const incumbent = byModel[sonnet.name];
  if (!challenger || challenger.samples < 30 || !incumbent || incumbent.samples < 30) return sonnet;
  return (challenger.value ?? 0) > (incumbent.value ?? 0) + 0.05 ? opus : sonnet;
});

const classifier = H.agent('classifier', classifierRole).model(haiku);
const drafter = H.agent('drafter', drafterRole).model(drafterModel).recalls(taste, experience);

const safeCategory = H.policy.rule('safe-category', (input: { readonly category: string }, metrics: Metrics) => {
  const approvals = metrics.rate({
    among: { entry: 'halt', halt: 'approve-reply', status: 'resolved', tags: { category: input.category } },
    count: { entry: 'halt', halt: 'approve-reply', status: 'resolved', tags: { category: input.category }, decision: { approved: true } },
  });
  return approvals.samples >= 200 && approvals.hits === approvals.samples;
});

const local = shell.local('local', { slots: 8 });
const sendReply = H.command('send-reply')
  .input(z.object({ conversationId: z.string(), reply: z.string() }))
  .argv(input => ['helpdesk-cli', 'reply', input.conversationId, '--body', input.reply, '--token', H.env('HELPDESK_TOKEN')])
  .on(local);

const conversationFlow = H.flow('triage')
  .for(Conversation)
  .does(async ctx => {
    const { conversationId, customer, message } = ctx.unit.data;
    const classified = await ctx.run(classifier, { customer, message });
    if (!classified.ok) return 'escalated';
    const category = classified.value.category;
    await ctx.update({ category });
    await ctx.move('drafting');
    const draft = await ctx.run(drafter, { customer, message, category }, { scope: { skills: [category] } });
    if (!draft.ok) return 'escalated';
    ctx.tag({ category, draftModel: draft.model ?? 'unknown' });
    let reply = draft.value.reply;
    const safe = await ctx.decide(safeCategory, { category });
    if (!safe) {
      await ctx.move('awaiting-approval');
      const review = await ctx.halt({
        name: 'approve-reply',
        show: reply,
        decision: z.object({
          approved: z.boolean(),
          editedReply: z.string().optional(),
          tasteNote: z.string().optional(),
        }),
      });
      if (review.tasteNote) {
        await ctx.remember(taste, {
          text: review.tasteNote,
          status: 'candidate',
          when: { kinds: [Conversation.name], roles: [drafterRole.name] },
        });
      }
      if (!review.approved) return 'classifying';
      reply = review.editedReply ?? reply;
    }
    const sent = await ctx.run(sendReply, { conversationId, reply });
    return sent.ok ? 'sent' : 'escalated';
  });

const escalationFlow = H.flow('human-escalation')
  .for(Escalation)
  .does(async ctx => {
    await ctx.move('handling');
    const outcome = await ctx.halt({
      name: 'handle-escalation',
      show: `Conversation ${ctx.unit.data.conversationId}: ${ctx.unit.data.reason}`,
      decision: z.object({ resolved: z.boolean() }),
    });
    return outcome.resolved ? 'resolved' : 'abandoned';
  });

const helpdeskEvent = z.object({
  event: z.enum(['created', 'customer-replied', 'closed']),
  conversationId: z.string(),
  customer: z.string(),
  message: z.string(),
  slaDueAt: z.string(),
});

const helpdeskHeaders = { authorization: H.env('HELPDESK_TOKEN') };

const conversationLane = H.lane('conversations', Conversation)
  .handler(conversationFlow)
  .suppliers(
    http.webhook(Conversation, {
      path: '/hooks/helpdesk',
      secret: H.env('HELPDESK_WEBHOOK_SECRET'),
      body: helpdeskEvent,
      read: event => event.event === 'created'
        ? {
            create: { conversationId: event.conversationId, customer: event.customer, message: event.message, slaDueAt: event.slaDueAt },
            key: event.conversationId,
          }
        : event.event === 'customer-replied'
          ? { update: event.conversationId, patch: { message: event.message }, state: 'classifying' }
          : { update: event.conversationId, state: 'closed-by-customer' },
    }),
    http.poll(Conversation, {
      url: 'https://helpdesk.example.com/api/conversations?status=open',
      every: { minutes: 10 },
      headers: helpdeskHeaders,
      body: z.object({ conversations: z.array(helpdeskEvent) }),
      read: body => body.conversations.map(c => ({
        create: { conversationId: c.conversationId, customer: c.customer, message: c.message, slaDueAt: c.slaDueAt },
        key: c.conversationId,
      })),
    }),
  )
  .store(http.store(Conversation, {
    url: 'https://helpdesk.example.com/api/conversations',
    headers: helpdeskHeaders,
    stateField: 'harness_state',
  }))
  .maxUsdPerUnit(0.4);

const escalationLane = H.lane('escalations', Escalation).handler(escalationFlow);

const slaBreachEscalates = H.trigger(
  'sla-breach-escalates',
  H.on.deadline(Conversation, data => new Date(data.slaDueAt), ['new', 'classifying', 'drafting', 'awaiting-approval']),
  (event, act) => [
    act.create(escalationLane, { conversationId: event.unit.data.conversationId, reason: 'SLA breached' }, `sla-${event.unit.key}`),
    act.move('escalated'),
  ],
);

const timeToBreach = (unit: PendingView): number =>
  unit.is(Conversation) ? Date.parse(unit.data.slaDueAt) : -Infinity;

const scheduler = H.policy.schedule('time-to-breach', view => ({
  start: [...view.pending].sort((a, b) => timeToBreach(a) - timeToBreach(b)),
}));

const pool = H.pool('anthropic', [
  { account: anthropic.account('support-api', { apiKey: H.env('ANTHROPIC_API_KEY') }), share: 1 },
], H.policy.account('first-eligible', choice => choice.accounts.find(view => view.eligible)?.account ?? null));

export const harness = H.harness('support-triage')
  .ledger(sqlite.ledger('.harness/ledger.db'))
  .lanes(conversationLane, escalationLane)
  .pools(pool)
  .triggers(slaBreachEscalates)
  .scheduler(scheduler)
  .clients(claudeCode.supervisor({
    grants: [H.ops.readWork, H.ops.resolveHalts, H.ops.readMemory, H.ops.writeMemory, H.ops.curateMemory, H.ops.readTelemetry],
  }))
  .observers(markdown.board('BOARD.md'), markdown.telemetry('TELEMETRY.md'));
