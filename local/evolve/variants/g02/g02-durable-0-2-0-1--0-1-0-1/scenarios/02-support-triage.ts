import { z } from 'zod';
import { H, Router, Route, State } from 'harness-dsl';
import { sqlite } from 'harness-dsl/sqlite';
import { jsonl } from 'harness-dsl/jsonl';
import { anthropic } from 'harness-dsl/anthropic';
import { claudeCode } from 'harness-dsl/claude-code';
import { zendesk, ZendeskEvent } from 'harness-dsl/zendesk';
import { local } from 'harness-dsl/local';
import { markdown } from 'harness-dsl/markdown';

const conversationSchema = z.object({
  ticketId: z.string(),
  subject: z.string(),
  message: z.string(),
  customerEmail: z.string(),
  priority: z.enum(['low', 'normal', 'high', 'urgent']),
  slaDueAt: z.string(),
});
type ConversationAttrs = z.infer<typeof conversationSchema>;

const New = H.state('New', 'pending');
const Classifying = H.state('Classifying', 'active');
const Drafting = H.state('Drafting', 'active');
const AwaitingApproval = H.state('AwaitingApproval', 'waiting');
const Sent = H.terminal('Sent', 'success');
const ClosedByCustomer = H.terminal('ClosedByCustomer', 'neutral');
const Escalated = H.terminal('Escalated', 'failure');

const Conversation = H.kind('Conversation')
  .attributes(conversationSchema)
  .states(New, Classifying, Drafting, AwaitingApproval, Sent, ClosedByCustomer, Escalated)
  .key(a => a.ticketId);

const EscalationOpen = H.state('EscalationOpen', 'pending');
const EscalationResolved = H.terminal('EscalationResolved', 'success');
const EscalationAbandoned = H.terminal('EscalationAbandoned', 'failure');

const Escalation = H.kind('Escalation')
  .attributes(z.object({ ticketId: z.string(), subject: z.string(), reason: z.string() }))
  .states(EscalationOpen, EscalationResolved, EscalationAbandoned)
  .key(a => a.ticketId);

const customerReplied = H.signal('customer-replied').payload(z.object({ message: z.string() }));
const customerClosed = H.signal('customer-closed');
const slaBreached = H.signal('sla-breached');

const replyApproval = H.halt('reply-approval').decision(
  z.object({ approved: z.boolean(), editedReply: z.string().optional(), notes: z.string().optional() }),
);
const costCeiling = H.halt('cost-ceiling').decision(
  z.discriminatedUnion('action', [
    z.object({ action: z.literal('raise'), maxUsd: z.number() }),
    z.object({ action: z.literal('fail') }),
  ]),
);
const escalationHandling = H.halt('escalation-handling').decision(z.object({ resolution: z.string() }));

const category = H.facet('category');

const quota = sqlite.quota('support-accounts', { path: '.harness/quota.sqlite' });
const apiAccount = anthropic.account('anthropic-api', { apiKey: H.env('ANTHROPIC_API_KEY'), quota });
const haiku = anthropic.model('haiku', { id: 'claude-haiku-4-5' });
const sonnet = anthropic.model('sonnet', { id: 'claude-sonnet-4-5' });
const pool = H.pool('support-pool').accounts(apiAccount);

const classifierRole = H.role('classifier').intents('read').instructions('Assign exactly one support category.');
const drafterRole = H.role('drafter').intents('read').instructions('Draft a reply the customer can act on.');
const reviewerRole = H.role('reviewer').intents('read', 'record').instructions('Approve or edit outgoing replies.');

const taste = H.journal('support-taste', H.memory('support-taste', 'taste'))
  .store(jsonl.memoryStore({ path: '.harness/taste.jsonl' }))
  .recall({ by: 'specificity', limit: 15 })
  .readBy(drafterRole)
  .recordedBy(reviewerRole);

const experience = H.journal('support-experience', H.memory('support-experience', 'experience'))
  .store(jsonl.memoryStore({ path: '.harness/experience.jsonl' }))
  .recall({ by: 'specificity', limit: 10 })
  .readBy(drafterRole)
  .recordedBy(reviewerRole);

const classifier = H.seat('classifier')
  .role(classifierRole)
  .model(haiku)
  .pool(pool)
  .output(z.object({ category: z.string() }));

const drafter = H.seat('drafter').role(drafterRole).model(sonnet).pool(pool);

const safeCategory = H.policy.halt(
  'safe-category-autoapprove',
  replyApproval,
  z.object({ category: z.string() }),
  ctx => {
    const record = ctx.metrics.rate(approvalRate, { by: { facets: [category.of(ctx.input.category)] } });
    return record.samples >= 200 && record.hits === record.samples ? { approved: true } : undefined;
  },
);

const localRunner = local.runner('local');

const sendReply = H.command('send-reply')
  .input(z.object({ ticketId: z.string(), body: z.string() }))
  .argv(i => ['./scripts/helpdesk-reply', i.ticketId, i.body])
  .runner(localRunner);

const postResolution = H.command('post-resolution')
  .input(z.object({ ticketId: z.string(), resolution: z.string() }))
  .argv(i => ['./scripts/helpdesk-note', i.ticketId, i.resolution])
  .runner(localRunner);

const triage = H.flow('triage')
  .input(conversationSchema)
  .step('classify', classifier, ctx => ({
    task: `Subject: ${ctx.unit.attributes.subject}\n\n${ctx.unit.attributes.message}`,
  }))
  .loop(
    'drafting',
    f =>
      f
        .step('draft', drafter, ctx => ({
          task: `Reply to: ${ctx.unit.attributes.message}`,
          skills: [ctx.steps.classify.category],
        }))
        .halt('approval', replyApproval, {
          ask: ctx => ctx.steps.draft,
          skip: { by: safeCategory, input: ctx => ({ category: ctx.steps.classify.category }) },
        }),
    { max: 3, until: ctx => ctx.steps.approval.approved },
  )
  .exit('escalate', ctx => !ctx.steps.approval.approved)
  .step('send', sendReply, ctx => ({
    ticketId: ctx.unit.attributes.ticketId,
    body: ctx.steps.approval.editedReply ?? ctx.steps.draft,
  }))
  .exit('sent');

const escalationFlow = H.flow('escalation')
  .input(z.object({ ticketId: z.string(), subject: z.string(), reason: z.string() }))
  .halt('handle', escalationHandling, {
    ask: ctx => `Escalated (${ctx.unit.attributes.reason}): ${ctx.unit.attributes.subject}`,
  })
  .step('note', postResolution, ctx => ({
    ticketId: ctx.unit.attributes.ticketId,
    resolution: ctx.steps.handle.resolution,
  }))
  .exit('resolved');

const slaHours: Record<ConversationAttrs['priority'], number> = { urgent: 1, high: 4, normal: 24, low: 48 };

function routeTicket<S extends State>(event: ZendeskEvent, to: Router<ConversationAttrs, S>): Route {
  if (event.status === 'closed' || event.status === 'solved') {
    return to.signal(customerClosed, event.ticketId, {});
  }
  if (event.type === 'replied') {
    return to.signal(customerReplied, event.ticketId, { message: event.message });
  }
  if (event.type === 'created') {
    return to.create({
      ticketId: event.ticketId,
      subject: event.subject,
      message: event.message,
      customerEmail: event.customerEmail,
      priority: event.priority,
      slaDueAt: new Date(event.createdAt.getTime() + slaHours[event.priority] * 3_600_000).toISOString(),
    });
  }
  return to.skip();
}

const helpdeskToken = H.env('ZENDESK_TOKEN');
const helpdesk = zendesk.store({ subdomain: 'acme', token: helpdeskToken });

const conversations = H.lane('conversations', Conversation)
  .supply(zendesk.webhook({ port: H.slot.port(1), path: '/zendesk', secret: H.env('ZENDESK_SECRET') }), routeTicket)
  .supply(zendesk.poll({ subdomain: 'acme', token: helpdeskToken, everyMinutes: 10 }), routeTicket)
  .store(helpdesk)
  .handler(triage, {
    exits: { escalate: Escalated, sent: Sent },
    during: { classify: Classifying, draft: Drafting, approval: AwaitingApproval },
  })
  .retry({ maxAttempts: 3, backoff: 'exponential', initialDelayMs: 30_000, exhausted: Escalated })
  .on(customerReplied, {
    update: (attrs, payload) => ({ ...attrs, message: payload.message }),
    restart: { to: 'classify', at: ['approval'] },
  })
  .on(customerClosed, { enter: ClosedByCustomer })
  .on(slaBreached, { enter: Escalated })
  .ceiling({ maxUsd: 0.4, onExceed: costCeiling });

const escalations = H.lane('escalations', Escalation)
  .store(helpdesk)
  .handler(escalationFlow, { exits: { resolved: EscalationResolved } })
  .retry({ maxAttempts: 3, backoff: 'fixed', initialDelayMs: 60_000, exhausted: EscalationAbandoned });

const approvalRate = H.metric('reply-approval-rate', H.when.decision(conversations, replyApproval))
  .facets(category)
  .samples(e =>
    e.resolvedBy === 'human'
      ? [
          {
            hit: e.decision.approved,
            by: {
              model: e.invocations.draft?.model,
              facets: [category.of(e.outputs.classify?.category ?? 'uncategorized')],
            },
          },
        ]
      : [],
  );

const slaBreach = H.trigger('sla-breach')
  .on(
    H.when.timer(conversations, u =>
      u.position === 'terminal' ? undefined : new Date(u.attributes.slaDueAt),
    ),
  )
  .create(escalations, e => ({
    ticketId: e.unit.attributes.ticketId,
    subject: e.unit.attributes.subject,
    reason: 'SLA breached',
  }))
  .signal(slaBreached, conversations, e => ({ key: e.unit.key, payload: {} }));

const editsBecomeTaste = H.trigger('reviewer-notes-become-taste')
  .on(H.when.decision(conversations, replyApproval))
  .record(taste, e =>
    e.resolvedBy === 'human' && e.decision.notes !== undefined
      ? { text: e.decision.notes, status: 'candidate', when: { kinds: [Conversation], roles: [drafterRole] } }
      : undefined,
  );

const scheduler = H.scheduler('support')
  .priority(escalations, conversations)
  .wip(conversations, 6)
  .rank(conversations, u => new Date(u.attributes.slaDueAt).getTime());

const reviewer = claudeCode.supervisor('reviewer').client('support-supervisor', {
  grants: [
    H.ops.workRead,
    H.ops.resolve(replyApproval),
    H.ops.resolve(costCeiling),
    H.ops.resolve(escalationHandling),
    H.ops.memoryRead,
    H.ops.memoryWrite,
    H.ops.memoryCurate,
    H.ops.telemetryRead,
  ],
});

export const supportTriage = H.harness('support-triage')
  .ledger(sqlite.ledger({ path: '.harness/ledger.sqlite' }))
  .lanes(conversations, escalations)
  .journals(taste, experience)
  .triggers(slaBreach, editsBecomeTaste)
  .metrics(approvalRate)
  .scheduler(scheduler)
  .clients(reviewer)
  .observers(markdown.board({ path: 'BOARD.md' }), markdown.telemetry({ path: 'TELEMETRY.md' }));
