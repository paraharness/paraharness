import { H, MetricRef, Resource, Route, Router } from 'harness-dsl';
import { z } from 'zod';
import { sqlite } from 'harness-dsl/sqlite';
import { jsonl } from 'harness-dsl/jsonl';
import { anthropic } from 'harness-dsl/anthropic';
import { claudeCode } from 'harness-dsl/claude-code';
import { zendesk, ZendeskEvent } from 'harness-dsl/zendesk';
import { local } from 'harness-dsl/local';
import { markdown } from 'harness-dsl/markdown';

const categoryNames = ['refunds', 'billing', 'shipping', 'account', 'other'];
const categorySchema = z.enum(['refunds', 'billing', 'shipping', 'account', 'other']);
const category = H.facet('category');
const categoryResources = new Map(
  categoryNames.map((name): [string, Resource] => [name, H.resource(`support-category-${name}`)]),
);
const resourcesFor = (name: string): readonly Resource[] => {
  const resource = categoryResources.get(name);
  return resource === undefined ? [] : [resource];
};

const apiAccount = anthropic.account('support-api', {
  apiKey: H.env('ANTHROPIC_API_KEY'),
  quota: sqlite.quota('support-api', { path: './.harness/quota.sqlite' }),
});
const supportPool = H.pool('support-pool').accounts(apiAccount);
const haiku = anthropic.model('haiku', { id: 'claude-haiku-4-5' });
const opus = anthropic.model('opus', { id: 'claude-opus-4-1' });

const classifierRole = H.role('classifier').intents('read');
const drafterRole = H.role('drafter').intents('read');
const reviewerRole = H.role('reviewer').intents('record');

const taste = H.journal('support-taste', H.memory('support-taste', 'taste'))
  .store(jsonl.memoryStore({ path: './.harness/taste.jsonl' }))
  .recall({ by: 'specificity', limit: 10 })
  .readBy(drafterRole)
  .recordedBy(reviewerRole);

const experience = H.journal('support-experience', H.memory('support-experience', 'experience'))
  .store(jsonl.memoryStore({ path: './.harness/experience.jsonl' }))
  .recall({ by: 'specificity', limit: 10 })
  .readBy(drafterRole);

const classifier = H.seat('classifier')
  .role(classifierRole)
  .model(haiku)
  .pool(supportPool)
  .output(z.object({ category: categorySchema }));

const drafter = H.seat('drafter').role(drafterRole).model(opus).pool(supportPool);

const approval = H.halt('reply-approval').decision(z.object({ approved: z.boolean(), reply: z.string() }));
const costCeiling = H.halt('cost-ceiling').decision(
  z.discriminatedUnion('action', [
    z.object({ action: z.literal('raise'), maxUsd: z.number() }),
    z.object({ action: z.literal('fail') }),
  ]),
);
const escalationHandled = H.halt('escalation-handled').decision(z.object({ resolution: z.string() }));
const auditReviewed = H.halt('audit-reviewed').decision(z.object({ findings: z.string() }));

const safeCategoryAutoApproves = H.policy.halt(
  'safe-category-auto-approves',
  approval,
  z.object({ category: z.string(), draft: z.string() }),
  ctx => {
    const record = ctx.metrics.rate(approvalRate, { by: { facets: [category.of(ctx.input.category)] } });
    return record.samples >= 200 && record.hits === record.samples ? { approved: true, reply: ctx.input.draft } : undefined;
  },
);

const sendReply = H.command('send-reply')
  .input(z.object({ ticketId: z.string(), reply: z.string() }))
  .argv(i => ['./support/send-reply', i.ticketId, i.reply])
  .runner(local.runner('local'));

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
type ConversationAttrs = z.infer<typeof conversationAttrs>;
type ConversationState = typeof New | typeof Sent | typeof ClosedByCustomer | typeof Escalated;

const Conversation = H.kind('Conversation')
  .attributes(conversationAttrs)
  .states(New, Sent, ClosedByCustomer, Escalated)
  .key(a => a.ticketId)
  .initial(New);

const customerReplied = H.signal('customer-replied').payload(z.object({ message: z.string() }));
const customerFollowedUp = H.signal('customer-followed-up').payload(z.object({ message: z.string() }));
const customerClosed = H.signal('customer-closed');
const slaExtended = H.signal('sla-extended').payload(z.object({ deadline: z.string() }));
const slaBreached = H.signal('sla-breached');

const slaHours = { low: 48, normal: 24, high: 8, urgent: 2 };

const routeHelpdesk = (e: ZendeskEvent, to: Router<ConversationAttrs, ConversationState>): Route | readonly Route[] => {
  if (e.type === 'created') {
    return to.create({
      ticketId: e.ticketId,
      subject: e.subject,
      message: e.message,
      customerEmail: e.customerEmail,
      slaDeadline: new Date(e.createdAt.getTime() + slaHours[e.priority] * 3_600_000).toISOString(),
    });
  }
  if (e.status === 'closed' || e.status === 'solved') {
    return to.signal(customerClosed, e.ticketId, {});
  }
  if (e.type === 'replied') {
    return [
      to.signal(customerReplied, { key: e.ticketId, in: New }, { message: e.message }),
      to.signal(customerFollowedUp, { key: e.ticketId, in: Sent }, { message: e.message }),
    ];
  }
  return to.skip();
};

const handleConversation = H.flow('handle-conversation')
  .input(conversationAttrs)
  .step('classify', classifier, ctx => ({ task: `Classify:\n${ctx.unit.attributes.subject}\n${ctx.unit.attributes.message}` }))
  .step('draft', drafter, ctx => ({
    task: `Draft a reply about ${ctx.steps.classify.category} to:\n${ctx.unit.attributes.message}`,
    resources: resourcesFor(ctx.steps.classify.category),
  }))
  .halt('approval', approval, {
    ask: ctx => `Approve the reply to ${ctx.unit.attributes.customerEmail}:\n\n${ctx.steps.draft}`,
    policy: {
      by: safeCategoryAutoApproves,
      input: ctx => ({ category: ctx.steps.classify.category, draft: ctx.steps.draft }),
    },
  })
  .exit('rejected', ctx => !ctx.steps.approval.approved)
  .step('send', sendReply, ctx => ({ ticketId: ctx.unit.attributes.ticketId, reply: ctx.steps.approval.reply }), {
    afterCrash: 'park',
  })
  .exit('sent');

const helpdeskToken = H.env('ZENDESK_TOKEN');

const conversations = H.lane('conversations', Conversation)
  .supply(zendesk.webhook({ port: H.slot.port(1), path: '/helpdesk', secret: H.env('ZENDESK_WEBHOOK_SECRET') }), routeHelpdesk)
  .supply(zendesk.poll({ subdomain: 'acme', token: helpdeskToken, everyMinutes: 10 }), routeHelpdesk)
  .store(zendesk.store({ subdomain: 'acme', token: helpdeskToken }))
  .handler(handleConversation, {
    ends: { rejected: Escalated },
    rests: { sent: Sent },
    retry: { maxAttempts: 3, backoff: 'exponential', initialDelayMs: 30_000, exhausted: Escalated },
    ceiling: { maxUsd: 0.4, onExceed: costCeiling },
  })
  .on(customerReplied, {
    update: (a, p) => ({ ...a, message: p.message }),
    restart: { to: 'classify', at: ['approval'] },
  })
  .on(customerFollowedUp, { update: (a, p) => ({ ...a, message: p.message }), enter: New })
  .on(customerClosed, { enter: ClosedByCustomer })
  .on(slaExtended, { update: (a, p) => ({ ...a, slaDeadline: p.deadline }) })
  .on(slaBreached, { enter: Escalated });

const approvalRate: MetricRef<'rate'> = H.metric('approval-rate', H.when.decision(conversations, approval))
  .facets(category)
  .samples(e => {
    const classified = e.outputs.classify;
    return e.resolvedBy !== 'human' || classified === undefined
      ? []
      : [{ hit: e.decision.approved, by: { facets: [category.of(classified.category)], model: e.invocations.draft?.model } }];
  });

const EscalationOpen = H.state('EscalationOpen', 'pending');
const EscalationResolved = H.terminal('EscalationResolved', 'success');
const EscalationFailed = H.terminal('EscalationFailed', 'failure');
const escalationAttrs = z.object({ ticketId: z.string(), reason: z.string() });

const Escalation = H.kind('Escalation')
  .attributes(escalationAttrs)
  .states(EscalationOpen, EscalationResolved, EscalationFailed)
  .key(a => a.ticketId)
  .initial(EscalationOpen);

const handleEscalation = H.flow('handle-escalation')
  .input(escalationAttrs)
  .halt('handle', escalationHandled, { ask: ctx => `Ticket ${ctx.unit.attributes.ticketId} escalated: ${ctx.unit.attributes.reason}` })
  .exit('resolved');

const escalations = H.lane('escalations', Escalation)
  .store(sqlite.store({ path: './.harness/units.sqlite' }))
  .handler(handleEscalation, {
    ends: { resolved: EscalationResolved },
    retry: { maxAttempts: 1, backoff: 'fixed', initialDelayMs: 0, exhausted: EscalationFailed },
  });

const AuditOpen = H.state('AuditOpen', 'pending');
const AuditClosed = H.terminal('AuditClosed', 'success');
const AuditCancelled = H.terminal('AuditCancelled', 'neutral');
const AuditAbandoned = H.terminal('AuditAbandoned', 'failure');
const auditAttrs = z.object({ category: z.string(), rate: z.number(), samples: z.number() });

const Audit = H.kind('Audit')
  .attributes(auditAttrs)
  .states(AuditOpen, AuditClosed, AuditCancelled, AuditAbandoned)
  .key(a => a.category)
  .initial(AuditOpen);

const reviewCategory = H.flow('review-category')
  .input(auditAttrs)
  .halt('review', auditReviewed, {
    ask: ctx =>
      `Approvals for ${ctx.unit.attributes.category} fell to ${ctx.unit.attributes.rate.toFixed(2)} over ${ctx.unit.attributes.samples} samples. Review the drafts.`,
  })
  .exit('closed');

const audits = H.lane('audits', Audit)
  .store(sqlite.store({ path: './.harness/units.sqlite' }))
  .handler(reviewCategory, {
    ends: { closed: AuditClosed },
    retry: { maxAttempts: 1, backoff: 'fixed', initialDelayMs: 0, exhausted: AuditAbandoned },
  })
  .on(H.cancel, { enter: AuditCancelled });

const slaBreach = H.trigger('sla-breach')
  .on(H.when.timer(conversations, { at: unit => new Date(unit.attributes.slaDeadline) }))
  .create(escalations, e => ({ ticketId: e.unit.attributes.ticketId, reason: `SLA breached at ${e.at.toISOString()}` }))
  .signal(slaBreached, conversations, e => ({ key: e.unit.key, payload: {} }));

const reviewerEditsBecomeTaste = H.trigger('reviewer-edits-become-taste')
  .on(H.when.decision(conversations, approval))
  .record(taste, e => {
    const drafted = e.outputs.draft;
    return e.resolvedBy === 'human' && drafted !== undefined && drafted !== e.decision.reply
      ? { text: `When replying, write like "${e.decision.reply}" rather than "${drafted}", because the reviewer edited it so.`, status: 'candidate' }
      : undefined;
  });

const approvalBand = { window: { lastDays: 7 }, minSamples: 50, enter: { below: 0.9 }, exit: { above: 0.95 } };

const approvalsFell = H.trigger('approvals-fell')
  .on(H.when.crossing(approvalRate, approvalBand, 'entered'))
  .create(audits, e => {
    const name = category.read(e.by);
    return name === undefined ? undefined : { category: name, rate: e.value, samples: e.samples };
  })
  .record(experience, e => {
    const name = category.read(e.by);
    return name === undefined
      ? undefined
      : {
          text: `When drafting for ${name}, recall the stricter phrasing, because approvals fell to ${e.value.toFixed(2)}.`,
          when: { roles: [drafterRole], kinds: [Conversation], resources: resourcesFor(name) },
          status: 'candidate',
        };
  });

const approvalsRecovered = H.trigger('approvals-recovered')
  .on(H.when.crossing(approvalRate, approvalBand, 'exited'))
  .signal(H.cancel, audits, e => {
    const name = category.read(e.by);
    return name === undefined ? undefined : { key: name, payload: { reason: `approval rate recovered to ${e.value.toFixed(2)}` } };
  });

const modelErrorRate = H.metric('model-error-rate', H.when.invocation({ lanes: [conversations] })).samples(e => [{ hit: !e.ok }]);

const errorBand = { window: { lastHours: 1 }, minSamples: 20, enter: { above: 0.2 }, exit: { below: 0.05 } };

const pauseOnModelErrors = H.trigger('pause-on-model-errors')
  .on(H.when.crossing(modelErrorRate, errorBand, 'entered'))
  .pause(conversations, e => `model error rate ${e.value.toFixed(3)} over ${e.samples} invocations`);

const resumeOnModelRecovery = H.trigger('resume-on-model-recovery')
  .on(H.when.crossing(modelErrorRate, errorBand, 'exited'))
  .resume(conversations, e => `model error rate ${e.value.toFixed(3)} over ${e.samples} invocations`);

const auditsOpened = H.metric('audits-opened', H.when.transition(audits, { to: AuditOpen }))
  .facets(category)
  .amounts(e => [{ amount: 1, by: { facets: [category.of(e.unit.attributes.category)] } }]);

const scheduler = H.scheduler('support-scheduler')
  .priority(conversations, escalations, audits)
  .rank(conversations, unit => new Date(unit.attributes.slaDeadline).getTime())
  .admit(audits, ctx => {
    const openedThisMonth = ctx.metrics.total(auditsOpened, {
      by: { facets: [category.of(ctx.unit.attributes.category)] },
      window: { calendar: 'month' },
    });
    const pausedThisMonth = ctx.metrics.paused({ lane: conversations, window: { calendar: 'month' } });
    return openedThisMonth.total <= 3 || pausedThisMonth.totalMs > 3_600_000;
  });

const reviewer = claudeCode.supervisor('support-reviewer').client('reviewer-control', {
  port: H.slot.port(2),
  grants: [
    H.ops.workRead,
    H.ops.workSignal,
    H.ops.resolve(approval),
    H.ops.resolve(costCeiling),
    H.ops.resolve(escalationHandled),
    H.ops.resolve(auditReviewed),
    H.ops.memoryWrite,
    H.ops.memoryCurate,
    H.ops.lanesPause,
    H.ops.telemetryRead,
  ],
});

export const harness = H.harness('support-self-watch')
  .ledger(sqlite.ledger({ path: './.harness/ledger.sqlite' }))
  .lanes(conversations, escalations, audits)
  .journals(taste, experience)
  .triggers(slaBreach, reviewerEditsBecomeTaste, approvalsFell, approvalsRecovered, pauseOnModelErrors, resumeOnModelRecovery)
  .metrics(approvalRate, modelErrorRate, auditsOpened)
  .scheduler(scheduler)
  .clients(reviewer)
  .observers(markdown.board({ path: './.harness/board.md' }), markdown.telemetry({ path: './.harness/telemetry.md' }));
