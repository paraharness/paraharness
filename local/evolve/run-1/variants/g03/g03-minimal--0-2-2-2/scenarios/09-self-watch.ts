import { z } from 'zod';
import { H } from 'harness-dsl';
import type { Metrics, Rate, PendingView } from 'harness-dsl';
import * as anthropic from 'harness-dsl/anthropic';
import * as http from 'harness-dsl/http';
import * as jsonl from 'harness-dsl/jsonl';
import * as sqlite from 'harness-dsl/sqlite';
import * as shell from 'harness-dsl/shell';
import * as markdown from 'harness-dsl/markdown';
import { supervisor } from 'harness-dsl/claude-code';

const fresh = H.state('new', 'pending');
const classifying = H.state('classifying', 'active');
const drafting = H.state('drafting', 'active');
const awaitingApproval = H.state('awaiting-approval', 'active');
const sent = H.state('sent', 'terminal', 'success');
const closedByCustomer = H.state('closed-by-customer', 'terminal', 'neutral');
const escalated = H.state('escalated', 'terminal', 'neutral');

const Conversation = H.kind('Conversation')
  .data(z.object({
    conversationId: z.string(),
    lastMessage: z.string(),
    slaDue: z.string(),
    category: z.string().optional(),
    reviewerNotes: z.string().optional(),
  }))
  .states(fresh, classifying, drafting, awaitingApproval, sent, closedByCustomer, escalated);

const escalationRaised = H.state('escalation-raised', 'pending');
const escalationHandling = H.state('escalation-handling', 'active');
const escalationResolved = H.state('escalation-resolved', 'terminal', 'success');

const Escalation = H.kind('Escalation')
  .data(z.object({ conversationId: z.string(), reason: z.string() }))
  .states(escalationRaised, escalationHandling, escalationResolved);

const auditOpen = H.state('audit-open', 'pending');
const auditInProgress = H.state('audit-in-progress', 'active');
const auditClosed = H.state('audit-closed', 'terminal', 'neutral');
const auditCancelled = H.state('audit-cancelled', 'terminal', 'neutral');

const Audit = H.kind('Audit')
  .data(z.object({ category: z.string(), rateWhenOpened: z.number() }))
  .states(auditOpen, auditInProgress, auditClosed, auditCancelled);

const toneTaste = H.memory('reply-tone', 'taste');
const replyExperience = H.memory('reply-experience', 'experience');
const tone = H.library('tone', toneTaste, jsonl.memory('memory/tone.jsonl'));
const replyLessons = H.library('reply-lessons', replyExperience, jsonl.memory('memory/reply-lessons.jsonl'));

const haiku = anthropic.model('claude-haiku-4-5');
const sonnet = anthropic.model('claude-sonnet-4-5');
const api = anthropic.account('support-api', { apiKey: H.env('ANTHROPIC_API_KEY') });
const models = H.pool('models', [{ account: api, share: 1 }]);

const classifierRole = H.role('classifier')
  .input(z.object({ message: z.string() }))
  .output(z.object({ category: z.string() }))
  .prompt((m) => `Classify this customer message into one support category.\n\n${m.message}`);

const drafterRole = H.role('drafter')
  .input(z.object({ message: z.string(), category: z.string(), notes: z.string() }))
  .output(z.object({ reply: z.string() }))
  .prompt((m) => `Draft a reply for a ${m.category} conversation.\nReviewer notes: ${m.notes}\n\n${m.message}`);

const classifier = H.agent('classifier', classifierRole).model(haiku);
const drafter = H.agent('drafter', drafterRole).model(sonnet).recalls(tone, replyLessons);

const approval = H.halt('reply-approval', z.object({
  approved: z.boolean(),
  editedReply: z.string().optional(),
  tasteNote: z.string().optional(),
}));
const escalationOutcome = H.halt('escalation-outcome', z.object({ resolution: z.string() }));
const auditFinding = H.halt('audit-finding', z.object({ finding: z.string() }));

const outbox = shell.local('outbox', { slots: 4 });

const sendReply = H.command('send-reply')
  .input(z.object({ conversationId: z.string(), reply: z.string() }))
  .argv((r) => ['helpdesk-reply', r.conversationId, r.reply])
  .on(outbox);

function approvalsIn(metrics: Metrics, category: string): Rate {
  return metrics
    .rateBy({ among: approval.resolved(), count: approval.resolved({ approved: true }), by: { tag: 'category' } })
    .of(category);
}

const safeCategory = H.policy.rule('safe-category', (category: string, metrics: Metrics) => {
  const record = approvalsIn(metrics, category);
  return record.hits >= 200 && record.hits === record.samples;
});

const handleConversation = H.flow('handle-conversation')
  .for(Conversation)
  .phases('classifying', 'drafting', 'awaiting')
  .exits('sent', 'redraft')
  .does(async (ctx) => {
    const conversation = ctx.unit.data;
    await ctx.move('classifying');
    const classified = await ctx.run(classifier, { message: conversation.lastMessage });
    if (!classified.ok) return ctx.fail(classified.error);
    const category = classified.value.category;
    ctx.tag({ category });
    await ctx.update({ category });
    await ctx.move('drafting');
    const drafted = await ctx.run(
      drafter,
      { message: conversation.lastMessage, category, notes: conversation.reviewerNotes ?? '' },
      { scope: { resources: [`category:${category}`] } },
    );
    if (!drafted.ok) return ctx.fail(drafted.error);
    let reply = drafted.value.reply;
    const safe = await ctx.decide(safeCategory, category);
    if (!safe) {
      await ctx.move('awaiting');
      const decision = await ctx.halt(approval, reply);
      if (decision.tasteNote !== undefined) {
        await ctx.remember(tone, {
          text: decision.tasteNote,
          because: 'the reviewer edited a drafted reply this way',
          when: { roles: [drafterRole] },
        });
      }
      if (!decision.approved) {
        await ctx.update({ reviewerNotes: decision.tasteNote ?? 'rejected without notes' });
        return 'redraft';
      }
      reply = decision.editedReply ?? reply;
    }
    const delivered = await ctx.run(sendReply, { conversationId: conversation.conversationId, reply });
    if (!delivered.ok) return ctx.fail(delivered.error);
    return 'sent';
  });

const helpdeskAuth = { Authorization: H.env('HELPDESK_TOKEN') };

const helpdeskHook = http.webhook(Conversation, {
  path: '/hooks/helpdesk',
  secret: H.env('HELPDESK_WEBHOOK_SECRET'),
  body: z.object({
    event: z.enum(['created', 'customer-replied', 'closed']),
    conversationId: z.string(),
    message: z.string(),
    slaDue: z.string(),
  }),
  read: (b) => {
    if (b.event === 'created') {
      return { create: { conversationId: b.conversationId, lastMessage: b.message, slaDue: b.slaDue }, key: b.conversationId };
    }
    if (b.event === 'customer-replied') {
      return { update: b.conversationId, patch: { lastMessage: b.message }, state: 'new' };
    }
    return { update: b.conversationId, state: 'closed-by-customer' };
  },
});

const helpdeskPoll = http.poll(Conversation, {
  url: 'https://helpdesk.example.com/api/conversations?status=open',
  every: { minutes: 15 },
  headers: helpdeskAuth,
  body: z.object({ conversations: z.array(z.object({ id: z.string(), message: z.string(), slaDue: z.string() })) }),
  read: (b) => b.conversations.map((c) => ({
    create: { conversationId: c.id, lastMessage: c.message, slaDue: c.slaDue },
    key: c.id,
  })),
});

const helpdeskStore = http.store(Conversation, {
  url: 'https://helpdesk.example.com/api/conversations',
  headers: helpdeskAuth,
  stateField: 'harness_state',
});

const conversations = H.lane('conversations', Conversation)
  .handler(handleConversation, { classifying, drafting, awaiting: awaitingApproval, sent, redraft: fresh })
  .suppliers(helpdeskHook, helpdeskPoll)
  .store(helpdeskStore)
  .maxUsdPerUnit(0.4);

const handleEscalation = H.flow('handle-escalation')
  .for(Escalation)
  .phases('handling')
  .exits('resolved')
  .does(async (ctx) => {
    await ctx.move('handling');
    await ctx.halt(escalationOutcome, `Conversation ${ctx.unit.data.conversationId}: ${ctx.unit.data.reason}`);
    return 'resolved';
  });

const escalations = H.lane('escalations', Escalation)
  .handler(handleEscalation, { handling: escalationHandling, resolved: escalationResolved });

function monthStart(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

function auditsOpenedThisMonth(metrics: Metrics, category: string, now: Date): number {
  const opened = { entry: 'firing', status: 'tripped', trigger: approvalWatch } as const;
  return metrics.rateBy({ among: opened, count: opened, by: 'group', since: monthStart(now) }).of(category).samples;
}

function lanePausedMsThisMonth(metrics: Metrics, now: Date): number {
  return metrics.sum({
    of: 'durationMs',
    among: { entry: 'lane', status: 'resumed', lane: conversations },
    since: monthStart(now),
  }).value ?? 0;
}

const auditBrief = H.policy.rule('audit-brief', (input: { category: string; now: Date }, metrics: Metrics) =>
  `Category ${input.category}: ${auditsOpenedThisMonth(metrics, input.category, input.now)} audits opened this month; ` +
  `conversations lane paused ${Math.round(lanePausedMsThisMonth(metrics, input.now) / 60000)} minutes this month.`);

const runAudit = H.flow('run-audit')
  .for(Audit)
  .phases('auditing')
  .exits('closed')
  .does(async (ctx) => {
    await ctx.move('auditing');
    const brief = await ctx.decide(auditBrief, { category: ctx.unit.data.category, now: ctx.now() });
    await ctx.halt(auditFinding, brief);
    return 'closed';
  });

const audits = H.lane('audits', Audit)
  .handler(runAudit, { auditing: auditInProgress, closed: auditClosed });

const slaBreach = H.trigger(
  'sla-breach',
  H.on.deadline(Conversation, (c) => new Date(c.slaDue), ['new', 'classifying', 'drafting', 'awaiting-approval']),
  (event, act) => [
    act.move('escalated'),
    act.create(
      escalations,
      { conversationId: event.unit.data.conversationId, reason: `SLA breached at ${event.at.toISOString()}` },
      `escalation-${event.unit.key}`,
    ),
  ],
);

const approvalWatch = H.trigger(
  'approval-rate-watch',
  H.on.metric(
    (metrics) => metrics.rateBy({
      among: approval.resolved(),
      count: approval.resolved({ approved: true }),
      by: { tag: 'category' },
      days: 7,
    }),
    { trip: { below: 0.9 }, reset: { above: 0.95 }, minSamples: 50 },
  ),
  (event, act) =>
    event.state === 'tripped'
      ? [
          act.create(audits, { category: event.group, rateWhenOpened: event.rate.value ?? 0 }, `audit-${event.group}`),
          act.remember(replyLessons, {
            text: `When drafting for ${event.group}, recall the stricter phrasing`,
            because: `approvals fell to ${event.rate.value ?? 0} over ${event.rate.samples} samples`,
            when: { roles: [drafterRole], resources: [`category:${event.group}`] },
            status: 'candidate',
          }),
        ]
      : act.move(audits, `audit-${event.group}`, 'audit-cancelled'),
);

const errorWatch = H.trigger(
  'model-error-watch',
  H.on.metric(
    (metrics) => metrics.rate({
      among: { entry: 'invocation', status: 'ended', mode: 'model' },
      count: { entry: 'invocation', status: 'ended', mode: 'model', ok: false },
      hours: 1,
    }),
    { trip: { above: 0.2 }, reset: { below: 0.05 }, minSamples: 20 },
  ),
  (event, act) => (event.state === 'tripped' ? act.pause(conversations) : act.resume(conversations)),
);

function breachAt(unit: PendingView): number {
  return unit.is(Conversation) ? Date.parse(unit.data.slaDue) : 0;
}

const byTimeToBreach = H.policy.scheduler('time-to-breach', (view) => ({
  start: [...view.pending].sort((a, b) => breachAt(a) - breachAt(b)),
}));

export const support = H.harness('support-triage')
  .ledger(sqlite.ledger('.harness/support.db'))
  .lanes(conversations, escalations, audits)
  .pools(models)
  .triggers(slaBreach, approvalWatch, errorWatch)
  .scheduler(byTimeToBreach)
  .clients(supervisor({
    grants: [
      H.ops.readWork,
      H.ops.writeWork,
      H.ops.resolveHalts,
      H.ops.readMemory,
      H.ops.writeMemory,
      H.ops.curateMemory,
      H.ops.readTelemetry,
    ],
  }))
  .observers(markdown.board('board.md'), markdown.telemetry('telemetry.md'));
