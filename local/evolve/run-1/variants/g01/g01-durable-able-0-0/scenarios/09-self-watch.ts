import { z } from 'zod';
import { H } from 'harness-dsl';
import type { Metrics } from 'harness-dsl';
import { sqlite } from 'harness-dsl/sqlite';
import { jsonl } from 'harness-dsl/jsonl';
import { anthropic } from 'harness-dsl/anthropic';
import { claudeCode } from 'harness-dsl/claude-code';
import { zendesk } from 'harness-dsl/zendesk';
import type { ZendeskEvent } from 'harness-dsl/zendesk';
import { local } from 'harness-dsl/local';
import { markdown } from 'harness-dsl/markdown';

const apiAccount = anthropic.account('support-api', { apiKey: H.env('ANTHROPIC_API_KEY') });
const haiku = anthropic.model('haiku', { id: 'claude-haiku-4' });
const sonnet = anthropic.model('sonnet', { id: 'claude-sonnet-4' });
const apiPool = H.pool('support-api').accounts(apiAccount);
const helpdeskToken = H.env('ZENDESK_TOKEN');
const workers = local.runner('support-workers').slots(4);
const harnessStore = sqlite.store({ path: '.harness/units.sqlite' });

const conversationAttributes = z.object({
  ticketId: z.string(),
  subject: z.string(),
  message: z.string(),
  customerEmail: z.string(),
  slaDueAt: z.string(),
});

const slaHours = { low: 48, normal: 24, high: 8, urgent: 2 };
function slaDueAt(event: ZendeskEvent): string {
  return new Date(event.createdAt.getTime() + slaHours[event.priority] * 3_600_000).toISOString();
}

const New = H.state('New', 'pending');
const Classifying = H.state('Classifying', 'active');
const Drafting = H.state('Drafting', 'active');
const AwaitingApproval = H.state('AwaitingApproval', 'waiting');
const Sending = H.state('Sending', 'active');
const Sent = H.state('Sent', 'terminal', 'success');
const ClosedByCustomer = H.state('ClosedByCustomer', 'terminal', 'neutral');
const Escalated = H.state('Escalated', 'terminal', 'failure');

const Conversation = H.kind('Conversation')
  .attributes(conversationAttributes)
  .states(New, Classifying, Drafting, AwaitingApproval, Sending, Sent, ClosedByCustomer, Escalated)
  .key(conversation => conversation.ticketId);

const classifierRole = H.role('classifier').intents('read').instructions('Assign exactly one support category.');
const drafterRole = H.role('drafter').intents('read').instructions('Draft a reply in the house tone that resolves the question.');

const classifier = H.agent('classifier')
  .role(classifierRole)
  .model(haiku)
  .output(z.object({ category: z.string(), summary: z.string() }));

const drafter = H.agent('drafter')
  .role(drafterRole)
  .model(sonnet)
  .output(z.object({ reply: z.string() }));

const approvalDecision = z.object({
  approved: z.boolean(),
  reply: z.string(),
  by: z.enum(['reviewer', 'policy']),
});
type ApprovalDecision = z.infer<typeof approvalDecision>;

function policyApproval(reply: string): ApprovalDecision {
  return { approved: true, reply, by: 'policy' };
}

function safeCategory(metrics: Metrics, category: string): boolean {
  const record = metrics.rate(approvalRate, { windowDays: 365, group: category });
  return record.samples >= 200 && record.hits === record.samples;
}

const sendReply = H.command('send-reply')
  .input(z.object({ ticketId: z.string(), reply: z.string() }))
  .argv(input => ['helpdesk-reply', input.ticketId])
  .runner(workers);

const conversationFlow = H.flow('conversation')
  .input(conversationAttributes)
  .step('classify', classifier, ctx => ({
    task: `Classify:\n${ctx.unit.attributes.subject}\n\n${ctx.unit.attributes.message}`,
  }), { restart: 'rerun' })
  .loop('review', flow => flow
    .step('draft', drafter, ctx => ({
      task: `Reply to ${ctx.unit.attributes.customerEmail}:\n\n${ctx.unit.attributes.message}`,
      resources: [`category:${ctx.steps.classify.category}`],
    }), { restart: 'rerun' })
    .halt('approve', {
      ask: ctx => `Approve the reply to ticket ${ctx.unit.attributes.ticketId} (${ctx.steps.classify.category}):\n\n${ctx.steps.draft.reply}`,
      decision: approvalDecision,
      skip: ctx => (safeCategory(ctx.metrics, ctx.steps.classify.category) ? policyApproval(ctx.steps.draft.reply) : undefined),
    }),
  { max: 3, until: ctx => ctx.steps.approve.approved })
  .exit('escalated', ctx => !ctx.steps.approve.approved)
  .step('send', sendReply, ctx => ({ ticketId: ctx.unit.attributes.ticketId, reply: ctx.steps.approve.reply }), { restart: 'park' })
  .exit('sent');

const customerReplied = H.signal('customer-replied').payload(z.object({ message: z.string() }));
const customerClosed = H.signal('customer-closed');

function routeHelpdesk(event: ZendeskEvent, to: Parameters<Parameters<typeof conversationBase.supply<ZendeskEvent>>[1]>[1]) {
  if (event.type === 'created') {
    return to.create({
      ticketId: event.ticketId,
      subject: event.subject,
      message: event.message,
      customerEmail: event.customerEmail,
      slaDueAt: slaDueAt(event),
    });
  }
  if (event.type === 'replied') return to.signal(customerReplied, event.ticketId, { message: event.message });
  if (event.type === 'closed') return to.signal(customerClosed, event.ticketId, {});
  return to.skip();
}

const conversationBase = H.lane('conversations', Conversation);

const conversationLane = conversationBase
  .supply(zendesk.webhook({ port: H.slot.port(1), path: '/helpdesk', secret: H.env('ZENDESK_WEBHOOK_SECRET') }), routeHelpdesk)
  .supply(zendesk.poll({ subdomain: 'acme', token: helpdeskToken, everyMinutes: 15 }), routeHelpdesk)
  .store(zendesk.store({ subdomain: 'acme', token: helpdeskToken }))
  .handler(conversationFlow, {
    exits: { escalated: Escalated, sent: Sent },
    during: { classify: Classifying, draft: Drafting, approve: AwaitingApproval, send: Sending },
  })
  .on(customerReplied, {
    update: (attrs, reply) => ({ ...attrs, message: reply.message }),
    restart: 'classify',
  })
  .on(customerClosed, { enter: ClosedByCustomer })
  .ceiling({ maxUsd: 0.4, onExceed: 'halt' });

const escalationAttributes = z.object({ ticketId: z.string(), reason: z.string() });
const EscalationRaised = H.state('EscalationRaised', 'pending');
const WithLead = H.state('WithLead', 'waiting');
const EscalationResolved = H.state('EscalationResolved', 'terminal', 'success');
const Escalation = H.kind('Escalation')
  .attributes(escalationAttributes)
  .states(EscalationRaised, WithLead, EscalationResolved)
  .key(escalation => escalation.ticketId);

const escalationFlow = H.flow('escalation-desk')
  .input(escalationAttributes)
  .halt('resolve', {
    ask: ctx => `Ticket ${ctx.unit.attributes.ticketId} escalated: ${ctx.unit.attributes.reason}`,
    decision: z.object({ resolution: z.string() }),
  })
  .exit('resolved');

const escalationLane = H.lane('escalations', Escalation)
  .supply(H.operator)
  .store(harnessStore)
  .handler(escalationFlow, { exits: { resolved: EscalationResolved }, during: { resolve: WithLead } });

const auditAttributes = z.object({ category: z.string(), rate: z.number(), samples: z.number() });
const AuditOpen = H.state('AuditOpen', 'pending');
const Investigating = H.state('Investigating', 'waiting');
const AuditClosed = H.state('AuditClosed', 'terminal', 'success');
const AuditWithdrawn = H.state('AuditWithdrawn', 'terminal', 'neutral');
const Audit = H.kind('Audit')
  .attributes(auditAttributes)
  .states(AuditOpen, Investigating, AuditClosed, AuditWithdrawn)
  .key(audit => audit.category);

const auditFlow = H.flow('category-audit')
  .input(auditAttributes)
  .halt('investigate', {
    ask: ctx => `Approvals for ${ctx.unit.attributes.category} fell to ${ctx.unit.attributes.rate.toFixed(2)} over ${ctx.unit.attributes.samples} samples. Record findings.`,
    decision: z.object({ findings: z.string() }),
  })
  .exit('closed');

const auditLane = H.lane('audits', Audit)
  .store(harnessStore)
  .handler(auditFlow, { exits: { closed: AuditClosed }, during: { investigate: Investigating } })
  .on(H.cancel, { enter: AuditWithdrawn });

const approvalRate = H.metric('approval-rate-by-category')
  .from(H.when.step(conversationLane, 'approve'))
  .samples(event => {
    const decision = event.output;
    const classified = event.steps.classify;
    if (decision === undefined || classified === undefined || decision.by === 'policy') return [];
    return [{ group: classified.category, hit: decision.approved }];
  });

const approvalByModel = H.metric('approval-rate-by-model')
  .from(H.when.step(conversationLane, 'approve'))
  .samples(event => {
    const decision = event.output;
    if (decision === undefined || decision.by === 'policy') return [];
    return [{ group: event.models.draft ?? 'unknown', hit: decision.approved }];
  });

const modelErrorRate = H.metric('conversation-model-errors')
  .from(H.when.invocation(conversationLane))
  .samples(event => (event.model === undefined ? [] : [{ group: 'conversations', hit: !event.ok }]));

const auditsOpened = H.metric('audits-opened')
  .from(H.when.transition(auditLane, { to: AuditOpen, if: event => event.from === undefined }))
  .samples(event => [{ group: event.unit.attributes.category, hit: true }]);

const supportTaste = H.memory('support-taste').trust('taste');
const supportExperience = H.memory('support-experience').trust('experience');

const tastePlaybook = H.playbook('support-taste', supportTaste)
  .store(jsonl.memoryStore({ path: '.harness/support-taste.jsonl' }))
  .recall(H.recall('support-taste-recall', { by: 'specificity', limit: 10 }))
  .readBy(drafterRole);

const experiencePlaybook = H.playbook('support-experience', supportExperience)
  .store(jsonl.memoryStore({ path: '.harness/support-experience.jsonl' }))
  .recall(H.recall('support-experience-recall', { by: 'specificity', limit: 10 }))
  .readBy(drafterRole);

const approvalWatch = H.trigger('approval-watch')
  .on(H.when.threshold(approvalRate, { below: 0.9, recoverAbove: 0.95, windowDays: 7, minSamples: 50 }))
  .create(auditLane, event =>
    event.crossing === 'breached'
      ? { category: event.group, rate: event.rate.rate, samples: event.rate.samples }
      : undefined)
  .record(experiencePlaybook, event =>
    event.crossing === 'breached'
      ? {
          body: { text: `When drafting for ${event.group}, recall the stricter phrasing, because approvals fell to ${event.rate.rate.toFixed(2)}` },
          status: 'candidate',
          when: { roles: [drafterRole], resources: [`category:${event.group}`] },
        }
      : undefined)
  .signal(
    H.cancel,
    event => (event.crossing === 'recovered' ? { reason: `approvals recovered to ${event.rate.rate.toFixed(2)}` } : undefined),
    { lane: auditLane, key: event => event.group },
  );

const modelErrorBrake = H.trigger('model-error-brake')
  .on(H.when.threshold(modelErrorRate, { above: 0.2, recoverBelow: 0.05, windowHours: 1, minSamples: 20 }))
  .pause(conversationLane, event => event.crossing === 'breached')
  .resume(conversationLane, event => event.crossing === 'recovered');

const slaBreach = H.trigger('sla-breach')
  .on(H.when.timer(conversationLane, {
    at: unit => new Date(unit.attributes.slaDueAt),
    if: unit => unit.position !== 'terminal',
  }))
  .create(escalationLane, event => ({
    ticketId: event.unit.attributes.ticketId,
    reason: `SLA breached at ${event.unit.attributes.slaDueAt}`,
  }));

const supportScheduler = H.scheduler('support')
  .priority(escalationLane, conversationLane, auditLane)
  .rank(conversationLane, unit => Date.parse(unit.attributes.slaDueAt))
  .admit(auditLane, ctx => {
    const openedThisMonth = ctx.metrics.rate(auditsOpened, { windowDays: 30, group: ctx.unit.attributes.category });
    const pausedThisMonthMs = ctx.metrics.pausedMs({ lane: conversationLane, windowDays: 30 });
    return openedThisMonth.samples <= 3 || pausedThisMonthMs < 3_600_000 || ctx.open(auditLane) <= 1;
  });

export const harness = H.harness('support-self-watch')
  .ledger(sqlite.ledger({ path: '.harness/support.sqlite' }))
  .pools(apiPool)
  .lanes(conversationLane, escalationLane, auditLane)
  .playbooks(tastePlaybook, experiencePlaybook)
  .triggers(approvalWatch, modelErrorBrake, slaBreach)
  .metrics(approvalRate, approvalByModel, modelErrorRate, auditsOpened)
  .scheduler(supportScheduler)
  .clients(claudeCode.supervisor('reviewer-desk', {
    grants: [
      H.ops.workRead,
      H.ops.workUpdate,
      H.ops.workCancel,
      H.ops.blockersResolve,
      H.ops.lanesPause,
      H.ops.memoryRead,
      H.ops.memoryWrite,
      H.ops.memoryCurate,
      H.ops.telemetryRead,
    ],
  }))
  .observers(markdown.board({ path: 'BOARD.md' }), markdown.telemetry({ path: 'TELEMETRY.md' }));

export const running = harness.start();
