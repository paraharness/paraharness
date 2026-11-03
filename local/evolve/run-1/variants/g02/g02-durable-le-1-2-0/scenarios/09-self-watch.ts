import { z } from 'zod';
import { H } from 'harness-dsl';
import type { Candidate } from 'harness-dsl/kernel';
import type { ZendeskTicket } from 'harness-dsl/zendesk';
import * as zendesk from 'harness-dsl/zendesk';
import * as anthropic from 'harness-dsl/anthropic';
import * as sqlite from 'harness-dsl/sqlite';
import * as jsonl from 'harness-dsl/jsonl';
import * as claudeCode from 'harness-dsl/claude-code';
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
  .fields({ subject: z.string(), latestComment: z.string(), requester: z.string() })
  .states([New, Classifying, Drafting, AwaitingApproval, Sent, ClosedByCustomer, Escalated])
  .events({ customerReplied: { comment: z.string() }, solved: {} })
  .timers(t => ({ slaBreach: t.attribute('slaDueAt') }))
  .key(u => String(u.attributes.ticketId));

const EscalationOpen = H.state('EscalationOpen', 'pending');
const EscalationHandling = H.state('EscalationHandling', 'active');
const EscalationResolved = H.state('EscalationResolved', 'terminal', 'success');

const Escalation = H.work('Escalation')
  .attributes({ ticketId: z.number(), reason: z.string() })
  .states([EscalationOpen, EscalationHandling, EscalationResolved])
  .key(u => String(u.attributes.ticketId));

const AuditOpen = H.state('AuditOpen', 'pending');
const Auditing = H.state('Auditing', 'active');
const AuditDone = H.state('AuditDone', 'terminal', 'success');
const AuditCancelled = H.state('AuditCancelled', 'terminal', 'neutral');

const Audit = H.work('Audit')
  .attributes({ category: z.string(), trippedAt: z.number(), rateAtOpen: z.number() })
  .states([AuditOpen, Auditing, AuditDone, AuditCancelled])
  .events({ recovered: { rate: z.number() } })
  .key(u => `${u.attributes.category}@${u.attributes.trippedAt}`);

const mostSpecificFirst = H.policy.recall('most-specific-first', c =>
  [...c.candidates]
    .sort((a, b) => b.specificity - a.specificity || b.track.succeeded - a.track.succeeded)
    .slice(0, c.limit),
);
const supportTaste = H.memory.taste('support-taste');
const supportExperience = H.memory.experience('support-experience').curated();
const tasteJournal = H.journal('support-taste', supportTaste)
  .store(jsonl.memory('memory/support-taste.jsonl'))
  .recall(mostSpecificFirst);
const experienceJournal = H.journal('support-experience', supportExperience)
  .store(jsonl.memory('memory/support-experience.jsonl'))
  .recall(mostSpecificFirst);

const api = anthropic.account('support-api', { apiKey: H.env('ANTHROPIC_API_KEY') });
const haiku = anthropic.model('claude-haiku-4-5');
const sonnet = anthropic.model('claude-sonnet-4-5');
const opus = anthropic.model('claude-opus-4-1');

const drafterModel = H.policy.model('drafter-model', [sonnet, opus], c => {
  const unit = c.unit;
  if (unit === null || !unit.is(Conversation)) return sonnet;
  const auditsThisMonth = c.metrics.count({
    kind: Audit,
    where: { category: unit.attributes.category },
    sinceMs: c.clock.startOfMonth(),
  });
  return auditsThisMonth > 0 ? opus : sonnet;
});

const classifierRole = H.role('classifier')
  .intents(['read'])
  .instructions('Classify the customer conversation into one support category.')
  .input({ subject: z.string(), comment: z.string() })
  .output({ category: z.string() });
const drafter = H.role('drafter')
  .intents(['read'])
  .instructions('Draft a reply in the house tone, citing policy where it applies.')
  .input({ subject: z.string(), comment: z.string(), category: z.string() })
  .output({ reply: z.string() });

const classifierAgent = H.agent('classifier', classifierRole).model(haiku).pool(api);
const drafterAgent = H.agent('drafter', drafter)
  .model(drafterModel)
  .pool(api)
  .recalls([tasteJournal, experienceJournal]);

const helpdesk = { subdomain: 'acme', token: H.env('ZENDESK_TOKEN') };
const sendReply = zendesk.reply('send-reply', helpdesk);
const replyApproval = H.decision('reply-approval', { approved: z.boolean(), editedReply: z.string() });
const approvedReplies = H.metric('reply-approved').of(replyApproval).hit(decision => decision.approved);

const conversationFlow = H.flow('conversation')
  .requires({ ticketId: z.number(), subject: z.string(), latestComment: z.string() })
  .step('classify', classifierAgent, c => ({ subject: c.input.subject, comment: c.input.latestComment }))
  .sets({ category: z.string() }, c => ({ category: c.out.classify.category }))
  .mark('drafting')
  .step('draft', drafterAgent, c => ({ subject: c.input.subject, comment: c.input.latestComment, category: c.input.category }))
  .mark('awaitingApproval')
  .halt('approval', replyApproval, { ask: c => `Approve the reply to ticket ${c.input.ticketId}?\n\n${c.out.draft.reply}` })
  .exit('rejected', c => !c.out.approval.approved)
  .step('send', sendReply, c => ({
    ticketId: c.input.ticketId,
    body: c.out.approval.editedReply.length > 0 ? c.out.approval.editedReply : c.out.draft.reply,
  }))
  .ends(['sent'], () => 'sent');

const escalationResolution = H.decision('escalation-resolution', { resolution: z.string() });
const escalationFlow = H.flow('escalation')
  .requires({ ticketId: z.number(), reason: z.string() })
  .halt('handle', escalationResolution, { ask: c => `Ticket ${c.input.ticketId} escalated: ${c.input.reason}` })
  .ends(['resolved'], () => 'resolved');

const auditFindings = H.decision('audit-findings', { findings: z.string(), actions: z.array(z.string()) });
const auditFlow = H.flow('category-audit')
  .requires({ category: z.string(), rateAtOpen: z.number() })
  .halt('findings', auditFindings, {
    ask: c => `Audit the ${c.input.category} category: approvals fell to ${c.input.rateAtOpen}.`,
  })
  .ends(['audited'], () => 'audited');

const fourHoursMs = 4 * 60 * 60 * 1000;
function conversationFrom(ticket: ZendeskTicket) {
  return {
    attributes: { ticketId: ticket.id, category: 'unclassified', slaDueAt: ticket.slaDueAt ?? ticket.updatedAt + fourHoursMs },
    fields: { subject: ticket.subject, latestComment: ticket.latestComment, requester: ticket.requesterEmail },
  };
}

const conversations = H.lane('conversations', Conversation)
  .supply([
    zendesk.webhook(Conversation, { ...helpdesk, port: H.slot.port(1), signingSecret: H.env('ZENDESK_SIGNING_SECRET') }, event => {
      const key = String(event.ticket.id);
      if (event.type === 'ticket.created') return { create: conversationFrom(event.ticket) };
      if (event.type === 'ticket.solved') return { key, event: 'solved' };
      if (event.fromCustomer) return { key, event: 'customerReplied', payload: { comment: event.ticket.latestComment } };
      return null;
    }),
    zendesk.poll(Conversation, H.time.every({ minutes: 15 }), helpdesk, ticket => ({ create: conversationFrom(ticket) })),
  ])
  .store(zendesk.store(Conversation, {
    ...helpdesk,
    status: { Classifying: 'open', Drafting: 'open', AwaitingApproval: 'pending', Sent: 'solved', ClosedByCustomer: 'closed', Escalated: 'open' },
  }))
  .budget({ maxUsdPerUnit: 0.4, onExceed: 'halt' })
  .handler(conversationFlow, {
    outcomes: { rejected: New, sent: Sent },
    progress: { drafting: Drafting, awaitingApproval: AwaitingApproval },
    skips: {
      approval: {
        name: 'proven-safe-category',
        when: g => {
          const record = g.metrics.read(approvedReplies, {
            kind: Conversation,
            where: { category: g.unit.attributes.category },
            window: 'all',
          });
          return record.n >= 200 && record.hits === record.n;
        },
        decision: { approved: true, editedReply: '' },
      },
    },
  })
  .reacts({
    customerReplied: H.reaction(New).from([Drafting, AwaitingApproval]),
    solved: H.reaction(ClosedByCustomer).from([New, Classifying, Drafting, AwaitingApproval]),
    slaBreach: H.reaction(Escalated).from([New, Classifying, Drafting, AwaitingApproval]),
  });

const escalations = H.lane('escalations', Escalation)
  .handler(escalationFlow, { outcomes: { resolved: EscalationResolved } });

const audits = H.lane('audits', Audit)
  .handler(auditFlow, { outcomes: { audited: AuditDone } })
  .reacts({ recovered: H.reaction(AuditCancelled).from([AuditOpen, Auditing]) });

const settledStates: readonly string[] = [Sent.name, ClosedByCustomer.name, Escalated.name];

const escalateOnBreach = H.trigger('escalate-on-sla-breach', H.on.event(conversations, 'slaBreach'))
  .where(e => !settledStates.includes(e.stateBefore))
  .creates(e => escalations.unit({ attributes: { ticketId: e.unit.attributes.ticketId, reason: 'SLA breached' } }));

const tasteFromReviewerEdits = H.trigger('taste-from-reviewer-edits', H.on.step(conversations, 'approval'))
  .where(e => e.status === 'succeeded' && e.output.editedReply.length > 0)
  .records(tasteJournal, e => [{
    rule: `when replying about ${e.unit.attributes.category}, write the way the reviewer rewrote it: ${e.output.editedReply}`,
    because: 'the reviewer edited the drafted reply before approving it',
    when: { roles: [drafter], attributes: { category: e.unit.attributes.category } },
  }]);

const approvalDrop = H.threshold('approval-drop', approvedReplies, {
  kind: Conversation,
  per: 'category',
  window: { days: 7 },
  minSamples: 50,
  trips: { below: 0.9 },
  resets: { above: 0.95 },
});

const openAuditOnDrop = H.trigger('open-audit-on-approval-drop', H.on.crossed(approvalDrop))
  .creates(e => audits.unit({ attributes: { category: e.group.category, trippedAt: e.trippedAt, rateAtOpen: e.rate } }))
  .records(experienceJournal, e => [{
    rule: `when drafting for ${e.group.category}, recall the stricter phrasing`,
    because: `approvals fell to ${e.rate.toFixed(2)} over ${e.n} replies`,
    when: { roles: [drafter], attributes: { category: e.group.category } },
  }]);

const cancelAuditOnRecovery = H.trigger('cancel-audit-on-recovery', H.on.recovered(approvalDrop))
  .sends(e => audits.event(`${e.group.category}@${e.trippedAt}`, 'recovered', { rate: e.rate }));

const modelErrors = H.metric('model-invocation-errors')
  .invocations(['agent'])
  .hit(invocation =>
    invocation.status === 'interrupted' || invocation.status === 'cancelled' ? null : invocation.status !== 'succeeded',
  );

const modelErrorRate = H.threshold('model-error-rate', modelErrors, {
  window: { hours: 1 },
  minSamples: 20,
  trips: { above: 0.2 },
  resets: { below: 0.05 },
});

const pauseConversations = H.trigger('pause-conversations-on-model-errors', H.on.crossed(modelErrorRate))
  .pauses(conversations);
const resumeConversations = H.trigger('resume-conversations-on-recovery', H.on.recovered(modelErrorRate))
  .resumes(conversations);

const breachAt = (candidate: Candidate): number => candidate.timers['slaBreach'] ?? Number.POSITIVE_INFINITY;
const halfHourMs = 30 * 60 * 1000;
const dayMs = 24 * 60 * 60 * 1000;

const supportSchedule = H.policy.schedule('time-to-breach', c => {
  const pausedLastDayMs = c.metrics.pausedMs({ lane: conversations, sinceMs: c.clock.now - dayMs });
  const rampLimit = pausedLastDayMs > halfHourMs ? 2 : Number.POSITIVE_INFINITY;
  let conversationsAdmitted = 0;
  const start = [...c.candidates]
    .sort((a, b) => breachAt(a) - breachAt(b))
    .filter(candidate => {
      if (!candidate.unit.is(conversations)) return true;
      conversationsAdmitted += 1;
      return conversationsAdmitted <= rampLimit;
    });
  return { start };
});

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

export const harness = H.harness('support-self-watch')
  .ledger(sqlite.ledger('.harness/support.db'))
  .lanes([conversations, escalations, audits])
  .triggers([
    escalateOnBreach,
    tasteFromReviewerEdits,
    openAuditOnDrop,
    cancelAuditOnRecovery,
    pauseConversations,
    resumeConversations,
  ])
  .schedule(supportSchedule)
  .projections([markdown.board('BOARD.md'), markdown.telemetry('TELEMETRY.md')]);

export const control = H.control('support-control', harness)
  .clients([claudeCode.supervisor('reviewer-desk', reviewerAccess, { port: H.slot.port(0) })]);

export async function main(): Promise<void> {
  await harness.start();
  await control.serve();
}
