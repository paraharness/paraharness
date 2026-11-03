import { z } from 'zod';
import { H, MetricRef, Metrics, Model, Route, Router, Window } from 'harness-dsl';
import { sqlite } from 'harness-dsl/sqlite';
import { jsonl } from 'harness-dsl/jsonl';
import { anthropic } from 'harness-dsl/anthropic';
import { claudeCode } from 'harness-dsl/claude-code';
import { zendesk, ZendeskEvent } from 'harness-dsl/zendesk';
import { local } from 'harness-dsl/local';
import { markdown } from 'harness-dsl/markdown';

const conversationAttributes = z.object({
  ticketId: z.string(),
  subject: z.string(),
  message: z.string(),
  customerEmail: z.string(),
  slaDeadline: z.string(),
});

type ConversationAttributes = z.infer<typeof conversationAttributes>;

const New = H.state('New', 'pending');
const Classifying = H.state('Classifying', 'active');
const Drafting = H.state('Drafting', 'active');
const AwaitingApproval = H.state('AwaitingApproval', 'active');
const Sending = H.state('Sending', 'active');
const Sent = H.state('Sent', 'waiting');
const ClosedByCustomer = H.terminal('ClosedByCustomer', 'success');
const Escalated = H.terminal('Escalated', 'neutral');
const Breached = H.terminal('Breached', 'failure');

const Conversation = H.kind('Conversation')
  .attributes(conversationAttributes)
  .states(New, Classifying, Drafting, AwaitingApproval, Sending, Sent, ClosedByCustomer, Escalated, Breached)
  .key(conversation => conversation.ticketId)
  .initial(New);

const customerReplied = H.signal('customer-replied').payload(z.object({ message: z.string() }));
const customerFollowedUp = H.signal('customer-followed-up').payload(z.object({ message: z.string() }));
const customerClosed = H.signal('customer-closed');
const slaBreached = H.signal('sla-breached');
const extendSla = H.signal('extend-sla').payload(z.object({ slaDeadline: z.string() }));

const classifier = H.role('classifier').intents('read').instructions('Assign the conversation one support category.');
const drafter = H.role('drafter')
  .intents('read')
  .instructions('Draft the reply in the house tone. Follow recalled taste and experience.');

const apiAccount = anthropic.account('api', { apiKey: H.env('ANTHROPIC_API_KEY') });
const pool = H.pool('support').accounts(apiAccount);
const haiku = anthropic.model('haiku', { id: 'claude-haiku-4-5' });
const sonnet = anthropic.model('sonnet', { id: 'claude-sonnet-4-5' });
const opus = anthropic.model('opus', { id: 'claude-opus-4-1' });

const month: Window = { calendar: 'month' };

const drafterModel = H.policy.model('drafter-model', [sonnet, opus], (ctx): Model => {
  const opened = ctx.metrics.total(auditsOpened, { window: month });
  const paused = ctx.metrics.paused({ lane: conversations, window: month });
  const sonnetApprovals = ctx.metrics.rate(approvalsByModel, { group: sonnet.name, window: { lastDays: 14 } });
  if (sonnetApprovals.samples >= 50 && sonnetApprovals.rate < 0.8) return opus;
  return opened.total >= 3 || paused.totalMs >= 3_600_000 ? opus : sonnet;
});

const classifierAgent = H.agent('classifier')
  .role(classifier)
  .model(haiku)
  .pool(pool)
  .output(z.object({ category: z.string() }));

const drafterAgent = H.agent('drafter')
  .role(drafter)
  .model(drafterModel)
  .pool(pool)
  .output(z.object({ reply: z.string() }));

const sendReply = H.command('send-reply')
  .input(z.object({ ticketId: z.string(), reply: z.string() }))
  .argv(input => ['helpdesk', 'reply', input.ticketId, '--body', input.reply])
  .runner(local.runner('support-box').slots(8));

function isSafeCategory(metrics: Metrics, category: string): boolean {
  const record = metrics.rate(approvals, { group: category });
  return record.hits >= 200 && record.hits === record.samples;
}

const approvalDecision = z.object({ action: z.enum(['approve', 'reject']), notes: z.string() });
const autoApproval: z.infer<typeof approvalDecision> = { action: 'approve', notes: '' };

const conversationFlow = H.flow('triage-conversation')
  .input(conversationAttributes)
  .step('classify', classifierAgent, ctx => ({
    task: `Classify this conversation.\nSubject: ${ctx.unit.attributes.subject}\n\n${ctx.unit.attributes.message}`,
  }))
  .loop(
    'drafting',
    round =>
      round
        .step('draft', drafterAgent, ctx => ({
          task: `Reply to ${ctx.unit.attributes.customerEmail}.\nSubject: ${ctx.unit.attributes.subject}\n\n${ctx.unit.attributes.message}`,
          skills: [ctx.steps.classify.category],
        }))
        .halt('approval', {
          ask: ctx => `Approve the reply to ticket ${ctx.unit.attributes.ticketId}:\n\n${ctx.steps.draft.reply}`,
          decision: approvalDecision,
          skip: ctx => (isSafeCategory(ctx.metrics, ctx.steps.classify.category) ? autoApproval : undefined),
        }),
    { max: 3, until: ctx => ctx.steps.approval.action === 'approve' },
  )
  .exit('escalated', ctx => ctx.steps.approval.action !== 'approve')
  .step('send', sendReply, ctx => ({ ticketId: ctx.unit.attributes.ticketId, reply: ctx.steps.draft.reply }), {
    afterCrash: 'park',
  })
  .exit('sent');

const slaHours: Readonly<Record<ZendeskEvent['priority'], number>> = { urgent: 1, high: 4, normal: 24, low: 48 };

function routeTicket(event: ZendeskEvent, to: Router<ConversationAttributes, string>): Route | readonly Route[] {
  if (event.status === 'solved' || event.status === 'closed') return to.signal(customerClosed, event.ticketId, {});
  if (event.type === 'created') {
    return to.create({
      ticketId: event.ticketId,
      subject: event.subject,
      message: event.message,
      customerEmail: event.customerEmail,
      slaDeadline: new Date(event.createdAt.getTime() + slaHours[event.priority] * 3_600_000).toISOString(),
    });
  }
  if (event.type === 'replied') {
    return [
      to.signal(customerReplied, unit => unit.key === event.ticketId && unit.state !== 'Sent', { message: event.message }),
      to.signal(customerFollowedUp, unit => unit.key === event.ticketId && unit.state === 'Sent', {
        message: event.message,
      }),
    ];
  }
  return to.skip();
}

const helpdeskToken = H.env('ZENDESK_TOKEN');

const conversations = H.lane('conversations', Conversation)
  .supply(zendesk.webhook({ port: H.slot.port(1), path: '/zendesk', secret: H.env('ZENDESK_WEBHOOK_SECRET') }), routeTicket)
  .supply(zendesk.poll({ subdomain: 'acme', token: helpdeskToken, everyMinutes: 15 }), routeTicket)
  .store(zendesk.store({ subdomain: 'acme', token: helpdeskToken }))
  .handler(conversationFlow, {
    exits: { escalated: Escalated, sent: Sent },
    during: { classify: Classifying, draft: Drafting, approval: AwaitingApproval, send: Sending },
  })
  .on(customerReplied, { update: (attrs, payload) => ({ ...attrs, message: payload.message }), restart: 'classify' })
  .on(customerFollowedUp, { update: (attrs, payload) => ({ ...attrs, message: payload.message }), enter: New })
  .on(customerClosed, { enter: ClosedByCustomer })
  .on(slaBreached, { enter: Breached })
  .on(extendSla, { update: (attrs, payload) => ({ ...attrs, slaDeadline: payload.slaDeadline }) })
  .ceiling({ maxUsd: 0.4, onExceed: 'halt' });

const escalationAttributes = z.object({ conversation: z.string(), reason: z.string() });

const EscalationOpen = H.state('EscalationOpen', 'pending');
const EscalationHandling = H.state('EscalationHandling', 'active');
const EscalationResolved = H.terminal('EscalationResolved', 'success');

const Escalation = H.kind('Escalation')
  .attributes(escalationAttributes)
  .states(EscalationOpen, EscalationHandling, EscalationResolved)
  .key(escalation => escalation.conversation)
  .initial(EscalationOpen);

const escalationFlow = H.flow('handle-escalation')
  .input(escalationAttributes)
  .halt('handle', {
    ask: ctx => `Escalated conversation ${ctx.unit.attributes.conversation}: ${ctx.unit.attributes.reason}`,
    decision: z.object({ resolution: z.string() }),
  })
  .exit('resolved');

const escalations = H.lane('escalations', Escalation)
  .handler(escalationFlow, { exits: { resolved: EscalationResolved }, during: { handle: EscalationHandling } });

const auditAttributes = z.object({ category: z.string(), rateAtOpen: z.number() });

const AuditOpen = H.state('AuditOpen', 'pending');
const AuditReview = H.state('AuditReview', 'active');
const AuditClosed = H.terminal('AuditClosed', 'success');
const AuditCancelled = H.terminal('AuditCancelled', 'neutral');

const Audit = H.kind('Audit')
  .attributes(auditAttributes)
  .states(AuditOpen, AuditReview, AuditClosed, AuditCancelled)
  .key(audit => audit.category)
  .initial(AuditOpen)
  .onCancelled(AuditCancelled);

const auditFlow = H.flow('audit-category')
  .input(auditAttributes)
  .halt('review', {
    ask: ctx => `Approvals for ${ctx.unit.attributes.category} fell to ${ctx.unit.attributes.rateAtOpen.toFixed(2)}. Review recent drafts.`,
    decision: z.object({ findings: z.string() }),
  })
  .exit('closed');

const audits = H.lane('audits', Audit)
  .handler(auditFlow, { exits: { closed: AuditClosed }, during: { review: AuditReview } });

const approvals: MetricRef<'rate'> = H.metric('approval-rate', H.when.step(conversations, 'approval')).samples(event => {
  const category = event.outputs.classify?.category;
  const decision = event.output;
  return category === undefined || decision === undefined ? [] : [{ group: category, hit: decision.action === 'approve' }];
});

const approvalsByModel: MetricRef<'rate'> = H.metric('approval-rate-by-model', H.when.step(conversations, 'approval')).samples(
  event => {
    const model = event.models.draft;
    const decision = event.output;
    return model === undefined || decision === undefined ? [] : [{ group: model, hit: decision.action === 'approve' }];
  },
);

const modelErrors: MetricRef<'rate'> = H.metric('model-error-rate', H.when.invocation({ lanes: [conversations] })).samples(
  event => (event.model === undefined ? [] : [{ group: 'conversations', hit: !event.ok }]),
);

const auditsOpened: MetricRef<'total'> = H.metric('audits-opened', H.when.transition(audits, { to: AuditOpen })).amounts(
  event => [{ group: event.unit.attributes.category, amount: 1 }],
);

const tasteKind = H.memory('reply-taste', 'taste');
const experienceKind = H.memory('drafting-experience', 'experience');

const taste = H.journal('taste', tasteKind)
  .store(jsonl.memoryStore({ path: '.harness/taste.jsonl' }))
  .recall({ by: 'specificity', limit: 12 })
  .readBy(drafter);

const experience = H.journal('experience', experienceKind)
  .store(jsonl.memoryStore({ path: '.harness/experience.jsonl' }))
  .recall({ by: 'specificity', limit: 12 })
  .readBy(drafter);

const slaBreach = H.trigger('sla-breach')
  .on(
    H.when.timer(conversations, {
      at: unit => (unit.position === 'terminal' || unit.state === 'Sent' ? undefined : new Date(unit.attributes.slaDeadline)),
    }),
  )
  .signal(slaBreached, conversations, event => ({ key: event.unit.key, payload: {} }))
  .create(escalations, event => ({
    conversation: event.unit.key,
    reason: `SLA deadline ${event.unit.attributes.slaDeadline} passed.`,
  }));

const unapprovedEscalates = H.trigger('unapproved-escalates')
  .on(H.when.transition(conversations, { to: Escalated }))
  .create(escalations, event => ({ conversation: event.unit.key, reason: 'No draft was approved after three rounds.' }));

const approvalDropOpensAudit = H.trigger('approval-drop-opens-audit')
  .on(
    H.when.crossing(approvals, {
      window: { lastDays: 7 },
      minSamples: 50,
      enter: { below: 0.9 },
      exit: { above: 0.95 },
    }),
  )
  .create(audits, event => (event.edge === 'entered' ? { category: event.group, rateAtOpen: event.value } : undefined))
  .record(experience, event =>
    event.edge === 'entered'
      ? {
          text: `When drafting for ${event.group}, recall the stricter phrasing, because approvals fell to ${event.value.toFixed(2)} over ${event.samples} samples.`,
          status: 'candidate',
          when: { roles: [drafter], skills: [event.group] },
        }
      : undefined,
  )
  .signal(H.cancel, audits, event =>
    event.edge === 'exited'
      ? { key: event.group, payload: { reason: `Approval rate recovered to ${event.value.toFixed(2)}.` } }
      : undefined,
  );

const modelErrorsPauseLane = H.trigger('model-errors-pause-lane')
  .on(
    H.when.crossing(modelErrors, {
      window: { lastHours: 1 },
      minSamples: 20,
      enter: { above: 0.2 },
      exit: { below: 0.05 },
    }),
  )
  .pause(conversations, event =>
    event.edge === 'entered'
      ? `Model error rate ${event.value.toFixed(3)} over ${event.samples} invocations in the last hour.`
      : undefined,
  )
  .resume(conversations, event =>
    event.edge === 'exited'
      ? `Model error rate recovered to ${event.value.toFixed(3)} over ${event.samples} invocations.`
      : undefined,
  );

const reviewerDesk = claudeCode.supervisor('reviewer-desk', {
  grants: [
    H.ops.workRead,
    H.ops.workSignal,
    H.ops.blockersResolve,
    H.ops.lanesPause,
    H.ops.memoryRead,
    H.ops.memoryWrite,
    H.ops.memoryCurate,
    H.ops.telemetryRead,
  ],
});

const support = H.harness('support-self-watch')
  .ledger(sqlite.ledger({ path: '.harness/ledger.sqlite' }))
  .lanes(conversations, escalations, audits)
  .journals(taste, experience)
  .triggers(slaBreach, unapprovedEscalates, approvalDropOpensAudit, modelErrorsPauseLane)
  .metrics(approvals, approvalsByModel, modelErrors, auditsOpened)
  .scheduler(
    H.scheduler('support')
      .priority(escalations, conversations, audits)
      .rank(conversations, unit => new Date(unit.attributes.slaDeadline).getTime()),
  )
  .clients(reviewerDesk)
  .observers(markdown.board({ path: '.harness/board.md' }), markdown.telemetry({ path: '.harness/telemetry.md' }));

void support.start();
