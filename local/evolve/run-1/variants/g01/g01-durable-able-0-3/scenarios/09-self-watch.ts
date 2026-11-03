import { z } from 'zod';
import { H, type AnyMetric, type Metrics, type Router, type State } from 'harness-dsl';
import { anthropic } from 'harness-dsl/anthropic';
import { claudeCode } from 'harness-dsl/claude-code';
import { sqlite } from 'harness-dsl/sqlite';
import { jsonl } from 'harness-dsl/jsonl';
import { local } from 'harness-dsl/local';
import { zendesk, type ZendeskEvent } from 'harness-dsl/zendesk';
import { markdown } from 'harness-dsl/markdown';

const apiAccount = anthropic.account('support-api', { apiKey: H.env('ANTHROPIC_API_KEY') });
const haiku = anthropic.model('haiku', { id: 'claude-haiku-4' });
const sonnet = anthropic.model('sonnet', { id: 'claude-sonnet-4' });
const opus = anthropic.model('opus', { id: 'claude-opus-4' });
const runner = local.runner('local').slots(8);

const conversationAttrs = z.object({
  ticketId: z.string(),
  subject: z.string(),
  message: z.string(),
  customerEmail: z.string(),
  slaDueAt: z.string(),
});

const New = H.state('new', 'pending');
const Classifying = H.state('classifying', 'active');
const Drafting = H.state('drafting', 'active');
const AwaitingApproval = H.state('awaitingApproval', 'active');
const Sent = H.state('sent', 'waiting');
const HeldForReviewer = H.state('heldForReviewer', 'waiting');
const ClosedByCustomer = H.state('closedByCustomer', 'terminal', 'success');
const Escalated = H.state('escalated', 'terminal', 'neutral');
const Abandoned = H.state('abandoned', 'terminal', 'failure');

const Conversation = H.kind('Conversation')
  .attributes(conversationAttrs)
  .states(New, Classifying, Drafting, AwaitingApproval, Sent, HeldForReviewer, ClosedByCustomer, Escalated, Abandoned)
  .key((conversation) => conversation.ticketId);

const customerReplied = H.signal('customerReplied').payload(z.object({ message: z.string() }));
const customerClosed = H.signal('customerClosed');
const escalate = H.signal('escalate');

const classifierRole = H.role('classifier').intents('read').instructions('Classify the conversation into one support category.');
const drafterRole = H.role('drafter').intents('read').instructions('Draft a reply in the house tone.');
const reviewerRole = H.role('reviewer').intents('read', 'edit');

const taste = H.memory('taste').trust('taste');
const experience = H.memory('experience').trust('experience');

const tasteJournal = H.journal('reply-taste', taste)
  .store(jsonl.memoryStore({ path: 'memory/taste.jsonl' }))
  .recall(H.recall('taste-recall', { by: 'specificity', limit: 12 }))
  .readBy(drafterRole)
  .writtenBy(reviewerRole);

const experienceJournal = H.journal('drafting-experience', experience)
  .store(jsonl.memoryStore({ path: 'memory/experience.jsonl' }))
  .recall(H.recall('experience-recall', { by: 'specificity', limit: 10 }))
  .readBy(drafterRole);

const drafterModel = H.policy.model('drafter-model', [sonnet, opus], (ctx) => {
  const paused = ctx.metrics.paused(ctx.lane, { windowDays: 30 });
  return paused.totalMs > 2 * 60 * 60 * 1000 ? opus : sonnet;
});

const classifier = H.agent('classifier')
  .role(classifierRole)
  .model(haiku)
  .output(z.object({ category: z.string(), summary: z.string() }))
  .budgetTokens(4000);

const drafter = H.agent('drafter')
  .role(drafterRole)
  .model(drafterModel)
  .output(z.object({ reply: z.string() }))
  .budgetTokens(12000);

const sendReply = H.command('send-reply')
  .input(z.object({ ticketId: z.string(), body: z.string() }))
  .argv((input) => ['helpdesk', 'reply', input.ticketId, input.body])
  .runner(runner);

const approvalDecision = z.object({
  approved: z.boolean(),
  finalReply: z.string(),
  editNotes: z.string().optional(),
});

function isSafeCategory(metrics: Metrics, category: string): boolean {
  const record = metrics.rate(approvalByCategory, { group: category });
  return record.samples >= 200 && record.successes === record.samples;
}

const conversationFlow = H.flow('conversation')
  .input(conversationAttrs)
  .step('classify', classifier, (ctx) => ({ task: `${ctx.unit.attributes.subject}\n\n${ctx.unit.attributes.message}` }))
  .step('draft', drafter, (ctx) => ({
    task: `Reply to: ${ctx.unit.attributes.message}`,
    skills: [ctx.steps.classify.category],
  }))
  .halt('approval', {
    ask: (ctx) => `Approve this reply to ${ctx.unit.attributes.customerEmail}?\n\n${ctx.steps.draft.reply}`,
    decision: approvalDecision,
    skip: (ctx) => (isSafeCategory(ctx.metrics, ctx.steps.classify.category) ? { approved: true, finalReply: ctx.steps.draft.reply } : undefined),
  })
  .exit('rejected', (ctx) => !ctx.steps.approval.approved)
  .step('send', sendReply, (ctx) => ({ ticketId: ctx.unit.attributes.ticketId, body: ctx.steps.approval.finalReply }))
  .exit('sent');

const slaHours = { low: 24, normal: 8, high: 4, urgent: 1 };

function routeTicket<S extends State>(event: ZendeskEvent, to: Router<z.infer<typeof conversationAttrs>, S>) {
  if (event.type === 'created') {
    return to.create({
      ticketId: event.ticketId,
      subject: event.subject,
      message: event.message,
      customerEmail: event.customerEmail,
      slaDueAt: new Date(event.createdAt.getTime() + slaHours[event.priority] * 60 * 60 * 1000).toISOString(),
    });
  }
  if (event.type === 'replied') {
    return to.signal(customerReplied, event.ticketId, { message: event.message });
  }
  if (event.type === 'closed') {
    return to.signal(customerClosed, event.ticketId, {});
  }
  return to.skip();
}

const conversations = H.lane('conversations', Conversation)
  .supply(zendesk.webhook({ port: H.slot.port(1), path: '/helpdesk', secret: H.env('ZENDESK_WEBHOOK_SECRET') }), routeTicket)
  .supply(zendesk.poll({ subdomain: 'acme', token: H.env('ZENDESK_TOKEN'), everyMinutes: 15 }), routeTicket)
  .store(zendesk.store({ subdomain: 'acme', token: H.env('ZENDESK_TOKEN') }))
  .handler(conversationFlow, {
    exits: { rejected: HeldForReviewer, sent: Sent },
    during: { classify: Classifying, draft: Drafting, approval: AwaitingApproval, send: Drafting },
    failure: Abandoned,
  })
  .ceiling({ maxUsd: 0.4, onExceed: 'halt' })
  .on(customerReplied, { update: (attrs, payload) => ({ ...attrs, message: payload.message }), restart: 'classify' })
  .on(customerClosed, { enter: ClosedByCustomer })
  .on(escalate, { enter: Escalated })
  .on(H.cancel, { enter: Abandoned });

const escalationAttrs = z.object({ ticketId: z.string(), reason: z.string() });

const EscalationOpen = H.state('open', 'pending');
const EscalationHandling = H.state('handling', 'active');
const EscalationResolved = H.state('resolved', 'terminal', 'success');
const EscalationDropped = H.state('dropped', 'terminal', 'neutral');
const EscalationFailed = H.state('failed', 'terminal', 'failure');

const Escalation = H.kind('Escalation')
  .attributes(escalationAttrs)
  .states(EscalationOpen, EscalationHandling, EscalationResolved, EscalationDropped, EscalationFailed)
  .key((escalation) => escalation.ticketId);

const escalationFlow = H.flow('escalation')
  .input(escalationAttrs)
  .halt('handle', {
    ask: (ctx) => `Ticket ${ctx.unit.attributes.ticketId} escalated: ${ctx.unit.attributes.reason}. Mark handled when done.`,
    decision: z.object({ handled: z.boolean(), note: z.string() }),
  })
  .exit('resolved', (ctx) => ctx.steps.handle.handled)
  .exit('dropped');

const escalations = H.lane('escalations', Escalation)
  .handler(escalationFlow, {
    exits: { resolved: EscalationResolved, dropped: EscalationDropped },
    during: { handle: EscalationHandling },
    failure: EscalationFailed,
  })
  .on(H.cancel, { enter: EscalationDropped });

const auditAttrs = z.object({ category: z.string(), rate: z.number(), samples: z.number() });

const AuditOpen = H.state('open', 'pending');
const AuditUnderReview = H.state('underReview', 'active');
const AuditResolved = H.state('resolved', 'terminal', 'success');
const AuditCancelled = H.state('cancelled', 'terminal', 'neutral');
const AuditFailed = H.state('failed', 'terminal', 'failure');

const Audit = H.kind('Audit')
  .attributes(auditAttrs)
  .states(AuditOpen, AuditUnderReview, AuditResolved, AuditCancelled, AuditFailed)
  .key((audit) => audit.category);

const auditFlow = H.flow('audit')
  .input(auditAttrs)
  .halt('review', {
    ask: (ctx) => {
      const openedThisMonth = ctx.metrics.rate(auditsOpened, { windowDays: 30, group: ctx.unit.attributes.category }).samples;
      return `Approvals for ${ctx.unit.attributes.category} fell to ${ctx.unit.attributes.rate} over ${ctx.unit.attributes.samples} samples. Audits opened for it in the last 30 days: ${openedThisMonth}. Review drafts and record findings.`;
    },
    decision: z.object({ findings: z.string() }),
  })
  .exit('resolved');

const audits = H.lane('audits', Audit)
  .handler(auditFlow, {
    exits: { resolved: AuditResolved },
    during: { review: AuditUnderReview },
    failure: AuditFailed,
  })
  .on(H.cancel, { enter: AuditCancelled });

const approvalByCategory: AnyMetric = H.metric('approval-by-category')
  .from(H.when.step(conversations, 'approval'))
  .samples((event) => {
    const category = event.steps.classify?.category;
    const decision = event.output;
    return category === undefined || decision === undefined ? [] : [{ group: category, success: decision.approved }];
  });

const modelReliability = H.metric('model-reliability')
  .from(H.when.invocation(conversations))
  .samples((event) => (event.model === undefined ? [] : [{ group: 'conversations', success: event.ok }]));

const auditsOpened: AnyMetric = H.metric('audits-opened')
  .from(H.when.transition(audits, { if: (event) => event.from === undefined }))
  .samples((event) => [{ group: event.unit.attributes.category, success: true }]);

const approvalBand = H.band('approval-band', approvalByCategory, { windowDays: 7, below: 0.9, above: 0.95, minSamples: 50 });
const reliabilityBand = H.band('model-reliability-band', modelReliability, { windowHours: 1, below: 0.8, above: 0.95, minSamples: 20 });

const approvalsFell = H.trigger('approvals-fell')
  .on(H.when.crossing(approvalBand, 'down'))
  .create(audits, (event) => ({ category: event.group, rate: event.rate, samples: event.samples }))
  .record(experienceJournal, (event) => ({
    body: { text: `when drafting for ${event.group}, recall the stricter phrasing, because approvals fell to ${event.rate.toFixed(2)}` },
    when: { roles: [drafterRole], skills: [event.group] },
    status: 'candidate',
  }));

const approvalsRecovered = H.trigger('approvals-recovered')
  .on(H.when.crossing(approvalBand, 'up'))
  .signal(H.cancel, (event) => ({
    unit: audits.unit(event.group),
    payload: { reason: `approvals recovered to ${event.rate.toFixed(2)} over ${event.samples} samples` },
  }));

const modelsUnreliable = H.trigger('models-unreliable')
  .on(H.when.crossing(reliabilityBand, 'down'))
  .pause(conversations, (event) => `model error rate ${(1 - event.rate).toFixed(2)} over ${event.samples} invocations`);

const modelsReliable = H.trigger('models-reliable')
  .on(H.when.crossing(reliabilityBand, 'up'))
  .resume(conversations, (event) => `model error rate ${(1 - event.rate).toFixed(2)} over ${event.samples} invocations`);

const slaBreached = H.trigger('sla-breached')
  .on(H.when.timer(conversations, {
    at: (unit) => new Date(unit.attributes.slaDueAt),
    if: (unit) => unit.position !== 'terminal' && unit.state !== 'sent',
  }))
  .create(escalations, (event) => ({ ticketId: event.unit.attributes.ticketId, reason: `SLA breached at ${event.unit.attributes.slaDueAt}` }))
  .signal(escalate, (event) => ({ unit: event.unit, payload: {} }));

const reviewerEditsBecomeTaste = H.trigger('reviewer-edits-become-taste')
  .on(H.when.step(conversations, 'approval', { if: (event) => event.output?.editNotes !== undefined }))
  .record(tasteJournal, (event) => {
    const notes = event.output?.editNotes;
    return notes === undefined ? undefined : { body: { text: notes }, when: { kinds: [Conversation], roles: [drafterRole] }, status: 'candidate' };
  });

const scheduler = H.scheduler('support-scheduler')
  .priority(escalations, audits, conversations)
  .rank(conversations, (unit) => Date.parse(unit.attributes.slaDueAt));

export const support = H.harness('support')
  .ledger(sqlite.ledger({ path: 'state/ledger.sqlite' }))
  .pool(H.pool('support-pool').accounts(apiAccount))
  .lanes(conversations, escalations, audits)
  .journals(tasteJournal, experienceJournal)
  .metrics(approvalByCategory, modelReliability, auditsOpened)
  .triggers(approvalsFell, approvalsRecovered, modelsUnreliable, modelsReliable, slaBreached, reviewerEditsBecomeTaste)
  .scheduler(scheduler)
  .clients(claudeCode.supervisor('support-desk', {
    grants: [
      H.ops.workRead,
      H.ops.workUpdate,
      H.ops.blockersResolve,
      H.ops.memoryRead,
      H.ops.memoryWrite,
      H.ops.memoryCurate,
      H.ops.telemetryRead,
    ],
  }))
  .observers(markdown.board({ path: 'board.md' }), markdown.telemetry({ path: 'telemetry.md' }));
