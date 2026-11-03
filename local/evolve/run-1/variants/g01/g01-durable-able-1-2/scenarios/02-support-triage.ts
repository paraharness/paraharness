import { H } from 'harness-dsl';
import type { Supply } from 'harness-dsl';
import { z } from 'zod';
import * as anthropic from 'harness-dsl/anthropic';
import * as zendesk from 'harness-dsl/zendesk';
import * as sqlite from 'harness-dsl/sqlite';
import * as jsonl from 'harness-dsl/jsonl';
import * as claudeCode from 'harness-dsl/claude-code';
import * as markdown from 'harness-dsl/markdown';

const helpdesk = { subdomain: 'acme', token: H.env('ZENDESK_TOKEN') };
const defaultSlaMs = 4 * 60 * 60 * 1000;

const New = H.state('New', 'pending');
const Classifying = H.state('Classifying', 'pending');
const Drafting = H.state('Drafting', 'active');
const AwaitingApproval = H.state('AwaitingApproval', 'active');
const Sent = H.state('Sent', 'terminal', 'success');
const ClosedByCustomer = H.state('ClosedByCustomer', 'terminal', 'neutral');
const Escalated = H.state('Escalated', 'terminal', 'failure');

const EscalationOpen = H.state('EscalationOpen', 'pending');
const EscalationResolved = H.state('EscalationResolved', 'terminal', 'success');
const EscalationDropped = H.state('EscalationDropped', 'terminal', 'neutral');

const Conversation = H.work('Conversation')
  .attributes({ ticketId: z.number(), category: z.string(), slaDueAt: z.number() })
  .fields({ subject: z.string(), latestMessage: z.string(), requesterEmail: z.string() })
  .states([New, Classifying, Drafting, AwaitingApproval, Sent, ClosedByCustomer, Escalated])
  .events({ customerReplied: { message: z.string() }, customerClosed: {} })
  .timers((t) => ({ slaBreach: t.attribute('slaDueAt') }))
  .key((u) => String(u.attributes.ticketId));

type ConversationTypes = NonNullable<typeof Conversation.types>;
type ConversationSupply = Supply<ConversationTypes['attributes'], ConversationTypes['fields'], ConversationTypes['events']>;

const Escalation = H.work('Escalation')
  .attributes({ ticketId: z.number(), reason: z.string() })
  .states([EscalationOpen, EscalationResolved, EscalationDropped])
  .key((u) => String(u.attributes.ticketId));

const experience = H.memory.experience('support-experience');
const taste = H.memory.taste('support-taste');

const specificFirst = H.policy.recall('specific-first', (c) =>
  [...c.candidates].sort((a, b) => b.specificity - a.specificity).slice(0, c.limit),
);

const experienceJournal = H.journal('support-experience-journal', experience)
  .store(jsonl.memory('memory/experience.jsonl'))
  .recall(specificFirst);
const tasteJournal = H.journal('support-taste-journal', taste)
  .store(jsonl.memory('memory/taste.jsonl'))
  .recall(specificFirst);

const apiAccount = anthropic.account('support-api', { apiKey: H.env('ANTHROPIC_API_KEY') });
const haiku = anthropic.model('claude-haiku-4-5');
const sonnet = anthropic.model('claude-sonnet-4-5');
const opus = anthropic.model('claude-opus-4-1');

const replyApproval = H.decision('reply-approval', {
  approved: z.boolean(),
  editedReply: z.string(),
  notes: z.string(),
});
const escalationOutcome = H.decision('escalation-outcome', { resolved: z.boolean(), notes: z.string() });

const replyApproved = H.metric('reply-approved').of(replyApproval).hit((d) => d.approved);

const drafterModel = H.policy.model('drafter-model', [sonnet, opus], (c) => {
  const where = c.unit === null ? undefined : { category: c.unit.attributes['category'] ?? '' };
  const standard = c.metrics.read(replyApproved, { model: sonnet, where, window: { days: 30 } });
  const strong = c.metrics.read(replyApproved, { model: opus, where, window: { days: 30 } });
  if (standard.n < 30 || strong.n < 30) return standard.n <= strong.n ? sonnet : opus;
  return (strong.rate ?? 0) > (standard.rate ?? 0) + 0.05 ? opus : sonnet;
});

const classifierRole = H.role('classifier')
  .intents(['read'])
  .instructions('Classify the conversation into exactly one category.')
  .input({ subject: z.string(), transcript: z.string() })
  .output({ category: z.enum(['billing', 'refund', 'technical', 'account', 'other']), confidence: z.number() });

const drafterRole = H.role('drafter')
  .intents(['read'])
  .instructions('Draft the next reply to the customer in the house tone.')
  .input({ subject: z.string(), transcript: z.string(), category: z.string() })
  .output({ reply: z.string() });

const classifier = H.agent('classifier', classifierRole).model(haiku).pool(apiAccount);
const drafter = H.agent('drafter', drafterRole)
  .model(drafterModel)
  .pool(apiAccount)
  .recalls([tasteJournal, experienceJournal]);

const sendReply = zendesk.reply('helpdesk-reply', helpdesk);

const triageFlow = H.flow('triage-and-reply')
  .requires({ ticketId: z.number(), subject: z.string(), latestMessage: z.string() })
  .events({ customerReplied: { message: z.string() } })
  .step('classify', classifier, (c) => ({
    subject: c.input.subject,
    transcript: c.events.customerReplied.reduce((t, r) => `${t}\n\nCustomer: ${r.payload.message}`, c.input.latestMessage),
  }))
  .sets({ category: z.string() }, (c) => ({ category: c.out.classify.category }))
  .mark('drafting')
  .step('draft', drafter, (c) => ({
    subject: c.input.subject,
    category: c.out.classify.category,
    transcript: c.events.customerReplied.reduce((t, r) => `${t}\n\nCustomer: ${r.payload.message}`, c.input.latestMessage),
  }))
  .mark('awaitingApproval')
  .halt('approval', replyApproval, { ask: (c) => `Approve this ${c.out.classify.category} reply?\n\n${c.out.draft.reply}` })
  .exit('rejected', (c) => !c.out.approval.approved)
  .step('send', sendReply, (c) => ({
    ticketId: c.input.ticketId,
    body: c.out.approval.editedReply.length > 0 ? c.out.approval.editedReply : c.out.draft.reply,
  }))
  .ends(['sent'], () => 'sent');

const escalationFlow = H.flow('human-escalation')
  .requires({ ticketId: z.number(), reason: z.string() })
  .halt('resolution', escalationOutcome, { ask: (c) => `Ticket ${c.input.ticketId} escalated (${c.input.reason}). Resolve it.` })
  .ends(['resolved', 'dropped'], (c) => (c.out.resolution.resolved ? 'resolved' : 'dropped'));

const conversationLane = H.lane('conversations', Conversation)
  .supply([
    zendesk.webhook(
      Conversation,
      { ...helpdesk, port: H.slot.port(1), signingSecret: H.env('ZENDESK_WEBHOOK_SECRET') },
      (e): ConversationSupply | null => {
        if (e.type === 'ticket.created') {
          return {
            create: {
              attributes: { ticketId: e.ticket.id, category: '', slaDueAt: e.ticket.slaDueAt ?? e.ticket.updatedAt + defaultSlaMs },
              fields: { subject: e.ticket.subject, latestMessage: e.ticket.latestComment, requesterEmail: e.ticket.requesterEmail },
            },
          };
        }
        if (e.type === 'comment.added' && e.fromCustomer) {
          return { key: String(e.ticket.id), event: 'customerReplied', payload: { message: e.ticket.latestComment } };
        }
        if (e.type === 'ticket.solved') {
          return { key: String(e.ticket.id), event: 'customerClosed', payload: {} };
        }
        return null;
      },
    ),
    zendesk.poll(Conversation, H.time.every({ minutes: 10 }), helpdesk, (ticket) => ({
      create: {
        attributes: { ticketId: ticket.id, category: '', slaDueAt: ticket.slaDueAt ?? ticket.updatedAt + defaultSlaMs },
        fields: { subject: ticket.subject, latestMessage: ticket.latestComment, requesterEmail: ticket.requesterEmail },
      },
    })),
  ])
  .store(
    zendesk.store(Conversation, {
      ...helpdesk,
      status: { New: 'new', Classifying: 'open', Drafting: 'open', AwaitingApproval: 'pending', Sent: 'solved', ClosedByCustomer: 'closed', Escalated: 'on-hold' },
    }),
  )
  .handler(triageFlow, {
    states: { drafting: Drafting, awaitingApproval: AwaitingApproval, rejected: Classifying, sent: Sent, failed: Classifying },
    skips: {
      approval: {
        name: 'safe-category',
        when: (g) => {
          const record = g.metrics.read(replyApproved, { where: { category: g.unit.attributes.category }, window: { days: 365 } });
          return record.n >= 200 && record.hits === record.n;
        },
        decision: { approved: true, editedReply: '', notes: 'category approved 200 times without rejection' },
      },
    },
  })
  .budget({ maxUsdPerUnit: 0.4, onExceed: 'halt' })
  .reacts({
    customerReplied: H.reaction(Classifying).from([AwaitingApproval]),
    customerClosed: H.reaction(ClosedByCustomer).from([New, Classifying, Drafting, AwaitingApproval]),
    slaBreach: H.reaction(Escalated).from([New, Classifying, Drafting, AwaitingApproval]),
  });

const escalationLane = H.lane('escalations', Escalation)
  .store(zendesk.store(Escalation, { ...helpdesk, status: { EscalationOpen: 'on-hold', EscalationResolved: 'solved', EscalationDropped: 'closed' } }))
  .handler(escalationFlow, { states: { resolved: EscalationResolved, dropped: EscalationDropped, failed: EscalationOpen } });

const slaBreachEscalates = H.trigger('sla-breach-escalates', H.on.event(conversationLane, 'slaBreach'))
  .where((e) => e.stateBefore !== Sent.name && e.stateBefore !== ClosedByCustomer.name && e.stateBefore !== Escalated.name)
  .creates((e) => escalationLane.unit({ attributes: { ticketId: e.unit.attributes.ticketId, reason: 'sla-breach' } }));

const timeToBreach = H.policy.schedule('time-to-breach', (c) => ({
  start: c.candidates
    .map((x) => ({
      x,
      due: x.entry.lane === escalationLane.name ? 0 : x.timers['slaBreach'] ?? Number.POSITIVE_INFINITY,
    }))
    .sort((a, b) => a.due - b.due)
    .map((p) => p.x),
}));

const reviewerAccess = H.access('reviewer').allows([
  H.ops.readWork,
  H.ops.updateWork,
  H.ops.sendEvents,
  H.ops.resolveBlocks,
  H.ops.readMemory,
  H.ops.writeMemory,
  H.ops.readTelemetry,
]);

export const harness = H.harness('support-triage')
  .ledger(sqlite.ledger('state/ledger.sqlite'))
  .lanes([conversationLane, escalationLane])
  .triggers([slaBreachEscalates])
  .schedule(timeToBreach)
  .clients([claudeCode.supervisor('reviewer', reviewerAccess, { port: H.slot.port(0) })])
  .projections([markdown.board('BOARD.md'), markdown.telemetry('TELEMETRY.md')]);
