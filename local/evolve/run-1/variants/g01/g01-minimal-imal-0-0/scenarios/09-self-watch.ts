import { H } from 'harness-dsl';
import type { Metrics } from 'harness-dsl';
import { z } from 'zod';
import * as anthropic from 'harness-dsl/anthropic';
import * as claudeCode from 'harness-dsl/claude-code';
import * as http from 'harness-dsl/http';
import * as sqlite from 'harness-dsl/sqlite';
import * as jsonl from 'harness-dsl/jsonl';
import * as shell from 'harness-dsl/shell';
import * as markdown from 'harness-dsl/markdown';

const stalled = H.state('stalled', 'waiting');
const cancelled = H.state('cancelled', 'terminal', 'neutral');

const fresh = H.state('new', 'pending');
const classifying = H.state('classifying', 'active');
const drafting = H.state('drafting', 'active');
const awaitingApproval = H.state('awaiting-approval', 'active');
const sent = H.state('sent', 'waiting');
const closed = H.state('closed', 'terminal', 'success');
const escalated = H.state('escalated', 'terminal', 'neutral');

const Conversation = H.kind('Conversation')
  .data(z.object({
    conversationId: z.string(),
    subject: z.string(),
    lastMessage: z.string(),
    category: z.string(),
    slaDueAt: z.string(),
  }))
  .states([fresh, classifying, drafting, awaitingApproval, sent, stalled, closed, escalated], { initial: 'new', afterFailure: 'new' });

const raised = H.state('raised', 'pending');
const handling = H.state('handling', 'active');
const resolved = H.state('resolved', 'terminal', 'success');

const Escalation = H.kind('Escalation')
  .data(z.object({ conversationId: z.string(), reason: z.string() }))
  .states([raised, handling, stalled, resolved], { initial: 'raised', afterFailure: 'stalled' });

const open = H.state('open', 'pending');
const auditing = H.state('auditing', 'active');
const completed = H.state('completed', 'terminal', 'success');

const Audit = H.kind('Audit')
  .data(z.object({ category: z.string(), rateAtOpening: z.number().nullable(), findings: z.string() }))
  .states([open, auditing, stalled, completed, cancelled], { initial: 'open', afterFailure: 'stalled' });

const taste = H.memory('taste', 'owner');
const experience = H.memory('experience', 'fallible');

const categoryFirst = H.policy.recall('category-first', view =>
  view.items
    .filter(item => item.status === 'accepted')
    .filter(item => (item.when.resources ?? []).every(r => view.scope.resources.includes(r)))
    .sort((a, b) => b.specificity - a.specificity || (b.trackRecord.value ?? 0) - (a.trackRecord.value ?? 0))
    .slice(0, 12));

const supportTaste = H.library('support-taste', taste, jsonl.memory('memory/taste.jsonl')).recall(categoryFirst);
const drafterExperience = H.library('drafter-experience', experience, jsonl.memory('memory/experience.jsonl')).recall(categoryFirst);

const classifierRole = H.role('classifier')
  .input(z.object({ subject: z.string(), message: z.string() }))
  .output(z.object({ category: z.string() }))
  .prompt(i => `Classify this support conversation.\nSubject: ${i.subject}\n${i.message}`)
  .intents([]);
const drafterRole = H.role('drafter')
  .input(z.object({ subject: z.string(), message: z.string(), category: z.string() }))
  .output(z.object({ reply: z.string() }))
  .prompt(i => `Draft a reply for a ${i.category} conversation.\nSubject: ${i.subject}\n${i.message}`)
  .intents([]);

const classifier = H.agent('classifier', classifierRole).model(anthropic.model('claude-haiku-4-5'));
const drafter = H.agent('drafter', drafterRole).model(anthropic.model('claude-sonnet-4-5')).recalls(supportTaste, drafterExperience);

const local = shell.local('local', { slots: 4 });
const sendReply = H.command('send-reply')
  .input(z.object({ conversationId: z.string(), body: z.string() }))
  .argv(i => ['helpdesk', 'reply', i.conversationId, i.body])
  .on(local)
  .onCrash('park');

const approvals = { entry: 'halt' as const, halt: 'approval', status: 'resolved' };

const safeToSend = H.policy.rule<{ category: string }, boolean>('safe-category', (input, metrics) => {
  const rejections = metrics.rate({
    among: { ...approvals, tags: { category: input.category } },
    count: { ...approvals, tags: { category: input.category }, decision: { approved: false } },
  });
  return rejections.samples >= 200 && rejections.hits === 0;
});

const handleConversation = H.flow('handle-conversation').for(Conversation).does(async ctx => {
  const c = ctx.unit.data;
  await ctx.move('classifying');
  const classified = await ctx.run(classifier, { subject: c.subject, message: c.lastMessage });
  if (!classified.ok) return ctx.fail(classified.error);
  const category = classified.value.category;
  ctx.tag({ category });
  await ctx.update({ category });
  await ctx.move('drafting');
  const draft = await ctx.run(drafter, { subject: c.subject, message: c.lastMessage, category }, { scope: { resources: [`category:${category}`] } });
  if (!draft.ok) return ctx.fail(draft.error);
  ctx.tag({ draftedBy: draft.model ?? 'unknown' });
  let reply = draft.value.reply;
  if (!(await ctx.decide(safeToSend, { category }))) {
    await ctx.move('awaiting-approval');
    const review = await ctx.halt({
      name: 'approval',
      show: reply,
      decision: z.object({ approved: z.boolean(), editedReply: z.string(), lesson: z.string() }),
    });
    if (review.lesson.length > 0) {
      await ctx.remember(supportTaste, { text: review.lesson, when: { roles: ['drafter'], resources: [`category:${category}`] } });
    }
    if (!review.approved) return ctx.fail('reviewer rejected the draft');
    reply = review.editedReply;
  }
  const posted = await ctx.run(sendReply, { conversationId: c.conversationId, body: reply });
  if (!posted.ok) return ctx.fail(posted.error);
  return 'sent';
});

const handleEscalation = H.flow('handle-escalation').for(Escalation).does(async ctx => {
  await ctx.move('handling');
  await ctx.halt({
    name: 'escalation',
    show: `Conversation ${ctx.unit.data.conversationId} escalated: ${ctx.unit.data.reason}`,
    decision: z.object({ resolution: z.string() }),
  });
  return 'resolved';
});

const auditHistory = H.policy.rule<{ category: string; monthStart: Date }, string>('audit-history', (input, metrics: Metrics) => {
  const opened = metrics.countBy({
    among: { entry: 'transition', kind: 'Audit', state: 'open' },
    by: { tag: 'category' },
    since: input.monthStart,
  });
  const pausedMinutes = Math.round(metrics.pausedMs({ lane: 'conversations', since: input.monthStart }) / 60000);
  return `${opened[input.category] ?? 0} audits opened for ${input.category} this month; conversations lane paused ${pausedMinutes} minutes this month.`;
});

const handleAudit = H.flow('handle-audit').for(Audit).does(async ctx => {
  await ctx.move('auditing');
  const now = ctx.now();
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const history = await ctx.decide(auditHistory, { category: ctx.unit.data.category, monthStart });
  const audit = await ctx.halt({
    name: 'audit-findings',
    show: `Approval rate for ${ctx.unit.data.category} fell to ${ctx.unit.data.rateAtOpening ?? 'unknown'}. ${history}`,
    decision: z.object({ findings: z.string() }),
  });
  await ctx.update({ findings: audit.findings });
  return 'completed';
});

const helpdeskHeaders = { authorization: H.env('HELPDESK_TOKEN') };
const conversationBody = z.object({
  conversationId: z.string(),
  subject: z.string(),
  message: z.string(),
  slaDueAt: z.string(),
  event: z.enum(['opened', 'customer-replied', 'closed']),
});

const helpdeskWebhook = http.webhook(Conversation, {
  path: '/webhooks/helpdesk',
  secret: H.env('HELPDESK_WEBHOOK_SECRET'),
  body: conversationBody,
  read: b => b.event === 'opened'
    ? { create: { conversationId: b.conversationId, subject: b.subject, lastMessage: b.message, category: '', slaDueAt: b.slaDueAt }, key: b.conversationId }
    : { update: b.conversationId, patch: { lastMessage: b.message }, state: b.event === 'closed' ? 'closed' : 'new' },
});

const helpdeskPoll = http.poll(Conversation, {
  url: 'https://helpdesk.example.com/api/conversations?status=open',
  every: { minutes: 15 },
  headers: helpdeskHeaders,
  body: z.object({ conversations: z.array(conversationBody) }),
  read: b => b.conversations.map(c => ({
    create: { conversationId: c.conversationId, subject: c.subject, lastMessage: c.message, category: '', slaDueAt: c.slaDueAt },
    key: c.conversationId,
  })),
});

const helpdeskStore = http.store(Conversation, {
  url: 'https://helpdesk.example.com/api/conversations',
  headers: helpdeskHeaders,
  stateField: 'harnessStatus',
});

const conversations = H.lane('conversations', Conversation).handler(handleConversation)
  .suppliers(helpdeskWebhook, helpdeskPoll).store(helpdeskStore).wip(8).maxUsdPerUnit(0.4);
const escalations = H.lane('escalations', Escalation).handler(handleEscalation).wip(5);
const audits = H.lane('audits', Audit).handler(handleAudit).wip(3);

const slaBreach = H.trigger('sla-breach',
  H.on.deadline(Conversation, d => new Date(d.slaDueAt), ['new', 'classifying', 'drafting', 'awaiting-approval', 'stalled']),
  (event, act) => [
    act.create(escalations, { conversationId: event.unit.data.conversationId, reason: 'SLA breached' }, { key: `escalation-${event.unit.key}` }),
    act.move('escalated'),
  ]);

const approvalDrop = H.trigger('approval-drop',
  H.on.crossing({
    rates: (metrics: Metrics) => metrics.rateBy({
      among: approvals,
      count: { ...approvals, decision: { approved: true } },
      by: { tag: 'category' },
      days: 7,
    }),
    enter: { below: 0.9 },
    clear: { above: 0.95 },
    minSamples: 50,
  }),
  (event, act) => event.direction === 'entered'
    ? [
        act.create(audits, { category: event.group, rateAtOpening: event.rate.value, findings: '' }, { key: `audit-${event.group}`, tags: { category: event.group } }),
        act.remember(drafterExperience, {
          text: `When drafting for ${event.group}, recall the stricter phrasing`,
          because: `approvals fell to ${event.rate.value ?? 'unknown'} over ${event.rate.samples} samples`,
          when: { roles: ['drafter'], resources: [`category:${event.group}`] },
          status: 'candidate',
        }),
      ]
    : act.move(audits, `audit-${event.group}`, 'cancelled'));

const modelErrors = H.trigger('model-error-rate',
  H.on.crossing({
    rate: (metrics: Metrics) => metrics.rate({
      among: { entry: 'invocation', phase: 'ended', mode: 'live', lane: 'conversations' },
      count: { entry: 'invocation', phase: 'ended', mode: 'live', lane: 'conversations', ok: false },
      hours: 1,
    }),
    enter: { above: 0.2 },
    clear: { below: 0.05 },
    minSamples: 20,
  }),
  (event, act) => event.direction === 'entered'
    ? act.pause(conversations, `model error rate ${event.rate.value ?? 'unknown'} over ${event.rate.samples} invocations`)
    : act.resume(conversations, `model error rate recovered to ${event.rate.value ?? 'unknown'}`));

const humanWorkFirst: Readonly<Record<string, number>> = { Escalation: 0, Audit: 1, Conversation: 2 };

const timeToBreach = H.policy.scheduler('time-to-breach', v => ({
  start: [...v.pending].sort((a, b) =>
    (humanWorkFirst[a.kind] ?? 9) - (humanWorkFirst[b.kind] ?? 9)
    || (a.is(Conversation) ? new Date(a.data.slaDueAt).getTime() : 0) - (b.is(Conversation) ? new Date(b.data.slaDueAt).getTime() : 0)),
}));

const api = anthropic.account('api', { apiKey: H.env('ANTHROPIC_API_KEY') });
const pool = H.pool('api', [{ account: api, share: 1 }],
  H.policy.account('provider-match', c => c.accounts.find(a => a.eligible && a.account.provider === c.model.provider)?.account ?? null));

export const supportSelfWatch = H.harness('support-self-watch')
  .ledger(sqlite.ledger('.harness/support.db'))
  .lanes(conversations, escalations, audits)
  .pools(pool)
  .triggers(slaBreach, approvalDrop, modelErrors)
  .scheduler(timeToBreach)
  .clients(claudeCode.supervisor({
    grants: [H.ops.readWork, H.ops.writeWork, H.ops.resolveHalts, H.ops.readMemory, H.ops.writeMemory, H.ops.curateMemory, H.ops.readTelemetry],
  }))
  .observers(markdown.board('BOARD.md'), markdown.telemetry('TELEMETRY.md'));
