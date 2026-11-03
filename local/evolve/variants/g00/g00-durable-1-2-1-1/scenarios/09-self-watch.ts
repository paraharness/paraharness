import { z } from 'zod';
import { H } from 'harness-dsl';
import * as sqlite from 'harness-dsl/sqlite';
import * as jsonl from 'harness-dsl/jsonl';
import * as anthropic from 'harness-dsl/anthropic';
import * as claudeCode from 'harness-dsl/claude-code';
import * as zendesk from 'harness-dsl/zendesk';
import * as local from 'harness-dsl/local';
import * as markdown from 'harness-dsl/markdown';

const fourHoursMs = 4 * 60 * 60 * 1000;

const New = H.state('New', 'pending');
const Classifying = H.state('Classifying', 'active');
const Drafting = H.state('Drafting', 'active');
const AwaitingApproval = H.state('AwaitingApproval', 'waiting');
const Held = H.state('Held', 'waiting');
const Sent = H.state('Sent', 'waiting');
const ClosedByCustomer = H.state('ClosedByCustomer', 'terminal', 'success');
const Escalated = H.state('Escalated', 'terminal', 'neutral');

const Conversation = H.work('Conversation')
  .attributes({ ticketId: z.number(), category: z.string(), slaDueAt: z.number() })
  .fields({ subject: z.string(), message: z.string() })
  .states([New, Classifying, Drafting, AwaitingApproval, Held, Sent, ClosedByCustomer, Escalated])
  .events({ customerReplied: { message: z.string() }, ticketSolved: {} })
  .timers((t) => ({ breach: t.attribute('slaDueAt') }))
  .key((u) => String(u.attributes.ticketId));

const EscalationQueued = H.state('EscalationQueued', 'pending');
const WithSpecialist = H.state('WithSpecialist', 'waiting');
const EscalationResolved = H.state('EscalationResolved', 'terminal', 'success');

const Escalation = H.work('Escalation')
  .attributes({ ticketId: z.number() })
  .states([EscalationQueued, WithSpecialist, EscalationResolved])
  .key((u) => String(u.attributes.ticketId));

const AuditQueued = H.state('AuditQueued', 'pending');
const UnderAudit = H.state('UnderAudit', 'waiting');
const AuditClosed = H.state('AuditClosed', 'terminal', 'success');
const AuditWithdrawn = H.state('AuditWithdrawn', 'terminal', 'neutral');

const Audit = H.work('Audit')
  .attributes({ category: z.string(), trippedAt: z.number() })
  .states([AuditQueued, UnderAudit, AuditClosed, AuditWithdrawn])
  .events({ recovered: { rate: z.number() } })
  .key((u) => `${u.attributes.category}@${u.attributes.trippedAt}`);

const humanResolution = H.decision('human-resolution', { note: z.string() });
const humanOnly = H.flow('human-only')
  .halt('review', humanResolution, { ask: (c) => `Resolve ${c.unit.kind.name} ${c.unit.key}.` })
  .ends(['resolved'], () => 'resolved');

const escalations = H.lane('escalations', Escalation)
  .handler(humanOnly, { states: { review: WithSpecialist, resolved: EscalationResolved } });

const audits = H.lane('audits', Audit)
  .handler(humanOnly, { states: { review: UnderAudit, resolved: AuditClosed } })
  .reacts({ recovered: H.reaction(AuditWithdrawn).from([AuditQueued, UnderAudit]).cancels() });

const mostSpecific = H.policy.recall('most-specific-first', (c) =>
  [...c.candidates]
    .sort((a, b) => b.specificity - a.specificity || b.track.succeeded - a.track.succeeded)
    .slice(0, c.limit),
);
const toneJournal = H.journal('tone-journal', H.memory.taste('support-tone'))
  .store(jsonl.memory('memory/tone.jsonl'))
  .recall(mostSpecific);
const draftingLessonsJournal = H.journal('drafting-lessons-journal', H.memory.experience('drafting-lessons').curated())
  .store(jsonl.memory('memory/drafting-lessons.jsonl'))
  .recall(mostSpecific);

const api = anthropic.account('support-api', { apiKey: H.env('ANTHROPIC_API_KEY') });
const haiku = anthropic.model('claude-haiku-4-5');
const sonnet = anthropic.model('claude-sonnet-4-5');
const opus = anthropic.model('claude-opus-4-1');

const drafterModel = H.policy.model('drafter-model', [sonnet, opus], (c) => {
  const unit = c.unitOf(Conversation);
  if (unit === null) return sonnet;
  const auditsThisMonth = c.metrics.count({
    lane: audits,
    where: { category: unit.attributes.category },
    sinceMs: c.clock.startOfMonth(),
  });
  return auditsThisMonth > 0 ? opus : sonnet;
});

const classifierRole = H.role('classifier')
  .intents(['read'])
  .instructions('Name the category of the customer conversation.')
  .input({ subject: z.string(), message: z.string() })
  .output({ category: z.string() });
const drafterRole = H.role('drafter')
  .intents(['read'])
  .instructions('Draft the reply to the customer.')
  .input({ subject: z.string(), message: z.string(), category: z.string(), followUps: z.array(z.string()) })
  .output({ reply: z.string() });

const classifier = H.agent('classifier-agent', classifierRole).model(haiku).pool(api);
const drafter = H.agent('drafter-agent', drafterRole)
  .model(drafterModel)
  .pool(api)
  .recalls([toneJournal, draftingLessonsJournal]);

const replyApproval = H.decision('reply-approval', { approved: z.boolean(), reply: z.string(), notes: z.string() });
const approvalRate = H.metric('approval-rate').of(replyApproval).hit((d) => d.approved);

const safeCategory = H.policy.halt('safe-category', Conversation, replyApproval).decides((g) => {
  const record = g.metrics.read(approvalRate, { where: { category: g.unit.attributes.category }, window: 'all' });
  return record.n >= 200 && record.hits === record.n ? { approved: true, reply: '', notes: 'safe category' } : null;
});

const zendeskConnection = { subdomain: 'acme', token: H.env('ZENDESK_TOKEN') };
const sendReply = zendesk.reply('send-reply', zendeskConnection);

const triage = H.flow('triage')
  .requires({ ticketId: z.number(), subject: z.string(), message: z.string() })
  .events({ customerReplied: { message: z.string() } })
  .step('classify', classifier, (c) => ({ subject: c.input.subject, message: c.input.message }))
  .sets({ category: z.string() }, (c) => ({ category: c.out.classify.category }))
  .step('draft', drafter, (c) => ({
    subject: c.input.subject,
    message: c.input.message,
    category: c.input.category,
    followUps: c.events.customerReplied.map((r) => r.payload.message),
  }))
  .halt('approval', replyApproval, { ask: (c) => `Approve the reply to ticket ${c.input.ticketId}:\n\n${c.out.draft.reply}` })
  .exit('rejected', (c) => !c.out.approval.approved)
  .step('send', sendReply, (c) => ({
    ticketId: c.input.ticketId,
    body: c.out.approval.reply === '' ? c.out.draft.reply : c.out.approval.reply,
  }))
  .ends(['sent'], () => 'sent');

const conversations = H.lane('conversations', Conversation)
  .supply([
    zendesk.webhook(
      Conversation,
      { ...zendeskConnection, port: H.slot.port(1), signingSecret: H.env('ZENDESK_SIGNING_SECRET') },
      (event, s) => {
        if (event.type === 'ticket.created') {
          return s.create({
            attributes: {
              ticketId: event.ticket.id,
              category: 'unclassified',
              slaDueAt: event.ticket.slaDueAt ?? event.ticket.updatedAt + fourHoursMs,
            },
            fields: { subject: event.ticket.subject, message: event.ticket.latestComment },
          });
        }
        if (event.type === 'ticket.solved') return s.event(String(event.ticket.id), 'ticketSolved', {});
        return event.fromCustomer
          ? s.event(String(event.ticket.id), 'customerReplied', { message: event.ticket.latestComment })
          : null;
      },
    ),
    zendesk.poll(Conversation, H.time.every({ minutes: 15 }), zendeskConnection, (ticket, s) =>
      s.create({
        attributes: { ticketId: ticket.id, category: 'unclassified', slaDueAt: ticket.slaDueAt ?? ticket.updatedAt + fourHoursMs },
        fields: { subject: ticket.subject, message: ticket.latestComment },
      }),
    ),
  ])
  .store(
    zendesk.store(Conversation, {
      ...zendeskConnection,
      status: { New: 'new', AwaitingApproval: 'pending', Sent: 'pending', ClosedByCustomer: 'solved', Escalated: 'open' },
    }),
  )
  .runner(local.shell({ slots: 4 }))
  .wip(10)
  .budget({ maxUsdPerUnit: 0.4, onExceed: 'halt' })
  .handler(triage, {
    opens: Classifying,
    blocked: Held,
    states: {
      classify: Classifying,
      draft: Drafting,
      approval: AwaitingApproval,
      rejected: H.loopback(New, { max: 3, then: Escalated }),
      sent: Sent,
    },
    resolvers: { approval: safeCategory },
  })
  .reacts({
    customerReplied: H.reaction(New).from([AwaitingApproval, Held, Sent]).cancels(),
    ticketSolved: H.reaction(ClosedByCustomer).from([Sent]),
    breach: H.reaction(Escalated).from([New, Classifying, Drafting, AwaitingApproval, Held, Sent]).cancels(),
  });

const approvalByCategory = H.threshold('approval-by-category', approvalRate, {
  window: { days: 7 },
  minSamples: 50,
  trips: { below: 0.9 },
  resets: { above: 0.95 },
  kind: Conversation,
  per: 'category',
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

const escalateOnBreach = H.trigger('escalated-conversation-opens-escalation', H.on.transition(conversations, { to: [Escalated] }))
  .creates((e) => escalations.unit({ attributes: { ticketId: e.unit.attributes.ticketId } }));

const openAudit = H.trigger('approval-fell-opens-audit', H.on.crossed(approvalByCategory))
  .creates((e) => audits.unit({ attributes: { category: e.group.category, trippedAt: e.trippedAt } }))
  .records(draftingLessonsJournal, (e) => [
    {
      rule: `when drafting for ${e.group.category}, recall the stricter phrasing`,
      because: `approvals fell to ${e.rate.toFixed(2)} over ${e.n} replies`,
      when: { roles: [drafterRole], attributes: { category: e.group.category } },
    },
  ]);

const withdrawAudit = H.trigger('approval-recovered-withdraws-audit', H.on.recovered(approvalByCategory))
  .sends((e) => audits.event(`${e.group.category}@${e.trippedAt}`, 'recovered', { rate: e.rate }));

const pauseOnModelErrors = H.trigger('model-errors-pause-conversations', H.on.crossed(modelErrorRate)).pauses(conversations);
const resumeOnRecovery = H.trigger('model-recovery-resumes-conversations', H.on.recovered(modelErrorRate)).resumes(conversations);

const breachFirst = H.policy.schedule('breach-first', (c) => {
  const pausedThisMonthMs = c.metrics.pausedMs({ lane: conversations, sinceMs: c.clock.startOfMonth() });
  const catchUp = pausedThisMonthMs > 60 * 60 * 1000;
  return {
    start: c.order(
      (x) => (x.is(conversations) ? (catchUp ? 0 : 1) : catchUp ? 1 : 0),
      (x) => x.timers.breach ?? Number.MAX_SAFE_INTEGER,
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

export const support = H.harness('support-self-watch')
  .ledger(sqlite.ledger('state/support.sqlite'))
  .lanes([conversations, escalations, audits])
  .triggers([escalateOnBreach, openAudit, withdrawAudit, pauseOnModelErrors, resumeOnRecovery])
  .schedule(breachFirst)
  .clients([claudeCode.supervisor('reviewer', reviewerAccess, { port: H.slot.port(0) })])
  .projections([markdown.board('BOARD.md'), markdown.telemetry('TELEMETRY.md')]);

export const running = support.start();
