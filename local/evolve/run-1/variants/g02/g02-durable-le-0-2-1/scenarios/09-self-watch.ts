import { z } from 'zod';
import { H, Metrics, Route, Router } from 'harness-dsl';
import { anthropic } from 'harness-dsl/anthropic';
import { claudeCode } from 'harness-dsl/claude-code';
import { sqlite } from 'harness-dsl/sqlite';
import { jsonl } from 'harness-dsl/jsonl';
import { local } from 'harness-dsl/local';
import { zendesk, ZendeskEvent } from 'harness-dsl/zendesk';
import { markdown } from 'harness-dsl/markdown';

const supportAccount = anthropic.account('support-api', { apiKey: H.env('ANTHROPIC_API_KEY') });
const cheapModel = anthropic.model('classifier-model', { id: 'claude-haiku-4-5' });
const strongModel = anthropic.model('drafter-model', { id: 'claude-sonnet-4-5' });
const supportPool = H.pool('support-api').accounts(supportAccount).serves(cheapModel, strongModel);

const classifierRole = H.role('classifier')
  .intents('read')
  .instructions('Assign exactly one category to the customer message.');
const drafterRole = H.role('drafter')
  .intents('read')
  .instructions('Draft a reply in the house tone that resolves the customer message.');

const supportTaste = H.memory('support-taste').trust('taste');
const supportExperience = H.memory('support-experience').trust('experience');
const supportRecall = H.recall('support-recall', { by: 'specificity', limit: 10 });

const tasteJournal = H.journal('support-taste', supportTaste)
  .store(jsonl.memoryStore({ path: 'memory/taste.jsonl' }))
  .recall(supportRecall)
  .readBy(drafterRole);

const experienceJournal = H.journal('support-experience', supportExperience)
  .store(jsonl.memoryStore({ path: 'memory/experience.jsonl' }))
  .recall(supportRecall)
  .readBy(drafterRole);

const classifier = H.agent('classifier')
  .role(classifierRole)
  .model(cheapModel)
  .output(z.object({ category: z.string() }));

const drafter = H.agent('drafter')
  .role(drafterRole)
  .model(strongModel)
  .output(z.object({ text: z.string() }));

const supportRunner = local.runner('support-local');
const helpdeskToken = H.env('ZENDESK_TOKEN');

const sendReply = H.command('send-reply')
  .input(z.object({ ticketId: z.string(), body: z.string() }))
  .argv(input => ['helpdesk', 'reply', input.ticketId, input.body])
  .runner(supportRunner);

const conversationSchema = z.object({
  ticketId: z.string(),
  subject: z.string(),
  message: z.string(),
  customerEmail: z.string(),
  slaDueAt: z.string(),
});
type ConversationAttributes = z.infer<typeof conversationSchema>;

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
  .states(New, Classifying, Drafting, AwaitingApproval, Sending, Sent, ClosedByCustomer, Escalated)
  .key(conversation => conversation.ticketId)
  .initial(New);

const approve = H.signal('approve').payload(z.object({
  approved: z.boolean(),
  reply: z.string().optional(),
  notes: z.string().optional(),
}));
const customerReplied = H.signal('customerReplied').payload(z.object({ message: z.string() }));
const customerClosed = H.signal('customerClosed');
const slaBreached = H.signal('slaBreached');
const extendSla = H.signal('extendSla').payload(z.object({ slaDueAt: z.string() }));

const slaHours = { urgent: 1, high: 4, normal: 12, low: 24 };

function routeTicket(event: ZendeskEvent, to: Router<ConversationAttributes, string>): Route {
  if (event.status === 'closed' || event.status === 'solved') return to.signal(customerClosed, event.ticketId, {});
  if (event.type === 'replied') return to.signal(customerReplied, event.ticketId, { message: event.message });
  if (event.type === 'created') {
    return to.create({
      ticketId: event.ticketId,
      subject: event.subject,
      message: event.message,
      customerEmail: event.customerEmail,
      slaDueAt: new Date(event.createdAt.getTime() + slaHours[event.priority] * 3600000).toISOString(),
    });
  }
  return to.skip();
}

function isSafeCategory(category: string, metrics: Metrics): boolean {
  const approvals = metrics.rate(approvalRate, { group: category });
  const auditsThisMonth = metrics.total(auditsOpened, { group: category, window: { calendar: 'month' } });
  return approvals.samples >= 200 && approvals.hits === approvals.samples && auditsThisMonth.total === 0;
}

const replyFlow = H.flow('reply-to-customer')
  .input(conversationSchema)
  .step('classify', classifier, ctx => ({
    task: `Classify this message.\nSubject: ${ctx.unit.attributes.subject}\n\n${ctx.unit.attributes.message}`,
  }))
  .loop(
    'drafting',
    round => round
      .step('draft', drafter, ctx => ({
        task: `Draft a reply to ${ctx.unit.attributes.customerEmail}:\n\n${ctx.unit.attributes.message}`,
        resources: [`category:${ctx.steps.classify.category}`],
      }))
      .await('approval', approve, {
        ask: ctx => `Approve this ${ctx.steps.classify.category} reply?\n\n${ctx.steps.draft.text}`,
        skip: ctx => isSafeCategory(ctx.steps.classify.category, ctx.metrics) ? { approved: true } : undefined,
      }),
    { max: 3, until: ctx => ctx.steps.approval.approved },
  )
  .exit('unapproved', ctx => !ctx.steps.approval.approved)
  .step('send', sendReply, ctx => ({
    ticketId: ctx.unit.attributes.ticketId,
    body: ctx.steps.approval.reply ?? ctx.steps.draft.text,
  }), { afterCrash: 'park' })
  .exit('sent');

const conversations = H.lane('conversations', Conversation)
  .supply(zendesk.webhook({ port: H.slot.port(1), path: '/helpdesk', secret: H.env('ZENDESK_WEBHOOK_SECRET') }), routeTicket)
  .supply(zendesk.poll({ subdomain: 'acme', token: helpdeskToken, everyMinutes: 15 }), routeTicket)
  .store(zendesk.store({ subdomain: 'acme', token: helpdeskToken }))
  .handler(replyFlow, {
    exits: { unapproved: Escalated, sent: Sent },
    during: { classify: Classifying, draft: Drafting, approval: AwaitingApproval, send: Sending },
  })
  .on(customerReplied, {
    update: (attrs, reply) => ({ ...attrs, message: reply.message }),
    restart: 'classify',
  })
  .on(customerClosed, { enter: ClosedByCustomer })
  .on(slaBreached, { enter: Escalated })
  .on(extendSla, { update: (attrs, extension) => ({ ...attrs, slaDueAt: extension.slaDueAt }) })
  .ceiling({ maxUsd: 0.4, onExceed: 'halt' });

const escalationSchema = z.object({
  ticketId: z.string(),
  reason: z.enum(['slaBreached', 'unapproved']),
});

const EscalationOpen = H.state('EscalationOpen', 'pending');
const WithHuman = H.state('WithHuman', 'waiting');
const EscalationResolved = H.terminal('EscalationResolved', 'success');

const Escalation = H.kind('Escalation')
  .attributes(escalationSchema)
  .states(EscalationOpen, WithHuman, EscalationResolved)
  .key(escalation => escalation.ticketId)
  .initial(EscalationOpen);

const escalationResolved = H.signal('escalationResolved').payload(z.object({ resolution: z.string() }));

const escalationFlow = H.flow('human-escalation')
  .input(escalationSchema)
  .await('handover', escalationResolved, {
    ask: ctx => `Ticket ${ctx.unit.attributes.ticketId} escalated (${ctx.unit.attributes.reason}). Take it over and record the resolution.`,
  })
  .exit('resolved');

const escalations = H.lane('escalations', Escalation)
  .store(sqlite.store({ path: 'state/escalations.sqlite' }))
  .handler(escalationFlow, {
    exits: { resolved: EscalationResolved },
    during: { handover: WithHuman },
  });

const auditSchema = z.object({
  category: z.string(),
  rateAtOpen: z.number(),
  samplesAtOpen: z.number(),
});
type AuditAttributes = z.infer<typeof auditSchema>;

const AuditOpen = H.state('AuditOpen', 'pending');
const AuditUnderReview = H.state('AuditUnderReview', 'waiting');
const AuditClosed = H.terminal('AuditClosed', 'success');
const AuditWithdrawn = H.terminal('AuditWithdrawn', 'neutral');

const Audit = H.kind('Audit')
  .attributes(auditSchema)
  .states(AuditOpen, AuditUnderReview, AuditClosed, AuditWithdrawn)
  .key(audit => audit.category)
  .initial(AuditOpen)
  .onCancelled(AuditWithdrawn);

const auditFinding = H.signal('auditFinding').payload(z.object({ finding: z.string() }));

function auditBrief(audit: AuditAttributes, metrics: Metrics): string {
  const openedThisMonth = metrics.total(auditsOpened, { group: audit.category, window: { calendar: 'month' } });
  const pausedThisMonth = metrics.paused({ lane: conversations, window: { calendar: 'month' } });
  return [
    `Approval rate for ${audit.category} fell to ${audit.rateAtOpen.toFixed(2)} over ${audit.samplesAtOpen} samples.`,
    `Audits opened for ${audit.category} this month: ${openedThisMonth.total}.`,
    `Conversations lane paused ${Math.round(pausedThisMonth.totalMs / 60000)} minutes this month across ${pausedThisMonth.count} pauses.`,
    'Review recent drafts in this category and record your finding.',
  ].join('\n');
}

const auditFlow = H.flow('category-audit')
  .input(auditSchema)
  .await('review', auditFinding, { ask: ctx => auditBrief(ctx.unit.attributes, ctx.metrics) })
  .exit('closed');

const audits = H.lane('audits', Audit)
  .store(sqlite.store({ path: 'state/audits.sqlite' }))
  .handler(auditFlow, {
    exits: { closed: AuditClosed },
    during: { review: AuditUnderReview },
  });

const approvalRate = H.metric('approval-rate-by-category')
  .from(H.when.step(conversations, 'approval'))
  .samples(event => {
    const category = event.outputs.classify?.category;
    return event.output && category !== undefined && !event.auto
      ? [{ group: category, hit: event.output.approved }]
      : [];
  });

const approvalRateByModel = H.metric('approval-rate-by-model')
  .from(H.when.step(conversations, 'approval'))
  .samples(event => {
    const model = event.models.draft;
    return event.output && model !== undefined && !event.auto
      ? [{ group: model, hit: event.output.approved }]
      : [];
  });

const modelErrorRate = H.metric('model-error-rate')
  .from(H.when.invocation({ lanes: [conversations] }))
  .samples(event => event.model === undefined ? [] : [{ group: 'conversations', hit: !event.ok }]);

const auditsOpened = H.metric('audits-opened')
  .from(H.when.transition(audits, { if: event => event.cause.by === 'created' }))
  .amounts(event => [{ group: event.unit.attributes.category, amount: 1 }]);

const approvalWatch = H.trigger('approval-watch')
  .on(H.when.crossing(approvalRate, {
    window: { lastDays: 7 },
    minSamples: 50,
    enter: { below: 0.9 },
    exit: { above: 0.95 },
  }))
  .create(audits, event => event.edge === 'entered'
    ? { category: event.group, rateAtOpen: event.value, samplesAtOpen: event.samples }
    : undefined)
  .record(experienceJournal, event => event.edge === 'entered'
    ? {
        body: {
          text: `When drafting for ${event.group}, recall the stricter phrasing, because approvals fell to ${event.value.toFixed(2)}.`,
        },
        when: { kinds: [Conversation], roles: [drafterRole], resources: [`category:${event.group}`] },
        status: 'candidate',
      }
    : undefined)
  .signal(H.cancel, audits, event => event.edge === 'exited'
    ? { key: event.group, payload: { reason: `approval rate recovered to ${event.value.toFixed(2)}` } }
    : undefined);

const modelErrorWatch = H.trigger('model-error-watch')
  .on(H.when.crossing(modelErrorRate, {
    window: { lastHours: 1 },
    minSamples: 20,
    enter: { above: 0.2 },
    exit: { below: 0.05 },
  }))
  .pause(conversations, event => event.edge === 'entered'
    ? `model error rate ${event.value.toFixed(2)} over ${event.samples} invocations`
    : undefined)
  .resume(conversations, event => event.edge === 'exited'
    ? `model error rate recovered to ${event.value.toFixed(2)} over ${event.samples} invocations`
    : undefined);

const slaBreach = H.trigger('sla-breach')
  .on(H.when.timer(conversations, { at: unit => new Date(unit.attributes.slaDueAt) }))
  .signal(slaBreached, conversations, event => ({ key: event.unit.key, payload: {} }));

const escalate = H.trigger('escalate')
  .on(H.when.transition(conversations, { to: Escalated }))
  .create(escalations, event => ({
    ticketId: event.unit.attributes.ticketId,
    reason: event.cause.by === 'signal' ? 'slaBreached' : 'unapproved',
  }));

const reviewerDesk = claudeCode.supervisor('reviewer-desk', {
  grants: [
    H.ops.workRead,
    H.ops.send(approve, { lanes: [conversations] }),
    H.ops.send(extendSla, { lanes: [conversations] }),
    H.ops.send(H.overBudget, { lanes: [conversations] }),
    H.ops.send(escalationResolved, { lanes: [escalations] }),
    H.ops.send(auditFinding, { lanes: [audits] }),
    H.ops.memoryRead,
    H.ops.memoryWrite,
    H.ops.memoryCurate,
    H.ops.telemetryRead,
    H.ops.lanesPause,
  ],
});

export const harness = H.harness('support-self-watch')
  .ledger(sqlite.ledger({ path: 'state/ledger.sqlite' }))
  .pools(supportPool)
  .lanes(conversations, escalations, audits)
  .journals(tasteJournal, experienceJournal)
  .triggers(approvalWatch, modelErrorWatch, slaBreach, escalate)
  .metrics(approvalRate, approvalRateByModel, modelErrorRate, auditsOpened)
  .scheduler(H.scheduler('support')
    .priority(escalations, audits, conversations)
    .rank(conversations, unit => Date.parse(unit.attributes.slaDueAt)))
  .clients(reviewerDesk)
  .observers(markdown.board({ path: 'BOARD.md' }), markdown.telemetry({ path: 'TELEMETRY.md' }));

export const running = harness.start();
