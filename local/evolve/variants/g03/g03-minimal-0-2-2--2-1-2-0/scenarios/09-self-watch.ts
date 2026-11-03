import { z } from 'zod';
import { H } from 'harness-dsl';
import type { PendingView } from 'harness-dsl';
import * as anthropic from 'harness-dsl/anthropic';
import * as claude from 'harness-dsl/claude-code';
import * as sqlite from 'harness-dsl/sqlite';
import * as jsonl from 'harness-dsl/jsonl';
import * as shell from 'harness-dsl/shell';
import * as http from 'harness-dsl/http';
import * as markdown from 'harness-dsl/markdown';

const categoryValues = z.enum(['billing', 'shipping', 'refund', 'other']);
type Category = z.infer<typeof categoryValues>;
const category = H.facet('category', categoryValues);

const local = shell.local('local', { slots: 4 });
const haiku = anthropic.model('claude-haiku-4-5');
const sonnet = anthropic.model('claude-sonnet-4-5');
const helpdeskHeaders = { authorization: H.env('HELPDESK_TOKEN') };

const ranked = H.policy.recall('ranked', view => view.ranked.slice(0, 8));
const taste = H.journal('support-taste', H.memory('taste', 'taste'), jsonl.memory('/srv/support/taste.jsonl'), ranked);
const experience = H.journal('support-experience', H.memory('experience', 'experience'), jsonl.memory('/srv/support/experience.jsonl'), ranked);

const fresh = H.state('new', 'pending');
const classifying = H.state('classifying', 'pending');
const sent = H.state('sent', 'terminal', 'success');
const closed = H.state('closed-by-customer', 'terminal', 'success');
const escalated = H.state('escalated', 'terminal', 'failure');
const conversation = H.kind('Conversation')
  .data(
    z.object({
      subject: z.string(),
      message: z.string(),
      customer: z.string(),
      slaDueAt: z.string(),
      category: categoryValues.optional(),
    })
  )
  .states(fresh, classifying, sent, closed, escalated);

const escalationOpen = H.state('open', 'pending');
const handled = H.state('handled', 'terminal', 'success');
const abandoned = H.state('abandoned', 'terminal', 'failure');
const escalation = H.kind('Escalation')
  .data(z.object({ conversation: z.string(), subject: z.string() }))
  .states(escalationOpen, handled, abandoned);

const auditOpen = H.state('audit-open', 'pending');
const auditClosed = H.state('audit-closed', 'terminal', 'success');
const auditCancelled = H.state('audit-cancelled', 'terminal', 'neutral');
const audit = H.kind('Audit')
  .data(z.object({ category: categoryValues, rate: z.number() }))
  .states(auditOpen, auditClosed, auditCancelled);

const drafterRole = H.role('drafter')
  .input(z.object({ message: z.string(), category: categoryValues }))
  .output(z.object({ reply: z.string() }))
  .prompt(input => `Draft a reply for a ${input.category} conversation:\n${input.message}`);

const classifier = H.seat(
  'classifier',
  H.role('classifier')
    .input(z.object({ subject: z.string(), message: z.string() }))
    .output(z.object({ category: categoryValues }))
    .prompt(input => `Classify: ${input.subject}\n${input.message}`)
).model(haiku);
const drafter = H.seat('drafter', drafterRole).model(sonnet).recalls(taste, experience);

const approval = H.halt('reply-approval', z.object({ approved: z.boolean(), edited: z.string().optional() }))
  .about(z.object({ category: categoryValues, draft: z.string() }))
  .policy('safe-category', view => {
    const facets = [category.of(view.about.category)];
    const record = view.metrics.rate({
      among: { ...view.resolved(), resolver: 'human', facets },
      count: { ...view.resolved({ approved: true }), resolver: 'human', facets },
    });
    return record.samples >= 200 && record.hits === record.samples ? { approved: true } : null;
  });
const escalationHandled = H.halt('escalation-handled', z.object({ outcome: z.string() }));
const auditDone = H.halt('audit-done', z.object({ findings: z.string() }));

const sendReply = H.command('send-reply')
  .input(z.object({ conversation: z.string(), body: z.string() }))
  .argv(input => ['helpdesk', 'reply', input.conversation, '--body', input.body])
  .on(local)
  .recovery('park');

const converse = H.flow('converse').for(conversation).does(async ctx => {
  const classified = await ctx.run(classifier, { subject: ctx.unit.data.subject, message: ctx.unit.data.message });
  if (!classified.ok) return ctx.fail(classified);
  const chosen = classified.value.category;
  await ctx.update({ category: chosen });
  const drafted = await ctx.run(drafter, { message: ctx.unit.data.message, category: chosen });
  if (!drafted.ok) return ctx.fail(drafted);
  const decision = await ctx.halt(approval, `Reply to ${ctx.unit.data.customer}`, { category: chosen, draft: drafted.value.reply });
  if (!decision.approved) return 'classifying';
  const delivered = await ctx.run(sendReply, { conversation: ctx.unit.key, body: decision.edited ?? drafted.value.reply });
  if (!delivered.ok) return ctx.fail(delivered);
  return 'sent';
});

const helpdeskEvent = z.object({
  type: z.enum(['created', 'replied', 'closed']),
  id: z.string(),
  subject: z.string(),
  message: z.string(),
  customer: z.string(),
  slaDueAt: z.string(),
});

const conversations = H.lane('conversations', conversation)
  .handler(converse)
  .retries(2, 'escalated', { first: { minutes: 1 }, factor: 2 })
  .suppliers(
    http.webhook(conversation, {
      path: '/helpdesk',
      secret: H.env('HELPDESK_WEBHOOK_SECRET'),
      body: helpdeskEvent,
      read: body =>
        body.type === 'created'
          ? {
              create: { subject: body.subject, message: body.message, customer: body.customer, slaDueAt: body.slaDueAt },
              key: body.id,
            }
          : body.type === 'replied'
            ? { update: body.id, patch: { message: body.message }, state: 'classifying' }
            : { update: body.id, state: 'closed-by-customer' },
    }),
    http.poll(conversation, {
      url: 'https://helpdesk.example.com/api/conversations?status=open',
      every: { minutes: 10 },
      headers: helpdeskHeaders,
      body: z.object({ conversations: z.array(helpdeskEvent) }),
      read: body =>
        body.conversations.map(item => ({
          create: { subject: item.subject, message: item.message, customer: item.customer, slaDueAt: item.slaDueAt },
          key: item.id,
        })),
    })
  )
  .store(http.store(conversation, { url: 'https://helpdesk.example.com/api/conversations', headers: helpdeskHeaders, stateField: 'harness_state' }))
  .maxUsdPerUnit(0.4)
  .facet(category, data => data.category);

const handleEscalation = H.flow('handle-escalation').for(escalation).does(async ctx => {
  await ctx.halt(escalationHandled, `Escalated: ${ctx.unit.data.subject}`);
  return 'handled';
});

const escalations = H.lane('escalations', escalation).handler(handleEscalation).retries(1, 'abandoned');

const startOfMonth = (now: Date): Date => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));

export const auditsOpened = H.policy.rule('audits-opened-per-category', z.object({ since: z.date() }), (input, metrics) => {
  const opened = (value: Category): number =>
    metrics.count({ since: input.since, of: { entry: 'transition', kind: audit, state: 'audit-open', facets: [category.of(value)] } });
  return { billing: opened('billing'), shipping: opened('shipping'), refund: opened('refund'), other: opened('other') };
});

export const lanePausedMs = H.policy.rule('conversations-paused-ms', z.object({ since: z.date() }), (input, metrics) =>
  metrics.sum({ of: 'durationMs', among: { entry: 'lane', lane: conversations, status: 'resumed' }, since: input.since })
);

const reviewAudit = H.flow('review-audit').for(audit).does(async ctx => {
  const since = startOfMonth(ctx.now());
  const opened = await ctx.decide(auditsOpened, { since });
  const paused = await ctx.decide(lanePausedMs, { since });
  await ctx.halt(
    auditDone,
    `Approval audit for ${ctx.unit.data.category} at ${ctx.unit.data.rate}: ${opened[ctx.unit.data.category]} audits this month, lane paused ${paused.value ?? 0} ms`
  );
  return 'audit-closed';
});

const audits = H.lane('audits', audit)
  .handler(reviewAudit)
  .retries(1, 'audit-cancelled')
  .facet(category, data => data.category);

const slaBreach = H.trigger(
  'sla-breach-escalates',
  H.on.deadline(conversation, data => new Date(data.slaDueAt), ['new', 'classifying']),
  (event, act) => [
    act.create(escalations, { conversation: event.unit.key, subject: event.unit.data.subject }, `escalation-${event.unit.key}`),
    act.move('escalated'),
  ]
);

const approvalWatch = H.trigger(
  'approval-rate-watch',
  H.on.metric(
    metrics =>
      metrics.rateBy({
        days: 7,
        among: { ...approval.resolved(), resolver: 'human' },
        count: { ...approval.resolved({ approved: true }), resolver: 'human' },
        by: category,
      }),
    { trip: { below: 0.9 }, reset: { above: 0.95 }, minSamples: 50 }
  ),
  (event, act) =>
    event.state === 'tripped'
      ? [
          act.create(audits, { category: event.group, rate: event.rate.value ?? 0 }, `audit-${event.group}`),
          act.remember(experience, {
            text: `When drafting for ${event.group}, recall the stricter phrasing`,
            because: `approvals fell to ${event.rate.value ?? 0} over ${event.rate.samples} samples`,
            when: { roles: [drafterRole], facets: [category.of(event.group)] },
            status: 'candidate',
          }),
        ]
      : act.move(audits, `audit-${event.group}`, 'audit-cancelled')
);

const modelErrorWatch = H.trigger(
  'model-error-pause',
  H.on.metric(
    metrics =>
      metrics.rate({
        hours: 1,
        among: { entry: 'invocation', mode: ['model', 'batch'], status: 'ended' },
        count: { entry: 'invocation', mode: ['model', 'batch'], status: 'ended', ok: false },
      }),
    { trip: { above: 0.2 }, reset: { below: 0.05 }, minSamples: 20 }
  ),
  (event, act) => (event.state === 'tripped' ? act.pause(conversations) : act.resume(conversations))
);

const timeToBreach = H.policy.scheduler('time-to-breach', view => {
  const breachInMs = (unit: PendingView): number =>
    unit.is(conversation) ? new Date(unit.data.slaDueAt).getTime() - view.now.getTime() : Number.MIN_SAFE_INTEGER;
  return { start: [...view.pending].sort((a, b) => breachInMs(a) - breachInMs(b)) };
});

export const harness = H.harness('support')
  .ledger(sqlite.ledger('/srv/support/ledger.sqlite'))
  .lanes(conversations, escalations, audits)
  .pools(H.pool('api', [{ account: anthropic.account('api', { apiKey: H.env('ANTHROPIC_API_KEY') }), share: 1 }]))
  .triggers(slaBreach, approvalWatch, modelErrorWatch)
  .scheduler(timeToBreach)
  .clients(
    claude.supervisor({
      grants: [
        H.ops.readWork,
        H.ops.writeWork,
        H.ops.resolve(approval, escalationHandled, auditDone),
        H.ops.writeMemory,
        H.ops.curateMemory,
        H.ops.readTelemetry,
      ],
    })
  )
  .observers(markdown.board('/srv/support/BOARD.md'), markdown.telemetry('/srv/support/TELEMETRY.md'));
