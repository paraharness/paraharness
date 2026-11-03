import { z } from 'zod';
import { H } from 'harness-dsl';
import type { Metric } from 'harness-dsl';
import * as sqlite from 'harness-dsl/sqlite';
import * as jsonl from 'harness-dsl/jsonl';
import * as anthropic from 'harness-dsl/anthropic';
import * as claudeCode from 'harness-dsl/claude-code';
import * as zendesk from 'harness-dsl/zendesk';
import * as markdown from 'harness-dsl/markdown';

const New = H.state.pending('New');
const Classifying = H.state.active('Classifying');
const Drafting = H.state.active('Drafting');
const AwaitingApproval = H.state.active('AwaitingApproval');
const Sent = H.state.terminal('Sent', 'success');
const ClosedByCustomer = H.state.terminal('ClosedByCustomer', 'neutral');
const Escalated = H.state.terminal('Escalated', 'failure');

const Open = H.state.pending('Open');
const Handling = H.state.active('Handling');
const Handled = H.state.terminal('Handled', 'success');
const Unhandled = H.state.waiting('Unhandled');

export const Conversation = H.work('Conversation')
  .attributes({ ticketId: z.number(), category: z.string(), slaDueAt: z.number() })
  .fields({ subject: z.string(), latestMessage: z.string(), requesterEmail: z.string() })
  .states([New, Classifying, Drafting, AwaitingApproval, Sent, ClosedByCustomer, Escalated])
  .events({ customerReplied: { body: z.string() }, customerClosed: {} })
  .timers(t => ({ slaBreach: t.attribute('slaDueAt') }))
  .key(u => String(u.attributes.ticketId));

export const Escalation = H.work('Escalation')
  .attributes({ ticketId: z.number(), category: z.string(), reason: z.string() })
  .states([Open, Handling, Handled, Unhandled])
  .key(u => String(u.attributes.ticketId));

const helpdesk = { subdomain: 'acme', token: H.env('ZENDESK_TOKEN') };
const defaultSlaMs = 4 * 60 * 60 * 1000;

const fromTicket = (ticket: zendesk.ZendeskTicket) => ({
  create: {
    attributes: {
      ticketId: ticket.id,
      category: 'unclassified',
      slaDueAt: ticket.slaDueAt ?? ticket.updatedAt + defaultSlaMs,
    },
    fields: { subject: ticket.subject, latestMessage: ticket.latestComment, requesterEmail: ticket.requesterEmail },
  },
});

const pushed = zendesk.webhook(
  Conversation,
  { ...helpdesk, port: H.slot.port(1), signingSecret: H.env('ZENDESK_SIGNING_SECRET') },
  event => {
    if (event.type === 'ticket.created') return fromTicket(event.ticket);
    if (event.type === 'comment.added' && event.fromCustomer) {
      return { key: String(event.ticket.id), event: 'customerReplied', payload: { body: event.ticket.latestComment } };
    }
    if (event.type === 'ticket.solved') return { key: String(event.ticket.id), event: 'customerClosed', payload: {} };
    return null;
  },
);

const polled = zendesk.poll(Conversation, H.time.every({ minutes: 15 }), helpdesk, ticket => fromTicket(ticket));

const helpdeskStore = zendesk.store(Conversation, {
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
});

const supportApi = anthropic.account('support-api', { apiKey: H.env('ANTHROPIC_API_KEY') });
const cheapModel = anthropic.model('claude-haiku-4-5');
const strongModel = anthropic.model('claude-sonnet-4-5');

const specificThenProven = H.policy.recall('specific-then-proven', c =>
  [...c.candidates]
    .sort(
      (a, b) =>
        b.specificity - a.specificity ||
        b.track.succeeded / Math.max(1, b.track.present) - a.track.succeeded / Math.max(1, a.track.present),
    )
    .slice(0, c.limit),
);

const toneJournal = H.journal('tone', H.memory.taste('tone').curated())
  .store(jsonl.memory('memory/tone.jsonl'))
  .recall(specificThenProven);

const supportExperience = H.journal('support-experience', H.memory.experience('support-experience'))
  .store(jsonl.memory('memory/support-experience.jsonl'))
  .recall(specificThenProven);

const classifierRole = H.role('classifier')
  .instructions('Classify the conversation into exactly one category from the support catalogue.')
  .input({ subject: z.string(), message: z.string() })
  .output({ category: z.string() });

const drafterRole = H.role('drafter')
  .instructions('Draft the reply the customer should receive next. Apply the reviewer notes when present.')
  .input({ subject: z.string(), message: z.string(), category: z.string(), notes: z.string() })
  .output({ reply: z.string() });

const classifier = H.agent('classifier', classifierRole).model(cheapModel).pool(supportApi);
const drafter = H.agent('drafter', drafterRole).model(strongModel).pool(supportApi).recalls([toneJournal, supportExperience]);

const safeCategory = H.policy.gate('safe-category-after-200-clean-approvals', c => {
  if (!c.unit) return false;
  const approvals = c.metrics.read(approvalRate, {
    kind: Conversation,
    model: strongModel,
    window: { days: 365 },
    where: { category: c.unit.attributes['category'] },
  });
  const keepSampling = c.unit.key.endsWith('0');
  return approvals.n >= 200 && approvals.hits === approvals.n && !keepSampling;
});

const sendReply = zendesk.reply('send-reply', helpdesk);

const triage = H.flow('triage')
  .requires({ ticketId: z.number(), subject: z.string(), latestMessage: z.string() })
  .mark('classifying')
  .step('classify', classifier, c => ({ subject: c.input.subject, message: c.input.latestMessage }), { onRestart: 'reconcile' })
  .sets({ category: z.string() }, c => ({ category: c.out.classify.category }))
  .loop(
    'rework',
    { carry: { notes: z.string() }, rounds: () => 3 },
    round =>
      round
        .mark('drafting')
        .step(
          'draft',
          drafter,
          c => ({
            subject: c.input.subject,
            message: c.input.latestMessage,
            category: c.input.category,
            notes: c.carry ? c.carry.notes : '',
          }),
          { onRestart: 'reconcile' },
        )
        .mark('awaitingApproval')
        .halt('approval', {
          ask: c => `Reply to ticket ${c.input.ticketId} (${c.input.category}):\n\n${c.out.draft.reply}`,
          decision: { approved: z.boolean(), edits: z.string(), notes: z.string() },
          skip: { when: safeCategory, decision: { approved: true, edits: '', notes: '' } },
        }),
    last => (last.approval.approved ? null : { notes: last.approval.notes }),
  )
  .exit('escalate', c => !c.out.rework.last.approval.approved)
  .step(
    'send',
    sendReply,
    c => ({
      ticketId: c.input.ticketId,
      body: c.out.rework.last.approval.edits.length > 0 ? c.out.rework.last.approval.edits : c.out.rework.last.draft.reply,
    }),
    { onRestart: 'park' },
  )
  .ends(['sent'], () => 'sent');

const approvalRate: Metric = H.metric('reply-approval').step(triage, 'approval').hit(decision => decision.approved);

const openStates = [New, Classifying, Drafting, AwaitingApproval];

export const conversations = H.lane('conversations', Conversation)
  .supply([pushed, polled])
  .store(helpdeskStore)
  .handler(triage, {
    states: {
      classifying: Classifying,
      drafting: Drafting,
      awaitingApproval: AwaitingApproval,
      escalate: Escalated,
      sent: Sent,
      failed: Escalated,
    },
  })
  .budget({ maxUsdPerUnit: 0.4, onExceed: 'halt' })
  .reacts({
    customerReplied: r =>
      r.to(New).from([Classifying, Drafting, AwaitingApproval]).updates(payload => ({ latestMessage: payload.body })),
    customerClosed: r => r.to(ClosedByCustomer).from(openStates),
    slaBreach: r => r.to(Escalated).from(openStates),
  });

const humanEscalation = H.flow('human-escalation')
  .requires({ ticketId: z.number(), reason: z.string() })
  .mark('handling')
  .halt('handle', {
    ask: c => `Ticket ${c.input.ticketId} was escalated (${c.input.reason}). Take it over and record how it was resolved.`,
    decision: { resolution: z.string() },
  })
  .ends(['handled'], () => 'handled');

export const escalations = H.lane('escalations', Escalation)
  .handler(humanEscalation, { states: { handling: Handling, handled: Handled, failed: Unhandled } });

const escalateToHumans = H.trigger('escalate-to-humans', H.on.transition(conversations, { to: [Escalated] }))
  .creates(escalations, e => ({
    attributes: {
      ticketId: e.unit.attributes.ticketId,
      category: e.unit.attributes.category,
      reason: `${e.cause.by}: ${e.cause.ref}`,
    },
  }));

const reviewerEditsBecomeTaste = H.trigger('reviewer-edits-become-taste', H.on.step(conversations, 'approval'))
  .where(e => e.status === 'succeeded' && e.output.edits.length > 0)
  .records(toneJournal, e => [
    {
      rule: `When drafting a ${e.unit.attributes.category} reply, write it the way the reviewer rewrote it: "${e.output.edits}"`,
      because: e.output.notes.length > 0 ? e.output.notes : 'the reviewer rewrote the draft before it was sent',
      when: { kinds: [Conversation], roles: [drafterRole], attributes: { category: e.unit.attributes.category } },
    },
  ]);

const timeToBreach = H.policy.schedule('time-to-breach', c => {
  const breachAt = (x: (typeof c.candidates)[number]) =>
    x.is(escalations) ? 0 : x.timers['slaBreach'] ?? Number.MAX_SAFE_INTEGER;
  return { start: [...c.candidates].sort((a, b) => breachAt(a) - breachAt(b)) };
});

const reviewerAccess = H.access('reviewer').allows([
  H.ops.readWork,
  H.ops.updateWork,
  H.ops.resolveBlocks,
  H.ops.recoverAttempts,
  H.ops.readMemory,
  H.ops.writeMemory,
  H.ops.curateMemory,
  H.ops.readTelemetry,
]);

export const supportTriage = H.harness('support-triage')
  .ledger(sqlite.ledger('.harness/support.db'))
  .lanes([conversations, escalations])
  .triggers([escalateToHumans, reviewerEditsBecomeTaste])
  .schedule(timeToBreach)
  .clients([claudeCode.supervisor('reviewer-supervisor', reviewerAccess, { port: H.slot.port(0) })])
  .projections([markdown.board('BOARD.md'), markdown.telemetry('TELEMETRY.md')]);
