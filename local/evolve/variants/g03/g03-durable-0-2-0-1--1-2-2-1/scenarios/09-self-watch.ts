import { z } from 'zod';
import { H } from 'harness-dsl';
import { sqlite } from 'harness-dsl/sqlite';
import { jsonl } from 'harness-dsl/jsonl';
import { anthropic } from 'harness-dsl/anthropic';
import { claudeCode } from 'harness-dsl/claude-code';
import { zendesk } from 'harness-dsl/zendesk';
import { local } from 'harness-dsl/local';
import { markdown } from 'harness-dsl/markdown';

const localRunner = local.runner('local');
const quota = sqlite.quota('support-quota', { path: '.harness/quota.db' });
const apiAccount = anthropic.account('support-api', { apiKey: H.env('ANTHROPIC_API_KEY'), quota });
const apiPool = H.pool('support-api').accounts(apiAccount);
const haiku = anthropic.model('haiku', { id: 'claude-haiku-4-5' });
const sonnet = anthropic.model('sonnet', { id: 'claude-sonnet-4-5' });
const opus = anthropic.model('opus', { id: 'claude-opus-4-1' });

const category = H.facet('category', ['billing', 'shipping', 'technical', 'account']);
const categoryTopics = H.resources('category-topic', category.values);

const drafterRole = H.role('drafter').intents('read').instructions('Draft a reply in the house tone.');
const classifierRole = H.role('classifier').intents('read').instructions('Classify the conversation into one category.');
const reviewerRole = H.role('reviewer');

const taste = H.memory('taste', 'taste');
const experience = H.memory('experience', 'experience');
const tasteJournal = H.journal('tone', taste)
  .store(jsonl.memoryStore({ path: '.harness/taste.jsonl' }))
  .recall({ by: 'specificity', limit: 10 })
  .readBy(drafterRole)
  .recordedBy(reviewerRole);
const experienceJournal = H.journal('support-experience', experience)
  .store(jsonl.memoryStore({ path: '.harness/experience.jsonl' }))
  .recall({ by: 'specificity', limit: 8 })
  .readBy(drafterRole);

const conversationSchema = z.object({
  ticketId: z.string(),
  subject: z.string(),
  message: z.string(),
  customerEmail: z.string(),
  slaDeadline: z.string(),
});

const New = H.state('New', 'pending');
const Sent = H.terminal('Sent', 'success');
const ClosedByCustomer = H.terminal('ClosedByCustomer', 'neutral');
const Escalated = H.terminal('Escalated', 'neutral');
const Failed = H.terminal('Failed', 'failure');

const conversationKind = H.kind('Conversation')
  .attributes(conversationSchema)
  .states(New, Sent, ClosedByCustomer, Escalated, Failed)
  .key(a => a.ticketId)
  .initial(New);

const approvalHalt = H.halt('approval').decision(z.object({ approved: z.boolean(), editedReply: z.string().optional() }));
const costHalt = H.halt('cost').decision(H.ceilingDecision);

const approvalRate = H.metric('approval-rate', H.when.decision(conversationKind, approvalHalt))
  .samples(e => e.resolvedBy === 'human' ? [{ hit: e.decision.approved, facets: e.facets }] : []);

const safeCategory = H.policy.halt('safe-category', conversationKind, approvalHalt).decide(ctx => {
  const value = ctx.facet(category);
  if (value === undefined) return undefined;
  const record = ctx.metrics.rate(approvalRate, { facets: [category.of(value)] });
  return record.samples >= 200 && record.hits === record.samples ? { approved: true } : undefined;
});

const auditSchema = z.object({ category: category.schema, rate: z.number(), samples: z.number() });

const AuditOpen = H.state('AuditOpen', 'pending');
const AuditDone = H.terminal('AuditDone', 'success');
const AuditCancelled = H.terminal('AuditCancelled', 'neutral');
const auditKind = H.kind('Audit')
  .attributes(auditSchema)
  .states(AuditOpen, AuditDone, AuditCancelled)
  .key(a => a.category)
  .initial(AuditOpen);

const auditHalt = H.halt('auditFinding').decision(z.object({ finding: z.string() }));

const auditFlow = H.flow('audit')
  .input(auditSchema)
  .halt('auditFinding', auditHalt, {
    ask: ctx => `Approvals for ${ctx.unit.attributes.category} fell to ${ctx.unit.attributes.rate} over ${ctx.unit.attributes.samples} samples. What is wrong?`,
  })
  .exit('done');

const auditLane = H.lane('audits', auditKind)
  .handler(auditFlow, { exits: { done: AuditDone } })
  .store(sqlite.store({ path: '.harness/store.db' }))
  .retry({ maxAttempts: 1, exhausted: AuditCancelled })
  .on(H.cancel, { enter: AuditCancelled });

const auditsOpened = H.metric('audits-opened', H.when.transition(auditLane, { to: AuditOpen }))
  .amounts(e => [{ amount: 1, facets: [category.of(e.unit.attributes.category)] }]);

const drafterModel = H.policy.model('drafter-model', [sonnet, opus], ctx => {
  const audits = category.values.reduce(
    (n, v) => n + ctx.metrics.total(auditsOpened, { facets: [category.of(v)], window: { calendar: 'month' } }).total,
    0,
  );
  const paused = ctx.metrics.paused({ lane: conversationLane, window: { calendar: 'month' } });
  return audits > 2 || paused.totalMs > 3_600_000 ? opus : sonnet;
});

const classifier = H.seat('classifier')
  .role(classifierRole)
  .model(haiku)
  .pool(apiPool)
  .output(z.object({ category: category.schema }));

const drafter = H.seat('drafter')
  .role(drafterRole)
  .model(drafterModel)
  .pool(apiPool)
  .output(z.object({ reply: z.string() }));

const sendReply = H.command('send-reply')
  .input(z.object({ ticketId: z.string(), reply: z.string() }))
  .argv(i => ['./scripts/helpdesk-reply', i.ticketId, i.reply])
  .runner(localRunner);

const answer = H.flow('answer')
  .input(conversationSchema)
  .step('classify', classifier, ctx => ({ task: `Classify: ${ctx.unit.attributes.subject}\n${ctx.unit.attributes.message}` }))
  .step('draft', drafter, ctx => ({
    task: `Reply to ${ctx.unit.attributes.customerEmail}: ${ctx.unit.attributes.message}`,
    resources: [categoryTopics.get(ctx.steps.classify.category)],
  }))
  .halt('approval', approvalHalt, {
    ask: ctx => ctx.steps.draft.reply,
    skip: safeCategory,
    facets: ctx => [category.of(ctx.steps.classify.category)],
  })
  .exit('rejected', ctx => !ctx.steps.approval.approved)
  .step('send', sendReply, ctx => ({
    ticketId: ctx.unit.attributes.ticketId,
    reply: ctx.steps.approval.editedReply ?? ctx.steps.draft.reply,
  }), { afterCrash: 'park' })
  .exit('sent');

const customerReplied = H.signal('customerReplied').payload(z.object({ message: z.string() }));
const customerClosed = H.signal('customerClosed');
const slaBreached = H.signal('slaBreached');

const slaHours = { low: 24, normal: 8, high: 4, urgent: 1 };
const helpdeskToken = H.env('HELPDESK_TOKEN');

const helpdeskWebhook = zendesk.webhook({ port: H.slot.port(1), path: '/helpdesk', secret: H.env('HELPDESK_WEBHOOK_SECRET') });
const helpdeskPoll = zendesk.poll({ subdomain: 'acme', token: helpdeskToken, everyMinutes: 10 });

const conversationLane = H.lane('conversations', conversationKind)
  .supply([helpdeskWebhook, helpdeskPoll], (e, to) => {
    if (e.type === 'created') {
      return to.create({
        ticketId: e.ticketId,
        subject: e.subject,
        message: e.message,
        customerEmail: e.customerEmail,
        slaDeadline: new Date(e.createdAt.getTime() + slaHours[e.priority] * 3_600_000).toISOString(),
      });
    }
    if (e.status === 'closed' || e.status === 'solved') return to.signal(customerClosed, e.ticketId, {});
    if (e.type === 'replied') return to.signal(customerReplied, e.ticketId, { message: e.message });
    return to.skip();
  })
  .handler(answer, { exits: { sent: Sent, rejected: { to: New, bound: { times: 3, to: Escalated } } } })
  .store(zendesk.store({ subdomain: 'acme', token: helpdeskToken }))
  .retry({ maxAttempts: 3, backoff: 'exponential', initialDelayMs: 30_000, exhausted: Failed })
  .ceiling({ maxUsd: 0.4, onExceed: costHalt })
  .on(customerReplied, { update: (a, p) => ({ ...a, message: p.message }), enter: New, at: ['approval'] })
  .on(customerClosed, { enter: ClosedByCustomer })
  .on(slaBreached, { enter: Escalated });

const escalationSchema = z.object({ ticketId: z.string(), reason: z.string() });
const EscalationOpen = H.state('EscalationOpen', 'pending');
const EscalationHandled = H.terminal('EscalationHandled', 'success');
const EscalationDropped = H.terminal('EscalationDropped', 'neutral');
const escalationKind = H.kind('Escalation')
  .attributes(escalationSchema)
  .states(EscalationOpen, EscalationHandled, EscalationDropped)
  .key(a => a.ticketId)
  .initial(EscalationOpen);

const escalationHalt = H.halt('escalationHandled').decision(z.object({ resolution: z.string() }));

const handleEscalation = H.flow('handle-escalation')
  .input(escalationSchema)
  .halt('escalationHandled', escalationHalt, { ask: ctx => `Ticket ${ctx.unit.attributes.ticketId}: ${ctx.unit.attributes.reason}` })
  .exit('handled');

const escalationLane = H.lane('escalations', escalationKind)
  .handler(handleEscalation, { exits: { handled: EscalationHandled } })
  .store(sqlite.store({ path: '.harness/store.db' }))
  .retry({ maxAttempts: 1, exhausted: EscalationDropped });

const slaBreach = H.trigger('sla-breach')
  .on(H.when.timer(conversationLane, { reads: ['slaDeadline'], at: v => new Date(v.attributes.slaDeadline) }))
  .create(escalationLane, e => ({ ticketId: e.unit.attributes.ticketId, reason: `SLA breached at ${e.unit.attributes.slaDeadline}` }))
  .signal(slaBreached, conversationLane, e => ({ key: e.unit.key, payload: {} }));

const approvalsFell = H.trigger('approvals-fell')
  .on(H.when.crossing(approvalRate, {
    window: { lastDays: 7 }, minSamples: 50, enter: { below: 0.9 }, exit: { above: 0.95 }, per: category,
  }, 'entered'))
  .create(auditLane, e => ({ category: e.value, rate: e.rate, samples: e.samples }))
  .record(experienceJournal, e => ({
    text: `When drafting for ${e.value}, recall the stricter phrasing, because approvals fell to ${e.rate.toFixed(2)}.`,
    when: { roles: [drafterRole], kinds: [conversationKind], resources: [categoryTopics.get(e.value)] },
    status: 'candidate',
  }));

const approvalsRecovered = H.trigger('approvals-recovered')
  .on(H.when.crossing(approvalRate, {
    window: { lastDays: 7 }, minSamples: 50, enter: { below: 0.9 }, exit: { above: 0.95 }, per: category,
  }, 'exited'))
  .signal(H.cancel, auditLane, e => ({ key: e.value, payload: { reason: `Approvals recovered to ${e.rate.toFixed(2)}` } }));

const modelErrors = H.metric('model-errors', H.when.invocation({ lanes: [conversationLane] }))
  .samples(e => [{ hit: !e.ok, model: e.model }]);

const pauseOnErrors = H.trigger('pause-on-errors')
  .on(H.when.crossing(modelErrors, {
    window: { lastHours: 1 }, minSamples: 20, enter: { above: 0.2 }, exit: { below: 0.05 },
  }, 'entered'))
  .pause(conversationLane, e => `Model error rate ${e.rate.toFixed(3)} over ${e.samples} invocations`);

const resumeOnRecovery = H.trigger('resume-on-recovery')
  .on(H.when.crossing(modelErrors, {
    window: { lastHours: 1 }, minSamples: 20, enter: { above: 0.2 }, exit: { below: 0.05 },
  }, 'exited'))
  .resume(conversationLane, e => `Model error rate ${e.rate.toFixed(3)} over ${e.samples} invocations`);

const reviewer = claudeCode.supervisor('reviewer', {
  grants: [
    H.ops.workRead,
    H.ops.workUpdate,
    H.ops.resolve(approvalHalt, costHalt, auditHalt, escalationHalt),
    H.ops.memoryRead,
    H.ops.memoryWrite,
    H.ops.memoryCurate,
    H.ops.telemetryRead,
  ],
  port: H.slot.port(2),
});

export const harness = H.harness('support')
  .ledger(sqlite.ledger({ path: '.harness/ledger.db' }))
  .lanes(conversationLane, escalationLane, auditLane)
  .journals(tasteJournal, experienceJournal)
  .triggers(slaBreach, approvalsFell, approvalsRecovered, pauseOnErrors, resumeOnRecovery)
  .metrics(approvalRate, auditsOpened, modelErrors)
  .scheduler(H.scheduler('support-scheduler')
    .expedite(escalationLane)
    .fixedDate(conversationLane, u => new Date(u.attributes.slaDeadline))
    .standard(auditLane))
  .clients(reviewer)
  .observers(markdown.board({ path: 'BOARD.md' }), markdown.telemetry({ path: 'TELEMETRY.md' }));

void harness.start();
