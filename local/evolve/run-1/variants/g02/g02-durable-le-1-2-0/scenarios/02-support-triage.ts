import { z } from 'zod';
import { H } from 'harness-dsl';
import type { Candidate, RecallCandidate } from 'harness-dsl/kernel';
import * as anthropic from 'harness-dsl/anthropic';
import * as claudeCode from 'harness-dsl/claude-code';
import * as zendesk from 'harness-dsl/zendesk';
import * as sqlite from 'harness-dsl/sqlite';
import * as jsonl from 'harness-dsl/jsonl';
import * as markdown from 'harness-dsl/markdown';

const hourMs = 60 * 60 * 1000;

export const New = H.state('New', 'pending');
export const Classifying = H.state('Classifying', 'active');
export const Drafting = H.state('Drafting', 'active');
export const AwaitingApproval = H.state('AwaitingApproval', 'active');
export const Sent = H.state('Sent', 'terminal', 'success');
export const ClosedByCustomer = H.state('ClosedByCustomer', 'terminal', 'neutral');
export const Escalated = H.state('Escalated', 'terminal', 'failure');

export const EscalationOpen = H.state('EscalationOpen', 'pending');
export const EscalationHandling = H.state('EscalationHandling', 'active');
export const EscalationResolved = H.state('EscalationResolved', 'terminal', 'success');

export const Conversation = H.work('Conversation')
  .attributes({ ticketId: z.number(), category: z.string(), slaDueAt: z.number() })
  .fields({ subject: z.string(), latestMessage: z.string(), requesterEmail: z.string() })
  .states([New, Classifying, Drafting, AwaitingApproval, Sent, ClosedByCustomer, Escalated])
  .events({ customerReplied: { message: z.string() }, solved: { solvedAt: z.number() } })
  .timers(t => ({ slaBreach: t.attribute('slaDueAt') }))
  .key(u => String(u.attributes.ticketId));

export const Escalation = H.work('Escalation')
  .attributes({ ticketId: z.number(), reason: z.string() })
  .states([EscalationOpen, EscalationHandling, EscalationResolved])
  .key(u => String(u.attributes.ticketId));

export const apiAccount = anthropic.account('anthropic-api', { apiKey: H.env('ANTHROPIC_API_KEY') });
export const haiku = anthropic.model('claude-haiku-4-5');
export const sonnet = anthropic.model('claude-sonnet-4-5');
export const opus = anthropic.model('claude-opus-4-1');

const proven = (x: RecallCandidate) => x.track.succeeded / Math.max(1, x.track.present);
export const specificThenProven = H.policy.recall('specific-then-proven', c =>
  [...c.candidates].sort((a, b) => b.specificity - a.specificity || proven(b) - proven(a)).slice(0, c.limit),
);

export const SupportTaste = H.memory.taste('support-taste').curated();
export const SupportExperience = H.memory.experience('support-experience');

export const tasteJournal = H.journal('support-taste', SupportTaste)
  .store(jsonl.memory('memory/taste.jsonl'))
  .recall(specificThenProven);
export const experienceJournal = H.journal('support-experience', SupportExperience)
  .store(jsonl.memory('memory/experience.jsonl'))
  .recall(specificThenProven);

export const replyApproval = H.decision('reply-approval', {
  approved: z.boolean(),
  edited: z.string().nullable(),
  notes: z.string(),
});
export const escalationOutcome = H.decision('escalation-outcome', { resolution: z.string() });

export const approvalRate = H.metric('reply-approval-rate').of(replyApproval).hit(decision => decision.approved);

export const classifierRole = H.role('classifier')
  .intents(['read'])
  .instructions('Classify the customer message into one support category.')
  .input({ subject: z.string(), message: z.string() })
  .output({ category: z.string() });

export const drafterRole = H.role('drafter')
  .intents(['read', 'remember'])
  .instructions('Draft a reply to the customer in the house tone.')
  .input({ category: z.string(), subject: z.string(), message: z.string() })
  .output({ reply: z.string() });

export const drafterModel = H.policy.model('drafter-model', [sonnet, opus], c => {
  const a = c.metrics.read(approvalRate, { model: sonnet, window: { days: 30 } });
  const b = c.metrics.read(approvalRate, { model: opus, window: { days: 30 } });
  if (a.n < 50 || b.n < 50) return a.n <= b.n ? sonnet : opus;
  return (a.rate ?? 0) >= (b.rate ?? 0) ? sonnet : opus;
});

export const classifier = H.agent('classifier', classifierRole).model(haiku).pool(apiAccount);
export const drafter = H.agent('drafter', drafterRole)
  .model(drafterModel)
  .pool(apiAccount)
  .recalls([tasteJournal, experienceJournal]);

const connection = { subdomain: 'acme', token: H.env('ZENDESK_TOKEN') };
export const sendReply = zendesk.reply('zendesk-reply', connection);

const latestMessage = (fallback: string, replies: readonly { readonly payload: { readonly message: string } }[]) =>
  replies.reduce<string>((last, reply) => reply.payload.message, fallback);

const conversationFrom = (ticket: zendesk.ZendeskTicket) => ({
  create: {
    attributes: {
      ticketId: ticket.id,
      category: 'unclassified',
      slaDueAt: ticket.slaDueAt ?? ticket.updatedAt + 4 * hourMs,
    },
    fields: { subject: ticket.subject, latestMessage: ticket.latestComment, requesterEmail: ticket.requesterEmail },
  },
});

export const triageFlow = H.flow('triage')
  .requires({ ticketId: z.number(), subject: z.string(), latestMessage: z.string() })
  .events({ customerReplied: { message: z.string() } })
  .step('classify', classifier, c => ({
    subject: c.input.subject,
    message: latestMessage(c.input.latestMessage, c.events.customerReplied),
  }))
  .sets({ category: z.string() }, c => ({ category: c.out.classify.category }))
  .mark('drafting')
  .step('draft', drafter, c => ({
    category: c.input.category,
    subject: c.input.subject,
    message: latestMessage(c.input.latestMessage, c.events.customerReplied),
  }))
  .mark('awaitingApproval')
  .halt('approval', replyApproval, {
    ask: c => `Approve this ${c.input.category} reply to "${c.input.subject}"?\n\n${c.out.draft.reply}`,
  })
  .exit('rejected', c => c.out.approval.approved === false)
  .step('send', sendReply, c => ({ ticketId: c.input.ticketId, body: c.out.approval.edited ?? c.out.draft.reply }))
  .ends(['sent'], () => 'sent');

export const escalationFlow = H.flow('escalation')
  .requires({ ticketId: z.number(), reason: z.string() })
  .halt('handle', escalationOutcome, { ask: c => `Ticket ${c.input.ticketId} escalated: ${c.input.reason}` })
  .ends(['resolved'], () => 'resolved');

export const conversations = H.lane('conversations', Conversation)
  .supply([
    zendesk.webhook(
      Conversation,
      { ...connection, port: H.slot.port(1), signingSecret: H.env('ZENDESK_SIGNING_SECRET') },
      event =>
        event.type === 'ticket.created'
          ? conversationFrom(event.ticket)
          : event.type === 'ticket.solved'
            ? { key: String(event.ticket.id), event: 'solved', payload: { solvedAt: event.ticket.updatedAt } }
            : event.fromCustomer
              ? { key: String(event.ticket.id), event: 'customerReplied', payload: { message: event.ticket.latestComment } }
              : null,
    ),
    zendesk.poll(Conversation, H.time.every({ minutes: 10 }), connection, conversationFrom),
  ])
  .store(
    zendesk.store(Conversation, {
      ...connection,
      status: {
        New: 'new',
        Classifying: 'open',
        Drafting: 'open',
        AwaitingApproval: 'pending',
        Sent: 'solved',
        ClosedByCustomer: 'closed',
        Escalated: 'hold',
      },
    }),
  )
  .handler(triageFlow, {
    outcomes: { rejected: New, sent: Sent },
    progress: { drafting: Drafting, awaitingApproval: AwaitingApproval },
    skips: {
      approval: {
        name: 'proven-safe-category',
        when: c => {
          const record = c.metrics.read(approvalRate, {
            kind: Conversation,
            where: { category: c.unit.attributes.category },
            window: 'all',
          });
          return record.n >= 200 && record.hits === record.n;
        },
        decision: { approved: true, edited: null, notes: 'category proven safe' },
      },
    },
  })
  .budget({ maxUsdPerUnit: 0.4, onExceed: 'halt' })
  .reacts({
    customerReplied: H.reaction(New).from([Classifying, Drafting, AwaitingApproval]),
    solved: H.reaction(ClosedByCustomer).from([New, Classifying, Drafting, AwaitingApproval]),
    slaBreach: H.reaction(Escalated).from([New, Classifying, Drafting, AwaitingApproval]),
  });

export const escalations = H.lane('escalations', Escalation).handler(escalationFlow, {
  outcomes: { resolved: EscalationResolved },
});

export const breachEscalates = H.trigger('sla-breach-escalates', H.on.event(conversations, 'slaBreach')).creates(e =>
  escalations.unit({
    attributes: {
      ticketId: e.unit.attributes.ticketId,
      reason: `SLA breached at ${new Date(e.payload.deadline).toISOString()} in state ${e.stateBefore}`,
    },
  }),
);

export const reviewerEditsBecomeTaste = H.trigger('reviewer-edits-become-taste', H.on.step(conversations, 'approval'))
  .where(e => e.output.edited !== null)
  .records(tasteJournal, e =>
    e.output.edited === null
      ? []
      : [
          {
            rule: `When drafting a ${e.unit.attributes.category} reply, write it the way the reviewer did: "${e.output.edited}"`,
            because: e.output.notes.length > 0 ? e.output.notes : 'the reviewer rewrote the draft this way',
            when: { roles: [drafterRole] },
          },
        ],
  );

const timeToBreach = (x: Candidate) =>
  x.unit.is(escalations) ? 0 : x.unit.is(conversations) ? x.unit.attributes.slaDueAt : Number.MAX_SAFE_INTEGER;

export const breachOrder = H.policy.schedule('time-to-breach', c => ({
  start: [...c.candidates].sort((a, b) => timeToBreach(a) - timeToBreach(b)),
}));

export const reviewerAccess = H.access('reviewer').allows([
  H.ops.readWork,
  H.ops.updateWork,
  H.ops.sendEvents,
  H.ops.resolveBlocks,
  H.ops.manageAttempts,
  H.ops.readMemory,
  H.ops.writeMemory,
  H.ops.curateMemory,
  H.ops.readTelemetry,
]);

export const supervisor = claudeCode.supervisor('support-supervisor', reviewerAccess, { port: H.slot.port(0) });

export const harness = H.harness('support-triage')
  .ledger(sqlite.ledger('.harness/support.db'))
  .lanes([conversations, escalations])
  .triggers([breachEscalates, reviewerEditsBecomeTaste])
  .schedule(breachOrder)
  .projections([markdown.board('BOARD.md'), markdown.telemetry('TELEMETRY.md')]);

export const control = H.control('support-control', harness).clients([supervisor]);
