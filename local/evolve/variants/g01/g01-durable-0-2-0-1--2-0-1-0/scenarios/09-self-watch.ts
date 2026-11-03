import { z } from 'zod';
import { H, MetricRef, ModelPolicy, Router, Route, Band } from 'harness-dsl';
import { sqlite } from 'harness-dsl/sqlite';
import { jsonl } from 'harness-dsl/jsonl';
import { anthropic } from 'harness-dsl/anthropic';
import { claudeCode } from 'harness-dsl/claude-code';
import { zendesk, ZendeskEvent } from 'harness-dsl/zendesk';
import { local } from 'harness-dsl/local';
import { markdown } from 'harness-dsl/markdown';

const quota = sqlite.quota('support-quota', { path: './.harness/quota.sqlite' });
const api = anthropic.account('api', { apiKey: H.env('ANTHROPIC_API_KEY'), quota });
const haiku = anthropic.model('haiku', { id: 'claude-haiku-4-5' });
const sonnet = anthropic.model('sonnet', { id: 'claude-sonnet-4-5' });
const opus = anthropic.model('opus', { id: 'claude-opus-4-1' });
const firstEligible = H.policy.account('first-eligible', ctx =>
  ctx.candidates.find(c => c.cooldownUntil === undefined || c.cooldownUntil <= ctx.now),
);
const pool = H.pool('support-pool').accounts(api).drain(firstEligible);
const runner = local.runner('local');

const classifierRole = H.role('classifier').intents('read').instructions('Classify the conversation into one category.');
const drafterRole = H.role('drafter').intents('read').instructions('Draft a reply in the house tone.');
const reviewerRole = H.role('reviewer').intents('read', 'record').instructions('Approve or edit outgoing replies.');

const taste = H.journal('support-taste', H.memory('taste', 'taste'))
  .store(jsonl.memoryStore({ path: './.harness/taste.jsonl' }))
  .recall({ by: 'specificity', limit: 10 })
  .readBy(drafterRole)
  .recordedBy(reviewerRole);

const experience = H.journal('support-experience', H.memory('experience', 'experience'))
  .store(jsonl.memoryStore({ path: './.harness/experience.jsonl' }))
  .recall({ by: 'specificity', limit: 10 })
  .readBy(drafterRole)
  .recordedBy(reviewerRole);

const category = H.facet('category');

const approval = H.halt('reply-approval').decision(z.object({ approved: z.boolean(), reply: z.string() }));
const costCeiling = H.halt('cost-ceiling').decision(
  z.discriminatedUnion('action', [
    z.object({ action: z.literal('raise'), maxUsd: z.number() }),
    z.object({ action: z.literal('fail') }),
  ]),
);
const escalationHandled = H.halt('escalation-handled').decision(z.object({ resolution: z.string() }));
const auditReview = H.halt('audit-review').decision(z.object({ findings: z.string() }));

const customerReplied = H.signal('customer-replied').payload(z.object({ message: z.string() }));
const customerClosed = H.signal('customer-closed');
const slaExtended = H.signal('sla-extended').payload(z.object({ slaDeadline: z.string() }));
const slaBreached = H.signal('sla-breached');

const drafterModel: ModelPolicy = H.policy.model('drafter-by-approval', [sonnet, opus], ctx => {
  const paused = ctx.metrics.paused({ lane: conversations, window: { calendar: 'month' } });
  if (paused.totalMs > 2 * 3600000) return sonnet;
  const cheap = ctx.metrics.rate(modelCategoryApproval, { by: { seat: ctx.seat, model: sonnet }, window: { lastDays: 14 } });
  const strong = ctx.metrics.rate(modelCategoryApproval, { by: { seat: ctx.seat, model: opus }, window: { lastDays: 14 } });
  return cheap.samples >= 50 && strong.samples >= 50 && strong.rate > cheap.rate + 0.05 ? opus : sonnet;
});

const classifier = H.seat('classifier').role(classifierRole).model(haiku).pool(pool).output(z.object({ category: z.string() }));
const drafter = H.seat('drafter').role(drafterRole).model(drafterModel).pool(pool).output(z.object({ reply: z.string() }));

const safeCategory = H.policy.halt(
  'safe-category-skips-approval',
  approval,
  z.object({ category: z.string(), reply: z.string() }),
  ctx => {
    const record = ctx.metrics.rate(categoryApproval, { by: { facets: [category.of(ctx.input.category)] }, window: { lastDays: 365 } });
    return record.samples >= 200 && record.hits === record.samples ? { approved: true, reply: ctx.input.reply } : undefined;
  },
);

const sendReply = H.command('send-reply')
  .input(z.object({ ticketId: z.string(), reply: z.string() }))
  .argv(i => ['./bin/send-reply', i.ticketId, i.reply])
  .runner(runner);

const conversationAttrs = z.object({
  ticketId: z.string(),
  subject: z.string(),
  message: z.string(),
  customerEmail: z.string(),
  slaDeadline: z.string(),
});

const New = H.state('New', 'pending');
const Classifying = H.state('Classifying', 'active');
const Drafting = H.state('Drafting', 'active');
const AwaitingApproval = H.state('AwaitingApproval', 'waiting');
const Sending = H.state('Sending', 'active');
const Sent = H.terminal('Sent', 'success');
const ClosedByCustomer = H.terminal('ClosedByCustomer', 'neutral');
const Escalated = H.terminal('Escalated', 'neutral');
const Rejected = H.terminal('Rejected', 'failure');

const Conversation = H.kind('Conversation')
  .attributes(conversationAttrs)
  .states(New, Classifying, Drafting, AwaitingApproval, Sending, Sent, ClosedByCustomer, Escalated, Rejected)
  .key(a => a.ticketId)
  .initial(New);

const conversationFlow = H.flow('conversation')
  .input(conversationAttrs)
  .step('classify', classifier, ctx => ({ task: `${ctx.unit.attributes.subject}\n${ctx.unit.attributes.message}` }))
  .step('draft', drafter, ctx => ({
    task: `Reply to ${ctx.unit.attributes.customerEmail}: ${ctx.unit.attributes.message}`,
    skills: [ctx.steps.classify.category],
  }))
  .halt('approval', approval, {
    ask: ctx => ctx.steps.draft.reply,
    skip: { by: safeCategory, input: ctx => ({ category: ctx.steps.classify.category, reply: ctx.steps.draft.reply }) },
  })
  .exit('rejected', ctx => !ctx.steps.approval.approved)
  .step('send', sendReply, ctx => ({ ticketId: ctx.unit.attributes.ticketId, reply: ctx.steps.approval.reply }), { afterCrash: 'park' })
  .exit('sent');

const slaHours = { low: 48, normal: 24, high: 8, urgent: 2 };

function routeTicket(e: ZendeskEvent, to: Router<z.infer<typeof conversationAttrs>, string, string>): Route {
  if (e.type === 'created') {
    return to.create({
      ticketId: e.ticketId,
      subject: e.subject,
      message: e.message,
      customerEmail: e.customerEmail,
      slaDeadline: new Date(e.createdAt.getTime() + slaHours[e.priority] * 3600000).toISOString(),
    });
  }
  if (e.status === 'closed' || e.status === 'solved') return to.signal(customerClosed, e.ticketId, {});
  return to.signal(customerReplied, e.ticketId, { message: e.message });
}

const conversations = H.lane('conversations', Conversation)
  .supply(zendesk.webhook({ port: H.slot.port(1), path: '/helpdesk', secret: H.env('HELPDESK_SECRET') }), routeTicket)
  .supply(zendesk.poll({ subdomain: 'acme', token: H.env('HELPDESK_TOKEN'), everyMinutes: 10 }), routeTicket)
  .store(zendesk.store({ subdomain: 'acme', token: H.env('HELPDESK_TOKEN') }))
  .handler(conversationFlow, {
    exits: { rejected: Rejected, sent: Sent },
    during: { classify: Classifying, draft: Drafting, send: Sending, approval: AwaitingApproval },
  })
  .retry({ maxAttempts: 3, backoff: 'exponential', initialDelayMs: 60000, exhausted: Escalated })
  .ceiling({ maxUsd: 0.4, onExceed: costCeiling })
  .on(customerReplied, { update: (a, p) => ({ ...a, message: p.message }), restart: { to: 'classify', at: ['approval'] } })
  .on(customerClosed, { enter: ClosedByCustomer })
  .on(slaExtended, { update: (a, p) => ({ ...a, slaDeadline: p.slaDeadline }) })
  .on(slaBreached, { enter: Escalated });

const EscalationOpen = H.state('EscalationOpen', 'pending');
const WithHuman = H.state('WithHuman', 'waiting');
const EscalationResolved = H.terminal('EscalationResolved', 'success');
const EscalationDropped = H.terminal('EscalationDropped', 'failure');

const Escalation = H.kind('Escalation')
  .attributes(z.object({ ticketId: z.string(), reason: z.string() }))
  .states(EscalationOpen, WithHuman, EscalationResolved, EscalationDropped)
  .key(a => a.ticketId)
  .initial(EscalationOpen);

const escalationFlow = H.flow('escalation')
  .input(z.object({ ticketId: z.string(), reason: z.string() }))
  .halt('handle', escalationHandled, { ask: ctx => `Ticket ${ctx.unit.attributes.ticketId}: ${ctx.unit.attributes.reason}` })
  .exit('resolved');

const escalations = H.lane('escalations', Escalation)
  .handler(escalationFlow, { exits: { resolved: EscalationResolved }, during: { handle: WithHuman } })
  .retry({ maxAttempts: 1, backoff: 'fixed', initialDelayMs: 0, exhausted: EscalationDropped });

const AuditQueued = H.state('AuditQueued', 'pending');
const UnderReview = H.state('UnderReview', 'waiting');
const AuditClosed = H.terminal('AuditClosed', 'success');
const AuditCancelled = H.terminal('AuditCancelled', 'neutral');
const AuditDropped = H.terminal('AuditDropped', 'failure');

const Audit = H.kind('Audit')
  .attributes(z.object({ category: z.string(), rate: z.number(), samples: z.number() }))
  .states(AuditQueued, UnderReview, AuditClosed, AuditCancelled, AuditDropped)
  .key(a => a.category)
  .initial(AuditQueued);

const auditFlow = H.flow('audit')
  .input(z.object({ category: z.string(), rate: z.number(), samples: z.number() }))
  .halt('review', auditReview, {
    ask: ctx => `Approvals for ${ctx.unit.attributes.category} fell to ${ctx.unit.attributes.rate.toFixed(2)} over ${ctx.unit.attributes.samples} samples.`,
  })
  .exit('closed');

const audits = H.lane('audits', Audit)
  .handler(auditFlow, { exits: { closed: AuditClosed }, during: { review: UnderReview } })
  .retry({ maxAttempts: 1, backoff: 'fixed', initialDelayMs: 0, exhausted: AuditDropped })
  .on(H.cancel, { enter: AuditCancelled });

const categoryApproval: MetricRef<'rate'> = H.metric('approval-by-category', H.when.decision(conversations, approval))
  .facets(category)
  .samples(e =>
    e.resolvedBy === 'human' && e.outputs.classify !== undefined
      ? [{ hit: e.decision.approved, by: { facets: [category.of(e.outputs.classify.category)] } }]
      : [],
  );

const modelCategoryApproval: MetricRef<'rate'> = H.metric('approval-by-category-and-model', H.when.decision(conversations, approval))
  .facets(category)
  .samples(e =>
    e.resolvedBy === 'human' && e.outputs.classify !== undefined
      ? [
          {
            hit: e.decision.approved,
            by: {
              seat: e.invocations.draft?.seat,
              model: e.invocations.draft?.model,
              facets: [category.of(e.outputs.classify.category)],
            },
          },
        ]
      : [],
  );

const modelErrors = H.metric('model-errors', H.when.invocation({ lanes: [conversations] })).samples(e =>
  e.model === undefined ? [] : [{ hit: !e.ok }],
);

const auditsOpened = H.metric('audits-opened', H.when.transition(audits, { to: AuditQueued }))
  .facets(category)
  .amounts(e => [{ amount: 1, by: { facets: [category.of(e.unit.attributes.category)] } }]);

const approvalBand: Band = { window: { lastDays: 7 }, minSamples: 50, enter: { below: 0.9 }, exit: { above: 0.95 } };
const errorBand: Band = { window: { lastHours: 1 }, minSamples: 20, enter: { above: 0.2 }, exit: { below: 0.05 } };

const approvalFell = H.trigger('approval-fell')
  .on(H.when.crossing(categoryApproval, approvalBand, 'entered'))
  .create(audits, e => {
    const c = category.read(e.by);
    return c === undefined ? undefined : { category: c, rate: e.value, samples: e.samples };
  })
  .record(experience, e => {
    const c = category.read(e.by);
    return c === undefined
      ? undefined
      : {
          text: `When drafting for ${c}, recall the stricter phrasing, because approvals fell to ${e.value.toFixed(2)}`,
          when: { roles: [drafterRole], skills: [c] },
          status: 'candidate',
        };
  });

const approvalRecovered = H.trigger('approval-recovered')
  .on(H.when.crossing(categoryApproval, approvalBand, 'exited'))
  .signal(H.cancel, audits, e => {
    const c = category.read(e.by);
    return c === undefined ? undefined : { key: c, payload: { reason: `approvals recovered to ${e.value.toFixed(2)}` } };
  });

const errorsSpiked = H.trigger('model-errors-spiked')
  .on(H.when.crossing(modelErrors, errorBand, 'entered'))
  .pause(conversations, e => `model error rate ${e.value.toFixed(2)} over ${e.samples} invocations`);

const errorsSubsided = H.trigger('model-errors-subsided')
  .on(H.when.crossing(modelErrors, errorBand, 'exited'))
  .resume(conversations, e => `model error rate ${e.value.toFixed(2)} over ${e.samples} invocations`);

const slaBreach = H.trigger('sla-breach')
  .on(H.when.timer(conversations, { at: u => new Date(u.attributes.slaDeadline) }))
  .create(escalations, e => ({ ticketId: e.unit.attributes.ticketId, reason: `SLA breached at ${e.at.toISOString()}` }))
  .signal(slaBreached, conversations, e => ({ key: e.unit.key, payload: {} }));

const scheduler = H.scheduler('support')
  .priority(escalations, audits, conversations)
  .rank(conversations, u => new Date(u.attributes.slaDeadline).getTime())
  .wip(conversations, 6)
  .admit(audits, ctx => {
    const opened = ctx.metrics.total(auditsOpened, {
      by: { facets: [category.of(ctx.unit.attributes.category)] },
      window: { calendar: 'month' },
    });
    return opened.total <= 4 || ctx.count(audits, 'active', 'waiting') === 0;
  });

void H.harness('support')
  .ledger(sqlite.ledger({ path: './.harness/ledger.sqlite' }))
  .lanes(conversations, escalations, audits)
  .journals(taste, experience)
  .triggers(approvalFell, approvalRecovered, errorsSpiked, errorsSubsided, slaBreach)
  .metrics(categoryApproval, modelCategoryApproval, modelErrors, auditsOpened)
  .scheduler(scheduler)
  .clients(
    claudeCode.supervisor('reviewer').client('support-reviewer', {
      grants: [
        H.ops.workRead,
        H.ops.workSignal,
        H.ops.lanesPause,
        H.ops.resolve(approval),
        H.ops.resolve(costCeiling),
        H.ops.resolve(escalationHandled),
        H.ops.resolve(auditReview),
        H.ops.memoryRead,
        H.ops.memoryWrite,
        H.ops.memoryCurate,
        H.ops.telemetryRead,
      ],
    }),
  )
  .observers(markdown.board({ path: './BOARD.md' }), markdown.telemetry({ path: './TELEMETRY.md' }))
  .start();
