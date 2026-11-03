import { z } from 'zod';
import { H } from 'harness-dsl';
import type { Model, SupplyOf } from 'harness-dsl';
import * as anthropic from 'harness-dsl/anthropic';
import * as zendesk from 'harness-dsl/zendesk';
import * as sqlite from 'harness-dsl/sqlite';
import * as jsonl from 'harness-dsl/jsonl';
import * as claudeCode from 'harness-dsl/claude-code';
import * as markdown from 'harness-dsl/markdown';

const fourHoursMs = 4 * 3_600_000;

const New = H.state('new', 'pending');
const Classifying = H.state('classifying', 'active');
const Drafting = H.state('drafting', 'active');
const AwaitingApproval = H.state('awaiting approval', 'active');
const Sent = H.state('sent', 'active');
const ClosedByCustomer = H.state('closed by customer', 'succeeded');
const Escalated = H.state('escalated', 'concluded');
const Failed = H.state('failed', 'failed');

const Conversation = H.work('Conversation')
  .attributes({ ticketId: z.number(), category: z.string(), slaDueAt: z.number() })
  .fields({ subject: z.string(), latestMessage: z.string(), customerEmail: z.string() })
  .states([New, Classifying, Drafting, AwaitingApproval, Sent, ClosedByCustomer, Escalated, Failed])
  .signals({ customerReplied: { message: z.string() }, customerClosed: {} })
  .timers(t => ({ slaBreach: t.attribute('slaDueAt') }))
  .key(unit => String(unit.attributes.ticketId));

const EscalationOpen = H.state('escalation open', 'pending');
const EscalationResolved = H.state('escalation resolved', 'succeeded');
const EscalationFailed = H.state('escalation failed', 'failed');

const Escalation = H.work('Escalation')
  .attributes({ ticketId: z.number(), reason: z.string() })
  .states([EscalationOpen, EscalationResolved, EscalationFailed])
  .key(unit => String(unit.attributes.ticketId));

const helpdesk = { subdomain: 'acme', token: H.env('ZENDESK_TOKEN') };
const apiAccount = anthropic.account('anthropic-api', { apiKey: H.env('ANTHROPIC_API_KEY') });
const haiku = anthropic.model('claude-haiku-4-5');
const sonnet = anthropic.model('claude-sonnet-4-5');
const opus = anthropic.model('claude-opus-4-1');

const specificThenProven = H.policy.recall('specific-then-proven', c =>
  [...c.candidates]
    .sort((a, b) => b.specificity - a.specificity || b.track.succeeded - a.track.succeeded)
    .slice(0, c.limit),
);

const ReplyTaste = H.memory.taste('reply-taste').curated();
const SupportExperience = H.memory.experience('support-experience');
const tasteJournal = H.journal('reply-taste-journal', ReplyTaste)
  .store(jsonl.memory('memory/taste.jsonl'))
  .recall(specificThenProven);
const experienceJournal = H.journal('support-experience-journal', SupportExperience)
  .store(jsonl.memory('memory/experience.jsonl'))
  .recall(specificThenProven);

const drafterModel = H.policy.model('drafter-model', [sonnet, opus], (c): Model => {
  const cheaper = c.metrics.read(replyApproval, { lane: conversationLane, model: sonnet, windowDays: 30 });
  return cheaper.n >= 50 && cheaper.rate !== null && cheaper.rate < 0.9 ? opus : sonnet;
});

const safeCategory = H.policy.gate('safe-category', (c): boolean => {
  const category = c.unit ? String(c.unit.attributes['category']) : '';
  const approvals = c.metrics.read(replyApproval, { lane: conversationLane, where: { category }, windowDays: 365 });
  return approvals.n >= 200 && approvals.hits === approvals.n;
});

const classifierRole = H.role('classifier')
  .intents(['read'])
  .instructions('Assign the conversation one support category.')
  .input({ subject: z.string(), message: z.string() })
  .output({ category: z.string() });

const drafterRole = H.role('drafter')
  .intents(['read'])
  .instructions('Draft the reply the support team would send.')
  .input({ category: z.string(), subject: z.string(), message: z.string() })
  .output({ reply: z.string() });

const classifier = H.agent('classifier', classifierRole).model(haiku).pool(apiAccount);
const drafter = H.agent('drafter', drafterRole)
  .model(drafterModel)
  .pool(apiAccount)
  .recalls([tasteJournal, experienceJournal]);

const sendReply = zendesk.reply('send-reply', helpdesk);

const conversationFlow = H.flow('conversation')
  .requires({ ticketId: z.number(), subject: z.string(), latestMessage: z.string() })
  .mark('classifying')
  .step('classify', classifier, c => ({ subject: c.input.subject, message: c.input.latestMessage }))
  .sets({ category: z.string() }, c => ({ category: c.out.classify.category }))
  .mark('drafting')
  .step('draft', drafter, c => ({
    category: c.out.classify.category,
    subject: c.input.subject,
    message: c.input.latestMessage,
  }))
  .mark('awaitingApproval')
  .halt('approval', {
    ask: c => `Reply to "${c.input.subject}" (${c.out.classify.category}):\n\n${c.out.draft.reply}`,
    decision: { approved: z.boolean(), editedReply: z.string().optional() },
    skip: { when: safeCategory, decision: { approved: true } },
  })
  .exit('rejected', c => !c.out.approval.approved)
  .step('send', sendReply, c => ({ ticketId: c.input.ticketId, body: c.out.approval.editedReply ?? c.out.draft.reply }), {
    retry: H.retry.fixed({ maxRetries: 2, delayMs: 30_000 }),
  })
  .ends(['sent'], () => 'sent');

const escalationFlow = H.flow('escalation')
  .requires({ ticketId: z.number(), reason: z.string() })
  .halt('resolution', {
    ask: c => `Ticket ${c.input.ticketId} escalated: ${c.input.reason}. Resolve it in the helpdesk, then record the outcome.`,
    decision: { resolution: z.string() },
  })
  .ends(['resolved'], () => 'resolved');

const fromTicket = (ticket: zendesk.ZendeskTicket) => ({
  attributes: {
    ticketId: ticket.id,
    category: 'unclassified',
    slaDueAt: ticket.slaDueAt ?? ticket.updatedAt + fourHoursMs,
  },
  fields: { subject: ticket.subject, latestMessage: ticket.latestComment, customerEmail: ticket.requesterEmail },
});

const fromEvent = (event: zendesk.ZendeskEvent): SupplyOf<typeof Conversation> | null => {
  if (event.type === 'ticket.created') return { create: fromTicket(event.ticket) };
  if (event.type === 'comment.added' && event.fromCustomer) {
    return { key: String(event.ticket.id), signal: 'customerReplied', payload: { message: event.ticket.latestComment } };
  }
  if (event.type === 'ticket.solved') return { key: String(event.ticket.id), signal: 'customerClosed', payload: {} };
  return null;
};

const conversationLane = H.lane('conversations', Conversation)
  .supply([
    zendesk.webhook(
      Conversation,
      { ...helpdesk, port: H.slot.port(1), signingSecret: H.env('ZENDESK_SIGNING_SECRET') },
      fromEvent,
    ),
    zendesk.poll(Conversation, H.time.every({ minutes: 10 }), helpdesk, ticket => ({ create: fromTicket(ticket) })),
  ])
  .store(zendesk.store(Conversation, {
    ...helpdesk,
    status: {
      new: 'new',
      classifying: 'open',
      drafting: 'open',
      'awaiting approval': 'pending',
      sent: 'pending',
      'closed by customer': 'solved',
      escalated: 'on-hold',
    },
  }))
  .handler(conversationFlow, {
    states: {
      classifying: Classifying,
      drafting: Drafting,
      awaitingApproval: AwaitingApproval,
      rejected: New,
      sent: Sent,
      failed: Failed,
    },
  })
  .budget({ maxUsdPerUnit: 0.4, onExceed: 'halt' })
  .signals({
    customerReplied: H.move(New).from([Classifying, Drafting, AwaitingApproval, Sent]),
    customerClosed: H.move(ClosedByCustomer),
    slaBreach: H.move(Escalated).from([New, Classifying, Drafting, AwaitingApproval]),
  });

const escalationLane = H.lane('escalations', Escalation)
  .handler(escalationFlow, { states: { resolved: EscalationResolved, failed: EscalationFailed } });

const unansweredStates: readonly string[] = [New.name, Classifying.name, Drafting.name, AwaitingApproval.name];

const slaBreachEscalates = H.trigger('sla-breach-escalates', H.on.signal(conversationLane, 'slaBreach'))
  .where(event => unansweredStates.includes(event.unit.state))
  .creates(escalationLane, event => ({
    attributes: {
      ticketId: event.unit.attributes.ticketId,
      reason: `SLA breached at ${new Date(event.payload.firedAt).toISOString()} while ${event.unit.state}`,
    },
  }));

const reviewerEditsBecomeTaste = H.trigger('reviewer-edits-become-taste', H.on.step(conversationLane, 'approval'))
  .where(event => event.output.editedReply !== undefined)
  .records(tasteJournal, event => [{
    rule: `Write ${event.unit.attributes.category} replies the way the reviewer rewrote this one: "${event.output.editedReply ?? ''}"`,
    because: 'the reviewer edited the drafted reply before approving it',
    when: { kinds: [Conversation], attributes: { category: event.unit.attributes.category } },
  }]);

const timeToBreach = H.policy.schedule('time-to-breach', c => ({
  start: [...c.candidates].sort(
    (a, b) => (a.timers['slaBreach'] ?? Number.MAX_SAFE_INTEGER) - (b.timers['slaBreach'] ?? Number.MAX_SAFE_INTEGER),
  ),
}));

const replyApproval = H.metric('reply-approval').step(conversationFlow, 'approval').hit(decision => decision.approved);

const reviewerAccess = H.access('reviewer').allows([
  H.ops.readWork,
  H.ops.signalWork,
  H.ops.resolveBlocks,
  H.ops.readMemory,
  H.ops.writeMemory,
  H.ops.curateMemory,
  H.ops.readTelemetry,
]);

export const supportTriage = H.harness('support-triage')
  .ledger(sqlite.ledger('support-ledger.db'))
  .lanes([conversationLane, escalationLane])
  .triggers([slaBreachEscalates, reviewerEditsBecomeTaste])
  .schedule(timeToBreach)
  .clients([claudeCode.supervisor('reviewer-supervisor', reviewerAccess, { port: H.slot.port(0) })])
  .projections([markdown.board('BOARD.md'), markdown.telemetry('TELEMETRY.md')]);
