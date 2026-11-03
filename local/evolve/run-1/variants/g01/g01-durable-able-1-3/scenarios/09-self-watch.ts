import { z } from 'zod';
import { H } from 'harness-dsl';
import type { SupplyOf } from 'harness-dsl';
import * as anthropic from 'harness-dsl/anthropic';
import * as claude from 'harness-dsl/claude-code';
import * as zendesk from 'harness-dsl/zendesk';
import * as sqlite from 'harness-dsl/sqlite';
import * as jsonl from 'harness-dsl/jsonl';
import * as markdown from 'harness-dsl/markdown';

const helpdesk = { subdomain: 'acme', token: H.env('ZENDESK_TOKEN') };
const apiAccount = anthropic.account('anthropic-api', { apiKey: H.env('ANTHROPIC_API_KEY') });
const cheap = anthropic.model('claude-haiku-4');
const strong = anthropic.model('claude-sonnet-4');

const ranked = H.policy.recall('specific-then-proven', (c) =>
  [...c.candidates]
    .sort((a, b) => b.specificity - a.specificity || b.track.succeeded - a.track.succeeded)
    .slice(0, c.limit),
);

const supportTaste = H.memory.taste('support-taste');
const draftingExperience = H.memory.experience('drafting-experience').curated();
const tasteJournal = H.journal('support-taste', supportTaste)
  .store(jsonl.memory('memory/taste.jsonl'))
  .recall(ranked);
const experienceJournal = H.journal('drafting-experience', draftingExperience)
  .store(jsonl.memory('memory/experience.jsonl'))
  .recall(ranked);

const New = H.state('New', 'pending');
const Classifying = H.state('Classifying', 'active');
const Drafting = H.state('Drafting', 'active');
const AwaitingApproval = H.state('AwaitingApproval', 'active');
const Sent = H.state('Sent', 'terminal', 'success');
const ClosedByCustomer = H.state('ClosedByCustomer', 'terminal', 'neutral');
const Escalated = H.state('Escalated', 'terminal', 'failure');

const Conversation = H.work('Conversation')
  .attributes({ ticketId: z.number(), category: z.string(), slaDueAt: z.number() })
  .fields({ message: z.string(), requesterEmail: z.string() })
  .states([New, Classifying, Drafting, AwaitingApproval, Sent, ClosedByCustomer, Escalated])
  .signals({ customerReplied: { message: z.string() }, closed: {} })
  .timers((t) => ({ sla: t.attribute('slaDueAt') }))
  .key((unit) => String(unit.attributes.ticketId));

const classifierRole = H.role('classifier')
  .intents(['read'])
  .instructions('Assign the conversation one category from the support taxonomy.')
  .input({ message: z.string() })
  .output({ category: z.string() });

const drafterRole = H.role('drafter')
  .intents(['read', 'remember'])
  .instructions('Draft the reply to the customer in the house tone.')
  .input({ category: z.string(), message: z.string() })
  .output({ body: z.string() });

const classifier = H.agent('classifier', classifierRole).model(cheap).pool(apiAccount);
const drafter = H.agent('drafter', drafterRole)
  .model(strong)
  .pool(apiAccount)
  .recalls([tasteJournal, experienceJournal]);

const sendReply = zendesk.reply('send-reply', helpdesk);

const safeToSend = H.policy.gate('safe-category', (c) => {
  if (c.unit === null) return false;
  const category = String(c.unit.attributes.category);
  const approvals = c.metrics.read(approval, { lane: conversations, where: { category } });
  const auditsThisMonth =
    c.metrics.created({ lane: audits, sinceMs: c.clock.startOfMonth() }, 'category')[category] ?? 0;
  const pausedToday = c.metrics.pausedMs({ lane: conversations, sinceMs: c.clock.startOfDay() });
  return approvals.n >= 200 && approvals.hits === approvals.n && auditsThisMonth === 0 && pausedToday < 3_600_000;
});

const conversationFlow = H.flow('conversation')
  .requires({ ticketId: z.number(), message: z.string() })
  .mark('classifying')
  .step('classify', classifier, (c) => ({ message: c.input.message }))
  .sets({ category: z.string() }, (c) => ({ category: c.out.classify.category }))
  .mark('drafting')
  .step('draft', drafter, (c) => ({ category: c.input.category, message: c.input.message }))
  .mark('awaitingApproval')
  .halt('approval', {
    ask: (c) => `Reply to ticket ${c.input.ticketId} (${c.input.category}):\n\n${c.out.draft.body}`,
    decision: { verdict: z.enum(['approve', 'edit', 'reject']), body: z.string() },
    skip: { when: safeToSend, decision: { verdict: 'approve', body: '' } },
  })
  .exit('rejected', (c) => c.out.approval.verdict === 'reject')
  .step('send', sendReply, (c) => ({
    ticketId: c.input.ticketId,
    body: c.out.approval.verdict === 'edit' ? c.out.approval.body : c.out.draft.body,
  }))
  .ends(['sent'], () => 'sent');

const approval = H.metric('approval')
  .step(conversationFlow, 'approval')
  .hit((decision) => decision.verdict === 'approve');

const openConversation = (ticket: zendesk.ZendeskTicket): SupplyOf<typeof Conversation> => ({
  create: {
    attributes: { ticketId: ticket.id, category: '', slaDueAt: ticket.slaDueAt ?? ticket.updatedAt + 86_400_000 },
    fields: { message: ticket.latestComment, requesterEmail: ticket.requesterEmail },
  },
});

const conversations = H.lane('conversations', Conversation)
  .supply([
    zendesk.webhook(Conversation, { ...helpdesk, port: H.slot.port(1), signingSecret: H.env('ZENDESK_SIGNING') }, (event) => {
      if (event.type === 'ticket.created') return openConversation(event.ticket);
      if (event.type === 'ticket.solved') return { key: String(event.ticket.id), signal: 'closed', payload: {} };
      if (event.fromCustomer) {
        return { key: String(event.ticket.id), signal: 'customerReplied', payload: { message: event.ticket.latestComment } };
      }
      return null;
    }),
    zendesk.poll(Conversation, H.time.every({ minutes: 15 }), helpdesk, (ticket) => openConversation(ticket)),
  ])
  .store(zendesk.store(Conversation, {
    ...helpdesk,
    status: { New: 'new', Classifying: 'open', Drafting: 'open', AwaitingApproval: 'pending', Sent: 'solved', Escalated: 'hold' },
  }))
  .handler(conversationFlow, {
    states: {
      classifying: Classifying,
      drafting: Drafting,
      awaitingApproval: AwaitingApproval,
      rejected: New,
      sent: Sent,
      failed: Escalated,
    },
  })
  .budget({ maxUsdPerUnit: 0.4, onExceed: 'halt' });

const Open = H.state('Open', 'pending');
const Handling = H.state('Handling', 'active');
const Resolved = H.state('Resolved', 'terminal', 'success');
const Unresolved = H.state('Unresolved', 'terminal', 'failure');

const Escalation = H.work('Escalation')
  .attributes({ ticketId: z.number(), reason: z.string() })
  .states([Open, Handling, Resolved, Unresolved])
  .key((unit) => String(unit.attributes.ticketId));

const escalationFlow = H.flow('escalation')
  .requires({ ticketId: z.number(), reason: z.string() })
  .mark('handling')
  .halt('handle', {
    ask: (c) => `Ticket ${c.input.ticketId} escalated: ${c.input.reason}. Take it over.`,
    decision: { resolution: z.string() },
  })
  .ends(['resolved'], () => 'resolved');

const escalations = H.lane('escalations', Escalation)
  .supply([H.supply.operator()])
  .handler(escalationFlow, { states: { handling: Handling, resolved: Resolved, failed: Unresolved } });

const AuditOpen = H.state('AuditOpen', 'pending');
const Auditing = H.state('Auditing', 'active');
const AuditClosed = H.state('AuditClosed', 'terminal', 'success');
const AuditWithdrawn = H.state('AuditWithdrawn', 'terminal', 'neutral');
const AuditAbandoned = H.state('AuditAbandoned', 'terminal', 'failure');

const Audit = H.work('Audit')
  .attributes({ category: z.string(), rate: z.number(), samples: z.number() })
  .states([AuditOpen, Auditing, AuditClosed, AuditWithdrawn, AuditAbandoned])
  .key((unit) => unit.attributes.category);

const auditFlow = H.flow('audit')
  .requires({ category: z.string(), rate: z.number(), samples: z.number() })
  .mark('auditing')
  .halt('review', {
    ask: (c) => `Approvals for ${c.input.category} fell to ${c.input.rate} over ${c.input.samples} samples. Audit the drafts.`,
    decision: { findings: z.string() },
  })
  .ends(['closed'], () => 'closed');

const audits = H.lane('audits', Audit)
  .handler(auditFlow, { states: { auditing: Auditing, closed: AuditClosed, failed: AuditAbandoned } });

const slaBreached = H.trigger('sla-breached', H.on.signal(conversations, 'sla'))
  .creates(escalations, (e) => ({ attributes: { ticketId: e.unit.attributes.ticketId, reason: 'SLA breached' } }))
  .moves(conversations, { key: (e) => e.unit.key, to: Escalated });

const customerReplied = H.trigger('customer-replied', H.on.signal(conversations, 'customerReplied'))
  .moves(conversations, {
    key: (e) => e.unit.key,
    to: New,
    from: [AwaitingApproval],
    update: (e) => ({ fields: { message: e.payload.message } }),
  });

const customerClosed = H.trigger('customer-closed', H.on.signal(conversations, 'closed'))
  .moves(conversations, { key: (e) => e.unit.key, to: ClosedByCustomer });

const approvalByCategory = H.on.threshold({
  groups: (c) => c.metrics.values({ lane: conversations, window: { days: 7 } }, 'category'),
  read: (c, group) =>
    c.metrics.read(approval, { lane: conversations, window: { days: 7 }, where: { category: group ?? '' } }),
  enters: (r) => r.n >= 50 && r.rate !== null && r.rate < 0.9,
  leaves: (r) => r.rate !== null && r.rate > 0.95,
});

const approvalFell = H.trigger('approval-fell', approvalByCategory)
  .where((e) => e.crossing === 'entered')
  .creates(audits, (e) => ({
    attributes: { category: e.group ?? '', rate: e.reading.rate ?? 0, samples: e.reading.n },
  }))
  .records(experienceJournal, (e) => [
    {
      rule: `When drafting for ${e.group ?? ''}, recall the stricter phrasing`,
      because: `approvals fell to ${e.reading.rate ?? 0} over ${e.reading.n} samples`,
      when: { roles: [drafterRole], attributes: { category: e.group ?? '' } },
    },
  ]);

const approvalRecovered = H.trigger('approval-recovered', approvalByCategory)
  .where((e) => e.crossing === 'left')
  .moves(audits, { key: (e) => e.group ?? '', to: AuditWithdrawn });

const modelErrors = H.on.threshold({
  read: (c) => c.metrics.invocationFailures({ lane: conversations, window: { hours: 1 } }),
  enters: (r) => r.n >= 20 && r.rate !== null && r.rate > 0.2,
  leaves: (r) => r.rate !== null && r.rate < 0.05,
});

const pauseOnErrors = H.trigger('pause-on-model-errors', modelErrors)
  .where((e) => e.crossing === 'entered')
  .pauses(conversations);
const resumeOnRecovery = H.trigger('resume-on-model-recovery', modelErrors)
  .where((e) => e.crossing === 'left')
  .resumes(conversations);

const supportSchedule = H.policy.schedule('time-to-breach', (c) => {
  const urgency = (x: (typeof c.candidates)[number]) =>
    x.is(escalations) || x.is(audits) ? Number.NEGATIVE_INFINITY : (x.timers['sla'] ?? Number.POSITIVE_INFINITY) - c.clock.now;
  return { start: [...c.candidates].sort((a, b) => urgency(a) - urgency(b)) };
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

export const supportHarness = H.harness('support')
  .ledger(sqlite.ledger('support-ledger.sqlite'))
  .lanes([conversations, escalations, audits])
  .triggers([
    slaBreached,
    customerReplied,
    customerClosed,
    approvalFell,
    approvalRecovered,
    pauseOnErrors,
    resumeOnRecovery,
  ])
  .schedule(supportSchedule)
  .clients([claude.supervisor('support-supervisor', reviewerAccess, { port: H.slot.port(0) })])
  .projections([markdown.board('BOARD.md'), markdown.telemetry('TELEMETRY.md')]);
