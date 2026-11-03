import { z } from 'zod';
import { H, Dims, MetricRef, Resource } from 'harness-dsl';
import { sqlite } from 'harness-dsl/sqlite';
import { jsonl } from 'harness-dsl/jsonl';
import { anthropic } from 'harness-dsl/anthropic';
import { claudeCode } from 'harness-dsl/claude-code';
import { zendesk } from 'harness-dsl/zendesk';
import { local } from 'harness-dsl/local';
import { markdown } from 'harness-dsl/markdown';

const categoryName = z.enum(['billing', 'shipping', 'refunds', 'account']);
type Category = z.infer<typeof categoryName>;

const categoryOf: { readonly [K in Category]: Resource } = {
  billing: H.resource('category-billing'),
  shipping: H.resource('category-shipping'),
  refunds: H.resource('category-refunds'),
  account: H.resource('category-account'),
};

const categoryAt = (by: Dims): Category | undefined => categoryName.options.find(c => categoryOf[c] === by.resource);

const quota = sqlite.quota('support-quota', { path: 'data/quota.sqlite' });
const apiAccount = anthropic.account('api', { apiKey: H.env('ANTHROPIC_API_KEY'), quota });
const haiku = anthropic.model('haiku', { id: 'claude-haiku-4-5' });
const sonnet = anthropic.model('sonnet', { id: 'claude-sonnet-4-5' });
const pool = H.pool('api').accounts(apiAccount);
const shell = local.runner('local').slots(4);
const helpdeskToken = H.env('ZENDESK_TOKEN');

const classifierRole = H.role('classifier').intents('read').instructions('Classify the conversation into one category.');
const drafterRole = H.role('drafter').intents('read').instructions('Draft the reply in the house tone.');
const reviewerRole = H.role('reviewer').intents('read', 'record').instructions('Approve or edit outgoing replies.');

const taste = H.journal('support-taste', H.memory('support-taste', 'taste'))
  .store(jsonl.memoryStore({ path: 'data/taste.jsonl' }))
  .recall({ by: 'specificity', limit: 8 })
  .readBy(drafterRole)
  .recordedBy(reviewerRole);

const experience = H.journal('support-experience', H.memory('support-experience', 'experience'))
  .store(jsonl.memoryStore({ path: 'data/experience.jsonl' }))
  .recall({ by: 'specificity', limit: 8 })
  .readBy(drafterRole)
  .recordedBy(reviewerRole);

const AuditOpen = H.state('AuditOpen', 'pending');
const AuditInReview = H.state('AuditInReview', 'waiting');
const AuditClosed = H.terminal('AuditClosed', 'success');
const AuditCancelled = H.terminal('AuditCancelled', 'neutral');
const AuditAbandoned = H.terminal('AuditAbandoned', 'failure');

const auditAttributes = z.object({ category: categoryName, rate: z.number(), samples: z.number() });

const Audit = H.kind('Audit')
  .attributes(auditAttributes)
  .states(AuditOpen, AuditInReview, AuditClosed, AuditCancelled, AuditAbandoned)
  .key(a => a.category)
  .initial(AuditOpen);

const auditFindings = H.halt('audit-findings').decision(z.object({ findings: z.string() }));

const auditCategory = H.flow('audit-category')
  .input(auditAttributes)
  .halt('review', auditFindings, {
    ask: ctx => `Approvals for ${ctx.unit.attributes.category} fell to ${ctx.unit.attributes.rate} over ${ctx.unit.attributes.samples} samples. Record findings.`,
  })
  .exit('closed');

const audits = H.lane('audits', Audit)
  .store(sqlite.store({ path: 'data/audits.sqlite' }))
  .handler(auditCategory, { exits: { closed: AuditClosed }, during: { review: AuditInReview } })
  .retry({ maxAttempts: 2, backoff: 'fixed', initialDelayMs: 60000, exhausted: AuditAbandoned })
  .on(H.cancel, { enter: AuditCancelled });

const auditsOpened = H.metric('audits-opened', H.when.transition(audits, { to: AuditOpen }))
  .amounts(opened => [{ amount: 1, by: { resource: categoryOf[opened.unit.attributes.category] } }]);

const EscalationOpen = H.state('EscalationOpen', 'pending');
const EscalationWaiting = H.state('EscalationWaiting', 'waiting');
const EscalationHandled = H.terminal('EscalationHandled', 'success');
const EscalationDropped = H.terminal('EscalationDropped', 'failure');

const escalationAttributes = z.object({ ticketId: z.string(), reason: z.string() });

const Escalation = H.kind('Escalation')
  .attributes(escalationAttributes)
  .states(EscalationOpen, EscalationWaiting, EscalationHandled, EscalationDropped)
  .key(a => a.ticketId)
  .initial(EscalationOpen);

const escalationResolution = H.halt('escalation-resolution').decision(z.object({ resolution: z.string() }));

const handleEscalation = H.flow('handle-escalation')
  .input(escalationAttributes)
  .halt('handle', escalationResolution, { ask: ctx => `Ticket ${ctx.unit.attributes.ticketId}: ${ctx.unit.attributes.reason}` })
  .exit('handled');

const escalations = H.lane('escalations', Escalation)
  .store(sqlite.store({ path: 'data/escalations.sqlite' }))
  .handler(handleEscalation, { exits: { handled: EscalationHandled }, during: { handle: EscalationWaiting } })
  .retry({ maxAttempts: 2, backoff: 'fixed', initialDelayMs: 60000, exhausted: EscalationDropped });

const approval = H.halt('reply-approval').decision(z.object({ approved: z.boolean(), editedReply: z.string().optional() }));

const approvalRate: MetricRef<'rate'> = H.metric('approval-rate', H.when.decision(conversations(), approval))
  .samples(decided => {
    const category = decided.outputs.classify?.category;
    return decided.resolvedBy === 'human' && category !== undefined
      ? [{ hit: decided.decision.approved, by: { resource: categoryOf[category], model: decided.invocations.draft?.model } }]
      : [];
  });

const safeCategory = H.policy.halt('safe-category', approval, z.object({ category: categoryName }), ctx => {
  const record = ctx.metrics.rate(approvalRate, { by: { resource: categoryOf[ctx.input.category] } });
  const auditedThisMonth = ctx.metrics.total(auditsOpened, {
    by: { resource: categoryOf[ctx.input.category] },
    window: { calendar: 'month' },
  });
  return record.samples >= 200 && record.hits === record.samples && auditedThisMonth.total === 0
    ? { approved: true }
    : undefined;
});

const classifier = H.seat('classifier').output(z.object({ category: categoryName })).role(classifierRole).model(haiku).pool(pool);
const drafter = H.seat('drafter').output(z.object({ reply: z.string() })).role(drafterRole).model(sonnet).pool(pool);

const sendReply = H.command('send-reply')
  .input(z.object({ ticketId: z.string(), body: z.string() }))
  .argv(i => ['helpdesk-reply', i.ticketId, i.body])
  .runner(shell);

const New = H.state('New', 'pending');
const Classifying = H.state('Classifying', 'active');
const Drafting = H.state('Drafting', 'active');
const AwaitingApproval = H.state('AwaitingApproval', 'waiting');
const Sent = H.terminal('Sent', 'success');
const ClosedByCustomer = H.terminal('ClosedByCustomer', 'neutral');
const Escalated = H.terminal('Escalated', 'neutral');

const conversationAttributes = z.object({
  ticketId: z.string(),
  subject: z.string(),
  message: z.string(),
  slaDeadline: z.string(),
});

const Conversation = H.kind('Conversation')
  .attributes(conversationAttributes)
  .states(New, Classifying, Drafting, AwaitingApproval, Sent, ClosedByCustomer, Escalated)
  .key(a => a.ticketId)
  .initial(New);

const reply = H.flow('reply')
  .input(conversationAttributes)
  .step('classify', classifier, ctx => ({ task: `${ctx.unit.attributes.subject}\n\n${ctx.unit.attributes.message}` }), { afterCrash: 'rerun' })
  .step('draft', drafter, ctx => ({
    task: `Reply to: ${ctx.unit.attributes.message}`,
    resources: [categoryOf[ctx.steps.classify.category]],
  }), { afterCrash: 'rerun' })
  .halt('approval', approval, {
    ask: ctx => `Approve the reply to ${ctx.unit.attributes.ticketId}:\n\n${ctx.steps.draft.reply}`,
    skip: { by: safeCategory, input: ctx => ({ category: ctx.steps.classify.category }) },
  })
  .exit('rejected', ctx => !ctx.steps.approval.approved)
  .step('send', sendReply, ctx => ({
    ticketId: ctx.unit.attributes.ticketId,
    body: ctx.steps.approval.editedReply ?? ctx.steps.draft.reply,
  }), { afterCrash: 'park' })
  .exit('sent');

const customerReplied = H.signal('customer-replied').payload(z.object({ message: z.string() }));
const customerClosed = H.signal('customer-closed');
const extendSla = H.signal('extend-sla').payload(z.object({ deadline: z.string() }));

const slaDeadlineFor = (createdAt: Date, priority: 'low' | 'normal' | 'high' | 'urgent') =>
  new Date(createdAt.getTime() + (priority === 'urgent' ? 1 : priority === 'high' ? 4 : 24) * 3600000).toISOString();

function conversations() {
  return H.lane('conversations', Conversation)
    .supply(zendesk.webhook({ port: H.slot.port(1), path: '/helpdesk', secret: H.env('ZENDESK_WEBHOOK_SECRET') }), (event, to) =>
      event.type === 'created'
        ? to.create({
            ticketId: event.ticketId,
            subject: event.subject,
            message: event.message,
            slaDeadline: slaDeadlineFor(event.createdAt, event.priority),
          })
        : event.type === 'replied'
          ? to.signal(customerReplied, event.ticketId, { message: event.message })
          : event.status === 'closed' || event.status === 'solved'
            ? to.signal(customerClosed, event.ticketId, {})
            : to.skip(),
    )
    .supply(zendesk.poll({ subdomain: 'acme', token: helpdeskToken, everyMinutes: 10 }), (event, to) =>
      event.status === 'new'
        ? to.create({
            ticketId: event.ticketId,
            subject: event.subject,
            message: event.message,
            slaDeadline: slaDeadlineFor(event.createdAt, event.priority),
          })
        : to.skip(),
    )
    .store(zendesk.store({ subdomain: 'acme', token: helpdeskToken }))
    .handler(reply, {
      exits: { rejected: Escalated, sent: Sent },
      during: { classify: Classifying, draft: Drafting, send: Drafting, approval: AwaitingApproval },
    })
    .retry({ maxAttempts: 3, backoff: 'exponential', initialDelayMs: 30000, exhausted: Escalated })
    .ceiling({ maxUsd: 0.4, onExceed: 'fail' })
    .on(customerReplied, {
      update: (attrs, replied) => ({ ...attrs, message: replied.message }),
      restart: { to: 'classify', at: ['approval'] },
    })
    .on(customerClosed, { enter: ClosedByCustomer })
    .on(extendSla, { update: (attrs, extended) => ({ ...attrs, slaDeadline: extended.deadline }) });
}

const conversationLane = conversations();

const modelErrorRate = H.metric('model-error-rate', H.when.invocation({ lanes: [conversationLane] }))
  .samples(invoked => [{ hit: !invoked.ok, by: { model: invoked.model } }]);

const approvalBand = { window: { lastDays: 7 }, minSamples: 50, enter: { below: 0.9 }, exit: { above: 0.95 } };
const errorBand = { window: { lastHours: 1 }, minSamples: 20, enter: { above: 0.2 }, exit: { below: 0.05 } };

const openAudit = H.trigger('open-audit')
  .on(H.when.crossing(approvalRate, approvalBand, 'entered'))
  .create(audits, crossed => {
    const category = categoryAt(crossed.by);
    return category === undefined ? undefined : { category, rate: crossed.value, samples: crossed.samples };
  })
  .record(experience, crossed => {
    const category = categoryAt(crossed.by);
    return category === undefined
      ? undefined
      : {
          text: `When drafting for ${category}, recall the stricter phrasing, because approvals fell to ${crossed.value}.`,
          when: { roles: [drafterRole], resources: [categoryOf[category]] },
          status: 'candidate',
        };
  });

const closeAudit = H.trigger('close-audit')
  .on(H.when.crossing(approvalRate, approvalBand, 'exited'))
  .signal(H.cancel, audits, crossed => {
    const category = categoryAt(crossed.by);
    return category === undefined
      ? undefined
      : { key: category, payload: { reason: `approval rate recovered to ${crossed.value} over ${crossed.samples} samples` } };
  });

const pauseOnErrors = H.trigger('pause-on-model-errors')
  .on(H.when.crossing(modelErrorRate, errorBand, 'entered'))
  .pause(conversationLane, crossed => `model error rate ${crossed.value} over ${crossed.samples} invocations`);

const resumeOnRecovery = H.trigger('resume-on-recovery')
  .on(H.when.crossing(modelErrorRate, errorBand, 'exited'))
  .resume(conversationLane, crossed => `model error rate ${crossed.value} over ${crossed.samples} invocations`);

const slaBreach = H.trigger('sla-breach')
  .on(H.when.timer(conversationLane, { at: unit => new Date(unit.attributes.slaDeadline) }))
  .create(escalations, breached => ({ ticketId: breached.unit.attributes.ticketId, reason: 'SLA breached' }));

const scheduler = H.scheduler('support-scheduler')
  .priority(escalations, conversationLane, audits)
  .wip(conversationLane, 6)
  .rank(conversationLane, unit => new Date(unit.attributes.slaDeadline).getTime())
  .admit(audits, ctx => ctx.metrics.paused({ lane: conversationLane, window: { lastHours: 24 } }).totalMs < 1800000);

const reviewer = claudeCode.supervisor('reviewer').client('reviewer-supervisor', {
  grants: [
    H.ops.workRead,
    H.ops.workSignal,
    H.ops.resolve(approval),
    H.ops.resolve(auditFindings),
    H.ops.resolve(escalationResolution),
    H.ops.memoryRead,
    H.ops.memoryWrite,
    H.ops.memoryCurate,
    H.ops.lanesPause,
    H.ops.telemetryRead,
  ],
});

const harness = H.harness('support')
  .ledger(sqlite.ledger({ path: 'data/ledger.sqlite' }))
  .lanes(conversationLane, escalations, audits)
  .journals(taste, experience)
  .triggers(openAudit, closeAudit, pauseOnErrors, resumeOnRecovery, slaBreach)
  .metrics(approvalRate, modelErrorRate, auditsOpened)
  .scheduler(scheduler)
  .clients(reviewer)
  .observers(markdown.board({ path: 'data/board.md' }), markdown.telemetry({ path: 'data/telemetry.md' }));

void harness.start();
