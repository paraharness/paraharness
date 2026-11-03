import { z } from 'zod';
import { H } from 'harness-dsl';
import { sqlite } from 'harness-dsl/sqlite';
import { jsonl } from 'harness-dsl/jsonl';
import { anthropic } from 'harness-dsl/anthropic';
import { claudeCode } from 'harness-dsl/claude-code';
import { zendesk } from 'harness-dsl/zendesk';
import { local } from 'harness-dsl/local';
import { markdown } from 'harness-dsl/markdown';

const quota = sqlite.quota('support-quota', { path: './.harness/quota.sqlite' });
const api = anthropic.account('anthropic-api', { apiKey: H.env('ANTHROPIC_API_KEY'), quota });
const haiku = anthropic.model('haiku', { id: 'claude-haiku-4-5' });
const sonnet = anthropic.model('sonnet', { id: 'claude-sonnet-4-5' });
const opus = anthropic.model('opus', { id: 'claude-opus-4-1' });
const pool = H.pool('support-pool').accounts(api);
const localRunner = local.runner('local');

const category = H.facet('category', ['billing', 'shipping', 'account', 'refund', 'other']);
const categoryResources = H.resources('category', category.values);

const conversationAttrs = z.object({
  ticketId: z.string(),
  subject: z.string(),
  message: z.string(),
  customerEmail: z.string(),
  slaDeadline: z.string(),
});

const New = H.state('new', 'pending');
const Sent = H.terminal('sent', 'success');
const ClosedByCustomer = H.terminal('closed-by-customer', 'neutral');
const Escalated = H.terminal('escalated', 'neutral');
const Unanswered = H.terminal('unanswered', 'failure');

const conversation = H.kind('Conversation')
  .attributes(conversationAttrs)
  .states(New, Sent, ClosedByCustomer, Escalated, Unanswered)
  .key(a => a.ticketId)
  .initial(New);

const customerReplied = H.signal('customer-replied').payload(z.object({ message: z.string() }));
const customerClosed = H.signal('customer-closed');
const escalated = H.signal('escalated');
const slaExtended = H.signal('sla-extended').payload(z.object({ deadline: z.string() }));

const classifierRole = H.role('classifier').intents('read').instructions('Pick the one category the conversation belongs to.');
const drafterRole = H.role('drafter').intents('read').instructions('Draft the reply the customer should receive.');
const reviewerRole = H.role('reviewer');

const classifier = H.seat('classifier')
  .role(classifierRole)
  .model(haiku)
  .pool(pool)
  .output(z.object({ category: category.schema }));

const drafterModel = H.policy.model('drafter-model', [sonnet, opus], ctx => {
  const paused = ctx.metrics.paused({ lane: conversations, window: { calendar: 'month' } });
  return paused.totalMs > 3_600_000 ? opus : sonnet;
});

const drafter = H.seat('drafter').role(drafterRole).model(drafterModel).pool(pool);

const approvalHalt = H.halt('reply-approval').decision(z.object({ approved: z.boolean(), editedReply: z.string().optional() }));

const sendReply = H.command('send-reply')
  .input(z.object({ ticketId: z.string(), body: z.string() }))
  .argv(i => ['helpdesk-reply', i.ticketId, i.body])
  .runner(localRunner);

const converse = H.flow('converse')
  .input(conversationAttrs)
  .step('classify', classifier, ctx => ({ task: `Classify:\n${ctx.unit.attributes.subject}\n${ctx.unit.attributes.message}` }))
  .step('draft', drafter, ctx => ({ task: `Draft a ${ctx.steps.classify.category} reply to:\n${ctx.unit.attributes.message}` }))
  .halt('approval', approvalHalt, {
    ask: ctx => `Approve this reply to ${ctx.unit.attributes.customerEmail}?\n${ctx.steps.draft}`,
    facets: ctx => [category.of(ctx.steps.classify.category)],
  })
  .exit('rejected', ctx => !ctx.steps.approval.approved)
  .step('send', sendReply, ctx => ({ ticketId: ctx.unit.attributes.ticketId, body: ctx.steps.approval.editedReply ?? ctx.steps.draft }))
  .exit('sent');

const helpdeskToken = H.env('ZENDESK_TOKEN');

const conversations = H.lane('conversations', conversation)
  .supply(
    [
      zendesk.webhook({ port: H.slot.port(2), path: '/helpdesk', secret: H.env('ZENDESK_WEBHOOK_SECRET') }),
      zendesk.poll({ subdomain: 'acme', token: helpdeskToken, everyMinutes: 10 }),
    ],
    (event, to) => {
      if (event.type === 'created') {
        const slaHours = event.priority === 'urgent' ? 1 : event.priority === 'high' ? 4 : 24;
        return to.create({
          ticketId: event.ticketId,
          subject: event.subject,
          message: event.message,
          customerEmail: event.customerEmail,
          slaDeadline: new Date(event.createdAt.getTime() + slaHours * 3_600_000).toISOString(),
        });
      }
      if (event.status === 'solved' || event.status === 'closed') return to.signal(customerClosed, event.ticketId, {});
      if (event.type === 'replied') return to.signal(customerReplied, event.ticketId, { message: event.message });
      return to.skip();
    },
  )
  .store(zendesk.store({ subdomain: 'acme', token: helpdeskToken }))
  .handler(converse, { exits: { rejected: New, sent: Sent } })
  .retry({ maxAttempts: 3, backoff: 'exponential', initialDelayMs: 60_000, exhausted: Unanswered })
  .on(customerReplied, { update: (attrs, payload) => ({ ...attrs, message: payload.message }), enter: New })
  .on(customerClosed, { enter: ClosedByCustomer })
  .on(escalated, { enter: Escalated })
  .on(slaExtended, { update: (attrs, payload) => ({ ...attrs, slaDeadline: payload.deadline }) })
  .ceiling({ maxUsd: 0.4, onExceed: H.halt('conversation-ceiling').decision(H.ceilingDecision) });

const escalationAttrs = z.object({ conversationKey: z.string(), reason: z.string() });
const EscalationOpen = H.state('escalation-open', 'pending');
const EscalationResolved = H.terminal('escalation-resolved', 'success');
const EscalationAbandoned = H.terminal('escalation-abandoned', 'failure');

const escalation = H.kind('Escalation')
  .attributes(escalationAttrs)
  .states(EscalationOpen, EscalationResolved, EscalationAbandoned)
  .key(a => a.conversationKey)
  .initial(EscalationOpen);

const escalationHalt = H.halt('escalation-handled').decision(z.object({ resolution: z.string() }));

const handleEscalation = H.flow('handle-escalation')
  .input(escalationAttrs)
  .halt('handle', escalationHalt, { ask: ctx => `Conversation ${ctx.unit.attributes.conversationKey}: ${ctx.unit.attributes.reason}` })
  .exit('resolved');

const escalations = H.lane('escalations', escalation)
  .store(sqlite.store({ path: './.harness/units.sqlite' }))
  .handler(handleEscalation, { exits: { resolved: EscalationResolved } })
  .retry({ maxAttempts: 1, exhausted: EscalationAbandoned });

const auditAttrs = z.object({ category: category.schema, rate: z.number() });
const AuditOpen = H.state('audit-open', 'pending');
const AuditClosed = H.terminal('audit-closed', 'success');
const AuditCancelled = H.terminal('audit-cancelled', 'neutral');

const audit = H.kind('Audit')
  .attributes(auditAttrs)
  .states(AuditOpen, AuditClosed, AuditCancelled)
  .key(a => a.category)
  .initial(AuditOpen);

const auditHalt = H.halt('audit-findings').decision(z.object({ findings: z.string() }));

const runAudit = H.flow('run-audit')
  .input(auditAttrs)
  .halt('review', auditHalt, { ask: ctx => `Approvals for ${ctx.unit.attributes.category} fell to ${ctx.unit.attributes.rate}. Findings?` })
  .exit('closed');

const audits = H.lane('audits', audit)
  .store(sqlite.store({ path: './.harness/units.sqlite' }))
  .handler(runAudit, { exits: { closed: AuditClosed } })
  .retry({ maxAttempts: 1, exhausted: AuditCancelled })
  .on(H.cancel, { enter: AuditCancelled });

const experienceJournal = H.journal('support-experience', H.memory('experience', 'experience'))
  .store(jsonl.memoryStore({ path: './.harness/experience.jsonl' }))
  .recall({ by: 'specificity', limit: 6 })
  .readBy(drafterRole)
  .recordedBy(reviewerRole);

const tasteJournal = H.journal('support-taste', H.memory('taste', 'taste'))
  .store(jsonl.memoryStore({ path: './.harness/taste.jsonl' }))
  .recall({ by: 'specificity', limit: 8 })
  .readBy(drafterRole)
  .recordedBy(reviewerRole);

const approvalRate = H.metric('approval-rate', H.when.decision(conversation, approvalHalt)).samples(event => {
  const value = event.facet(category);
  return value === undefined ? [] : [{ hit: event.decision.approved, facets: [category.of(value)] }];
});

const modelErrorRate = H.metric('model-error-rate', H.when.invocation({ lanes: [conversations] })).samples(event =>
  event.model === undefined ? [] : [{ hit: !event.ok }]);

const auditsOpened = H.metric('audits-opened', H.when.transition(audits, { to: AuditOpen })).amounts(event => [
  { amount: 1, facets: [category.of(event.unit.attributes.category)] },
]);

const approvalBand = { window: { lastDays: 7 }, minSamples: 50, enter: { below: 0.9 }, exit: { above: 0.95 }, per: category };
const errorBand = { window: { lastHours: 1 }, minSamples: 20, enter: { above: 0.2 }, exit: { below: 0.05 } };

const openAudit = H.trigger('open-audit')
  .on(H.when.crossing(approvalRate, approvalBand, 'entered'))
  .create(audits, event => ({ category: event.value, rate: event.rate }))
  .record(experienceJournal, event => ({
    text: `When drafting for ${event.value}, recall the stricter phrasing, because approvals fell to ${event.rate.toFixed(2)}.`,
    when: { roles: [drafterRole], kinds: [conversation], resources: [categoryResources.get(event.value)] },
    status: 'candidate',
  }));

const cancelAudit = H.trigger('cancel-audit')
  .on(H.when.crossing(approvalRate, approvalBand, 'exited'))
  .signal(H.cancel, audits, event => ({
    key: event.value,
    payload: { reason: `approvals for ${event.value} recovered to ${event.rate.toFixed(2)} over ${event.samples} samples` },
  }));

const pauseConversations = H.trigger('pause-conversations')
  .on(H.when.crossing(modelErrorRate, errorBand, 'entered'))
  .pause(conversations, event => `model error rate ${event.rate.toFixed(2)} over ${event.samples} invocations`);

const resumeConversations = H.trigger('resume-conversations')
  .on(H.when.crossing(modelErrorRate, errorBand, 'exited'))
  .resume(conversations, event => `model error rate ${event.rate.toFixed(2)} over ${event.samples} invocations`);

const breachSla = H.trigger('breach-sla')
  .on(H.when.timer(conversations, { reads: ['slaDeadline'], at: view => new Date(view.attributes.slaDeadline) }))
  .create(escalations, event => ({ conversationKey: event.unit.key, reason: 'SLA breached' }))
  .signal(escalated, conversations, event => ({ key: event.unit.key, payload: {} }));

const tasteFromEdits = H.trigger('taste-from-edits')
  .on(H.when.decision(conversation, approvalHalt))
  .record(tasteJournal, event =>
    event.decision.editedReply === undefined
      ? undefined
      : { text: `Prefer replies phrased like: ${event.decision.editedReply}`, status: 'candidate' });

const scheduler = H.scheduler('support')
  .fixedDate(conversations, unit => new Date(unit.attributes.slaDeadline))
  .expedite(escalations)
  .standard(audits)
  .wip(conversations, 6)
  .admit(audits, ctx =>
    ctx.metrics.total(auditsOpened, { facets: [category.of(ctx.unit.attributes.category)], window: { calendar: 'month' } }).total < 10);

const reviewer = claudeCode.supervisor('reviewer', {
  port: H.slot.port(1),
  grants: [
    H.ops.workRead,
    H.ops.workSignal,
    H.ops.resolve(approvalHalt, escalationHalt, auditHalt),
    H.ops.memoryWrite,
    H.ops.memoryCurate,
    H.ops.lanesPause,
    H.ops.telemetryRead,
  ],
});

void H.harness('support-self-watch')
  .ledger(sqlite.ledger({ path: './.harness/ledger.sqlite' }))
  .lanes(conversations, escalations, audits)
  .journals(experienceJournal, tasteJournal)
  .triggers(openAudit, cancelAudit, pauseConversations, resumeConversations, breachSla, tasteFromEdits)
  .metrics(approvalRate, modelErrorRate, auditsOpened)
  .scheduler(scheduler)
  .clients(reviewer)
  .observers(markdown.board({ path: './.harness/board.md' }), markdown.telemetry({ path: './.harness/telemetry.md' }))
  .start();
