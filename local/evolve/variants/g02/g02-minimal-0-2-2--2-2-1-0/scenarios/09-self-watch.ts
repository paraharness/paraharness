import { H } from 'harness-dsl';
import type { Metrics } from 'harness-dsl';
import { z } from 'zod';
import { webhook, store, control } from 'harness-dsl/http';
import { supervisor } from 'harness-dsl/claude-code';
import { account, model } from 'harness-dsl/anthropic';
import { ledger } from 'harness-dsl/sqlite';
import { memory } from 'harness-dsl/jsonl';
import { local } from 'harness-dsl/shell';
import { board, telemetry } from 'harness-dsl/markdown';

const shell = local('support-shell', { slots: 4 });
const api = account('support-api', { apiKey: H.env('ANTHROPIC_API_KEY') });
const haiku = model('claude-haiku-4-5');
const sonnet = model('claude-sonnet-4-5');

const categoryValues = z.enum(['billing', 'shipping', 'refund', 'technical', 'other']);
type Category = z.infer<typeof categoryValues>;
const category = H.facet('category', categoryValues);

const tone = H.memory('support-tone', 'taste');
const lessons = H.memory('support-lessons', 'experience');
const toneJournal = H.journal('support-tone-journal', tone, memory('/srv/support/taste.jsonl'));
const lessonJournal = H.journal('support-lesson-journal', lessons, memory('/srv/support/experience.jsonl'));

const fresh = H.state('new', 'pending');
const classifying = H.state('classifying', 'pending');
const sent = H.state('sent', 'waiting');
const closedByCustomer = H.state('closed-by-customer', 'terminal', 'success');
const escalated = H.state('escalated', 'terminal', 'neutral');
const abandoned = H.state('abandoned', 'terminal', 'failure');
const conversation = H.kind('conversation')
  .data(z.object({ customer: z.string(), message: z.string(), category: categoryValues.optional(), slaDue: z.string() }))
  .states(fresh, classifying, sent, closedByCustomer, escalated, abandoned);

const classifyRole = H.role('classify')
  .input(z.object({ message: z.string() }))
  .output(z.object({ category: categoryValues }))
  .prompt(input => `Classify this support message:\n${input.message}`);
const draftRole = H.role('draft-reply')
  .input(z.object({ message: z.string(), category: categoryValues }))
  .output(z.object({ reply: z.string() }))
  .prompt(input => `Draft a reply for a ${input.category} conversation:\n${input.message}`);
const classifier = H.seat('classifier', classifyRole).model(haiku);
const drafter = H.seat('drafter', draftRole).model(sonnet).recalls(toneJournal, lessonJournal);

const approval = H.halt('reply-approval', z.object({ approved: z.boolean(), edited: z.string().optional() })).about(
  z.object({ category: categoryValues, reply: z.string() })
);
const sendReply = H.command('send-reply')
  .input(z.object({ conversation: z.string(), reply: z.string() }))
  .argv(input => ['helpdesk-reply', input.conversation, input.reply])
  .on(shell)
  .recovery('park');

const handleConversation = H.flow('handle-conversation')
  .for(conversation)
  .does(async ctx => {
    const { message } = ctx.unit.data;
    const classified = await ctx.run(classifier, { message });
    if (!classified.ok) return ctx.fail(classified.error);
    await ctx.update({ category: classified.value.category });
    const drafted = await ctx.run(drafter, { message, category: classified.value.category });
    if (!drafted.ok) return ctx.fail(drafted.error);
    const verdict = await ctx.halt(approval, drafted.value.reply, { category: classified.value.category, reply: drafted.value.reply });
    if (!verdict.approved) return 'escalated';
    const posted = await ctx.run(sendReply, { conversation: ctx.unit.key, reply: verdict.edited ?? drafted.value.reply });
    if (!posted.ok) return ctx.fail(posted.error);
    return 'sent';
  });

const helpdeskHeaders = { Authorization: H.env('HELPDESK_TOKEN') };
const helpdeskHook = webhook(conversation, {
  path: '/helpdesk',
  secret: H.env('HELPDESK_WEBHOOK_SECRET'),
  body: z.object({
    event: z.enum(['created', 'customer-replied', 'closed']),
    conversation: z.string(),
    customer: z.string(),
    message: z.string(),
    slaDue: z.string(),
  }),
  read: body =>
    body.event === 'created'
      ? { create: { customer: body.customer, message: body.message, slaDue: body.slaDue }, key: body.conversation }
      : body.event === 'customer-replied'
        ? { update: body.conversation, patch: { message: body.message }, state: 'classifying', cancels: ['active', 'waiting'] }
        : { update: body.conversation, state: 'closed-by-customer' },
});

const conversationsLane = H.lane('conversations', conversation)
  .handler(handleConversation)
  .retries(2, { backoff: { first: { minutes: 1 }, factor: 2 }, exhausted: 'abandoned' })
  .suppliers(helpdeskHook)
  .store(store(conversation, { url: 'https://helpdesk.example.com/api/conversations', headers: helpdeskHeaders, stateField: 'harness_state' }))
  .wip(6)
  .maxUsdPerUnit(0.4)
  .facet(category, data => data.category);

const raised = H.state('raised', 'pending');
const handled = H.state('handled', 'terminal', 'success');
const unhandled = H.state('unhandled', 'terminal', 'failure');
const escalation = H.kind('escalation')
  .data(z.object({ conversation: z.string(), customer: z.string(), reason: z.string() }))
  .states(raised, handled, unhandled);
const escalationHandled = H.halt('escalation-handled', z.object({ resolution: z.string() }));
const handleEscalation = H.flow('handle-escalation')
  .for(escalation)
  .does(async ctx => {
    await ctx.halt(escalationHandled, `${ctx.unit.data.reason}: conversation ${ctx.unit.data.conversation}`);
    return 'handled';
  });
const escalationLane = H.lane('escalations', escalation)
  .handler(handleEscalation)
  .retries(0, { exhausted: 'unhandled' })
  .suppliers(H.operator);

const monthStart = (now: Date) => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));

const auditOpen = H.state('audit-open', 'pending');
const auditDone = H.state('audit-done', 'terminal', 'success');
const auditCancelled = H.state('audit-cancelled', 'terminal', 'neutral');
const auditStuck = H.state('audit-stuck', 'terminal', 'failure');
const audit = H.kind('audit')
  .data(z.object({ category: categoryValues, rate: z.number(), samples: z.number() }))
  .states(auditOpen, auditDone, auditCancelled, auditStuck);

const auditsOpened = H.policy.rule('audits-opened-this-month', (ask: { readonly category: Category; readonly now: Date }, metrics: Metrics) =>
  metrics.count({
    since: monthStart(ask.now),
    of: { entry: 'transition', kind: audit, state: 'audit-open', facets: [category.of(ask.category)] },
  })
);
const pausedMinutes = H.policy.rule('lane-paused-minutes-this-month', (ask: { readonly now: Date }, metrics: Metrics) => {
  const paused = metrics.sum({
    of: 'durationMs',
    since: monthStart(ask.now),
    among: { entry: 'lane', lane: conversationsLane, status: 'resumed' },
  });
  return Math.round((paused.value ?? 0) / 60_000);
});

const auditFindings = H.halt('audit-findings', z.object({ findings: z.string() })).about(
  z.object({ category: categoryValues, openedThisMonth: z.number(), pausedMinutesThisMonth: z.number() })
);
const reviewAudit = H.flow('review-audit')
  .for(audit)
  .does(async ctx => {
    const now = ctx.now();
    const openedThisMonth = await ctx.decide(auditsOpened, { category: ctx.unit.data.category, now });
    const pausedMinutesThisMonth = await ctx.decide(pausedMinutes, { now });
    await ctx.halt(
      auditFindings,
      `Approval rate for ${ctx.unit.data.category} fell to ${ctx.unit.data.rate} over ${ctx.unit.data.samples} samples`,
      { category: ctx.unit.data.category, openedThisMonth, pausedMinutesThisMonth }
    );
    return 'audit-done';
  });
const auditLane = H.lane('audits', audit)
  .handler(reviewAudit)
  .retries(0, { exhausted: 'audit-stuck' })
  .facet(category, data => data.category);

const approvalsByCategory = (metrics: Metrics) =>
  metrics.rateBy({ days: 7, among: approval.resolved(), count: approval.resolved({ approved: true }), by: category });

const approvalWatch = H.trigger(
  'approval-watch',
  H.on.metric(approvalsByCategory, { trip: { below: 0.9 }, reset: { above: 0.95 }, minSamples: 50 }),
  (event, act) =>
    event.state === 'tripped'
      ? [
          act.create(
            auditLane,
            { category: event.group, rate: event.rate.value ?? 0, samples: event.rate.samples },
            `audit-${event.group}`
          ),
          act.remember(lessonJournal, {
            text: `When drafting for ${event.group}, recall the stricter phrasing`,
            because: `approvals fell to ${event.rate.value ?? 0} over ${event.rate.samples} samples`,
            when: { roles: [draftRole], facets: [category.of(event.group)] },
            status: 'candidate',
          }),
        ]
      : act.move(auditLane, `audit-${event.group}`, 'audit-cancelled')
);

const modelErrorRate = (metrics: Metrics) =>
  metrics.rate({
    hours: 1,
    among: { entry: 'invocation', status: 'ended', mode: 'model' },
    count: { entry: 'invocation', status: 'ended', mode: 'model', ok: false },
  });

const errorBrake = H.trigger(
  'model-error-brake',
  H.on.metric(modelErrorRate, { trip: { above: 0.2 }, reset: { below: 0.05 }, minSamples: 20 }),
  (event, act) => (event.state === 'tripped' ? act.pause(conversationsLane) : act.resume(conversationsLane))
);

const slaBreach = H.trigger(
  'sla-breach',
  H.on.deadline(conversation, data => new Date(data.slaDue), ['new', 'classifying']),
  (event, act) => [
    act.create(
      escalationLane,
      { conversation: event.unit.key, customer: event.unit.data.customer, reason: 'SLA breached' },
      `escalation-${event.unit.key}`
    ),
    act.move('escalated'),
  ]
);

export default H.harness('support')
  .ledger(ledger('/srv/support/ledger.sqlite'))
  .lanes(conversationsLane, escalationLane, auditLane)
  .pools(H.pool('support-api-pool', [{ account: api, share: 1 }]))
  .triggers(approvalWatch, errorBrake, slaBreach)
  .clients(
    supervisor({
      grants: [
        H.ops.readWork,
        H.ops.writeWork,
        H.ops.resolve(approval, auditFindings, escalationHandled),
        H.ops.readMemory,
        H.ops.writeMemory,
        H.ops.curateMemory,
        H.ops.readTelemetry,
      ],
    }),
    control({ port: 7490, token: H.env('SUPPORT_CONTROL_TOKEN'), grants: [H.ops.readWork, H.ops.readTelemetry] })
  )
  .observers(board('/srv/support/BOARD.md'), telemetry('/srv/support/TELEMETRY.md'));
