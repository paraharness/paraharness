import { z } from 'zod';
import { H } from 'harness-dsl';
import * as sqlite from 'harness-dsl/sqlite';
import * as jsonl from 'harness-dsl/jsonl';
import * as claudeCode from 'harness-dsl/claude-code';
import * as anthropic from 'harness-dsl/anthropic';
import * as zendesk from 'harness-dsl/zendesk';
import * as markdown from 'harness-dsl/markdown';
import type { ZendeskTicket } from 'harness-dsl/zendesk';

const New = H.state('New', 'pending');
const Classifying = H.state('Classifying', 'active');
const Drafting = H.state('Drafting', 'active');
const AwaitingApproval = H.state('AwaitingApproval', 'active');
const Sent = H.state('Sent', 'terminal', 'success');
const ClosedByCustomer = H.state('ClosedByCustomer', 'terminal', 'neutral');
const Escalated = H.state('Escalated', 'terminal', 'failure');

const Raised = H.state('Raised', 'pending');
const Handling = H.state('Handling', 'active');
const EscalationResolved = H.state('EscalationResolved', 'terminal', 'success');
const HandedOff = H.state('HandedOff', 'terminal', 'neutral');

const Conversation = H.work('Conversation')
  .attributes({ ticketId: z.number(), category: z.string(), slaDueAt: z.number() })
  .fields({ subject: z.string(), message: z.string(), requesterEmail: z.string() })
  .states([New, Classifying, Drafting, AwaitingApproval, Sent, ClosedByCustomer, Escalated])
  .events({ customerReplied: { message: z.string() } })
  .timers(t => ({ slaBreach: t.attribute('slaDueAt') }))
  .key(u => String(u.attributes.ticketId));

const Escalation = H.work('Escalation')
  .attributes({ ticketId: z.number(), reason: z.string() })
  .states([Raised, Handling, EscalationResolved, HandedOff])
  .key(u => `escalation-${u.attributes.ticketId}`);

const tone = H.memory.taste('support-tone').curated();
const lessons = H.memory.experience('support-experience');

const mostSpecificFirst = H.policy.recall('most-specific-first', c =>
  [...c.candidates]
    .sort((a, b) =>
      b.specificity - a.specificity ||
      b.track.succeeded / Math.max(1, b.track.present) - a.track.succeeded / Math.max(1, a.track.present))
    .slice(0, c.limit));

const toneJournal = H.journal('support-tone', tone).store(jsonl.memory('memory/tone.jsonl')).recall(mostSpecificFirst);
const lessonJournal = H.journal('support-experience', lessons).store(jsonl.memory('memory/experience.jsonl')).recall(mostSpecificFirst);

const apiAccount = anthropic.account('support-api', { apiKey: H.env('ANTHROPIC_API_KEY') });
const cheap = anthropic.model('claude-haiku-4-5');
const strong = anthropic.model('claude-sonnet-4-5');

const classifierRole = H.role('classifier')
  .instructions('Classify the customer message into one support category.')
  .input({ subject: z.string(), message: z.string() })
  .output({ category: z.string() });

const drafterRole = H.role('drafter')
  .intents(['read', 'remember'])
  .instructions('Draft a reply in the house tone. Apply the reviewer notes when present.')
  .input({ message: z.string(), category: z.string(), notes: z.string() })
  .output({ reply: z.string() });

const classifier = H.agent('classifier', classifierRole).model(cheap).pool(apiAccount);
const drafter = H.agent('drafter', drafterRole).model(strong).pool(apiAccount).recalls([toneJournal, lessonJournal]);

const Approval = H.decision('reply-approval', {
  approved: z.boolean(),
  edited: z.string().nullable(),
  notes: z.string(),
});
const EscalationOutcome = H.decision('escalation-outcome', { resolved: z.boolean(), notes: z.string() });

const helpdesk = { subdomain: 'acme', token: H.env('ZENDESK_TOKEN') };
const sendReply = zendesk.reply('send-reply', helpdesk);

const approvalRate = H.metric('approval-rate').of(Approval).hit(decision => decision.approved);

const triage = H.flow('triage')
  .requires({ ticketId: z.number(), category: z.string(), subject: z.string(), message: z.string() })
  .events({ customerReplied: { message: z.string() } })
  .step('classify', classifier, c => ({
    subject: c.input.subject,
    message: c.events.customerReplied.reduce((latest, reply) => reply.payload.message, c.input.message),
  }))
  .sets({ category: z.string() }, c => ({ category: c.out.classify.category }))
  .mark('drafting')
  .loop(
    'review',
    { carry: { notes: z.string() }, rounds: () => 3 },
    round => round
      .step('draft', drafter, c => ({
        message: c.events.customerReplied.reduce((latest, reply) => reply.payload.message, c.input.message),
        category: c.input.category,
        notes: c.carry === null ? '' : c.carry.notes,
      }))
      .mark('awaitingApproval')
      .halt('approval', Approval, { ask: c => `Approve this ${c.input.category} reply?\n\n${c.out.draft.reply}` }),
    last => last.approval.approved ? null : { notes: last.approval.notes },
  )
  .exit('escalate', c => !c.out.review.last.approval.approved)
  .step('send', sendReply, c => ({
    ticketId: c.input.ticketId,
    body: c.out.review.last.approval.edited ?? c.out.review.last.draft.reply,
  }), { restart: 'park' })
  .ends(['sent'], () => 'sent');

const escalationHandling = H.flow('escalation-handling')
  .requires({ ticketId: z.number(), reason: z.string() })
  .halt('outcome', EscalationOutcome, { ask: c => `Ticket ${c.input.ticketId} escalated: ${c.input.reason}` })
  .ends(['resolved', 'handedOff'], c => c.out.outcome.resolved ? 'resolved' : 'handedOff');

const conversationFrom = (ticket: ZendeskTicket) => ({
  attributes: {
    ticketId: ticket.id,
    category: 'unclassified',
    slaDueAt: ticket.slaDueAt ?? ticket.updatedAt + 4 * 3600000,
  },
  fields: { subject: ticket.subject, message: ticket.latestComment, requesterEmail: ticket.requesterEmail },
});

const conversationLane = H.lane('conversations', Conversation)
  .supply([
    zendesk.webhook(Conversation, { ...helpdesk, port: H.slot.port(1), signingSecret: H.env('ZENDESK_SIGNING_SECRET') }, (event, to) =>
      event.type === 'ticket.created' ? to.create(conversationFrom(event.ticket))
        : event.type === 'comment.added' && event.fromCustomer
          ? to.event(String(event.ticket.id), 'customerReplied', { message: event.ticket.latestComment })
          : null),
    zendesk.poll(Conversation, H.time.every({ minutes: 10 }), helpdesk, (ticket, to) =>
      ticket.status === 'new' || ticket.status === 'open' ? to.create(conversationFrom(ticket)) : null),
  ])
  .store(zendesk.store(Conversation, {
    ...helpdesk,
    status: {
      New: 'new',
      Classifying: 'open',
      Drafting: 'open',
      AwaitingApproval: 'pending',
      Sent: 'solved',
      ClosedByCustomer: 'closed',
      Escalated: 'open',
    },
  }))
  .budget({ maxUsdPerUnit: 0.4, onExceed: 'halt' })
  .reacts({
    customerReplied: H.reaction(New).from([Classifying, Drafting, AwaitingApproval]).cancels(),
    slaBreach: H.reaction(Escalated).from([New, Classifying, Drafting, AwaitingApproval]).cancels(),
  })
  .handler(triage, {
    ends: { sent: Sent, escalate: Escalated },
    marks: { drafting: Drafting, awaitingApproval: AwaitingApproval },
    skips: {
      approval: {
        name: 'proven-safe-category',
        when: g => {
          const record = g.metrics.read(approvalRate, {
            kind: Conversation,
            where: { category: g.unit.attributes.category },
            window: 'ever',
          });
          return record.n >= 200 && record.hits === record.n;
        },
        decision: { approved: true, edited: null, notes: '' },
      },
    },
  });

const escalationLane = H.lane('escalations', Escalation)
  .handler(escalationHandling, { ends: { resolved: EscalationResolved, handedOff: HandedOff } });

const breachEscalates = H.trigger('sla-breach-escalates', H.on.event(conversationLane, 'slaBreach'))
  .where(e => e.stateBefore !== Sent.name && e.stateBefore !== ClosedByCustomer.name)
  .creates(e => escalationLane.unit({
    attributes: { ticketId: e.unit.attributes.ticketId, reason: `SLA breached at ${new Date(e.payload.deadline).toISOString()}` },
  }));

const reviewerNotesBecomeTaste = H.trigger('reviewer-notes-become-taste', H.on.step(conversationLane, 'review'))
  .where(e => e.output.last.approval.notes.length > 0)
  .records(toneJournal, e => [{
    rule: `when drafting a ${e.unit.attributes.category} reply, ${e.output.last.approval.notes}`,
    because: 'the reviewer edited a draft to say so',
    when: { kinds: [Conversation], roles: [drafterRole], attributes: { category: e.unit.attributes.category } },
  }]);

const timeToBreach = H.policy.schedule('escalations-then-time-to-breach', c => ({
  start: c.candidates
    .map(candidate => ({
      candidate,
      deadline: candidate.is(escalationLane) ? 0
        : candidate.is(conversationLane) ? candidate.unit.attributes.slaDueAt
        : Number.MAX_SAFE_INTEGER,
    }))
    .sort((a, b) => a.deadline - b.deadline)
    .map(ranked => ranked.candidate),
}));

const reviewerAccess = H.access('reviewer')
  .allows([
    H.ops.readWork,
    H.ops.resolveBlocks,
    H.ops.sendEvents,
    H.ops.readMemory,
    H.ops.writeMemory,
    H.ops.curateMemory,
    H.ops.readTelemetry,
  ]);

export const harness = H.harness('support-triage')
  .ledger(sqlite.ledger('.harness/support.db'))
  .lanes([conversationLane, escalationLane])
  .triggers([breachEscalates, reviewerNotesBecomeTaste])
  .schedule(timeToBreach)
  .clients([claudeCode.supervisor('reviewer', reviewerAccess, { port: H.slot.port(0) })])
  .projections([markdown.board('BOARD.md'), markdown.telemetry('TELEMETRY.md')]);
