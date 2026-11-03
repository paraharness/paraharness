import { z } from 'zod';
import { H, MetricRef, ModelPolicy, Router } from 'harness-dsl';
import { sqlite } from 'harness-dsl/sqlite';
import { jsonl } from 'harness-dsl/jsonl';
import { anthropic } from 'harness-dsl/anthropic';
import { claudeCode } from 'harness-dsl/claude-code';
import { zendesk, ZendeskEvent } from 'harness-dsl/zendesk';
import { local } from 'harness-dsl/local';
import { markdown } from 'harness-dsl/markdown';

const Failed = H.terminal('Failed', 'failure');
const Withdrawn = H.terminal('Withdrawn', 'neutral');

const localRunner = local.runner('local');
const apiAccount = anthropic.account('anthropic-api', { apiKey: H.env('ANTHROPIC_API_KEY') });
const pool = H.pool('support-pool').accounts(apiAccount);
const haiku = anthropic.model('haiku', { id: 'claude-haiku-4-5' });
const sonnet = anthropic.model('sonnet', { id: 'claude-sonnet-4-5' });
const opus = anthropic.model('opus', { id: 'claude-opus-4-1' });

const draftingFor = H.skill('category');

const classifierRole = H.role('classifier').intents('read').instructions('Classify the customer message into one category.');
const drafterRole = H.role('drafter').intents('read').instructions('Draft a reply in the house tone. Cite policy when it applies.');
const reviewerRole = H.role('reviewer');

const toneTaste = H.corpus('support-taste', H.memory('support-taste', 'taste'))
  .store(jsonl.memoryStore({ path: 'memory/taste.jsonl' }))
  .recall({ by: 'specificity', limit: 20 })
  .readBy(drafterRole)
  .recordedBy(reviewerRole);

const draftingExperience = H.corpus('drafting-experience', H.memory('drafting-experience', 'experience'))
  .store(jsonl.memoryStore({ path: 'memory/experience.jsonl' }))
  .recall({ by: 'specificity', limit: 15 })
  .readBy(drafterRole)
  .recordedBy(reviewerRole);

const auditSchema = z.object({ category: z.string(), rateAtOpen: z.number() });

const AuditOpen = H.state('AuditOpen', 'pending');
const AuditUnderReview = H.state('AuditUnderReview', 'waiting');
const AuditClosed = H.terminal('AuditClosed', 'success');

const Audit = H.kind('Audit')
  .attributes(auditSchema)
  .states(AuditOpen, AuditUnderReview, AuditClosed, Failed, Withdrawn)
  .key((audit) => audit.category)
  .initial(AuditOpen)
  .onAttemptFailed(Failed)
  .onCancelled(Withdrawn);

const auditFlow = H.flow('category-audit')
  .input(auditSchema)
  .halt('review', {
    ask: (ctx) => `Approvals for ${ctx.unit.attributes.category} fell to ${ctx.unit.attributes.rateAtOpen.toFixed(2)}. Review recent drafts and record findings.`,
    decision: z.object({ findings: z.string() }),
  })
  .exit('closed');

const audits = H.lane('audits', Audit).handler(auditFlow, {
  exits: { closed: AuditClosed },
  during: { review: AuditUnderReview },
});

const auditsOpened = H.metric(
  'audits-opened',
  H.when.transition(audits, { to: AuditOpen, if: (event) => event.unit.attempts === 0 }),
).amounts((event) => [{ group: event.unit.attributes.category, amount: 1 }]);

const escalationSchema = z.object({ ticketId: z.string(), subject: z.string() });

const EscalationOpen = H.state('EscalationOpen', 'pending');
const WithHuman = H.state('WithHuman', 'waiting');
const Handled = H.terminal('Handled', 'success');

const Escalation = H.kind('Escalation')
  .attributes(escalationSchema)
  .states(EscalationOpen, WithHuman, Handled, Failed, Withdrawn)
  .key((escalation) => escalation.ticketId)
  .initial(EscalationOpen)
  .onAttemptFailed(Failed)
  .onCancelled(Withdrawn);

const escalationFlow = H.flow('escalation')
  .input(escalationSchema)
  .halt('handle', {
    ask: (ctx) => `Take over ticket ${ctx.unit.attributes.ticketId}: ${ctx.unit.attributes.subject}`,
    decision: z.object({ resolution: z.string() }),
  })
  .exit('handled');

const escalations = H.lane('escalations', Escalation).handler(escalationFlow, {
  exits: { handled: Handled },
  during: { handle: WithHuman },
});

const conversationSchema = z.object({
  ticketId: z.string(),
  subject: z.string(),
  message: z.string(),
  customerEmail: z.string(),
  slaDueAt: z.string(),
});
type ConversationAttrs = z.infer<typeof conversationSchema>;

const New = H.state('New', 'pending');
const Classifying = H.state('Classifying', 'active');
const Drafting = H.state('Drafting', 'active');
const AwaitingApproval = H.state('AwaitingApproval', 'waiting');
const Sending = H.state('Sending', 'active');
const Sent = H.terminal('Sent', 'success');
const ClosedByCustomer = H.terminal('ClosedByCustomer', 'neutral');
const Escalated = H.terminal('Escalated', 'failure');

const Conversation = H.kind('Conversation')
  .attributes(conversationSchema)
  .states(New, Classifying, Drafting, AwaitingApproval, Sending, Sent, ClosedByCustomer, Escalated, Failed, Withdrawn)
  .key((conversation) => conversation.ticketId)
  .initial(New)
  .onAttemptFailed(Failed)
  .onCancelled(Withdrawn);

const customerReplied = H.signal('customer-replied').payload(z.object({ message: z.string() }));
const customerClosed = H.signal('customer-closed');
const slaBreached = H.signal('sla-breached');

const classifier = H.agent('classifier')
  .role(classifierRole)
  .model(haiku)
  .pool(pool)
  .output(z.object({ category: z.enum(['billing', 'refund', 'shipping', 'technical', 'other']) }));

const drafterModel: ModelPolicy = H.policy.model('drafter-model', [sonnet, opus], (ctx) => {
  const paused = ctx.metrics.paused({ lane: conversations, window: { calendar: 'month' } });
  const sonnetApprovals = ctx.metrics.rate(approvalByModel, { group: sonnet.name, window: { lastDays: 14 } });
  const sonnetWeak = sonnetApprovals.samples >= 100 && sonnetApprovals.rate < 0.85;
  return sonnetWeak || paused.totalMs > 3600000 ? opus : sonnet;
});

const drafter = H.agent('drafter').role(drafterRole).model(drafterModel).pool(pool);

const sendReply = H.command('send-reply')
  .input(z.object({ ticketId: z.string(), reply: z.string() }))
  .argv((input) => ['helpdesk', 'reply', input.ticketId, '--body', input.reply])
  .runner(localRunner);

const approvalDecision = z.object({ approved: z.boolean(), reply: z.string() });

const conversationFlow = H.flow('conversation')
  .input(conversationSchema)
  .step('classify', classifier, (ctx) => ({ task: `${ctx.unit.attributes.subject}\n\n${ctx.unit.attributes.message}` }))
  .loop(
    'drafting',
    (round) =>
      round
        .step('draft', drafter, (ctx) => ({
          task: `Reply to: ${ctx.unit.attributes.message}`,
          skills: [draftingFor.of(ctx.steps.classify.category)],
        }))
        .halt('approval', {
          ask: (ctx) => `Approve this reply to ${ctx.unit.attributes.customerEmail}?\n\n${ctx.steps.draft}`,
          decision: approvalDecision,
          skip: (ctx) => {
            const category = ctx.steps.classify.category;
            const record = ctx.metrics.rate(approvalByCategory, { group: category });
            const auditedThisMonth = ctx.metrics.total(auditsOpened, { group: category, window: { calendar: 'month' } });
            const safe = record.samples >= 200 && record.hits === record.samples && auditedThisMonth.total === 0;
            return safe ? { approved: true, reply: ctx.steps.draft } : undefined;
          },
        }),
    { max: 3, until: (ctx) => ctx.steps.approval.approved },
  )
  .exit('unapproved', (ctx) => !ctx.steps.approval.approved)
  .step('send', sendReply, (ctx) => ({ ticketId: ctx.unit.attributes.ticketId, reply: ctx.steps.approval.reply }), {
    afterCrash: 'park',
  })
  .exit('sent');

const slaHours: { readonly [P in ZendeskEvent['priority']]: number } = { low: 48, normal: 24, high: 8, urgent: 2 };

function routeHelpdesk(event: ZendeskEvent, to: Router<ConversationAttrs, string>) {
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
  if (event.status === 'closed' || event.status === 'solved') return to.signal(customerClosed, event.ticketId, {});
  return to.skip();
}

const conversations = H.lane('conversations', Conversation)
  .supply(zendesk.webhook({ port: H.slot.port(1), path: '/zendesk', secret: H.env('ZENDESK_WEBHOOK_SECRET') }), routeHelpdesk)
  .supply(zendesk.poll({ subdomain: 'acme', token: H.env('ZENDESK_TOKEN'), everyMinutes: 15 }), routeHelpdesk)
  .store(zendesk.store({ subdomain: 'acme', token: H.env('ZENDESK_TOKEN') }), {
    New: 'new',
    Classifying: 'open',
    Drafting: 'open',
    AwaitingApproval: 'open',
    Sending: 'open',
    Sent: 'pending',
    ClosedByCustomer: 'closed',
    Escalated: 'open',
    Failed: 'open',
    Withdrawn: 'solved',
  })
  .handler(conversationFlow, {
    exits: { unapproved: Escalated, sent: Sent },
    during: {
      classify: Classifying,
      draft: Drafting,
      send: Sending,
      approval: AwaitingApproval,
    },
  })
  .on(customerReplied, { update: (attrs, payload) => ({ ...attrs, message: payload.message }), restart: 'classify' })
  .on(customerClosed, { enter: ClosedByCustomer })
  .on(slaBreached, { enter: Escalated })
  .ceiling({ maxUsd: 0.4, onExceed: 'halt' });

const approvalByCategory: MetricRef<'rate'> = H.metric('approval-by-category', H.when.step(conversations, 'approval')).samples(
  (event) => {
    const classification = event.outputs.classify;
    const decision = event.output;
    return classification === undefined || decision === undefined
      ? []
      : [{ group: classification.category, hit: decision.approved }];
  },
);

const approvalByModel = H.metric('approval-by-model', H.when.step(conversations, 'approval')).samples((event) => {
  const decision = event.output;
  return decision === undefined ? [] : [{ group: event.models.draft ?? 'unknown', hit: decision.approved }];
});

const modelErrors = H.metric('model-errors', H.when.invocation({ lanes: [conversations] })).samples((event) =>
  event.model === undefined ? [] : [{ group: 'conversations', hit: !event.ok }],
);

const approvalLow = H.crossing('approval-low', approvalByCategory, {
  window: { lastDays: 7 },
  minSamples: 50,
  enter: { below: 0.9 },
  exit: { above: 0.95 },
});

const modelErrorsHigh = H.crossing('model-errors-high', modelErrors, {
  window: { lastHours: 1 },
  minSamples: 20,
  enter: { above: 0.2 },
  exit: { below: 0.05 },
});

const slaBreach = H.trigger('sla-breach')
  .on(H.when.timer(conversations, { at: (unit) => (unit.position === 'terminal' ? undefined : new Date(unit.attributes.slaDueAt)) }))
  .signal(slaBreached, conversations, (event) => ({ key: event.unit.key, payload: {} }));

const escalate = H.trigger('escalate')
  .on(H.when.transition(conversations, { to: Escalated }))
  .create(escalations, (event) => ({ ticketId: event.unit.attributes.ticketId, subject: event.unit.attributes.subject }));

const openAudit = H.trigger('open-audit')
  .on(H.when.entered(approvalLow))
  .create(audits, (event) => ({ category: event.group, rateAtOpen: event.value }))
  .record(draftingExperience, (event) => ({
    text: `When drafting for ${event.group}, recall the stricter phrasing, because approvals fell to ${event.value.toFixed(2)}.`,
    status: 'candidate',
    when: { roles: [drafterRole], skills: [draftingFor.of(event.group)] },
  }));

const closeAudit = H.trigger('close-audit')
  .on(H.when.exited(approvalLow))
  .signal(H.cancel, audits, (event) => ({
    key: event.group,
    payload: { reason: `approval rate recovered to ${event.value.toFixed(2)} over ${event.samples} samples` },
  }));

const pauseOnErrors = H.trigger('pause-on-model-errors')
  .on(H.when.entered(modelErrorsHigh))
  .pause(conversations, (event) => `model error rate ${event.value.toFixed(2)} over ${event.samples} invocations`);

const resumeOnRecovery = H.trigger('resume-on-model-recovery')
  .on(H.when.exited(modelErrorsHigh))
  .resume(conversations, (event) => `model error rate ${event.value.toFixed(2)} over ${event.samples} invocations`);

const scheduler = H.scheduler('support')
  .priority(escalations, audits, conversations)
  .rank(conversations, (unit) => new Date(unit.attributes.slaDueAt).getTime());

const reviewerSupervisor = claudeCode.supervisor('reviewer-supervisor', {
  grants: [
    H.ops.workRead,
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
  .ledger(sqlite.ledger({ path: 'state/ledger.sqlite' }))
  .lanes(conversations, escalations, audits)
  .corpora(toneTaste, draftingExperience)
  .triggers(slaBreach, escalate, openAudit, closeAudit, pauseOnErrors, resumeOnRecovery)
  .metrics(approvalByCategory, approvalByModel, modelErrors, auditsOpened)
  .scheduler(scheduler)
  .clients(reviewerSupervisor)
  .observers(markdown.board({ path: 'BOARD.md' }), markdown.telemetry({ path: 'TELEMETRY.md' }));
