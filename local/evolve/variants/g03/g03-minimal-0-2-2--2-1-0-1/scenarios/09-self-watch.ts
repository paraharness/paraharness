import { H } from 'harness-dsl';
import type { Metrics, Rate, EntryFilter, PendingView, SupplyOf } from 'harness-dsl';
import { z } from 'zod';
import * as anthropic from 'harness-dsl/anthropic';
import * as claudeCode from 'harness-dsl/claude-code';
import * as sqlite from 'harness-dsl/sqlite';
import * as jsonl from 'harness-dsl/jsonl';
import * as shell from 'harness-dsl/shell';
import * as http from 'harness-dsl/http';
import * as markdown from 'harness-dsl/markdown';

const haiku = anthropic.model('claude-haiku-4-5');
const sonnet = anthropic.model('claude-sonnet-4-5');
const api = anthropic.account('anthropic-api', { apiKey: H.env('ANTHROPIC_API_KEY') });

const local = shell.local('local', { slots: 4 });

const categories = z.enum(['billing', 'refund', 'technical', 'account', 'other']);
type Category = z.infer<typeof categories>;
const category = H.facet('category', categories);

const fresh = H.state('new', 'pending');
const classifying = H.state('classifying', 'pending');
const sent = H.state('sent', 'waiting');
const closedByCustomer = H.state('closedByCustomer', 'terminal', 'success');
const escalated = H.state('escalated', 'terminal', 'neutral');
const failed = H.state('failed', 'terminal', 'failure');

const conversation = H.kind('Conversation')
  .data(z.object({
    ticket: z.string(),
    customer: z.string(),
    lastMessage: z.string(),
    slaDueAt: z.string(),
    category: categories.optional(),
  }))
  .states(fresh, classifying, sent, closedByCustomer, escalated, failed);

const helpdeskEvent = z.discriminatedUnion('type', [
  z.object({ type: z.literal('created'), ticket: z.string(), customer: z.string(), message: z.string(), slaDueAt: z.string() }),
  z.object({ type: z.literal('replied'), ticket: z.string(), message: z.string() }),
  z.object({ type: z.literal('closed'), ticket: z.string() }),
]);
type HelpdeskEvent = z.infer<typeof helpdeskEvent>;

const fromHelpdesk = (event: HelpdeskEvent): SupplyOf<typeof conversation> => {
  switch (event.type) {
    case 'created':
      return {
        create: { ticket: event.ticket, customer: event.customer, lastMessage: event.message, slaDueAt: event.slaDueAt },
        key: event.ticket,
      };
    case 'replied':
      return { update: event.ticket, patch: { lastMessage: event.message }, state: 'classifying', cancels: ['waiting'] };
    case 'closed':
      return { update: event.ticket, state: 'closedByCustomer', cancels: ['active', 'waiting'] };
  }
};

const helpdeskHeaders = { authorization: H.env('HELPDESK_AUTH_HEADER') };

const helpdeskWebhook = http.webhook(conversation, {
  path: '/helpdesk',
  secret: H.env('HELPDESK_WEBHOOK_SECRET'),
  body: helpdeskEvent,
  read: fromHelpdesk,
});

const helpdeskPoll = http.poll(conversation, {
  url: 'https://helpdesk.example.com/api/tickets?status=open',
  every: { minutes: 10 },
  headers: helpdeskHeaders,
  body: z.object({
    tickets: z.array(z.object({ ticket: z.string(), customer: z.string(), message: z.string(), slaDueAt: z.string() })),
  }),
  read: body => body.tickets.map(ticket => fromHelpdesk({ type: 'created', ...ticket })),
});

const helpdeskStore = http.store(conversation, {
  url: 'https://helpdesk.example.com/api/tickets',
  headers: helpdeskHeaders,
  stateField: 'harness_state',
});

const tasteMemory = H.memory('reply-taste', 'taste');
const experienceMemory = H.memory('reply-experience', 'experience');
const replyTaste = H.journal('reply-taste', tasteMemory, jsonl.memory('.harness/taste.jsonl'));
const drafterExperience = H.journal('drafter-experience', experienceMemory, jsonl.memory('.harness/experience.jsonl'));

const classifying_ = H.role('classifier')
  .input(z.object({ message: z.string() }))
  .output(z.object({ category: categories }))
  .prompt(input => `Classify this customer message:\n${input.message}`);

const drafting = H.role('drafter')
  .input(z.object({ message: z.string(), category: categories }))
  .output(z.object({ reply: z.string() }))
  .prompt(input => `Draft a reply for a ${input.category} conversation:\n${input.message}`);

const classifier = H.seat('classifier', classifying_).model(haiku);
const drafter = H.seat('drafter', drafting).model(sonnet).recalls(replyTaste, drafterExperience);

const approvalDecision = z.object({ approved: z.boolean(), reply: z.string().optional() });
type Approval = z.infer<typeof approvalDecision>;
const approvalAbout = z.object({ category: categories });
type ApprovalAbout = z.infer<typeof approvalAbout>;

function humanApprovalRecord(metrics: Metrics, value: Category, days?: number): Rate {
  const scope = [category.of(value)];
  return metrics.rate({
    among: { ...replyApproval.resolved(), resolver: 'human', facets: scope },
    count: { ...replyApproval.resolved({ approved: true }), resolver: 'human', facets: scope },
    days,
  });
}

const safeCategory = H.policy.rule('safe-category-approval', (about: ApprovalAbout, metrics: Metrics): Approval | null => {
  const record = humanApprovalRecord(metrics, about.category);
  return record.samples >= 200 && record.hits === record.samples ? { approved: true } : null;
});

const replyApproval = H.halt('reply-approval', approvalDecision).about(approvalAbout).policy(safeCategory);

const sendReply = H.command('send-reply')
  .input(z.object({ ticket: z.string(), reply: z.string() }))
  .argv(input => [
    'curl', '-sf', '-X', 'POST', `https://helpdesk.example.com/api/tickets/${input.ticket}/reply`,
    '-H', H.env('HELPDESK_AUTH_HEADER'), '--data-urlencode', `body=${input.reply}`,
  ])
  .on(local)
  .recovery('park');

const handleConversation = H.flow('handle-conversation').for(conversation).does(async ctx => {
  const classified = await ctx.run(classifier, { message: ctx.unit.data.lastMessage });
  if (!classified.ok) return ctx.fail(classified.error);
  await ctx.update({ category: classified.value.category });
  const draft = await ctx.run(drafter, { message: ctx.unit.data.lastMessage, category: classified.value.category });
  if (!draft.ok) return ctx.fail(draft.error);
  const approval = await ctx.halt(replyApproval, draft.value.reply, { category: classified.value.category });
  if (!approval.approved) return 'escalated';
  const posted = await ctx.run(sendReply, { ticket: ctx.unit.data.ticket, reply: approval.reply ?? draft.value.reply });
  return posted.ok ? 'sent' : ctx.fail(posted.error);
});

const conversations = H.lane('conversations', conversation)
  .handler(handleConversation)
  .attempts(3, { backoff: { first: { minutes: 2 }, factor: 2 }, exhausted: 'failed' })
  .suppliers(helpdeskWebhook, helpdeskPoll)
  .store(helpdeskStore)
  .wip(8)
  .maxUsdPerUnit(0.4)
  .facet(category, data => data.category);

const raised = H.state('raised', 'pending');
const handled = H.state('handled', 'terminal', 'success');
const dropped = H.state('dropped', 'terminal', 'neutral');

const escalation = H.kind('Escalation').data(z.object({ ticket: z.string(), reason: z.string() })).states(raised, handled, dropped);
const escalationResolution = H.halt('escalation-resolution', z.object({ resolved: z.boolean(), note: z.string().optional() }));

const handleEscalation = H.flow('handle-escalation').for(escalation).does(async ctx => {
  const outcome = await ctx.halt(escalationResolution, `${ctx.unit.data.ticket}: ${ctx.unit.data.reason}`);
  return outcome.resolved ? 'handled' : 'dropped';
});

const escalations = H.lane('escalations', escalation)
  .handler(handleEscalation)
  .attempts(1, { exhausted: 'dropped' })
  .store(sqlite.store(escalation, '.harness/escalations.db'));

const monthStart = (now: Date): Date => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));

const auditOpen = H.state('auditOpen', 'pending');
const auditClosed = H.state('auditClosed', 'terminal', 'success');
const auditCancelled = H.state('auditCancelled', 'terminal', 'neutral');

const audit = H.kind('Audit').data(z.object({ category: categories })).states(auditOpen, auditClosed, auditCancelled);

const auditHistory = H.policy.rule('audit-history', (input: { readonly category: Category; readonly since: Date }, metrics: Metrics) => ({
  auditsOpened: metrics.count({
    of: { entry: 'transition', kind: audit, state: 'auditOpen', facets: [category.of(input.category)] },
    since: input.since,
  }),
  lanePausedMs: metrics.sum({ of: 'durationMs', among: { entry: 'lane', status: 'resumed', lane: conversations }, since: input.since }),
  approvalRate: humanApprovalRecord(metrics, input.category, 7),
}));

const auditFinding = H.halt('audit-finding', z.object({ finding: z.string() }));

const runAudit = H.flow('run-audit').for(audit).does(async ctx => {
  const history = await ctx.decide(auditHistory, { category: ctx.unit.data.category, since: monthStart(ctx.now()) });
  await ctx.halt(
    auditFinding,
    `Audit ${ctx.unit.data.category}: approval ${history.approvalRate.value ?? 'n/a'} over ${history.approvalRate.samples} samples; ` +
      `${history.auditsOpened} audits this month; lane paused ${history.lanePausedMs.value ?? 0} ms this month`
  );
  return 'auditClosed';
});

const audits = H.lane('audits', audit)
  .handler(runAudit)
  .attempts(1, { exhausted: 'auditCancelled' })
  .store(sqlite.store(audit, '.harness/audits.db'))
  .facet(category, data => data.category);

const slaBreach = H.trigger(
  'sla-breach',
  H.on.deadline(conversation, data => new Date(data.slaDueAt), ['new', 'classifying']),
  (_event, act) => act.move('escalated')
);

const escalateOnEnter = H.trigger('escalate-conversation', H.on.enters(conversation, 'escalated'), (event, act) =>
  act.create(escalations, { ticket: event.unit.data.ticket, reason: 'conversation escalated' }, `escalation-${event.unit.key}`)
);

const approvalByCategory = (metrics: Metrics) =>
  metrics.rateBy({
    among: { ...replyApproval.resolved(), resolver: 'human' },
    count: { ...replyApproval.resolved({ approved: true }), resolver: 'human' },
    by: category,
    days: 7,
  });

const auditOnApprovalDrop = H.trigger(
  'audit-on-approval-drop',
  H.on.metric(approvalByCategory, { trip: { below: 0.9 }, reset: { above: 0.95 }, minSamples: 50 }),
  (event, act) =>
    event.state === 'tripped'
      ? [
          act.create(audits, { category: event.group }, `audit-${event.group}`),
          act.remember(drafterExperience, {
            text: `When drafting for ${event.group}, recall the stricter phrasing`,
            because: `approvals fell to ${event.rate.value === null ? 'unknown' : event.rate.value.toFixed(2)} over ${event.rate.samples} samples`,
            when: { roles: [drafting], facets: [category.of(event.group)] },
            status: 'candidate',
          }),
        ]
      : act.move(audits, `audit-${event.group}`, 'auditCancelled')
);

const modelCalls: EntryFilter = { entry: 'invocation', mode: 'model', status: 'ended' };

const pauseOnModelErrors = H.trigger(
  'pause-on-model-errors',
  H.on.metric(metrics => metrics.rate({ among: modelCalls, count: { ...modelCalls, ok: false }, hours: 1 }), {
    trip: { above: 0.2 },
    reset: { below: 0.05 },
    minSamples: 20,
  }),
  (event, act) => (event.state === 'tripped' ? act.pause(conversations) : act.resume(conversations))
);

const timeToBreach = H.policy.scheduler('time-to-breach', view => {
  const due = (unit: PendingView): number =>
    unit.is(conversation) ? new Date(unit.data.slaDueAt).getTime() : unit.is(escalation) ? 0 : Number.MAX_SAFE_INTEGER;
  return { start: [...view.pending].sort((a, b) => due(a) - due(b)) };
});

export const support = H.harness('support')
  .ledger(sqlite.ledger('.harness/ledger.db'))
  .lanes(conversations, escalations, audits)
  .pools(H.pool('api', [{ account: api, share: 1, serves: [haiku, sonnet] }]))
  .triggers(slaBreach, escalateOnEnter, auditOnApprovalDrop, pauseOnModelErrors)
  .scheduler(timeToBreach)
  .clients(claudeCode.supervisor({
    grants: [
      H.ops.readWork,
      H.ops.writeWork,
      H.ops.resolve(replyApproval, escalationResolution, auditFinding, H.halts.costCeiling, H.halts.interrupted, H.halts.definitionChanged),
      H.ops.writeMemory,
      H.ops.curateMemory,
      H.ops.readTelemetry,
    ],
  }))
  .observers(markdown.board('BOARD.md'), markdown.telemetry('TELEMETRY.md'));
