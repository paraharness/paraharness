import { H } from 'harness-dsl';
import { z } from 'zod';
import { anthropic } from 'harness-dsl/anthropic';
import { claudeCode } from 'harness-dsl/claude-code';
import { jsonl } from 'harness-dsl/jsonl';
import { local } from 'harness-dsl/local';
import { markdown } from 'harness-dsl/markdown';
import { sqlite } from 'harness-dsl/sqlite';
import { zendesk } from 'harness-dsl/zendesk';

const runner = local.runner('local');
const apiAccount = anthropic.account('support', { apiKey: H.env('ANTHROPIC_API_KEY') });
const haiku = anthropic.model('haiku', { id: 'claude-haiku-4-5' });
const sonnet = anthropic.model('sonnet', { id: 'claude-sonnet-4-5' });
const opus = anthropic.model('opus', { id: 'claude-opus-4-1' });
const pool = H.pool('support').accounts(apiAccount);

const approvalByCategory = H.metric.rate('approvalByCategory');
const approvalByModel = H.metric.rate('approvalByModel');
const modelErrors = H.metric.rate('modelErrors');
const auditsOpened = H.metric.total('auditsOpened');

const New = H.state('New', 'pending');
const Classifying = H.state('Classifying', 'active');
const Drafting = H.state('Drafting', 'active');
const AwaitingApproval = H.state('AwaitingApproval', 'waiting');
const Sent = H.terminal('Sent', 'success');
const ClosedByCustomer = H.terminal('ClosedByCustomer', 'neutral');
const Escalated = H.terminal('Escalated', 'failure');

const conversationAttrs = z.object({
  ticketId: z.string(),
  subject: z.string(),
  message: z.string(),
  customerEmail: z.string(),
  slaDueAt: z.string(),
});

const Conversation = H.kind('Conversation')
  .attributes(conversationAttrs)
  .states(New, Classifying, Drafting, AwaitingApproval, Sent, ClosedByCustomer, Escalated)
  .key(conversation => conversation.ticketId)
  .initial(New);

const customerReplied = H.signal('customerReplied').payload(z.object({ message: z.string() }));
const customerClosed = H.signal('customerClosed');
const slaExtended = H.signal('slaExtended').payload(z.object({ slaDueAt: z.string() }));
const escalate = H.signal('escalate');

const classifierRole = H.role('classifier')
  .intents('read')
  .instructions('Assign exactly one support category to the conversation.');
const drafterRole = H.role('drafter')
  .intents('read')
  .instructions('Draft a reply in the house tone. Cite policy where it applies.');
const reviewerRole = H.role('reviewer')
  .intents('read', 'record')
  .instructions('Approve or edit outgoing replies.');

const tasteJournal = H.journal('supportTaste', H.memory('taste', 'taste'))
  .store(jsonl.memoryStore({ path: 'support/taste.jsonl' }))
  .recall({ by: 'specificity', limit: 15 })
  .readBy(drafterRole)
  .recordedBy(reviewerRole);

const experienceJournal = H.journal('supportExperience', H.memory('experience', 'experience'))
  .store(jsonl.memoryStore({ path: 'support/experience.jsonl' }))
  .recall({ by: 'specificity', limit: 10 })
  .readBy(drafterRole);

const drafterModel = H.policy.model('drafterModel', [sonnet, opus], ctx => {
  const paused = ctx.metrics.paused({ lane: ctx.lane, window: { calendar: 'month' } });
  const cheaper = ctx.metrics.rate(approvalByModel, { group: sonnet.name, window: { lastDays: 14 } });
  return paused.totalMs > 7200000 || (cheaper.samples >= 100 && cheaper.rate < 0.9) ? opus : sonnet;
});

const classifier = H.agent('classifier')
  .role(classifierRole)
  .model(haiku)
  .pool(pool)
  .output(z.object({ category: z.string() }));

const drafter = H.agent('drafter')
  .role(drafterRole)
  .model(drafterModel)
  .pool(pool)
  .output(z.object({ reply: z.string() }));

const sendReply = H.command('sendReply')
  .input(z.object({ ticketId: z.string(), reply: z.string() }))
  .argv(input => ['helpdesk-reply', input.ticketId, input.reply])
  .runner(runner);

const conversationFlow = H.flow('conversation')
  .input(conversationAttrs)
  .step('classify', classifier, ctx => ({
    task: `Classify:\nSubject: ${ctx.unit.attributes.subject}\n${ctx.unit.attributes.message}`,
  }))
  .loop('review', flow => flow
    .step('draft', drafter, ctx => ({
      task: `Reply to ${ctx.unit.attributes.customerEmail} about "${ctx.unit.attributes.subject}":\n${ctx.unit.attributes.message}`,
      skills: [ctx.steps.classify.category],
    }))
    .halt('approval', {
      ask: ctx => `Approve this reply (${ctx.steps.classify.category})?\n\n${ctx.steps.draft.reply}`,
      decision: z.object({
        approved: z.boolean(),
        editedReply: z.string().optional(),
        tasteNote: z.string().optional(),
      }),
      skip: ctx => {
        const record = ctx.metrics.rate(approvalByCategory, { group: ctx.steps.classify.category });
        return record.samples >= 200 && record.hits === record.samples ? { approved: true } : undefined;
      },
    }), {
    max: 3,
    until: ctx => ctx.steps.approval.approved,
  })
  .exit('unapproved', ctx => !ctx.steps.approval.approved)
  .step('send', sendReply, ctx => ({
    ticketId: ctx.unit.attributes.ticketId,
    reply: ctx.steps.approval.editedReply ?? ctx.steps.draft.reply,
  }), { afterCrash: 'park' })
  .exit('sent');

const slaHours = { low: 48, normal: 24, high: 8, urgent: 2 };
const helpdeskToken = H.env('ZENDESK_TOKEN');

const conversations = H.lane('conversations', Conversation)
  .supply([
    zendesk.webhook({ port: H.slot.port(1), path: '/helpdesk', secret: H.env('ZENDESK_WEBHOOK_SECRET') }),
    zendesk.poll({ subdomain: 'acme', token: helpdeskToken, everyMinutes: 10 }),
  ], (event, to) => {
    if (event.status === 'solved' || event.status === 'closed') return to.signal(customerClosed, event.ticketId, {});
    if (event.type === 'created') {
      return to.create({
        ticketId: event.ticketId,
        subject: event.subject,
        message: event.message,
        customerEmail: event.customerEmail,
        slaDueAt: new Date(event.createdAt.getTime() + slaHours[event.priority] * 3600000).toISOString(),
      });
    }
    if (event.type === 'replied') return to.signal(customerReplied, event.ticketId, { message: event.message });
    return to.skip();
  })
  .store(zendesk.store({ subdomain: 'acme', token: helpdeskToken }))
  .handler(conversationFlow, {
    exits: { unapproved: Escalated, sent: Sent },
    during: { classify: Classifying, draft: Drafting, approval: AwaitingApproval },
  })
  .retry({ maxAttempts: 3, initialDelayMs: 30000, exhausted: Escalated })
  .ceiling({ maxUsd: 0.4, onExceed: 'halt' })
  .on(customerReplied, {
    update: (attrs, payload) => ({ ...attrs, message: payload.message }),
    restart: 'classify',
  })
  .on(customerClosed, { enter: ClosedByCustomer })
  .on(slaExtended, { update: (attrs, payload) => ({ ...attrs, slaDueAt: payload.slaDueAt }) })
  .on(escalate, { enter: Escalated });

const EscalationOpen = H.state('EscalationOpen', 'pending');
const WithHuman = H.state('WithHuman', 'waiting');
const EscalationResolved = H.terminal('EscalationResolved', 'success');
const EscalationAbandoned = H.terminal('EscalationAbandoned', 'failure');

const escalationAttrs = z.object({ ticketId: z.string(), reason: z.string() });

const Escalation = H.kind('Escalation')
  .attributes(escalationAttrs)
  .states(EscalationOpen, WithHuman, EscalationResolved, EscalationAbandoned)
  .key(escalation => escalation.ticketId)
  .initial(EscalationOpen);

const escalationFlow = H.flow('escalation')
  .input(escalationAttrs)
  .halt('handle', {
    ask: ctx => `Ticket ${ctx.unit.attributes.ticketId} escalated (${ctx.unit.attributes.reason}). Resolve it and describe the outcome.`,
    decision: z.object({ resolution: z.string() }),
  })
  .exit('resolved');

const escalations = H.lane('escalations', Escalation)
  .handler(escalationFlow, { exits: { resolved: EscalationResolved }, during: { handle: WithHuman } })
  .retry({ maxAttempts: 3, initialDelayMs: 60000, exhausted: EscalationAbandoned });

const AuditOpen = H.state('AuditOpen', 'pending');
const AuditInReview = H.state('AuditInReview', 'waiting');
const AuditClosed = H.terminal('AuditClosed', 'success');
const AuditCancelled = H.terminal('AuditCancelled', 'neutral');
const AuditAbandoned = H.terminal('AuditAbandoned', 'failure');

const auditAttrs = z.object({ category: z.string(), openedAtRate: z.number() });

const Audit = H.kind('Audit')
  .attributes(auditAttrs)
  .states(AuditOpen, AuditInReview, AuditClosed, AuditCancelled, AuditAbandoned)
  .key(audit => audit.category)
  .initial(AuditOpen)
  .onCancelled(AuditCancelled);

const auditFlow = H.flow('audit')
  .input(auditAttrs)
  .halt('review', {
    ask: ctx => `Approval rate for ${ctx.unit.attributes.category} fell to ${ctx.unit.attributes.openedAtRate.toFixed(2)}. Review recent drafts and record findings.`,
    decision: z.object({ findings: z.string() }),
  })
  .exit('closed');

const audits = H.lane('audits', Audit)
  .handler(auditFlow, { exits: { closed: AuditClosed }, during: { review: AuditInReview } })
  .retry({ maxAttempts: 3, initialDelayMs: 60000, exhausted: AuditAbandoned });

const approvalDrop = H.crossing('approvalDrop', approvalByCategory, {
  window: { lastDays: 7 },
  minSamples: 50,
  enter: { below: 0.9 },
  exit: { above: 0.95 },
});

const modelErrorSpike = H.crossing('modelErrorSpike', modelErrors, {
  window: { lastHours: 1 },
  minSamples: 20,
  enter: { above: 0.2 },
  exit: { below: 0.05 },
});

const openAudit = H.trigger('openAudit')
  .on(approvalDrop.entered)
  .create(audits, event => ({ category: event.group, openedAtRate: event.value }))
  .record(experienceJournal, event => ({
    text: `When drafting for ${event.group}, recall the stricter phrasing, because approvals fell to ${event.value.toFixed(2)} over ${event.samples} samples.`,
    status: 'candidate',
    when: { roles: [drafterRole], skills: [event.group] },
  }));

const closeAudit = H.trigger('closeAudit')
  .on(approvalDrop.exited)
  .signal(H.cancel, audits, event => ({
    key: event.group,
    payload: { reason: `approval rate recovered to ${event.value.toFixed(2)} over ${event.samples} samples` },
  }));

const pauseConversations = H.trigger('pauseConversations')
  .on(modelErrorSpike.entered)
  .pause(conversations, event => `model error rate ${event.value.toFixed(3)} over ${event.samples} invocations in the last hour`);

const resumeConversations = H.trigger('resumeConversations')
  .on(modelErrorSpike.exited)
  .resume(conversations, event => `model error rate recovered to ${event.value.toFixed(3)} over ${event.samples} invocations`);

const breachSla = H.trigger('breachSla')
  .on(H.when.timer(conversations, { at: unit => new Date(unit.attributes.slaDueAt) }))
  .signal(escalate, conversations, event => ({ key: event.unit.key, payload: {} }));

const openEscalation = H.trigger('openEscalation')
  .on(H.when.transition(conversations, { to: Escalated }))
  .create(escalations, event => ({
    ticketId: event.unit.attributes.ticketId,
    reason: Date.parse(event.unit.attributes.slaDueAt) <= event.at.getTime() ? 'slaBreached' : 'replyNotApproved',
  }));

const tasteFromEdits = H.trigger('tasteFromEdits')
  .on(H.when.step(conversations, 'approval', { if: event => event.output?.tasteNote !== undefined }))
  .record(tasteJournal, event => {
    const note = event.output?.tasteNote;
    return note === undefined ? undefined : { text: note, status: 'candidate', when: { roles: [drafterRole] } };
  });

const approvalsByCategory = H.measure(approvalByCategory, H.when.step(conversations, 'approval'), event => {
  const category = event.outputs.classify?.category;
  const decision = event.output;
  return category !== undefined && decision !== undefined ? [{ group: category, hit: decision.approved }] : [];
});

const approvalsByModel = H.measure(approvalByModel, H.when.step(conversations, 'approval'), event => {
  const model = event.models.draft;
  const decision = event.output;
  return model !== undefined && decision !== undefined ? [{ group: model, hit: decision.approved }] : [];
});

const invocationErrors = H.measure(modelErrors, H.when.invocation({ lanes: [conversations] }), event =>
  event.model === undefined ? [] : [{ group: 'conversations', hit: !event.ok }]);

const auditOpenings = H.measure(auditsOpened, H.when.transition(audits, { to: AuditOpen }), event =>
  [{ group: event.unit.attributes.category, amount: 1 }]);

const supervisor = claudeCode.supervisor('reviewerDesk', {
  grants: [
    H.ops.workRead,
    H.ops.workSignal,
    H.ops.workUpdate,
    H.ops.blockersResolve,
    H.ops.lanesPause,
    H.ops.memoryRead,
    H.ops.memoryWrite,
    H.ops.memoryCurate,
    H.ops.telemetryRead,
  ],
});

export const support = H.harness('support')
  .ledger(sqlite.ledger({ path: 'support/ledger.db' }))
  .lanes(conversations, escalations, audits)
  .journals(tasteJournal, experienceJournal)
  .triggers(openAudit, closeAudit, pauseConversations, resumeConversations, breachSla, openEscalation, tasteFromEdits)
  .measurements(approvalsByCategory, approvalsByModel, invocationErrors, auditOpenings)
  .scheduler(H.scheduler('support')
    .priority(escalations, audits, conversations)
    .rank(conversations, unit => Date.parse(unit.attributes.slaDueAt))
    .admit(audits, ctx =>
      ctx.metrics.total(auditsOpened, { group: ctx.unit.attributes.category, window: { calendar: 'month' } }).total <= 3
      || ctx.count(audits, 'waiting') === 0))
  .clients(supervisor)
  .observers(markdown.board({ path: 'support/BOARD.md' }), markdown.telemetry({ path: 'support/TELEMETRY.md' }));
