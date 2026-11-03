import { z } from 'zod';
import { H } from 'harness-dsl';
import type { EntryFilter, Metrics, PendingView, Rate, SupplyOf } from 'harness-dsl';
import * as anthropic from 'harness-dsl/anthropic';
import * as claudeCode from 'harness-dsl/claude-code';
import * as http from 'harness-dsl/http';
import * as jsonl from 'harness-dsl/jsonl';
import * as sqlite from 'harness-dsl/sqlite';
import * as shell from 'harness-dsl/shell';
import * as markdown from 'harness-dsl/markdown';

const conversationsLane = 'conversations';
const auditTrigger = 'approval-audit';

const fresh = H.state('new', 'pending');
const classifying = H.state('classifying', 'active');
const drafting = H.state('drafting', 'active');
const awaitingApproval = H.state('awaiting-approval', 'active');
const sent = H.state('sent', 'waiting');
const closed = H.state('closed', 'terminal', 'success');
const escalated = H.state('escalated', 'terminal', 'neutral');

const Conversation = H.kind('Conversation')
  .data(z.object({
    id: z.string(),
    customer: z.string(),
    lastMessage: z.string(),
    slaDue: z.string(),
    category: z.string().optional(),
  }))
  .states(fresh, classifying, drafting, awaitingApproval, sent, closed, escalated);

const raised = H.state('raised', 'pending');
const handling = H.state('handling', 'active');
const resolved = H.state('resolved', 'terminal', 'success');
const Escalation = H.kind('Escalation')
  .data(z.object({ conversation: z.string(), reason: z.string() }))
  .states(raised, handling, resolved);

const open = H.state('open', 'pending');
const auditing = H.state('auditing', 'active');
const concluded = H.state('concluded', 'terminal', 'success');
const cancelled = H.state('cancelled', 'terminal', 'neutral');
const Audit = H.kind('Audit')
  .data(z.object({ category: z.string(), rateAtOpen: z.number() }))
  .states(open, auditing, concluded, cancelled);

const helpdeskHeaders = { Authorization: H.env('HELPDESK_TOKEN') };

const helpdeskEvent = z.object({
  conversationId: z.string(),
  event: z.enum(['created', 'customer-replied', 'closed']),
  customer: z.string(),
  message: z.string(),
  slaDue: z.string(),
});

function conversationSupply(body: z.infer<typeof helpdeskEvent>): SupplyOf<typeof Conversation> {
  switch (body.event) {
    case 'created':
      return {
        create: { id: body.conversationId, customer: body.customer, lastMessage: body.message, slaDue: body.slaDue },
        key: body.conversationId,
      };
    case 'customer-replied':
      return { update: body.conversationId, patch: { lastMessage: body.message }, state: 'new' };
    case 'closed':
      return { update: body.conversationId, state: 'closed' };
  }
}

const missedConversation = z.object({ id: z.string(), customer: z.string(), lastMessage: z.string(), slaDue: z.string() });
function missedSupply(c: z.infer<typeof missedConversation>): SupplyOf<typeof Conversation> {
  return { create: c, key: c.id };
}

const helpdeskHook = http.webhook(Conversation, {
  path: '/hooks/helpdesk',
  secret: H.env('HELPDESK_WEBHOOK_SECRET'),
  body: helpdeskEvent,
  read: conversationSupply,
});
const helpdeskSweep = http.poll(Conversation, {
  url: 'https://helpdesk.example.com/api/conversations?status=open',
  every: { minutes: 15 },
  headers: helpdeskHeaders,
  body: z.object({ conversations: z.array(missedConversation) }),
  read: body => body.conversations.map(missedSupply),
});
const helpdeskStore = http.store(Conversation, {
  url: 'https://helpdesk.example.com/api/conversations',
  headers: helpdeskHeaders,
  stateField: 'harness_state',
});

const tasteLibrary = H.library('reply-taste', H.memory('reply-taste', 'taste'), jsonl.memory('support/taste.jsonl'));
const experienceLibrary = H.library('support-experience', H.memory('support-lessons', 'experience'), jsonl.memory('support/experience.jsonl'));

const classification = H.role('classification')
  .input(z.object({ message: z.string() }))
  .output(z.object({ category: z.string() }))
  .prompt(c => `Classify this customer message into one support category.\n\n${c.message}`);
const replyDrafting = H.role('reply-drafting')
  .input(z.object({ message: z.string(), category: z.string() }))
  .output(z.object({ reply: z.string() }))
  .prompt(c => `Draft a reply for a ${c.category} conversation.\n\n${c.message}`);

const classifier = H.agent('classifier', classification).model(anthropic.model('claude-haiku-4-5'));
const drafter = H.agent('drafter', replyDrafting)
  .model(anthropic.model('claude-sonnet-4-5'))
  .recalls(tasteLibrary, experienceLibrary);

const local = shell.local('support-tools', { slots: 4 });
const sendReply = H.command('send-reply')
  .input(z.object({ conversation: z.string(), reply: z.string() }))
  .argv(r => ['helpdesk-reply', '--conversation', r.conversation, '--body', r.reply])
  .on(local)
  .recovery('park');

const approvals: EntryFilter = { entry: 'halt', halt: 'reply-approval', status: 'resolved' };
const approved: EntryFilter = { ...approvals, decision: { approved: true } };

const safeCategory = H.policy.rule('safe-category', (category: string, metrics) => {
  const record = metrics.rate({ among: { ...approvals, tags: { category } }, count: { ...approved, tags: { category } } });
  return record.samples >= 200 && record.hits === record.samples;
});

const approvalDecision = z.object({
  approved: z.boolean(),
  editedReply: z.string().optional(),
  tasteNote: z.string().optional(),
});

const conversationFlow = H.flow('conversation').for(Conversation).does(async ctx => {
  const c = ctx.unit.data;
  const classified = await ctx.run(classifier, { message: c.lastMessage });
  if (!classified.ok) return ctx.fail(classified.error);
  const category = classified.value.category;
  ctx.tag({ category });
  await ctx.update({ category });

  await ctx.move('drafting');
  const draft = await ctx.run(drafter, { message: c.lastMessage, category }, { scope: { skills: [category] } });
  if (!draft.ok) return ctx.fail(draft.error);

  let reply = draft.value.reply;
  if (!(await ctx.decide(safeCategory, category))) {
    await ctx.move('awaiting-approval');
    const review = await ctx.halt({ name: 'reply-approval', show: reply, decision: approvalDecision });
    if (review.tasteNote) {
      await ctx.remember(tasteLibrary, { text: review.tasteNote, when: { roles: [replyDrafting.name] }, status: 'candidate' });
    }
    if (!review.approved) {
      if (!review.editedReply) return 'escalated';
      reply = review.editedReply;
    }
  }

  const delivered = await ctx.run(sendReply, { conversation: c.id, reply });
  if (!delivered.ok) return ctx.fail(delivered.error);
  return 'sent';
});

const escalationFlow = H.flow('escalation').for(Escalation).does(async ctx => {
  await ctx.halt({
    name: 'escalation-handled',
    show: `Conversation ${ctx.unit.data.conversation}: ${ctx.unit.data.reason}`,
    decision: z.object({ resolution: z.string() }),
  });
  return 'resolved';
});

const auditOpenings: EntryFilter = { entry: 'firing', trigger: auditTrigger, status: 'tripped' };
const noSamples: Rate = { value: null, hits: 0, samples: 0 };

const auditDigest = H.policy.rule('audit-digest', (input: { readonly category: string; readonly since: Date }, metrics: Metrics) => {
  const opened = metrics.rateBy({ among: auditOpenings, count: auditOpenings, byTag: 'group', since: input.since });
  const paused = metrics.sum({ of: 'durationMs', among: { entry: 'lane', lane: conversationsLane, status: 'resumed' }, since: input.since });
  const audits = (opened[input.category] ?? noSamples).samples;
  const pausedMinutes = Math.round((paused.value ?? 0) / 60000);
  return `Audits opened for ${input.category} this month: ${audits}. Conversations lane paused ${pausedMinutes} minutes over ${paused.samples} pauses.`;
});

const auditFlow = H.flow('category-audit').for(Audit).does(async ctx => {
  const now = ctx.now();
  const audit = ctx.unit.data;
  const digest = await ctx.decide(auditDigest, { category: audit.category, since: new Date(now.getFullYear(), now.getMonth(), 1) });
  await ctx.halt({
    name: 'audit-findings',
    show: `Approval rate for ${audit.category} fell to ${audit.rateAtOpen.toFixed(2)}. ${digest}`,
    decision: z.object({ findings: z.string() }),
  });
  return 'concluded';
});

const conversations = H.lane(conversationsLane, Conversation)
  .handler(conversationFlow)
  .suppliers(helpdeskHook, helpdeskSweep, H.operator)
  .store(helpdeskStore)
  .maxUsdPerUnit(0.4);
const escalations = H.lane('escalations', Escalation).handler(escalationFlow);
const audits = H.lane('audits', Audit).handler(auditFlow);

const slaBreach = H.trigger(
  'sla-breach',
  H.on.deadline(Conversation, c => new Date(c.slaDue), ['new', 'classifying', 'drafting', 'awaiting-approval']),
  (_event, act) => act.move('escalated'),
);

const escalate = H.trigger('escalate', H.on.enters(Conversation, 'escalated'), (event, act) =>
  act.create(
    escalations,
    { conversation: event.unit.key, reason: `Escalated at ${event.at.toISOString()}; SLA due ${event.unit.data.slaDue}` },
    `escalation-${event.unit.key}`,
  ));

const approvalByCategory = (metrics: Metrics) =>
  metrics.rateBy({ among: approvals, count: approved, byTag: 'category', days: 7 });

const approvalAudit = H.trigger(
  auditTrigger,
  H.on.metric(approvalByCategory, { trip: { below: 0.9 }, reset: { above: 0.95 }, minSamples: 50 }),
  (event, act) =>
    event.state === 'tripped'
      ? [
          act.create(audits, { category: event.group, rateAtOpen: event.rate.value ?? 0 }, `audit-${event.group}`),
          act.remember(experienceLibrary, {
            text: `When drafting for ${event.group}, recall the stricter phrasing`,
            because: `approvals fell to ${(event.rate.value ?? 0).toFixed(2)} over ${event.rate.samples} samples`,
            when: { roles: [replyDrafting.name], skills: [event.group] },
            status: 'candidate',
          }),
        ]
      : act.move(audits, `audit-${event.group}`, 'cancelled'),
);

const modelCalls: EntryFilter = { entry: 'invocation', status: 'ended', mode: ['model', 'batch'] };
const modelErrorRate = (metrics: Metrics) => ({
  [conversationsLane]: metrics.rate({ among: modelCalls, count: { ...modelCalls, ok: false }, hours: 1 }),
});

const pauseOnModelErrors = H.trigger(
  'pause-on-model-errors',
  H.on.metric(modelErrorRate, { trip: { above: 0.2 }, reset: { below: 0.05 }, minSamples: 20 }),
  (event, act) => (event.state === 'tripped' ? act.pause(conversations) : act.resume(conversations)),
);

function urgency(unit: PendingView): number {
  if (unit.is(Conversation)) return new Date(unit.data.slaDue).getTime();
  return 0;
}
const timeToBreach = H.policy.scheduler('time-to-breach', view => ({
  start: [...view.pending].sort((x, y) => urgency(x) - urgency(y)),
}));

const reviewer = claudeCode.supervisor({
  grants: [
    H.ops.readWork,
    H.ops.writeWork,
    H.ops.resolveHalts,
    H.ops.writeMemory,
    H.ops.curateMemory,
    H.ops.readTelemetry,
  ],
});

export const running = H.harness('support-self-watch')
  .ledger(sqlite.ledger('support/ledger.db'))
  .lanes(conversations, escalations, audits)
  .pools(H.pool('support-api', [{ account: anthropic.account('support', { apiKey: H.env('ANTHROPIC_API_KEY') }), share: 1 }]))
  .triggers(slaBreach, escalate, approvalAudit, pauseOnModelErrors)
  .scheduler(timeToBreach)
  .clients(reviewer)
  .observers(markdown.board('support/BOARD.md'), markdown.telemetry('support/TELEMETRY.md'))
  .start();
