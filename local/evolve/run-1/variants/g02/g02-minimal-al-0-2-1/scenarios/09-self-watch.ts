import { z } from 'zod';
import { H } from 'harness-dsl';
import type { Metrics, PendingView, Rate, SupplyOf } from 'harness-dsl';
import * as anthropic from 'harness-dsl/anthropic';
import * as http from 'harness-dsl/http';
import * as sqlite from 'harness-dsl/sqlite';
import * as jsonl from 'harness-dsl/jsonl';
import * as shell from 'harness-dsl/shell';
import * as claude from 'harness-dsl/claude-code';
import * as markdown from 'harness-dsl/markdown';

const HOUR = 60 * 60 * 1000;
const monthStart = (now: Date): Date => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));

const api = anthropic.account('anthropic-api', { apiKey: H.env('ANTHROPIC_API_KEY') });
const haiku = anthropic.model('claude-haiku-4-5');
const sonnet = anthropic.model('claude-sonnet-4-5');
const opus = anthropic.model('claude-opus-4-1');
const local = shell.local('local', { slots: 4 });

const New = H.state('new', 'pending');
const Classifying = H.state('classifying', 'pending');
const Drafting = H.state('drafting', 'active');
const AwaitingApproval = H.state('awaiting-approval', 'active');
const Sent = H.state('sent', 'terminal', 'success');
const ClosedByCustomer = H.state('closed-by-customer', 'terminal', 'neutral');
const Escalated = H.state('escalated', 'terminal', 'failure');

const Conversation = H.kind('conversation')
  .data(z.object({
    subject: z.string(),
    latestMessage: z.string(),
    slaDue: z.string(),
    category: z.string().optional(),
  }))
  .states(New, Classifying, Drafting, AwaitingApproval, Sent, ClosedByCustomer, Escalated);

const Raised = H.state('raised', 'pending');
const Handled = H.state('handled', 'terminal', 'success');

const Escalation = H.kind('escalation')
  .data(z.object({ conversationId: z.string(), subject: z.string(), reason: z.string() }))
  .states(Raised, Handled);

const AuditOpen = H.state('open', 'pending');
const AuditResolved = H.state('resolved', 'terminal', 'success');
const AuditCancelled = H.state('cancelled', 'terminal', 'neutral');

const Audit = H.kind('audit')
  .data(z.object({ category: z.string(), rate: z.number().nullable(), samples: z.number() }))
  .states(AuditOpen, AuditResolved, AuditCancelled);

const taste = H.library('support-taste', H.memory('tone', 'taste'), jsonl.memory('memory/taste.jsonl'));
const experience = H.library('support-experience', H.memory('support-lessons', 'experience'), jsonl.memory('memory/experience.jsonl'));

const helpdeskHeaders = { authorization: H.env('HELPDESK_TOKEN') };

const helpdeskEvent = z.object({
  conversationId: z.string(),
  event: z.enum(['created', 'customer-replied', 'closed']),
  subject: z.string(),
  message: z.string(),
  slaDue: z.string(),
});

function supplyConversation(body: z.infer<typeof helpdeskEvent>): SupplyOf<typeof Conversation> {
  if (body.event === 'customer-replied') {
    return { update: body.conversationId, patch: { latestMessage: body.message }, state: 'classifying' };
  }
  if (body.event === 'closed') return { update: body.conversationId, state: 'closed-by-customer' };
  return {
    create: { subject: body.subject, latestMessage: body.message, slaDue: body.slaDue },
    key: body.conversationId,
  };
}

const helpdeskWebhook = http.webhook(Conversation, {
  path: '/helpdesk',
  secret: H.env('HELPDESK_WEBHOOK_SECRET'),
  body: helpdeskEvent,
  read: supplyConversation,
});

const helpdeskPoll = http.poll(Conversation, {
  url: 'https://helpdesk.example.com/api/conversations?status=open',
  every: { minutes: 15 },
  headers: helpdeskHeaders,
  body: z.object({
    conversations: z.array(z.object({ id: z.string(), subject: z.string(), message: z.string(), slaDue: z.string() })),
  }),
  read: body => body.conversations.map(c => ({
    create: { subject: c.subject, latestMessage: c.message, slaDue: c.slaDue },
    key: c.id,
  })),
});

const helpdeskStore = http.store(Conversation, {
  url: 'https://helpdesk.example.com/api/conversations',
  headers: helpdeskHeaders,
  stateField: 'harness_state',
});

const classifierRole = H.role('classifier')
  .input(z.object({ subject: z.string(), message: z.string() }))
  .output(z.object({ category: z.string() }))
  .prompt(input => `Classify this support conversation.\n\n${input.subject}\n\n${input.message}`);

const drafterRole = H.role('drafter')
  .input(z.object({ subject: z.string(), message: z.string(), category: z.string() }))
  .output(z.object({ reply: z.string() }))
  .prompt(input => `Draft a reply for a ${input.category} conversation.\n\n${input.subject}\n\n${input.message}`);

const drafterModel = H.policy.model('drafter-model', choice => {
  const paused = choice.metrics.sum({
    of: 'durationMs',
    among: { entry: 'lane', lane: conversations, status: 'resumed' },
    since: monthStart(choice.now),
  });
  return (paused.value ?? 0) > HOUR ? opus : sonnet;
});

const classifier = H.agent('classifier', classifierRole).model(haiku);
const drafter = H.agent('drafter', drafterRole).model(drafterModel).recalls(taste, experience);

const approveReply = H.decision('approve-reply')
  .input(z.object({ category: z.string(), model: z.string(), reply: z.string() }))
  .output(z.object({ approved: z.boolean(), editedReply: z.string().optional() }))
  .show(input => `[${input.category}] ${input.reply}`)
  .policy((input, metrics, self) => {
    const rejections = metrics.rateBy({
      among: self.resolved(undefined, 'human'),
      count: self.resolved({ approved: false }, 'human'),
      by: H.by.input(self, 'category'),
    })[input.category];
    return rejections !== undefined && rejections.samples >= 200 && rejections.hits === 0 ? { approved: true } : H.ask;
  });

const approvalByCategory = (metrics: Metrics): Readonly<Record<string, Rate>> => metrics.rateBy({
  among: approveReply.resolved(undefined, 'human'),
  count: approveReply.resolved({ approved: true }, 'human'),
  by: H.by.input(approveReply, 'category'),
  days: 7,
});

const sendReply = H.command('send-reply')
  .input(z.object({ conversationId: z.string(), reply: z.string() }))
  .argv(input => ['helpdesk-reply', '--conversation', input.conversationId, '--body', input.reply])
  .on(local);

const handleConversation = H.flow('handle-conversation').for(Conversation).does(async ctx => {
  const { subject, latestMessage } = ctx.unit.data;
  const classified = await ctx.run(classifier, { subject, message: latestMessage });
  if (classified.ok === false) return ctx.fail(classified.error);
  const category = classified.value.category;
  await ctx.update({ category });
  await ctx.move('drafting');

  const draft = await ctx.run(drafter, { subject, message: latestMessage, category }, {
    scope: { resources: [`category/${category}`] },
  });
  if (draft.ok === false) return ctx.fail(draft.error);
  await ctx.move('awaiting-approval');

  const verdict = await ctx.decide(approveReply, { category, model: draft.model ?? 'unknown', reply: draft.value.reply });
  if (verdict.approved === false) return 'classifying';
  if (verdict.editedReply !== undefined && verdict.editedReply !== draft.value.reply) {
    await ctx.remember(taste, {
      text: `When replying in ${category}, phrase it like: "${verdict.editedReply}"`,
      because: `the reviewer rewrote "${draft.value.reply}" before approving`,
      when: { roles: [drafterRole.name], resources: [`category/${category}`] },
      status: 'candidate',
    });
  }

  const sent = await ctx.run(sendReply, { conversationId: ctx.unit.key, reply: verdict.editedReply ?? draft.value.reply });
  if (sent.ok === false) return ctx.fail(sent.error);
  return 'sent';
});

const escalationResolution = H.decision('escalation-resolution')
  .input(z.object({ conversationId: z.string(), subject: z.string(), reason: z.string() }))
  .output(z.object({ resolution: z.string() }))
  .show(input => `${input.subject}: ${input.reason}`);

const handleEscalation = H.flow('handle-escalation').for(Escalation).does(async ctx => {
  await ctx.decide(escalationResolution, ctx.unit.data);
  return 'handled';
});

const auditFindings = H.decision('audit-findings')
  .input(z.object({ category: z.string(), rate: z.number().nullable(), samples: z.number() }))
  .output(z.object({ findings: z.string() }))
  .show(input => `Approvals for ${input.category} fell to ${input.rate ?? 'unknown'} over ${input.samples} samples`);

const runAudit = H.flow('run-audit').for(Audit).does(async ctx => {
  await ctx.decide(auditFindings, ctx.unit.data);
  return 'resolved';
});

const conversations = H.lane('conversations', Conversation)
  .handler(handleConversation)
  .suppliers(helpdeskWebhook, helpdeskPoll)
  .store(helpdeskStore)
  .maxUsdPerUnit(0.4);

const escalations = H.lane('escalations', Escalation).handler(handleEscalation);
const audits = H.lane('audits', Audit).handler(runAudit);

const slaBreach = H.trigger(
  'sla-breach',
  H.on.deadline(Conversation, data => new Date(data.slaDue), ['new', 'classifying', 'drafting', 'awaiting-approval']),
  (event, act) => [
    act.create(escalations, {
      conversationId: event.unit.key,
      subject: event.unit.data.subject,
      reason: `SLA breached at ${event.at.toISOString()}`,
    }, `sla-${event.unit.key}`),
    act.move('escalated'),
  ],
);

const auditKey = (category: string): string => `audit-${category}`;

const approvalAudit = H.trigger(
  'approval-audit',
  H.on.metricBy(approvalByCategory, { trip: { below: 0.9 }, reset: { above: 0.95 }, minSamples: 50 }),
  (event, act) => event.state === 'tripped'
    ? [
      act.create(audits, { category: event.group, rate: event.rate.value, samples: event.rate.samples }, auditKey(event.group)),
      act.remember(experience, {
        text: `When drafting for ${event.group}, recall the stricter phrasing`,
        because: `approvals fell to ${event.rate.value ?? 'unknown'} over ${event.rate.samples} samples`,
        when: { roles: [drafterRole.name], resources: [`category/${event.group}`] },
        status: 'candidate',
      }),
    ]
    : [act.move(audits, auditKey(event.group), 'cancelled')],
);

const modelErrorPause = H.trigger(
  'model-error-pause',
  H.on.metric(metrics => metrics.rate({
    among: { entry: 'invocation', lane: conversations, mode: 'model', status: 'ended' },
    count: { entry: 'invocation', lane: conversations, mode: 'model', status: 'ended', ok: false },
    hours: 1,
  }), { trip: { above: 0.2 }, reset: { below: 0.05 }, minSamples: 20 }),
  (event, act) => (event.state === 'tripped' ? act.pause(conversations) : act.resume(conversations)),
);

const auditsOpenedThisMonth = (metrics: Metrics, now: Date): Readonly<Record<string, Rate>> => metrics.rateBy({
  among: { entry: 'transition', kind: Audit },
  count: { entry: 'transition', kind: Audit, state: AuditOpen },
  by: H.by.data(Audit, 'category'),
  since: monthStart(now),
});

const scheduler = H.policy.scheduler('escalations-audits-then-time-to-breach', view => {
  const openings = auditsOpenedThisMonth(view.metrics, view.now);
  const priority = (unit: PendingView): number => {
    if (unit.is(Escalation)) return -2e15;
    if (unit.is(Audit)) return -1e15 - (openings[unit.data.category]?.hits ?? 0);
    if (unit.is(Conversation)) return new Date(unit.data.slaDue).getTime() - view.now.getTime();
    return Number.MAX_SAFE_INTEGER;
  };
  return { start: [...view.pending].sort((a, b) => priority(a) - priority(b)) };
});

export const running = H.harness('support-self-watch')
  .ledger(sqlite.ledger('.harness/support.db'))
  .pools(H.pool('anthropic', [{ account: api, share: 1 }]))
  .lanes(conversations, escalations, audits)
  .triggers(slaBreach, approvalAudit, modelErrorPause)
  .scheduler(scheduler)
  .clients(claude.supervisor({
    grants: [
      H.ops.readWork,
      H.ops.writeWork,
      H.ops.resolveDecisions,
      H.ops.readMemory,
      H.ops.writeMemory,
      H.ops.curateMemory,
      H.ops.readTelemetry,
    ],
  }))
  .observers(markdown.board('BOARD.md'), markdown.telemetry('TELEMETRY.md'))
  .start();
