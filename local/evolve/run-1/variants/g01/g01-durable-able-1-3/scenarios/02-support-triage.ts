import { z } from 'zod';
import { H, type Metric } from 'harness-dsl';
import * as sqlite from 'harness-dsl/sqlite';
import * as jsonl from 'harness-dsl/jsonl';
import * as claude from 'harness-dsl/claude-code';
import * as anthropic from 'harness-dsl/anthropic';
import * as zendesk from 'harness-dsl/zendesk';
import * as markdown from 'harness-dsl/markdown';

const HOUR = 60 * 60 * 1000;
const SAFE_SAMPLES = 200;

const helpdesk = { subdomain: 'acme', token: H.env('ZENDESK_TOKEN') };

const New = H.state('new', 'pending');
const Classifying = H.state('classifying', 'active');
const Drafting = H.state('drafting', 'active');
const AwaitingApproval = H.state('awaiting-approval', 'active');
const Sent = H.state('sent', 'terminal', 'success');
const ClosedByCustomer = H.state('closed-by-customer', 'terminal', 'neutral');
const Escalated = H.state('escalated', 'terminal', 'failure');

const EscalationOpen = H.state('escalation-open', 'pending');
const Handling = H.state('handling', 'active');
const Handled = H.state('handled', 'terminal', 'success');
const Dropped = H.state('dropped', 'terminal', 'failure');

const Conversation = H.work('Conversation')
  .attributes({ ticketId: z.number(), category: z.string(), slaDueAt: z.number() })
  .fields({ subject: z.string(), latestMessage: z.string(), requester: z.string() })
  .states([New, Classifying, Drafting, AwaitingApproval, Sent, ClosedByCustomer, Escalated])
  .signals({ customerReplied: { message: z.string() }, customerClosed: {} })
  .timers((t) => ({ slaBreach: t.attribute('slaDueAt') }))
  .key((unit) => String(unit.attributes.ticketId));

const Escalation = H.work('Escalation')
  .attributes({ ticketId: z.number(), reason: z.string() })
  .states([EscalationOpen, Handling, Handled, Dropped])
  .key((unit) => `${unit.attributes.ticketId}:${unit.attributes.reason}`);

const fromTicket = (ticket: zendesk.ZendeskTicket) => ({
  create: {
    attributes: {
      ticketId: ticket.id,
      category: 'unclassified',
      slaDueAt: ticket.slaDueAt === null ? ticket.updatedAt + 4 * HOUR : ticket.slaDueAt,
    },
    fields: { subject: ticket.subject, latestMessage: ticket.latestComment, requester: ticket.requesterEmail },
  },
});

const specificThenProven = H.policy.recall('specific-then-proven', (c) =>
  [...c.candidates]
    .sort(
      (a, b) =>
        b.specificity - a.specificity ||
        (b.track.present === 0 ? 0 : b.track.succeeded / b.track.present) -
          (a.track.present === 0 ? 0 : a.track.succeeded / a.track.present),
    )
    .slice(0, c.limit),
);

const tone = H.journal('tone', H.memory.taste('support-tone'))
  .store(jsonl.memory('memory/tone.jsonl'))
  .recall(specificThenProven);

const supportExperience = H.journal('support-experience', H.memory.experience('support-experience'))
  .store(jsonl.memory('memory/support-experience.jsonl'))
  .recall(specificThenProven);

const api = anthropic.account('api', { apiKey: H.env('ANTHROPIC_API_KEY') });
const haiku = anthropic.model('claude-haiku-4-5');
const sonnet = anthropic.model('claude-sonnet-4-5');

const classifierRole = H.role('classifier')
  .intents(['read'])
  .instructions('Classify the customer message into one support category.')
  .input({ subject: z.string(), message: z.string() })
  .output({ category: z.string(), confidence: z.number() });

const drafterRole = H.role('drafter')
  .intents(['read', 'remember'])
  .instructions('Draft a reply to the customer in the house tone.')
  .input({ subject: z.string(), message: z.string(), category: z.string() })
  .output({ body: z.string() });

const classifier = H.agent('classifier', classifierRole).model(haiku).pool(api);
const drafter = H.agent('drafter', drafterRole).model(sonnet).pool(api).recalls([tone, supportExperience]);

const safeCategory = H.policy.gate('safe-category', (c) => {
  if (c.unit === null) return false;
  const reading = c.metrics.read(approvals, {
    kind: Conversation,
    where: { category: c.unit.attributes['category'] },
  });
  return reading.n >= SAFE_SAMPLES && reading.hits === reading.n;
});

const reply = zendesk.reply('helpdesk-reply', helpdesk);

const conversationFlow = H.flow('conversation')
  .requires({ ticketId: z.number(), subject: z.string(), latestMessage: z.string() })
  .mark('classifying')
  .step('classify', classifier, (c) => ({ subject: c.input.subject, message: c.input.latestMessage }))
  .sets({ category: z.string() }, (c) => ({ category: c.out.classify.category }))
  .mark('drafting')
  .step('draft', drafter, (c) => ({
    subject: c.input.subject,
    message: c.input.latestMessage,
    category: c.input.category,
  }))
  .mark('awaiting')
  .halt('approval', {
    ask: (c) => `Approve this reply for ticket ${c.input.ticketId}, or edit it:\n\n${c.out.draft.body}`,
    decision: { approved: z.boolean(), editedBody: z.string() },
    skip: { when: safeCategory, decision: { approved: true, editedBody: '' } },
  })
  .exit('rejected', (c) => c.out.approval.approved === false)
  .step(
    'send',
    reply,
    (c) => ({
      ticketId: c.input.ticketId,
      body: c.out.approval.editedBody === '' ? c.out.draft.body : c.out.approval.editedBody,
    }),
    { onRestart: 'park' },
  )
  .ends(['sent'], () => 'sent');

const approvals: Metric = H.metric('approvals')
  .step(conversationFlow, 'approval')
  .hit((output) => output.approved);

const escalationFlow = H.flow('escalation')
  .requires({ ticketId: z.number(), reason: z.string() })
  .mark('handling')
  .halt('resolve', {
    ask: (c) => `Ticket ${c.input.ticketId} escalated (${c.input.reason}). Write the reply the customer gets.`,
    decision: { replyToCustomer: z.string() },
  })
  .step('respond', reply, (c) => ({ ticketId: c.input.ticketId, body: c.out.resolve.replyToCustomer }), {
    onRestart: 'park',
  })
  .ends(['handled'], () => 'handled');

const conversations = H.lane('conversations', Conversation)
  .supply([
    zendesk.webhook(
      Conversation,
      { ...helpdesk, port: H.slot.port(1), signingSecret: H.env('ZENDESK_SIGNING_SECRET') },
      (event) => {
        if (event.type === 'ticket.created') return fromTicket(event.ticket);
        if (event.type === 'ticket.solved') {
          return { key: String(event.ticket.id), signal: 'customerClosed', payload: {} };
        }
        if (event.fromCustomer) {
          return {
            key: String(event.ticket.id),
            signal: 'customerReplied',
            payload: { message: event.ticket.latestComment },
          };
        }
        return null;
      },
    ),
    zendesk.poll(Conversation, H.time.every({ minutes: 15 }), helpdesk, fromTicket),
  ])
  .store(
    zendesk.store(Conversation, {
      ...helpdesk,
      status: {
        new: 'new',
        classifying: 'open',
        drafting: 'open',
        'awaiting-approval': 'pending',
        sent: 'solved',
        'closed-by-customer': 'closed',
        escalated: 'hold',
      },
    }),
  )
  .handler(conversationFlow, {
    states: {
      classifying: Classifying,
      drafting: Drafting,
      awaiting: AwaitingApproval,
      rejected: Escalated,
      sent: Sent,
      failed: Escalated,
    },
  })
  .budget({ maxUsdPerUnit: 0.4, onExceed: 'halt' });

const escalations = H.lane('escalations', Escalation)
  .supply([H.supply.operator()])
  .handler(escalationFlow, {
    states: { handling: Handling, handled: Handled, failed: Dropped },
  });

const slaBreachEscalates = H.trigger('sla-breach-escalates', H.on.signal(conversations, 'slaBreach'))
  .where((event) => event.unit.position !== 'terminal')
  .creates(escalations, (event) => ({
    attributes: { ticketId: event.unit.attributes.ticketId, reason: 'sla-breach' },
  }))
  .moves(conversations, { key: (event) => event.unit.key, to: Escalated });

const customerReplyRedrafts = H.trigger('customer-reply-redrafts', H.on.signal(conversations, 'customerReplied')).moves(
  conversations,
  {
    key: (event) => event.unit.key,
    to: New,
    from: [AwaitingApproval],
    update: (event) => ({ fields: { latestMessage: event.payload.message } }),
  },
);

const customerCloses = H.trigger('customer-closes', H.on.signal(conversations, 'customerClosed')).moves(conversations, {
  key: (event) => event.unit.key,
  to: ClosedByCustomer,
  from: [New, Classifying, Drafting, AwaitingApproval],
});

const editsBecomeTaste = H.trigger('reviewer-edits-become-taste', H.on.step(conversations, 'approval'))
  .where((event) => event.status === 'succeeded' && event.output.editedBody !== '')
  .records(tone, (event) => [
    {
      rule: `When drafting for ${event.unit.attributes.category}, write the way the reviewer rewrote it: "${event.output.editedBody.slice(0, 280)}"`,
      because: 'the reviewer edited a draft in this category before approving it',
      when: {
        kinds: [Conversation],
        roles: [drafterRole],
        attributes: { category: event.unit.attributes.category },
      },
    },
  ]);

const timeToBreach = (lane: string, timers: Readonly<Record<string, number>>): number => {
  if (lane === escalations.name) return 0;
  return 'slaBreach' in timers ? timers['slaBreach'] : Number.MAX_SAFE_INTEGER;
};

const breachFirst = H.policy.schedule('escalations-then-time-to-breach', (c) => ({
  start: [...c.candidates].sort(
    (a, b) => timeToBreach(a.unit.lane, a.timers) - timeToBreach(b.unit.lane, b.timers),
  ),
}));

const reviewerAccess = H.access('reviewer').allows([
  H.ops.readWork,
  H.ops.updateWork,
  H.ops.resolveBlocks,
  H.ops.readMemory,
  H.ops.writeMemory,
  H.ops.curateMemory,
  H.ops.readTelemetry,
]);

export default H.harness('support-triage')
  .ledger(sqlite.ledger('.harness/support.sqlite'))
  .lanes([conversations, escalations])
  .triggers([slaBreachEscalates, customerReplyRedrafts, customerCloses, editsBecomeTaste])
  .schedule(breachFirst)
  .clients([claude.supervisor('reviewer', reviewerAccess, { port: H.slot.port(0) })])
  .projections([markdown.board('BOARD.md'), markdown.telemetry('TELEMETRY.md')]);
