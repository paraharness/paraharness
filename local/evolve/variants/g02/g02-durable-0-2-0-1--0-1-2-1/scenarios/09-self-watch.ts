import { z } from 'zod';
import { H } from 'harness-dsl';
import { sqlite } from 'harness-dsl/sqlite';
import { jsonl } from 'harness-dsl/jsonl';
import { anthropic } from 'harness-dsl/anthropic';
import { claudeCode } from 'harness-dsl/claude-code';
import { zendesk } from 'harness-dsl/zendesk';
import { markdown } from 'harness-dsl/markdown';

const CategoryName = z.enum(['billing', 'shipping', 'refund', 'technical', 'account']);
const category = H.facet('category', CategoryName.options);

const apiAccount = anthropic.account('support-api', {
  apiKey: H.env('ANTHROPIC_API_KEY'),
  quota: sqlite.quota('support-api', { path: './support/quota.sqlite' }),
});
const haiku = anthropic.model('haiku', { id: 'claude-haiku-4-5' });
const sonnet = anthropic.model('sonnet', { id: 'claude-sonnet-4-5' });
const pool = H.pool('support').accounts(apiAccount);

const classifierRole = H.role('classifier').intents('read').instructions('Classify the conversation into one category.');
const drafterRole = H.role('drafter').intents('read').instructions('Draft the reply in the house tone.');
const reviewerRole = H.role('reviewer').intents('record').instructions('Approve or edit outgoing replies.');

const classifier = H.seat('classifier').role(classifierRole).model(haiku).pool(pool)
  .output(z.object({ category: CategoryName, summary: z.string() }));
const drafter = H.seat('drafter').role(drafterRole).model(sonnet).pool(pool)
  .output(z.object({ reply: z.string() }));

const taste = H.journal('reply-taste', H.memory('taste', 'taste'))
  .store(jsonl.memoryStore({ path: './support/taste.jsonl' }))
  .recall({ by: 'specificity', limit: 10 })
  .readBy(drafterRole)
  .recordedBy(reviewerRole);
const experience = H.journal('reply-experience', H.memory('experience', 'experience'))
  .store(jsonl.memoryStore({ path: './support/experience.jsonl' }))
  .recall({ by: 'specificity', limit: 10 })
  .readBy(drafterRole);

const ConversationAttrs = z.object({
  ticketId: z.string(),
  subject: z.string(),
  customerEmail: z.string(),
  messages: z.array(z.string()),
  slaDue: z.string(),
});
const New = H.state('New', 'pending');
const Sent = H.state('Sent', 'waiting');
const ClosedByCustomer = H.terminal('ClosedByCustomer', 'success');
const Escalated = H.terminal('Escalated', 'neutral');
const Conversation = H.kind('Conversation')
  .attributes(ConversationAttrs)
  .states(New, Sent, ClosedByCustomer, Escalated)
  .key(a => a.ticketId)
  .initial(New);

const approval = H.halt('reply-approval').decision(z.object({ approved: z.boolean(), edited: z.string().optional() }));
const costCeiling = H.halt('conversation-cost').decision(H.ceilingDecision);

const approvalRate = H.metric('approval', H.when.decision(Conversation, approval)).samples(ev =>
  ev.resolvedBy === 'policy' ? [] : [{ hit: ev.decision.approved, facets: ev.facets, seat: drafter, model: ev.modelFor(drafter) }]);

const AuditAttrs = z.object({ category: CategoryName, rate: z.number(), samples: z.number() });
const AuditOpen = H.state('AuditOpen', 'pending');
const AuditClosed = H.terminal('AuditClosed', 'success');
const AuditCancelled = H.terminal('AuditCancelled', 'neutral');
const AuditAbandoned = H.terminal('AuditAbandoned', 'failure');
const Audit = H.kind('Audit')
  .attributes(AuditAttrs)
  .states(AuditOpen, AuditClosed, AuditCancelled, AuditAbandoned)
  .key(a => a.category)
  .initial(AuditOpen);

const auditFindings = H.halt('audit-findings').decision(z.object({ findings: z.string() }));
const auditFlow = H.flow('audit')
  .input(AuditAttrs)
  .halt('findings', auditFindings, {
    ask: ctx => `Audit ${ctx.unit.attributes.category}: approvals at ${ctx.unit.attributes.rate.toFixed(2)} over ${ctx.unit.attributes.samples} samples.`,
  })
  .exit('closed');

const auditLane = H.lane('audits', Audit)
  .handler(auditFlow, { exits: { closed: AuditClosed } })
  .store(sqlite.store({ path: './support/audits.sqlite' }))
  .retry({ maxAttempts: 1, exhausted: AuditAbandoned })
  .on(H.cancel, { enter: AuditCancelled });

const auditsOpened = H.metric('audits-opened', H.when.transition(auditLane, { to: AuditOpen }))
  .amounts(ev => [{ amount: 1, facets: [category.of(ev.unit.attributes.category)] }]);

const safeCategory = H.policy.halt('safe-category', Conversation, approval).decide(ctx => {
  const value = ctx.valueOf(category);
  if (value === undefined) return undefined;
  const approvals = ctx.metrics.rate(approvalRate, { facets: [category.of(value)] });
  const audits = ctx.metrics.total(auditsOpened, { facets: [category.of(value)], window: { calendar: 'month' } });
  return approvals.samples >= 200 && approvals.hits === approvals.samples && audits.total === 0 ? { approved: true } : undefined;
});

const sendReply = H.command('send-reply')
  .input(z.object({ ticketId: z.string(), reply: z.string() }))
  .argv(i => ['./bin/helpdesk-reply', i.ticketId, i.reply]);

const conversationFlow = H.flow('conversation')
  .input(ConversationAttrs)
  .step('classify', classifier, ctx => ({ task: `Classify:\n${ctx.unit.attributes.messages.join('\n')}` }))
  .step('draft', drafter, ctx => ({
    task: `Reply to ${ctx.unit.attributes.subject}.\n${ctx.steps.classify.summary}\n${ctx.unit.attributes.messages.join('\n')}`,
    skills: [ctx.steps.classify.category],
  }))
  .halt('approval', approval, {
    ask: ctx => `Approve reply on ${ctx.unit.attributes.subject}:\n${ctx.steps.draft.reply}`,
    skip: safeCategory,
    facets: ctx => [category.of(ctx.steps.classify.category)],
  })
  .exit('rejected', ctx => ctx.steps.approval.approved === false)
  .step('send', sendReply, ctx => ({ ticketId: ctx.unit.attributes.ticketId, reply: ctx.steps.approval.edited ?? ctx.steps.draft.reply }), { afterCrash: 'park' })
  .exit('sent');

const customerReplied = H.signal('customer-replied').payload(z.object({ message: z.string() }));
const customerClosed = H.signal('customer-closed');
const slaBreached = H.signal('sla-breached');

const slaMinutes = { low: 1440, normal: 480, high: 120, urgent: 30 };
const helpdeskToken = H.env('ZENDESK_TOKEN');

const conversationLane = H.lane('conversations', Conversation)
  .supply(zendesk.webhook({ port: H.slot.port(1), path: '/helpdesk', secret: H.env('ZENDESK_WEBHOOK_SECRET') }), (ev, to) =>
    ev.type === 'created'
      ? to.create({
        ticketId: ev.ticketId,
        subject: ev.subject,
        customerEmail: ev.customerEmail,
        messages: [ev.message],
        slaDue: new Date(ev.createdAt.getTime() + slaMinutes[ev.priority] * 60_000).toISOString(),
      })
      : ev.type === 'replied' ? to.signal(customerReplied, ev.ticketId, { message: ev.message })
        : ev.status === 'solved' || ev.status === 'closed' ? to.signal(customerClosed, ev.ticketId, {})
          : to.skip())
  .supply(zendesk.poll({ subdomain: 'acme', token: helpdeskToken, everyMinutes: 10 }), (ev, to) =>
    ev.type === 'created'
      ? to.create({
        ticketId: ev.ticketId,
        subject: ev.subject,
        customerEmail: ev.customerEmail,
        messages: [ev.message],
        slaDue: new Date(ev.createdAt.getTime() + slaMinutes[ev.priority] * 60_000).toISOString(),
      })
      : to.skip())
  .handler(conversationFlow, { exits: { rejected: Escalated, sent: Sent } })
  .store(zendesk.store({ subdomain: 'acme', token: helpdeskToken }))
  .retry({ maxAttempts: 2, exhausted: Escalated })
  .ceiling({ maxUsd: 0.4, onExceed: costCeiling })
  .on(customerReplied, { update: (a, p) => ({ ...a, messages: [...a.messages, p.message] }), enter: New })
  .on(customerClosed, { enter: ClosedByCustomer })
  .on(slaBreached, { enter: Escalated });

const EscalationAttrs = z.object({ ticketId: z.string(), reason: z.string() });
const EscalationOpen = H.state('EscalationOpen', 'pending');
const EscalationHandled = H.terminal('EscalationHandled', 'success');
const EscalationUnhandled = H.terminal('EscalationUnhandled', 'failure');
const Escalation = H.kind('Escalation')
  .attributes(EscalationAttrs)
  .states(EscalationOpen, EscalationHandled, EscalationUnhandled)
  .key(a => a.ticketId)
  .initial(EscalationOpen);

const escalationHandled = H.halt('escalation-handled').decision(z.object({ resolution: z.string() }));
const escalationFlow = H.flow('escalation')
  .input(EscalationAttrs)
  .halt('handle', escalationHandled, { ask: ctx => `Ticket ${ctx.unit.attributes.ticketId} escalated: ${ctx.unit.attributes.reason}` })
  .exit('handled');

const escalationLane = H.lane('escalations', Escalation)
  .handler(escalationFlow, { exits: { handled: EscalationHandled } })
  .store(sqlite.store({ path: './support/escalations.sqlite' }))
  .retry({ maxAttempts: 1, exhausted: EscalationUnhandled });

const modelErrors = H.metric('model-errors', H.when.invocation({ lanes: [conversationLane] }))
  .samples(ev => [{ hit: ev.ok === false, seat: ev.seat, model: ev.model }]);

const approvalBand = {
  window: { lastDays: 7 },
  minSamples: 50,
  enter: { below: 0.9 },
  exit: { above: 0.95 },
  per: category,
};
const errorBand = {
  window: { lastHours: 1 },
  minSamples: 20,
  enter: { above: 0.2 },
  exit: { below: 0.05 },
};

const approvalFell = H.trigger('approval-fell')
  .on(H.when.crossing(approvalRate, approvalBand, 'entered'))
  .create(auditLane, ev => ({ category: ev.value.value, rate: ev.rate, samples: ev.samples }))
  .record(experience, ev => ({
    text: `When drafting for ${ev.value.value}, recall the stricter phrasing, because approvals fell to ${ev.rate.toFixed(2)} over ${ev.samples} samples.`,
    when: { roles: [drafterRole], skills: [ev.value.value] },
    status: 'candidate',
  }));

const approvalRecovered = H.trigger('approval-recovered')
  .on(H.when.crossing(approvalRate, approvalBand, 'exited'))
  .signal(H.cancel, auditLane, ev => ({ key: ev.value.value, payload: { reason: `approvals recovered to ${ev.rate.toFixed(2)}` } }));

const pauseOnModelErrors = H.trigger('pause-on-model-errors')
  .on(H.when.crossing(modelErrors, errorBand, 'entered'))
  .pause(conversationLane, ev => `model error rate ${ev.rate.toFixed(2)} over ${ev.samples} invocations`);

const resumeAfterModelErrors = H.trigger('resume-after-model-errors')
  .on(H.when.crossing(modelErrors, errorBand, 'exited'))
  .resume(conversationLane, ev => `model error rate ${ev.rate.toFixed(2)} over ${ev.samples} invocations`);

const slaBreach = H.trigger('sla-breach')
  .on(H.when.timer(conversationLane, {
    at: unit => unit.position === 'terminal' || unit.state === Sent ? undefined : new Date(unit.attributes.slaDue),
  }))
  .create(escalationLane, ev => ({ ticketId: ev.unit.attributes.ticketId, reason: `SLA breached at ${ev.deadline.toISOString()}` }))
  .signal(slaBreached, conversationLane, ev => ({ key: ev.unit.key, payload: {} }));

const reviewer = claudeCode.supervisor('reviewer', {
  port: H.slot.port(2),
  grants: [
    H.ops.workRead, H.ops.workUpdate, H.ops.workCancel,
    H.ops.resolve(approval, costCeiling, auditFindings, escalationHandled),
    H.ops.memoryRead, H.ops.memoryWrite, H.ops.memoryCurate,
    H.ops.telemetryRead, H.ops.lanesPause,
  ],
});

export const harness = H.harness('support')
  .ledger(sqlite.ledger({ path: './support/ledger.sqlite' }))
  .lanes(conversationLane, escalationLane, auditLane)
  .journals(taste, experience)
  .triggers(approvalFell, approvalRecovered, pauseOnModelErrors, resumeAfterModelErrors, slaBreach)
  .metrics(approvalRate, auditsOpened, modelErrors)
  .scheduler(H.scheduler('support')
    .expedite(escalationLane)
    .fixedDate(conversationLane, unit => new Date(unit.attributes.slaDue))
    .standard(auditLane)
    .admit(auditLane, ctx => {
      const opened = ctx.metrics.total(auditsOpened, { facets: [category.of(ctx.unit.attributes.category)], window: { calendar: 'month' } });
      const paused = ctx.metrics.paused({ lane: conversationLane, window: { calendar: 'month' } });
      return opened.total <= 4 || paused.totalMs < 2 * 3_600_000;
    }))
  .clients(reviewer)
  .observers(markdown.board({ path: './support/BOARD.md' }), markdown.telemetry({ path: './support/TELEMETRY.md' }));
