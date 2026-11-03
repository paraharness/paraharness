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
const AwaitingApproval = H.state('AwaitingApproval', 'waiting');
const Sent = H.state('Sent', 'terminal', 'success');
const ClosedByCustomer = H.state('ClosedByCustomer', 'terminal', 'neutral');
const Escalated = H.state('Escalated', 'terminal', 'failure');

const EscalationOpen = H.state('EscalationOpen', 'pending');
const EscalationHandling = H.state('EscalationHandling', 'active');
const EscalationWithHuman = H.state('EscalationWithHuman', 'waiting');
const EscalationResolved = H.state('EscalationResolved', 'terminal', 'success');
const EscalationAbandoned = H.state('EscalationAbandoned', 'terminal', 'neutral');

const Conversation = H.work('Conversation')
  .attributes({
    ticketId: z.number(),
    subject: z.string(),
    requester: z.string(),
    category: z.string(),
    slaDueAt: z.number(),
  })
  .fields({ latestComment: z.string() })
  .states([New, Classifying, Drafting, AwaitingApproval, Sent, ClosedByCustomer, Escalated])
  .events({ customerReplied: { body: z.string() }, solved: {} })
  .timers(t => ({ slaBreach: t.attribute('slaDueAt') }))
  .key(u => String(u.attributes.ticketId));

const Escalation = H.work('Escalation')
  .attributes({ ticketId: z.number(), reason: z.string() })
  .states([EscalationOpen, EscalationHandling, EscalationWithHuman, EscalationResolved, EscalationAbandoned])
  .failsTo(EscalationAbandoned)
  .key(u => String(u.attributes.ticketId));

const connection = { subdomain: 'acme', token: H.env('ZENDESK_TOKEN') };
const defaultSlaMs = 4 * 3_600_000;

const fromTicket = (ticket: zendesk.ZendeskTicket) => ({
  attributes: {
    ticketId: ticket.id,
    subject: ticket.subject,
    requester: ticket.requesterEmail,
    category: '',
    slaDueAt: ticket.slaDueAt ?? ticket.updatedAt + defaultSlaMs,
  },
  fields: { latestComment: ticket.latestComment },
});

const helpdeskWebhook = zendesk.webhook(
  Conversation,
  { ...connection, port: H.slot.port(1), signingSecret: H.env('ZENDESK_SIGNING_SECRET') },
  (event, supply) => {
    const key = String(event.ticket.id);
    if (event.type === 'ticket.created') return supply.create(fromTicket(event.ticket));
    if (event.type === 'comment.added' && event.fromCustomer) {
      return supply.event(key, 'customerReplied', { body: event.ticket.latestComment });
    }
    if (event.type === 'ticket.solved') return supply.event(key, 'solved', {});
    return null;
  },
);

const helpdeskPoll = zendesk.poll(Conversation, H.time.every({ minutes: 10 }), connection, (ticket, supply) =>
  supply.create(fromTicket(ticket)));

const Tone = H.memory.taste('replyTone').curated();
const ReplyExperience = H.memory.experience('replyExperience');

const bySpecificity = H.policy.recall('bySpecificity', c =>
  [...c.candidates]
    .sort((a, b) => b.specificity - a.specificity || b.track.succeeded - a.track.succeeded)
    .slice(0, c.limit));

const tone = H.journal('tone', Tone).store(jsonl.memory('.harness/tone.jsonl')).recall(bySpecificity);
const replyExperience = H.journal('replyExperience', ReplyExperience)
  .store(jsonl.memory('.harness/reply-experience.jsonl'))
  .recall(bySpecificity);

const apiAccount = anthropic.account('anthropicApi', { apiKey: H.env('ANTHROPIC_API_KEY') });
const haiku = anthropic.model('claude-haiku-4-5');
const sonnet = anthropic.model('claude-sonnet-4-5');
const opus = anthropic.model('claude-opus-4-1');

const replyApproval = H.decision('replyApproval', { approved: z.boolean(), editedBody: z.string().nullable() });
const handoff = H.decision('handoff', { resolution: z.string() });

const approvedReplies = H.metric('approvedReplies').of(replyApproval).hit(decision => decision.approved);

const drafterModel = H.policy.model('drafterModel', [sonnet, opus], c => {
  const category = c.unitOf(Conversation)?.attributes.category ?? '';
  const record = c.metrics.read(approvedReplies, { model: sonnet, where: { category }, window: { days: 30 } });
  return record.n >= 30 && record.rate !== null && record.rate < 0.8 ? opus : sonnet;
});

const classifierRole = H.role('classifier')
  .instructions('Classify the customer message into one support category.')
  .input({ subject: z.string(), message: z.string() })
  .output({ category: z.string() });

const drafterRole = H.role('drafter')
  .instructions('Draft a reply to the customer in the house tone.')
  .input({ subject: z.string(), message: z.string(), category: z.string() })
  .output({ body: z.string() });

const classifier = H.agent('classifier', classifierRole).model(haiku).pool(apiAccount);
const drafter = H.agent('drafter', drafterRole).model(drafterModel).pool(apiAccount).recalls([tone, replyExperience]);

const sendReply = zendesk.reply('sendReply', connection);

const triageFlow = H.flow('triage')
  .requires({ ticketId: z.number(), subject: z.string(), latestComment: z.string() })
  .step('classify', classifier, c => ({ subject: c.input.subject, message: c.input.latestComment }))
  .sets({ category: z.string() }, c => ({ category: c.out.classify.category }))
  .step('draft', drafter, c => ({ subject: c.input.subject, message: c.input.latestComment, category: c.input.category }))
  .halt('approval', replyApproval, { ask: c => `Approve the reply to ticket #${c.input.ticketId}:\n\n${c.out.draft.body}` })
  .exit('rejected', c => !c.out.approval.approved)
  .step('send', sendReply, c => ({ ticketId: c.input.ticketId, body: c.out.approval.editedBody ?? c.out.draft.body }))
  .ends(['sent'], () => 'sent');

const escalationFlow = H.flow('escalation')
  .requires({ ticketId: z.number(), reason: z.string() })
  .halt('handoff', handoff, { ask: c => `Ticket #${c.input.ticketId} escalated (${c.input.reason}). Take it over.` })
  .ends(['resolved'], () => 'resolved');

const conversations = H.lane('conversations', Conversation)
  .supply([helpdeskWebhook, helpdeskPoll])
  .store(zendesk.store(Conversation, {
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
  }))
  .handler(triageFlow, {
    opens: Classifying,
    progress: { draft: Drafting },
    halts: { approval: AwaitingApproval },
    ends: { sent: Sent, rejected: { to: New, times: 2, thereafter: Escalated } },
    skips: {
      approval: {
        name: 'safeCategory',
        when: g => {
          const record = g.metrics.read(approvedReplies, { where: { category: g.unit.attributes.category }, window: 'all' });
          return record.n >= 200 && record.hits === record.n;
        },
        decision: { approved: true, editedBody: null },
      },
    },
  })
  .retry(H.retry.exponential({ maxRetries: 2, initialDelayMs: 30_000 }), { exhausted: Escalated })
  .budget({ maxUsdPerUnit: 0.4, onExceed: 'halt' })
  .wip(8);

const escalations = H.lane('escalations', Escalation)
  .handler(escalationFlow, {
    opens: EscalationHandling,
    halts: { handoff: EscalationWithHuman },
    ends: { resolved: EscalationResolved },
  });

const open = [New, Classifying, Drafting, AwaitingApproval];

const customerReplied = H.trigger('customerReplied', H.on.event(conversations, 'customerReplied'))
  .moves(New, { from: [Classifying, Drafting, AwaitingApproval], cancels: true });

const customerSolved = H.trigger('customerSolved', H.on.event(conversations, 'solved'))
  .moves(ClosedByCustomer, { from: open, cancels: true });

const slaBreached = H.trigger('slaBreached', H.on.event(conversations, 'slaBreach'))
  .moves(Escalated, { from: open, cancels: true });

const escalate = H.trigger('escalate', H.on.transition(conversations, { to: [Escalated] }))
  .creates(e => escalations.unit({
    attributes: { ticketId: e.unit.attributes.ticketId, reason: e.cause.ref === 'slaBreached' ? 'SLA breached' : e.cause.by },
  }));

const reviewerEdits = H.trigger('reviewerEdits', H.on.step(conversations, 'approval'))
  .where(e => e.output.editedBody !== null)
  .records(tone, e => [{
    rule: `When drafting for ${e.unit.attributes.category}, write the way the reviewer rewrote it: ${e.output.editedBody ?? ''}`,
    because: 'the reviewer edited the draft into this form before approving',
    when: { roles: [drafterRole], attributes: { category: e.unit.attributes.category } },
  }]);

const timeToBreach = H.policy.schedule('timeToBreach', c => ({
  start: c.order(
    k => (k.is(escalations) ? 0 : 1),
    k => (k.timers['slaBreach'] ?? Number.MAX_SAFE_INTEGER) - c.clock.now,
  ),
}));

const reviewerAccess = H.access('reviewer').allows([
  H.ops.readWork,
  H.ops.sendEvents,
  H.ops.resolveBlocks,
  H.ops.readMemory,
  H.ops.writeMemory,
  H.ops.curateMemory,
  H.ops.readTelemetry,
]);

export const supportTriage = H.harness('supportTriage')
  .ledger(sqlite.ledger('.harness/support.db'))
  .lanes([conversations, escalations])
  .triggers([customerReplied, customerSolved, slaBreached, escalate, reviewerEdits])
  .schedule(timeToBreach)
  .clients([claudeCode.supervisor('reviewer', reviewerAccess, { port: H.slot.port(0) })])
  .projections([markdown.board('BOARD.md'), markdown.telemetry('TELEMETRY.md')]);
