import { z } from 'zod';
import { H, MetricRef, Route, Router, State } from 'harness-dsl';
import { anthropic } from 'harness-dsl/anthropic';
import { sqlite } from 'harness-dsl/sqlite';
import { jsonl } from 'harness-dsl/jsonl';
import { zendesk, ZendeskEvent } from 'harness-dsl/zendesk';
import { local } from 'harness-dsl/local';
import { claudeCode } from 'harness-dsl/claude-code';
import { markdown } from 'harness-dsl/markdown';

const conversationAttrs = z.object({
  ticketId: z.string(),
  subject: z.string(),
  message: z.string(),
  customerEmail: z.string(),
  slaDue: z.string(),
});
type Conversation = z.infer<typeof conversationAttrs>;

const escalationAttrs = z.object({ ticketId: z.string(), reason: z.string() });

const received = H.state('New', 'pending');
const classifying = H.state('Classifying', 'active');
const drafting = H.state('Drafting', 'active');
const awaitingApproval = H.state('AwaitingApproval', 'waiting');
const sent = H.terminal('Sent', 'success');
const closedByCustomer = H.terminal('ClosedByCustomer', 'neutral');
const escalated = H.terminal('Escalated', 'failure');

const open = H.state('Open', 'pending');
const withHuman = H.state('WithHuman', 'waiting');
const handled = H.terminal('Handled', 'success');
const dropped = H.terminal('Dropped', 'failure');

const conversation = H.kind('Conversation')
  .attributes(conversationAttrs)
  .states(received, classifying, drafting, awaitingApproval, sent, closedByCustomer, escalated)
  .key(a => a.ticketId)
  .initial(received);

const escalation = H.kind('Escalation')
  .attributes(escalationAttrs)
  .states(open, withHuman, handled, dropped)
  .key(a => a.ticketId)
  .initial(open);

const customerReplied = H.signal('customer-replied').payload(z.object({ message: z.string() }));
const customerClosed = H.signal('customer-closed');
const escalate = H.signal('escalate');

const category = H.facet('category');

const approval = H.halt('reply-approval').decision(
  z.object({ approved: z.boolean(), editedReply: z.string().optional() }),
);
const costCeiling = H.halt('conversation-cost-ceiling').decision(
  z.union([
    z.object({ action: z.literal('raise'), maxUsd: z.number() }),
    z.object({ action: z.literal('fail') }),
  ]),
);
const escalationHandled = H.halt('escalation-handled').decision(z.object({ note: z.string() }));

const quota = sqlite.quota('support-quota', { path: '.harness/quota.db' });
const api = anthropic.account('anthropic-api', { apiKey: H.env('ANTHROPIC_API_KEY'), quota });
const pool = H.pool('support').accounts(api);

const haiku = anthropic.model('haiku', { id: 'claude-haiku-4-5' });
const opus = anthropic.model('opus', { id: 'claude-opus-4-1' });

const classifierRole = H.role('classifier').intents('read').instructions('Assign one category to the conversation.');
const drafterRole = H.role('drafter').intents('read').instructions('Draft the next reply to the customer.');
const reviewerRole = H.role('reviewer').instructions('Approve, edit or reject drafted replies.');

const tone = H.journal('reply-taste', H.memory('reply-taste', 'taste'))
  .store(jsonl.memoryStore({ path: 'memory/taste.jsonl' }))
  .recall({ by: 'specificity', limit: 10 })
  .readBy(drafterRole)
  .recordedBy(reviewerRole);

const supportLessons = H.journal('support-lessons', H.memory('support-lessons', 'experience'))
  .store(jsonl.memoryStore({ path: 'memory/experience.jsonl' }))
  .recall({ by: 'specificity', limit: 8 })
  .readBy(drafterRole);

const classifier = H.seat('classifier')
  .role(classifierRole)
  .model(haiku)
  .pool(pool)
  .output(z.object({ category: z.string() }));

const drafter = H.seat('drafter').role(drafterRole).model(opus).pool(pool);

const safeCategory = H.policy.halt(
  'safe-category-skips-approval',
  approval,
  z.object({ category: z.string() }),
  ctx => {
    const rate = ctx.metrics.rate(approvalRate, { by: { facets: [category.of(ctx.input.category)] } });
    return rate.samples >= 200 && rate.hits === rate.samples ? { approved: true } : undefined;
  },
);

const sendReply = H.command('send-reply')
  .input(z.object({ ticketId: z.string(), body: z.string() }))
  .argv(i => ['./bin/helpdesk-reply', i.ticketId, i.body])
  .runner(local.runner('local'));

const triage = H.flow('triage')
  .input(conversationAttrs)
  .step('classify', classifier, ctx => ({ task: `Classify:\n${ctx.unit.attributes.subject}\n${ctx.unit.attributes.message}` }))
  .step('draft', drafter, ctx => ({
    task: `Draft a reply for a ${ctx.steps.classify.category} conversation:\n${ctx.unit.attributes.message}`,
    skills: [ctx.steps.classify.category],
  }))
  .halt('approval', approval, {
    ask: ctx => `Reply to ${ctx.unit.key}:\n\n${ctx.steps.draft}`,
    skip: { by: safeCategory, input: ctx => ({ category: ctx.steps.classify.category }) },
  })
  .exit('rejected', ctx => ctx.steps.approval.approved === false)
  .step('send', sendReply, ctx => ({ ticketId: ctx.unit.key, body: ctx.steps.approval.editedReply ?? ctx.steps.draft }))
  .exit('sent');

const slaHours = { low: 48, normal: 24, high: 8, urgent: 2 };

const routeTicket = (e: ZendeskEvent, to: Router<Conversation, State>): Route => {
  if (e.status === 'closed' || e.status === 'solved') return to.signal(customerClosed, e.ticketId, {});
  if (e.type === 'created') {
    return to.create({
      ticketId: e.ticketId,
      subject: e.subject,
      message: e.message,
      customerEmail: e.customerEmail,
      slaDue: new Date(e.createdAt.getTime() + slaHours[e.priority] * 3600000).toISOString(),
    });
  }
  if (e.type === 'replied') return to.signal(customerReplied, e.ticketId, { message: e.message });
  return to.skip();
};

const helpdeskToken = H.env('ZENDESK_TOKEN');

const conversations = H.lane('conversations', conversation)
  .supply(zendesk.webhook({ port: H.slot.port(0), path: '/zendesk', secret: H.env('ZENDESK_WEBHOOK_SECRET') }), routeTicket)
  .supply(zendesk.poll({ subdomain: 'acme', token: helpdeskToken, everyMinutes: 10 }), routeTicket)
  .store(zendesk.store({ subdomain: 'acme', token: helpdeskToken }))
  .handler(triage, {
    exits: { rejected: escalated, sent },
    during: { classify: classifying, draft: drafting, send: drafting, approval: awaitingApproval },
  })
  .retry({ maxAttempts: 3, backoff: 'exponential', initialDelayMs: 30000, exhausted: escalated })
  .ceiling({ maxUsd: 0.4, onExceed: costCeiling })
  .on(customerReplied, { update: (a, p) => ({ ...a, message: p.message }), enter: received, interrupt: true })
  .on(customerClosed, { enter: closedByCustomer })
  .on(escalate, { enter: escalated });

const humanEscalation = H.flow('human-escalation')
  .input(escalationAttrs)
  .halt('handle', escalationHandled, { ask: ctx => `Escalated ticket ${ctx.unit.key}: ${ctx.unit.attributes.reason}` })
  .exit('handled');

const escalations = H.lane('escalations', escalation)
  .handler(humanEscalation, { exits: { handled }, during: { handle: withHuman } })
  .retry({ maxAttempts: 1, backoff: 'fixed', initialDelayMs: 0, exhausted: dropped });

const approvalRate: MetricRef<'rate'> = H.metric('reply-approval', H.when.decision(conversations, approval))
  .facets(category)
  .samples(e =>
    e.resolvedBy === 'human'
      ? [
          {
            hit: e.decision.approved,
            by: {
              model: e.invocations.draft?.model,
              facets: [category.of(e.outputs.classify?.category ?? 'unclassified')],
            },
          },
        ]
      : [],
  );

const slaBreachEscalates = H.trigger('sla-breach-escalates')
  .on(H.when.timer(conversations, { at: u => new Date(u.attributes.slaDue) }))
  .signal(escalate, conversations, e => ({ key: e.unit.key, payload: {} }));

const escalatedOpensEscalation = H.trigger('escalated-opens-escalation')
  .on(H.when.transition(conversations, { to: escalated }))
  .create(escalations, e => ({
    ticketId: e.unit.key,
    reason: e.attempt?.exit === 'rejected' ? 'reviewer rejected the draft' : 'SLA breached or retries exhausted',
  }));

const reviewerEditsBecomeTaste = H.trigger('reviewer-edits-become-taste')
  .on(H.when.decision(conversations, approval))
  .record(tone, e => {
    const edited = e.decision.editedReply;
    if (e.resolvedBy === 'human' && edited) {
      return {
        text: `When drafting a ${e.outputs.classify?.category ?? 'general'} reply, write it the way the reviewer did ("${edited}"), because the reviewer rewrote "${e.outputs.draft ?? ''}"`,
        when: { roles: [drafterRole], skills: [e.outputs.classify?.category ?? 'general'] },
        status: 'candidate',
      };
    }
    return undefined;
  });

const scheduler = H.scheduler('support')
  .priority(escalations, conversations)
  .rank(conversations, u => new Date(u.attributes.slaDue).getTime());

const reviewer = claudeCode.supervisor('reviewer');

export const supportTriage = H.harness('support-triage')
  .ledger(sqlite.ledger({ path: '.harness/support.db' }))
  .lanes(conversations, escalations)
  .journals(tone, supportLessons)
  .triggers(slaBreachEscalates, escalatedOpensEscalation, reviewerEditsBecomeTaste)
  .metrics(approvalRate)
  .scheduler(scheduler)
  .clients(
    reviewer.client('reviewer-console', {
      grants: [
        H.ops.workRead,
        H.ops.resolve(approval),
        H.ops.resolve(costCeiling),
        H.ops.resolve(escalationHandled),
        H.ops.memoryRead,
        H.ops.memoryWrite,
        H.ops.telemetryRead,
      ],
    }),
  )
  .observers(markdown.board({ path: 'BOARD.md' }), markdown.telemetry({ path: 'TELEMETRY.md' }));

void supportTriage.start();
