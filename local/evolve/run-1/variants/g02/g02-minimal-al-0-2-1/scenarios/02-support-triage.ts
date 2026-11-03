import { H } from 'harness-dsl';
import type { PendingView, Rate } from 'harness-dsl';
import { z } from 'zod';
import * as claudeCode from 'harness-dsl/claude-code';
import * as anthropic from 'harness-dsl/anthropic';
import * as http from 'harness-dsl/http';
import * as sqlite from 'harness-dsl/sqlite';
import * as jsonl from 'harness-dsl/jsonl';
import * as shell from 'harness-dsl/shell';
import * as markdown from 'harness-dsl/markdown';

const New = H.state('new', 'pending');
const Classifying = H.state('classifying', 'pending');
const Drafting = H.state('drafting', 'active');
const AwaitingApproval = H.state('awaiting-approval', 'active');
const Sent = H.state('sent', 'terminal', 'success');
const Closed = H.state('closed', 'terminal', 'neutral');
const Escalated = H.state('escalated', 'terminal', 'failure');

const Open = H.state('open', 'pending');
const Resolved = H.state('resolved', 'terminal', 'success');

const Conversation = H.kind('conversation')
  .data(z.object({
    customer: z.string(),
    lastMessage: z.string(),
    slaDue: z.string(),
    category: z.string().optional(),
  }))
  .states(New, Classifying, Drafting, AwaitingApproval, Sent, Closed, Escalated);

const Escalation = H.kind('escalation')
  .data(z.object({ conversation: z.string(), reason: z.string() }))
  .states(Open, Resolved);

const tasteMemory = H.memory('reply-taste', 'taste');
const experienceMemory = H.memory('support-experience', 'experience');
const taste = H.library('reply-taste', tasteMemory, jsonl.memory('memory/taste.jsonl'));
const experience = H.library('support-experience', experienceMemory, jsonl.memory('memory/experience.jsonl'));

const haiku = anthropic.model('claude-haiku-4-5');
const sonnet = anthropic.model('claude-sonnet-4-5');
const opus = anthropic.model('claude-opus-4-1');
const accounts = H.pool('anthropic', [{ account: anthropic.account('api', { apiKey: H.env('ANTHROPIC_API_KEY') }), share: 1 }]);

const local = shell.local('local', { slots: 4 });

const approveReply = H.decision('approve-reply')
  .input(z.object({ conversation: z.string(), category: z.string(), model: z.string(), reply: z.string() }))
  .output(z.object({ approved: z.boolean(), editedReply: z.string().optional(), tasteNote: z.string().optional() }))
  .show(i => `[${i.category}] ${i.reply}`)
  .policy((input, metrics, self) => {
    const history = metrics.rateBy({
      among: self.resolved(undefined, 'human'),
      count: self.resolved({ approved: true }, 'human'),
      by: H.by.input(self, 'category'),
      days: 365,
    });
    const record: Rate | undefined = history[input.category];
    return record === undefined || record.samples < 200 || record.hits < record.samples ? H.ask : { approved: true };
  });

const resolveEscalation = H.decision('resolve-escalation')
  .input(z.object({ conversation: z.string(), reason: z.string() }))
  .output(z.object({ resolution: z.string() }))
  .show(i => `Conversation ${i.conversation} escalated: ${i.reason}`);

const drafterByApproval = H.policy.model('drafter-by-approval', choice => {
  const byModel = choice.metrics.rateBy({
    among: approveReply.resolved(undefined, 'human'),
    count: approveReply.resolved({ approved: true }, 'human'),
    by: H.by.input(approveReply, 'model'),
    days: 30,
  });
  const primary: Rate | undefined = byModel[sonnet.name];
  if (primary === undefined || primary.samples < 50 || primary.value === null) return sonnet;
  return primary.value < 0.8 ? opus : sonnet;
});

const classifierRole = H.role('classifier')
  .input(z.object({ message: z.string() }))
  .output(z.object({ category: z.string() }))
  .prompt(i => `Classify this customer message into one support category.\n\n${i.message}`);

const drafterRole = H.role('drafter')
  .input(z.object({ message: z.string(), category: z.string() }))
  .output(z.object({ reply: z.string() }))
  .prompt(i => `Draft a reply to this ${i.category} message.\n\n${i.message}`);

const classifier = H.agent('classifier', classifierRole).model(haiku);
const drafter = H.agent('drafter', drafterRole).model(drafterByApproval).recalls(taste, experience);

const helpdeskHeaders = { 'X-Api-Key': H.env('HELPDESK_API_KEY') };

const sendReply = H.command('send-reply')
  .input(z.object({ conversation: z.string(), reply: z.string() }))
  .argv(i => ['helpdesk-send', '--conversation', i.conversation, '--body', i.reply])
  .on(local)
  .recover('park');

const conversationFlow = H.flow('triage-conversation').for(Conversation).does(async ctx => {
  const message = ctx.unit.data.lastMessage;
  const classified = await ctx.run(classifier, { message });
  if (classified.ok === false) return ctx.fail(classified.error);
  const category = classified.value.category;
  await ctx.update({ category });
  await ctx.move('drafting');
  const draft = await ctx.run(drafter, { message, category }, { scope: { skills: [category] } });
  if (draft.ok === false) return ctx.fail(draft.error);
  await ctx.move('awaiting-approval');
  const verdict = await ctx.decide(approveReply, {
    conversation: ctx.unit.key,
    category,
    model: draft.model ?? 'unknown',
    reply: draft.value.reply,
  });
  if (verdict.tasteNote) {
    await ctx.remember(taste, { text: verdict.tasteNote, when: { roles: [drafterRole.name] }, status: 'accepted' });
  }
  if (verdict.approved === false) return 'escalated';
  const sent = await ctx.run(sendReply, { conversation: ctx.unit.key, reply: verdict.editedReply ?? draft.value.reply });
  if (sent.ok === false) return ctx.fail(sent.error);
  return 'sent';
});

const escalationFlow = H.flow('handle-escalation').for(Escalation).does(async ctx => {
  await ctx.decide(resolveEscalation, { conversation: ctx.unit.data.conversation, reason: ctx.unit.data.reason });
  return 'resolved';
});

const helpdeskPush = http.webhook(Conversation, {
  path: '/helpdesk/events',
  secret: H.env('HELPDESK_WEBHOOK_SECRET'),
  body: z.discriminatedUnion('event', [
    z.object({ event: z.literal('created'), conversation: z.string(), customer: z.string(), message: z.string(), slaDue: z.string() }),
    z.object({ event: z.literal('replied'), conversation: z.string(), message: z.string() }),
    z.object({ event: z.literal('closed'), conversation: z.string() }),
  ]),
  read: body => {
    if (body.event === 'created') {
      return { create: { customer: body.customer, lastMessage: body.message, slaDue: body.slaDue }, key: body.conversation };
    }
    if (body.event === 'replied') {
      return { update: body.conversation, patch: { lastMessage: body.message }, state: 'classifying' };
    }
    return { update: body.conversation, state: 'closed' };
  },
});

const helpdeskSweep = http.poll(Conversation, {
  url: 'https://helpdesk.example.com/api/conversations?status=open',
  every: { minutes: 10 },
  headers: helpdeskHeaders,
  body: z.object({
    conversations: z.array(z.object({ id: z.string(), customer: z.string(), message: z.string(), slaDue: z.string() })),
  }),
  read: body => body.conversations.map(c => ({
    create: { customer: c.customer, lastMessage: c.message, slaDue: c.slaDue },
    key: c.id,
  })),
});

const helpdeskStore = http.store(Conversation, {
  url: 'https://helpdesk.example.com/api/conversations',
  headers: helpdeskHeaders,
  stateField: 'triage_status',
});

const conversations = H.lane('conversations', Conversation)
  .handler(conversationFlow)
  .suppliers(helpdeskPush, helpdeskSweep)
  .store(helpdeskStore)
  .maxUsdPerUnit(0.4);

const escalations = H.lane('escalations', Escalation).handler(escalationFlow);

const slaBreachEscalates = H.trigger(
  'sla-breach-escalates',
  H.on.deadline(Conversation, data => new Date(data.slaDue), ['new', 'classifying', 'drafting', 'awaiting-approval']),
  (event, act) => [
    act.create(escalations, { conversation: event.unit.key, reason: 'SLA breached' }, event.unit.key),
    act.move('escalated'),
  ]
);

const timeToBreach = (unit: PendingView): number => {
  if (unit.is(Escalation)) return 0;
  if (unit.is(Conversation)) return Date.parse(unit.data.slaDue);
  return Number.MAX_SAFE_INTEGER;
};

const soonestBreachFirst = H.policy.scheduler('soonest-breach-first', view => ({
  start: [...view.pending].sort((a, b) => timeToBreach(a) - timeToBreach(b)),
}));

const supervisor = claudeCode.supervisor({
  grants: [H.ops.readWork, H.ops.writeWork, H.ops.resolveDecisions, H.ops.readMemory, H.ops.writeMemory, H.ops.readTelemetry],
});

export const supportTriage = H.harness('support-triage')
  .ledger(sqlite.ledger('harness/support.sqlite'))
  .lanes(conversations, escalations)
  .pools(accounts)
  .triggers(slaBreachEscalates)
  .scheduler(soonestBreachFirst)
  .clients(supervisor)
  .observers(markdown.board('BOARD.md'), markdown.telemetry('TELEMETRY.md'));
