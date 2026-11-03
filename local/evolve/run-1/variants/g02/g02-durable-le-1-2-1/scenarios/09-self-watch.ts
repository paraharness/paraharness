import { z } from 'zod';
import { H } from 'harness-dsl';
import * as sqlite from 'harness-dsl/sqlite';
import * as jsonl from 'harness-dsl/jsonl';
import * as anthropic from 'harness-dsl/anthropic';
import * as claudeCode from 'harness-dsl/claude-code';
import * as zendesk from 'harness-dsl/zendesk';
import type { ZendeskTicket } from 'harness-dsl/zendesk';
import * as markdown from 'harness-dsl/markdown';

const helpdesk = { subdomain: 'acme', token: H.env('ZENDESK_TOKEN') };
const apiAccount = anthropic.account('support-api', { apiKey: H.env('ANTHROPIC_API_KEY') });
const cheap = anthropic.model('claude-haiku-4-5');
const strong = anthropic.model('claude-sonnet-4-5');
const alternate = anthropic.model('claude-opus-4-1');

const New = H.state('New', 'pending');
const Classifying = H.state('Classifying', 'active');
const Drafting = H.state('Drafting', 'active');
const AwaitingApproval = H.state('AwaitingApproval', 'active');
const Sent = H.state('Sent', 'terminal', 'success');
const ClosedByCustomer = H.state('ClosedByCustomer', 'terminal', 'neutral');
const Escalated = H.state('Escalated', 'terminal', 'failure');

const Conversation = H.work('Conversation')
  .attributes({ ticketId: z.number(), category: z.string(), slaDueAt: z.number() })
  .fields({ subject: z.string(), message: z.string(), requester: z.string() })
  .states([New, Classifying, Drafting, AwaitingApproval, Sent, ClosedByCustomer, Escalated])
  .events({ customerReplied: { message: z.string() }, solved: {} })
  .timers(t => ({ slaBreached: t.attribute('slaDueAt') }))
  .key(u => String(u.attributes.ticketId));

const Open = H.state('Open', 'pending');
const Auditing = H.state('Auditing', 'active');
const Concluded = H.state('Concluded', 'terminal', 'success');
const Withdrawn = H.state('Withdrawn', 'terminal', 'neutral');

const Audit = H.work('Audit')
  .attributes({ category: z.string(), trippedAt: z.number(), rate: z.number() })
  .states([Open, Auditing, Concluded, Withdrawn])
  .events({ recovered: { rate: z.number() } })
  .key(u => `${u.attributes.category}@${u.attributes.trippedAt}`);

const specificFirst = H.policy.recall('specific-first', c =>
  [...c.candidates]
    .sort((x, y) => y.specificity - x.specificity || y.track.succeeded - x.track.succeeded)
    .slice(0, c.limit));

const tone = H.journal('support-tone', H.memory.taste('support-tone'))
  .store(jsonl.memory('memory/tone.jsonl'))
  .recall(specificFirst);
const draftingExperience = H.journal('drafting-experience', H.memory.experience('drafting-experience').curated())
  .store(jsonl.memory('memory/drafting-experience.jsonl'))
  .recall(specificFirst);

const classifierRole = H.role('classifier')
  .input({ subject: z.string(), messages: z.array(z.string()) })
  .output({ category: z.string() });
const drafterRole = H.role('drafter')
  .input({ category: z.string(), subject: z.string(), messages: z.array(z.string()) })
  .output({ reply: z.string() });

const drafterModel = H.policy.model('drafter-model', [strong, alternate], c => {
  const pausedMs = c.metrics.pausedMs({ lane: conversations, sinceMs: c.clock.startOfMonth() });
  return pausedMs > 2 * 3600000 ? alternate : strong;
});

const classifier = H.agent('classifier', classifierRole).model(cheap).pool(apiAccount);
const drafter = H.agent('drafter', drafterRole).model(drafterModel).pool(apiAccount).recalls([tone, draftingExperience]);
const reply = zendesk.reply('helpdesk-reply', helpdesk);

const approval = H.decision('reply-approval', { approved: z.boolean(), edited: z.string() });

const handleConversation = H.flow('handle-conversation')
  .requires({ ticketId: z.number(), subject: z.string(), message: z.string() })
  .events({ customerReplied: { message: z.string() } })
  .step('classify', classifier, c => ({
    subject: c.input.subject,
    messages: [c.input.message, ...c.events.customerReplied.map(e => e.payload.message)],
  }))
  .sets({ category: z.string() }, c => ({ category: c.out.classify.category }))
  .mark('drafting')
  .step('draft', drafter, c => ({
    category: c.input.category,
    subject: c.input.subject,
    messages: [c.input.message, ...c.events.customerReplied.map(e => e.payload.message)],
  }))
  .mark('awaitingApproval')
  .halt('approval', approval, { ask: c => `Category ${c.input.category}. Approve this reply?\n\n${c.out.draft.reply}` })
  .exit('rejected', c => c.out.approval.approved === false)
  .step('send', reply, c => ({
    ticketId: c.input.ticketId,
    body: c.out.approval.edited.length > 0 ? c.out.approval.edited : c.out.draft.reply,
  }))
  .ends(['sent'], () => 'sent');

const conversationOf = (ticket: ZendeskTicket) => ({
  attributes: { ticketId: ticket.id, category: 'unclassified', slaDueAt: ticket.slaDueAt ?? ticket.updatedAt + 4 * 3600000 },
  fields: { subject: ticket.subject, message: ticket.latestComment, requester: ticket.requesterEmail },
});

const conversations = H.lane('conversations', Conversation)
  .supply([
    zendesk.webhook(Conversation, { ...helpdesk, port: H.slot.port(1), signingSecret: H.env('ZENDESK_SIGNING_SECRET') }, (event, supply) => {
      if (event.type === 'ticket.created') return supply.create(conversationOf(event.ticket));
      if (event.type === 'ticket.solved') return supply.event(String(event.ticket.id), 'solved', {});
      return event.fromCustomer ? supply.event(String(event.ticket.id), 'customerReplied', { message: event.ticket.latestComment }) : null;
    }),
    zendesk.poll(Conversation, H.time.every({ minutes: 5 }), helpdesk, (ticket, supply) => supply.create(conversationOf(ticket))),
  ])
  .store(zendesk.store(Conversation, {
    ...helpdesk,
    status: { New: 'new', Classifying: 'open', Drafting: 'open', AwaitingApproval: 'pending', Sent: 'solved', ClosedByCustomer: 'closed', Escalated: 'hold' },
  }))
  .budget({ maxUsdPerUnit: 0.4, onExceed: 'halt' })
  .handler(handleConversation, {
    states: { drafting: Drafting, awaitingApproval: AwaitingApproval, rejected: New, sent: Sent },
    opens: Classifying,
  })
  .reacts({
    customerReplied: H.reaction(New).from([Classifying, Drafting, AwaitingApproval]).cancels(),
    solved: H.reaction(ClosedByCustomer).from([New, Classifying, Drafting, AwaitingApproval]).cancels(),
    slaBreached: H.reaction(Escalated).from([New, Classifying, Drafting, AwaitingApproval]).cancels(),
  });

const auditFindings = H.decision('audit-findings', { findings: z.string(), actions: z.array(z.string()) });

const auditCategory = H.flow('audit-category')
  .requires({ category: z.string(), rate: z.number() })
  .halt('findings', auditFindings, { ask: c => `Approvals for ${c.input.category} fell to ${c.input.rate.toFixed(2)}. Record findings.` })
  .ends(['concluded'], () => 'concluded');

const audits = H.lane('audits', Audit)
  .handler(auditCategory, { states: { concluded: Concluded }, opens: Auditing })
  .reacts({ recovered: H.reaction(Withdrawn).from([Open, Auditing]).cancels() });

const approvalRate = H.metric('approval-rate').of(approval).hit(d => d.approved);
const approvalFloor = H.threshold('approval-floor', approvalRate, {
  window: { days: 7 },
  minSamples: 50,
  trips: { below: 0.9 },
  resets: { above: 0.95 },
  kind: Conversation,
  per: 'category',
});

const modelErrors = H.metric('model-error-rate').invocations(['agent']).hit(i => i.status === 'failed' || i.status === 'timedOut');
const errorCeiling = H.threshold('model-error-ceiling', modelErrors, {
  window: { hours: 1 },
  minSamples: 20,
  trips: { above: 0.2 },
  resets: { below: 0.05 },
});

const opensAudit = H.trigger('open-category-audit', H.on.crossed(approvalFloor))
  .creates(e => audits.unit({ attributes: { category: e.group.category, trippedAt: e.trippedAt, rate: e.rate } }))
  .records(draftingExperience, e => [{
    rule: `When drafting for ${e.group.category}, recall the stricter phrasing`,
    because: `approvals fell to ${e.rate.toFixed(2)} over ${e.n} samples`,
    when: { roles: [drafterRole], attributes: { category: e.group.category } },
  }]);

const withdrawsAudit = H.trigger('withdraw-category-audit', H.on.recovered(approvalFloor))
  .sends(e => audits.event(`${e.group.category}@${e.trippedAt}`, 'recovered', { rate: e.rate }));

const pausesConversations = H.trigger('pause-on-model-errors', H.on.crossed(errorCeiling)).pauses(conversations);
const resumesConversations = H.trigger('resume-after-model-errors', H.on.recovered(errorCeiling)).resumes(conversations);

const schedule = H.policy.schedule('audits-then-time-to-breach', c => {
  const monthStart = c.clock.startOfMonth();
  const auditsThisMonth = (category: string) => c.metrics.count({ kind: Audit, where: { category }, sinceMs: monthStart });
  return {
    start: c.order(
      x => (x.is(audits) ? 0 : 1),
      x => (x.is(conversations) ? x.unit.attributes.slaDueAt - c.clock.now : 0),
      x => (x.is(conversations) ? -auditsThisMonth(x.unit.attributes.category) : 0),
      x => x.enqueuedAt,
    ),
  };
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

export const support = H.harness('support')
  .ledger(sqlite.ledger('.harness/ledger.sqlite'))
  .lanes([conversations, audits])
  .triggers([opensAudit, withdrawsAudit, pausesConversations, resumesConversations])
  .schedule(schedule)
  .clients([claudeCode.supervisor('support-supervisor', reviewerAccess, { port: H.slot.port(0) })])
  .projections([markdown.board('BOARD.md'), markdown.telemetry('TELEMETRY.md')]);
