import { z } from 'zod';
import { H } from 'harness-dsl';
import * as sqlite from 'harness-dsl/sqlite';
import * as jsonl from 'harness-dsl/jsonl';
import * as claudeCode from 'harness-dsl/claude-code';
import * as anthropic from 'harness-dsl/anthropic';
import * as zendesk from 'harness-dsl/zendesk';
import * as markdown from 'harness-dsl/markdown';

const New = H.state('New', 'pending');
const Classifying = H.state('Classifying', 'active');
const Drafting = H.state('Drafting', 'active');
const AwaitingApproval = H.state('AwaitingApproval', 'active');
const Sent = H.state('Sent', 'terminal', 'success');
const ClosedByCustomer = H.state('ClosedByCustomer', 'terminal', 'neutral');
const Escalated = H.state('Escalated', 'terminal', 'failure');

const EscalationOpen = H.state('EscalationOpen', 'pending');
const EscalationHandling = H.state('EscalationHandling', 'active');
const EscalationResolved = H.state('EscalationResolved', 'terminal', 'success');

const conversationKind = H.work('Conversation')
  .attributes({ ticketId: z.number(), category: z.string(), slaDueAt: z.number() })
  .fields({ subject: z.string(), message: z.string(), requesterEmail: z.string() })
  .states([New, Classifying, Drafting, AwaitingApproval, Sent, ClosedByCustomer, Escalated])
  .events({ customerReplied: { message: z.string() }, customerClosed: {} })
  .timers(t => ({ slaBreach: t.attribute('slaDueAt') }))
  .key(unit => String(unit.attributes.ticketId));

const escalationKind = H.work('Escalation')
  .attributes({ ticketId: z.number(), reason: z.string() })
  .states([EscalationOpen, EscalationHandling, EscalationResolved])
  .key(unit => `escalation:${unit.attributes.ticketId}`);

const apiAccount = anthropic.account('anthropic-api', { apiKey: H.env('ANTHROPIC_API_KEY') });
const haiku = anthropic.model('claude-haiku-4-5');
const sonnet = anthropic.model('claude-sonnet-4-5');
const opus = anthropic.model('claude-opus-4-1');

const approvalDecision = H.decision('replyApproval', {
  approved: z.boolean(),
  revisedBody: z.string(),
  note: z.string(),
});

const approvalRate = H.metric('replyApprovalRate').of(approvalDecision).hit(decision => decision.approved);

const drafterModel = H.policy.model('drafterModel', [sonnet, opus], c => {
  const unit = c.unitOf(conversationKind);
  if (unit === null) return sonnet;
  const cheaper = c.metrics.read(approvalRate, {
    model: sonnet,
    where: { category: unit.attributes.category },
    window: { days: 30 },
  });
  return cheaper.n >= 30 && cheaper.rate !== null && cheaper.rate < 0.8 ? opus : sonnet;
});

const bySpecificityAndTrack = H.policy.recall('bySpecificityAndTrack', c =>
  [...c.candidates]
    .sort((a, b) =>
      b.specificity - a.specificity ||
      b.track.succeeded / Math.max(1, b.track.present) - a.track.succeeded / Math.max(1, a.track.present))
    .slice(0, c.limit));

const toneJournal = H.journal('toneTaste', H.memory.taste('tone').curated())
  .store(jsonl.memory('support/memory/tone.jsonl'))
  .recall(bySpecificityAndTrack);

const replyJournal = H.journal('replyExperience', H.memory.experience('replyLessons'))
  .store(jsonl.memory('support/memory/replies.jsonl'))
  .recall(bySpecificityAndTrack);

const classifierRole = H.role('classifier')
  .intents(['read'])
  .instructions('Classify the customer conversation into one support category.')
  .input({ subject: z.string(), message: z.string() })
  .output({ category: z.string(), confidence: z.number() });

const drafterRole = H.role('drafter')
  .intents(['read', 'search'])
  .instructions('Draft the reply to the customer in the house tone.')
  .input({ category: z.string(), message: z.string() })
  .output({ body: z.string() });

const classifier = H.agent('classifier', classifierRole).model(haiku).pool(apiAccount);
const drafter = H.agent('drafter', drafterRole)
  .model(drafterModel)
  .pool(apiAccount)
  .recalls([toneJournal, replyJournal]);

const helpdesk = { subdomain: 'acme', token: H.env('ZENDESK_TOKEN') };
const sendReply = zendesk.reply('sendReply', helpdesk);

function latestMessage(original: string, replies: readonly { readonly payload: { readonly message: string } }[]): string {
  return replies.reduce<string>((_, reply) => reply.payload.message, original);
}

function conversationFrom(ticket: zendesk.ZendeskTicket) {
  return {
    attributes: {
      ticketId: ticket.id,
      category: 'unclassified',
      slaDueAt: ticket.slaDueAt === null ? ticket.updatedAt + 4 * 60 * 60 * 1000 : ticket.slaDueAt,
    },
    fields: { subject: ticket.subject, message: ticket.latestComment, requesterEmail: ticket.requesterEmail },
  };
}

const triageFlow = H.flow('triage')
  .requires({ ticketId: z.number(), subject: z.string(), message: z.string() })
  .events({ customerReplied: { message: z.string() } })
  .step('classify', classifier, c => ({
    subject: c.input.subject,
    message: latestMessage(c.input.message, c.events.customerReplied),
  }))
  .sets({ category: z.string() }, c => ({ category: c.out.classify.category }))
  .mark('drafting')
  .step('draft', drafter, c => ({
    category: c.out.classify.category,
    message: latestMessage(c.input.message, c.events.customerReplied),
  }))
  .mark('awaitingApproval')
  .halt('approval', approvalDecision, {
    ask: c => `Approve the reply to ticket ${c.input.ticketId} (${c.out.classify.category}):\n\n${c.out.draft.body}`,
  })
  .exit('rejected', c => !c.out.approval.approved)
  .step('send', sendReply, c => ({
    ticketId: c.input.ticketId,
    body: c.out.approval.revisedBody === '' ? c.out.draft.body : c.out.approval.revisedBody,
  }))
  .ends(['sent'], () => 'sent');

const resolutionDecision = H.decision('escalationResolution', { resolution: z.string() });

const escalationFlow = H.flow('humanEscalation')
  .requires({ ticketId: z.number(), reason: z.string() })
  .halt('resolution', resolutionDecision, {
    ask: c => `Ticket ${c.input.ticketId} escalated (${c.input.reason}). Take it over and record the resolution.`,
  })
  .ends(['resolved'], () => 'resolved');

const conversations = H.lane('conversations', conversationKind)
  .supply([
    zendesk.webhook(
      conversationKind,
      { ...helpdesk, port: H.slot.port(1), signingSecret: H.env('ZENDESK_SIGNING_SECRET') },
      (event, supply) => {
        if (event.type === 'ticket.created') return supply.create(conversationFrom(event.ticket));
        if (event.type === 'comment.added' && event.fromCustomer) {
          return supply.event(String(event.ticket.id), 'customerReplied', { message: event.ticket.latestComment });
        }
        if (event.type === 'ticket.solved') return supply.event(String(event.ticket.id), 'customerClosed', {});
        return null;
      },
    ),
    zendesk.poll(conversationKind, H.time.every({ minutes: 15 }), helpdesk, (ticket, supply) =>
      supply.create(conversationFrom(ticket))),
  ])
  .store(zendesk.store(conversationKind, {
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
  .handler(triageFlow, {
    states: { drafting: Drafting, awaitingApproval: AwaitingApproval, rejected: New, sent: Sent },
    opens: Classifying,
    skips: {
      approval: {
        name: 'provenSafeCategory',
        when: c => {
          const record = c.metrics.read(approvalRate, {
            where: { category: c.unit.attributes.category },
            window: 'all',
          });
          return record.hits >= 200 && record.hits === record.n;
        },
        decision: { approved: true, revisedBody: '', note: '' },
      },
    },
  })
  .budget({ maxUsdPerUnit: 0.4, onExceed: 'halt' })
  .retry(H.retry.exponential({ maxRetries: 2, initialDelayMs: 30000 }))
  .wip(10)
  .reacts({
    customerReplied: H.reaction(New).from([Classifying, Drafting, AwaitingApproval, Sent]).cancels(),
    customerClosed: H.reaction(ClosedByCustomer).from([New, Classifying, Drafting, AwaitingApproval]).cancels(),
    slaBreach: H.reaction(Escalated).from([New, Classifying, Drafting, AwaitingApproval]).cancels(),
  });

const escalations = H.lane('escalations', escalationKind)
  .supply([H.supply.operator()])
  .handler(escalationFlow, { states: { resolved: EscalationResolved }, opens: EscalationHandling });

const slaBreachEscalates = H.trigger('slaBreachEscalates', H.on.event(conversations, 'slaBreach'))
  .where(e => e.stateBefore !== Sent.name && e.stateBefore !== ClosedByCustomer.name && e.stateBefore !== Escalated.name)
  .creates(e => escalations.unit({
    attributes: { ticketId: e.unit.attributes.ticketId, reason: 'SLA breached' },
  }));

const reviewerNotesBecomeTaste = H.trigger('reviewerNotesBecomeTaste', H.on.step(conversations, 'approval'))
  .where(e => e.status === 'succeeded' && e.output.note !== '')
  .records(toneJournal, e => [{
    rule: e.output.note,
    because: `the reviewer revised a ${e.unit.attributes.category} reply to say so`,
    when: { roles: [drafterRole], attributes: { category: e.unit.attributes.category } },
  }]);

const timeToBreach = H.policy.schedule('timeToBreach', c => ({
  start: c.order(
    candidate => candidate.is(escalations) ? 0 : 1,
    candidate => candidate.is(conversations) ? candidate.unit.attributes.slaDueAt : candidate.enqueuedAt,
  ),
}));

const reviewerAccess = H.access('reviewer').allows([
  H.ops.readWork,
  H.ops.createWork,
  H.ops.sendEvents,
  H.ops.resolveBlocks,
  H.ops.readMemory,
  H.ops.writeMemory,
  H.ops.curateMemory,
  H.ops.readTelemetry,
]);

export const supportTriage = H.harness('support-triage')
  .ledger(sqlite.ledger('support/ledger.db'))
  .lanes([conversations, escalations])
  .triggers([slaBreachEscalates, reviewerNotesBecomeTaste])
  .schedule(timeToBreach)
  .clients([claudeCode.supervisor('reviewer', reviewerAccess, { port: H.slot.port(0) })])
  .projections([markdown.board('support/BOARD.md'), markdown.telemetry('support/TELEMETRY.md')]);
