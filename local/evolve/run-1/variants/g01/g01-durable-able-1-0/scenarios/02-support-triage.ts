import { z } from 'zod';
import { H } from 'harness-dsl';
import type { Metric, SupplyOf } from 'harness-dsl';
import * as sqlite from 'harness-dsl/sqlite';
import * as jsonl from 'harness-dsl/jsonl';
import * as claude from 'harness-dsl/claude-code';
import * as anthropic from 'harness-dsl/anthropic';
import * as zendesk from 'harness-dsl/zendesk';
import type { ZendeskTicket, ZendeskEvent } from 'harness-dsl/zendesk';
import * as markdown from 'harness-dsl/markdown';

const New = H.state('new', 'pending');
const Classifying = H.state('classifying', 'pending');
const Drafting = H.state('drafting', 'active');
const AwaitingApproval = H.state('awaiting-approval', 'active');
const Sent = H.state('sent', 'waiting');
const NeedsHuman = H.state('needs-human', 'waiting');
const ClosedByCustomer = H.state('closed-by-customer', 'terminal', 'success');
const Escalated = H.state('escalated', 'terminal', 'failure');

const EscalationOpen = H.state('open', 'pending');
const EscalationHandling = H.state('handling', 'active');
const EscalationResolved = H.state('resolved', 'terminal', 'success');
const EscalationReturned = H.state('returned', 'terminal', 'neutral');

const Conversation = H.work('conversation')
  .attributes({ ticketId: z.number(), category: z.string(), latestMessage: z.string(), slaDueAt: z.number() })
  .fields({ subject: z.string(), requester: z.string() })
  .states([New, Classifying, Drafting, AwaitingApproval, Sent, NeedsHuman, ClosedByCustomer, Escalated])
  .events({ customerReplied: { message: z.string() }, solved: { at: z.number() } })
  .timers((t) => ({ slaBreach: t.attribute('slaDueAt') }))
  .key((u) => String(u.attributes.ticketId));

const Escalation = H.work('escalation')
  .attributes({ ticketId: z.number(), breachedAt: z.number() })
  .states([EscalationOpen, EscalationHandling, EscalationResolved, EscalationReturned])
  .key((u) => String(u.attributes.ticketId), { unique: 'whileOpen' });

const Experience = H.memory.experience('support-experience');
const Taste = H.memory.taste('reply-taste').curated();

const bySpecificity = H.policy.recall('specificity-then-track-record', (c) =>
  [...c.candidates]
    .sort((a, b) => b.specificity - a.specificity || b.track.succeeded - a.track.succeeded)
    .slice(0, c.limit),
);

const experienceJournal = H.journal('support-experience', Experience)
  .store(jsonl.memory('./memory/experience.jsonl'))
  .recall(bySpecificity);

const tasteJournal = H.journal('reply-taste', Taste)
  .store(jsonl.memory('./memory/taste.jsonl'))
  .recall(bySpecificity);

const apiAccount = anthropic.account('support-api', { apiKey: H.env('ANTHROPIC_API_KEY') });
const haiku = anthropic.model('claude-haiku-4-5');
const sonnet = anthropic.model('claude-sonnet-4-5');
const opus = anthropic.model('claude-opus-4-1');

const approvalWindow = { days: 30 };

const drafterModel = H.policy.model('drafter-model', [sonnet, opus], (c) => {
  const category = c.unit ? c.unit.attributes['category'] : undefined;
  const where = typeof category === 'string' ? { category } : undefined;
  const cheaper = c.metrics.read(approvalMetric, { kind: Conversation, model: sonnet, window: approvalWindow, where });
  const stronger = c.metrics.read(approvalMetric, { kind: Conversation, model: opus, window: approvalWindow, where });
  if (cheaper.n < 30 || cheaper.rate === null) return sonnet;
  if (cheaper.rate >= 0.8) return sonnet;
  return stronger.n < 30 || (stronger.rate !== null && stronger.rate > cheaper.rate) ? opus : sonnet;
});

const safeCategory = H.policy.gate('safe-category', (c) => {
  const category = c.unit ? c.unit.attributes['category'] : undefined;
  if (typeof category !== 'string') return false;
  const approvals = c.metrics.read(approvalMetric, { kind: Conversation, window: { days: 365 }, where: { category } });
  return approvals.n >= 200 && approvals.hits === approvals.n;
});

const classifierRole = H.role('classifier')
  .intents(['read'])
  .instructions('Classify the customer conversation into one support category.')
  .input({ subject: z.string(), message: z.string() })
  .output({ category: z.string(), summary: z.string() });

const drafterRole = H.role('drafter')
  .intents(['read', 'search'])
  .instructions('Draft the next reply to the customer in the house tone.')
  .input({ subject: z.string(), message: z.string(), category: z.string() })
  .output({ reply: z.string() });

const classifier = H.agent('classifier', classifierRole).model(haiku).pool(apiAccount);

const drafter = H.agent('drafter', drafterRole)
  .model(drafterModel)
  .pool(apiAccount)
  .recalls([tasteJournal, experienceJournal]);

const helpdesk = { subdomain: 'acme', token: H.env('ZENDESK_TOKEN') };
const sendReply = zendesk.reply('send-reply', helpdesk);

const conversationFlow = H.flow('conversation')
  .requires({ ticketId: z.number(), subject: z.string(), latestMessage: z.string() })
  .step('classify', classifier, (c) => ({ subject: c.input.subject, message: c.input.latestMessage }))
  .sets({ category: z.string() }, (c) => ({ category: c.out.classify.category }))
  .mark('drafting')
  .step('draft', drafter, (c) => ({
    subject: c.input.subject,
    message: c.input.latestMessage,
    category: c.input.category,
  }))
  .mark('awaiting-approval')
  .halt('approve', {
    ask: (c) => `Approve this ${c.input.category} reply to ticket ${c.input.ticketId}?\n\n${c.out.draft.reply}`,
    decision: { approved: z.boolean(), edited: z.string() },
    skip: { when: safeCategory, decision: { approved: true, edited: '' } },
  })
  .exit('rejected', (c) => !c.out.approve.approved)
  .step('send', sendReply, (c) => ({
    ticketId: c.input.ticketId,
    body: c.out.approve.edited.length > 0 ? c.out.approve.edited : c.out.draft.reply,
  }))
  .ends(['sent'], () => 'sent');

const approvalMetric: Metric = H.metric('approval')
  .step(conversationFlow, 'approve')
  .hit((decision) => decision.approved);

const escalationFlow = H.flow('escalation')
  .requires({ ticketId: z.number(), breachedAt: z.number() })
  .mark('handling')
  .halt('handle', {
    ask: (c) => `Ticket ${c.input.ticketId} breached its SLA at ${new Date(c.input.breachedAt).toISOString()}. Take it over.`,
    decision: { outcome: z.enum(['resolved', 'returned']), note: z.string() },
  })
  .ends(['resolved', 'returned'], (c) => (c.out.handle.outcome === 'resolved' ? 'resolved' : 'returned'));

const defaultSlaMs = 4 * 60 * 60 * 1000;

const fromTicket = (ticket: ZendeskTicket): SupplyOf<typeof Conversation> => ({
  create: {
    attributes: {
      ticketId: ticket.id,
      category: '',
      latestMessage: ticket.latestComment,
      slaDueAt: ticket.slaDueAt ?? ticket.updatedAt + defaultSlaMs,
    },
    fields: { subject: ticket.subject, requester: ticket.requesterEmail },
  },
});

const fromEvent = (event: ZendeskEvent): SupplyOf<typeof Conversation> | null => {
  if (event.type === 'ticket.created') return fromTicket(event.ticket);
  if (event.type === 'ticket.solved') {
    return { key: String(event.ticket.id), event: 'solved', payload: { at: event.ticket.updatedAt } };
  }
  if (!event.fromCustomer) return null;
  return { key: String(event.ticket.id), event: 'customerReplied', payload: { message: event.ticket.latestComment } };
};

const conversationLane = H.lane('conversations', Conversation)
  .supply([
    zendesk.webhook(
      Conversation,
      { ...helpdesk, port: H.slot.port(1), signingSecret: H.env('ZENDESK_SIGNING_SECRET') },
      fromEvent,
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
        sent: 'pending',
        'needs-human': 'hold',
        'closed-by-customer': 'solved',
        escalated: 'hold',
      },
    }),
  )
  .budget({ maxUsdPerUnit: 0.4, onExceed: 'halt' })
  .reaction('customerReplied', Classifying, {
    from: [New, Classifying, Drafting, AwaitingApproval, Sent],
    sets: (payload) => ({ latestMessage: payload.message }),
  })
  .reaction('solved', ClosedByCustomer, { from: [Sent] })
  .reaction('slaBreach', Escalated, { from: [New, Classifying, Drafting, AwaitingApproval, NeedsHuman] })
  .handler(conversationFlow, {
    states: {
      drafting: Drafting,
      'awaiting-approval': AwaitingApproval,
      rejected: Classifying,
      sent: Sent,
      failed: NeedsHuman,
    },
  });

const escalationLane = H.lane('escalations', Escalation).handler(escalationFlow, {
  states: {
    handling: EscalationHandling,
    resolved: EscalationResolved,
    returned: EscalationReturned,
    failed: EscalationOpen,
  },
});

const slaBreachEscalates = H.trigger('sla-breach-escalates', H.on.event(conversationLane, 'slaBreach'))
  .where((e) => e.reaction !== null)
  .creates(escalationLane, (e) => ({
    attributes: { ticketId: e.unit.attributes.ticketId, breachedAt: e.payload.dueAt },
  }));

const reviewerEditsBecomeTaste = H.trigger('reviewer-edits-become-taste', H.on.step(conversationLane, 'approve'))
  .where((e) => e.resolvedBy === 'human' && e.output.edited.length > 0)
  .records(tasteJournal, (e) => [
    {
      rule: `When replying in category ${e.unit.attributes.category}, phrase it the way the reviewer did: "${e.output.edited}"`,
      because: 'the reviewer rewrote the drafted reply before approving it',
      when: { kinds: [Conversation], roles: [drafterRole], attributes: { category: e.unit.attributes.category } },
    },
  ]);

const timeToBreach = H.policy.schedule('time-to-breach', (c) => {
  const dueAt = (x: (typeof c.candidates)[number]): number =>
    x.is(escalationLane) ? 0 : x.is(conversationLane) ? x.unit.attributes.slaDueAt : Number.MAX_SAFE_INTEGER;
  return { start: [...c.candidates].sort((a, b) => dueAt(a) - dueAt(b)) };
});

const reviewerAccess = H.access('reviewer').allows([
  H.ops.readWork,
  H.ops.updateWork,
  H.ops.resolveBlocks,
  H.ops.readMemory,
  H.ops.writeMemory,
  H.ops.curateMemory,
  H.ops.readTelemetry,
]);

export const supportTriage = H.harness('support-triage')
  .ledger(sqlite.ledger('./.harness/ledger.db'))
  .lanes([conversationLane, escalationLane])
  .triggers([slaBreachEscalates, reviewerEditsBecomeTaste])
  .schedule(timeToBreach)
  .clients([claude.supervisor('reviewer', reviewerAccess, { port: H.slot.port(0) })])
  .projections([markdown.board('./BOARD.md'), markdown.telemetry('./TELEMETRY.md')]);

export const running = supportTriage.start();
