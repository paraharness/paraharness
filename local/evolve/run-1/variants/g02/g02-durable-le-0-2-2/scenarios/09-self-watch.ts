import { z } from 'zod';
import { H } from 'harness-dsl';
import { anthropic } from 'harness-dsl/anthropic';
import { claudeCode } from 'harness-dsl/claude-code';
import { jsonl } from 'harness-dsl/jsonl';
import { local } from 'harness-dsl/local';
import { markdown } from 'harness-dsl/markdown';
import { sqlite } from 'harness-dsl/sqlite';
import { zendesk, type ZendeskEvent } from 'harness-dsl/zendesk';

const helpdeskToken = H.env('ZENDESK_TOKEN');

const slaHours: Record<ZendeskEvent['priority'], number> = { urgent: 1, high: 4, normal: 8, low: 24 };

function slaDeadline(priority: ZendeskEvent['priority'], from: Date): string {
  return new Date(from.getTime() + slaHours[priority] * 3_600_000).toISOString();
}

const conversation = z.object({
  ticketId: z.string(),
  subject: z.string(),
  message: z.string(),
  customerEmail: z.string(),
  slaDeadline: z.string(),
});

const New = H.state('new', 'pending');
const Sent = H.state('sent', 'waiting');
const Closed = H.terminal('closed', 'success');
const Escalated = H.terminal('escalated', 'failure');
const Rejected = H.terminal('rejected', 'failure');
const Dropped = H.terminal('dropped', 'neutral');

const Conversation = H.kind('Conversation')
  .attributes(conversation)
  .states(New, Sent, Closed, Escalated, Rejected, Dropped)
  .key(c => c.ticketId)
  .initial(New)
  .onCancelled(Dropped);

const CustomerReplied = H.signal('customer-replied').payload(
  z.object({ message: z.string(), slaDeadline: z.string() }),
);
const CustomerClosed = H.signal('customer-closed');
const ExtendSla = H.signal('extend-sla').payload(z.object({ slaDeadline: z.string() }));
const Escalate = H.signal('escalate');

const classifier = H.role('classifier').intents('read').instructions('Classify the conversation into one category.');
const drafter = H.role('drafter')
  .intents('read')
  .instructions('Draft the reply in the house tone, using the memory you are given.');

const taste = H.memory('reply-taste').trust('taste');
const experience = H.memory('support-experience').trust('experience');

const replyTaste = H.journal('reply-taste', taste)
  .store(jsonl.memoryStore({ path: 'support/memory/taste.jsonl' }))
  .recall(H.recall('taste-by-scope', { by: 'specificity', limit: 15 }))
  .readBy(drafter);

const supportExperience = H.journal('support-experience', experience)
  .store(jsonl.memoryStore({ path: 'support/memory/experience.jsonl' }))
  .recall(H.recall('experience-by-scope', { by: 'specificity', limit: 10 }))
  .readBy(drafter);

const haiku = anthropic.model('haiku', { id: 'claude-haiku-4-5' });
const sonnet = anthropic.model('sonnet', { id: 'claude-sonnet-4-5' });
const opus = anthropic.model('opus', { id: 'claude-opus-4-1' });
const supportAccount = anthropic.account('support', { apiKey: H.env('ANTHROPIC_API_KEY') });
const pool = H.pool('support').accounts(supportAccount).serves(haiku, sonnet, opus);

const approvalRate = H.metric('approval-rate', 'rate');
const modelErrors = H.metric('model-errors', 'rate');
const auditsOpened = H.metric('audits-opened', 'total');

const drafterModel = H.policy.model('drafter-model', [sonnet, opus], ctx => {
  const pauses = ctx.metrics.paused({ lane: ctx.lane, window: { lastDays: 7 } });
  return pauses.count >= 3 ? opus : sonnet;
});

const classifierAgent = H.agent('classifier')
  .role(classifier)
  .model(haiku)
  .output(z.object({ category: z.string() }));

const drafterAgent = H.agent('drafter')
  .role(drafter)
  .model(drafterModel)
  .output(z.object({ reply: z.string() }));

const sendReply = H.command('send-reply')
  .input(z.object({ ticketId: z.string(), reply: z.string() }))
  .argv(message => ['helpdesk-reply', '--ticket', message.ticketId, '--body', message.reply])
  .env({ HELPDESK_TOKEN: helpdeskToken })
  .runner(local.runner('support-local').slots(4));

const conversationFlow = H.flow('conversation')
  .input(conversation)
  .step('classify', classifierAgent, ctx => ({
    task: `${ctx.unit.attributes.subject}\n\n${ctx.unit.attributes.message}`,
  }))
  .loop(
    'drafting',
    flow =>
      flow
        .step('draft', drafterAgent, ctx => ({
          task: `Reply to ${ctx.unit.attributes.customerEmail}:\n\n${ctx.unit.attributes.message}`,
          skills: [ctx.steps.classify.category],
        }))
        .halt('approval', z.object({ approved: z.boolean(), notes: z.string() }), {
          ask: ctx => `Approve this ${ctx.steps.classify.category} reply?\n\n${ctx.steps.draft.reply}`,
          skip: ctx => {
            const record = ctx.metrics.rate(approvalRate, { group: ctx.steps.classify.category });
            return record.samples >= 200 && record.hits === record.samples
              ? { approved: true, notes: '' }
              : undefined;
          },
        }),
    { max: 3, until: ctx => ctx.steps.approval.approved },
  )
  .exit('rejected', ctx => !ctx.steps.approval.approved)
  .step('send', sendReply, ctx => ({ ticketId: ctx.unit.attributes.ticketId, reply: ctx.steps.draft.reply }))
  .exit('sent');

const helpdeskEvents = [
  zendesk.webhook({ port: H.slot.port(0), path: '/helpdesk', secret: H.env('ZENDESK_WEBHOOK_SECRET') }),
  zendesk.poll({ subdomain: 'acme', token: helpdeskToken, everyMinutes: 10 }),
];

const conversations = H.lane('conversations', Conversation)
  .supply(helpdeskEvents, (event, to) => {
    if (event.type === 'created')
      return to.create({
        ticketId: event.ticketId,
        subject: event.subject,
        message: event.message,
        customerEmail: event.customerEmail,
        slaDeadline: slaDeadline(event.priority, event.createdAt),
      });
    if (event.type === 'replied')
      return to.signal(CustomerReplied, event.ticketId, {
        message: event.message,
        slaDeadline: slaDeadline(event.priority, new Date()),
      });
    if (event.status === 'solved' || event.status === 'closed') return to.signal(CustomerClosed, event.ticketId, {});
    return to.skip();
  })
  .store(zendesk.store({ subdomain: 'acme', token: helpdeskToken }))
  .handler(conversationFlow, { exits: { rejected: Rejected, sent: Sent } })
  .on(CustomerReplied, {
    update: (c, reply) => ({ ...c, message: reply.message, slaDeadline: reply.slaDeadline }),
    restart: 'classify',
  })
  .on(CustomerClosed, { enter: Closed })
  .on(ExtendSla, { update: (c, extension) => ({ ...c, slaDeadline: extension.slaDeadline }) })
  .on(Escalate, { enter: Escalated })
  .ceiling({ maxUsd: 0.4, onExceed: 'halt' });

const escalation = z.object({ ticketId: z.string(), reason: z.string() });

const EscalationOpen = H.state('escalation-open', 'pending');
const EscalationResolved = H.terminal('escalation-resolved', 'success');
const EscalationDropped = H.terminal('escalation-dropped', 'neutral');

const Escalation = H.kind('Escalation')
  .attributes(escalation)
  .states(EscalationOpen, EscalationResolved, EscalationDropped)
  .key(e => e.ticketId)
  .initial(EscalationOpen)
  .onCancelled(EscalationDropped);

const escalationFlow = H.flow('escalation')
  .input(escalation)
  .halt('handle', z.object({ resolution: z.string() }), {
    ask: ctx => `Ticket ${ctx.unit.attributes.ticketId} escalated: ${ctx.unit.attributes.reason}. Resolve it.`,
  })
  .exit('resolved');

const escalations = H.lane('escalations', Escalation)
  .handler(escalationFlow, { exits: { resolved: EscalationResolved } });

const audit = z.object({ category: z.string(), openingRate: z.number(), openingSamples: z.number() });

const AuditOpen = H.state('audit-open', 'pending');
const AuditClosed = H.terminal('audit-closed', 'success');
const AuditWithdrawn = H.terminal('audit-withdrawn', 'neutral');

const Audit = H.kind('Audit')
  .attributes(audit)
  .states(AuditOpen, AuditClosed, AuditWithdrawn)
  .key(a => a.category)
  .initial(AuditOpen)
  .onCancelled(AuditWithdrawn);

const auditFlow = H.flow('audit')
  .input(audit)
  .halt('review', z.object({ findings: z.string(), actions: z.array(z.string()) }), {
    ask: ctx => {
      const opened = ctx.metrics.total(auditsOpened, {
        group: ctx.unit.attributes.category,
        window: { calendar: 'month' },
      });
      const paused = ctx.metrics.paused({ lane: conversations, window: { calendar: 'month' } });
      return `Approval rate for ${ctx.unit.attributes.category} fell to ${ctx.unit.attributes.openingRate} over ${ctx.unit.attributes.openingSamples} samples. Audits opened for this category this month: ${opened.total}. Conversations lane paused ${Math.round(paused.totalMs / 60_000)} minutes over ${paused.count} pauses this month.`;
    },
  })
  .exit('closed');

const audits = H.lane('audits', Audit).handler(auditFlow, { exits: { closed: AuditClosed } });

const approvalRateDefinition = approvalRate.from(H.when.step(conversations, 'approval'), event => [
  event.outputs.classify === undefined || event.output === undefined
    ? undefined
    : { group: event.outputs.classify.category, hit: event.output.approved },
]);

const modelErrorsDefinition = modelErrors.from(H.when.invocation({ lanes: [conversations] }), event => [
  event.model === undefined ? undefined : { group: 'all', hit: !event.ok },
]);

const auditsOpenedDefinition = auditsOpened.from(
  H.when.transition(audits, { to: AuditOpen, if: event => event.from === undefined }),
  event => [{ group: event.unit.attributes.category, amount: 1 }],
);

const approvalWatch = H.trigger(
  'approval-watch',
  H.when.crossing(approvalRate, {
    window: { lastDays: 7 },
    minSamples: 50,
    enter: { below: 0.9 },
    exit: { above: 0.95 },
  }),
)
  .create(audits, event =>
    event.edge === 'entered'
      ? { category: event.group, openingRate: event.value, openingSamples: event.samples }
      : undefined,
  )
  .record(supportExperience, event =>
    event.edge === 'entered'
      ? {
          body: {
            text: `When drafting for ${event.group}, recall the stricter phrasing, because approvals fell to ${event.value}.`,
          },
          when: { roles: [drafter], skills: [event.group] },
          status: 'candidate',
        }
      : undefined,
  )
  .signal(H.cancel, audits, event =>
    event.edge === 'exited'
      ? { key: event.group, payload: { reason: `approval rate recovered to ${event.value}` } }
      : undefined,
  );

const errorWatch = H.trigger(
  'model-error-watch',
  H.when.crossing(modelErrors, {
    window: { lastHours: 1 },
    minSamples: 20,
    enter: { above: 0.2 },
    exit: { below: 0.05 },
  }),
)
  .pause(conversations, event =>
    event.edge === 'entered'
      ? `model error rate ${event.value} over ${event.samples} invocations in the last hour`
      : undefined,
  )
  .resume(conversations, event =>
    event.edge === 'exited'
      ? `model error rate recovered to ${event.value} over ${event.samples} invocations`
      : undefined,
  );

const slaBreach = H.trigger(
  'sla-breach',
  H.when.timer(conversations, { at: unit => new Date(unit.attributes.slaDeadline) }),
)
  .create(escalations, event =>
    event.unit.state === 'sent' || event.unit.position === 'terminal'
      ? undefined
      : { ticketId: event.unit.attributes.ticketId, reason: 'SLA breached' },
  )
  .signal(Escalate, conversations, event =>
    event.unit.state === 'sent' || event.unit.position === 'terminal'
      ? undefined
      : { key: event.unit.key, payload: {} },
  );

const rejectionEscalation = H.trigger(
  'rejection-escalation',
  H.when.transition(conversations, { to: Rejected }),
).create(escalations, event => ({
  ticketId: event.unit.attributes.ticketId,
  reason: 'reply rejected in every drafting round',
}));

const scheduler = H.scheduler('support')
  .priority(escalations, audits, conversations)
  .rank(conversations, c => new Date(c.attributes.slaDeadline).getTime());

export default H.harness('support')
  .ledger(sqlite.ledger({ path: 'support/ledger.sqlite' }))
  .pools(pool)
  .lanes(conversations, escalations, audits)
  .journals(replyTaste, supportExperience)
  .triggers(approvalWatch, errorWatch, slaBreach, rejectionEscalation)
  .metrics(approvalRateDefinition, modelErrorsDefinition, auditsOpenedDefinition)
  .scheduler(scheduler)
  .clients(
    claudeCode.supervisor('reviewer-desk', {
      grants: [
        H.ops.workRead,
        H.ops.workSignal,
        H.ops.workCancel,
        H.ops.blockersResolve,
        H.ops.lanesPause,
        H.ops.memoryRead,
        H.ops.memoryWrite,
        H.ops.memoryCurate,
        H.ops.telemetryRead,
      ],
    }),
  )
  .observers(markdown.board({ path: 'support/BOARD.md' }), markdown.telemetry({ path: 'support/TELEMETRY.md' }));
