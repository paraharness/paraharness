import { z } from 'zod';
import { H, type Route, type Router } from 'harness-dsl';
import { sqlite } from 'harness-dsl/sqlite';
import { jsonl } from 'harness-dsl/jsonl';
import { anthropic } from 'harness-dsl/anthropic';
import { claudeCode } from 'harness-dsl/claude-code';
import { zendesk, type ZendeskEvent } from 'harness-dsl/zendesk';
import { local } from 'harness-dsl/local';
import { markdown } from 'harness-dsl/markdown';

const supportApi = anthropic.account('support-api', { apiKey: H.env('ANTHROPIC_API_KEY') });
const haiku = anthropic.model('haiku', { id: 'claude-haiku-4-5' });
const sonnet = anthropic.model('sonnet', { id: 'claude-sonnet-4-5' });
const opus = anthropic.model('opus', { id: 'claude-opus-4-1' });
const box = local.runner('support-box');

function daysIntoMonth(now: Date): number {
  return (now.getTime() - Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)) / 86_400_000;
}

const classifier = H.role('classifier').intents('read').instructions('Classify the customer conversation into one support category.');
const drafter = H.role('drafter').intents('read').instructions('Draft the reply to the customer in the house tone.');

const supportTaste = H.memory('support-taste', 'taste');
const supportExperience = H.memory('support-experience', 'experience');
const bySpecificity = H.recall('support-by-specificity', { by: 'specificity', limit: 15 });

const tasteJournal = H.journal('support-taste-journal', supportTaste)
  .store(jsonl.memoryStore({ path: 'memory/support-taste.jsonl' }))
  .recall(bySpecificity)
  .readBy(drafter);

const experienceJournal = H.journal('support-experience-journal', supportExperience)
  .store(jsonl.memoryStore({ path: 'memory/support-experience.jsonl' }))
  .recall(bySpecificity)
  .readBy(drafter);

const classifierAgent = H.agent('classifier').role(classifier).model(haiku).output(z.object({ category: z.string() }));

const drafterModel = H.policy.model('drafter-model', [opus, sonnet], ctx => {
  const paused = ctx.metrics.pausedMs(conversations, { windowDays: daysIntoMonth(ctx.now) });
  return paused.totalMs > 2 * 3_600_000 ? sonnet : opus;
});

const drafterAgent = H.agent('drafter').role(drafter).model(drafterModel).output(z.object({ reply: z.string() }));

const sendReply = H.command('send-reply')
  .input(z.object({ ticketId: z.string(), reply: z.string() }))
  .argv(input => ['helpdesk-reply', input.ticketId, input.reply])
  .runner(box);

const ConversationAttributes = z.object({
  ticketId: z.string(),
  subject: z.string(),
  message: z.string(),
  customerEmail: z.string(),
  slaDeadline: z.string(),
});
type ConversationAttrs = z.infer<typeof ConversationAttributes>;

const New = H.state('new', 'pending');
const Classifying = H.state('classifying', 'active');
const Drafting = H.state('drafting', 'active');
const AwaitingApproval = H.state('awaiting-approval', 'waiting');
const Sent = H.state('sent', 'terminal', 'success');
const ClosedByCustomer = H.state('closed-by-customer', 'terminal', 'neutral');
const Escalated = H.state('escalated', 'terminal', 'neutral');

const Conversation = H.kind('Conversation')
  .attributes(ConversationAttributes)
  .states(New, Classifying, Drafting, AwaitingApproval, Sent, ClosedByCustomer, Escalated)
  .key(c => c.ticketId);

const CustomerReplied = H.signal('customer-replied').payload(z.object({ message: z.string() }));
const CustomerClosed = H.signal('customer-closed').payload(z.object({ status: z.string() }));
const ExtendSla = H.signal('extend-sla').payload(z.object({ deadline: z.string() }));
const Escalate = H.signal('escalate');

const conversationFlow = H.flow('conversation')
  .input(ConversationAttributes)
  .step('classify', classifierAgent, ctx => ({ task: `${ctx.unit.attributes.subject}\n\n${ctx.unit.attributes.message}` }))
  .step('draft', drafterAgent, ctx => ({
    task: `Reply to ${ctx.unit.attributes.customerEmail}: ${ctx.unit.attributes.message}`,
    skills: [ctx.steps.classify.category],
  }))
  .halt('approval', {
    ask: ctx => `Approve the ${ctx.steps.classify.category} reply to ${ctx.unit.attributes.ticketId}?\n\n${ctx.steps.draft.reply}`,
    decision: z.object({ approved: z.boolean(), reply: z.string(), auto: z.boolean() }),
    skip: ctx => {
      const record = ctx.metrics.rate(approvals, { group: ctx.steps.classify.category });
      return record.samples >= 200 && record.hits === record.samples
        ? { approved: true, reply: ctx.steps.draft.reply, auto: true }
        : undefined;
    },
  })
  .exit('rejected', ctx => !ctx.steps.approval.approved)
  .step('send', sendReply, ctx => ({ ticketId: ctx.unit.attributes.ticketId, reply: ctx.steps.approval.reply }))
  .exit('sent');

function slaMs(priority: ZendeskEvent['priority']): number {
  if (priority === 'urgent') return 3_600_000;
  if (priority === 'high') return 4 * 3_600_000;
  return 24 * 3_600_000;
}

function routeTicket<SN extends string>(event: ZendeskEvent, to: Router<ConversationAttrs, SN>): Route {
  if (event.status === 'solved' || event.status === 'closed') return to.signal(CustomerClosed, event.ticketId, { status: event.status });
  if (event.type === 'replied') return to.signal(CustomerReplied, event.ticketId, { message: event.message });
  return to.create({
    ticketId: event.ticketId,
    subject: event.subject,
    message: event.message,
    customerEmail: event.customerEmail,
    slaDeadline: new Date(event.createdAt.getTime() + slaMs(event.priority)).toISOString(),
  });
}

const helpdeskToken = H.env('ZENDESK_TOKEN');

const conversations = H.lane('conversations', Conversation)
  .supply(zendesk.webhook({ port: H.slot.port(1), path: '/zendesk', secret: H.env('ZENDESK_WEBHOOK_SECRET') }), routeTicket)
  .supply(zendesk.poll({ subdomain: 'acme', token: helpdeskToken, everyMinutes: 10 }), routeTicket)
  .store(zendesk.store({ subdomain: 'acme', token: helpdeskToken }))
  .handler(conversationFlow, {
    exits: { rejected: Escalated, sent: Sent },
    during: { classify: Classifying, draft: Drafting, approval: AwaitingApproval },
    failure: Escalated,
  })
  .on(CustomerReplied, { update: (attrs, reply) => ({ ...attrs, message: reply.message }), restart: 'classify' })
  .on(CustomerClosed, { enter: ClosedByCustomer })
  .on(ExtendSla, { update: (attrs, extension) => ({ ...attrs, slaDeadline: extension.deadline }) })
  .on(Escalate, { enter: Escalated })
  .ceiling({ maxUsd: 0.4, onExceed: 'halt' });

const CanaryAttributes = z.object({ probe: z.string() });
const CanaryDue = H.state('canary-due', 'pending');
const CanaryRunning = H.state('canary-running', 'active');
const CanaryOk = H.state('canary-ok', 'terminal', 'success');
const CanaryFailed = H.state('canary-failed', 'terminal', 'failure');
const ModelCanary = H.kind('ModelCanary').attributes(CanaryAttributes).states(CanaryDue, CanaryRunning, CanaryOk, CanaryFailed).key(c => c.probe);

const canaryFlow = H.flow('model-canary')
  .input(CanaryAttributes)
  .step('probe', classifierAgent, () => ({ task: 'My invoice was charged twice this month.' }))
  .exit('ok');

const canaries = H.lane('model-canaries', ModelCanary)
  .supply(H.clock('canary-clock').every({ minutes: 2 }), (tick, to) => to.create({ probe: tick.at.toISOString() }))
  .handler(canaryFlow, { exits: { ok: CanaryOk }, during: { probe: CanaryRunning }, failure: CanaryFailed });

const EscalationAttributes = z.object({ ticketId: z.string(), reason: z.string() });
const EscalationOpen = H.state('escalation-open', 'pending');
const EscalationWithHuman = H.state('escalation-with-human', 'waiting');
const EscalationResolved = H.state('escalation-resolved', 'terminal', 'success');
const Escalation = H.kind('Escalation')
  .attributes(EscalationAttributes)
  .states(EscalationOpen, EscalationWithHuman, EscalationResolved)
  .key(e => e.ticketId);

const escalationFlow = H.flow('escalation')
  .input(EscalationAttributes)
  .halt('handle', { ask: ctx => `Ticket ${ctx.unit.attributes.ticketId} escalated: ${ctx.unit.attributes.reason}`, decision: z.object({ resolution: z.string() }) })
  .exit('resolved');

const escalations = H.lane('escalations', Escalation)
  .handler(escalationFlow, { exits: { resolved: EscalationResolved }, during: { handle: EscalationWithHuman } });

const AuditAttributes = z.object({ category: z.string(), openedRate: z.number(), openedSamples: z.number() });
const AuditQueued = H.state('audit-queued', 'pending');
const AuditWithHuman = H.state('audit-with-human', 'waiting');
const AuditClosed = H.state('audit-closed', 'terminal', 'success');
const AuditWithdrawn = H.state('audit-withdrawn', 'terminal', 'neutral');
const Audit = H.kind('Audit')
  .attributes(AuditAttributes)
  .states(AuditQueued, AuditWithHuman, AuditClosed, AuditWithdrawn)
  .key(a => a.category);

const auditFlow = H.flow('category-audit')
  .input(AuditAttributes)
  .halt('review', {
    ask: ctx => {
      const opened = ctx.metrics.rate(auditsOpened, { group: ctx.unit.attributes.category, windowDays: daysIntoMonth(ctx.now) });
      const paused = ctx.metrics.pausedMs(conversations, { windowDays: daysIntoMonth(ctx.now) });
      return `Approvals for ${ctx.unit.attributes.category} fell to ${ctx.unit.attributes.openedRate.toFixed(2)} over ${ctx.unit.attributes.openedSamples} samples. Audits for this category this month: ${opened.hits}. Conversations paused this month: ${Math.round(paused.totalMs / 60_000)} minutes.`;
    },
    decision: z.object({ findings: z.string() }),
  })
  .exit('closed');

const audits = H.lane('audits', Audit).handler(auditFlow, {
  exits: { closed: AuditClosed },
  during: { review: AuditWithHuman },
  cancelled: AuditWithdrawn,
});

const approvals = H.metric('approval-by-category')
  .from(H.when.step(conversations, 'approval'))
  .samples(event => {
    const category = event.steps.classify?.category;
    const decision = event.output;
    if (category === undefined || decision === undefined || decision.auto) return [];
    return [{ group: category, hit: decision.approved }];
  });

const modelErrors = H.metric('model-error-rate')
  .from(H.when.invocation(conversations, canaries))
  .samples(event => (event.model === undefined ? [] : [{ group: 'harness', hit: !event.ok }]));

const auditsOpened = H.metric('audits-opened')
  .from(H.when.transition(audits, { to: AuditQueued }))
  .samples(event => (event.from === undefined ? [{ group: event.unit.attributes.category, hit: true }] : []));

const approvalBounds = { windowDays: 7, trip: { below: 0.9 }, reset: { above: 0.95 }, minSamples: 50 };
const errorBounds = { windowHours: 1, trip: { above: 0.2 }, reset: { below: 0.05 }, minSamples: 20 };

const auditOnApprovalDrop = H.trigger('audit-on-approval-drop')
  .on(H.when.threshold(approvals, { ...approvalBounds, edge: 'tripped' }))
  .create(audits, event => ({ category: event.group, openedRate: event.rate, openedSamples: event.samples }))
  .record(experienceJournal, event => ({
    text: `When drafting for ${event.group}, recall the stricter phrasing, because approvals fell to ${event.rate.toFixed(2)} over ${event.samples} samples.`,
    status: 'candidate',
    when: { roles: [drafter], skills: [event.group] },
  }));

const withdrawAuditOnRecovery = H.trigger('withdraw-audit-on-recovery')
  .on(H.when.threshold(approvals, { ...approvalBounds, edge: 'reset' }))
  .signal(audits, H.cancel, event => ({
    key: event.group,
    payload: { reason: `approvals recovered to ${event.rate.toFixed(2)} over ${event.samples} samples` },
  }));

const pauseOnModelErrors = H.trigger('pause-on-model-errors')
  .on(H.when.threshold(modelErrors, { ...errorBounds, edge: 'tripped' }))
  .pause(conversations);

const resumeOnModelRecovery = H.trigger('resume-on-model-recovery')
  .on(H.when.threshold(modelErrors, { ...errorBounds, edge: 'reset' }))
  .resume(conversations);

const slaBreach = H.trigger('sla-breach')
  .on(H.when.timer(conversations, { at: unit => new Date(unit.attributes.slaDeadline), if: unit => unit.position !== 'terminal' }))
  .create(escalations, event => ({ ticketId: event.unit.attributes.ticketId, reason: `SLA breached at ${event.at.toISOString()}` }))
  .signal(conversations, Escalate, event => ({ key: event.unit.key, payload: {} }));

export const support = H.harness('support')
  .ledger(sqlite.ledger({ path: 'state/support.db' }))
  .pools(H.pool('support-pool').accounts(supportApi))
  .lanes(canaries, conversations, escalations, audits)
  .journals(tasteJournal, experienceJournal)
  .triggers(auditOnApprovalDrop, withdrawAuditOnRecovery, pauseOnModelErrors, resumeOnModelRecovery, slaBreach)
  .metrics(approvals, modelErrors, auditsOpened)
  .scheduler(
    H.scheduler('support-scheduler')
      .priority(canaries, escalations, conversations, audits)
      .wip(canaries, 1)
      .rank(conversations, unit => new Date(unit.attributes.slaDeadline).getTime())
      .admit(audits, ctx => {
        const openedThisMonth = ctx.metrics.rate(auditsOpened, { group: ctx.unit.attributes.category, windowDays: daysIntoMonth(ctx.now) });
        return ctx.open(audits) <= 3 || openedThisMonth.hits >= 2;
      }),
  )
  .clients(
    claudeCode.supervisor('reviewer', {
      grants: [H.ops.workRead, H.ops.workSignal, H.ops.blockersResolve, H.ops.memoryWrite, H.ops.memoryCurate, H.ops.telemetryRead],
    }),
  )
  .observers(markdown.board({ path: 'board.md' }), markdown.telemetry({ path: 'telemetry.md' }));
