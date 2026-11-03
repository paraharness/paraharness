import { z } from 'zod';
import { H, FacetValue, Router, Route } from 'harness-dsl';
import { anthropic } from 'harness-dsl/anthropic';
import { claudeCode } from 'harness-dsl/claude-code';
import { sqlite } from 'harness-dsl/sqlite';
import { jsonl } from 'harness-dsl/jsonl';
import { zendesk, ZendeskEvent } from 'harness-dsl/zendesk';
import { local } from 'harness-dsl/local';
import { markdown } from 'harness-dsl/markdown';

const apiAccount = anthropic.account('anthropic-api', { apiKey: H.env('ANTHROPIC_API_KEY') });
const haiku = anthropic.model('haiku', { id: 'claude-haiku-4-5' });
const sonnet = anthropic.model('sonnet', { id: 'claude-sonnet-4-5' });
const pool = H.pool('api').accounts(apiAccount);
const ops = local.runner('ops').slots(4);
const zendeskToken = H.env('ZENDESK_TOKEN');

const category = H.facet('category');
const categoryNames: readonly string[] = ['billing', 'shipping', 'account', 'technical'];
const categoryOf = (scope: readonly FacetValue[]) => scope.find(v => v.facet === category.name)?.value;

const classifierRole = H.role('classifier').intents('read').instructions('Classify the conversation into one category.');
const drafterRole = H.role('drafter').intents('read').instructions('Draft a reply the customer can act on.');
const reviewerRole = H.role('reviewer').intents('read', 'record').instructions('Approve or edit outgoing replies.');

const taste = H.memory('support-taste', 'taste');
const tasteJournal = H.journal('support-taste', taste)
  .store(jsonl.memoryStore({ path: '.harness/taste.jsonl' }))
  .recall({ by: 'specificity', limit: 10 })
  .readBy(drafterRole)
  .recordedBy(reviewerRole);

const experience = H.memory('support-experience', 'experience');
const experienceJournal = H.journal('support-experience', experience)
  .store(jsonl.memoryStore({ path: '.harness/experience.jsonl' }))
  .recall({ by: 'specificity', limit: 10 })
  .readBy(drafterRole)
  .recordedBy(reviewerRole);

const classifier = H.seat('classifier')
  .role(classifierRole)
  .model(haiku)
  .pool(pool)
  .output(z.object({ category: z.enum(['billing', 'shipping', 'account', 'technical']) }));

const drafter = H.seat('drafter')
  .role(drafterRole)
  .model(sonnet)
  .pool(pool)
  .output(z.object({ reply: z.string() }));

const conversationAttributes = z.object({
  ticketId: z.string(),
  subject: z.string(),
  message: z.string(),
  customerEmail: z.string(),
  slaDueAt: z.string(),
});
type ConversationAttributes = z.infer<typeof conversationAttributes>;

const fresh = H.state('new', 'pending');
const classifying = H.state('classifying', 'active');
const draftingReply = H.state('drafting', 'active');
const awaitingApproval = H.state('awaitingApproval', 'waiting');
const sending = H.state('sending', 'active');
const sent = H.terminal('sent', 'success');
const closedByCustomer = H.terminal('closedByCustomer', 'neutral');
const escalated = H.terminal('escalated', 'failure');

const conversationKind = H.kind('Conversation')
  .attributes(conversationAttributes)
  .states(fresh, classifying, draftingReply, awaitingApproval, sending, sent, closedByCustomer, escalated)
  .key(a => a.ticketId)
  .initial(fresh);

const approval = H.halt('approval').decision(z.object({ approved: z.boolean(), reply: z.string() }));

const approvalRate = H.metric('approval-rate', H.when.decision(conversationKind, approval))
  .facets(category)
  .samples(e => {
    const value = categoryOf(e.scope);
    return e.resolvedBy === 'human' && value !== undefined ? [{ hit: e.decision.approved, facets: { category: value } }] : [];
  });

const approvalByModel = H.metric('approval-by-model', H.when.decision(conversationKind, approval))
  .facets(category)
  .samples(e => {
    const value = categoryOf(e.scope);
    return e.resolvedBy === 'human' && value !== undefined
      ? e.seats.filter(s => s.seat.name === drafter.name).map(s => ({ hit: e.decision.approved, seat: s.seat, model: s.model, facets: { category: value } }))
      : [];
  });

const safeCategory = H.policy.halt('safe-category', conversationKind, approval, ctx => {
  const value = categoryOf(ctx.scope);
  if (value === undefined) return undefined;
  const read = ctx.metrics.rate(approvalRate, { facets: { category: value } });
  return read.samples >= 200 && read.hits === read.samples ? { approved: true, reply: '' } : undefined;
});

const sendReply = H.command('send-reply')
  .input(z.object({ ticketId: z.string(), reply: z.string() }))
  .argv(i => ['helpdesk-reply', i.ticketId, i.reply])
  .runner(ops);

const triage = H.flow('triage')
  .input(conversationAttributes)
  .step('classify', classifier, ctx => ({ task: `${ctx.unit.attributes.subject}\n\n${ctx.unit.attributes.message}` }))
  .step('draft', drafter, ctx => ({
    task: `Reply to: ${ctx.unit.attributes.message}`,
    facets: [category.is(ctx.steps.classify.category)],
  }))
  .halt('approval', approval, {
    ask: ctx => `Approve this ${ctx.steps.classify.category} reply?\n\n${ctx.steps.draft.reply}`,
    scope: ctx => [category.is(ctx.steps.classify.category)],
    skip: safeCategory,
  })
  .exit('rejected', ctx => !ctx.steps.approval.approved)
  .step('send', sendReply, ctx => ({
    ticketId: ctx.unit.attributes.ticketId,
    reply: ctx.steps.approval.reply.length > 0 ? ctx.steps.approval.reply : ctx.steps.draft.reply,
  }), { afterCrash: 'park' })
  .exit('delivered');

const customerReplied = H.signal('customerReplied').payload(z.object({ message: z.string() }));
const customerClosed = H.signal('customerClosed');
const breached = H.signal('breached');

const slaHours = (priority: ZendeskEvent['priority']) => (priority === 'urgent' ? 1 : priority === 'high' ? 4 : 24);

const routeTicket = (e: ZendeskEvent, to: Router<ConversationAttributes>): Route =>
  e.type === 'created'
    ? to.create({
        ticketId: e.ticketId,
        subject: e.subject,
        message: e.message,
        customerEmail: e.customerEmail,
        slaDueAt: new Date(e.createdAt.getTime() + slaHours(e.priority) * 3600000).toISOString(),
      })
    : e.status === 'closed' || e.status === 'solved'
      ? to.signal(customerClosed, e.ticketId, {})
      : e.type === 'replied'
        ? to.signal(customerReplied, e.ticketId, { message: e.message })
        : to.skip();

const conversations = H.lane('conversations', conversationKind)
  .supply(zendesk.webhook({ port: H.slot.port(1), path: '/zendesk', secret: H.env('ZENDESK_WEBHOOK_SECRET') }), routeTicket)
  .supply(zendesk.poll({ subdomain: 'acme', token: zendeskToken, everyMinutes: 10 }), routeTicket)
  .store(zendesk.store({ subdomain: 'acme', token: zendeskToken }))
  .handler(triage, {
    exits: { rejected: escalated, delivered: sent },
    during: { classify: classifying, draft: draftingReply, approval: awaitingApproval, send: sending },
  })
  .retry({ maxAttempts: 3, backoff: 'exponential', initialDelayMs: 30000, exhausted: escalated })
  .ceiling({ maxUsd: 0.4, onExceed: 'halt' })
  .on(customerReplied, { update: (a, p) => ({ ...a, message: p.message }), restart: { to: 'classify', at: ['approval'] } })
  .on(customerClosed, { enter: closedByCustomer })
  .on(breached, { enter: escalated });

const escalationAttributes = z.object({ ticketId: z.string(), subject: z.string(), breachedAt: z.string() });
const escalationQueued = H.state('queued', 'pending');
const withHuman = H.state('withHuman', 'waiting');
const handled = H.terminal('handled', 'success');
const droppedEscalation = H.terminal('dropped', 'neutral');
const unhandled = H.terminal('unhandled', 'failure');

const escalationKind = H.kind('Escalation')
  .attributes(escalationAttributes)
  .states(escalationQueued, withHuman, handled, droppedEscalation, unhandled)
  .key(a => a.ticketId)
  .initial(escalationQueued);

const escalationReview = H.halt('escalation').decision(z.object({ resolution: z.string() }));

const escalationFlow = H.flow('escalation')
  .input(escalationAttributes)
  .halt('handle', escalationReview, { ask: ctx => `SLA breached on ${ctx.unit.attributes.ticketId}: ${ctx.unit.attributes.subject}` })
  .exit('handled');

const escalations = H.lane('escalations', escalationKind)
  .store(sqlite.store({ path: '.harness/units.sqlite' }))
  .handler(escalationFlow, { exits: { handled }, during: { handle: withHuman }, cancelled: droppedEscalation })
  .retry({ maxAttempts: 1, exhausted: unhandled });

const auditAttributes = z.object({ category: z.string(), rate: z.number(), samples: z.number() });
const auditOpen = H.state('open', 'pending');
const underReview = H.state('underReview', 'waiting');
const concluded = H.terminal('concluded', 'success');
const withdrawn = H.terminal('withdrawn', 'neutral');
const abandoned = H.terminal('abandoned', 'failure');

const auditKind = H.kind('Audit')
  .attributes(auditAttributes)
  .states(auditOpen, underReview, concluded, withdrawn, abandoned)
  .key(a => a.category)
  .initial(auditOpen);

const auditReview = H.halt('audit').decision(z.object({ findings: z.string() }));

const auditFlow = H.flow('audit')
  .input(auditAttributes)
  .halt('review', auditReview, {
    ask: ctx => `Approval rate for ${ctx.unit.attributes.category} fell to ${ctx.unit.attributes.rate} over ${ctx.unit.attributes.samples} samples. What went wrong?`,
  })
  .exit('concluded');

const audits = H.lane('audits', auditKind)
  .store(sqlite.store({ path: '.harness/units.sqlite' }))
  .handler(auditFlow, { exits: { concluded }, during: { review: underReview }, cancelled: withdrawn })
  .retry({ maxAttempts: 1, exhausted: abandoned });

const auditsOpened = H.metric('audits-opened', H.when.transition(audits, { to: auditOpen }))
  .facets(category)
  .amounts(e => [{ amount: 1, facets: { category: e.unit.attributes.category } }]);

const modelErrors = H.metric('model-errors', H.when.invocation({ lanes: [conversations] }))
  .samples(e => (e.model === undefined ? [] : [{ hit: !e.ok }]));

const approvalBand = { window: { lastDays: 7 }, minSamples: 50, enter: { below: 0.9 }, exit: { above: 0.95 } };
const errorBand = { window: { lastHours: 1 }, minSamples: 20, enter: { above: 0.2 }, exit: { below: 0.05 } };

const approvalsFell = H.trigger('approvals-fell')
  .on(H.when.crossing(approvalRate, approvalBand, 'entered'))
  .create(audits, e => ({ category: e.facets.category, rate: e.value, samples: e.samples }))
  .record(experienceJournal, e => ({
    text: `When drafting for ${e.facets.category}, recall the stricter phrasing, because approvals fell to ${e.value.toFixed(2)}.`,
    when: { roles: [drafterRole], facets: [category.is(e.facets.category)] },
    status: 'candidate',
  }));

const approvalsRecovered = H.trigger('approvals-recovered')
  .on(H.when.crossing(approvalRate, approvalBand, 'exited'))
  .signal(H.cancel, audits, e => ({ key: e.facets.category, payload: { reason: `approval rate recovered to ${e.value.toFixed(2)}` } }));

const errorsSpiked = H.trigger('model-errors-spiked')
  .on(H.when.crossing(modelErrors, errorBand, 'entered'))
  .pause(conversations, e => `model error rate ${e.value.toFixed(3)} over ${e.samples} invocations in the last hour`);

const errorsSubsided = H.trigger('model-errors-subsided')
  .on(H.when.crossing(modelErrors, errorBand, 'exited'))
  .resume(conversations, e => `model error rate ${e.value.toFixed(3)} over ${e.samples} invocations in the last hour`);

const slaBreach = H.trigger('sla-breach')
  .on(H.when.timer(conversations, { at: unit => new Date(unit.attributes.slaDueAt) }))
  .create(escalations, e => ({ ticketId: e.unit.attributes.ticketId, subject: e.unit.attributes.subject, breachedAt: e.at.toISOString() }))
  .signal(breached, conversations, e => ({ key: e.unit.key, payload: {} }));

const reportAttributes = z.object({ month: z.string() });
const reportDue = H.state('due', 'pending');
const publishing = H.state('publishing', 'active');
const published = H.terminal('published', 'success');
const reportFailed = H.terminal('reportFailed', 'failure');
const reportDropped = H.terminal('reportDropped', 'neutral');

const reportKind = H.kind('HealthReport')
  .attributes(reportAttributes)
  .states(reportDue, publishing, published, reportFailed, reportDropped)
  .key(a => a.month)
  .initial(reportDue);

const publishHealth = H.command('publish-health')
  .input(z.object({ month: z.string(), auditsByCategory: z.record(z.string(), z.number()), pausedMinutes: z.number(), pauses: z.number() }))
  .argv(i => ['publish-health', JSON.stringify(i)])
  .runner(ops);

const healthReport = H.flow('health-report')
  .input(reportAttributes)
  .step('publish', publishHealth, ctx => {
    const paused = ctx.metrics.paused({ lane: conversations, window: { calendar: 'month' } });
    return {
      month: ctx.unit.attributes.month,
      auditsByCategory: Object.fromEntries(
        categoryNames.map(name => [name, ctx.metrics.total(auditsOpened, { window: { calendar: 'month' }, facets: { category: name } }).total]),
      ),
      pausedMinutes: paused.totalMs / 60000,
      pauses: paused.count,
    };
  })
  .exit('published');

const reports = H.lane('reports', reportKind)
  .supply(H.clock('month-end').at('23:30', { on: 28 }), (tick, to) => to.create({ month: tick.at.toISOString().slice(0, 7) }))
  .store(sqlite.store({ path: '.harness/units.sqlite' }))
  .handler(healthReport, { exits: { published }, during: { publish: publishing }, cancelled: reportDropped })
  .retry({ maxAttempts: 3, backoff: 'exponential', initialDelayMs: 60000, exhausted: reportFailed });

const scheduler = H.scheduler('support')
  .priority(escalations, conversations, audits, reports)
  .rank(conversations, unit => new Date(unit.attributes.slaDueAt).getTime())
  .admit(audits, ctx => ctx.metrics.total(auditsOpened, { window: { calendar: 'month' }, facets: { category: ctx.unit.attributes.category } }).total <= 4);

const supervisor = H.client('reviewer', {
  transport: claudeCode.mcp('reviewer-mcp', { port: H.slot.port(2) }),
  grants: [
    H.ops.workRead,
    H.ops.workUpdate,
    H.ops.attemptsRecover,
    H.ops.lanesPause,
    H.ops.memoryWrite,
    H.ops.memoryCurate,
    H.ops.telemetryRead,
    H.ops.resolve(approval, escalationReview, auditReview),
  ],
});

export const harness = H.harness('support')
  .ledger(sqlite.ledger({ path: '.harness/ledger.sqlite' }))
  .lanes(conversations, escalations, audits, reports)
  .journals(tasteJournal, experienceJournal)
  .triggers(approvalsFell, approvalsRecovered, errorsSpiked, errorsSubsided, slaBreach)
  .metrics(approvalRate, approvalByModel, auditsOpened, modelErrors)
  .scheduler(scheduler)
  .clients(supervisor)
  .observers(markdown.board({ path: 'BOARD.md' }), markdown.telemetry({ path: 'TELEMETRY.md' }));
