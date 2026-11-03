import { z } from 'zod';
import { H } from 'harness-dsl';
import { sqlite } from 'harness-dsl/sqlite';
import { jsonl } from 'harness-dsl/jsonl';
import { anthropic } from 'harness-dsl/anthropic';
import { claudeCode } from 'harness-dsl/claude-code';
import { zendesk } from 'harness-dsl/zendesk';
import { markdown } from 'harness-dsl/markdown';

const New = H.state('new', 'pending');
const Sent = H.terminal('sent', 'success');
const ClosedByCustomer = H.terminal('closed-by-customer', 'neutral');
const Escalated = H.terminal('escalated', 'failure');

const Raised = H.state('raised', 'pending');
const Handled = H.terminal('handled', 'success');
const Dropped = H.terminal('dropped', 'failure');

const category = H.facet('category', ['billing', 'refund', 'shipping', 'account', 'other']);

const conversation = z.object({
  ticketId: z.string(),
  subject: z.string(),
  message: z.string(),
  customerEmail: z.string(),
  slaDueAt: z.string(),
});

const escalation = z.object({ ticketId: z.string(), subject: z.string(), reason: z.string() });

const Conversation = H.kind('conversation')
  .attributes(conversation)
  .states(New, Sent, ClosedByCustomer, Escalated)
  .key(a => a.ticketId)
  .initial(New);

const Escalation = H.kind('escalation').attributes(escalation).states(Raised, Handled, Dropped).key(a => a.ticketId).initial(Raised);

const customerReplied = H.signal('customer-replied').payload(z.object({ message: z.string() }));
const customerClosed = H.signal('customer-closed');
const escalate = H.signal('escalate').payload(z.object({ reason: z.string() }));

const classifierRole = H.role('classifier').intents('read').instructions('Assign one category to the conversation.');
const drafterRole = H.role('drafter').intents('read').instructions('Draft a reply the customer can act on.');
const reviewerRole = H.role('reviewer').instructions('Approve, edit or reject outgoing replies.');

const taste = H.journal('support-taste', H.memory('tone', 'taste'))
  .store(jsonl.memoryStore({ path: 'memory/taste.jsonl' }))
  .recall({ by: 'specificity', limit: 10 })
  .readBy(drafterRole)
  .recordedBy(reviewerRole);

const experience = H.journal('support-experience', H.memory('support-lessons', 'experience'))
  .store(jsonl.memoryStore({ path: 'memory/experience.jsonl' }))
  .recall({ by: 'specificity', limit: 6 })
  .readBy(drafterRole);

const apiAccount = anthropic.account('anthropic-api', {
  apiKey: H.env('ANTHROPIC_API_KEY'),
  quota: sqlite.quota('support-quota', { path: '.harness/quota.db' }),
});
const supportPool = H.pool('support').accounts(apiAccount);

const haiku = anthropic.model('haiku', { id: 'claude-haiku-4-5' });
const sonnet = anthropic.model('sonnet', { id: 'claude-sonnet-4-5' });

const classifier = H.seat('classifier')
  .role(classifierRole)
  .model(haiku)
  .pool(supportPool)
  .output(z.object({ category: category.schema, summary: z.string() }));

const drafter = H.seat('drafter').role(drafterRole).model(sonnet).pool(supportPool);

const replyApproval = H.halt('reply-approval').decision(
  z.object({ approved: z.boolean(), editedReply: z.string().optional(), notes: z.string().optional() }),
);
const costCeiling = H.halt('conversation-cost-ceiling').decision(H.ceilingDecision);
const handleEscalation = H.halt('handle-escalation').decision(z.object({ resolution: z.string() }));

const approvals = H.metric('reply-approval', H.when.decision(Conversation, replyApproval)).samples(event =>
  event.resolvedBy === 'human'
    ? [{ hit: event.decision.approved, facets: event.facets, model: event.modelOf(drafter) }]
    : [],
);

const safeCategory = H.policy.halt('safe-category', Conversation, replyApproval).decide(ctx => {
  const value = ctx.facet(category);
  if (value === undefined) return undefined;
  const record = ctx.metrics.rate(approvals, { facets: [category.of(value)] });
  return record.samples >= 200 && record.hits === record.samples ? { approved: true } : undefined;
});

const sendReply = H.command('send-reply')
  .input(z.object({ ticketId: z.string(), reply: z.string() }))
  .argv(input => ['helpdesk-reply', '--ticket', input.ticketId, '--body', input.reply]);

const triage = H.flow('triage')
  .input(conversation)
  .step('classify', classifier, ctx => ({
    task: `Classify this customer message.\nSubject: ${ctx.unit.attributes.subject}\n${ctx.unit.attributes.message}`,
  }))
  .loop(
    'revise',
    { schema: z.string(), initial: '' },
    f =>
      f
        .step('draft', drafter, ctx => ({
          task: `Draft a reply.\nCustomer: ${ctx.unit.attributes.message}\nSummary: ${ctx.steps.classify.summary}\nReviewer notes: ${ctx.steps.revise}`,
          skills: [ctx.steps.classify.category],
        }))
        .halt('approve', replyApproval, {
          ask: ctx => `Approve this reply to ticket ${ctx.unit.attributes.ticketId}:\n${ctx.steps.draft}`,
          skip: safeCategory,
          facets: ctx => [category.of(ctx.steps.classify.category)],
        }),
    {
      max: 3,
      until: ctx => ctx.steps.approve.approved,
      next: ctx => ctx.steps.approve.notes ?? '',
    },
  )
  .exit('unapproved', ctx => !ctx.steps.approve.approved)
  .step(
    'send',
    sendReply,
    ctx => ({ ticketId: ctx.unit.attributes.ticketId, reply: ctx.steps.approve.editedReply ?? ctx.steps.draft }),
    { afterCrash: 'park' },
  )
  .exit('sent');

const slaHours = { low: 48, normal: 24, high: 8, urgent: 2 };
const helpdeskToken = H.env('ZENDESK_TOKEN');
const helpdeskStore = zendesk.store({ subdomain: 'acme', token: helpdeskToken });

const conversations = H.lane('conversations', Conversation)
  .supply(
    [
      zendesk.webhook({ port: H.slot.port(1), path: '/helpdesk', secret: H.env('ZENDESK_WEBHOOK_SECRET') }),
      zendesk.poll({ subdomain: 'acme', token: helpdeskToken, everyMinutes: 10 }),
    ],
    (event, to) => {
      if (event.type === 'created') {
        return to.create({
          ticketId: event.ticketId,
          subject: event.subject,
          message: event.message,
          customerEmail: event.customerEmail,
          slaDueAt: new Date(event.createdAt.getTime() + slaHours[event.priority] * 3_600_000).toISOString(),
        });
      }
      if (event.status === 'closed') return to.signal(customerClosed, event.ticketId, {});
      if (event.type === 'replied') return to.signal(customerReplied, event.ticketId, { message: event.message });
      return to.skip();
    },
  )
  .handler(triage, { exits: { unapproved: Escalated, sent: Sent } })
  .store(helpdeskStore)
  .retry({ maxAttempts: 2, backoff: 'exponential', initialDelayMs: 30_000, exhausted: Escalated })
  .on(customerReplied, {
    update: (attrs, payload) => ({ ...attrs, message: payload.message }),
    restart: 'classify',
    at: ['approve'],
  })
  .on(customerClosed, { enter: ClosedByCustomer })
  .on(escalate, { enter: Escalated })
  .ceiling({ maxUsd: 0.4, onExceed: costCeiling });

const postNote = H.command('post-internal-note')
  .input(z.object({ ticketId: z.string(), note: z.string() }))
  .argv(input => ['helpdesk-note', '--ticket', input.ticketId, '--body', input.note]);

const escalationFlow = H.flow('handle-escalation')
  .input(escalation)
  .halt('handle', handleEscalation, {
    ask: ctx => `Escalated ticket ${ctx.unit.attributes.ticketId} (${ctx.unit.attributes.subject}): ${ctx.unit.attributes.reason}`,
  })
  .step('note', postNote, ctx => ({ ticketId: ctx.unit.attributes.ticketId, note: ctx.steps.handle.resolution }))
  .exit('handled');

const escalations = H.lane('escalations', Escalation)
  .handler(escalationFlow, { exits: { handled: Handled } })
  .store(helpdeskStore)
  .retry({ maxAttempts: 2, exhausted: Dropped });

const slaBreachEscalates = H.trigger('sla-breach-escalates')
  .on(H.when.timer(conversations, { reads: ['slaDueAt'], at: view => new Date(view.attributes.slaDueAt) }))
  .signal(escalate, conversations, event => ({ key: event.unit.key, payload: { reason: 'sla-breached' } }));

const escalatedOpensEscalation = H.trigger('escalated-opens-escalation')
  .on(H.when.transition(conversations, { to: Escalated }))
  .create(escalations, event => ({
    ticketId: event.unit.attributes.ticketId,
    subject: event.unit.attributes.subject,
    reason: 'The conversation breached its SLA or no reply was approved.',
  }));

const reviewerEditsBecomeTaste = H.trigger('reviewer-edits-become-taste')
  .on(H.when.decision(Conversation, replyApproval))
  .record(taste, event =>
    event.decision.editedReply === undefined || event.resolvedBy !== 'human'
      ? undefined
      : {
          text: `When drafting replies, write like "${event.decision.editedReply}", because the reviewer edited a draft to read that way.`,
          when: { roles: [drafterRole] },
          status: 'candidate',
        },
  );

const scheduler = H.scheduler('support')
  .fixedDate(conversations, unit => new Date(unit.attributes.slaDueAt))
  .standard(escalations);

const supervisor = claudeCode.supervisor('reviewer-supervisor', {
  grants: [
    H.ops.workRead,
    H.ops.workSignal,
    H.ops.resolve(replyApproval, costCeiling, handleEscalation),
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
  .triggers(slaBreachEscalates, escalatedOpensEscalation, reviewerEditsBecomeTaste)
  .metrics(approvals)
  .scheduler(scheduler)
  .clients(supervisor)
  .observers(markdown.board({ path: 'BOARD.md' }));

void supportTriage.start();
