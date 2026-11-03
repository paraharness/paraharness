import { z } from 'zod';
import { H } from 'harness-dsl';
import * as sqlite from 'harness-dsl/sqlite';
import * as jsonl from 'harness-dsl/jsonl';
import * as anthropic from 'harness-dsl/anthropic';
import * as claudeCode from 'harness-dsl/claude-code';
import * as zendesk from 'harness-dsl/zendesk';
import * as markdown from 'harness-dsl/markdown';

const Dropped = H.state('dropped', 'terminal', 'failure');
const New = H.state('new', 'pending');
const Classifying = H.state('classifying', 'active');
const Drafting = H.state('drafting', 'active');
const AwaitingApproval = H.state('awaitingApproval', 'waiting');
const Sent = H.state('sent', 'terminal', 'success');
const ClosedByCustomer = H.state('closedByCustomer', 'terminal', 'neutral');
const Escalated = H.state('escalated', 'terminal', 'neutral');

const Conversation = H.work('Conversation')
  .attributes({ ticketId: z.number(), subject: z.string(), category: z.string(), slaDueAt: z.number() })
  .fields({ body: z.string() })
  .states([New, Classifying, Drafting, AwaitingApproval, Sent, ClosedByCustomer, Escalated, Dropped])
  .events({ customerReplied: { text: z.string() }, customerClosed: {} })
  .timers(t => ({ slaBreach: t.attribute('slaDueAt') }))
  .key(unit => String(unit.attributes.ticketId));

const bySpecificity = H.policy.recall('bySpecificity', c =>
  [...c.candidates].sort((a, b) => b.specificity - a.specificity || b.track.succeeded - a.track.succeeded).slice(0, c.limit),
);
const toneTaste = H.journal('tone', H.memory.taste('tone')).store(jsonl.memory('memory/tone.jsonl')).recall(bySpecificity);
const draftingExperience = H.journal('draftingExperience', H.memory.experience('draftingExperience').curated())
  .store(jsonl.memory('memory/drafting.jsonl'))
  .recall(bySpecificity);

const approval = H.decision('replyApproval', { approved: z.boolean(), reply: z.string(), notes: z.string() });
const approvalRate = H.metric('approvalRate').of(approval).hit(decision => decision.approved);
const modelErrors = H.metric('modelErrors')
  .invocations(['agent'])
  .hit(invocation => invocation.status === 'failed' || invocation.status === 'timedOut');

const account = anthropic.account('support', { apiKey: H.env('ANTHROPIC_API_KEY') });
const haiku = anthropic.model('claude-haiku-4-5');
const sonnet = anthropic.model('claude-sonnet-4-5');
const opus = anthropic.model('claude-opus-4-1');

const drafterModel = H.policy.model('drafterModel', [sonnet, opus], c => {
  const sonnetApproval = c.metrics.read(approvalRate, { kind: Conversation, model: sonnet, window: { days: 14 } });
  return sonnetApproval.n >= 100 && (sonnetApproval.rate ?? 1) < 0.85 ? opus : sonnet;
});

const classifierRole = H.role('classifier')
  .intents(['read'])
  .instructions('Classify the conversation into one support category.')
  .input({ subject: z.string(), body: z.string() })
  .output({ category: z.string() });
const drafterRole = H.role('drafter')
  .intents(['read'])
  .instructions('Draft the next reply to the customer in house tone.')
  .input({ category: z.string(), body: z.string(), replies: z.array(z.string()) })
  .output({ reply: z.string() });

const classifier = H.agent('classifier', classifierRole).model(haiku).pool(account);
const drafter = H.agent('drafter', drafterRole).model(drafterModel).pool(account).recalls([toneTaste, draftingExperience]);

const connection = { subdomain: 'acme', token: H.env('ZENDESK_TOKEN') };
const sendReply = zendesk.reply('sendReply', connection);

const conversationFlow = H.flow('triageConversation')
  .requires({ ticketId: z.number(), subject: z.string(), body: z.string() })
  .events({ customerReplied: { text: z.string() } })
  .step('classify', classifier, c => ({ subject: c.input.subject, body: c.input.body }))
  .sets({ category: z.string() }, c => ({ category: c.out.classify.category }))
  .step('draft', drafter, c => ({
    category: c.input.category,
    body: c.input.body,
    replies: c.events.customerReplied.map(reply => reply.payload.text),
  }))
  .halt('approval', approval, { ask: c => `Reply to #${c.input.ticketId} (${c.input.category}):\n${c.out.draft.reply}` })
  .exit('rejected', c => !c.out.approval.approved)
  .step('send', sendReply, c => ({
    ticketId: c.input.ticketId,
    body: c.out.approval.reply === '' ? c.out.draft.reply : c.out.approval.reply,
  }))
  .ends(['sent'], () => 'sent');

const conversations = H.lane('conversations', Conversation)
  .supply([
    zendesk.webhook(Conversation, { ...connection, port: H.slot.port(1), signingSecret: H.env('ZENDESK_SIGNING_SECRET') }, (event, supply) =>
      event.type === 'ticket.created'
        ? supply.create({
            attributes: {
              ticketId: event.ticket.id,
              subject: event.ticket.subject,
              category: 'unclassified',
              slaDueAt: event.ticket.slaDueAt ?? event.ticket.updatedAt + 14_400_000,
            },
            fields: { body: event.ticket.latestComment },
          })
        : event.type === 'ticket.solved'
          ? supply.event(String(event.ticket.id), 'customerClosed', {})
          : event.fromCustomer
            ? supply.event(String(event.ticket.id), 'customerReplied', { text: event.ticket.latestComment })
            : null,
    ),
    zendesk.poll(Conversation, H.time.every({ minutes: 5 }), connection, (ticket, supply) =>
      supply.create({
        attributes: {
          ticketId: ticket.id,
          subject: ticket.subject,
          category: 'unclassified',
          slaDueAt: ticket.slaDueAt ?? ticket.updatedAt + 14_400_000,
        },
        fields: { body: ticket.latestComment },
      }),
    ),
  ])
  .store(zendesk.store(Conversation, { ...connection, status: { new: 'new', sent: 'pending', closedByCustomer: 'solved', escalated: 'open' } }))
  .handler(conversationFlow, {
    opens: Classifying,
    progress: { draft: Drafting },
    halts: { approval: AwaitingApproval },
    ends: { sent: Sent, rejected: { to: New, times: 2, thereafter: Escalated } },
    skips: {
      approval: {
        name: 'provenSafeCategory',
        when: gate => {
          const record = gate.metrics.read(approvalRate, {
            kind: Conversation,
            where: { category: gate.unit.attributes.category },
            window: 'all',
          });
          return record.n >= 200 && record.hits === record.n;
        },
        decision: { approved: true, reply: '', notes: '' },
      },
    },
  })
  .budget({ maxUsdPerUnit: 0.4, onExceed: 'halt' })
  .retry(H.retry.exponential({ maxRetries: 3, initialDelayMs: 30_000 }), { exhausted: Dropped });

const Raised = H.state('raised', 'pending');
const Handling = H.state('handling', 'active');
const AwaitingAgent = H.state('awaitingAgent', 'waiting');
const Handled = H.state('handled', 'terminal', 'success');

const Escalation = H.work('Escalation')
  .attributes({ ticketId: z.number(), reason: z.string() })
  .states([Raised, Handling, AwaitingAgent, Handled, Dropped])
  .key(unit => `${unit.attributes.ticketId}:${unit.attributes.reason}`);
const escalationResolution = H.decision('escalationResolution', { resolution: z.string() });
const escalationFlow = H.flow('handleEscalation')
  .requires({ ticketId: z.number(), reason: z.string() })
  .halt('handle', escalationResolution, { ask: c => `Ticket #${c.input.ticketId} escalated: ${c.input.reason}` })
  .ends(['handled'], () => 'handled');
const escalations = H.lane('escalations', Escalation)
  .handler(escalationFlow, { opens: Handling, halts: { handle: AwaitingAgent }, ends: { handled: Handled } })
  .retry(H.retry.fixed({ maxRetries: 3, delayMs: 60_000 }), { exhausted: Dropped });

const AuditOpen = H.state('auditOpen', 'pending');
const Auditing = H.state('auditing', 'active');
const AwaitingAuditor = H.state('awaitingAuditor', 'waiting');
const AuditResolved = H.state('auditResolved', 'terminal', 'success');
const AuditWithdrawn = H.state('auditWithdrawn', 'terminal', 'neutral');

const Audit = H.work('Audit')
  .attributes({ category: z.string(), trippedAt: z.number(), rate: z.number(), samples: z.number() })
  .states([AuditOpen, Auditing, AwaitingAuditor, AuditResolved, AuditWithdrawn, Dropped])
  .events({ recovered: { rate: z.number() } })
  .key(unit => `${unit.attributes.category}:${unit.attributes.trippedAt}`);
const auditFinding = H.decision('auditFinding', { finding: z.string() });
const auditFlow = H.flow('auditCategory')
  .requires({ category: z.string(), rate: z.number(), samples: z.number() })
  .halt('review', auditFinding, {
    ask: c => `Approval rate for ${c.input.category} fell to ${c.input.rate} over ${c.input.samples} samples. Audit it.`,
  })
  .ends(['resolved'], () => 'resolved');
const audits = H.lane('audits', Audit)
  .handler(auditFlow, { opens: Auditing, halts: { review: AwaitingAuditor }, ends: { resolved: AuditResolved } })
  .retry(H.retry.fixed({ maxRetries: 3, delayMs: 60_000 }), { exhausted: Dropped });

const approvalSlump = H.threshold('approvalSlump', approvalRate, {
  kind: Conversation,
  per: 'category',
  window: { days: 7 },
  minSamples: 50,
  trips: { below: 0.9 },
  resets: { above: 0.95 },
});
const modelErrorSpike = H.threshold('modelErrorSpike', modelErrors, {
  window: { hours: 1 },
  minSamples: 20,
  trips: { above: 0.2 },
  resets: { below: 0.05 },
});

const customerReplied = H.trigger('customerReplied', H.on.event(conversations, 'customerReplied'))
  .moves(New, { from: [Classifying, Drafting, AwaitingApproval], cancels: true });
const customerClosed = H.trigger('customerClosed', H.on.event(conversations, 'customerClosed'))
  .moves(ClosedByCustomer, { from: [New, Classifying, Drafting, AwaitingApproval], cancels: true });
const slaBreached = H.trigger('slaBreached', H.on.event(conversations, 'slaBreach'))
  .moves(Escalated, { from: [New, Classifying, Drafting, AwaitingApproval], cancels: true })
  .creates(event => escalations.unit({ attributes: { ticketId: event.unit.attributes.ticketId, reason: 'slaBreach' } }));
const reviewerEditsBecomeTaste = H.trigger('reviewerEditsBecomeTaste', H.on.step(conversations, 'approval'))
  .where(event => event.status === 'succeeded' && event.output.notes !== '')
  .records(toneTaste, event => [
    { rule: event.output.notes, because: 'the reviewer edited a draft this way', when: { roles: [drafterRole] } },
  ]);

const openAudit = H.trigger('openAudit', H.on.crossed(approvalSlump))
  .creates(event =>
    audits.unit({ attributes: { category: event.group.category, trippedAt: event.trippedAt, rate: event.rate, samples: event.n } }),
  )
  .records(draftingExperience, event => [
    {
      rule: `when drafting for ${event.group.category}, recall the stricter phrasing`,
      because: `approvals fell to ${event.rate} over ${event.n} samples`,
      when: { roles: [drafterRole], attributes: { category: event.group.category } },
    },
  ]);
const closeAudit = H.trigger('closeAudit', H.on.recovered(approvalSlump)).sends(event =>
  audits.event(`${event.group.category}:${event.trippedAt}`, 'recovered', { rate: event.rate }),
);
const withdrawAudit = H.trigger('withdrawAudit', H.on.event(audits, 'recovered'))
  .moves(AuditWithdrawn, { from: [AuditOpen, Auditing, AwaitingAuditor], cancels: true });

const pauseConversations = H.trigger('pauseConversations', H.on.crossed(modelErrorSpike)).pauses(conversations);
const resumeConversations = H.trigger('resumeConversations', H.on.recovered(modelErrorSpike)).resumes(conversations);

const timeToBreach = H.policy.schedule('timeToBreach', c => {
  const monthStart = c.clock.startOfMonth();
  const pausedThisMonthMs = c.metrics.pausedMs({ lane: conversations, sinceMs: monthStart });
  const auditsOpened = (category: string) => c.metrics.count({ lane: audits, where: { category }, sinceMs: monthStart });
  return {
    start: c.order(
      candidate => (candidate.is(escalations) ? (pausedThisMonthMs > 3_600_000 ? 0 : 1) : candidate.is(conversations) ? 1 : 2),
      candidate => (candidate.is(conversations) ? candidate.unit.attributes.slaDueAt - c.clock.now : Number.MAX_SAFE_INTEGER),
      candidate => (candidate.is(audits) ? -auditsOpened(candidate.unit.attributes.category) : 0),
      candidate => candidate.enqueuedAt,
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

const harness = H.harness('supportSelfWatch')
  .ledger(sqlite.ledger('.harness/ledger.sqlite'))
  .lanes([conversations, escalations, audits])
  .triggers([
    customerReplied,
    customerClosed,
    slaBreached,
    reviewerEditsBecomeTaste,
    openAudit,
    closeAudit,
    withdrawAudit,
    pauseConversations,
    resumeConversations,
  ])
  .schedule(timeToBreach)
  .clients([claudeCode.supervisor('reviewer', reviewerAccess, { port: H.slot.port(0) })])
  .projections([markdown.board('BOARD.md'), markdown.telemetry('TELEMETRY.md')]);

void harness.start();
