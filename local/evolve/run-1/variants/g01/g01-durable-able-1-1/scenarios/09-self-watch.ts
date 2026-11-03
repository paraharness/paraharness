import { z } from 'zod';
import { H } from 'harness-dsl';
import type { Metric } from 'harness-dsl';
import * as sqlite from 'harness-dsl/sqlite';
import * as jsonl from 'harness-dsl/jsonl';
import * as anthropic from 'harness-dsl/anthropic';
import * as claudeCode from 'harness-dsl/claude-code';
import * as zendesk from 'harness-dsl/zendesk';
import * as markdown from 'harness-dsl/markdown';

const helpdesk = { subdomain: 'acme', token: H.env('ZENDESK_TOKEN') };
const fourHoursMs = 4 * 3600000;

const api = anthropic.account('support-api', { apiKey: H.env('ANTHROPIC_API_KEY') });
const haiku = anthropic.model('claude-haiku-4-5');
const sonnet = anthropic.model('claude-sonnet-4-5');

const New = H.state.pending('New');
const Classifying = H.state.active('Classifying');
const Drafting = H.state.active('Drafting');
const AwaitingApproval = H.state.active('AwaitingApproval');
const Sent = H.state.terminal('Sent', 'success');
const ClosedByCustomer = H.state.terminal('ClosedByCustomer', 'neutral');
const Escalated = H.state.terminal('Escalated', 'failure');

const Conversation = H.work('Conversation')
  .attributes({ ticketId: z.number(), category: z.string(), slaDueAt: z.number() })
  .fields({ subject: z.string(), message: z.string() })
  .states([New, Classifying, Drafting, AwaitingApproval, Sent, ClosedByCustomer, Escalated])
  .events({ customerReplied: { message: z.string() }, closedByCustomer: {} })
  .timers(t => ({ breach: t.attribute('slaDueAt') }))
  .key(conversation => String(conversation.attributes.ticketId));

const specificFirst = H.policy.recall('specific-first', c =>
  [...c.candidates]
    .filter(candidate => candidate.item.status === 'accepted')
    .sort((a, b) => b.specificity - a.specificity || b.track.succeeded - a.track.succeeded)
    .slice(0, c.limit),
);

const supportTaste = H.memory.taste('support-tone').curated();
const draftingLessons = H.memory.experience('drafting-lessons').curated();
const toneJournal = H.journal('support-tone-journal', supportTaste).store(jsonl.memory('memory/tone.jsonl')).recall(specificFirst);
const lessonsJournal = H.journal('drafting-lessons-journal', draftingLessons).store(jsonl.memory('memory/drafting.jsonl')).recall(specificFirst);

const classifierRole = H.role('classifier')
  .intents(['read'])
  .instructions('Assign the conversation one category from the helpdesk taxonomy.')
  .input({ subject: z.string(), message: z.string() })
  .output({ category: z.string() });

const drafterRole = H.role('drafter')
  .intents(['read'])
  .instructions('Draft the reply in the house tone. Apply every reviewer note.')
  .input({ category: z.string(), message: z.string(), notes: z.string() })
  .output({ reply: z.string() });

const classifier = H.agent('classifier', classifierRole).model(haiku).pool(api);
const drafter = H.agent('drafter', drafterRole).model(sonnet).pool(api).recalls([toneJournal, lessonsJournal]);
const sendReply = zendesk.reply('send-reply', helpdesk);

function approvals(): Metric {
  return approvalRate;
}

const safeCategory = H.policy.gate('safe-category', c => {
  if (c.unit === null) return false;
  const record = c.metrics.read(approvals(), { kind: Conversation, window: { days: 90 }, where: { category: c.unit.attributes['category'] } });
  return record.n >= 200 && record.hits === record.n;
});

const triage = H.flow('triage')
  .requires({ ticketId: z.number(), category: z.string(), subject: z.string(), message: z.string() })
  .mark('classifying')
  .step('classify', classifier, c => ({ subject: c.input.subject, message: c.input.message }), { onRestart: 'reconcile' })
  .sets({ category: z.string() }, c => ({ category: c.out.classify.category }))
  .loop(
    'rework',
    { carry: { notes: z.string() }, rounds: () => 3 },
    round =>
      round
        .mark('drafting')
        .step('draft', drafter, c => ({
          category: c.input.category,
          message: c.input.message,
          notes: c.carry === null ? '' : c.carry.notes,
        }), { onRestart: 'reconcile' })
        .mark('awaiting')
        .halt('approval', {
          ask: c => `Send this reply to ticket ${c.input.ticketId}?\n\n${c.out.draft.reply}`,
          decision: { approved: z.boolean(), notes: z.string() },
          skip: { when: safeCategory, decision: { approved: true, notes: '' } },
        }),
    last => (last.approval.approved ? null : { notes: last.approval.notes }),
  )
  .exit('escalate', c => !c.out.rework.last.approval.approved)
  .step('send', sendReply, c => ({ ticketId: c.input.ticketId, body: c.out.rework.last.draft.reply }), { onRestart: 'reconcile' })
  .ends(['sent'], () => 'sent');

const conversations = H.lane('conversations', Conversation)
  .supply([
    zendesk.webhook(Conversation, { ...helpdesk, port: H.slot.port(0), signingSecret: H.env('ZENDESK_SIGNING_SECRET') }, event => {
      const ticket = event.ticket;
      if (event.type === 'ticket.created') {
        return {
          create: {
            attributes: { ticketId: ticket.id, category: 'unclassified', slaDueAt: ticket.slaDueAt ?? ticket.updatedAt + fourHoursMs },
            fields: { subject: ticket.subject, message: ticket.latestComment },
          },
        };
      }
      if (event.type === 'ticket.solved') return { key: String(ticket.id), event: 'closedByCustomer', payload: {} };
      if (event.fromCustomer) return { key: String(ticket.id), event: 'customerReplied', payload: { message: ticket.latestComment } };
      return null;
    }),
    zendesk.poll(Conversation, H.time.every({ minutes: 15 }), helpdesk, ticket => ({
      create: {
        attributes: { ticketId: ticket.id, category: 'unclassified', slaDueAt: ticket.slaDueAt ?? ticket.updatedAt + fourHoursMs },
        fields: { subject: ticket.subject, message: ticket.latestComment },
      },
    })),
  ])
  .store(zendesk.store(Conversation, {
    ...helpdesk,
    status: { New: 'new', Classifying: 'open', Drafting: 'open', AwaitingApproval: 'pending', Sent: 'solved', ClosedByCustomer: 'closed', Escalated: 'hold' },
  }))
  .budget({ maxUsdPerUnit: 0.4, onExceed: 'halt' })
  .handler(triage, {
    states: {
      classifying: Classifying,
      drafting: Drafting,
      awaiting: AwaitingApproval,
      escalate: Escalated,
      sent: Sent,
      failed: Escalated,
    },
  })
  .reacts({
    customerReplied: r => r.to(New).from([Drafting, AwaitingApproval]).updates(reply => ({ message: reply.message })),
    closedByCustomer: r => r.to(ClosedByCustomer).from([New, Classifying, Drafting, AwaitingApproval]),
    breach: r => r.to(Escalated).from([New, Classifying, Drafting, AwaitingApproval]),
  });

const approvalRate = H.metric('approval-rate').step(triage, 'approval').hit(decision => decision.approved);

const modelErrorRate = H.metric('model-error-rate')
  .invocations(conversations)
  .hit(invocation => {
    if (invocation.model === null) return null;
    if (invocation.status === 'running' || invocation.status === 'interrupted' || invocation.status === 'cancelled') return null;
    return invocation.status === 'failed' || invocation.status === 'timedOut';
  });

const AuditOpen = H.state.pending('AuditOpen');
const AuditReviewing = H.state.active('AuditReviewing');
const AuditStuck = H.state.waiting('AuditStuck');
const AuditClosed = H.state.terminal('AuditClosed', 'success');
const AuditWithdrawn = H.state.terminal('AuditWithdrawn', 'neutral');

const Audit = H.work('Audit')
  .attributes({ category: z.string(), openedRate: z.number(), openedSamples: z.number() })
  .states([AuditOpen, AuditReviewing, AuditStuck, AuditClosed, AuditWithdrawn])
  .events({ recovered: { rate: z.number() } })
  .key(audit => audit.attributes.category);

const auditFlow = H.flow('category-audit')
  .requires({ category: z.string(), openedRate: z.number(), openedSamples: z.number() })
  .mark('reviewing')
  .halt('findings', {
    ask: c => `Approvals for ${c.input.category} fell to ${c.input.openedRate} over ${c.input.openedSamples} samples. What is wrong?`,
    decision: { findings: z.string() },
  })
  .ends(['closed'], () => 'closed');

const audits = H.lane('audits', Audit)
  .handler(auditFlow, { states: { reviewing: AuditReviewing, closed: AuditClosed, failed: AuditStuck } })
  .reacts({ recovered: r => r.to(AuditWithdrawn).from([AuditOpen, AuditReviewing, AuditStuck]) });

const approvalCrossing = H.on.crossing(approvalRate, {
  lane: conversations,
  window: { days: 7 },
  minSamples: 50,
  per: 'category',
  enter: { below: 0.9 },
  exit: { above: 0.95 },
});

const openCategoryAudit = H.trigger('open-category-audit', approvalCrossing)
  .where(crossing => crossing.direction === 'enter')
  .creates(audits, crossing => ({
    attributes: { category: crossing.group.category ?? 'unclassified', openedRate: crossing.rate, openedSamples: crossing.n },
  }))
  .records(lessonsJournal, crossing => {
    const category = crossing.group.category ?? 'unclassified';
    return [{
      rule: `when drafting for ${category}, recall the stricter phrasing`,
      because: `approvals fell to ${crossing.rate.toFixed(2)} over ${crossing.n} samples`,
      when: { roles: [drafterRole], attributes: { category } },
    }];
  });

const withdrawRecoveredAudit = H.trigger('withdraw-recovered-audit', approvalCrossing)
  .where(crossing => crossing.direction === 'exit')
  .delivers(audits, 'recovered', crossing => ({ key: crossing.group.category ?? 'unclassified', payload: { rate: crossing.rate } }));

const errorCrossing = H.on.crossing(modelErrorRate, {
  lane: conversations,
  window: { hours: 1 },
  minSamples: 20,
  enter: { above: 0.2 },
  exit: { below: 0.05 },
});

const pauseOnModelErrors = H.trigger('pause-on-model-errors', errorCrossing)
  .where(crossing => crossing.direction === 'enter')
  .pauses(conversations);

const resumeOnRecovery = H.trigger('resume-on-recovery', errorCrossing)
  .where(crossing => crossing.direction === 'exit')
  .resumes(conversations);

const reviewerEditsBecomeTaste = H.trigger('reviewer-edits-become-taste', H.on.step(conversations, 'approval'))
  .where(step => step.status === 'succeeded' && step.output.notes.trim().length > 0)
  .records(toneJournal, step => [{
    rule: step.output.notes.trim(),
    because: `the reviewer edited a ${step.unit.attributes.category} reply`,
    when: { roles: [drafterRole] },
  }]);

const slaFirst = H.policy.schedule('sla-first', c => {
  const monthStart = c.clock.startOfMonth();
  const auditsThisMonth = (category: string) => c.metrics.created({ lane: audits, sinceMs: monthStart, where: { category } });
  const unstable = c.metrics.pausedMs({ lane: conversations, sinceMs: monthStart }) > 2 * 3600000;
  const auditCandidates = c.candidates
    .flatMap(candidate => (candidate.is(audits) ? [candidate] : []))
    .sort((a, b) => auditsThisMonth(b.unit.attributes.category) - auditsThisMonth(a.unit.attributes.category));
  const deadline = (timers: Readonly<Record<string, number>>) => ('breach' in timers ? timers['breach'] : Number.MAX_SAFE_INTEGER);
  const conversationCandidates = c.candidates
    .filter(candidate => candidate.is(conversations))
    .sort((a, b) => deadline(a.timers) - deadline(b.timers));
  return { start: unstable ? [...auditCandidates, ...conversationCandidates] : [...conversationCandidates, ...auditCandidates] };
});

const reviewerDesk = H.access('reviewer-desk').allows([
  H.ops.readWork,
  H.ops.updateWork,
  H.ops.deliverEvents,
  H.ops.resolveBlocks,
  H.ops.recoverAttempts,
  H.ops.readMemory,
  H.ops.writeMemory,
  H.ops.curateMemory,
  H.ops.readTelemetry,
]);

export const selfWatchingSupport = H.harness('support-self-watch')
  .ledger(sqlite.ledger('.harness/support.sqlite'))
  .lanes([conversations, audits])
  .triggers([openCategoryAudit, withdrawRecoveredAudit, pauseOnModelErrors, resumeOnRecovery, reviewerEditsBecomeTaste])
  .schedule(slaFirst)
  .clients([claudeCode.supervisor('reviewer', reviewerDesk, { port: H.slot.port(1) })])
  .projections([markdown.board('.harness/board.md'), markdown.telemetry('.harness/telemetry.md')]);
