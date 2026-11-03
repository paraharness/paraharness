import { H, type Halt, type Metrics, type PendingView, type SupplyOf, type Trigger } from 'harness-dsl';
import * as anthropic from 'harness-dsl/anthropic';
import * as claude from 'harness-dsl/claude-code';
import * as http from 'harness-dsl/http';
import * as jsonl from 'harness-dsl/jsonl';
import * as sqlite from 'harness-dsl/sqlite';
import * as shell from 'harness-dsl/shell';
import * as markdown from 'harness-dsl/markdown';
import { z } from 'zod';

const account = anthropic.account('api', { apiKey: H.env('ANTHROPIC_API_KEY') });
const pool = H.pool('api-pool', [{ account, share: 1 }]);
const haiku = anthropic.model('claude-haiku');
const sonnet = anthropic.model('claude-sonnet');
const local = shell.local('local', { slots: 4 });

const category = H.facet('category', z.string());
const tasteMemory = H.memory('support-taste', 'taste');
const experienceMemory = H.memory('support-experience', 'experience');
const taste = H.journal('support-taste', tasteMemory, jsonl.memory('./memory/taste.jsonl'));
const experience = H.journal('support-experience', experienceMemory, jsonl.memory('./memory/experience.jsonl'));

const fresh = H.state('new', 'pending');
const sent = H.state('sent', 'waiting');
const closed = H.state('closed-by-customer', 'terminal', 'success');
const escalated = H.state('escalated', 'terminal', 'neutral');
const conversation = H.kind('conversation')
  .data(z.object({
    conversationId: z.string(),
    customer: z.string(),
    message: z.string(),
    slaDueAt: z.string(),
    category: z.string().optional(),
  }))
  .states(fresh, sent, closed, escalated);

const escalationOpen = H.state('escalation-open', 'pending');
const escalationResolved = H.state('escalation-resolved', 'terminal', 'success');
const escalation = H.kind('escalation')
  .data(z.object({ conversationId: z.string(), reason: z.string() }))
  .states(escalationOpen, escalationResolved);

const auditOpen = H.state('audit-open', 'pending');
const auditClosed = H.state('audit-closed', 'terminal', 'success');
const auditCancelled = H.state('cancelled', 'terminal', 'neutral');
const audit = H.kind('audit')
  .data(z.object({ category: z.string(), rate: z.number() }))
  .states(auditOpen, auditClosed, auditCancelled);

const classifierRole = H.role('classifier')
  .input(z.object({ message: z.string() }))
  .output(z.object({ category: z.string() }))
  .prompt(input => `Classify this support message:\n${input.message}`);
const drafterRole = H.role('drafter')
  .input(z.object({ customer: z.string(), message: z.string(), category: z.string() }))
  .output(z.object({ reply: z.string() }))
  .prompt(input => `Draft a reply to ${input.customer} (${input.category}):\n${input.message}`);
const classifier = H.seat('classifier', classifierRole).model(haiku);
const drafter = H.seat('drafter', drafterRole).model(sonnet).recalls(taste, experience);

const approvalDecision = z.object({ approved: z.boolean(), edited: z.string().optional() });
const approvalAbout = z.object({ category: z.string(), draft: z.string() });
type ApprovalDecision = z.infer<typeof approvalDecision>;
type ApprovalAbout = z.infer<typeof approvalAbout>;

const safeCategory = H.policy.rule('safe-category', (about: ApprovalAbout, metrics: Metrics): ApprovalDecision | null => {
  const among = { entry: 'halt' as const, halt: approval, status: 'resolved', resolver: 'human' as const, facets: [category.value(about.category)] };
  const record = metrics.rate({ among, count: { ...among, decision: { approved: true } } });
  return record.samples >= 200 && record.hits === record.samples ? { approved: true } : null;
});
const approval: Halt<ApprovalDecision, ApprovalAbout> = H.halt('reply-approval', approvalDecision)
  .about(approvalAbout)
  .policy(safeCategory);

const costCeiling = H.halt('conversation-cost-ceiling', z.object({ continue: z.boolean() }))
  .about(z.object({ spentUsd: z.number(), limitUsd: z.number() }));

const sendReply = H.command('send-reply')
  .input(z.object({ conversationId: z.string(), reply: z.string() }))
  .argv(input => ['./helpdesk/send', input.conversationId, input.reply])
  .on(local)
  .recovery('park');

const reply = H.flow('reply').for(conversation).does(async ctx => {
  const { conversationId, customer, message } = ctx.unit.data;
  const classified = await ctx.run(classifier, { message });
  if (!classified.ok) return ctx.fail(classified.error);
  ctx.tag(category, classified.value.category);
  await ctx.update({ category: classified.value.category });
  const drafted = await ctx.run(drafter, { customer, message, category: classified.value.category });
  if (!drafted.ok) return ctx.fail(drafted.error);
  const decision = await ctx.halt(approval, `Reply to ${customer}:\n${drafted.value.reply}`, {
    category: classified.value.category,
    draft: drafted.value.reply,
  });
  if (!decision.approved) return ctx.fail('reviewer rejected the draft');
  if (decision.edited !== undefined) {
    await ctx.remember(taste, {
      text: `Prefer phrasing like "${decision.edited}" over "${drafted.value.reply}"`,
      because: 'the reviewer edited the draft this way',
      status: 'candidate',
    });
  }
  const delivered = await ctx.run(sendReply, { conversationId, reply: decision.edited ?? drafted.value.reply });
  return delivered.ok ? 'sent' : ctx.fail(delivered.error);
});

const escalationHandled = H.halt('escalation-handled', z.object({ resolution: z.string() }));
const handleEscalation = H.flow('handle-escalation').for(escalation).does(async ctx => {
  await ctx.halt(escalationHandled, `Escalated conversation ${ctx.unit.data.conversationId}: ${ctx.unit.data.reason}`);
  return 'escalation-resolved';
});

interface AuditQuery {
  readonly category: string;
  readonly now: Date;
}
const monthStart = (now: Date) => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
const auditHistory = H.policy.rule('audit-history', (query: AuditQuery, metrics: Metrics): string => {
  const since = monthStart(query.now);
  const opened = metrics.count({ of: { entry: 'firing', trigger: approvalWatch, status: 'tripped', group: query.category }, since });
  const paused = metrics.sum({ of: 'durationMs', among: { entry: 'lane', lane: conversations, status: 'resumed' }, since });
  return `Audits opened for ${query.category} this month: ${opened}. Conversations lane paused this month: ${Math.round((paused.value ?? 0) / 60_000)} minutes over ${paused.samples} pauses.`;
});

const auditFindings = H.halt('audit-findings', z.object({ findings: z.string() }))
  .about(z.object({ category: z.string(), history: z.string() }));
const runAudit = H.flow('audit').for(audit).does(async ctx => {
  const history = await ctx.decide(auditHistory, { category: ctx.unit.data.category, now: ctx.now() });
  await ctx.halt(auditFindings, `Audit approvals in ${ctx.unit.data.category} (rate ${ctx.unit.data.rate})`, {
    category: ctx.unit.data.category,
    history,
  });
  return 'audit-closed';
});

const helpdeskHeaders = { Authorization: H.env('HELPDESK_TOKEN') };
const conversationEvent = z.object({
  event: z.enum(['created', 'replied']),
  conversationId: z.string(),
  customer: z.string(),
  message: z.string(),
  slaDueAt: z.string(),
});
type ConversationEvent = z.infer<typeof conversationEvent>;
const toSupply = (body: ConversationEvent): SupplyOf<typeof conversation> => body.event === 'created'
  ? { create: { conversationId: body.conversationId, customer: body.customer, message: body.message, slaDueAt: body.slaDueAt }, key: body.conversationId }
  : { update: body.conversationId, patch: { message: body.message }, state: 'new' };

const helpdeskWebhook = http.webhook(conversation, {
  path: '/helpdesk',
  secret: H.env('HELPDESK_WEBHOOK_SECRET'),
  body: conversationEvent,
  read: toSupply,
});
const helpdeskPoll = http.poll(conversation, {
  url: 'https://helpdesk.example.com/api/conversations?status=open',
  every: { minutes: 10 },
  headers: helpdeskHeaders,
  body: z.object({ conversations: z.array(conversationEvent) }),
  read: body => body.conversations.map(toSupply),
});

const conversations = H.lane('conversations', conversation)
  .handler(reply)
  .suppliers(helpdeskWebhook, helpdeskPoll)
  .store(http.store(conversation, { url: 'https://helpdesk.example.com/api/conversations', headers: helpdeskHeaders, stateField: 'status' }))
  .wip(6)
  .maxUsdPerUnit(0.4, costCeiling)
  .retry(H.policy.retry('redraft-twice', view => view.failures < 2 ? { retryInMs: 30_000 } : 'stop'), 'escalated');
const escalations = H.lane('escalations', escalation).handler(handleEscalation);
const audits = H.lane('audits', audit).handler(runAudit);

const slaBreach = H.trigger(
  'sla-breach',
  H.on.deadline(conversation, data => new Date(data.slaDueAt), ['new', 'sent']),
  (event, act) => [
    act.create(escalations, { conversationId: event.unit.data.conversationId, reason: 'SLA breached' }, `escalation-${event.unit.key}`),
    act.move('escalated'),
  ],
);

const approvalByCategory = (metrics: Metrics) => metrics.rateBy({
  among: { entry: 'halt', halt: approval, status: 'resolved' },
  count: { entry: 'halt', halt: approval, status: 'resolved', decision: { approved: true } },
  by: category,
  days: 7,
});
const auditKey = (group: string, trippedAt: Date) => `audit-${group}-${trippedAt.toISOString()}`;
const approvalWatch: Trigger = H.trigger(
  'approval-watch',
  H.on.metric(approvalByCategory, { trip: { below: 0.9 }, reset: { above: 0.95 }, minSamples: 50 }),
  (event, act) => event.state === 'tripped'
    ? [
      act.create(audits, { category: event.group, rate: event.rate.value ?? 0 }, auditKey(event.group, event.trippedAt)),
      act.remember(experience, {
        text: `When drafting for ${event.group}, recall the stricter phrasing`,
        because: `approvals fell to ${event.rate.value ?? 0} over ${event.rate.samples} samples`,
        when: { roles: [drafterRole], facets: [category.value(event.group)] },
        status: 'candidate',
      }),
    ]
    : act.move(audits, auditKey(event.group, event.trippedAt), 'cancelled'),
);

const modelErrorRate = (metrics: Metrics) => metrics.rate({
  among: { entry: 'invocation', mode: 'model', status: 'ended' },
  count: { entry: 'invocation', mode: 'model', status: 'ended', ok: false },
  hours: 1,
});
const modelErrorBrake = H.trigger(
  'model-error-brake',
  H.on.metric(modelErrorRate, { trip: { above: 0.2 }, reset: { below: 0.05 }, minSamples: 20 }),
  (event, act) => event.state === 'tripped' ? act.pause(conversations) : act.resume(conversations),
);

const breachTime = (unit: PendingView) => unit.is(conversation) ? new Date(unit.data.slaDueAt).getTime() : Number.MAX_SAFE_INTEGER;
const timeToBreach = H.policy.scheduler('time-to-breach', view => ({
  start: [...view.pending].sort((a, b) => breachTime(a) - breachTime(b)),
}));

export const harness = H.harness('support')
  .ledger(sqlite.ledger('./.harness/ledger.db'))
  .lanes(conversations, escalations, audits)
  .pools(pool)
  .triggers(slaBreach, approvalWatch, modelErrorBrake)
  .scheduler(timeToBreach)
  .clients(claude.supervisor({
    grants: [
      H.ops.readWork, H.ops.writeWork,
      H.ops.resolve(approval, costCeiling, escalationHandled, auditFindings),
      H.ops.writeMemory, H.ops.curateMemory, H.ops.readTelemetry,
    ],
  }))
  .observers(markdown.board('./BOARD.md'), markdown.telemetry('./TELEMETRY.md'));
