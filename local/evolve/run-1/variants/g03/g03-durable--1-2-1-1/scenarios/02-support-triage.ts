import { z } from 'zod';
import { H } from 'harness-dsl';
import * as sqlite from 'harness-dsl/sqlite';
import * as jsonl from 'harness-dsl/jsonl';
import * as claudeCode from 'harness-dsl/claude-code';
import * as anthropic from 'harness-dsl/anthropic';
import * as zendesk from 'harness-dsl/zendesk';
import * as markdown from 'harness-dsl/markdown';
import * as local from 'harness-dsl/local';

const New = H.state('New', 'pending');
const Classifying = H.state('Classifying', 'active');
const Drafting = H.state('Drafting', 'active');
const AwaitingApproval = H.state('AwaitingApproval', 'waiting');
const Sending = H.state('Sending', 'active');
const HeldForReview = H.state('HeldForReview', 'waiting');
const Sent = H.state('Sent', 'terminal', 'success');
const ClosedByCustomer = H.state('ClosedByCustomer', 'terminal', 'neutral');
const Escalated = H.state('Escalated', 'terminal', 'failure');

const Open = H.state('Open', 'pending');
const AwaitingHuman = H.state('AwaitingHuman', 'waiting');
const Resolved = H.state('Resolved', 'terminal', 'success');

const Conversation = H.work('Conversation')
  .attributes({
    ticketId: z.number(),
    subject: z.string(),
    category: z.string(),
    slaDueAt: z.number(),
  })
  .fields({ latestComment: z.string(), requesterEmail: z.string() })
  .states([New, Classifying, Drafting, AwaitingApproval, Sending, HeldForReview, Sent, ClosedByCustomer, Escalated])
  .events({ customerReplied: { comment: z.string() }, solved: {} })
  .timers(t => ({ slaBreach: t.attribute('slaDueAt') }))
  .key(u => String(u.attributes.ticketId));

const Escalation = H.work('Escalation')
  .attributes({ ticketId: z.number(), reason: z.string(), openedAt: z.number() })
  .states([Open, AwaitingHuman, Resolved])
  .key(u => `${u.attributes.ticketId}@${u.attributes.openedAt}`);

const apiAccount = anthropic.account('support-api', { apiKey: H.env('ANTHROPIC_API_KEY') });
const haiku = anthropic.model('claude-haiku-4-5');
const sonnet = anthropic.model('claude-sonnet-4-5');
const opus = anthropic.model('claude-opus-4-1');

const replyApproval = H.decision('reply-approval', {
  verdict: z.enum(['approve', 'reject']),
  editedBody: z.string().nullable(),
  notes: z.string(),
});

const escalationResolution = H.decision('escalation-resolution', { resolution: z.string() });

const approvals = H.metric('reply-approved').of(replyApproval).hit(d => d.verdict === 'approve');

const trackRate = (x: { track: { present: number; succeeded: number } }) =>
  x.track.present === 0 ? 0 : x.track.succeeded / x.track.present;

const specificThenProven = H.policy.recall('specific-then-proven', c =>
  [...c.candidates]
    .sort((a, b) => b.specificity - a.specificity || trackRate(b) - trackRate(a))
    .slice(0, c.limit),
);

const tone = H.journal('tone', H.memory.taste('tone').curated())
  .store(jsonl.memory('memory/tone.jsonl'))
  .recall(specificThenProven);

const supportLessons = H.journal('support-lessons', H.memory.experience('support-lesson'))
  .store(jsonl.memory('memory/support-lessons.jsonl'))
  .recall(specificThenProven);

const drafterModel = H.policy.model('drafter-model', [opus, sonnet], c => {
  const strong = c.metrics.read(approvals, { model: opus, window: { days: 30 } });
  const cheaper = c.metrics.read(approvals, { model: sonnet, window: { days: 30 } });
  if (strong.n < 50 || cheaper.n < 50) return strong.n <= cheaper.n ? opus : sonnet;
  return (cheaper.rate ?? 0) >= (strong.rate ?? 0) ? sonnet : opus;
});

const classifierRole = H.role('classifier')
  .intents(['read'])
  .instructions('Classify the customer conversation into one support category.')
  .input({ subject: z.string(), comment: z.string() })
  .output({ category: z.string(), confidence: z.number() });

const drafterRole = H.role('drafter')
  .intents(['read'])
  .instructions('Draft the next reply to the customer.')
  .input({ subject: z.string(), comment: z.string(), category: z.string(), history: z.array(z.string()) })
  .output({ body: z.string() });

const classifier = H.agent('classifier', classifierRole).model(haiku).pool(apiAccount);

const drafter = H.agent('drafter', drafterRole)
  .model(drafterModel)
  .pool(apiAccount)
  .recalls([tone, supportLessons]);

const connection = { subdomain: 'acme', token: H.env('ZENDESK_TOKEN') };
const reply = zendesk.reply('zendesk-reply', connection);

const conversationFlow = H.flow('conversation')
  .requires({ ticketId: z.number(), subject: z.string(), latestComment: z.string() })
  .events({ customerReplied: { comment: z.string() } })
  .step('classify', classifier, c => {
    const replies = c.events.customerReplied.map(r => r.payload.comment);
    return {
      subject: c.input.subject,
      comment: replies.length > 0 ? replies[replies.length - 1] : c.input.latestComment,
    };
  })
  .sets({ category: z.string() }, c => ({ category: c.out.classify.category }))
  .step('draft', drafter, c => {
    const replies = c.events.customerReplied.map(r => r.payload.comment);
    return {
      subject: c.input.subject,
      comment: replies.length > 0 ? replies[replies.length - 1] : c.input.latestComment,
      category: c.input.category,
      history: replies,
    };
  })
  .halt('approval', replyApproval, {
    ask: c => `Approve the reply to ticket ${c.input.ticketId}:\n\n${c.out.draft.body}`,
  })
  .exit('rejected', c => c.out.approval.verdict === 'reject')
  .step('send', reply, c => ({
    ticketId: c.input.ticketId,
    body: c.out.approval.editedBody ?? c.out.draft.body,
  }))
  .ends(['sent'], () => 'sent');

const escalationFlow = H.flow('escalation')
  .requires({ ticketId: z.number(), reason: z.string() })
  .halt('resolve', escalationResolution, {
    ask: c => `Ticket ${c.input.ticketId} escalated (${c.input.reason}). How was it resolved?`,
  })
  .ends(['resolved'], () => 'resolved');

const fallbackSlaMs = 4 * 60 * 60 * 1000;

const conversations = H.lane('conversations', Conversation)
  .supply([
    zendesk.webhook(
      Conversation,
      { ...connection, port: H.slot.port(0), signingSecret: H.env('ZENDESK_SIGNING_SECRET') },
      (ev, supply) => {
        const key = String(ev.ticket.id);
        if (ev.type === 'ticket.solved') return supply.event(key, 'solved', {});
        if (ev.type === 'comment.added') {
          return ev.fromCustomer ? supply.event(key, 'customerReplied', { comment: ev.ticket.latestComment }) : null;
        }
        return supply.create({
          attributes: {
            ticketId: ev.ticket.id,
            subject: ev.ticket.subject,
            category: 'unclassified',
            slaDueAt: ev.ticket.slaDueAt ?? ev.ticket.updatedAt + fallbackSlaMs,
          },
          fields: { latestComment: ev.ticket.latestComment, requesterEmail: ev.ticket.requesterEmail },
        });
      },
    ),
    zendesk.poll(Conversation, H.time.every({ minutes: 10 }), connection, (ticket, supply) =>
      supply.create({
        attributes: {
          ticketId: ticket.id,
          subject: ticket.subject,
          category: 'unclassified',
          slaDueAt: ticket.slaDueAt ?? ticket.updatedAt + fallbackSlaMs,
        },
        fields: { latestComment: ticket.latestComment, requesterEmail: ticket.requesterEmail },
      }),
    ),
  ])
  .store(
    zendesk.store(Conversation, {
      ...connection,
      status: {
        New: 'new',
        Classifying: 'open',
        Drafting: 'open',
        AwaitingApproval: 'open',
        Sending: 'open',
        HeldForReview: 'open',
        Sent: 'pending',
        ClosedByCustomer: 'solved',
        Escalated: 'hold',
      },
    }),
  )
  .runner(local.shell({ slots: 10 }))
  .wip(10)
  .budget({ maxUsdPerUnit: 0.4, onExceed: 'halt' })
  .handler(conversationFlow, {
    states: {
      classify: Classifying,
      draft: Drafting,
      approval: AwaitingApproval,
      send: Sending,
      rejected: H.loopback(New, { max: 3, then: Escalated }),
      sent: Sent,
    },
    opens: Classifying,
    blocked: HeldForReview,
    skips: {
      approval: {
        name: 'safe-category',
        when: g => {
          const r = g.metrics.read(approvals, { where: { category: g.unit.attributes.category }, window: 'all' });
          return r.n >= 200 && r.hits === r.n;
        },
        decision: { verdict: 'approve', editedBody: null, notes: '' },
      },
    },
  })
  .reacts({
    customerReplied: H.reaction(New)
      .from([Classifying, Drafting, AwaitingApproval, Sending, HeldForReview, Sent])
      .cancels(),
    solved: H.reaction(ClosedByCustomer)
      .from([New, Classifying, Drafting, AwaitingApproval, Sending, HeldForReview, Sent])
      .cancels(),
    slaBreach: H.reaction(Escalated)
      .from([New, Classifying, Drafting, AwaitingApproval, HeldForReview])
      .cancels(),
  });

const escalations = H.lane('escalations', Escalation)
  .handler(escalationFlow, {
    states: { resolve: AwaitingHuman, resolved: Resolved },
  });

const escalatedOpensEscalation = H.trigger(
  'escalated-opens-escalation',
  H.on.transition(conversations, { to: [Escalated] }),
).creates(e =>
  escalations.unit({
    attributes: {
      ticketId: e.unit.attributes.ticketId,
      reason: e.cause.by === 'timer' ? 'sla breached' : `escalated by ${e.cause.by}`,
      openedAt: e.unit.updatedAt,
    },
  }),
);

const reviewerNotesBecomeTaste = H.trigger(
  'reviewer-notes-become-taste',
  H.on.step(conversations, 'approval'),
)
  .where(e => e.status === 'succeeded' && e.output.notes.length > 0)
  .records(tone, e => [
    {
      rule: e.output.notes,
      because: `the reviewer edited the reply to ticket ${e.unit.attributes.ticketId}`,
      when: { roles: [drafterRole], attributes: { category: e.unit.attributes.category } },
    },
  ]);

const timeToBreach = H.policy.schedule('time-to-breach', c => ({
  start: c.order(
    x => (x.is(escalations) ? 0 : 1),
    x => (x.is(conversations) ? x.unit.attributes.slaDueAt : x.enqueuedAt),
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
  .ledger(sqlite.ledger('.harness/support.db'))
  .lanes([conversations, escalations])
  .triggers([escalatedOpensEscalation, reviewerNotesBecomeTaste])
  .schedule(timeToBreach)
  .clients([claudeCode.supervisor('reviewer', reviewerAccess, { port: H.slot.port(1) })])
  .projections([markdown.board('BOARD.md'), markdown.telemetry('TELEMETRY.md')]);
