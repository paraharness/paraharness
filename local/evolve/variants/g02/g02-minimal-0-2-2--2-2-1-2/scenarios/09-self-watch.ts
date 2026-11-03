import { H } from 'harness-dsl';
import type { Lane, PendingView } from 'harness-dsl';
import * as claudeCode from 'harness-dsl/claude-code';
import * as anthropic from 'harness-dsl/anthropic';
import * as sqlite from 'harness-dsl/sqlite';
import * as jsonl from 'harness-dsl/jsonl';
import * as shell from 'harness-dsl/shell';
import * as http from 'harness-dsl/http';
import * as markdown from 'harness-dsl/markdown';
import { z } from 'zod';

const local = shell.local('local', { slots: 4 });
const apiAccount = anthropic.account('api', { apiKey: H.env('ANTHROPIC_API_KEY') });
const haiku = anthropic.model('claude-haiku');
const sonnet = anthropic.model('claude-sonnet');
const apiPool = H.pool('api', [{ account: apiAccount, share: 1 }]);

const categorySchema = z.enum(['billing', 'refund', 'technical', 'account']);
type Category = z.infer<typeof categorySchema>;
const category = H.facet('category', categorySchema);

const newConversation = H.state('new', 'pending');
const classifying = H.state('classifying', 'pending');
const sent = H.state('sent', 'waiting');
const needsHuman = H.state('needs-human', 'waiting');
const closed = H.state('closed', 'terminal', 'success');
const escalated = H.state('escalated', 'terminal', 'neutral');
const conversation = H.kind('Conversation')
  .data(z.object({
    subject: z.string(),
    latestMessage: z.string(),
    customerEmail: z.string(),
    slaDue: z.string(),
    category: categorySchema.optional(),
  }))
  .states(newConversation, classifying, sent, needsHuman, closed, escalated);

const helpdeskHeaders = { Authorization: H.env('HELPDESK_TOKEN') };

const helpdeskWebhook = http.webhook(conversation, {
  path: '/helpdesk',
  secret: H.env('HELPDESK_WEBHOOK_SECRET'),
  body: z.object({
    event: z.enum(['created', 'replied', 'closed']),
    conversationId: z.string(),
    subject: z.string(),
    message: z.string(),
    customerEmail: z.string(),
    slaDue: z.string(),
  }),
  read: body =>
    body.event === 'created'
      ? {
          create: { subject: body.subject, latestMessage: body.message, customerEmail: body.customerEmail, slaDue: body.slaDue },
          key: body.conversationId,
        }
      : body.event === 'replied'
        ? { update: body.conversationId, patch: { latestMessage: body.message }, state: 'classifying' }
        : { update: body.conversationId, state: 'closed' },
});

const helpdeskPoll = http.poll(conversation, {
  url: 'https://helpdesk.example.com/api/conversations?status=open',
  every: { minutes: 10 },
  headers: helpdeskHeaders,
  body: z.object({
    conversations: z.array(z.object({
      id: z.string(),
      subject: z.string(),
      message: z.string(),
      customerEmail: z.string(),
      slaDue: z.string(),
    })),
  }),
  read: body =>
    body.conversations.map(item => ({
      create: { subject: item.subject, latestMessage: item.message, customerEmail: item.customerEmail, slaDue: item.slaDue },
      key: item.id,
    })),
});

const helpdeskStore = http.store(conversation, {
  url: 'https://helpdesk.example.com/api/conversations',
  headers: helpdeskHeaders,
  stateField: 'harness_state',
});

const taste = H.memory('taste', 'taste');
const experience = H.memory('experience', 'experience');
const replyTaste = H.library('reply-taste', taste, jsonl.memory('.harness/reply-taste.jsonl'));
const draftingExperience = H.library('drafting-experience', experience, jsonl.memory('.harness/drafting-experience.jsonl'));

const classifyRole = H.role('classify')
  .input(z.object({ subject: z.string(), message: z.string() }))
  .output(z.object({ category: categorySchema }))
  .prompt(input => `Classify this support conversation.\nSubject: ${input.subject}\n${input.message}`);

const draftRole = H.role('draft')
  .input(z.object({ subject: z.string(), message: z.string(), category: categorySchema }))
  .output(z.object({ reply: z.string() }))
  .prompt(input => `Draft a reply for a ${input.category} conversation.\nSubject: ${input.subject}\n${input.message}`);

const classifier = H.seat('classifier', classifyRole).model(haiku);
const drafter = H.seat('drafter', draftRole).model(sonnet).recalls(replyTaste, draftingExperience);

const approvalAbout = z.object({ category: categorySchema, reply: z.string() });
type ApprovalAbout = z.infer<typeof approvalAbout>;

const approvalAsk = H.halt('reply-approval', z.object({ approved: z.boolean(), reply: z.string() })).about(approvalAbout);

const autoApproveSafe = H.policy.rule('auto-approve-safe-category', (about: ApprovalAbout, metrics) => {
  const history = metrics.rate({
    among: { entry: 'halt', halt: approvalAsk, status: 'resolved', resolver: 'human', facets: [category.of(about.category)] },
    count: { entry: 'halt', halt: approvalAsk, status: 'resolved', resolver: 'human', decision: { approved: false }, facets: [category.of(about.category)] },
  });
  return history.samples >= 200 && history.hits === 0 ? { approved: true, reply: about.reply } : null;
});

const approval = approvalAsk.policy(autoApproveSafe);

const sendReply = H.command('send-reply')
  .input(z.object({ conversationId: z.string(), reply: z.string() }))
  .argv(input => ['bin/helpdesk-reply', input.conversationId, input.reply])
  .on(local)
  .recovery('park');

const handleConversation = H.flow('handle-conversation').for(conversation).does(async ctx => {
  const { subject, latestMessage, customerEmail } = ctx.unit.data;
  const classified = await ctx.run(classifier, { subject, message: latestMessage });
  if (!classified.ok) return ctx.fail(classified.error);
  await ctx.update({ category: classified.value.category });
  const draft = await ctx.run(drafter, { subject, message: latestMessage, category: classified.value.category });
  if (!draft.ok) return ctx.fail(draft.error);
  const decision = await ctx.halt(approval, `Reply to ${customerEmail}:\n${draft.value.reply}`, {
    category: classified.value.category,
    reply: draft.value.reply,
  });
  if (!decision.approved) return 'needs-human';
  const posted = await ctx.run(sendReply, { conversationId: ctx.unit.key, reply: decision.reply });
  if (!posted.ok) return ctx.fail(posted.error);
  return 'sent';
});

const conversations = H.lane('conversations', conversation)
  .handler(handleConversation, { retries: 2, backoff: { first: { minutes: 1 }, factor: 2 }, exhausted: 'needs-human' })
  .suppliers(helpdeskWebhook, helpdeskPoll)
  .store(helpdeskStore)
  .maxUsdPerUnit(0.4)
  .facet(category, data => data.category);

const escalationOpen = H.state('escalation-open', 'pending');
const escalationHandled = H.state('escalation-handled', 'terminal', 'success');
const escalationUnhandled = H.state('escalation-unhandled', 'terminal', 'failure');
const escalation = H.kind('Escalation')
  .data(z.object({ conversationId: z.string(), reason: z.string() }))
  .states(escalationOpen, escalationHandled, escalationUnhandled);

const escalationOutcome = H.halt('escalation-outcome', z.object({ resolution: z.string() }));

const handleEscalation = H.flow('handle-escalation').for(escalation).does(async ctx => {
  await ctx.halt(escalationOutcome, `Conversation ${ctx.unit.data.conversationId}: ${ctx.unit.data.reason}`);
  return 'escalation-handled';
});

const escalations = H.lane('escalations', escalation)
  .handler(handleEscalation, { retries: 0, exhausted: 'escalation-unhandled' });

const slaBreach = H.trigger(
  'sla-breach',
  H.on.deadline(conversation, data => new Date(data.slaDue), ['new', 'classifying', 'needs-human']),
  (event, act) => [
    act.create(escalations, { conversationId: event.unit.key, reason: 'SLA breached' }, `escalation-${event.unit.key}`),
    act.move('escalated'),
  ]
);

const auditOpen = H.state('audit-open', 'pending');
const auditClosed = H.state('audit-closed', 'terminal', 'success');
const auditCancelled = H.state('audit-cancelled', 'terminal', 'neutral');
const auditStalled = H.state('audit-stalled', 'waiting');
const auditData = z.object({ category: categorySchema });
type AuditData = z.infer<typeof auditData>;
type AuditState = 'audit-open' | 'audit-closed' | 'audit-cancelled' | 'audit-stalled';
const audit = H.kind('Audit').data(auditData).states(auditOpen, auditClosed, auditCancelled, auditStalled);

interface AuditHistory {
  readonly auditsOpened: number;
  readonly pausedMs: number;
  readonly pauseSamples: number;
}

const auditHistory = H.policy.rule<{ readonly category: Category }, AuditHistory>('audit-history', (input, metrics) => {
  const paused = metrics.sum({ of: 'durationMs', among: { entry: 'lane', status: 'resumed', lane: conversations }, days: 30 });
  return {
    auditsOpened: metrics.count({
      of: { entry: 'firing', trigger: approvalRateAudit, status: 'tripped', facets: [category.of(input.category)] },
      days: 30,
    }),
    pausedMs: paused.value ?? 0,
    pauseSamples: paused.samples,
  };
});

const auditFindings = H.halt('audit-findings', z.object({ findings: z.string() }));

const auditCategory = H.flow('audit-category').for(audit).does(async ctx => {
  const history = await ctx.decide(auditHistory, { category: ctx.unit.data.category });
  await ctx.halt(
    auditFindings,
    `Approval rate fell for ${ctx.unit.data.category}. Audits opened in 30 days: ${history.auditsOpened}. Conversations lane paused ${Math.round(history.pausedMs / 60000)} minutes over ${history.pauseSamples} pauses.`
  );
  return 'audit-closed';
});

const audits: Lane<AuditData, AuditState> = H.lane('audits', audit)
  .handler(auditCategory, { retries: 0, exhausted: 'audit-stalled' })
  .facet(category, data => data.category);

const approvalRateAudit = H.trigger(
  'approval-rate-audit',
  H.on.metric(
    metrics => metrics.rateBy({
      among: { entry: 'halt', halt: approval, status: 'resolved' },
      count: { entry: 'halt', halt: approval, status: 'resolved', decision: { approved: true } },
      days: 7,
      by: category,
    }),
    { trip: { below: 0.9 }, reset: { above: 0.95 }, minSamples: 50 }
  ),
  (event, act) =>
    event.state === 'tripped'
      ? [
          act.create(audits, { category: event.group }, `audit-${event.group}`),
          act.remember(draftingExperience, {
            text: `when drafting for ${event.group}, recall the stricter phrasing`,
            because: `approvals fell to ${event.rate.value ?? 'unknown'} over ${event.rate.samples} samples`,
            when: { roles: [draftRole], facets: [category.of(event.group)] },
            status: 'candidate',
          }),
        ]
      : act.move(audits, `audit-${event.group}`, 'audit-cancelled')
);

const modelErrorPause = H.trigger(
  'model-error-pause',
  H.on.metric(
    metrics => metrics.rate({
      among: { entry: 'invocation', status: 'ended', mode: 'model', lane: conversations },
      count: { entry: 'invocation', status: 'ended', mode: 'model', lane: conversations, ok: false },
      hours: 1,
    }),
    { trip: { above: 0.2 }, reset: { below: 0.05 }, minSamples: 20 }
  ),
  (event, act) => (event.state === 'tripped' ? act.pause(conversations) : act.resume(conversations))
);

const breachAt = (unit: PendingView): number => {
  if (unit.is(escalation)) return 0;
  if (unit.is(conversation)) return new Date(unit.data.slaDue).getTime();
  return Number.MAX_SAFE_INTEGER;
};

const timeToBreach = H.policy.scheduler('time-to-breach', view => ({
  start: [...view.pending].sort((a, b) => breachAt(a) - breachAt(b)),
}));

const reviewer = claudeCode.supervisor({
  grants: [
    H.ops.readWork,
    H.ops.writeWork,
    H.ops.resolve(approval, escalationOutcome, auditFindings, H.halts.costCeiling, H.halts.interrupted, H.halts.definitionChanged),
    H.ops.readMemory,
    H.ops.writeMemory,
    H.ops.curateMemory,
    H.ops.readTelemetry,
  ],
});

export const support = H.harness('support')
  .ledger(sqlite.ledger('.harness/ledger.sqlite'))
  .lanes(conversations, escalations, audits)
  .pools(apiPool)
  .triggers(slaBreach, approvalRateAudit, modelErrorPause)
  .scheduler(timeToBreach)
  .clients(reviewer)
  .observers(markdown.board('BOARD.md'), markdown.telemetry('TELEMETRY.md'));
