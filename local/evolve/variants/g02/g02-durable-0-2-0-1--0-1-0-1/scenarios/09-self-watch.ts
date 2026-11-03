import { z } from 'zod';
import { H, MetricRef, Band, Router, Route, State } from 'harness-dsl';
import { sqlite } from 'harness-dsl/sqlite';
import { jsonl } from 'harness-dsl/jsonl';
import { anthropic } from 'harness-dsl/anthropic';
import { claudeCode } from 'harness-dsl/claude-code';
import { zendesk, ZendeskEvent } from 'harness-dsl/zendesk';
import { local } from 'harness-dsl/local';
import { markdown } from 'harness-dsl/markdown';

const quota = sqlite.quota('support-quota', { path: '.harness/quota.sqlite' });
const apiAccount = anthropic.account('api', { apiKey: H.env('ANTHROPIC_API_KEY'), quota });
const haiku = anthropic.model('haiku', { id: 'claude-haiku-4-5' });
const sonnet = anthropic.model('sonnet', { id: 'claude-sonnet-4-5' });
const pool = H.pool('api').accounts(apiAccount);
const runner = local.runner('local').slots(4);
const category = H.facet('category');

const classifierRole = H.role('classifier').intents('read').instructions('Classify the conversation into one category.');
const drafterRole = H.role('drafter').intents('read').instructions('Draft a reply in the house tone.');
const reviewerRole = H.role('reviewer').intents('record').instructions('Approve or edit replies.');

const taste = H.memory('taste', 'taste');
const experience = H.memory('experience', 'experience');
const tasteJournal = H.journal('support-taste', taste)
  .store(jsonl.memoryStore({ path: '.harness/taste.jsonl' }))
  .recall({ by: 'specificity', limit: 10 })
  .readBy(drafterRole)
  .recordedBy(reviewerRole);
const experienceJournal = H.journal('support-experience', experience)
  .store(jsonl.memoryStore({ path: '.harness/experience.jsonl' }))
  .recall({ by: 'specificity', limit: 8 })
  .readBy(drafterRole)
  .recordedBy(reviewerRole);

const classifier = H.seat('classifier').role(classifierRole).model(haiku).pool(pool).output(z.object({ category: z.string() }));
const drafter = H.seat('drafter').role(drafterRole).model(sonnet).pool(pool).output(z.object({ reply: z.string() }));

const approvalDecision = z.object({ action: z.enum(['approve', 'reject']), edits: z.string().optional() });
type ApprovalDecision = z.infer<typeof approvalDecision>;
const approval = H.halt('reply-approval').decision(approvalDecision);

const safeCategory = H.policy.halt(
  'safe-category',
  approval,
  z.object({ category: z.string() }),
  ({ input, metrics }): ApprovalDecision | undefined => {
    const approvals = metrics.rate(approvalRate, { by: { facets: [category.of(input.category)] } });
    return approvals.samples >= 200 && approvals.hits === approvals.samples ? { action: 'approve' } : undefined;
  },
);

const conversationAttrs = z.object({
  ticketId: z.string(),
  subject: z.string(),
  message: z.string(),
  customerEmail: z.string(),
  slaDeadline: z.string(),
});
type ConversationAttrs = z.infer<typeof conversationAttrs>;

const New = H.state('new', 'pending');
const Classifying = H.state('classifying', 'active');
const Drafting = H.state('drafting', 'active');
const AwaitingApproval = H.state('awaiting-approval', 'waiting');
const Sending = H.state('sending', 'active');
const Sent = H.state('sent', 'waiting');
const ClosedByCustomer = H.terminal('closed-by-customer', 'success');
const Escalated = H.terminal('escalated', 'neutral');

const Conversation = H.kind('Conversation')
  .attributes(conversationAttrs)
  .states(New, Classifying, Drafting, AwaitingApproval, Sending, Sent, ClosedByCustomer, Escalated)
  .key(a => a.ticketId);

const customerReplied = H.signal('customer-replied').payload(z.object({ message: z.string() }));
const closedByCustomer = H.signal('closed-by-customer');
const slaExtended = H.signal('sla-extended').payload(z.object({ deadline: z.string() }));
const escalate = H.signal('escalate').payload(z.object({ reason: z.string() }));

const slaHours = { low: 48, normal: 24, high: 8, urgent: 2 };

function routeTicket(e: ZendeskEvent, to: Router<ConversationAttrs, State>): Route {
  if (e.type === 'created') {
    return to.create({
      ticketId: e.ticketId,
      subject: e.subject,
      message: e.message,
      customerEmail: e.customerEmail,
      slaDeadline: new Date(e.createdAt.getTime() + slaHours[e.priority] * 3_600_000).toISOString(),
    });
  }
  if (e.type === 'replied') return to.signal(customerReplied, e.ticketId, { message: e.message });
  if (e.status === 'closed' || e.status === 'solved') return to.signal(closedByCustomer, e.ticketId, {});
  return to.skip();
}

const sendReply = H.command('send-reply')
  .input(z.object({ ticketId: z.string(), reply: z.string() }))
  .argv(i => ['./scripts/send-reply', i.ticketId, i.reply])
  .runner(runner);

const answerConversation = H.flow('answer-conversation')
  .input(conversationAttrs)
  .step('classify', classifier, ctx => ({ task: `Classify: ${ctx.unit.attributes.subject}\n${ctx.unit.attributes.message}` }))
  .loop(
    'drafts',
    draft =>
      draft
        .step('draft', drafter, ctx => ({
          task: `Draft a reply to: ${ctx.unit.attributes.message}`,
          skills: [ctx.steps.classify.category],
        }))
        .halt('approval', approval, {
          ask: ctx => `Approve this reply to ${ctx.unit.attributes.ticketId}?\n${ctx.steps.draft.reply}`,
          skip: { by: safeCategory, input: ctx => ({ category: ctx.steps.classify.category }) },
        }),
    { max: 3, until: ctx => ctx.steps.approval.action === 'approve' },
  )
  .exit('unapproved', ctx => ctx.steps.approval.action === 'reject')
  .step('send', sendReply, ctx => ({ ticketId: ctx.unit.attributes.ticketId, reply: ctx.steps.approval.edits ?? ctx.steps.draft.reply }), {
    afterCrash: 'park',
  })
  .exit('sent');

const helpdeskToken = H.env('ZENDESK_TOKEN');

const conversationLane = H.lane('conversations', Conversation)
  .supply(zendesk.webhook({ port: H.slot.port(2), path: '/zendesk', secret: H.env('ZENDESK_WEBHOOK_SECRET') }), routeTicket)
  .supply(zendesk.poll({ subdomain: 'acme', token: helpdeskToken, everyMinutes: 10 }), routeTicket)
  .store(zendesk.store({ subdomain: 'acme', token: helpdeskToken }))
  .handler(answerConversation, {
    exits: { unapproved: Escalated, sent: Sent },
    during: { classify: Classifying, draft: Drafting, approval: AwaitingApproval, send: Sending },
  })
  .retry({ maxAttempts: 2, backoff: 'exponential', initialDelayMs: 30_000, exhausted: Escalated })
  .on(customerReplied, { update: (a, p) => ({ ...a, message: p.message }), restart: { to: 'classify', at: ['approval'] } })
  .on(closedByCustomer, { enter: ClosedByCustomer })
  .on(slaExtended, { update: (a, p) => ({ ...a, slaDeadline: p.deadline }) })
  .on(escalate, { enter: Escalated });

const escalationAttrs = z.object({ ticketId: z.string(), subject: z.string() });
const EscalationOpen = H.state('escalation-open', 'pending');
const EscalationHandling = H.state('escalation-handling', 'waiting');
const EscalationStuck = H.state('escalation-stuck', 'waiting');
const EscalationResolved = H.terminal('escalation-resolved', 'success');
const EscalationDropped = H.terminal('escalation-dropped', 'neutral');
const Escalation = H.kind('Escalation')
  .attributes(escalationAttrs)
  .states(EscalationOpen, EscalationHandling, EscalationStuck, EscalationResolved, EscalationDropped)
  .key(a => a.ticketId);
const escalationDecision = H.halt('escalation-decision').decision(z.object({ resolution: z.string() }));
const handleEscalation = H.flow('handle-escalation')
  .input(escalationAttrs)
  .halt('handle', escalationDecision, { ask: ctx => `Take over ticket ${ctx.unit.attributes.ticketId}: ${ctx.unit.attributes.subject}` })
  .exit('handled');
const escalationLane = H.lane('escalations', Escalation)
  .handler(handleEscalation, { exits: { handled: EscalationResolved }, during: { handle: EscalationHandling } })
  .retry({ maxAttempts: 1, backoff: 'fixed', initialDelayMs: 0, exhausted: EscalationStuck })
  .on(H.cancel, { enter: EscalationDropped });

const auditAttrs = z.object({ category: z.string(), rate: z.number(), samples: z.number() });
const AuditOpen = H.state('audit-open', 'pending');
const AuditUnderReview = H.state('audit-under-review', 'waiting');
const AuditStuck = H.state('audit-stuck', 'waiting');
const AuditClosed = H.terminal('audit-closed', 'success');
const AuditCancelled = H.terminal('audit-cancelled', 'neutral');
const Audit = H.kind('Audit')
  .attributes(auditAttrs)
  .states(AuditOpen, AuditUnderReview, AuditStuck, AuditClosed, AuditCancelled)
  .key(a => a.category);
const auditReview = H.halt('audit-review').decision(z.object({ findings: z.string() }));
const auditCategory = H.flow('audit-category')
  .input(auditAttrs)
  .halt('review', auditReview, {
    ask: ctx => `Approvals for ${ctx.unit.attributes.category} fell to ${ctx.unit.attributes.rate} over ${ctx.unit.attributes.samples} samples. What did you find?`,
  })
  .exit('reviewed');
const auditLane = H.lane('audits', Audit)
  .handler(auditCategory, { exits: { reviewed: AuditClosed }, during: { review: AuditUnderReview } })
  .retry({ maxAttempts: 1, backoff: 'fixed', initialDelayMs: 0, exhausted: AuditStuck })
  .on(H.cancel, { enter: AuditCancelled });

const approvalRate: MetricRef<'rate'> = H.metric('approval-rate', H.when.decision(conversationLane, approval))
  .facets(category)
  .samples(e =>
    e.resolvedBy === 'human'
      ? [
          {
            hit: e.decision.action === 'approve',
            by: { model: e.invocations.draft?.model, facets: [category.of(e.outputs.classify?.category ?? 'uncategorised')] },
          },
        ]
      : [],
  );

const modelErrorRate = H.metric('model-error-rate', H.when.invocation(conversationLane)).samples(e =>
  e.model === undefined ? [] : [{ hit: e.ok === false }],
);

const auditsOpened = H.metric('audits-opened', H.when.transition(auditLane, AuditOpen))
  .facets(category)
  .amounts(e => [{ amount: 1, by: { facets: [category.of(e.unit.attributes.category)] } }]);

const approvalBand: Band = { window: { lastDays: 7 }, minSamples: 50, enter: { below: 0.9 }, exit: { above: 0.95 } };
const errorBand: Band = { window: { lastHours: 1 }, minSamples: 20, enter: { above: 0.2 }, exit: { below: 0.05 } };

const approvalDropped = H.trigger('approval-dropped')
  .on(H.when.crossing(approvalRate, approvalBand, 'entered'))
  .create(auditLane, e => {
    const c = category.read(e.by);
    return c === undefined ? undefined : { category: c, rate: e.value, samples: e.samples };
  })
  .record(experienceJournal, e => {
    const c = category.read(e.by);
    return c === undefined
      ? undefined
      : {
          text: `When drafting for ${c}, recall the stricter phrasing, because approvals fell to ${e.value.toFixed(2)}.`,
          when: { roles: [drafterRole], skills: [c] },
          status: 'candidate',
        };
  });

const approvalRecovered = H.trigger('approval-recovered')
  .on(H.when.crossing(approvalRate, approvalBand, 'exited'))
  .signal(H.cancel, auditLane, e => {
    const c = category.read(e.by);
    return c === undefined ? undefined : { key: c, payload: { reason: `approval rate recovered to ${e.value.toFixed(2)}` } };
  });

const modelErrorsPause = H.trigger('model-errors-pause')
  .on(H.when.crossing(modelErrorRate, errorBand, 'entered'))
  .pause(conversationLane, e => `model error rate ${e.value.toFixed(3)} over ${e.samples} invocations`);

const modelErrorsResume = H.trigger('model-errors-resume')
  .on(H.when.crossing(modelErrorRate, errorBand, 'exited'))
  .resume(conversationLane, e => `model error rate ${e.value.toFixed(3)} over ${e.samples} invocations`);

const slaBreach = H.trigger('sla-breach')
  .on(H.when.timer(conversationLane, u => (u.position === 'terminal' || u.state === Sent ? undefined : new Date(u.attributes.slaDeadline))))
  .signal(escalate, conversationLane, e => ({ key: e.unit.key, payload: { reason: 'SLA breached' } }));

const escalationOpened = H.trigger('escalation-opened')
  .on(H.when.transition(conversationLane, Escalated))
  .create(escalationLane, e => ({ ticketId: e.unit.attributes.ticketId, subject: e.unit.attributes.subject }));

const reviewer = claudeCode.supervisor('reviewer').client('support-review', {
  grants: [
    H.ops.workRead,
    H.ops.resolve(approval),
    H.ops.resolve(auditReview),
    H.ops.resolve(escalationDecision),
    H.ops.signal(slaExtended),
    H.ops.signal(H.cancel),
    H.ops.memoryRead,
    H.ops.memoryWrite,
    H.ops.memoryCurate,
    H.ops.telemetryRead,
  ],
});

export const harness = H.harness('support')
  .ledger(sqlite.ledger({ path: '.harness/ledger.sqlite' }))
  .lanes(conversationLane, escalationLane, auditLane)
  .journals(tasteJournal, experienceJournal)
  .metrics(approvalRate, modelErrorRate, auditsOpened)
  .triggers(approvalDropped, approvalRecovered, modelErrorsPause, modelErrorsResume, slaBreach, escalationOpened)
  .scheduler(
    H.scheduler('support-scheduler')
      .priority(escalationLane, auditLane, conversationLane)
      .rank(conversationLane, u => new Date(u.attributes.slaDeadline).getTime())
      .admit(auditLane, ({ unit, metrics }) => {
        const opened = metrics.total(auditsOpened, { by: { facets: [category.of(unit.attributes.category)] }, window: { calendar: 'month' } });
        const paused = metrics.paused({ lane: conversationLane, window: { calendar: 'month' } });
        return opened.total <= 4 || paused.totalMs > 4 * 3_600_000;
      }),
  )
  .clients(reviewer)
  .observers(markdown.board({ path: 'BOARD.md' }), markdown.telemetry({ path: 'TELEMETRY.md' }));

void harness.start();
