import { z } from 'zod';
import { H } from 'harness-dsl';
import type { Metrics, PendingView, SupplyOf } from 'harness-dsl';
import * as anthropic from 'harness-dsl/anthropic';
import * as claudeCode from 'harness-dsl/claude-code';
import * as http from 'harness-dsl/http';
import * as sqlite from 'harness-dsl/sqlite';
import * as jsonl from 'harness-dsl/jsonl';
import * as shell from 'harness-dsl/shell';
import * as markdown from 'harness-dsl/markdown';

const fresh = H.state('new', 'pending');
const classifying = H.state('classifying', 'active');
const drafting = H.state('drafting', 'active');
const awaitingApproval = H.state('awaiting-approval', 'active');
const sent = H.state('sent', 'terminal', 'success');
const closedByCustomer = H.state('closed-by-customer', 'terminal', 'neutral');
const escalated = H.state('escalated', 'terminal', 'failure');

const Conversation = H.kind('Conversation')
  .data(z.object({
    ticketId: z.string(),
    customer: z.string(),
    message: z.string(),
    slaDue: z.string(),
    category: z.string().optional(),
  }))
  .states(fresh, classifying, drafting, awaitingApproval, sent, closedByCustomer, escalated);

const escalationOpen = H.state('escalation-open', 'pending');
const handling = H.state('handling', 'active');
const resolved = H.state('resolved', 'terminal', 'success');

const Escalation = H.kind('Escalation')
  .data(z.object({ ticketId: z.string(), reason: z.string() }))
  .states(escalationOpen, handling, resolved);

const auditOpen = H.state('audit-open', 'pending');
const investigating = H.state('investigating', 'active');
const auditClosed = H.state('audit-closed', 'terminal', 'success');
const auditWithdrawn = H.state('audit-withdrawn', 'terminal', 'neutral');

const Audit = H.kind('Audit')
  .data(z.object({ category: z.string(), rate: z.number().nullable(), finding: z.string().optional() }))
  .states(auditOpen, investigating, auditClosed, auditWithdrawn);

const experience = H.memory('experience', 'experience');
const taste = H.memory('taste', 'taste');
const draftingLessons = H.library('drafting-lessons', experience, jsonl.memory('.harness/experience.jsonl'));
const replyTaste = H.library('reply-taste', taste, jsonl.memory('.harness/taste.jsonl'));

const replyApproval = H.halt('reply-approval', z.object({
  approved: z.boolean(),
  reply: z.string(),
  notes: z.string(),
}));
const escalationOutcome = H.halt('escalation-outcome', z.object({ resolution: z.string() }));
const auditFinding = H.halt('audit-finding', z.object({ finding: z.string() }));

const classifierRole = H.role('classifier')
  .input(z.object({ message: z.string() }))
  .output(z.object({ category: z.string() }))
  .prompt((conversation) => `Classify this customer message into one support category:\n${conversation.message}`)
  .intents(['read']);

const drafterRole = H.role('drafter')
  .input(z.object({ customer: z.string(), message: z.string(), category: z.string(), notes: z.string() }))
  .output(z.object({ reply: z.string() }))
  .prompt((conversation) => `Draft a reply to ${conversation.customer} about ${conversation.category}:\n${conversation.message}\nReviewer notes: ${conversation.notes}`)
  .intents(['read']);

const classifier = H.agent('classifier', classifierRole).model(anthropic.model('claude-haiku-4-5'));
const drafter = H.agent('drafter', drafterRole)
  .model(anthropic.model('claude-opus-4-1'))
  .recalls(replyTaste, draftingLessons);

const local = shell.local('support-tools', { slots: 4 });

const sendReply = H.command('send-reply')
  .input(z.object({ ticketId: z.string(), reply: z.string() }))
  .argv((message) => ['helpdesk-reply', '--ticket', message.ticketId, '--body', message.reply])
  .on(local);

const safeCategory = H.policy.rule('safe-category', (category: string, metrics: Metrics): boolean => {
  const history = metrics.rate({
    among: { ...replyApproval.resolved(), tags: { category } },
    count: { ...replyApproval.resolved({ approved: true }), tags: { category } },
  });
  return history.samples >= 200 && history.hits === history.samples;
});

const handleConversation = H.flow('handle-conversation').for(Conversation).does(async (ctx) => {
  const conversation = ctx.unit.data;
  await ctx.move('classifying');
  const classified = await ctx.run(classifier, { message: conversation.message });
  if (classified.ok === false) return ctx.fail(classified.error);
  const category = classified.value.category;
  ctx.tag({ category });
  await ctx.update({ category });
  const safe = await ctx.decide(safeCategory, category);
  let notes = '';
  for (let round = 1; round <= 3; round += 1) {
    await ctx.move('drafting');
    const draft = await ctx.run(
      drafter,
      { customer: conversation.customer, message: conversation.message, category, notes },
      { scope: { skills: [category] } },
    );
    if (draft.ok === false) return ctx.fail(draft.error);
    let reply = draft.value.reply;
    if (safe === false) {
      await ctx.move('awaiting-approval');
      const review = await ctx.halt(replyApproval, draft.value.reply);
      notes = review.notes;
      reply = review.approved ? review.reply : '';
    }
    if (reply.length > 0) {
      const delivered = await ctx.run(sendReply, { ticketId: conversation.ticketId, reply });
      if (delivered.ok === false) return ctx.fail(delivered.error);
      return 'sent';
    }
  }
  return ctx.fail('three drafts were rejected');
});

const helpdeskHeaders = { authorization: H.env('HELPDESK_TOKEN') };
const ticketShape = z.object({
  ticketId: z.string(),
  customer: z.string(),
  message: z.string(),
  slaDue: z.string(),
});

const helpdeskWebhook = http.webhook(Conversation, {
  path: '/helpdesk',
  secret: H.env('HELPDESK_WEBHOOK_SECRET'),
  body: ticketShape.extend({ event: z.enum(['created', 'customer-replied', 'closed']) }),
  read: (event): SupplyOf<typeof Conversation> | null => {
    if (event.event === 'created') {
      return {
        create: { ticketId: event.ticketId, customer: event.customer, message: event.message, slaDue: event.slaDue },
        key: event.ticketId,
      };
    }
    if (event.event === 'customer-replied') {
      return { update: event.ticketId, patch: { message: event.message }, state: 'new' };
    }
    return { update: event.ticketId, state: 'closed-by-customer' };
  },
});

const helpdeskPoll = http.poll(Conversation, {
  url: 'https://helpdesk.example.com/api/tickets?status=open',
  every: { minutes: 15 },
  headers: helpdeskHeaders,
  body: z.object({ tickets: z.array(ticketShape) }),
  read: (body) => body.tickets.map((ticket) => ({ create: ticket, key: ticket.ticketId })),
});

const conversations = H.lane('conversations', Conversation)
  .handler(handleConversation)
  .suppliers(helpdeskWebhook, helpdeskPoll)
  .store(http.store(Conversation, {
    url: 'https://helpdesk.example.com/api/tickets',
    headers: helpdeskHeaders,
    stateField: 'harness_state',
  }))
  .maxUsdPerUnit(0.4);

const handleEscalation = H.flow('handle-escalation').for(Escalation).does(async (ctx) => {
  await ctx.move('handling');
  await ctx.halt(escalationOutcome, `Ticket ${ctx.unit.data.ticketId} escalated: ${ctx.unit.data.reason}`);
  return 'resolved';
});

const escalations = H.lane('escalations', Escalation).handler(handleEscalation);

const auditHistory = H.policy.rule(
  'audit-history',
  (input: { readonly category: string; readonly monthStart: Date }, metrics: Metrics): string => {
    const tripped = { entry: 'firing' as const, trigger: approvalAudit, status: 'tripped' };
    const opened = metrics.rateBy({ among: tripped, count: tripped, byTag: 'group', since: input.monthStart });
    const pausedMs = metrics.sum({
      of: 'durationMs',
      among: { entry: 'lane', lane: conversations, status: 'resumed' },
      since: input.monthStart,
    });
    const forCategory = opened[input.category];
    const count = forCategory === undefined ? 0 : forCategory.hits;
    const minutes = Math.round((pausedMs.value ?? 0) / 60_000);
    return `Audits opened for ${input.category} this month: ${count}. Conversations lane paused ${minutes} minutes this month over ${pausedMs.samples} pauses.`;
  },
);

const handleAudit = H.flow('handle-audit').for(Audit).does(async (ctx) => {
  const { category, rate } = ctx.unit.data;
  const now = ctx.now();
  const history = await ctx.decide(auditHistory, { category, monthStart: new Date(now.getFullYear(), now.getMonth(), 1) });
  await ctx.move('investigating');
  const finding = await ctx.halt(auditFinding, `Approval rate for ${category} fell to ${rate ?? 'unknown'}. ${history}`);
  await ctx.update({ finding: finding.finding });
  return 'audit-closed';
});

const audits = H.lane('audits', Audit).handler(handleAudit);

const slaBreach = H.trigger(
  'sla-breach',
  H.on.deadline(Conversation, (conversation) => new Date(conversation.slaDue), ['new', 'classifying', 'drafting', 'awaiting-approval']),
  (event, act) => [
    act.move('escalated'),
    act.create(escalations, { ticketId: event.unit.data.ticketId, reason: 'SLA breached' }, `escalation-${event.unit.key}`),
  ],
);

const approvalAudit = H.trigger(
  'approval-audit',
  H.on.metric(
    (metrics) => metrics.rateBy({
      among: replyApproval.resolved(),
      count: replyApproval.resolved({ approved: true }),
      byTag: 'category',
      days: 7,
    }),
    { trip: { below: 0.9 }, reset: { above: 0.95 }, minSamples: 50 },
  ),
  (event, act) => {
    const key = `audit-${event.group}`;
    if (event.state === 'reset') return act.move(audits, key, 'audit-withdrawn');
    const shown = event.rate.value === null ? 'unknown' : event.rate.value.toFixed(2);
    return [
      act.create(audits, { category: event.group, rate: event.rate.value }, key),
      act.remember(draftingLessons, {
        text: `When drafting for ${event.group}, recall the stricter phrasing`,
        because: `approvals fell to ${shown}`,
        when: { roles: [drafterRole.name], skills: [event.group] },
        status: 'candidate',
      }),
    ];
  },
);

const modelErrorBrake = H.trigger(
  'model-error-brake',
  H.on.metric(
    (metrics) => metrics.rate({
      among: { entry: 'invocation', status: 'ended', mode: ['model', 'batch'] },
      count: { entry: 'invocation', status: 'ended', mode: ['model', 'batch'], ok: false },
      hours: 1,
    }),
    { trip: { above: 0.2 }, reset: { below: 0.05 }, minSamples: 20 },
  ),
  (event, act) => (event.state === 'tripped' ? act.pause(conversations) : act.resume(conversations)),
);

const timeToBreach = H.policy.scheduler('time-to-breach', ({ now, pending }) => {
  const slack = (unit: PendingView): number =>
    unit.is(Conversation) ? new Date(unit.data.slaDue).getTime() - now.getTime() : Number.MIN_SAFE_INTEGER;
  return { start: [...pending].sort((a, b) => slack(a) - slack(b)) };
});

const api = anthropic.account('support-api', { apiKey: H.env('ANTHROPIC_API_KEY') });

export const support = H.harness('support-triage')
  .ledger(sqlite.ledger('.harness/ledger.db'))
  .lanes(conversations, escalations, audits)
  .pools(H.pool('support-accounts', [{ account: api, share: 1 }]))
  .triggers(slaBreach, approvalAudit, modelErrorBrake)
  .scheduler(timeToBreach)
  .clients(claudeCode.supervisor({
    grants: [
      H.ops.readWork, H.ops.writeWork, H.ops.resolveHalts,
      H.ops.readMemory, H.ops.writeMemory, H.ops.curateMemory, H.ops.readTelemetry,
    ],
  }))
  .observers(markdown.board('BOARD.md'), markdown.telemetry('TELEMETRY.md'));
