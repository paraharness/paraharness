import { z } from 'zod';
import { H } from 'harness-dsl';
import { sqlite } from 'harness-dsl/sqlite';
import { jsonl } from 'harness-dsl/jsonl';
import { anthropic } from 'harness-dsl/anthropic';
import { claudeCode } from 'harness-dsl/claude-code';
import { zendesk } from 'harness-dsl/zendesk';
import { local } from 'harness-dsl/local';
import { markdown } from 'harness-dsl/markdown';

const workstation = local.runner('workstation').slots(8);

const api = anthropic.account('support-api', {
  apiKey: H.env('ANTHROPIC_API_KEY'),
  quota: sqlite.quota('support-quota', { path: './.harness/quota.sqlite' }),
});
const pool = H.pool('support-pool').accounts(api);
const haiku = anthropic.model('haiku', { id: 'claude-haiku-4-5' });
const sonnet = anthropic.model('sonnet', { id: 'claude-sonnet-4-5' });
const opus = anthropic.model('opus', { id: 'claude-opus-4-1' });

const categorySchema = z.enum(['billing', 'refund', 'shipping', 'account', 'other']);
const category = H.facet('category', categorySchema);
const categoryResources = {
  billing: H.resource('billing'),
  refund: H.resource('refund'),
  shipping: H.resource('shipping'),
  account: H.resource('account'),
  other: H.resource('other'),
};

const NeedsOwner = H.state('NeedsOwner', 'waiting');

const New = H.state('New', 'pending');
const Sent = H.state('Sent', 'waiting');
const ClosedByCustomer = H.terminal('ClosedByCustomer', 'success');
const Escalated = H.terminal('Escalated', 'failure');

const conversationAttrs = z.object({
  ticketId: z.string(),
  subject: z.string(),
  message: z.string(),
  customerEmail: z.string(),
  slaDeadline: z.string(),
});
const conversation = H.kind('Conversation')
  .attributes(conversationAttrs)
  .states(New, Sent, ClosedByCustomer, Escalated)
  .key(a => a.ticketId);

const approval = H.halt('reply-approval').decision(z.object({
  approved: z.boolean(),
  reply: z.string().optional(),
  notes: z.string().optional(),
}));
const costCeiling = H.halt('conversation-cost').decision(H.ceilingDecision);

const approvalRate = H.metric('approval-rate', H.when.decision(conversation, approval))
  .samples(e => e.resolvedBy === 'human' ? [{ hit: e.decision.approved, facets: e.facets, model: e.modelOf(drafter) }] : []);

const AuditOpen = H.state('AuditOpen', 'pending');
const AuditClosed = H.terminal('AuditClosed', 'success');
const AuditCancelled = H.terminal('AuditCancelled', 'neutral');

const auditAttrs = z.object({ category: categorySchema, rate: z.number() });
const audit = H.kind('Audit').attributes(auditAttrs).states(AuditOpen, NeedsOwner, AuditClosed, AuditCancelled).key(a => a.category);

const auditReview = H.halt('audit-review').decision(z.object({ findings: z.string() }));

const auditFlow = H.flow('category-audit')
  .input(auditAttrs)
  .halt('review', auditReview, { ask: ctx => `Approvals for ${ctx.unit.attributes.category} fell to ${ctx.unit.attributes.rate.toFixed(2)}. Audit the recent replies.` })
  .exit('closed');

const audits = H.lane('audits', audit)
  .store(sqlite.store({ path: './.harness/audits.sqlite' }))
  .handler(auditFlow, { exits: { closed: AuditClosed } })
  .retry({ maxAttempts: 1, exhausted: NeedsOwner })
  .on(H.cancel, { enter: AuditCancelled });

const auditsOpened = H.metric('audits-opened', H.when.transition(audits, { to: AuditOpen, if: e => e.attempt === undefined }))
  .amounts(e => [{ amount: 1, facets: [category.of(e.unit.attributes.category)] }]);

const safeCategory = H.policy.halt('safe-category', conversation, approval, ctx => {
  const approvals = ctx.metrics.rate(approvalRate, { facets: ctx.facets, window: { lastDays: 90 } });
  const recentAudits = ctx.metrics.total(auditsOpened, { facets: ctx.facets, window: { calendar: 'month' } });
  return approvals.samples >= 200 && approvals.hits === approvals.samples && recentAudits.total === 0
    ? { approved: true }
    : undefined;
});

const classifierRole = H.role('classifier').intents('read').instructions('Classify the conversation into one category.');
const drafterRole = H.role('drafter').intents('read').instructions('Draft the reply to the customer in the house tone.');

const classifier = H.seat('classifier')
  .role(classifierRole)
  .model(haiku)
  .pool(pool)
  .output(z.object({ category: categorySchema }));

const drafterModel = H.policy.model('drafter-model', [sonnet, opus], ctx => {
  const paused = ctx.metrics.paused({ lane: conversations, window: { lastDays: 7 } });
  return paused.samples >= 3 && paused.totalMs > 3600000 ? opus : sonnet;
});

const drafter = H.seat('drafter')
  .role(drafterRole)
  .model(drafterModel)
  .pool(pool)
  .output(z.object({ reply: z.string() }));

const sendReply = H.command('send-reply')
  .input(z.object({ ticketId: z.string(), reply: z.string() }))
  .argv(i => ['./scripts/send-reply.sh', i.ticketId, i.reply])
  .runner(workstation);

const answer = H.flow('answer-conversation')
  .input(conversationAttrs)
  .step('classify', classifier, ctx => ({ task: `${ctx.unit.attributes.subject}\n\n${ctx.unit.attributes.message}` }))
  .step('draft', drafter, ctx => ({
    task: `${ctx.unit.attributes.subject}\n\n${ctx.unit.attributes.message}`,
    resources: [categoryResources[ctx.steps.classify.category]],
  }))
  .halt('approve', approval, {
    ask: ctx => ctx.steps.draft.reply,
    skip: safeCategory,
    facets: ctx => [category.of(ctx.steps.classify.category)],
  })
  .exit('handedOff', ctx => !ctx.steps.approve.approved)
  .step('send', sendReply, ctx => ({
    ticketId: ctx.unit.attributes.ticketId,
    reply: ctx.steps.approve.reply ?? ctx.steps.draft.reply,
  }), { afterCrash: 'park' })
  .exit('sent');

const customerReplied = H.signal('customer-replied').payload(z.object({ message: z.string() }));
const customerClosed = H.signal('customer-closed');
const slaBreached = H.signal('sla-breached');

const slaHours = { low: 48, normal: 24, high: 8, urgent: 2 };
const zendeskToken = H.env('ZENDESK_TOKEN');

const conversations = H.lane('conversations', conversation)
  .supply(zendesk.webhook({ port: H.slot.port(2), path: '/zendesk', secret: H.env('ZENDESK_WEBHOOK_SECRET') }), (event, to) =>
    event.status === 'solved' || event.status === 'closed'
      ? to.signal(customerClosed, event.ticketId, {})
      : event.type === 'created'
        ? to.create({
          ticketId: event.ticketId,
          subject: event.subject,
          message: event.message,
          customerEmail: event.customerEmail,
          slaDeadline: new Date(event.createdAt.getTime() + slaHours[event.priority] * 3600000).toISOString(),
        })
        : to.signal(customerReplied, event.ticketId, { message: event.message }))
  .supply(zendesk.poll({ subdomain: 'acme', token: zendeskToken, everyMinutes: 10 }), (event, to) =>
    event.type === 'created'
      ? to.create({
        ticketId: event.ticketId,
        subject: event.subject,
        message: event.message,
        customerEmail: event.customerEmail,
        slaDeadline: new Date(event.createdAt.getTime() + slaHours[event.priority] * 3600000).toISOString(),
      })
      : to.skip())
  .store(zendesk.store({ subdomain: 'acme', token: zendeskToken }))
  .handler(answer, { exits: { handedOff: Escalated, sent: Sent } })
  .retry({ maxAttempts: 3, backoff: 'exponential', initialDelayMs: 30000, exhausted: Escalated })
  .ceiling({ maxUsd: 0.4, halt: costCeiling })
  .on(customerReplied, { update: (a, p) => ({ ...a, message: p.message }), enter: New })
  .on(customerClosed, { enter: ClosedByCustomer })
  .on(slaBreached, { enter: Escalated });

const EscalationOpen = H.state('EscalationOpen', 'pending');
const Handled = H.terminal('Handled', 'success');

const escalationAttrs = z.object({ ticketId: z.string(), subject: z.string() });
const escalation = H.kind('Escalation').attributes(escalationAttrs).states(EscalationOpen, NeedsOwner, Handled).key(a => a.ticketId);

const handleEscalation = H.halt('handle-escalation').decision(z.object({ resolution: z.string() }));

const escalationFlow = H.flow('human-escalation')
  .input(escalationAttrs)
  .halt('handle', handleEscalation, { ask: ctx => `Escalated ticket ${ctx.unit.attributes.ticketId}: ${ctx.unit.attributes.subject}` })
  .exit('handled');

const escalations = H.lane('escalations', escalation)
  .store(sqlite.store({ path: './.harness/escalations.sqlite' }))
  .handler(escalationFlow, { exits: { handled: Handled } })
  .retry({ maxAttempts: 1, exhausted: NeedsOwner });

const slaBreach = H.trigger('sla-breach')
  .on(H.when.timer(conversations, { in: [New, Sent], at: u => new Date(u.attributes.slaDeadline) }))
  .signal(slaBreached, conversations, e => ({ key: e.unit.key, payload: {} }));

const escalate = H.trigger('escalate')
  .on(H.when.transition(conversations, { to: Escalated }))
  .create(escalations, e => ({ ticketId: e.unit.attributes.ticketId, subject: e.unit.attributes.subject }));

const taste = H.journal('support-taste', H.memory('support-taste', 'taste'))
  .store(jsonl.memoryStore({ path: './.harness/taste.jsonl' }))
  .recall({ by: 'specificity', limit: 10 })
  .readBy(drafterRole);

const experience = H.journal('support-experience', H.memory('support-experience', 'experience'))
  .store(jsonl.memoryStore({ path: './.harness/experience.jsonl' }))
  .recall({ by: 'specificity', limit: 8 })
  .readBy(drafterRole);

const reviewerEditsBecomeTaste = H.trigger('reviewer-edits-become-taste')
  .on(H.when.decision(conversation, approval))
  .record(taste, e => e.resolvedBy === 'human' && e.decision.notes !== undefined
    ? { text: e.decision.notes, when: { kinds: [conversation], roles: [drafterRole] }, status: 'candidate' }
    : undefined);

const approvalsFell = H.trigger('approvals-fell')
  .on(H.when.crossing(approvalRate, {
    window: { lastDays: 7 },
    minSamples: 50,
    enter: { below: 0.9 },
    exit: { above: 0.95 },
    per: category,
  }, 'entered'))
  .create(audits, e => ({ category: e.value, rate: e.rate }))
  .record(experience, e => ({
    text: `When drafting for ${e.value}, recall the stricter phrasing, because approvals fell to ${e.rate.toFixed(2)}.`,
    when: { roles: [drafterRole], resources: [categoryResources[e.value]] },
    status: 'candidate',
  }));

const approvalsRecovered = H.trigger('approvals-recovered')
  .on(H.when.crossing(approvalRate, {
    window: { lastDays: 7 },
    minSamples: 50,
    enter: { below: 0.9 },
    exit: { above: 0.95 },
    per: category,
  }, 'exited'))
  .signal(H.cancel, audits, e => ({ key: e.value, payload: { reason: `approvals recovered to ${e.rate.toFixed(2)} over ${e.samples} samples` } }));

const modelErrors = H.metric('model-errors', H.when.invocation({ lanes: [conversations] }))
  .samples(e => [{ hit: !e.ok, model: e.model, seat: e.seat }]);

const pauseOnModelErrors = H.trigger('pause-on-model-errors')
  .on(H.when.crossing(modelErrors, { window: { lastHours: 1 }, minSamples: 20, enter: { above: 0.2 }, exit: { below: 0.05 } }, 'entered'))
  .pause(conversations, e => `model error rate ${e.rate.toFixed(3)} over ${e.samples} invocations`);

const resumeOnRecovery = H.trigger('resume-on-recovery')
  .on(H.when.crossing(modelErrors, { window: { lastHours: 1 }, minSamples: 20, enter: { above: 0.2 }, exit: { below: 0.05 } }, 'exited'))
  .resume(conversations, e => `model error rate ${e.rate.toFixed(3)} over ${e.samples} invocations`);

const reviewer = claudeCode.supervisor('reviewer', {
  port: H.slot.port(0),
  grants: [
    H.ops.workRead,
    H.ops.workUpdate,
    H.ops.resolve(approval, costCeiling, auditReview, handleEscalation),
    H.ops.attemptsRecover,
    H.ops.memoryWrite,
    H.ops.memoryCurate,
    H.ops.telemetryRead,
  ],
});

export default H.harness('support-self-watch')
  .ledger(sqlite.ledger({ path: './.harness/ledger.sqlite' }))
  .lanes(conversations, escalations, audits)
  .journals(taste, experience)
  .triggers(slaBreach, escalate, reviewerEditsBecomeTaste, approvalsFell, approvalsRecovered, pauseOnModelErrors, resumeOnRecovery)
  .metrics(approvalRate, auditsOpened, modelErrors)
  .scheduler(H.scheduler('support-scheduler')
    .expedite(escalations)
    .fixedDate(conversations, u => new Date(u.attributes.slaDeadline))
    .standard(audits))
  .clients(reviewer)
  .observers(
    markdown.board({ path: './.harness/BOARD.md' }),
    markdown.telemetry({ path: './.harness/TELEMETRY.md' }),
  );
