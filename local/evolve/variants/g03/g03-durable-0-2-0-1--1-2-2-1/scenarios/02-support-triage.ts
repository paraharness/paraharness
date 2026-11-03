import { z } from 'zod';
import { H } from 'harness-dsl';
import { zendesk } from 'harness-dsl/zendesk';
import { anthropic } from 'harness-dsl/anthropic';
import { claudeCode } from 'harness-dsl/claude-code';
import { sqlite } from 'harness-dsl/sqlite';
import { jsonl } from 'harness-dsl/jsonl';
import { markdown } from 'harness-dsl/markdown';

const helpdeskToken = H.env('ZENDESK_TOKEN');
const helpdeskStore = zendesk.store({ subdomain: 'acme', token: helpdeskToken });

const quota = sqlite.quota('support-quota', { path: '.harness/quota.sqlite' });
const apiAccount = anthropic.account('support-api', { apiKey: H.env('ANTHROPIC_API_KEY'), quota });
const apiPool = H.pool('support-api').accounts(apiAccount);
const haiku = anthropic.model('haiku', { id: 'claude-haiku-4-5' });
const sonnet = anthropic.model('sonnet', { id: 'claude-sonnet-4-5' });

const category = H.facet('category', ['billing', 'refund', 'technical', 'account', 'other']);

const conversationSchema = z.object({
  ticketId: z.string(),
  subject: z.string(),
  message: z.string(),
  customerEmail: z.string(),
  slaDueAt: z.string(),
  reviewerNotes: z.array(z.string()),
});

const fresh = H.state('new', 'pending');
const sent = H.terminal('sent', 'success');
const closedByCustomer = H.terminal('closed-by-customer', 'neutral');
const escalated = H.terminal('escalated', 'failure');

const conversation = H.kind('Conversation')
  .attributes(conversationSchema)
  .states(fresh, sent, closedByCustomer, escalated)
  .initial(fresh)
  .key(attrs => attrs.ticketId);

const approval = H.halt('reply-approval').decision(z.object({
  approved: z.boolean(),
  editedReply: z.string().optional(),
  notes: z.string().optional(),
}));
const costCeiling = H.halt('conversation-cost-ceiling').decision(H.ceilingDecision);

const classifierRole = H.role('classifier').intents('read').instructions('Assign exactly one category to the conversation.');
const drafterRole = H.role('drafter').intents('read').instructions('Draft a reply the customer can act on.');
const reviewerRole = H.role('reviewer').intents('record').instructions('Approve, edit or reject outgoing replies.');

const classifier = H.seat('classifier')
  .role(classifierRole)
  .model(haiku)
  .pool(apiPool)
  .output(z.object({ category: category.schema }));

const drafter = H.seat('drafter')
  .role(drafterRole)
  .model(sonnet)
  .pool(apiPool)
  .output(z.object({ reply: z.string() }));

const approvals = H.metric('approval-rate', H.when.decision(conversation, approval)).samples(event => [{
  hit: event.decision.approved,
  model: event.modelOf(drafter),
  facets: [category.of(event.facet(category) ?? 'other')],
}]);

const safeCategory = H.policy.halt('safe-category-skips-approval', conversation, approval).decide(ctx => {
  const value = ctx.facet(category);
  if (value === undefined) return undefined;
  const record = ctx.metrics.rate(approvals, { of: conversation, facets: [category.of(value)] });
  return record.samples >= 200 && record.hits === record.samples ? { approved: true } : undefined;
});

const sendReply = H.command('send-reply')
  .input(z.object({ ticketId: z.string(), reply: z.string() }))
  .argv(input => ['./bin/send-reply', '--ticket', input.ticketId, '--body', input.reply]);

const triage = H.flow('triage')
  .input(conversationSchema)
  .step('classify', classifier, ctx => ({
    task: `Classify this conversation.\nSubject: ${ctx.unit.attributes.subject}\n${ctx.unit.attributes.message}`,
  }))
  .step('draft', drafter, ctx => ({
    task: `Draft a reply.\nSubject: ${ctx.unit.attributes.subject}\n${ctx.unit.attributes.message}\nReviewer notes: ${ctx.unit.attributes.reviewerNotes.join('; ')}`,
    skills: [ctx.steps.classify.category],
  }))
  .halt('approval', approval, {
    ask: ctx => ctx.steps.draft.reply,
    skip: safeCategory,
    facets: ctx => [category.of(ctx.steps.classify.category)],
  })
  .exit('rejected', {
    when: ctx => ctx.steps.approval.approved === false,
    update: ctx => ({ reviewerNotes: [...ctx.unit.attributes.reviewerNotes, ctx.steps.approval.notes ?? 'reply rejected'] }),
  })
  .step('send', sendReply, ctx => ({
    ticketId: ctx.unit.attributes.ticketId,
    reply: ctx.steps.approval.editedReply ?? ctx.steps.draft.reply,
  }), { afterCrash: 'park' })
  .exit('sent');

const customerReplied = H.signal('customer-replied').payload(z.object({ message: z.string() }));
const customerClosed = H.signal('customer-closed');
const escalate = H.signal('escalate');

const slaHours = { low: 48, normal: 24, high: 8, urgent: 2 };

const conversationLane = H.lane('conversations', conversation)
  .supply(
    [
      zendesk.webhook({ port: H.slot.port(0), path: '/helpdesk', secret: H.env('ZENDESK_WEBHOOK_SECRET') }),
      zendesk.poll({ subdomain: 'acme', token: helpdeskToken, everyMinutes: 10 }),
    ],
    (event, to) => {
      if (event.type === 'created') {
        return to.create({
          ticketId: event.ticketId,
          subject: event.subject,
          message: event.message,
          customerEmail: event.customerEmail,
          slaDueAt: new Date(event.createdAt.getTime() + slaHours[event.priority] * 3600000).toISOString(),
          reviewerNotes: [],
        });
      }
      if (event.status === 'solved' || event.status === 'closed') return to.signal(customerClosed, event.ticketId, {});
      if (event.type === 'replied') return to.signal(customerReplied, event.ticketId, { message: event.message });
      return to.skip();
    },
  )
  .handler(triage, { exits: { rejected: { to: fresh, bound: { times: 3, to: escalated } }, sent } })
  .store(helpdeskStore)
  .retry({ maxAttempts: 3, backoff: 'exponential', initialDelayMs: 30000, exhausted: escalated })
  .ceiling({ maxUsd: 0.4, onExceed: costCeiling })
  .on(customerReplied, {
    update: (attrs, payload) => ({ ...attrs, message: payload.message }),
    enter: fresh,
    at: ['approval'],
  })
  .on(customerClosed, { enter: closedByCustomer })
  .on(escalate, { enter: escalated });

const escalationSchema = z.object({ ticketId: z.string(), reason: z.string() });
const awaitingHuman = H.state('awaiting-human', 'pending');
const handled = H.terminal('handled', 'success');
const unhandled = H.terminal('unhandled', 'failure');
const escalation = H.kind('Escalation')
  .attributes(escalationSchema)
  .states(awaitingHuman, handled, unhandled)
  .initial(awaitingHuman)
  .key(attrs => attrs.ticketId);

const handleEscalation = H.halt('handle-escalation').decision(z.object({ resolution: z.string() }));

const escalationFlow = H.flow('escalation')
  .input(escalationSchema)
  .halt('handle', handleEscalation, { ask: ctx => `Ticket ${ctx.unit.attributes.ticketId}: ${ctx.unit.attributes.reason}` })
  .exit('handled');

const escalationLane = H.lane('escalations', escalation)
  .handler(escalationFlow, { exits: { handled } })
  .store(helpdeskStore)
  .retry({ maxAttempts: 2, exhausted: unhandled });

const breachEscalates = H.trigger('sla-breach-escalates')
  .on(H.when.timer(conversationLane, { reads: ['slaDueAt'], at: view => new Date(view.attributes.slaDueAt) }))
  .create(escalationLane, event => ({
    ticketId: event.unit.attributes.ticketId,
    reason: `SLA breached at ${event.at.toISOString()}`,
  }))
  .signal(escalate, conversationLane, event => ({ key: event.unit.key, payload: {} }));

const taste = H.memory('reply-taste', 'taste');
const experience = H.memory('support-experience', 'experience');

const tasteJournal = H.journal('reply-taste', taste)
  .store(jsonl.memoryStore({ path: 'memory/taste.jsonl' }))
  .recall({ by: 'specificity', limit: 15 })
  .readBy(drafterRole)
  .recordedBy(reviewerRole);

const experienceJournal = H.journal('support-experience', experience)
  .store(jsonl.memoryStore({ path: 'memory/experience.jsonl' }))
  .recall({ by: 'specificity', limit: 10 })
  .readBy(drafterRole);

const editsBecomeTaste = H.trigger('reviewer-edits-become-taste')
  .on(H.when.decision(conversation, approval))
  .record(tasteJournal, event => event.decision.editedReply === undefined ? undefined : {
    text: `When replying in the ${event.facet(category) ?? 'other'} category, write like this reviewer edit: ${event.decision.editedReply}, because the reviewer rewrote the draft this way`,
    when: { kinds: [conversation], roles: [drafterRole] },
    status: 'candidate',
  });

const scheduler = H.scheduler('support')
  .expedite(escalationLane)
  .fixedDate(conversationLane, unit => new Date(unit.attributes.slaDueAt));

const reviewerDesk = claudeCode.supervisor('reviewer-desk', {
  grants: [
    H.ops.workRead,
    H.ops.resolve(approval, handleEscalation, costCeiling),
    H.ops.memoryRead,
    H.ops.memoryWrite,
    H.ops.memoryCurate,
    H.ops.telemetryRead,
  ],
});

export const supportTriage = H.harness('support-triage')
  .ledger(sqlite.ledger({ path: '.harness/ledger.sqlite' }))
  .lanes(conversationLane, escalationLane)
  .journals(tasteJournal, experienceJournal)
  .triggers(breachEscalates, editsBecomeTaste)
  .metrics(approvals)
  .scheduler(scheduler)
  .clients(reviewerDesk)
  .observers(markdown.board({ path: 'BOARD.md' }), markdown.telemetry({ path: 'TELEMETRY.md' }));

void supportTriage.start();
