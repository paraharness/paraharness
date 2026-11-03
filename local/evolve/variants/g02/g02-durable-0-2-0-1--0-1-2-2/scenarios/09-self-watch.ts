import { z } from 'zod';
import { H } from 'harness-dsl';
import { sqlite } from 'harness-dsl/sqlite';
import { jsonl } from 'harness-dsl/jsonl';
import { anthropic } from 'harness-dsl/anthropic';
import { claudeCode } from 'harness-dsl/claude-code';
import { zendesk } from 'harness-dsl/zendesk';
import { local } from 'harness-dsl/local';
import { markdown } from 'harness-dsl/markdown';

const category = H.facet('category', ['billing', 'refunds', 'shipping', 'account', 'other']);
const categoryTopics = H.resources('category', category.values);

const quota = sqlite.quota('support-quota', { path: '.harness/quota.sqlite' });
const apiAccount = anthropic.account('support-api', { apiKey: H.env('ANTHROPIC_API_KEY'), quota });
const haiku = anthropic.model('haiku', { id: 'claude-haiku-4-5' });
const sonnet = anthropic.model('sonnet', { id: 'claude-sonnet-4-5' });
const pool = H.pool('support-pool').accounts(apiAccount);

const classifierRole = H.role('classifier').intents('read').instructions('Classify the conversation into exactly one category.');
const drafterRole = H.role('drafter').intents('read').instructions('Draft the next reply to the customer.');
const reviewerRole = H.role('reviewer');

const tasteJournal = H.journal('support-taste', H.memory('taste', 'taste'))
  .store(jsonl.memoryStore({ path: '.harness/taste.jsonl' }))
  .recall({ by: 'specificity', limit: 10 })
  .readBy(drafterRole)
  .recordedBy(reviewerRole);

const experienceJournal = H.journal('support-experience', H.memory('experience', 'experience'))
  .store(jsonl.memoryStore({ path: '.harness/experience.jsonl' }))
  .recall({ by: 'specificity', limit: 8 })
  .readBy(drafterRole);

const classifier = H.seat('classifier').role(classifierRole).model(haiku).pool(pool).output(z.object({ category: category.schema }));
const drafter = H.seat('drafter').role(drafterRole).model(sonnet).pool(pool).output(z.object({ reply: z.string() }));

const auditSchema = z.object({ category: category.schema, rate: z.number(), samples: z.number() });

const AuditOpen = H.state('AuditOpen', 'pending');
const AuditDone = H.terminal('AuditDone', 'success');
const AuditCancelled = H.terminal('AuditCancelled', 'neutral');
const AuditFailed = H.terminal('AuditFailed', 'failure');

const audit = H.kind('Audit').attributes(auditSchema).states(AuditOpen, AuditDone, AuditCancelled, AuditFailed).key(a => a.category).initial(AuditOpen);

const auditFindings = H.halt('audit-findings').decision(z.object({ findings: z.string() }));

const runAudit = H.flow('run-audit')
  .input(auditSchema)
  .halt('findings', auditFindings, {
    ask: ctx => `Approvals for ${ctx.unit.attributes.category} fell to ${ctx.unit.attributes.rate.toFixed(2)} over ${ctx.unit.attributes.samples} samples. Review recent drafts.`,
  })
  .exit('audited');

const audits = H.lane('audits', audit)
  .handler(runAudit, { exits: { audited: AuditDone } })
  .retry({ maxAttempts: 1, exhausted: AuditFailed })
  .on(H.cancel, { enter: AuditCancelled });

const auditsOpened = H.metric('audits-opened', H.when.transition(audits, { to: AuditOpen }))
  .amounts(event => [{ amount: 1, facets: [category.of(event.unit.attributes.category)] }]);

const conversationSchema = z.object({
  ticketId: z.string(),
  subject: z.string(),
  customerEmail: z.string(),
  lastMessage: z.string(),
  slaDeadline: z.string(),
});

const New = H.state('New', 'pending');
const AwaitingCustomer = H.state('AwaitingCustomer', 'waiting');
const NeedsAgent = H.state('NeedsAgent', 'waiting');
const ClosedByCustomer = H.terminal('ClosedByCustomer', 'success');
const Escalated = H.terminal('Escalated', 'neutral');

const conversation = H.kind('Conversation')
  .attributes(conversationSchema)
  .states(New, AwaitingCustomer, NeedsAgent, ClosedByCustomer, Escalated)
  .key(a => a.ticketId)
  .initial(New);

const approval = H.halt('reply-approval').decision(z.object({ verdict: z.enum(['approve', 'reject']), reply: z.string().optional() }));

const approvalRate = H.metric('approval-rate', H.when.decision(conversation, approval))
  .samples(event => event.resolvedBy === 'human'
    ? [{ hit: event.decision.verdict === 'approve', seat: drafter, model: event.modelOf(drafter), facets: event.facets }]
    : []);

const safeCategory = H.policy.halt('safe-category', conversation, approval).decide(ctx => {
  const value = ctx.facet(category);
  if (value === undefined) return undefined;
  const auditedThisMonth = ctx.metrics.total(auditsOpened, { facets: [category.of(value)], window: { calendar: 'month' } });
  if (auditedThisMonth.total > 0) return undefined;
  const record = ctx.metrics.rate(approvalRate, { facets: [category.of(value)] });
  return record.samples >= 200 && record.hits === record.samples ? { verdict: 'approve' } : undefined;
});

const sendReply = H.command('send-reply')
  .input(z.object({ ticketId: z.string(), reply: z.string() }))
  .argv(input => ['helpdesk-reply', input.ticketId, input.reply])
  .runner(local.runner('local'));

const answer = H.flow('answer')
  .input(conversationSchema)
  .step('classify', classifier, ctx => ({ task: `Classify:\n${ctx.unit.attributes.subject}\n${ctx.unit.attributes.lastMessage}` }))
  .step('draft', drafter, ctx => ({
    task: `Reply to ${ctx.unit.attributes.customerEmail}:\n${ctx.unit.attributes.lastMessage}`,
    resources: [categoryTopics.get(ctx.steps.classify.category)],
  }))
  .halt('approval', approval, {
    ask: ctx => `Approve this reply?\n${ctx.steps.draft.reply}`,
    skip: safeCategory,
    facets: ctx => [category.of(ctx.steps.classify.category)],
  })
  .exit('rejected', ctx => ctx.steps.approval.verdict === 'reject')
  .step('send', sendReply, ctx => ({
    ticketId: ctx.unit.attributes.ticketId,
    reply: ctx.steps.approval.reply ?? ctx.steps.draft.reply,
  }), { afterCrash: 'park' })
  .exit('sent');

const customerReplied = H.signal('customer-replied').payload(z.object({ message: z.string() }));
const closedByCustomer = H.signal('closed-by-customer');
const escalate = H.signal('escalate');

const slaHours = { low: 48, normal: 24, high: 8, urgent: 2 };
const zendeskToken = H.env('ZENDESK_TOKEN');

const conversations = H.lane('conversations', conversation)
  .supply([
    zendesk.webhook({ port: H.slot.port(1), path: '/helpdesk', secret: H.env('ZENDESK_WEBHOOK_SECRET') }),
    zendesk.poll({ subdomain: 'acme', token: zendeskToken, everyMinutes: 10 }),
  ], (event, to) =>
    event.type === 'created'
      ? to.create({
        ticketId: event.ticketId,
        subject: event.subject,
        customerEmail: event.customerEmail,
        lastMessage: event.message,
        slaDeadline: new Date(event.createdAt.getTime() + slaHours[event.priority] * 3_600_000).toISOString(),
      })
      : event.status === 'closed' || event.status === 'solved'
        ? to.signal(closedByCustomer, event.ticketId, {})
        : event.type === 'replied'
          ? to.signal(customerReplied, event.ticketId, { message: event.message })
          : to.skip())
  .handler(answer, { exits: { rejected: Escalated, sent: AwaitingCustomer } })
  .store(zendesk.store({ subdomain: 'acme', token: zendeskToken }))
  .retry({ maxAttempts: 3, backoff: 'exponential', initialDelayMs: 30_000, exhausted: NeedsAgent })
  .on(customerReplied, { update: (attrs, payload) => ({ ...attrs, lastMessage: payload.message }), enter: New })
  .on(closedByCustomer, { enter: ClosedByCustomer })
  .on(escalate, { enter: Escalated });

const escalationSchema = z.object({ ticketId: z.string(), reason: z.string() });

const EscalationOpen = H.state('EscalationOpen', 'pending');
const EscalationResolved = H.terminal('EscalationResolved', 'success');
const EscalationFailed = H.terminal('EscalationFailed', 'failure');

const escalation = H.kind('Escalation')
  .attributes(escalationSchema)
  .states(EscalationOpen, EscalationResolved, EscalationFailed)
  .key(a => a.ticketId)
  .initial(EscalationOpen);

const takeOver = H.halt('escalation-takeover').decision(z.object({ resolution: z.string() }));

const handleEscalation = H.flow('handle-escalation')
  .input(escalationSchema)
  .halt('takeOver', takeOver, { ask: ctx => `Take over ${ctx.unit.attributes.ticketId}: ${ctx.unit.attributes.reason}` })
  .exit('resolved');

const escalations = H.lane('escalations', escalation)
  .handler(handleEscalation, { exits: { resolved: EscalationResolved } })
  .retry({ maxAttempts: 1, exhausted: EscalationFailed });

const modelErrors = H.metric('model-error-rate', H.when.invocation({ lanes: [conversations] }))
  .samples(event => [{ hit: !event.ok, seat: event.seat, model: event.model }]);

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

const approvalsFell = H.trigger('approvals-fell')
  .on(H.when.crossing(approvalRate, approvalBand, 'entered'))
  .create(audits, event => ({ category: event.value, rate: event.rate, samples: event.samples }))
  .record(experienceJournal, event => ({
    text: `When drafting for ${event.value}, recall the stricter phrasing, because approvals fell to ${event.rate.toFixed(2)} over ${event.samples} samples.`,
    when: { roles: [drafterRole], resources: [categoryTopics.get(event.value)] },
    status: 'candidate',
  }));

const approvalsRecovered = H.trigger('approvals-recovered')
  .on(H.when.crossing(approvalRate, approvalBand, 'exited'))
  .signal(H.cancel, audits, event => ({
    key: event.value,
    payload: { reason: `approvals recovered to ${event.rate.toFixed(2)} over ${event.samples} samples` },
  }));

const errorsHigh = H.trigger('model-errors-high')
  .on(H.when.crossing(modelErrors, errorBand, 'entered'))
  .pause(conversations, event => `model error rate ${event.rate.toFixed(2)} over ${event.samples} invocations`);

const errorsLow = H.trigger('model-errors-low')
  .on(H.when.crossing(modelErrors, errorBand, 'exited'))
  .resume(conversations, event => `model error rate ${event.rate.toFixed(2)} over ${event.samples} invocations`);

const slaBreached = H.trigger('sla-breached')
  .on(H.when.timer(conversations, { reads: ['slaDeadline'], at: view => new Date(view.attributes.slaDeadline) }))
  .create(escalations, event => ({ ticketId: event.unit.key, reason: `SLA deadline ${event.unit.attributes.slaDeadline} passed` }))
  .signal(escalate, conversations, event => ({ key: event.unit.key, payload: {} }));

const reviewer = claudeCode.supervisor('reviewer', {
  grants: [
    H.ops.workRead,
    H.ops.workUpdate,
    H.ops.resolve(approval, takeOver, auditFindings),
    H.ops.memoryWrite,
    H.ops.telemetryRead,
    H.ops.lanesPause,
  ],
  port: H.slot.port(2),
});

export const support = H.harness('support')
  .ledger(sqlite.ledger({ path: '.harness/ledger.sqlite' }))
  .lanes(conversations, escalations, audits)
  .journals(tasteJournal, experienceJournal)
  .triggers(approvalsFell, approvalsRecovered, errorsHigh, errorsLow, slaBreached)
  .metrics(approvalRate, modelErrors, auditsOpened)
  .scheduler(H.scheduler('support')
    .fixedDate(conversations, unit => new Date(unit.attributes.slaDeadline))
    .standard(escalations, audits)
    .wip(conversations, 4)
    .admit(audits, ctx => ctx.metrics.paused({ lane: conversations, window: { lastHours: 24 } }).totalMs < 4 * 3_600_000))
  .clients(reviewer)
  .observers(markdown.board({ path: 'BOARD.md' }), markdown.telemetry({ path: 'TELEMETRY.md' }));
