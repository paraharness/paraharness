import { z } from 'zod';
import { H } from 'harness-dsl';
import { anthropic } from 'harness-dsl/anthropic';
import { claudeCode } from 'harness-dsl/claude-code';
import { sqlite } from 'harness-dsl/sqlite';
import { jsonl } from 'harness-dsl/jsonl';
import { zendesk } from 'harness-dsl/zendesk';
import { local } from 'harness-dsl/local';
import { markdown } from 'harness-dsl/markdown';

const quota = sqlite.quota('support-quota', { path: '/srv/support/quota.sqlite' });
const apiAccount = anthropic.account('support-api', { apiKey: H.env('ANTHROPIC_API_KEY'), quota });
const haiku = anthropic.model('haiku', { id: 'claude-haiku-4-5' });
const sonnet = anthropic.model('sonnet', { id: 'claude-sonnet-4-5' });
const pool = H.pool('support').accounts(apiAccount);
const runner = local.runner('support');

const category = H.facet('category', ['billing', 'shipping', 'refunds', 'technical', 'other']);
const categories = H.resources('support-category', ['billing', 'shipping', 'refunds', 'technical', 'other']);

const classifierRole = H.role('classifier').intents('read').instructions('Classify the conversation into one category.');
const drafterRole = H.role('drafter').intents('read').instructions('Draft a reply in the house tone.');
const reviewerRole = H.role('reviewer').intents('read', 'record').instructions('Approve or edit replies.');

const tasteKind = H.memory('support-taste', 'taste');
const experienceKind = H.memory('drafting-experience', 'experience');
const taste = H.journal('support-taste', tasteKind)
  .store(jsonl.memoryStore({ path: '/srv/support/taste.jsonl' }))
  .recall({ by: 'specificity', limit: 8 })
  .readBy(drafterRole)
  .recordedBy(reviewerRole);
const experience = H.journal('drafting-experience', experienceKind)
  .store(jsonl.memoryStore({ path: '/srv/support/experience.jsonl' }))
  .recall({ by: 'specificity', limit: 8 })
  .readBy(drafterRole);

const classifier = H.seat('classifier').role(classifierRole).model(haiku).pool(pool).output(z.object({ category: category.schema }));
const drafter = H.seat('drafter').role(drafterRole).model(sonnet).pool(pool).output(z.object({ reply: z.string() }));

const conversationAttrs = z.object({
  ticketId: z.string(),
  subject: z.string(),
  message: z.string(),
  customerEmail: z.string(),
  priority: z.enum(['low', 'normal', 'high', 'urgent']),
  slaDueAt: z.string(),
  awaitingUs: z.boolean(),
});

const New = H.state('new', 'pending');
const Sent = H.state('sent', 'waiting');
const ClosedByCustomer = H.terminal('closed-by-customer', 'success');
const Escalated = H.terminal('escalated', 'neutral');

const conversationKind = H.kind('conversation')
  .attributes(conversationAttrs)
  .states(New, Sent, ClosedByCustomer, Escalated)
  .key(a => a.ticketId)
  .initial(New);

const approveHalt = H.halt('approve-reply').decision(z.object({ approved: z.boolean(), editedReply: z.string().optional() }));
const costHalt = H.halt('cost-ceiling').decision(H.ceilingDecision);

const approvals = H.metric('approval-rate', H.when.decision(conversationKind, approveHalt)).samples(e => {
  const value = e.facet(category);
  return e.resolvedBy === 'human' && value !== undefined
    ? [{ hit: e.decision.approved, facets: [category.of(value)], model: e.modelOf(drafter) }]
    : [];
});

const auditAttrs = z.object({ category: category.schema, openedAtRate: z.number() });

const AuditOpen = H.state('audit-open', 'pending');
const AuditDone = H.terminal('audit-done', 'success');
const AuditCancelled = H.terminal('audit-cancelled', 'neutral');
const AuditAbandoned = H.terminal('audit-abandoned', 'failure');

const auditKind = H.kind('audit')
  .attributes(auditAttrs)
  .states(AuditOpen, AuditDone, AuditCancelled, AuditAbandoned)
  .key(a => a.category)
  .initial(AuditOpen);

const auditHalt = H.halt('audit-findings').decision(z.object({ findings: z.string() }));

const auditFlow = H.flow('audit')
  .input(auditAttrs)
  .halt('review', auditHalt, {
    ask: ctx => `Approvals for ${ctx.unit.attributes.category} fell to ${ctx.unit.attributes.openedAtRate.toFixed(2)}. What went wrong?`,
  })
  .exit('done');

const audits = H.lane('audits', auditKind)
  .handler(auditFlow, { exits: { done: AuditDone } })
  .retry({ maxAttempts: 2, exhausted: AuditAbandoned })
  .on(H.cancel, { enter: AuditCancelled });

const auditsOpened = H.metric('audits-opened', H.when.transition(audits, { to: AuditOpen })).amounts(e => [
  { amount: 1, facets: [category.of(e.unit.attributes.category)] },
]);

const safeCategory = H.policy.halt('safe-category', conversationKind, approveHalt).decide(ctx => {
  const value = ctx.facet(category);
  if (value === undefined) return undefined;
  const openedThisMonth = ctx.metrics.total(auditsOpened, { facets: [category.of(value)], window: { calendar: 'month' } });
  if (openedThisMonth.total > 0) return undefined;
  const record = ctx.metrics.rate(approvals, { facets: [category.of(value)] });
  return record.hits >= 200 && record.hits === record.samples ? { approved: true } : undefined;
});

const sendReply = H.command('send-reply')
  .input(z.object({ ticketId: z.string(), body: z.string() }))
  .argv(i => ['helpdesk', 'reply', i.ticketId, i.body])
  .runner(runner);

const replyFlow = H.flow('reply')
  .input(conversationAttrs)
  .step('classify', classifier, ctx => ({ task: `Classify: ${ctx.unit.attributes.subject}\n${ctx.unit.attributes.message}` }))
  .step('draft', drafter, ctx => ({
    task: `Draft a reply to a ${ctx.steps.classify.category} conversation: ${ctx.unit.attributes.message}`,
    resources: [categories.get(ctx.steps.classify.category)],
  }))
  .halt('approve', approveHalt, {
    ask: ctx => ctx.steps.draft.reply,
    skip: safeCategory,
    facets: ctx => [category.of(ctx.steps.classify.category)],
  })
  .exit('rejected', ctx => !ctx.steps.approve.approved)
  .step(
    'send',
    sendReply,
    ctx => ({ ticketId: ctx.unit.attributes.ticketId, body: ctx.steps.approve.editedReply ?? ctx.steps.draft.reply }),
    { afterCrash: 'park' },
  )
  .exit('sent');

const customerReplied = H.signal('customer-replied').payload(z.object({ message: z.string() }));
const customerClosed = H.signal('customer-closed');
const escalate = H.signal('escalate');

const slaHours = { low: 48, normal: 24, high: 8, urgent: 2 };
const zendeskToken = H.env('ZENDESK_TOKEN');

const conversations = H.lane('conversations', conversationKind)
  .supply(
    [
      zendesk.webhook({ port: H.slot.port(1), path: '/zendesk', secret: H.env('ZENDESK_WEBHOOK_SECRET') }),
      zendesk.poll({ subdomain: 'acme', token: zendeskToken, everyMinutes: 10 }),
    ],
    (e, to) =>
      e.type === 'created'
        ? to.create({
            ticketId: e.ticketId,
            subject: e.subject,
            message: e.message,
            customerEmail: e.customerEmail,
            priority: e.priority,
            slaDueAt: new Date(e.createdAt.getTime() + slaHours[e.priority] * 3_600_000).toISOString(),
            awaitingUs: true,
          })
        : e.status === 'solved' || e.status === 'closed'
          ? to.signal(customerClosed, e.ticketId, {})
          : e.type === 'replied'
            ? to.signal(customerReplied, e.ticketId, { message: e.message })
            : to.skip(),
  )
  .handler(replyFlow, {
    exits: {
      rejected: { to: New, limit: { count: 2, then: Escalated } },
      sent: { to: Sent, update: a => ({ ...a, awaitingUs: false }) },
    },
  })
  .store(zendesk.store({ subdomain: 'acme', token: zendeskToken }))
  .retry({ maxAttempts: 3, backoff: 'exponential', initialDelayMs: 30_000, exhausted: Escalated })
  .on(customerReplied, { update: (a, p) => ({ ...a, message: p.message, awaitingUs: true }), enter: New })
  .on(customerClosed, { enter: ClosedByCustomer })
  .on(escalate, { enter: Escalated })
  .ceiling({ maxUsd: 0.4, onExceed: costHalt });

const escalationAttrs = z.object({ ticketId: z.string(), reason: z.string() });

const EscalationOpen = H.state('escalation-open', 'pending');
const EscalationHandled = H.terminal('escalation-handled', 'success');
const EscalationAbandoned = H.terminal('escalation-abandoned', 'failure');

const escalationKind = H.kind('escalation')
  .attributes(escalationAttrs)
  .states(EscalationOpen, EscalationHandled, EscalationAbandoned)
  .key(a => a.ticketId)
  .initial(EscalationOpen);

const escalationHalt = H.halt('handle-escalation').decision(z.object({ resolution: z.string() }));

const escalationFlow = H.flow('escalation')
  .input(escalationAttrs)
  .halt('handle', escalationHalt, { ask: ctx => `Ticket ${ctx.unit.attributes.ticketId} escalated: ${ctx.unit.attributes.reason}` })
  .exit('handled');

const escalations = H.lane('escalations', escalationKind)
  .handler(escalationFlow, { exits: { handled: EscalationHandled } })
  .retry({ maxAttempts: 2, exhausted: EscalationAbandoned });

const slaBreach = H.trigger('sla-breach')
  .on(
    H.when.timer(conversations, {
      reads: ['slaDueAt', 'awaitingUs'],
      at: v => (v.attributes.awaitingUs ? new Date(v.attributes.slaDueAt) : undefined),
    }),
  )
  .create(escalations, e => ({ ticketId: e.unit.attributes.ticketId, reason: `SLA breached at ${e.unit.attributes.slaDueAt}` }))
  .signal(escalate, conversations, e => ({ key: e.unit.key, payload: {} }));

const approvalBand = {
  window: { lastDays: 7 },
  minSamples: 50,
  enter: { below: 0.9 },
  exit: { above: 0.95 },
  per: category,
};

const approvalsFell = H.trigger('approvals-fell')
  .on(H.when.crossing(approvals, approvalBand, 'entered'))
  .create(audits, e => ({ category: e.value, openedAtRate: e.rate }))
  .record(experience, e => ({
    text: `When drafting for ${e.value}, recall the stricter phrasing, because approvals fell to ${e.rate.toFixed(2)}`,
    when: { roles: [drafterRole], resources: [categories.get(e.value)] },
    status: 'candidate',
  }));

const approvalsRecovered = H.trigger('approvals-recovered')
  .on(H.when.crossing(approvals, approvalBand, 'exited'))
  .signal(H.cancel, audits, e => ({ key: e.value, payload: { reason: `approvals recovered to ${e.rate.toFixed(2)}` } }));

const modelErrors = H.metric('model-error-rate', H.when.invocation({ lanes: [conversations] })).samples(e => [
  { hit: !e.ok, model: e.model },
]);

const errorBand = { window: { lastHours: 1 }, minSamples: 20, enter: { above: 0.2 }, exit: { below: 0.05 } };

const pauseOnErrors = H.trigger('pause-on-model-errors')
  .on(H.when.crossing(modelErrors, errorBand, 'entered'))
  .pause(conversations, e => `model error rate ${e.rate.toFixed(2)} over ${e.samples} invocations`);

const resumeOnRecovery = H.trigger('resume-on-model-recovery')
  .on(H.when.crossing(modelErrors, errorBand, 'exited'))
  .resume(conversations, e => `model error rate ${e.rate.toFixed(2)} over ${e.samples} invocations`);

const scheduler = H.scheduler('support')
  .fixedDate(conversations, u => new Date(u.attributes.slaDueAt))
  .standard(audits, escalations)
  .wip(conversations, 6)
  .admit(conversations, ctx => {
    const paused = ctx.metrics.paused({ lane: conversations, window: { calendar: 'month' } });
    return paused.totalMs < 6 * 3_600_000 || ctx.unit.attributes.priority === 'urgent';
  });

const reviewer = claudeCode.supervisor('reviewer', {
  grants: [
    H.ops.workRead,
    H.ops.workUpdate,
    H.ops.resolve(approveHalt, auditHalt, escalationHalt, costHalt),
    H.ops.memoryWrite,
    H.ops.telemetryRead,
    H.ops.lanesPause,
  ],
  port: H.slot.port(2),
});

const harness = H.harness('support')
  .ledger(sqlite.ledger({ path: '/srv/support/ledger.sqlite' }))
  .lanes(conversations, audits, escalations)
  .journals(taste, experience)
  .triggers(slaBreach, approvalsFell, approvalsRecovered, pauseOnErrors, resumeOnRecovery)
  .metrics(approvals, auditsOpened, modelErrors)
  .scheduler(scheduler)
  .clients(reviewer)
  .observers(markdown.board({ path: '/srv/support/board.md' }), markdown.telemetry({ path: '/srv/support/telemetry.md' }));

void harness.start();
