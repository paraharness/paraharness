import { z } from 'zod';
import { H, type PendingView, type EntryFilter, type SupplyOf } from 'harness-dsl';
import * as anthropic from 'harness-dsl/anthropic';
import * as cc from 'harness-dsl/claude-code';
import * as http from 'harness-dsl/http';
import * as sqlite from 'harness-dsl/sqlite';
import * as jsonl from 'harness-dsl/jsonl';
import * as shell from 'harness-dsl/shell';
import * as markdown from 'harness-dsl/markdown';

const New = H.state('new', 'pending');
const Classifying = H.state('classifying', 'active');
const Drafting = H.state('drafting', 'active');
const AwaitingApproval = H.state('awaiting-approval', 'active');
const Sent = H.state('sent', 'terminal', 'success');
const ClosedByCustomer = H.state('closed', 'terminal', 'neutral');
const Escalated = H.state('escalated', 'terminal', 'failure');
const Open = H.state('open', 'pending');
const Handling = H.state('handling', 'active');
const Resolved = H.state('resolved', 'terminal', 'success');

const Conversation = H.kind('conversation')
  .data(z.object({
    id: z.string(),
    customer: z.string(),
    subject: z.string(),
    lastMessage: z.string(),
    slaDue: z.string(),
    category: z.string().optional(),
  }))
  .states(New, Classifying, Drafting, AwaitingApproval, Sent, ClosedByCustomer, Escalated);

const Escalation = H.kind('escalation')
  .data(z.object({ conversation: z.string(), reason: z.string(), resolution: z.string().optional() }))
  .states(Open, Handling, Resolved);

const helpdeskConversation = z.object({
  id: z.string(),
  customer: z.string(),
  subject: z.string(),
  last_message: z.string(),
  sla_due: z.string(),
});
type HelpdeskConversation = z.infer<typeof helpdeskConversation>;

const helpdeskEvent = z.object({
  type: z.enum(['conversation.created', 'message.created', 'conversation.closed']),
  conversation: helpdeskConversation,
});
type HelpdeskEvent = z.infer<typeof helpdeskEvent>;

const toConversation = (c: HelpdeskConversation) => ({
  id: c.id,
  customer: c.customer,
  subject: c.subject,
  lastMessage: c.last_message,
  slaDue: c.sla_due,
});

const fromEvent = (event: HelpdeskEvent): SupplyOf<typeof Conversation> | null => {
  switch (event.type) {
    case 'conversation.created':
      return { create: toConversation(event.conversation), key: event.conversation.id };
    case 'message.created':
      return { update: event.conversation.id, patch: { lastMessage: event.conversation.last_message }, state: 'new' };
    case 'conversation.closed':
      return { update: event.conversation.id, state: 'closed' };
  }
};

const helpdeskHeaders = { Authorization: H.env('HELPDESK_TOKEN') };

const helpdeskWebhook = http.webhook(Conversation, {
  path: '/helpdesk/events',
  secret: H.env('HELPDESK_WEBHOOK_SECRET'),
  body: helpdeskEvent,
  read: fromEvent,
});

const helpdeskPoll = http.poll(Conversation, {
  url: 'https://helpdesk.example.com/api/conversations?status=open',
  every: { minutes: 10 },
  headers: helpdeskHeaders,
  body: z.object({ conversations: z.array(helpdeskConversation) }),
  read: body => body.conversations.map(c => ({ create: toConversation(c), key: c.id })),
});

const helpdeskStore = http.store(Conversation, {
  url: 'https://helpdesk.example.com/api/conversations',
  headers: helpdeskHeaders,
  stateField: 'harness_state',
});

const category = z.enum(['billing', 'refund', 'technical', 'account', 'other']);

const classifierRole = H.role('classifier')
  .input(z.object({ subject: z.string(), message: z.string() }))
  .output(z.object({ category }))
  .prompt(i => `Classify this support message.\nSubject: ${i.subject}\n\n${i.message}`);

const drafterRole = H.role('drafter')
  .input(z.object({ customer: z.string(), category: z.string(), message: z.string() }))
  .output(z.object({ reply: z.string() }))
  .prompt(i => `Draft a reply to ${i.customer} about a ${i.category} question.\n\n${i.message}`);

const taste = H.memory('taste', 'taste');
const experience = H.memory('experience', 'experience');
const tasteLibrary = H.library('reply-taste', taste, jsonl.memory('memory/taste.jsonl'));
const experienceLibrary = H.library('support-experience', experience, jsonl.memory('memory/experience.jsonl'));

const haiku = anthropic.model('claude-haiku-4-5');
const sonnet = anthropic.model('claude-sonnet-4-5');
const opus = anthropic.model('claude-opus-4-1');

const approvals: EntryFilter = { entry: 'halt', halt: 'approve-reply', status: 'resolved' };
const approved: EntryFilter = { ...approvals, decision: { approved: true } };

const drafterModel = H.policy.model('drafter-by-approval-rate', choice => {
  const byModel = choice.metrics.rateBy({ among: approvals, count: approved, byTag: 'model', days: 30 });
  const current = byModel[sonnet.name];
  const lagging = (current?.samples ?? 0) >= 50 && (current?.value ?? 1) < 0.8;
  return lagging ? opus : sonnet;
});

const safeCategory = H.policy.rule('safe-category', (name: string, metrics) => {
  const record = metrics.rate({
    among: { ...approvals, tags: { category: name } },
    count: { ...approved, tags: { category: name } },
  });
  return record.samples >= 200 && record.hits === record.samples;
});

const classifier = H.agent('classifier', classifierRole).model(haiku);
const drafter = H.agent('drafter', drafterRole)
  .model(drafterModel)
  .recalls(tasteLibrary, experienceLibrary);

const local = shell.local('local', { slots: 4 });

const sendReply = H.command('send-reply')
  .input(z.object({ conversation: z.string(), body: z.string() }))
  .argv(i => ['helpdesk-reply', '--conversation', i.conversation, '--body', i.body])
  .on(local)
  .recovery('park');

const approvalDecision = z.object({
  approved: z.boolean(),
  editedReply: z.string().optional(),
  tasteNote: z.string().optional(),
});

const conversationFlow = H.flow('triage-and-reply').for(Conversation).does(async ctx => {
  const conversation = ctx.unit.data;
  await ctx.move('classifying');
  const classified = await ctx.run(classifier, { subject: conversation.subject, message: conversation.lastMessage });
  if (!classified.ok) return ctx.fail(classified.error);
  const chosen = classified.value.category;
  await ctx.update({ category: chosen });
  ctx.tag({ category: chosen });

  await ctx.move('drafting');
  const drafted = await ctx.run(
    drafter,
    { customer: conversation.customer, category: chosen, message: conversation.lastMessage },
    { scope: { skills: [chosen] } },
  );
  if (!drafted.ok) return ctx.fail(drafted.error);
  ctx.tag({ category: chosen, model: drafted.model ?? 'unknown' });

  let reply = drafted.value.reply;
  const safe = await ctx.decide(safeCategory, chosen);
  if (!safe) {
    await ctx.move('awaiting-approval');
    const decision = await ctx.halt({ name: 'approve-reply', show: reply, decision: approvalDecision });
    if (decision.tasteNote !== undefined) {
      await ctx.remember(tasteLibrary, { text: decision.tasteNote, when: { roles: [drafterRole.name] } });
    }
    if (!decision.approved) return 'escalated';
    reply = decision.editedReply ?? reply;
  }

  const sent = await ctx.run(sendReply, { conversation: conversation.id, body: reply });
  if (!sent.ok) return ctx.fail(sent.error);
  return 'sent';
});

const escalationFlow = H.flow('escalation-by-hand').for(Escalation).does(async ctx => {
  await ctx.move('handling');
  const outcome = await ctx.halt({
    name: 'handle-escalation',
    show: `Conversation ${ctx.unit.data.conversation}: ${ctx.unit.data.reason}`,
    decision: z.object({ resolution: z.string() }),
  });
  await ctx.update({ resolution: outcome.resolution });
  return 'resolved';
});

const conversations = H.lane('conversations', Conversation)
  .handler(conversationFlow)
  .suppliers(helpdeskWebhook, helpdeskPoll)
  .store(helpdeskStore)
  .maxUsdPerUnit(0.4);

const escalations = H.lane('escalations', Escalation)
  .handler(escalationFlow);

const slaBreachEscalates = H.trigger(
  'sla-breach-escalates',
  H.on.deadline(Conversation, data => new Date(data.slaDue), ['new', 'classifying', 'drafting', 'awaiting-approval']),
  (_event, act) => act.move('escalated'),
);

const escalatedOpensEscalation = H.trigger(
  'escalated-opens-escalation',
  H.on.enters(Conversation, 'escalated'),
  (event, act) => act.create(escalations, {
    conversation: event.unit.key,
    reason: `Escalated at ${event.at.toISOString()} with SLA due ${event.unit.data.slaDue}`,
  }, `escalation-${event.unit.key}`),
);

const timeToBreachMs = (unit: PendingView, now: Date): number =>
  unit.is(Conversation) ? Date.parse(unit.data.slaDue) - now.getTime() : Number.NEGATIVE_INFINITY;

const scheduler = H.policy.scheduler('soonest-breach-first', view => ({
  start: [...view.pending].sort((a, b) => timeToBreachMs(a, view.now) - timeToBreachMs(b, view.now)),
}));

const api = H.pool('anthropic', [
  { account: anthropic.account('support-api', { apiKey: H.env('ANTHROPIC_API_KEY') }), share: 1 },
]);

export const harness = H.harness('support-triage')
  .ledger(sqlite.ledger('.harness/support-ledger.db'))
  .lanes(conversations, escalations)
  .pools(api)
  .triggers(slaBreachEscalates, escalatedOpensEscalation)
  .scheduler(scheduler)
  .clients(cc.supervisor({
    grants: [H.ops.readWork, H.ops.writeWork, H.ops.resolveHalts, H.ops.writeMemory, H.ops.readMemory, H.ops.readTelemetry],
  }))
  .observers(markdown.board('BOARD.md'), markdown.telemetry('TELEMETRY.md'));
