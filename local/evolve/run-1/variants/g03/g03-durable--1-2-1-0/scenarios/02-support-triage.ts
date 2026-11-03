import { H } from 'harness-dsl';
import { z } from 'zod';
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
const Sent = H.state('Sent', 'waiting');
const ClosedByCustomer = H.state('ClosedByCustomer', 'terminal', 'success');
const Escalated = H.state('Escalated', 'terminal', 'failure');

const Conversation = H.work('conversation')
  .attributes({ ticketId: z.number(), category: z.string(), slaDueAt: z.number() })
  .fields({ subject: z.string(), message: z.string(), customer: z.string() })
  .states([New, Classifying, Drafting, AwaitingApproval, Sent, ClosedByCustomer, Escalated])
  .events({ customerReplied: { text: z.string() }, solved: { at: z.number() } })
  .timers(t => ({ slaBreach: t.attribute('slaDueAt') }))
  .key(u => String(u.attributes.ticketId));

const Open = H.state('Open', 'pending');
const Handling = H.state('Handling', 'active');
const Unattended = H.state('Unattended', 'waiting');
const Resolved = H.state('Resolved', 'terminal', 'success');

const Escalation = H.work('escalation')
  .attributes({ ticketId: z.number(), reason: z.string() })
  .states([Open, Handling, Unattended, Resolved])
  .key(u => String(u.attributes.ticketId));

const apiAccount = anthropic.account('support-api', { apiKey: H.env('ANTHROPIC_API_KEY') });
const haiku = anthropic.model('claude-haiku-4-5');
const sonnet = anthropic.model('claude-sonnet-4-5');
const opus = anthropic.model('claude-opus-4-1');

const approval = H.decision('reply-approval', {
  verdict: z.enum(['approve', 'edit', 'reject']),
  reply: z.string(),
  note: z.string(),
});

const approvalRate = H.metric('reply-approval-rate').of(approval).hit(d => d.verdict !== 'reject');

const trackRate = (x: { track: { present: number; succeeded: number } }) =>
  (x.track.succeeded + 1) / (x.track.present + 2);

const specificThenProven = H.policy.recall('specific-then-proven', c =>
  c.candidates
    .slice()
    .sort((a, b) => b.specificity - a.specificity || trackRate(b) - trackRate(a))
    .slice(0, c.limit));

const tone = H.playbook('support-tone', H.memory.taste('support-tone').curated())
  .store(jsonl.memory('.harness/memory/tone.jsonl'))
  .recall(specificThenProven);

const supportExperience = H.playbook('support-experience', H.memory.experience('support-experience'))
  .store(jsonl.memory('.harness/memory/experience.jsonl'))
  .recall(specificThenProven);

const classifierRole = H.role('classifier')
  .intents(['read'])
  .instructions('Classify the customer message into one category.')
  .input({ subject: z.string(), message: z.string() })
  .output({ category: z.enum(['billing', 'refund', 'technical', 'account', 'other']) });

const drafterRole = H.role('drafter')
  .intents(['read'])
  .instructions('Draft a reply to the customer in the house tone.')
  .input({ subject: z.string(), message: z.string(), category: z.string() })
  .output({ reply: z.string() });

const drafterModel = H.policy.model('drafter-by-approval', [sonnet, opus], (c, options) => {
  const unit = c.unitOf(Conversation);
  const reads = options.map(model => ({
    model,
    rate: c.metrics.read(approvalRate, {
      kind: Conversation,
      model,
      where: unit ? { category: unit.attributes.category } : undefined,
      window: { days: 30 },
    }),
  }));
  const thin = reads.filter(r => r.rate.n < 30)[0];
  if (thin) return thin.model;
  return reads.reduce((best, r) => (r.rate.rate ?? 0) > (best.rate.rate ?? 0) ? r : best).model;
});

const classifier = H.agent('classifier', classifierRole).model(haiku).pool(apiAccount);

const drafter = H.agent('drafter', drafterRole)
  .model(drafterModel)
  .pool(apiAccount)
  .recalls([tone, supportExperience]);

const connection = { subdomain: 'acme', token: H.env('ZENDESK_TOKEN') };
const sendReply = zendesk.reply('zendesk-reply', connection);

const triageFlow = H.flow('triage')
  .requires({ ticketId: z.number(), subject: z.string(), message: z.string() })
  .events({ customerReplied: { text: z.string() } })
  .step('classify', classifier, c => ({
    subject: c.input.subject,
    message: c.events.customerReplied[c.events.customerReplied.length - 1]?.payload.text ?? c.input.message,
  }))
  .sets({ category: z.string() }, c => ({ category: c.out.classify.category }))
  .step('draft', drafter, c => ({
    subject: c.input.subject,
    message: c.events.customerReplied[c.events.customerReplied.length - 1]?.payload.text ?? c.input.message,
    category: c.out.classify.category,
  }))
  .halt('approval', approval, {
    ask: c => `Reply to ticket ${c.input.ticketId} (${c.out.classify.category}):\n\n${c.out.draft.reply}`,
  })
  .exit('rejected', c => c.out.approval.verdict === 'reject')
  .step('send', sendReply, c => ({
    ticketId: c.input.ticketId,
    body: c.out.approval.verdict === 'edit' ? c.out.approval.reply : c.out.draft.reply,
  }))
  .ends(['sent'], () => 'sent');

const escalationDecision = H.decision('escalation-resolution', { note: z.string() });

const escalationFlow = H.flow('escalation')
  .requires({ ticketId: z.number(), reason: z.string() })
  .halt('handle', escalationDecision, {
    ask: c => `Ticket ${c.input.ticketId} escalated (${c.input.reason}). Take it over and record how it was resolved.`,
  })
  .ends(['resolved'], () => 'resolved');

const conversationOf = (t: zendesk.ZendeskTicket) => ({
  attributes: { ticketId: t.id, category: 'unclassified', slaDueAt: t.slaDueAt ?? t.updatedAt + 4 * 60 * 60 * 1000 },
  fields: { subject: t.subject, message: t.latestComment, customer: t.requesterEmail },
});

const conversations = H.lane('conversations', Conversation)
  .supply([
    zendesk.webhook(Conversation, { ...connection, port: H.slot.port(1), signingSecret: H.env('ZENDESK_SIGNING_SECRET') }, (event, s) => {
      const key = String(event.ticket.id);
      if (event.type === 'ticket.created') return s.create(conversationOf(event.ticket));
      if (event.type === 'ticket.solved') return s.event(key, 'solved', { at: event.ticket.updatedAt });
      return event.fromCustomer ? s.event(key, 'customerReplied', { text: event.ticket.latestComment }) : null;
    }),
    zendesk.poll(Conversation, H.time.every({ minutes: 10 }), connection, (ticket, s) => s.create(conversationOf(ticket))),
  ])
  .store(zendesk.store(Conversation, {
    ...connection,
    status: { New: 'new', Classifying: 'open', Drafting: 'open', AwaitingApproval: 'open', Sent: 'pending', ClosedByCustomer: 'solved', Escalated: 'open' },
  }))
  .budget({ maxUsdPerUnit: 0.4, onExceed: 'halt' })
  .retry(H.retry.fixed({ maxRetries: 2, delayMs: 60_000 }))
  .reacts({
    customerReplied: H.reaction(New).from([New, Sent, AwaitingApproval]).cancels(),
    solved: H.reaction(ClosedByCustomer).from([New, Sent]),
    slaBreach: H.reaction(Escalated).from([New, Classifying, Drafting, AwaitingApproval]).cancels(),
  })
  .handler(triageFlow, {
    opens: Classifying,
    during: { draft: Drafting, approval: AwaitingApproval },
    ends: { sent: Sent, rejected: { to: New, upTo: 2, then: Escalated } },
    exhausted: Escalated,
    skips: {
      approval: {
        name: 'proven-safe-category',
        when: g => {
          const r = g.metrics.read(approvalRate, {
            kind: Conversation,
            where: { category: g.unit.attributes.category },
            window: 'all',
          });
          return r.n >= 200 && r.hits === r.n;
        },
        decision: { verdict: 'approve', reply: '', note: 'skipped: category proven safe' },
      },
    },
  });

const escalations = H.lane('escalations', Escalation)
  .handler(escalationFlow, {
    opens: Handling,
    ends: { resolved: Resolved },
    exhausted: Unattended,
  });

const slaBreachEscalates = H.trigger(
  'sla-breach-escalates',
  H.on.event(conversations, 'slaBreach', { in: [New, Classifying, Drafting, AwaitingApproval] }),
).creates(e => escalations.unit({ attributes: { ticketId: e.unit.attributes.ticketId, reason: 'sla breached' } }));

const otherEscalations = H.trigger('rejections-and-failures-escalate', H.on.transition(conversations, { to: [Escalated] }))
  .where(e => e.cause.by !== 'event')
  .creates(e => escalations.unit({
    attributes: { ticketId: e.unit.attributes.ticketId, reason: e.end === 'rejected' ? 'drafts rejected twice' : 'attempts exhausted' },
  }));

const editsBecomeTaste = H.trigger('reviewer-edits-become-taste', H.on.step(conversations, 'approval'))
  .where(e => e.status === 'succeeded' && e.output.verdict === 'edit' && e.output.note.length > 0)
  .records(tone, e => [{
    rule: e.output.note,
    because: `the reviewer edited a ${e.unit.attributes.category} draft this way`,
    when: { roles: [drafterRole] },
  }]);

const schedule = H.policy.schedule('time-to-breach', c => ({
  start: c.order(
    x => x.is(escalations) ? 0 : 1,
    x => x.is(conversations) ? x.unit.attributes.slaDueAt - c.clock.now : Infinity,
  ),
}));

const reviewerAccess = H.access('reviewer').allows([
  H.ops.readWork,
  H.ops.updateWork,
  H.ops.sendEvents,
  H.ops.resolveBlocks,
  H.ops.readMemory,
  H.ops.writeMemory,
  H.ops.curateMemory,
  H.ops.readTelemetry,
]);

export const harness = H.harness('support-triage')
  .ledger(sqlite.ledger('.harness/ledger.db'))
  .lanes([conversations, escalations])
  .triggers([slaBreachEscalates, otherEscalations, editsBecomeTaste])
  .schedule(schedule)
  .clients([claudeCode.supervisor('reviewer', reviewerAccess, { port: H.slot.port(0) })])
  .projections([markdown.board('BOARD.md'), markdown.telemetry('TELEMETRY.md')]);
