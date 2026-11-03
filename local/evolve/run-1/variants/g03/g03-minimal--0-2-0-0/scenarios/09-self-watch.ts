import { z } from 'zod';
import { H } from 'harness-dsl';
import type { PendingView, SupplyOf } from 'harness-dsl';
import * as anthropic from 'harness-dsl/anthropic';
import * as cc from 'harness-dsl/claude-code';
import * as http from 'harness-dsl/http';
import * as jsonl from 'harness-dsl/jsonl';
import * as markdown from 'harness-dsl/markdown';
import * as shell from 'harness-dsl/shell';
import * as sqlite from 'harness-dsl/sqlite';

const newConversation = H.state('new', 'pending');
const classifying = H.state('classifying', 'pending');
const drafting = H.state('drafting', 'pending');
const awaitingApproval = H.state('awaitingApproval', 'active');
const sent = H.state('sent', 'waiting');
const closedByCustomer = H.state('closedByCustomer', 'terminal', 'success');
const escalated = H.state('escalated', 'terminal', 'failure');

const Conversation = H.kind('conversation')
  .data(
    z.object({
      id: z.string(),
      customer: z.string(),
      message: z.string(),
      slaDue: z.string(),
      category: z.string().optional(),
    }),
  )
  .states(newConversation, classifying, drafting, awaitingApproval, sent, closedByCustomer, escalated)
  .failsTo('drafting');

const escalationOpen = H.state('escalationOpen', 'pending');
const escalationResolved = H.state('escalationResolved', 'terminal', 'success');
const Escalation = H.kind('escalation')
  .data(z.object({ conversation: z.string(), reason: z.string() }))
  .states(escalationOpen, escalationResolved);

const auditOpen = H.state('auditOpen', 'pending');
const auditClosed = H.state('auditClosed', 'terminal', 'success');
const auditCancelled = H.state('auditCancelled', 'terminal', 'neutral');
const Audit = H.kind('audit')
  .data(z.object({ category: z.string(), rateAtOpen: z.number().nullable() }))
  .states(auditOpen, auditClosed, auditCancelled);

const categoryTag = H.tag('category');
const drafterModel = H.tag('drafter-model');

const taste = H.memory('reply-taste', 'taste');
const experience = H.memory('support-experience', 'experience');
const tasteArchive = H.archive('reviewer-taste', taste, jsonl.memory('memory/taste.jsonl'));
const experienceArchive = H.archive('drafting-experience', experience, jsonl.memory('memory/experience.jsonl'));

const classifierRole = H.role('classifier')
  .input(z.object({ message: z.string() }))
  .output(z.object({ category: z.string() }))
  .prompt((conversation) => `Classify this customer message into one support category.\n\n${conversation.message}`);

const drafterRole = H.role('drafter')
  .input(z.object({ message: z.string(), category: z.string() }))
  .output(z.object({ reply: z.string() }))
  .prompt((conversation) => `Draft a reply for a ${conversation.category} conversation.\n\n${conversation.message}`);

const classifier = H.agent('classifier', classifierRole).model(anthropic.model('claude-haiku-4-5'));
const drafter = H.agent('drafter', drafterRole)
  .model(anthropic.model('claude-opus-4-1'))
  .recalls(H.briefing('drafter-briefing', [tasteArchive, experienceArchive]));

const approval = H.halt(
  'reply-approval',
  z.object({
    approved: z.boolean(),
    editedReply: z.string().optional(),
    tasteNote: z.string().optional(),
  }),
);

const autoSend = H.policy.rule(
  'auto-send-safe-category',
  { input: z.object({ category: z.string() }), output: z.boolean() },
  ({ category }, metrics) => {
    const approvals = metrics
      .rateBy({ among: approval.resolved(), count: approval.resolved({ approved: true }), by: categoryTag })
      .of(category);
    return approvals.samples >= 200 && approvals.hits === approvals.samples;
  },
);

const local = shell.local('local', { slots: 4 });

const sendReply = H.command('send-reply')
  .input(z.object({ conversation: z.string(), reply: z.string() }))
  .argv((outgoing) => ['helpdesk-reply', '--conversation', outgoing.conversation, '--body', outgoing.reply])
  .on(local)
  .recovers('park');

const conversationFlow = H.flow('conversation')
  .for(Conversation)
  .does(async (ctx) => {
    const classified = await ctx.run(classifier, { message: ctx.unit.data.message });
    if (!classified.ok) return ctx.fail(classified.error);
    await ctx.update({ category: classified.value.category });
    return 'drafting';
  })
  .phase('drafting', async (ctx) => {
    const category = ctx.unit.data.category ?? 'uncategorised';
    ctx.tag(categoryTag, category);
    const drafted = await ctx.run(drafter, { message: ctx.unit.data.message, category });
    if (!drafted.ok) return ctx.fail(drafted.error);
    ctx.tag(drafterModel, drafted.model);
    await ctx.move('awaitingApproval');
    let reply = drafted.value.reply;
    const safe = await ctx.decide(autoSend, { category });
    if (!safe) {
      const decision = await ctx.halt(approval, reply);
      if (decision.tasteNote !== undefined) {
        await ctx.remember(tasteArchive, {
          text: decision.tasteNote,
          when: { roles: [drafterRole], tags: [categoryTag.is(category)] },
        });
      }
      if (!decision.approved) return ctx.fail('rejected by reviewer', 'drafting');
      reply = decision.editedReply ?? reply;
    }
    const posted = await ctx.run(sendReply, { conversation: ctx.unit.data.id, reply });
    if (!posted.ok) return ctx.fail(posted.error);
    return 'sent';
  });

const helpdeskHeaders = { authorization: H.env('HELPDESK_TOKEN') };

const helpdeskEvent = z.object({
  type: z.enum(['created', 'replied', 'closed']),
  conversation: z.string(),
  customer: z.string(),
  message: z.string(),
  slaDue: z.string(),
});

const fromHelpdesk = (event: z.infer<typeof helpdeskEvent>): SupplyOf<typeof Conversation> =>
  event.type === 'created'
    ? {
        create: { id: event.conversation, customer: event.customer, message: event.message, slaDue: event.slaDue },
        key: event.conversation,
      }
    : event.type === 'replied'
      ? { update: event.conversation, patch: { message: event.message }, state: 'classifying' }
      : { update: event.conversation, state: 'closedByCustomer' };

const conversations = H.lane('conversations', Conversation)
  .handler(conversationFlow)
  .suppliers(
    http.webhook(Conversation, {
      path: '/helpdesk/events',
      secret: H.env('HELPDESK_WEBHOOK_SECRET'),
      body: helpdeskEvent,
      read: fromHelpdesk,
    }),
    http.poll(Conversation, {
      url: 'https://helpdesk.example.com/api/conversations?status=open',
      every: { minutes: 5 },
      headers: helpdeskHeaders,
      body: z.object({ conversations: z.array(helpdeskEvent) }),
      read: (body) => body.conversations.map(fromHelpdesk),
    }),
  )
  .store(
    http.store(Conversation, {
      url: 'https://helpdesk.example.com/api/conversations',
      headers: helpdeskHeaders,
      stateField: 'harness_state',
    }),
  )
  .maxUsdPerUnit(0.4);

const escalationResolution = H.halt('escalation-resolution', z.object({ resolution: z.string() }));

const escalationFlow = H.flow('escalation')
  .for(Escalation)
  .does(async (ctx) => {
    await ctx.halt(escalationResolution, `Conversation ${ctx.unit.data.conversation} escalated: ${ctx.unit.data.reason}`);
    return 'escalationResolved';
  });

const escalations = H.lane('escalations', Escalation).handler(escalationFlow);

const auditContext = H.policy.rule(
  'audit-context',
  {
    input: z.object({ category: z.string() }),
    output: z.object({ auditsOpened: z.number(), pausedMinutes: z.number(), pauses: z.number() }),
  },
  ({ category }, metrics) => {
    const opened = metrics
      .rateBy({
        among: { entry: 'transition', kind: Audit },
        count: { entry: 'transition', kind: Audit, state: auditOpen },
        by: categoryTag,
        days: 30,
      })
      .of(category);
    const paused = metrics.sum({
      of: 'durationMs',
      among: { entry: 'lane', lane: conversations, status: 'resumed' },
      days: 30,
    });
    return { auditsOpened: opened.hits, pausedMinutes: paused.value / 60000, pauses: paused.samples };
  },
);

const auditReview = H.halt('audit-review', z.object({ findings: z.string() }));

const auditFlow = H.flow('audit')
  .for(Audit)
  .does(async (ctx) => {
    const context = await ctx.decide(auditContext, { category: ctx.unit.data.category });
    await ctx.halt(
      auditReview,
      `Approval rate for ${ctx.unit.data.category} fell to ${ctx.unit.data.rateAtOpen ?? 'unknown'}. ` +
        `Audits opened for it in 30 days: ${context.auditsOpened}. ` +
        `Conversations lane paused ${context.pauses} times for ${context.pausedMinutes.toFixed(0)} minutes in 30 days.`,
    );
    return 'auditClosed';
  });

const audits = H.lane('audits', Audit).handler(auditFlow);

const slaBreach = H.trigger(
  'sla-breach-escalates',
  H.on.deadline(Conversation, (data) => new Date(data.slaDue), ['new', 'classifying', 'drafting', 'awaitingApproval']),
  (event, act) => [
    act.move('escalated'),
    act.create(
      escalations,
      { conversation: event.unit.data.id, reason: `SLA due ${event.unit.data.slaDue} breached` },
      `escalation-${event.unit.data.id}`,
    ),
  ],
);

const approvalAudit = H.trigger(
  'approval-rate-audit',
  H.on.metric(
    (metrics) =>
      metrics.rateBy({
        among: approval.resolved(),
        count: approval.resolved({ approved: true }),
        by: categoryTag,
        days: 7,
      }),
    { trip: { below: 0.9 }, reset: { above: 0.95 }, minSamples: 50, group: categoryTag },
  ),
  (event, act) =>
    event.state === 'tripped'
      ? [
          act.create(audits, { category: event.group, rateAtOpen: event.rate.value }, `audit-${event.group}`),
          act.remember(experienceArchive, {
            text: `When drafting for ${event.group}, recall the stricter phrasing`,
            because: `approvals fell to ${(event.rate.value ?? 0).toFixed(2)} over ${event.rate.samples} samples`,
            when: { roles: [drafterRole], tags: [categoryTag.is(event.group)] },
            status: 'candidate',
          }),
        ]
      : act.move(audits, `audit-${event.group}`, 'auditCancelled'),
);

const modelErrorPause = H.trigger(
  'model-errors-pause-conversations',
  H.on.metric(
    (metrics) =>
      metrics.rate({
        among: { entry: 'invocation', mode: 'model', status: 'ended' },
        count: { entry: 'invocation', mode: 'model', status: 'ended', ok: false },
        hours: 1,
      }),
    { trip: { above: 0.2 }, reset: { below: 0.05 }, minSamples: 20 },
  ),
  (event, act) => (event.state === 'tripped' ? act.pause(conversations) : act.resume(conversations)),
);

const MINUTE_MS = 60 * 1000;

const byTimeToBreach = H.policy.scheduler('time-to-breach', ({ now, pending, metrics }) => {
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const auditsOpened = metrics.rateBy({
    among: { entry: 'transition', kind: Audit },
    count: { entry: 'transition', kind: Audit, state: auditOpen },
    by: categoryTag,
    since: monthStart,
  });
  const urgency = (unit: PendingView) => {
    if (!unit.is(Conversation)) return Number.MIN_SAFE_INTEGER;
    const audited = auditsOpened.of(unit.data.category ?? 'uncategorised').hits >= 2 ? 15 * MINUTE_MS : 0;
    return Date.parse(unit.data.slaDue) - now.getTime() - audited;
  };
  return { start: [...pending].sort((a, b) => urgency(a) - urgency(b)) };
});

const api = anthropic.account('anthropic-api', { apiKey: H.env('ANTHROPIC_API_KEY') });

export const harness = H.harness('support-self-watch')
  .ledger(sqlite.ledger('.harness/support.db'))
  .lanes(conversations, escalations, audits)
  .pools(H.pool('support-accounts', [{ account: api, share: 1 }]))
  .triggers(slaBreach, approvalAudit, modelErrorPause)
  .scheduler(byTimeToBreach)
  .clients(
    cc.supervisor({
      grants: [
        H.ops.readWork,
        H.ops.writeWork,
        H.ops.resolveHalts,
        H.ops.readMemory,
        H.ops.writeMemory,
        H.ops.curateMemory,
        H.ops.readTelemetry,
      ],
    }),
  )
  .observers(markdown.board('BOARD.md'), markdown.telemetry('TELEMETRY.md'));
