import { z } from 'zod';
import { H, Router, Route } from 'harness-dsl';
import { sqlite } from 'harness-dsl/sqlite';
import { jsonl } from 'harness-dsl/jsonl';
import { anthropic } from 'harness-dsl/anthropic';
import { claudeCode } from 'harness-dsl/claude-code';
import { local } from 'harness-dsl/local';
import { markdown } from 'harness-dsl/markdown';
import { zendesk, ZendeskEvent } from 'harness-dsl/zendesk';

const quota = sqlite.quota('support-quota', { path: '.harness/quota.db' });
const apiAccount = anthropic.account('support-api', { apiKey: H.env('ANTHROPIC_API_KEY'), quota });
const haiku = anthropic.model('haiku', { id: 'claude-haiku-4-5' });
const sonnet = anthropic.model('sonnet', { id: 'claude-sonnet-4-5' });
const supportPool = H.pool('support').accounts(apiAccount);

const classifierRole = H.role('classifier').intents('read').instructions('Assign exactly one support category.');
const drafterRole = H.role('drafter').intents('read').instructions('Draft a reply the customer can act on.');

const category = H.facet('category');

const replyApproval = H.halt('replyApproval').decision(
  z.object({ approved: z.boolean(), reply: z.string().optional(), notes: z.string().optional() }),
);
const costCeiling = H.halt('costCeiling').decision(
  z.discriminatedUnion('action', [
    z.object({ action: z.literal('raise'), maxUsd: z.number() }),
    z.object({ action: z.literal('fail') }),
  ]),
);
const escalationHandled = H.halt('escalationHandled').decision(z.object({ resolution: z.string() }));

const customerReplied = H.signal('customerReplied').payload(z.object({ message: z.string() }));
const customerClosed = H.signal('customerClosed');
const slaBreached = H.signal('slaBreached');

const New = H.state('New', 'pending');
const Sent = H.terminal('Sent', 'success');
const ClosedByCustomer = H.terminal('ClosedByCustomer', 'neutral');
const Escalated = H.terminal('Escalated', 'failure');

const conversationAttrs = z.object({
  ticketId: z.string(),
  subject: z.string(),
  message: z.string(),
  customerEmail: z.string(),
  slaAt: z.date(),
});
type ConversationAttrs = z.infer<typeof conversationAttrs>;
type ConversationState = typeof New | typeof Sent | typeof ClosedByCustomer | typeof Escalated;

const Conversation = H.kind('Conversation')
  .attributes(conversationAttrs)
  .states(New, Sent, ClosedByCustomer, Escalated)
  .key(conversation => conversation.ticketId)
  .initial(New);

const classifier = H.seat('classifier')
  .role(classifierRole)
  .model(haiku)
  .pool(supportPool)
  .output(z.object({ category: z.string() }));

const drafter = H.seat('drafter').role(drafterRole).model(sonnet).pool(supportPool);

const safeCategory = H.policy.halt('safeCategory', replyApproval, z.object({ category: z.string() }), ctx => {
  const record = ctx.metrics.rate(approvalRate, { by: { facets: [category.of(ctx.input.category)] } });
  return record.samples >= 200 && record.hits === record.samples ? { approved: true } : undefined;
});

const helpdeskWorker = local.runner('helpdesk-worker').slots(4);
const sendReply = H.command('sendReply')
  .input(z.object({ ticketId: z.string(), reply: z.string() }))
  .argv(input => ['./scripts/send-reply.sh', input.ticketId, input.reply])
  .runner(helpdeskWorker);

const triage = H.flow('triage')
  .input(conversationAttrs)
  .step('classify', classifier, ctx => ({
    task: `Classify this conversation.\nSubject: ${ctx.unit.attributes.subject}\n${ctx.unit.attributes.message}`,
  }))
  .loop(
    'drafting',
    flow =>
      flow
        .step('draft', drafter, ctx => ({
          task: `Draft a reply in category ${ctx.steps.classify.category}.\nSubject: ${ctx.unit.attributes.subject}\n${ctx.unit.attributes.message}`,
          skills: [ctx.steps.classify.category],
        }))
        .halt('approval', replyApproval, {
          ask: ctx => ctx.steps.draft,
          policy: { by: safeCategory, input: ctx => ({ category: ctx.steps.classify.category }) },
        }),
    { max: 3, until: ctx => ctx.steps.approval.approved },
  )
  .exit('unapproved', ctx => !ctx.steps.approval.approved)
  .step(
    'send',
    sendReply,
    ctx => ({ ticketId: ctx.unit.attributes.ticketId, reply: ctx.steps.approval.reply ?? ctx.steps.draft }),
    { afterCrash: 'park' },
  )
  .exit('sent');

const slaHours: { readonly [P in ZendeskEvent['priority']]: number } = { low: 48, normal: 24, high: 8, urgent: 2 };

const routeTicket = (event: ZendeskEvent, to: Router<ConversationAttrs, ConversationState>): Route => {
  if (event.status === 'solved' || event.status === 'closed') return to.signal(customerClosed, event.ticketId, {});
  if (event.type === 'replied') return to.signal(customerReplied, event.ticketId, { message: event.message });
  if (event.type === 'created')
    return to.create({
      ticketId: event.ticketId,
      subject: event.subject,
      message: event.message,
      customerEmail: event.customerEmail,
      slaAt: new Date(event.createdAt.getTime() + slaHours[event.priority] * 3600000),
    });
  return to.skip();
};

const conversations = H.lane('conversations', Conversation)
  .supply(
    zendesk.webhook({ port: H.slot.port(0), path: '/helpdesk', secret: H.env('HELPDESK_WEBHOOK_SECRET') }),
    routeTicket,
  )
  .supply(zendesk.poll({ subdomain: 'acme', token: H.env('HELPDESK_TOKEN'), everyMinutes: 10 }), routeTicket)
  .store(zendesk.store({ subdomain: 'acme', token: H.env('HELPDESK_TOKEN') }))
  .handler(triage, {
    ends: { sent: Sent, unapproved: Escalated },
    retry: { maxAttempts: 3, backoff: 'exponential', initialDelayMs: 30000, exhausted: Escalated },
    ceiling: { maxUsd: 0.4, onExceed: costCeiling },
  })
  .on(customerReplied, {
    update: (attrs, payload) => ({ ...attrs, message: payload.message }),
    restart: { to: 'classify', at: ['approval'] },
  })
  .on(customerClosed, { enter: ClosedByCustomer })
  .on(slaBreached, { enter: Escalated });

const Open = H.state('Open', 'pending');
const Handled = H.terminal('Handled', 'success');
const Dropped = H.terminal('Dropped', 'neutral');

const escalationAttrs = z.object({ ticketId: z.string(), reason: z.string() });

const Escalation = H.kind('Escalation')
  .attributes(escalationAttrs)
  .states(Open, Handled, Dropped)
  .key(escalation => escalation.ticketId)
  .initial(Open);

const humanEscalation = H.flow('humanEscalation')
  .input(escalationAttrs)
  .halt('handle', escalationHandled, {
    ask: ctx => `Ticket ${ctx.unit.attributes.ticketId} needs a human: ${ctx.unit.attributes.reason}`,
  })
  .exit('handled');

const escalations = H.lane('escalations', Escalation).handler(humanEscalation, {
  ends: { handled: Handled },
  retry: { maxAttempts: 1, backoff: 'fixed', initialDelayMs: 0, exhausted: Dropped },
});

const approvalRate = H.metric('approvalRate', H.when.decision(conversations, replyApproval))
  .facets(category)
  .samples(event =>
    event.resolvedBy === 'human'
      ? [
          {
            hit: event.decision.approved,
            by: {
              facets: [category.of(event.outputs.classify?.category ?? 'unclassified')],
              model: event.invocations.draft?.model,
            },
          },
        ]
      : [],
  );

const taste = H.journal('taste', H.memory('taste', 'taste'))
  .store(jsonl.memoryStore({ path: 'memory/taste.jsonl' }))
  .recall({ by: 'specificity', limit: 15 })
  .readBy(drafterRole);

const experience = H.journal('experience', H.memory('experience', 'experience'))
  .store(jsonl.memoryStore({ path: 'memory/experience.jsonl' }))
  .recall({ by: 'specificity', limit: 10 })
  .readBy(drafterRole);

const slaBreach = H.trigger('slaBreach')
  .on(H.when.timer(conversations, { at: unit => unit.attributes.slaAt }))
  .create(escalations, event => ({
    ticketId: event.unit.attributes.ticketId,
    reason: `SLA breached at ${event.at.toISOString()}`,
  }))
  .signal(slaBreached, conversations, event => ({ key: event.unit.key, payload: {} }));

const tasteFromEdits = H.trigger('tasteFromEdits')
  .on(H.when.decision(conversations, replyApproval))
  .record(taste, event =>
    event.resolvedBy === 'human' && event.decision.notes
      ? { text: event.decision.notes, when: { roles: [drafterRole] }, status: 'candidate' }
      : undefined,
  );

const scheduler = H.scheduler('support')
  .priority(conversations, escalations)
  .rank(conversations, unit => unit.attributes.slaAt.getTime());

const reviewer = claudeCode.supervisor('reviewer').client('support', {
  grants: [
    H.ops.workRead,
    H.ops.resolve(replyApproval),
    H.ops.resolve(costCeiling),
    H.ops.resolve(escalationHandled),
    H.ops.memoryRead,
    H.ops.memoryWrite,
    H.ops.memoryCurate,
    H.ops.telemetryRead,
  ],
});

export const supportTriage = H.harness('support-triage')
  .ledger(sqlite.ledger({ path: '.harness/ledger.db' }))
  .lanes(conversations, escalations)
  .journals(taste, experience)
  .triggers(slaBreach, tasteFromEdits)
  .metrics(approvalRate)
  .scheduler(scheduler)
  .clients(reviewer)
  .observers(markdown.board({ path: 'BOARD.md' }), markdown.telemetry({ path: 'TELEMETRY.md' }));

void supportTriage.start();
