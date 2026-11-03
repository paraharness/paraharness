import { z } from 'zod';
import { H } from 'harness-dsl';
import * as anthropic from 'harness-dsl/anthropic';
import * as claudeCode from 'harness-dsl/claude-code';
import * as zendesk from 'harness-dsl/zendesk';
import type { ZendeskTicket } from 'harness-dsl/zendesk';
import * as sqlite from 'harness-dsl/sqlite';
import * as jsonl from 'harness-dsl/jsonl';
import * as markdown from 'harness-dsl/markdown';

const New = H.state('New', 'pending');
const Classifying = H.state('Classifying', 'active');
const Drafting = H.state('Drafting', 'active');
const AwaitingApproval = H.state('AwaitingApproval', 'active');
const Sent = H.state('Sent', 'terminal', 'success');
const ClosedByCustomer = H.state('ClosedByCustomer', 'terminal', 'neutral');
const Escalated = H.state('Escalated', 'terminal', 'failure');

const Conversation = H.work('Conversation')
  .attributes({ ticketId: z.number(), category: z.string(), slaDueAt: z.number() })
  .fields({ subject: z.string(), latestMessage: z.string(), requesterEmail: z.string() })
  .states([New, Classifying, Drafting, AwaitingApproval, Sent, ClosedByCustomer, Escalated])
  .events({ customerReplied: { message: z.string() }, customerClosed: {} })
  .timers((t) => ({ slaBreach: t.attribute('slaDueAt') }))
  .key((u) => String(u.attributes.ticketId));

const Raised = H.state('Raised', 'pending');
const Handling = H.state('Handling', 'active');
const Handled = H.state('Handled', 'terminal', 'success');

const Escalation = H.work('Escalation')
  .attributes({ ticketId: z.number(), category: z.string() })
  .fields({ reason: z.string() })
  .states([Raised, Handling, Handled])
  .key((u) => String(u.attributes.ticketId));

const AuditOpen = H.state('AuditOpen', 'pending');
const AuditUnderReview = H.state('AuditUnderReview', 'active');
const AuditClosed = H.state('AuditClosed', 'terminal', 'success');
const AuditCancelled = H.state('AuditCancelled', 'terminal', 'neutral');

const Audit = H.work('Audit')
  .attributes({ category: z.string() })
  .fields({ openedAtRate: z.number() })
  .states([AuditOpen, AuditUnderReview, AuditClosed, AuditCancelled])
  .events({ recovered: { rate: z.number() } })
  .key((u) => u.attributes.category);

const mostSpecificFirst = H.policy.recall('most-specific-first', (c) =>
  [...c.candidates]
    .sort((a, b) => b.specificity - a.specificity || b.track.succeeded - a.track.succeeded)
    .slice(0, c.limit),
);
const SupportTaste = H.memory.taste('support-taste').curated();
const SupportExperience = H.memory.experience('support-experience').curated();
const taste = H.journal('support-taste', SupportTaste).store(jsonl.memory('.harness/taste.jsonl')).recall(mostSpecificFirst);
const experience = H.journal('support-experience', SupportExperience)
  .store(jsonl.memory('.harness/experience.jsonl'))
  .recall(mostSpecificFirst);

const classifierRole = H.role('classifier')
  .intents(['read'])
  .instructions('Classify the customer conversation into exactly one support category.')
  .input({ subject: z.string(), message: z.string() })
  .output({ category: z.string() });
const drafterRole = H.role('drafter')
  .intents(['read'])
  .instructions('Draft the reply to the customer in the house tone. Apply the reviewer notes when given.')
  .input({ subject: z.string(), message: z.string(), category: z.string(), notes: z.string() })
  .output({ reply: z.string() });

const approval = H.decision('reply-approval', { approved: z.boolean(), notes: z.string(), editedReply: z.string() });
const approvalRate = H.metric('reply-approved').of(approval).hit((d) => d.approved);

const api = anthropic.account('support-api', { apiKey: H.env('ANTHROPIC_API_KEY') });
const haiku = anthropic.model('claude-haiku-4-5');
const sonnet = anthropic.model('claude-sonnet-4-5');
const opus = anthropic.model('claude-opus-4-1');

const drafterModel = H.policy.model('drafter-by-approval', [sonnet, opus], (c) => {
  const cheaper = c.metrics.read(approvalRate, { agent: c.agent, model: sonnet, window: { days: 30 } });
  return cheaper.n >= 100 && cheaper.rate !== null && cheaper.rate < 0.9 ? opus : sonnet;
});

const classifier = H.agent('classifier', classifierRole).model(haiku).pool(api);
const drafter = H.agent('drafter', drafterRole).model(drafterModel).pool(api).recalls([taste, experience]);

const helpdesk = { subdomain: 'acme', token: H.env('ZENDESK_TOKEN') };
const sendReply = zendesk.reply('send-reply', helpdesk);

const triage = H.flow('triage')
  .requires({ ticketId: z.number(), category: z.string(), subject: z.string(), latestMessage: z.string(), requesterEmail: z.string() })
  .events({ customerReplied: { message: z.string() } })
  .step('classify', classifier, (c) => ({
    subject: c.input.subject,
    message: c.events.customerReplied.reduce((_previous, received) => received.payload.message, c.input.latestMessage),
  }))
  .sets({ category: z.string() }, (c) => ({ category: c.out.classify.category }))
  .mark('drafting')
  .loop(
    'rounds',
    { carry: { notes: z.string() }, rounds: () => 3 },
    (round) =>
      round
        .step('draft', drafter, (c) => ({
          subject: c.input.subject,
          message: c.events.customerReplied.reduce((_previous, received) => received.payload.message, c.input.latestMessage),
          category: c.input.category,
          notes: c.carry?.notes ?? '',
        }))
        .mark('awaitingApproval')
        .halt('approval', approval, { ask: (c) => `[${c.input.category}] ${c.input.subject}\n\n${c.out.draft.reply}` }),
    (last) => (last.approval.approved ? null : { notes: last.approval.notes }),
  )
  .exit('escalate', (c) => !c.out.rounds.last.approval.approved)
  .step(
    'send',
    sendReply,
    (c) => ({ ticketId: c.input.ticketId, body: c.out.rounds.last.approval.editedReply || c.out.rounds.last.draft.reply }),
    { restart: 'park' },
  )
  .ends(['sent'], () => 'sent');

const fromTicket = (ticket: ZendeskTicket) => ({
  attributes: { ticketId: ticket.id, category: 'unclassified', slaDueAt: ticket.slaDueAt ?? ticket.updatedAt + 4 * 3600000 },
  fields: { subject: ticket.subject, latestMessage: ticket.latestComment, requesterEmail: ticket.requesterEmail },
});

const conversations = H.lane('conversations', Conversation)
  .supply([
    zendesk.webhook(Conversation, { ...helpdesk, port: H.slot.port(1), signingSecret: H.env('ZENDESK_SIGNING_SECRET') }, (event, to) =>
      event.type === 'ticket.created'
        ? to.create(fromTicket(event.ticket))
        : event.type === 'ticket.solved'
          ? to.event(String(event.ticket.id), 'customerClosed', {})
          : event.fromCustomer
            ? to.event(String(event.ticket.id), 'customerReplied', { message: event.ticket.latestComment })
            : null,
    ),
    zendesk.poll(Conversation, H.time.every({ minutes: 15 }), helpdesk, (ticket, to) =>
      ticket.status === 'solved' || ticket.status === 'closed' ? null : to.create(fromTicket(ticket)),
    ),
  ])
  .store(
    zendesk.store(Conversation, {
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
    }),
  )
  .budget({ maxUsdPerUnit: 0.4, onExceed: 'halt' })
  .reacts({
    customerReplied: H.reaction(New).from([New, Classifying, Drafting, AwaitingApproval]).cancels(),
    customerClosed: H.reaction(ClosedByCustomer).from([New, Classifying, Drafting, AwaitingApproval]).cancels(),
    slaBreach: H.reaction(Escalated).from([New, Classifying, Drafting, AwaitingApproval]).cancels(),
  })
  .handler(triage, {
    ends: { escalate: Escalated, sent: Sent },
    marks: { drafting: Drafting, awaitingApproval: AwaitingApproval },
    skips: {
      approval: {
        name: 'safe-category',
        decision: { approved: true, notes: '', editedReply: '' },
        when: (g) => {
          const record = g.metrics.read(approvalRate, {
            kind: Conversation,
            where: { category: g.unit.attributes.category },
            window: 'ever',
          });
          return record.n >= 200 && record.hits === record.n;
        },
      },
    },
  });

const escalationOutcome = H.decision('escalation-outcome', { resolution: z.string() });
const handleEscalation = H.flow('handle-escalation')
  .requires({ ticketId: z.number(), reason: z.string() })
  .halt('resolution', escalationOutcome, { ask: (c) => `Ticket ${c.input.ticketId} escalated: ${c.input.reason}` })
  .ends(['handled'], () => 'handled');

const escalations = H.lane('escalations', Escalation)
  .supply([H.supply.operator()])
  .handler(handleEscalation, { ends: { handled: Handled } });

const auditFindings = H.decision('audit-findings', { findings: z.string() });
const reviewAudit = H.flow('review-audit')
  .requires({ category: z.string(), openedAtRate: z.number() })
  .halt('findings', auditFindings, {
    ask: (c) => `Approvals for ${c.input.category} fell to ${c.input.openedAtRate}. Review recent drafts and record findings.`,
  })
  .ends(['closed'], () => 'closed');

const audits = H.lane('audits', Audit)
  .reuseKeys()
  .reacts({ recovered: H.reaction(AuditCancelled).from([AuditOpen, AuditUnderReview]).cancels() })
  .handler(reviewAudit, { ends: { closed: AuditClosed } });

const approvalByCategory = H.threshold('approval-by-category', approvalRate, {
  kind: Conversation,
  per: 'category',
  window: { days: 7 },
  minSamples: 50,
  trips: { below: 0.9 },
  resets: { above: 0.95 },
});

const modelErrors = H.metric('model-errors')
  .invocations(['agent'])
  .hit((i) => i.status === 'failed' || i.status === 'timedOut');
const modelErrorRate = H.threshold('model-error-rate', modelErrors, {
  window: { hours: 1 },
  minSamples: 20,
  trips: { above: 0.2 },
  resets: { below: 0.05 },
});

const escalatedOpensEscalation = H.trigger('escalated-opens-escalation', H.on.transition(conversations, { to: [Escalated] }))
  .creates((e) =>
    escalations.unit({
      attributes: { ticketId: e.unit.attributes.ticketId, category: e.unit.attributes.category },
      fields: { reason: e.cause.by === 'event' ? 'SLA breached or customer event' : 'draft rejected in every round' },
    }),
  );

const editsBecomeTaste = H.trigger('reviewer-edits-become-taste', H.on.transition(conversations, { to: [Sent] }))
  .records(taste, (e) => {
    const decided = e.outputs.rounds?.last.approval;
    return decided && decided.notes.length > 0
      ? [
          {
            rule: `When drafting replies for ${e.unit.attributes.category}, ${decided.notes}`,
            because: `the reviewer edited the reply to ticket ${e.unit.attributes.ticketId} this way`,
            when: { kinds: [Conversation], roles: [drafterRole] },
          },
        ]
      : [];
  });

const approvalsFellOpensAudit = H.trigger('approvals-fell-opens-audit', H.on.crossed(approvalByCategory))
  .creates((e) => audits.unit({ attributes: { category: e.group.category }, fields: { openedAtRate: e.rate } }))
  .records(experience, (e) => [
    {
      rule: `When drafting for ${e.group.category}, recall the stricter phrasing`,
      because: `approvals fell to ${e.rate.toFixed(2)} over ${e.n} samples`,
      when: { kinds: [Conversation], roles: [drafterRole], attributes: { category: e.group.category } },
    },
  ]);

const approvalsRecoveredCancelsAudit = H.trigger('approvals-recovered-cancels-audit', H.on.recovered(approvalByCategory))
  .sends((e) => audits.event(e.group.category, 'recovered', { rate: e.rate }));

const modelErrorsPauseConversations = H.trigger('model-errors-pause-conversations', H.on.crossed(modelErrorRate))
  .pauses(conversations);
const modelErrorsRecoveredResumeConversations = H.trigger('model-errors-recovered-resume-conversations', H.on.recovered(modelErrorRate))
  .resumes(conversations);

const supportSchedule = H.policy.schedule('escalations-breach-audits', (c) => {
  const monthStart = c.clock.startOfMonth();
  const auditsOpened = (category: string) => c.metrics.count({ kind: Audit, where: { category }, sinceMs: monthStart });
  const escalationsFirst = c.candidates.filter((x) => x.is(escalations));
  const byTimeToBreach = c.candidates
    .flatMap((x) => (x.is(conversations) ? [x] : []))
    .sort((a, b) => a.unit.attributes.slaDueAt - b.unit.attributes.slaDueAt);
  const auditsByRecurrence = c.candidates
    .flatMap((x) => (x.is(audits) ? [x] : []))
    .sort((a, b) => auditsOpened(b.unit.attributes.category) - auditsOpened(a.unit.attributes.category));
  const longPauseThisMonth = c.metrics.pausedMs({ lane: conversations, sinceMs: monthStart }) > 3600000;
  return {
    start: longPauseThisMonth
      ? [...escalationsFirst, ...auditsByRecurrence, ...byTimeToBreach]
      : [...escalationsFirst, ...byTimeToBreach, ...auditsByRecurrence],
  };
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

export const supportWatching = H.harness('support')
  .ledger(sqlite.ledger('.harness/ledger.sqlite'))
  .lanes([conversations, escalations, audits])
  .triggers([
    escalatedOpensEscalation,
    editsBecomeTaste,
    approvalsFellOpensAudit,
    approvalsRecoveredCancelsAudit,
    modelErrorsPauseConversations,
    modelErrorsRecoveredResumeConversations,
  ])
  .schedule(supportSchedule)
  .clients([claudeCode.supervisor('reviewer-supervisor', reviewerAccess, { port: H.slot.port(0) })])
  .projections([markdown.board('.harness/board.md'), markdown.telemetry('.harness/telemetry.md')]);
