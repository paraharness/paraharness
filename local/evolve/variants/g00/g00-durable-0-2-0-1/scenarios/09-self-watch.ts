import { z } from 'zod';
import { H, Band, Metrics, Route, Router } from 'harness-dsl';
import { anthropic } from 'harness-dsl/anthropic';
import { claudeCode } from 'harness-dsl/claude-code';
import { zendesk, ZendeskEvent } from 'harness-dsl/zendesk';
import { sqlite } from 'harness-dsl/sqlite';
import { jsonl } from 'harness-dsl/jsonl';
import { local } from 'harness-dsl/local';
import { markdown } from 'harness-dsl/markdown';

const hourMs = 3_600_000;

const conversationAttrs = z.object({
  ticketId: z.string(),
  subject: z.string(),
  message: z.string(),
  customerEmail: z.string(),
  slaDueAt: z.string(),
});
type ConversationAttrs = z.infer<typeof conversationAttrs>;

const New = H.state('New', 'pending');
const Classifying = H.state('Classifying', 'active');
const Drafting = H.state('Drafting', 'active');
const AwaitingApproval = H.state('AwaitingApproval', 'waiting');
const Sending = H.state('Sending', 'active');
const Sent = H.state('Sent', 'waiting');
const ClosedByCustomer = H.terminal('ClosedByCustomer', 'success');
const Escalated = H.terminal('Escalated', 'neutral');
const Unanswerable = H.terminal('Unanswerable', 'failure');

const Conversation = H.kind('Conversation')
  .attributes(conversationAttrs)
  .states(New, Classifying, Drafting, AwaitingApproval, Sending, Sent, ClosedByCustomer, Escalated, Unanswerable)
  .key(conversation => conversation.ticketId)
  .initial(New);

const customerReplied = H.signal('customer-replied').payload(z.object({ message: z.string() }));
const closedByCustomer = H.signal('closed-by-customer');
const escalate = H.signal('escalate');
const extendSla = H.signal('extend-sla').payload(z.object({ slaDueAt: z.string() }));

const slaHours = { low: 48, normal: 24, high: 8, urgent: 2 };

const newConversation = (event: ZendeskEvent): ConversationAttrs => ({
  ticketId: event.ticketId,
  subject: event.subject,
  message: event.message,
  customerEmail: event.customerEmail,
  slaDueAt: new Date(event.createdAt.getTime() + slaHours[event.priority] * hourMs).toISOString(),
});

const fromWebhook = <SN extends string>(event: ZendeskEvent, to: Router<ConversationAttrs, SN>): Route => {
  if (event.type === 'created') return to.create(newConversation(event));
  if (event.status === 'solved' || event.status === 'closed') return to.signal(closedByCustomer, event.ticketId, {});
  if (event.type === 'replied') return to.signal(customerReplied, event.ticketId, { message: event.message });
  return to.skip();
};

const apiAccount = anthropic.account('anthropic-api', { apiKey: H.env('ANTHROPIC_API_KEY') });
const pool = H.pool('support-pool').accounts(apiAccount);
const haiku = anthropic.model('haiku', { id: 'claude-haiku-4' });
const sonnet = anthropic.model('sonnet', { id: 'claude-sonnet-4' });
const opus = anthropic.model('opus', { id: 'claude-opus-4' });

const classifierRole = H.role('classifier').intents('read').instructions('Assign one support category.');
const drafterRole = H.role('drafter').intents('read').instructions('Draft a reply in the house tone.');
const reviewerRole = H.role('reviewer').intents('read', 'record');

const classifier = H.agent('classifier')
  .role(classifierRole)
  .model(haiku)
  .pool(pool)
  .output(z.object({ category: z.string(), summary: z.string() }));

const drafterModel = H.policy.model('drafter-model', [sonnet, opus], ctx => {
  const opened = ctx.metrics.total(auditsOpened, { window: { calendar: 'month' } });
  const paused = ctx.metrics.paused({ lane: conversations, window: { calendar: 'month' } });
  const cheaper = ctx.metrics.rate(approvalByModel, { group: sonnet.name, window: { lastDays: 14 } });
  const cheaperSlipping = cheaper.samples >= 100 && cheaper.rate < 0.85;
  return opened.total >= 3 || paused.totalMs > 2 * hourMs || cheaperSlipping ? opus : sonnet;
});

const drafter = H.agent('drafter')
  .role(drafterRole)
  .model(drafterModel)
  .pool(pool)
  .output(z.object({ reply: z.string() }));

const safeCategory = (metrics: Metrics, category: string): boolean => {
  const approvals = metrics.rate(approvalRate, { group: category });
  const auditsThisMonth = metrics.total(auditsOpened, { group: category, window: { calendar: 'month' } });
  return approvals.samples >= 200 && approvals.hits === approvals.samples && auditsThisMonth.total === 0;
};

const postReply = H.command('post-reply')
  .input(z.object({ ticketId: z.string(), reply: z.string() }))
  .argv(input => ['helpdesk', 'reply', input.ticketId, input.reply])
  .runner(local.runner('support-box'));

const answerConversation = H.flow('answer-conversation')
  .input(conversationAttrs)
  .step('classify', classifier, ctx => ({
    task: `Subject: ${ctx.unit.attributes.subject}\n\n${ctx.unit.attributes.message}`,
  }))
  .loop(
    'revisions',
    flow => flow
      .step('draft', drafter, ctx => ({
        task: `Category ${ctx.steps.classify.category}. ${ctx.steps.classify.summary}\n\nCustomer wrote:\n${ctx.unit.attributes.message}`,
        skills: [ctx.steps.classify.category],
      }))
      .halt('approval', {
        ask: ctx => ctx.steps.draft.reply,
        decision: z.object({ approved: z.boolean(), reply: z.string(), tasteNote: z.string() }),
        skip: ctx => safeCategory(ctx.metrics, ctx.steps.classify.category)
          ? { approved: true, reply: ctx.steps.draft.reply, tasteNote: '' }
          : undefined,
      }),
    { max: 3, until: ctx => ctx.steps.approval.approved },
  )
  .exit('rejected', ctx => !ctx.steps.approval.approved)
  .step('send', postReply, ctx => ({ ticketId: ctx.unit.attributes.ticketId, reply: ctx.steps.approval.reply }), { afterCrash: 'park' })
  .exit('sent');

const helpdesk = { subdomain: 'acme', token: H.env('ZENDESK_TOKEN') };

const conversations = H.lane('conversations', Conversation)
  .supply(
    zendesk.webhook({ port: H.slot.port(1), path: '/helpdesk', secret: H.env('ZENDESK_WEBHOOK_SECRET') }),
    (event, to) => fromWebhook(event, to),
  )
  .supply(
    zendesk.poll({ ...helpdesk, everyMinutes: 15 }),
    (event, to) => (event.type === 'created' ? to.create(newConversation(event)) : to.skip()),
  )
  .store(zendesk.store(helpdesk))
  .handler(answerConversation, {
    exits: { rejected: Escalated, sent: Sent },
    during: { classify: Classifying, draft: Drafting, approval: AwaitingApproval, send: Sending },
  })
  .retry({ maxAttempts: 3, backoff: 'exponential', initialDelayMs: 60_000, exhausted: Unanswerable })
  .ceiling({ maxUsd: 0.4, onExceed: 'halt' })
  .on(customerReplied, { update: (attrs, payload) => ({ ...attrs, message: payload.message }), restart: 'classify' })
  .on(closedByCustomer, { enter: ClosedByCustomer })
  .on(escalate, { enter: Escalated })
  .on(extendSla, { update: (attrs, payload) => ({ ...attrs, slaDueAt: payload.slaDueAt }) });

const escalationAttrs = z.object({ ticketId: z.string(), subject: z.string(), reason: z.string() });

const EscalationOpen = H.state('EscalationOpen', 'pending');
const WithHuman = H.state('WithHuman', 'waiting');
const Handled = H.terminal('Handled', 'success');
const EscalationDropped = H.terminal('EscalationDropped', 'failure');

const Escalation = H.kind('Escalation')
  .attributes(escalationAttrs)
  .states(EscalationOpen, WithHuman, Handled, EscalationDropped)
  .key(escalation => escalation.ticketId)
  .initial(EscalationOpen);

const handleEscalation = H.flow('handle-escalation')
  .input(escalationAttrs)
  .halt('handle', {
    ask: ctx => `Escalated ${ctx.unit.attributes.ticketId} (${ctx.unit.attributes.subject}): ${ctx.unit.attributes.reason}`,
    decision: z.object({ resolution: z.string() }),
  })
  .exit('handled');

const escalations = H.lane('escalations', Escalation)
  .handler(handleEscalation, { exits: { handled: Handled }, during: { handle: WithHuman } })
  .retry({ maxAttempts: 2, backoff: 'fixed', initialDelayMs: 60_000, exhausted: EscalationDropped });

const auditAttrs = z.object({ category: z.string(), rate: z.number(), samples: z.number() });

const AuditOpen = H.state('AuditOpen', 'pending');
const UnderAudit = H.state('UnderAudit', 'waiting');
const Concluded = H.terminal('Concluded', 'success');
const Recovered = H.terminal('Recovered', 'neutral');
const AuditAbandoned = H.terminal('AuditAbandoned', 'failure');

const Audit = H.kind('Audit')
  .attributes(auditAttrs)
  .states(AuditOpen, UnderAudit, Concluded, Recovered, AuditAbandoned)
  .key(audit => audit.category)
  .initial(AuditOpen)
  .onCancelled(Recovered);

const runAudit = H.flow('run-audit')
  .input(auditAttrs)
  .halt('review', {
    ask: ctx => `Approval rate for ${ctx.unit.attributes.category} fell to ${ctx.unit.attributes.rate.toFixed(2)} over ${ctx.unit.attributes.samples} samples.`,
    decision: z.object({ findings: z.string() }),
  })
  .exit('concluded');

const audits = H.lane('audits', Audit)
  .handler(runAudit, { exits: { concluded: Concluded }, during: { review: UnderAudit } })
  .retry({ maxAttempts: 2, backoff: 'fixed', initialDelayMs: 60_000, exhausted: AuditAbandoned });

const approvalRate = H.metric('approval-rate', H.when.step(conversations, 'approval')).samples(event => {
  const category = event.outputs.classify?.category;
  const decision = event.output;
  return decision === undefined || category === undefined ? [] : [{ group: category, hit: decision.approved }];
});

const approvalByModel = H.metric('approval-by-model', H.when.step(conversations, 'approval')).samples(event => {
  const category = event.outputs.classify?.category;
  const model = event.models.draft;
  const decision = event.output;
  if (decision === undefined || category === undefined || model === undefined) return [];
  return [
    { group: model, hit: decision.approved },
    { group: `${category}@${model}`, hit: decision.approved },
  ];
});

const modelErrorRate = H.metric('model-error-rate', H.when.invocation({ lanes: [conversations] }))
  .samples(event => (event.model === undefined ? [] : [{ group: 'conversations', hit: !event.ok }]));

const auditsOpened = H.metric('audits-opened', H.when.transition(audits, { to: AuditOpen }))
  .amounts(event => [{ group: event.unit.attributes.category, amount: 1 }]);

const approvalBand: Band = {
  window: { lastDays: 7 },
  minSamples: 50,
  enter: { below: 0.9 },
  exit: { above: 0.95 },
};

const errorBand: Band = {
  window: { lastHours: 1 },
  minSamples: 20,
  enter: { above: 0.2 },
  exit: { below: 0.05 },
};

const supportTaste = H.journal('support-taste', H.memory('reply-taste', 'taste'))
  .store(jsonl.memoryStore({ path: 'memory/taste.jsonl' }))
  .recall({ by: 'specificity', limit: 10 })
  .readBy(drafterRole)
  .recordedBy(reviewerRole);

const supportExperience = H.journal('support-experience', H.memory('reply-lesson', 'experience'))
  .store(jsonl.memoryStore({ path: 'memory/experience.jsonl' }))
  .recall({ by: 'specificity', limit: 8 })
  .readBy(drafterRole);

const approvalDropOpensAudit = H.trigger('approval-drop-opens-audit')
  .on(H.when.crossing(approvalRate, approvalBand, 'entered'))
  .create(audits, event => ({ category: event.group, rate: event.value, samples: event.samples }))
  .record(supportExperience, event => ({
    text: `when drafting for ${event.group}, recall the stricter phrasing, because approvals fell to ${event.value.toFixed(2)}`,
    status: 'candidate',
    when: { roles: [drafterRole], skills: [event.group] },
  }));

const approvalRecoveryClosesAudit = H.trigger('approval-recovery-closes-audit')
  .on(H.when.crossing(approvalRate, approvalBand, 'exited'))
  .signal(H.cancel, audits, event => ({
    key: event.group,
    payload: { reason: `approval rate recovered to ${event.value.toFixed(2)} over ${event.samples} samples` },
  }));

const modelErrorsPauseConversations = H.trigger('model-errors-pause-conversations')
  .on(H.when.crossing(modelErrorRate, errorBand, 'entered'))
  .pause(conversations, event => `model error rate ${event.value.toFixed(2)} over ${event.samples} invocations`);

const modelRecoveryResumesConversations = H.trigger('model-recovery-resumes-conversations')
  .on(H.when.crossing(modelErrorRate, errorBand, 'exited'))
  .resume(conversations, event => `model error rate ${event.value.toFixed(2)} over ${event.samples} invocations`);

const slaBreachEscalates = H.trigger('sla-breach-escalates')
  .on(H.when.timer(conversations, { at: unit => new Date(unit.attributes.slaDueAt) }))
  .create(escalations, event => event.unit.state === 'Sent'
    ? undefined
    : {
      ticketId: event.unit.attributes.ticketId,
      subject: event.unit.attributes.subject,
      reason: `SLA breached at ${event.at.toISOString()}`,
    })
  .signal(escalate, conversations, event => (event.unit.state === 'Sent' ? undefined : { key: event.unit.key, payload: {} }));

const reviewerEditsBecomeTaste = H.trigger('reviewer-edits-become-taste')
  .on(H.when.step(conversations, 'approval', { if: event => event.output !== undefined && event.output.tasteNote !== '' }))
  .record(supportTaste, event => event.output === undefined
    ? undefined
    : { text: event.output.tasteNote, status: 'candidate', when: { kinds: [Conversation], roles: [drafterRole] } });

export const supportSelfWatch = H.harness('support-self-watch')
  .ledger(sqlite.ledger({ path: 'state/support.sqlite' }))
  .lanes(conversations, escalations, audits)
  .journals(supportTaste, supportExperience)
  .triggers(
    approvalDropOpensAudit,
    approvalRecoveryClosesAudit,
    modelErrorsPauseConversations,
    modelRecoveryResumesConversations,
    slaBreachEscalates,
    reviewerEditsBecomeTaste,
  )
  .metrics(approvalRate, approvalByModel, modelErrorRate, auditsOpened)
  .scheduler(
    H.scheduler('support-scheduler')
      .priority(escalations, conversations, audits)
      .rank(conversations, unit => new Date(unit.attributes.slaDueAt).getTime()),
  )
  .clients(claudeCode.supervisor('support-desk', {
    port: H.slot.port(2),
    grants: [
      H.ops.workRead,
      H.ops.workSignal,
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
