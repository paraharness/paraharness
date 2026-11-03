import { z } from 'zod';
import { H } from 'harness-dsl';
import * as sqlite from 'harness-dsl/sqlite';
import * as jsonl from 'harness-dsl/jsonl';
import * as anthropic from 'harness-dsl/anthropic';
import * as claudeCode from 'harness-dsl/claude-code';
import * as zendesk from 'harness-dsl/zendesk';
import * as markdown from 'harness-dsl/markdown';

const account = anthropic.account('support-api', { apiKey: H.env('ANTHROPIC_API_KEY') });
const haiku = anthropic.model('claude-haiku-4-5');
const sonnet = anthropic.model('claude-sonnet-4-5');

const Open = H.state('Open', 'pending');
const Handling = H.state('Handling', 'active');
const Sent = H.state('Sent', 'waiting');
const Closed = H.state('Closed', 'terminal', 'success');
const HandedToHuman = H.state('HandedToHuman', 'terminal', 'neutral');
const Escalated = H.state('Escalated', 'terminal', 'failure');

const Conversation = H.work('Conversation')
  .attributes({ ticketId: z.number(), category: z.string(), slaDueAt: z.number() })
  .fields({ subject: z.string(), message: z.string(), requester: z.string() })
  .states([Open, Handling, Sent, Closed, HandedToHuman, Escalated])
  .events({ customerReplied: { message: z.string() }, solved: { at: z.number() } })
  .timers(t => ({ slaBreach: t.attribute('slaDueAt') }))
  .key(u => String(u.attributes.ticketId));

const AuditOpen = H.state('AuditOpen', 'pending');
const Auditing = H.state('Auditing', 'active');
const Audited = H.state('Audited', 'terminal', 'success');
const AuditWithdrawn = H.state('AuditWithdrawn', 'terminal', 'neutral');

const Audit = H.work('Audit')
  .attributes({ category: z.string(), openedRate: z.number(), samples: z.number() })
  .states([AuditOpen, Auditing, Audited, AuditWithdrawn])
  .events({ recovered: { rate: z.number(), samples: z.number() } })
  .key(u => u.attributes.category);

const EscalationQueued = H.state('EscalationQueued', 'pending');
const EscalationOwned = H.state('EscalationOwned', 'active');
const EscalationResolved = H.state('EscalationResolved', 'terminal', 'success');
const EscalationDropped = H.state('EscalationDropped', 'terminal', 'neutral');

const Escalation = H.work('Escalation')
  .attributes({ ticketId: z.number(), category: z.string(), breachedAt: z.number() })
  .states([EscalationQueued, EscalationOwned, EscalationResolved, EscalationDropped])
  .key(u => String(u.attributes.ticketId));

const specificFirst = H.policy.recall('specificFirst', c =>
  [...c.candidates]
    .sort((a, b) => b.specificity - a.specificity || b.track.succeeded - a.track.succeeded)
    .slice(0, c.limit));

const replyTaste = H.journal('replyTaste', H.memory.taste('replyTone').curated())
  .store(jsonl.memory('memory/reply-taste.jsonl'))
  .recall(specificFirst);
const draftingExperience = H.journal('draftingExperience', H.memory.experience('draftingLessons').curated())
  .store(jsonl.memory('memory/drafting-experience.jsonl'))
  .recall(specificFirst);

const classifierRole = H.role('classifier')
  .intents(['read'])
  .instructions('Classify the conversation into one support category.')
  .input({ subject: z.string(), message: z.string() })
  .output({ category: z.string() });

const drafter = H.role('drafter')
  .intents(['read'])
  .instructions('Draft the next reply to the customer in the house tone.')
  .input({ subject: z.string(), message: z.string(), category: z.string(), followUps: z.array(z.string()) })
  .output({ reply: z.string() });

const classifierAgent = H.agent('classifier', classifierRole).model(haiku).pool(account);
const drafterAgent = H.agent('drafter', drafter)
  .model(sonnet)
  .pool(account)
  .recalls([replyTaste, draftingExperience]);

const replyApproval = H.decision('replyApproval', {
  approved: z.boolean(),
  editedReply: z.string().nullable(),
  note: z.string(),
});

const approvalRate = H.metric('approvalRate').of(replyApproval).hit(d => d.approved);
const modelErrorRate = H.metric('modelErrorRate')
  .invocations(['agent'])
  .hit(i => i.status === 'failed' || i.status === 'timedOut');

const helpdesk = { subdomain: 'acme', token: H.env('ZENDESK_TOKEN') };
const sendReply = zendesk.reply('sendReply', helpdesk);
const defaultSlaMs = 4 * 60 * 60 * 1000;

const fromTicket = (ticket: zendesk.ZendeskTicket) => ({
  create: {
    attributes: {
      ticketId: ticket.id,
      category: 'unclassified',
      slaDueAt: ticket.slaDueAt ?? ticket.updatedAt + defaultSlaMs,
    },
    fields: { subject: ticket.subject, message: ticket.latestComment, requester: ticket.requesterEmail },
  },
});

const conversationFlow = H.flow('conversation')
  .requires({ ticketId: z.number(), subject: z.string(), message: z.string() })
  .events({ customerReplied: { message: z.string() } })
  .step('classify', classifierAgent, c => ({ subject: c.input.subject, message: c.input.message }))
  .sets({ category: z.string() }, c => ({ category: c.out.classify.category }))
  .step('draft', drafterAgent, c => ({
    subject: c.input.subject,
    message: c.input.message,
    category: c.input.category,
    followUps: c.events.customerReplied.map(reply => reply.payload.message),
  }))
  .halt('approval', replyApproval, {
    ask: c => `Reply to #${c.input.ticketId} (${c.input.category}):\n\n${c.out.draft.reply}`,
  })
  .exit('handedToHuman', c => !c.out.approval.approved)
  .step('send', sendReply, c => ({
    ticketId: c.input.ticketId,
    body: c.out.approval.editedReply ?? c.out.draft.reply,
  }))
  .ends(['sent'], () => 'sent');

const conversations = H.lane('conversations', Conversation)
  .supply([
    zendesk.webhook(Conversation, { ...helpdesk, port: H.slot.port(1), signingSecret: H.env('ZENDESK_SIGNING_SECRET') }, event => {
      if (event.type === 'ticket.created') return fromTicket(event.ticket);
      if (event.type === 'ticket.solved') {
        return { key: String(event.ticket.id), event: 'solved', payload: { at: event.ticket.updatedAt } };
      }
      if (event.fromCustomer) {
        return { key: String(event.ticket.id), event: 'customerReplied', payload: { message: event.ticket.latestComment } };
      }
      return null;
    }),
    zendesk.poll(Conversation, H.time.every({ minutes: 15 }), helpdesk, ticket => fromTicket(ticket)),
  ])
  .store(zendesk.store(Conversation, {
    ...helpdesk,
    status: { Open: 'open', Handling: 'open', Sent: 'pending', Closed: 'solved', HandedToHuman: 'open', Escalated: 'open' },
  }))
  .wip(8)
  .budget({ maxUsdPerUnit: 0.4, onExceed: 'halt' })
  .reacts({
    customerReplied: H.reaction(Open).from([Handling, Sent]),
    solved: H.reaction(Closed).from([Open, Handling, Sent]),
  })
  .handler(conversationFlow, {
    states: { sent: Sent, handedToHuman: HandedToHuman, failed: Escalated },
    skips: {
      approval: {
        name: 'safeCategory',
        when: c => {
          const category = c.unit.attributes.category;
          const record = c.metrics.read(approvalRate, { kind: Conversation, where: { category }, window: { days: 365 } });
          const auditsThisMonth = c.metrics.count({ kind: Audit, where: { category }, sinceMs: c.clock.startOfMonth() });
          return record.n >= 200 && record.hits === record.n && auditsThisMonth === 0;
        },
        decision: { approved: true, editedReply: null, note: 'safe category' },
      },
    },
  });

const auditFindings = H.decision('auditFindings', { findings: z.string() });

const auditFlow = H.flow('categoryAudit')
  .requires({ category: z.string(), openedRate: z.number(), samples: z.number() })
  .halt('findings', auditFindings, {
    ask: c => `Approvals for ${c.input.category} fell to ${c.input.openedRate.toFixed(2)} over ${c.input.samples} replies. What changed?`,
  })
  .ends(['audited'], () => 'audited');

const audits = H.lane('audits', Audit)
  .reacts({ recovered: H.reaction(AuditWithdrawn).from([AuditOpen, Auditing]) })
  .handler(auditFlow, { states: { audited: Audited, failed: AuditOpen } });

const escalationOutcome = H.decision('escalationOutcome', { resolved: z.boolean(), resolution: z.string() });

const escalationFlow = H.flow('escalation')
  .requires({ ticketId: z.number(), category: z.string() })
  .halt('outcome', escalationOutcome, {
    ask: c => `Ticket #${c.input.ticketId} (${c.input.category}) breached its SLA. Take it over.`,
  })
  .ends(['resolved', 'dropped'], c => (c.out.outcome.resolved ? 'resolved' : 'dropped'));

const escalations = H.lane('escalations', Escalation)
  .supply([H.supply.operator()])
  .handler(escalationFlow, {
    states: { resolved: EscalationResolved, dropped: EscalationDropped, failed: EscalationQueued },
  });

const approvalSlump = H.threshold('approvalSlump', approvalRate, {
  kind: Conversation,
  per: 'category',
  window: { days: 7 },
  minSamples: 50,
  trips: { below: 0.9 },
  resets: { above: 0.95 },
});

const modelErrorSpike = H.threshold('modelErrorSpike', modelErrorRate, {
  window: { hours: 1 },
  minSamples: 20,
  trips: { above: 0.2 },
  resets: { below: 0.05 },
});

const openAuditOnSlump = H.trigger('openAuditOnSlump', H.on.crossed(approvalSlump))
  .creates(e => audits.unit({ attributes: { category: e.group.category, openedRate: e.rate, samples: e.n } }))
  .records(draftingExperience, e => [{
    rule: `when drafting for ${e.group.category}, recall the stricter phrasing`,
    because: `approvals fell to ${e.rate.toFixed(2)} over ${e.n} replies`,
    when: { roles: [drafter], attributes: { category: e.group.category } },
  }]);

const withdrawAuditOnRecovery = H.trigger('withdrawAuditOnRecovery', H.on.recovered(approvalSlump))
  .sends(e => audits.event(e.group.category, 'recovered', { rate: e.rate, samples: e.n }));

const pauseOnModelErrors = H.trigger('pauseOnModelErrors', H.on.crossed(modelErrorSpike)).pauses(conversations);
const resumeOnModelRecovery = H.trigger('resumeOnModelRecovery', H.on.recovered(modelErrorSpike)).resumes(conversations);

const escalateOnBreach = H.trigger('escalateOnBreach', H.on.event(conversations, 'slaBreach'))
  .where(e => e.stateBefore === Open.name || e.stateBefore === Handling.name)
  .creates(e => escalations.unit({
    attributes: { ticketId: e.unit.attributes.ticketId, category: e.unit.attributes.category, breachedAt: e.payload.firedAt },
  }));

const tasteFromReviewerEdits = H.trigger('tasteFromReviewerEdits', H.on.step(conversations, 'approval'))
  .where(e => e.status === 'succeeded' && e.output.editedReply !== null && e.output.note.trim() !== '')
  .records(replyTaste, e => [{
    rule: e.output.note,
    because: `the reviewer edited the reply to ticket #${e.unit.attributes.ticketId}`,
    when: { roles: [drafter], attributes: { category: e.unit.attributes.category } },
  }]);

const timeToBreach = H.policy.schedule('timeToBreach', c => {
  const monthStart = c.clock.startOfMonth();
  const pausedLong = c.metrics.pausedMs({ lane: conversations, sinceMs: monthStart }) > 2 * 60 * 60 * 1000;
  const tier = (x: (typeof c.candidates)[number]) =>
    x.is(escalations) ? 0 : x.is(audits) ? (pausedLong ? 1 : 3) : 2;
  const within = (x: (typeof c.candidates)[number]) =>
    x.is(audits)
      ? -c.metrics.count({ kind: Audit, where: { category: x.unit.attributes.category }, sinceMs: monthStart })
      : x.is(conversations)
        ? (x.timers['slaBreach'] ?? Number.MAX_SAFE_INTEGER) - c.clock.now
        : -x.waitedMs;
  return { start: [...c.candidates].sort((a, b) => tier(a) - tier(b) || within(a) - within(b)) };
});

const reviewerDesk = H.access('reviewerDesk').allows([
  H.ops.readWork,
  H.ops.updateWork,
  H.ops.sendEvents,
  H.ops.resolveBlocks,
  H.ops.readMemory,
  H.ops.curateMemory,
  H.ops.readTelemetry,
]);

export const supportSelfWatch = H.harness('support-self-watch')
  .ledger(sqlite.ledger('.harness/support.sqlite'))
  .lanes([conversations, audits, escalations])
  .triggers([
    openAuditOnSlump,
    withdrawAuditOnRecovery,
    pauseOnModelErrors,
    resumeOnModelRecovery,
    escalateOnBreach,
    tasteFromReviewerEdits,
  ])
  .schedule(timeToBreach)
  .clients([claudeCode.supervisor('reviewer', reviewerDesk, { port: H.slot.port(0) })])
  .projections([markdown.board('BOARD.md'), markdown.telemetry('TELEMETRY.md')]);
