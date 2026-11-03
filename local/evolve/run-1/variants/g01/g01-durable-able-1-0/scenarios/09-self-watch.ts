import { z } from 'zod';
import { H } from 'harness-dsl';
import type { Candidate, GatePolicy } from 'harness-dsl/kernel';
import * as sqlite from 'harness-dsl/sqlite';
import * as jsonl from 'harness-dsl/jsonl';
import * as anthropic from 'harness-dsl/anthropic';
import * as zendesk from 'harness-dsl/zendesk';
import type { ZendeskTicket } from 'harness-dsl/zendesk';
import * as claudeCode from 'harness-dsl/claude-code';
import * as markdown from 'harness-dsl/markdown';

const helpdesk = { subdomain: 'acme', token: H.env('ZENDESK_TOKEN') };
const supportApi = anthropic.account('support-api', { apiKey: H.env('ANTHROPIC_API_KEY') });
const haiku = anthropic.model('claude-haiku-4');
const sonnet = anthropic.model('claude-sonnet-4');

const specificFirst = H.policy.recall('specific-then-proven', c =>
  [...c.candidates]
    .sort((a, b) => b.specificity - a.specificity || b.track.succeeded - a.track.succeeded)
    .slice(0, c.limit),
);
const toneTaste = H.journal('reviewer-taste-journal', H.memory.taste('reviewer-taste'))
  .store(jsonl.memory('memory/taste.jsonl'))
  .recall(specificFirst);
const drafterLessons = H.journal('drafter-lessons-journal', H.memory.experience('drafter-lessons').curated())
  .store(jsonl.memory('memory/drafter-lessons.jsonl'))
  .recall(specificFirst);

const New = H.state('new', 'pending');
const Classifying = H.state('classifying', 'active');
const Drafting = H.state('drafting', 'active');
const AwaitingApproval = H.state('awaiting-approval', 'active');
const NeedsAttention = H.state('needs-attention', 'waiting');
const Sent = H.state('sent', 'terminal', 'success');
const ClosedByCustomer = H.state('closed-by-customer', 'terminal', 'neutral');
const Escalated = H.state('escalated', 'terminal', 'failure');

const Conversation = H.work('conversation')
  .attributes({ ticketId: z.number(), category: z.string(), slaDueAt: z.number(), latestMessage: z.string() })
  .states([New, Classifying, Drafting, AwaitingApproval, NeedsAttention, Sent, ClosedByCustomer, Escalated])
  .events({ customerReplied: { message: z.string() }, solved: { at: z.number() } })
  .timers(t => ({ sla: t.attribute('slaDueAt') }))
  .key(conversation => String(conversation.attributes.ticketId));

const classifierRole = H.role('classifier')
  .intents(['read'])
  .instructions('Classify the customer message into one support category.')
  .input({ message: z.string() })
  .output({ category: z.string() });

const drafterRole = H.role('drafter')
  .intents(['read'])
  .instructions('Draft a reply in the house tone. Cite policy where the lessons say so.')
  .input({ message: z.string(), category: z.string() })
  .output({ reply: z.string() });

const classifier = H.agent('classifier', classifierRole).model(haiku).pool(supportApi);
const drafter = H.agent('drafter', drafterRole).model(sonnet).pool(supportApi).recalls([toneTaste, drafterLessons]);
const sendReply = zendesk.reply('helpdesk-reply', helpdesk);

const safeCategorySkipsApproval: GatePolicy = H.policy.gate('safe-category-skips-approval', c => {
  const category = String(c.unit?.attributes.category ?? '');
  const approvals = c.metrics.read(approvalRate, { lane: conversations, window: { days: 90 }, where: { category } });
  const auditsThisMonth = c.metrics.created({ lane: audits, window: { days: 30 }, where: { category } });
  const pausedThisMonth = c.metrics.paused(conversations, { days: 30 });
  return (
    approvals.hits >= 200 &&
    approvals.hits === approvals.n &&
    auditsThisMonth === 0 &&
    !pausedThisMonth.pausedNow &&
    pausedThisMonth.totalMs < 6 * 60 * 60 * 1000
  );
});

const conversationFlow = H.flow('conversation')
  .requires({ ticketId: z.number(), latestMessage: z.string() })
  .mark('classifying')
  .step('classify', classifier, c => ({ message: c.input.latestMessage }))
  .sets({ category: z.string() }, c => ({ category: c.out.classify.category }))
  .mark('drafting')
  .step('draft', drafter, c => ({ message: c.input.latestMessage, category: c.input.category }))
  .mark('awaitingApproval')
  .halt('approval', {
    ask: c => `Approve this reply for ticket ${c.input.ticketId} (${c.input.category})?\n\n${c.out.draft.reply}`,
    decision: { approved: z.boolean(), reply: z.string().nullable() },
    skip: { when: safeCategorySkipsApproval, decision: { approved: true, reply: null } },
  })
  .exit('rejected', c => !c.out.approval.approved)
  .step('send', sendReply, c => ({ ticketId: c.input.ticketId, body: c.out.approval.reply ?? c.out.draft.reply }), {
    effect: 'unrepeatable',
  })
  .ends(['sent'], () => 'sent');

const created = (ticket: ZendeskTicket) => ({
  create: {
    attributes: {
      ticketId: ticket.id,
      category: 'unclassified',
      slaDueAt: ticket.slaDueAt ?? ticket.updatedAt + 4 * 60 * 60 * 1000,
      latestMessage: ticket.latestComment,
    },
  },
});

const conversations = H.lane('conversations', Conversation)
  .supply([
    zendesk.webhook(Conversation, { ...helpdesk, port: H.slot.port(1), signingSecret: H.env('ZENDESK_SIGNING_SECRET') }, event => {
      const key = String(event.ticket.id);
      if (event.type === 'ticket.created') return created(event.ticket);
      if (event.type === 'ticket.solved') return { key, event: 'solved', payload: { at: event.ticket.updatedAt } };
      return event.fromCustomer ? { key, event: 'customerReplied', payload: { message: event.ticket.latestComment } } : null;
    }),
    zendesk.poll(Conversation, H.time.every({ minutes: 5 }), helpdesk, created),
  ])
  .store(
    zendesk.store(Conversation, {
      ...helpdesk,
      status: {
        new: 'new',
        classifying: 'open',
        drafting: 'open',
        'awaiting-approval': 'pending',
        'needs-attention': 'open',
        sent: 'solved',
        'closed-by-customer': 'closed',
        escalated: 'open',
      },
    }),
  )
  .budget({ maxUsdPerUnit: 0.4, onExceed: 'halt' })
  .handler(conversationFlow, {
    states: {
      classifying: Classifying,
      drafting: Drafting,
      awaitingApproval: AwaitingApproval,
      rejected: New,
      sent: Sent,
      failed: NeedsAttention,
    },
  })
  .reaction('customerReplied', New, {
    from: [Classifying, Drafting, AwaitingApproval, NeedsAttention],
    sets: payload => ({ latestMessage: payload.message }),
  })
  .reaction('solved', ClosedByCustomer)
  .reaction('sla', Escalated, { from: [New, Classifying, Drafting, AwaitingApproval, NeedsAttention] });

const EscalationOpen = H.state('escalation-open', 'pending');
const EscalationHandling = H.state('escalation-handling', 'active');
const EscalationHandled = H.state('escalation-handled', 'terminal', 'success');

const Escalation = H.work('escalation')
  .attributes({ ticketId: z.number(), reason: z.string() })
  .states([EscalationOpen, EscalationHandling, EscalationHandled])
  .key(escalation => String(escalation.attributes.ticketId));

const escalationFlow = H.flow('escalation')
  .requires({ ticketId: z.number(), reason: z.string() })
  .mark('handling')
  .halt('resolution', {
    ask: c => `Ticket ${c.input.ticketId} escalated: ${c.input.reason}. Take it over and record the resolution.`,
    decision: { resolution: z.string() },
  })
  .ends(['handled'], () => 'handled');

const escalations = H.lane('escalations', Escalation)
  .handler(escalationFlow, {
    states: { handling: EscalationHandling, handled: EscalationHandled, failed: EscalationOpen },
  });

const AuditOpen = H.state('audit-open', 'pending');
const Auditing = H.state('auditing', 'active');
const AuditClosed = H.state('audit-closed', 'terminal', 'success');
const AuditCancelled = H.state('audit-cancelled', 'terminal', 'neutral');

const Audit = H.work('audit')
  .attributes({ category: z.string(), openedAtRate: z.number() })
  .states([AuditOpen, Auditing, AuditClosed, AuditCancelled])
  .events({ recovered: { rate: z.number() } })
  .key(audit => audit.attributes.category, { unique: 'whileOpen' });

const auditFlow = H.flow('category-audit')
  .requires({ category: z.string(), openedAtRate: z.number() })
  .mark('auditing')
  .halt('findings', {
    ask: c => `Approvals for ${c.input.category} fell to ${c.input.openedAtRate.toFixed(2)}. Audit recent drafts and record findings.`,
    decision: { findings: z.string() },
  })
  .ends(['closed'], () => 'closed');

const audits = H.lane('audits', Audit)
  .handler(auditFlow, { states: { auditing: Auditing, closed: AuditClosed, failed: AuditOpen } })
  .reaction('recovered', AuditCancelled, { from: [AuditOpen, Auditing] });

const approvalRate = H.metric('approval-rate')
  .step(conversationFlow, 'approval')
  .hit(decision => decision.approved);

const approvalByCategory = H.threshold('approval-by-category', approvalRate, {
  lane: conversations,
  per: 'category',
  window: { days: 7 },
  minN: 50,
  breach: { below: 0.9 },
  recovery: { above: 0.95 },
});

const modelErrors = H.metric('model-error-rate')
  .invocations(invocation => invocation.kind === 'agent' && invocation.status !== 'interrupted')
  .hit(invocation => invocation.status === 'failed' || invocation.status === 'timedOut');

const modelHealth = H.threshold('model-health', modelErrors, {
  window: { hours: 1 },
  minN: 20,
  breach: { above: 0.2 },
  recovery: { below: 0.05 },
});

const openAuditOnApprovalDrop = H.trigger('open-audit-on-approval-drop', H.on.crossing(approvalByCategory, 'breach'))
  .creates(audits, e => ({ attributes: { category: e.group, openedAtRate: e.reading.rate ?? 0 } }))
  .records(drafterLessons, e => [
    {
      rule: `When drafting for ${e.group}, recall the stricter phrasing`,
      because: `approvals fell to ${(e.reading.rate ?? 0).toFixed(2)} over ${e.reading.n} samples`,
      when: { roles: [drafterRole], attributes: { category: e.group } },
    },
  ]);

const cancelAuditOnRecovery = H.trigger('cancel-audit-on-recovery', H.on.crossing(approvalByCategory, 'recovery'))
  .sends(audits, 'recovered', e => ({ key: e.group, payload: { rate: e.reading.rate ?? 0 } }));

const pauseOnModelErrors = H.trigger('pause-conversations-on-model-errors', H.on.crossing(modelHealth, 'breach'))
  .pauses(conversations);

const resumeOnModelRecovery = H.trigger('resume-conversations-on-model-recovery', H.on.crossing(modelHealth, 'recovery'))
  .resumes(conversations);

const escalateOnSlaBreach = H.trigger('escalate-on-sla-breach', H.on.event(conversations, 'sla'))
  .where(e => e.reaction !== null)
  .creates(escalations, e => ({
    attributes: { ticketId: e.unit.attributes.ticketId, reason: `SLA breached at ${new Date(e.payload.dueAt).toISOString()}` },
  }));

const timeToBreach = (candidate: Candidate, now: number): number =>
  candidate.is(conversations) ? candidate.unit.attributes.slaDueAt - now : Number.NEGATIVE_INFINITY;

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

export const harness = H.harness('support')
  .ledger(sqlite.ledger('state/support.db'))
  .lanes([conversations, escalations, audits])
  .triggers([
    openAuditOnApprovalDrop,
    cancelAuditOnRecovery,
    pauseOnModelErrors,
    resumeOnModelRecovery,
    escalateOnSlaBreach,
  ])
  .schedule(
    H.policy.schedule('time-to-breach', c => ({
      start: [...c.candidates].sort((a, b) => timeToBreach(a, c.clock.now) - timeToBreach(b, c.clock.now)),
    })),
  )
  .clients([claudeCode.supervisor('reviewer-desk', reviewerAccess, { port: H.slot.port(0) })])
  .projections([markdown.board('BOARD.md'), markdown.telemetry('TELEMETRY.md')]);

export const running = harness.start();
