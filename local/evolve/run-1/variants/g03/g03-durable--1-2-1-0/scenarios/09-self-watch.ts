import { z } from 'zod';
import { H } from 'harness-dsl';
import * as anthropic from 'harness-dsl/anthropic';
import * as zendesk from 'harness-dsl/zendesk';
import type { ZendeskTicket } from 'harness-dsl/zendesk';
import * as sqlite from 'harness-dsl/sqlite';
import * as jsonl from 'harness-dsl/jsonl';
import * as claudeCode from 'harness-dsl/claude-code';
import * as markdown from 'harness-dsl/markdown';

const stalled = H.state('stalled', 'waiting');

const fresh = H.state('new', 'pending');
const classifying = H.state('classifying', 'active');
const drafting = H.state('drafting', 'active');
const awaitingApproval = H.state('awaitingApproval', 'active');
const sent = H.state('sent', 'terminal', 'success');
const escalated = H.state('escalated', 'terminal', 'failure');

const Conversation = H.work('conversation')
  .attributes({ ticketId: z.number(), category: z.string(), slaDueAt: z.number() })
  .fields({ subject: z.string(), latestComment: z.string(), requesterEmail: z.string() })
  .states([fresh, classifying, drafting, awaitingApproval, sent, escalated, stalled])
  .events({ customerReplied: { message: z.string() } })
  .timers((t) => ({ sla: t.attribute('slaDueAt') }))
  .key((u) => String(u.attributes.ticketId));

const open = H.state('open', 'pending');
const handling = H.state('handling', 'active');
const handled = H.state('handled', 'terminal', 'success');

const Escalation = H.work('escalation')
  .attributes({ ticketId: z.number(), reason: z.string() })
  .states([open, handling, handled, stalled])
  .key((u) => String(u.attributes.ticketId));

const investigating = H.state('investigating', 'active');
const closed = H.state('closed', 'terminal', 'success');
const withdrawn = H.state('withdrawn', 'terminal', 'neutral');

const Audit = H.work('audit')
  .attributes({ category: z.string(), trippedAt: z.number(), rate: z.number() })
  .states([open, investigating, closed, withdrawn, stalled])
  .events({ recovered: { rate: z.number() } })
  .key((u) => `${u.attributes.category}@${u.attributes.trippedAt}`);

const apiAccount = anthropic.account('api', { apiKey: H.env('ANTHROPIC_API_KEY') });
const haiku = anthropic.model('claude-haiku-4-5');
const sonnet = anthropic.model('claude-sonnet-4-5');

const specificThenProven = H.policy.recall('specific-then-proven', (c) =>
  [...c.candidates]
    .sort(
      (a, b) =>
        b.specificity - a.specificity ||
        b.track.succeeded / Math.max(1, b.track.present) - a.track.succeeded / Math.max(1, a.track.present),
    )
    .slice(0, c.limit),
);
const tone = H.playbook('tone', H.memory.taste('tone'))
  .store(jsonl.memory('memory/tone.jsonl'))
  .recall(specificThenProven);
const supportLessons = H.playbook('support-lessons', H.memory.experience('support-experience').curated())
  .store(jsonl.memory('memory/support-lessons.jsonl'))
  .recall(specificThenProven);

const drafterRole = H.role('drafter')
  .intents(['read'])
  .instructions('Draft a reply to the customer in house tone.')
  .input({ subject: z.string(), message: z.string(), category: z.string() })
  .output({ reply: z.string() });

const classifier = H.agent(
  'classifier',
  H.role('classifier')
    .intents(['read'])
    .instructions('Name the category of the conversation.')
    .input({ subject: z.string(), message: z.string() })
    .output({ category: z.string() }),
)
  .model(haiku)
  .pool(apiAccount);
const drafter = H.agent('drafter', drafterRole).model(sonnet).pool(apiAccount).recalls([tone, supportLessons]);

const replyApproval = H.decision('reply-approval', {
  approved: z.boolean(),
  body: z.string().nullable(),
  note: z.string().nullable(),
});

const helpdesk = { subdomain: 'acme', token: H.env('ZENDESK_TOKEN') };
const sendReply = zendesk.reply('send-reply', helpdesk);

const converse = H.flow('converse')
  .requires({ ticketId: z.number(), subject: z.string(), latestComment: z.string() })
  .step('classify', classifier, (c) => ({ subject: c.input.subject, message: c.input.latestComment }))
  .sets({ category: z.string() }, (c) => ({ category: c.out.classify.category }))
  .step('draft', drafter, (c) => ({ subject: c.input.subject, message: c.input.latestComment, category: c.input.category }))
  .halt('approval', replyApproval, { ask: (c) => c.out.draft.reply })
  .exit('rejected', (c) => !c.out.approval.approved)
  .step('send', sendReply, (c) => ({ ticketId: c.input.ticketId, body: c.out.approval.body ?? c.out.draft.reply }), {
    restart: 'ask',
  })
  .ends(['sent'], () => 'sent');

const approved = H.metric('reply-approved').of(replyApproval).hit((d) => d.approved);

const fromTicket = (ticket: ZendeskTicket) => ({
  attributes: {
    ticketId: ticket.id,
    category: 'unclassified',
    slaDueAt: ticket.slaDueAt ?? ticket.updatedAt + 14_400_000,
  },
  fields: { subject: ticket.subject, latestComment: ticket.latestComment, requesterEmail: ticket.requesterEmail },
});

const conversations = H.lane('conversations', Conversation)
  .supply([
    zendesk.webhook(
      Conversation,
      { ...helpdesk, port: H.slot.port(1), signingSecret: H.env('ZENDESK_SIGNING_SECRET') },
      (event, supply) =>
        event.type === 'ticket.created'
          ? supply.create(fromTicket(event.ticket))
          : event.type === 'comment.added' && event.fromCustomer
            ? supply.event(String(event.ticket.id), 'customerReplied', { message: event.ticket.latestComment })
            : null,
    ),
    zendesk.poll(Conversation, H.time.every({ minutes: 15 }), helpdesk, (ticket, supply) =>
      supply.create(fromTicket(ticket)),
    ),
  ])
  .store(
    zendesk.store(Conversation, {
      ...helpdesk,
      status: { new: 'new', classifying: 'open', drafting: 'open', awaitingApproval: 'pending', sent: 'solved', escalated: 'open' },
    }),
  )
  .wip(10)
  .budget({ maxUsdPerUnit: 0.4, onExceed: 'halt' })
  .retry(H.retry.exponential({ maxRetries: 2, initialDelayMs: 30_000 }))
  .reacts({
    customerReplied: H.reaction(fresh).from([awaitingApproval]).cancels(),
    sla: H.reaction(escalated).from([fresh, classifying, drafting, awaitingApproval, stalled]).cancels(),
  })
  .handler(converse, {
    opens: classifying,
    during: { draft: drafting, approval: awaitingApproval },
    ends: { sent, rejected: { to: fresh, upTo: 2, then: escalated } },
    exhausted: stalled,
    skips: {
      approval: {
        name: 'proven-safe-category',
        when: (g) => {
          const r = g.metrics.read(approved, {
            kind: Conversation,
            where: { category: g.unit.attributes.category },
            window: 'all',
          });
          return r.n >= 200 && r.hits === r.n;
        },
        decision: { approved: true, body: null, note: null },
      },
    },
  });

const handlingDecision = H.decision('escalation-handled', { resolution: z.string() });
const escalationFlow = H.flow('handle-escalation')
  .requires({ ticketId: z.number(), reason: z.string() })
  .halt('resolution', handlingDecision, { ask: (c) => `Ticket ${c.input.ticketId} escalated: ${c.input.reason}` })
  .ends(['handled'], () => 'handled');

const escalations = H.lane('escalations', Escalation)
  .supply([H.supply.operator()])
  .store(sqlite.store(Escalation, 'data/units.sqlite'))
  .handler(escalationFlow, { opens: handling, ends: { handled }, exhausted: stalled });

const auditFindings = H.decision('audit-findings', { summary: z.string(), actions: z.array(z.string()) });
const auditFlow = H.flow('audit-category')
  .requires({ category: z.string(), rate: z.number() })
  .halt('findings', auditFindings, {
    ask: (c) => `Approval rate for ${c.input.category} fell to ${c.input.rate.toFixed(2)}. What changed?`,
  })
  .ends(['closed'], () => 'closed');

const audits = H.lane('audits', Audit)
  .store(sqlite.store(Audit, 'data/units.sqlite'))
  .reacts({ recovered: H.reaction(withdrawn).from([open, investigating, stalled]).cancels() })
  .handler(auditFlow, { opens: investigating, ends: { closed }, exhausted: stalled });

const approvalByCategory = H.threshold('approval-by-category', approved, {
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

const openAudit = H.trigger('approval-fell', H.on.crossed(approvalByCategory))
  .creates((e) => audits.unit({ attributes: { category: e.group.category, trippedAt: e.trippedAt, rate: e.rate } }))
  .records(supportLessons, (e) => [
    {
      rule: `when drafting for ${e.group.category}, recall the stricter phrasing`,
      because: `approvals fell to ${e.rate.toFixed(2)} over ${e.n} replies`,
      when: { roles: [drafterRole], attributes: { category: e.group.category } },
    },
  ]);

const withdrawAudit = H.trigger('approval-recovered', H.on.recovered(approvalByCategory)).sends((e) =>
  audits.event(`${e.group.category}@${e.trippedAt}`, 'recovered', { rate: e.rate }),
);

const pauseConversations = H.trigger('pause-on-model-errors', H.on.crossed(modelErrorRate)).pauses(conversations);
const resumeConversations = H.trigger('resume-after-model-errors', H.on.recovered(modelErrorRate)).resumes(conversations);

const escalate = H.trigger('escalated-conversation', H.on.transition(conversations, { to: [escalated] })).creates((e) =>
  escalations.unit({
    attributes: {
      ticketId: e.unit.attributes.ticketId,
      reason: e.cause.by === 'event' ? 'SLA breached' : 'reply rejected twice',
    },
  }),
);

const editsBecomeTaste = H.trigger('reviewer-edits-become-taste', H.on.step(conversations, 'approval')).records(
  tone,
  (e) =>
    e.output.note === null
      ? []
      : [{ rule: e.output.note, because: 'the reviewer edited a drafted reply this way', when: { roles: [drafterRole] } }],
);

const schedule = H.policy.schedule('breach-first', (c) => {
  const monthStart = c.clock.startOfMonth();
  const pausedLong = c.metrics.pausedMs({ lane: conversations, sinceMs: monthStart }) > 3_600_000;
  const auditsThisMonth = (category: string) =>
    c.metrics.count({ kind: Audit, where: { category }, sinceMs: monthStart });
  return {
    start: c.order(
      (x) => (x.is(escalations) ? 0 : x.is(conversations) ? (pausedLong ? 2 : 1) : pausedLong ? 1 : 2),
      (x) => (x.is(audits) ? -auditsThisMonth(x.unit.attributes.category) : 0),
      (x) => (x.timers['sla'] ?? Number.MAX_SAFE_INTEGER) - c.clock.now,
      (x) => x.enqueuedAt,
    ),
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

export const supportSelfWatch = H.harness('support')
  .ledger(sqlite.ledger('data/ledger.sqlite'))
  .lanes([conversations, escalations, audits])
  .triggers([openAudit, withdrawAudit, pauseConversations, resumeConversations, escalate, editsBecomeTaste])
  .schedule(schedule)
  .clients([claudeCode.supervisor('reviewer', reviewerAccess, { port: H.slot.port(0) })])
  .projections([markdown.board('board.md'), markdown.telemetry('telemetry.md')]);
