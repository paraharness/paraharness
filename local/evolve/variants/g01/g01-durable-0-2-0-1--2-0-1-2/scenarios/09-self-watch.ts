import { z } from 'zod';
import { H, Resource, Router, Route } from 'harness-dsl';
import { sqlite } from 'harness-dsl/sqlite';
import { jsonl } from 'harness-dsl/jsonl';
import { anthropic } from 'harness-dsl/anthropic';
import { claudeCode } from 'harness-dsl/claude-code';
import { zendesk, ZendeskEvent } from 'harness-dsl/zendesk';
import { local } from 'harness-dsl/local';
import { markdown } from 'harness-dsl/markdown';

const quota = sqlite.quota('support-quota', { path: './.harness/quota.sqlite' });
const apiAccount = anthropic.account('api', { apiKey: H.env('ANTHROPIC_API_KEY'), quota });
const haiku = anthropic.model('haiku', { id: 'claude-haiku-4-5' });
const sonnet = anthropic.model('sonnet', { id: 'claude-sonnet-4-5' });
const pool = H.pool('support-pool').accounts(apiAccount);

const runner = local.runner('local').slots(4);

const categories = ['billing', 'shipping', 'refunds', 'account'] as const satisfies readonly string[];
const category = H.facet('category');
const categoryResources = new Map<string, Resource>(categories.map((name): [string, Resource] => [name, H.resource(`category-${name}`)]));
function resourcesFor(name: string): Resource[] {
  const found = categoryResources.get(name);
  return found === undefined ? [] : [found];
}

const tasteKind = H.memory('taste', 'taste');
const experienceKind = H.memory('experience', 'experience');

const classifierRole = H.role('classifier').intents('read').instructions('Classify the conversation into exactly one category.');
const drafterRole = H.role('drafter').intents('read').instructions('Draft the reply in the house tone, citing policy where it applies.');
const reviewerRole = H.role('reviewer').intents('read', 'record').instructions('Approve, edit or reject the drafted reply.');

const tasteJournal = H.journal('support-taste', tasteKind)
  .store(jsonl.memoryStore({ path: './.harness/taste.jsonl' }))
  .recall({ by: 'specificity', limit: 10 })
  .readBy(drafterRole)
  .recordedBy(reviewerRole);

const experienceJournal = H.journal('support-experience', experienceKind)
  .store(jsonl.memoryStore({ path: './.harness/experience.jsonl' }))
  .recall({ by: 'specificity', limit: 10 })
  .readBy(drafterRole)
  .recordedBy(reviewerRole);

const conversationAttrs = z.object({
  ticketId: z.string(),
  subject: z.string(),
  customerEmail: z.string(),
  lastMessage: z.string(),
  priority: z.enum(['low', 'normal', 'high', 'urgent']),
  slaDeadline: z.string(),
});
type ConversationAttrs = z.infer<typeof conversationAttrs>;

const fresh = H.state('New', 'pending');
const sent = H.terminal('Sent', 'success');
const closedByCustomer = H.terminal('ClosedByCustomer', 'neutral');
const escalated = H.terminal('Escalated', 'failure');

const conversation = H.kind('Conversation')
  .attributes(conversationAttrs)
  .states(fresh, sent, closedByCustomer, escalated)
  .key(a => a.ticketId)
  .initial(fresh);

const customerReplied = H.signal('customer-replied').payload(z.object({ message: z.string() }));
const customerClosed = H.signal('customer-closed');
const escalate = H.signal('escalate');

const approval = H.halt('reply-approval').decision(z.object({ approved: z.boolean(), edited: z.string().optional() }));
const costHalt = H.halt('cost-ceiling').decision(H.ceilingDecision);

const approvalRate = H.metric('approval', H.when.decision(conversation, approval)).samples(event =>
  event.resolvedBy !== 'human'
    ? []
    : event.seats.map(assignment => ({
        hit: event.decision.approved,
        facets: event.facets,
        seat: assignment.seat,
        model: assignment.model,
      })));

const safeCategory = H.policy.halt('safe-category-skips-approval', conversation, approval).decide(ctx => {
  const record = ctx.metrics.rate(approvalRate, { facets: ctx.facets });
  return record.samples >= 200 && record.hits === record.samples ? { approved: true } : undefined;
});

const classifierSeat = H.seat('classifier')
  .role(classifierRole)
  .model(haiku)
  .pool(pool)
  .output(z.object({ category: z.enum(categories) }));

const drafterSeat = H.seat('drafter')
  .role(drafterRole)
  .model(sonnet)
  .pool(pool)
  .output(z.object({ reply: z.string() }));

const sendReply = H.command('send-reply')
  .input(z.object({ ticketId: z.string(), body: z.string() }))
  .argv(input => ['helpdesk', 'reply', input.ticketId, input.body])
  .runner(runner);

const replyFlow = H.flow('reply')
  .input(conversationAttrs)
  .step('classify', classifierSeat, ctx => ({ task: `Classify: ${ctx.unit.attributes.subject}\n\n${ctx.unit.attributes.lastMessage}` }))
  .step('draft', drafterSeat, ctx => ({
    task: `Reply to: ${ctx.unit.attributes.lastMessage}`,
    resources: resourcesFor(ctx.steps.classify.category),
  }))
  .halt('approval', approval, {
    ask: ctx => ctx.steps.draft.reply,
    skip: safeCategory,
    facets: ctx => [category.of(ctx.steps.classify.category)],
  })
  .exit('rejected', ctx => !ctx.steps.approval.approved)
  .step('send', sendReply, ctx => ({
    ticketId: ctx.unit.attributes.ticketId,
    body: ctx.steps.approval.edited ?? ctx.steps.draft.reply,
  }), { afterCrash: 'park' })
  .exit('sent');

const slaHours = { low: 48, normal: 24, high: 8, urgent: 2 };

function routeTicket(event: ZendeskEvent, to: Router<ConversationAttrs>): Route {
  if (event.status === 'solved' || event.status === 'closed') return to.signal(customerClosed, event.ticketId, {});
  if (event.type === 'created') {
    return to.create({
      ticketId: event.ticketId,
      subject: event.subject,
      customerEmail: event.customerEmail,
      lastMessage: event.message,
      priority: event.priority,
      slaDeadline: new Date(event.createdAt.getTime() + slaHours[event.priority] * 3600000).toISOString(),
    });
  }
  if (event.type === 'replied') return to.signal(customerReplied, event.ticketId, { message: event.message });
  return to.skip();
}

const helpdeskToken = H.env('ZENDESK_TOKEN');

const conversations = H.lane('conversations', conversation)
  .supply(zendesk.webhook({ port: H.slot.port(3), path: '/helpdesk', secret: H.env('ZENDESK_WEBHOOK_SECRET') }), routeTicket)
  .supply(zendesk.poll({ subdomain: 'acme', token: helpdeskToken, everyMinutes: 10 }), routeTicket)
  .handler(replyFlow, { exits: { rejected: escalated, sent } })
  .store(zendesk.store({ subdomain: 'acme', token: helpdeskToken }))
  .retry({ maxAttempts: 3, backoff: 'exponential', initialDelayMs: 30000, exhausted: escalated })
  .ceiling({ maxUsd: 0.4, onExceed: costHalt })
  .on(customerReplied, {
    update: (attrs, reply) => ({ ...attrs, lastMessage: reply.message }),
    restart: 'classify',
    at: ['approval'],
  })
  .on(customerClosed, { enter: closedByCustomer })
  .on(escalate, { enter: escalated });

const escalationOpen = H.state('Open', 'pending');
const escalationResolved = H.terminal('Resolved', 'success');
const escalationDropped = H.terminal('Dropped', 'neutral');

const escalationAttrs = z.object({ ticketId: z.string(), reason: z.string() });

const escalation = H.kind('Escalation')
  .attributes(escalationAttrs)
  .states(escalationOpen, escalationResolved, escalationDropped)
  .key(a => a.ticketId)
  .initial(escalationOpen);

const escalationHandled = H.halt('escalation-handled').decision(z.object({ resolution: z.string() }));

const handleEscalation = H.flow('handle-escalation')
  .input(escalationAttrs)
  .halt('handled', escalationHandled, { ask: ctx => `Ticket ${ctx.unit.attributes.ticketId}: ${ctx.unit.attributes.reason}` })
  .exit('resolved');

const escalations = H.lane('escalations', escalation)
  .handler(handleEscalation, { exits: { resolved: escalationResolved } })
  .retry({ maxAttempts: 1, exhausted: escalationDropped })
  .on(H.cancel, { enter: escalationDropped });

const slaBreach = H.trigger('sla-breach')
  .on(H.when.timer(conversations, {
    at: unit => (unit.position === 'terminal' ? undefined : new Date(unit.attributes.slaDeadline)),
  }))
  .create(escalations, event => ({ ticketId: event.unit.attributes.ticketId, reason: `SLA breached at ${event.at.toISOString()}` }))
  .signal(escalate, conversations, event => ({ key: event.unit.key, payload: {} }));

const auditOpen = H.state('Open', 'pending');
const auditClosed = H.terminal('Closed', 'success');
const auditWithdrawn = H.terminal('Withdrawn', 'neutral');

const auditAttrs = z.object({ category: z.string(), rate: z.number(), samples: z.number() });

const audit = H.kind('Audit')
  .attributes(auditAttrs)
  .states(auditOpen, auditClosed, auditWithdrawn)
  .key(a => a.category)
  .initial(auditOpen);

const auditFindings = H.halt('audit-findings').decision(z.object({ findings: z.string() }));

const runAudit = H.flow('run-audit')
  .input(auditAttrs)
  .halt('findings', auditFindings, {
    ask: ctx => `Approvals for ${ctx.unit.attributes.category} fell to ${ctx.unit.attributes.rate.toFixed(2)} over ${ctx.unit.attributes.samples} samples. What went wrong?`,
  })
  .exit('closed');

const audits = H.lane('audits', audit)
  .handler(runAudit, { exits: { closed: auditClosed } })
  .retry({ maxAttempts: 1, exhausted: auditWithdrawn })
  .on(H.cancel, { enter: auditWithdrawn });

const approvalBand = {
  window: { lastDays: 7 },
  minSamples: 50,
  enter: { below: 0.9 },
  exit: { above: 0.95 },
  per: category,
};

const approvalFell = H.trigger('approval-fell')
  .on(H.when.crossing(approvalRate, approvalBand, 'entered'))
  .create(audits, event => (event.value === undefined ? undefined : { category: event.value, rate: event.rate, samples: event.samples }))
  .record(experienceJournal, event =>
    event.value === undefined
      ? undefined
      : {
          text: `When drafting for ${event.value}, recall the stricter phrasing, because approvals fell to ${event.rate.toFixed(2)}.`,
          when: { kinds: [conversation], roles: [drafterRole], resources: resourcesFor(event.value) },
          status: 'candidate',
        });

const approvalRecovered = H.trigger('approval-recovered')
  .on(H.when.crossing(approvalRate, approvalBand, 'exited'))
  .signal(H.cancel, audits, event =>
    event.value === undefined
      ? undefined
      : { key: event.value, payload: { reason: `Approvals for ${event.value} recovered to ${event.rate.toFixed(2)}` } });

const modelErrors = H.metric('model-errors', H.when.invocation({ lanes: [conversations] })).samples(event => [
  { hit: !event.ok, seat: event.seat, model: event.model },
]);

const errorBand = {
  window: { lastHours: 1 },
  minSamples: 20,
  enter: { above: 0.2 },
  exit: { below: 0.05 },
};

const pauseOnErrors = H.trigger('pause-on-model-errors')
  .on(H.when.crossing(modelErrors, errorBand, 'entered'))
  .pause(conversations, event => `Model error rate ${event.rate.toFixed(3)} over ${event.samples} invocations in the last hour`);

const resumeOnRecovery = H.trigger('resume-on-model-recovery')
  .on(H.when.crossing(modelErrors, errorBand, 'exited'))
  .resume(conversations, event => `Model error rate recovered to ${event.rate.toFixed(3)} over ${event.samples} invocations`);

const auditsOpened = H.metric('audits-opened', H.when.transition(audits, { to: auditOpen })).amounts(event => [
  { amount: 1, facets: [category.of(event.unit.attributes.category)] },
]);

const reviewer = claudeCode.supervisor('reviewer', {
  port: H.slot.port(1),
  grants: [
    H.ops.workRead,
    H.ops.workUpdate,
    H.ops.lanesPause,
    H.ops.resolve(approval, costHalt, escalationHandled, auditFindings),
    H.ops.memoryWrite,
    H.ops.memoryCurate,
    H.ops.telemetryRead,
  ],
});

export const harness = H.harness('support')
  .ledger(sqlite.ledger({ path: './.harness/ledger.sqlite' }))
  .lanes(conversations, escalations, audits)
  .journals(tasteJournal, experienceJournal)
  .triggers(slaBreach, approvalFell, approvalRecovered, pauseOnErrors, resumeOnRecovery)
  .metrics(approvalRate, modelErrors, auditsOpened)
  .scheduler(
    H.scheduler('support-scheduler')
      .fixedDate(conversations, unit => new Date(unit.attributes.slaDeadline))
      .standard(escalations, audits)
      .wip(conversations, 6)
      .admit(audits, ctx =>
        ctx.metrics.total(auditsOpened, {
          facets: [category.of(ctx.unit.attributes.category)],
          window: { calendar: 'month' },
        }).total <= 6)
      .admit(conversations, ctx =>
        ctx.unit.attributes.priority === 'urgent' ||
        ctx.metrics.paused({ lane: conversations, window: { calendar: 'week' } }).totalMs < 4 * 3600000),
  )
  .clients(reviewer)
  .observers(
    markdown.board({ path: './.harness/board.md' }),
    markdown.telemetry({ path: './.harness/telemetry.md' }),
  );
