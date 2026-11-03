import { z } from 'zod';
import { H } from 'harness-dsl';
import type { DataOf, StateOf, EntryFilter, Metrics, PendingView, Rate, Supply } from 'harness-dsl';
import * as anthropic from 'harness-dsl/anthropic';
import * as claude from 'harness-dsl/claude-code';
import * as http from 'harness-dsl/http';
import * as sqlite from 'harness-dsl/sqlite';
import * as jsonl from 'harness-dsl/jsonl';
import * as shell from 'harness-dsl/shell';
import * as markdown from 'harness-dsl/markdown';

const local = shell.local('local', { slots: 4 });
const haiku = anthropic.model('claude-haiku-4-5');
const sonnet = anthropic.model('claude-sonnet-4-5');
const apiAccount = anthropic.account('anthropic-api', { apiKey: H.env('ANTHROPIC_API_KEY') });
const firstEligible = H.policy.account('first-eligible', choice => choice.accounts.find(a => a.eligible)?.account ?? null);
const helpdeskHeaders = { 'X-Api-Key': H.env('HELPDESK_API_KEY') };
const formatRate = (rate: Rate) => rate.value === null ? 'n/a' : `${rate.value.toFixed(2)} over ${rate.samples} samples`;

const fresh = H.state('new', 'pending');
const classifying = H.state('classifying', 'active');
const drafting = H.state('drafting', 'active');
const awaitingApproval = H.state('awaiting-approval', 'active');
const sent = H.state('sent', 'waiting');
const closed = H.state('closed', 'terminal', 'success');
const escalated = H.state('escalated', 'terminal', 'neutral');
const failed = H.state('failed', 'terminal', 'failure');

const Conversation = H.kind('Conversation')
  .data(z.object({
    conversationId: z.string(),
    customer: z.string(),
    subject: z.string(),
    latestMessage: z.string(),
    category: z.string(),
    slaDueAt: z.string(),
  }))
  .states([fresh, classifying, drafting, awaitingApproval, sent, closed, escalated, failed], {
    initial: 'new',
    afterFailure: 'failed',
    afterCancel: 'new',
  });

type ConversationSupply = Supply<DataOf<typeof Conversation>, StateOf<typeof Conversation>>;

const helpdeskConversation = z.object({
  id: z.string(),
  customer: z.string(),
  subject: z.string(),
  message: z.string(),
  slaDueAt: z.string(),
});

const helpdeskWebhook = http.webhook(Conversation, {
  path: '/webhooks/helpdesk',
  secret: H.env('HELPDESK_WEBHOOK_SECRET'),
  body: z.object({ event: z.enum(['created', 'customer_replied', 'closed']), conversation: helpdeskConversation }),
  read: body => body.event === 'created'
    ? {
        create: {
          conversationId: body.conversation.id,
          customer: body.conversation.customer,
          subject: body.conversation.subject,
          latestMessage: body.conversation.message,
          category: '',
          slaDueAt: body.conversation.slaDueAt,
        },
        key: body.conversation.id,
      }
    : body.event === 'customer_replied'
      ? { update: body.conversation.id, patch: { latestMessage: body.conversation.message }, state: 'new' }
      : { update: body.conversation.id, state: 'closed' },
});

const helpdeskPoll = http.poll(Conversation, {
  url: 'https://helpdesk.example.com/api/conversations?status=open',
  every: { minutes: 5 },
  headers: helpdeskHeaders,
  body: z.object({ conversations: z.array(helpdeskConversation) }),
  read: body => body.conversations.map((c): ConversationSupply => ({
    create: { conversationId: c.id, customer: c.customer, subject: c.subject, latestMessage: c.message, category: '', slaDueAt: c.slaDueAt },
    key: c.id,
  })),
});

const helpdeskStore = http.store(Conversation, {
  url: 'https://helpdesk.example.com/api/conversations',
  headers: helpdeskHeaders,
  stateField: 'harness_state',
});

const taste = H.memory('taste', 'owner');
const experience = H.memory('experience', 'fallible');
const specificFirst = H.policy.recall('specific-first', view =>
  [...view.items]
    .sort((a, b) => b.specificity - a.specificity || (b.trackRecord.value ?? 0) - (a.trackRecord.value ?? 0))
    .slice(0, 12)
);
const replyTaste = H.library('reply-taste', taste, jsonl.memory('memory/taste.jsonl')).recall(specificFirst);
const draftingExperience = H.library('drafting-experience', experience, jsonl.memory('memory/experience.jsonl')).recall(specificFirst);

const classifierRole = H.role('classifier')
  .input(z.object({ subject: z.string(), message: z.string() }))
  .output(z.object({ category: z.string() }))
  .prompt(c => `Classify this support conversation.\nSubject: ${c.subject}\n\n${c.message}`);

const drafterRole = H.role('drafter')
  .input(z.object({ subject: z.string(), message: z.string(), category: z.string() }))
  .output(z.object({ reply: z.string() }))
  .prompt(c => `Draft a reply for a ${c.category} conversation.\nSubject: ${c.subject}\n\n${c.message}`);

const classifier = H.agent('classifier', classifierRole).model(haiku);
const drafter = H.agent('drafter', drafterRole).model(sonnet).recalls(replyTaste, draftingExperience);

const sendReply = H.command('send-reply')
  .input(z.object({ conversationId: z.string(), reply: z.string() }))
  .argv(r => ['helpdesk-reply', '--conversation', r.conversationId, '--body', r.reply])
  .on(local);

const approvalHalts: EntryFilter = { entry: 'halt', halt: 'approve-reply', status: 'resolved' };

const approvalRequired = H.policy.rule('approval-required-unless-proven-safe', (category: string, metrics: Metrics): boolean => {
  const record = metrics.rate({
    among: { ...approvalHalts, tags: { category } },
    count: { ...approvalHalts, tags: { category }, decision: { approved: true } },
  });
  return !(record.samples >= 200 && record.hits === record.samples);
});

const triageConversation = H.flow('triage-conversation').for(Conversation).does(async ctx => {
  const conversation = ctx.unit.data;
  await ctx.move('classifying');
  const classified = await ctx.run(classifier, { subject: conversation.subject, message: conversation.latestMessage });
  if (!classified.ok) return ctx.fail(classified.error);
  const category = classified.value.category;
  await ctx.update({ category });
  ctx.tag({ category });
  await ctx.move('drafting');
  const drafted = await ctx.run(
    drafter,
    { subject: conversation.subject, message: conversation.latestMessage, category },
    { scope: { resources: [`category:${category}`] } }
  );
  if (!drafted.ok) return ctx.fail(drafted.error);
  ctx.tag({ draftModel: drafted.model ?? 'unknown' });
  let reply = drafted.value.reply;
  if (await ctx.decide(approvalRequired, category)) {
    await ctx.move('awaiting-approval');
    const review = await ctx.halt({
      name: 'approve-reply',
      show: reply,
      decision: z.object({ approved: z.boolean(), editedReply: z.string(), tasteNote: z.string() }),
    });
    if (review.tasteNote.trim() !== '') {
      await ctx.remember(replyTaste, {
        text: review.tasteNote,
        when: { kinds: ['Conversation'], roles: ['drafter'] },
      });
    }
    if (!review.approved) return 'escalated';
    reply = review.editedReply.trim() === '' ? reply : review.editedReply;
  }
  const delivered = await ctx.run(sendReply, { conversationId: conversation.conversationId, reply });
  return delivered.ok ? 'sent' : ctx.fail(delivered.error);
});

const conversationLane = H.lane('conversations', Conversation)
  .handler(triageConversation)
  .suppliers(helpdeskWebhook, helpdeskPoll)
  .store(helpdeskStore)
  .maxUsdPerUnit(0.4);

const open = H.state('open', 'pending');
const handling = H.state('handling', 'active');
const resolved = H.state('resolved', 'terminal', 'success');
const dropped = H.state('dropped', 'terminal', 'neutral');
const cancelled = H.state('cancelled', 'terminal', 'neutral');
const unresolved = H.state('unresolved', 'terminal', 'failure');

const Escalation = H.kind('Escalation')
  .data(z.object({ conversationId: z.string(), customer: z.string(), reason: z.string() }))
  .states([open, handling, resolved, dropped, unresolved], { initial: 'open', afterFailure: 'unresolved', afterCancel: 'dropped' });

const handleEscalation = H.flow('handle-escalation').for(Escalation).does(async ctx => {
  await ctx.move('handling');
  const outcome = await ctx.halt({
    name: 'resolve-escalation',
    show: `${ctx.unit.data.customer}: ${ctx.unit.data.reason}`,
    decision: z.object({ resolved: z.boolean(), note: z.string() }),
  });
  return outcome.resolved ? 'resolved' : 'unresolved';
});

const escalationLane = H.lane('escalations', Escalation).handler(handleEscalation);

const Audit = H.kind('Audit')
  .data(z.object({ category: z.string(), openedAtRate: z.number().nullable() }))
  .states([open, handling, resolved, cancelled, unresolved], { initial: 'open', afterFailure: 'unresolved', afterCancel: 'cancelled' });

const auditHistory = H.policy.rule('audit-history', (input: { readonly category: string; readonly now: Date }, metrics: Metrics) => {
  const monthStart = new Date(input.now.getFullYear(), input.now.getMonth(), 1);
  const opened = metrics.count({
    among: { entry: 'firing', trigger: 'approval-rate-audit', phase: 'tripped' },
    by: 'group',
    since: monthStart,
  });
  return {
    auditsThisMonth: opened[input.category] ?? 0,
    conversationsPausedMs: metrics.pausedMs({ lane: 'conversations', since: monthStart }),
  };
});

const runAudit = H.flow('run-audit').for(Audit).does(async ctx => {
  await ctx.move('handling');
  const history = await ctx.decide(auditHistory, { category: ctx.unit.data.category, now: ctx.now() });
  const findings = await ctx.halt({
    name: 'audit-findings',
    show: `Category ${ctx.unit.data.category}: approval rate ${ctx.unit.data.openedAtRate ?? 'n/a'}. Audits this month: ${history.auditsThisMonth}. Lane paused ${Math.round(history.conversationsPausedMs / 60000)} minutes this month.`,
    decision: z.object({ findings: z.string() }),
  });
  await ctx.remember(draftingExperience, {
    text: findings.findings,
    because: `the ${ctx.unit.data.category} audit found it`,
    when: { roles: ['drafter'], resources: [`category:${ctx.unit.data.category}`] },
    status: 'candidate',
  });
  return 'resolved';
});

const auditLane = H.lane('audits', Audit).handler(runAudit);

const conversationEscalates = H.trigger(
  'conversation-escalates',
  H.on.enters(Conversation, 'escalated'),
  (event, act) => act.create(escalationLane, {
    conversationId: event.unit.data.conversationId,
    customer: event.unit.data.customer,
    reason: `escalated in state history at ${event.at.toISOString()}`,
  }, `escalation:${event.unit.data.conversationId}`)
);

const slaBreachEscalates = H.trigger(
  'sla-breach-escalates',
  H.on.deadline(Conversation, c => new Date(c.slaDueAt), ['new', 'classifying', 'drafting', 'awaiting-approval']),
  (_event, act) => act.move('escalated')
);

const approvalRateAudit = H.trigger(
  'approval-rate-audit',
  H.on.metric(
    metrics => metrics.rateBy({
      among: approvalHalts,
      count: { ...approvalHalts, decision: { approved: true } },
      by: { tag: 'category' },
      days: 7,
    }),
    { trips: { below: 0.9 }, resets: { above: 0.95 }, minSamples: 50 }
  ),
  (event, act) => event.phase === 'tripped'
    ? [
        act.create(auditLane, { category: event.group, openedAtRate: event.rate.value }, `audit:${event.group}`),
        act.remember(draftingExperience, {
          text: `when drafting for ${event.group}, recall the stricter phrasing`,
          because: `approvals fell to ${formatRate(event.rate)}`,
          when: { roles: ['drafter'], resources: [`category:${event.group}`] },
          status: 'candidate',
        }),
      ]
    : act.moveIn(auditLane, `audit:${event.group}`, 'cancelled')
);

const modelErrorsPauseConversations = H.trigger(
  'model-errors-pause-conversations',
  H.on.metric(
    metrics => {
      const errorsOf = (agent: string) => metrics.rate({
        among: { entry: 'invocation', executable: agent },
        count: { entry: 'invocation', executable: agent, ok: false },
        hours: 1,
      });
      const classifierErrors = errorsOf('classifier');
      const drafterErrors = errorsOf('drafter');
      const hits = classifierErrors.hits + drafterErrors.hits;
      const samples = classifierErrors.samples + drafterErrors.samples;
      return { conversations: { value: samples === 0 ? null : hits / samples, hits, samples } };
    },
    { trips: { above: 0.2 }, resets: { below: 0.05 }, minSamples: 20 }
  ),
  (event, act) => event.phase === 'tripped'
    ? act.pause(conversationLane, `model error rate ${formatRate(event.rate)} in the last hour`)
    : act.resume(conversationLane, `model error rate recovered to ${formatRate(event.rate)}`)
);

const timeToBreachMs = (unit: PendingView, now: Date) =>
  unit.is(Conversation) ? new Date(unit.data.slaDueAt).getTime() - now.getTime() : Infinity;
const supportLaneOrder = ['audits', 'escalations', 'conversations'];

export const support = H.harness('support-self-watch')
  .ledger(sqlite.ledger('support.db'))
  .lanes(conversationLane, escalationLane, auditLane)
  .pools(H.pool('api', [{ account: apiAccount, share: 1 }], firstEligible))
  .triggers(conversationEscalates, slaBreachEscalates, approvalRateAudit, modelErrorsPauseConversations)
  .scheduler(H.policy.scheduler('humans-first-then-time-to-breach', view => ({
    start: [...view.pending].sort((a, b) =>
      supportLaneOrder.indexOf(a.lane) - supportLaneOrder.indexOf(b.lane)
      || timeToBreachMs(a, view.now) - timeToBreachMs(b, view.now)
      || b.waitedMs - a.waitedMs),
  })))
  .clients(claude.supervisor({
    grants: [H.ops.readWork, H.ops.writeWork, H.ops.resolveHalts, H.ops.readMemory, H.ops.writeMemory, H.ops.curateMemory, H.ops.readTelemetry],
  }))
  .observers(markdown.board('BOARD.md'), markdown.telemetry('TELEMETRY.md'));
