import { z } from 'zod';
import { H } from 'harness-dsl';
import * as anthropic from 'harness-dsl/anthropic';
import * as claudeCode from 'harness-dsl/claude-code';
import * as http from 'harness-dsl/http';
import * as jsonl from 'harness-dsl/jsonl';
import * as markdown from 'harness-dsl/markdown';
import * as shell from 'harness-dsl/shell';
import * as sqlite from 'harness-dsl/sqlite';

const category = H.tag('category');
const local = shell.local('local', { slots: 4 });
const haiku = anthropic.model('claude-haiku-4-5');
const sonnet = anthropic.model('claude-sonnet-4-5');

const newMessage = H.state('new', 'pending');
const classifying = H.state('classifying', 'active');
const drafting = H.state('drafting', 'active');
const awaitingApproval = H.state('awaiting-approval', 'active');
const sent = H.state('sent', 'terminal', 'success');
const closedByCustomer = H.state('closed-by-customer', 'terminal', 'neutral');
const escalated = H.state('escalated', 'terminal', 'failure');

const Conversation = H.kind('conversation')
  .data(z.object({ customer: z.string(), subject: z.string(), lastMessage: z.string(), slaDueAt: z.string() }))
  .states(newMessage, classifying, drafting, awaitingApproval, sent, closedByCustomer, escalated);

const open = H.state('open', 'pending');
const inReview = H.state('in-review', 'active');
const resolved = H.state('resolved', 'terminal', 'success');
const withdrawn = H.state('withdrawn', 'terminal', 'neutral');

const Escalation = H.kind('escalation').data(z.object({ conversation: z.string(), reason: z.string() })).states(open, inReview, resolved);
const Audit = H.kind('audit').data(z.object({ category: z.string(), rate: z.number() })).states(open, inReview, resolved, withdrawn);

const tone = H.memory('reply-taste', 'taste');
const lessons = H.memory('drafting-experience', 'experience');
const replyTaste = H.library('reply-taste', tone, jsonl.memory('memory/taste.jsonl'));
const drafterLessons = H.library('drafter-lessons', lessons, jsonl.memory('memory/experience.jsonl'));

const classifierRole = H.role('classifier')
  .input(z.object({ subject: z.string(), message: z.string() }))
  .output(z.object({ category: z.string() }))
  .prompt(input => `Classify this support message.\nSubject: ${input.subject}\n${input.message}`)
  .intents(['read']);

const drafterRole = H.role('drafter')
  .input(z.object({ customer: z.string(), category: z.string(), message: z.string() }))
  .output(z.object({ reply: z.string() }))
  .prompt(input => `Draft a ${input.category} reply to ${input.customer}:\n${input.message}`)
  .intents(['read']);

const classifier = H.agent('classifier', classifierRole).model(haiku);
const drafter = H.agent('drafter', drafterRole).model(sonnet).recalls(replyTaste, drafterLessons);

const replyApproval = H.halt('reply-approval', z.object({ approved: z.boolean(), reply: z.string() }));
const auditFinding = H.halt('audit-finding', z.object({ note: z.string() }));
const escalationHandled = H.halt('escalation-handled', z.object({ note: z.string() }));

const approvals = replyApproval.resolved();
const approved = replyApproval.resolved({ approved: true });

const safeCategory = H.policy.rule('safe-category')
  .input(z.object({ category: z.string() }))
  .decides((input, metrics) => {
    const record = metrics.rateBy({ among: approvals, count: approved, by: category, days: 365 }).get(input.category);
    return record.samples >= 200 && record.hits === record.samples;
  });

const sendReply = H.command('send-reply')
  .input(z.object({ conversation: z.string(), reply: z.string() }))
  .argv(input => ['helpdesk-send', '--conversation', input.conversation, '--body', input.reply])
  .on(local)
  .recovery('park');

const conversationFlow = H.flow('conversation').for(Conversation).does(async ctx => {
  const { customer, subject, lastMessage } = ctx.unit.data;
  await ctx.move('classifying');
  const classified = await ctx.run(classifier, { subject, message: lastMessage });
  if (!classified.ok) return ctx.fail(classified.error);
  const conversationCategory = classified.value.category;
  ctx.tag(category, conversationCategory);

  await ctx.move('drafting');
  const drafted = await ctx.run(drafter, { customer, category: conversationCategory, message: lastMessage }, { scope: { skills: [conversationCategory] } });
  if (!drafted.ok) return ctx.fail(drafted.error);

  let reply = drafted.value.reply;
  const safe = await ctx.decide(safeCategory, { category: conversationCategory });
  if (!safe) {
    await ctx.move('awaiting-approval');
    const review = await ctx.halt(replyApproval, reply);
    reply = review.reply;
  }
  const delivered = await ctx.run(sendReply, { conversation: ctx.unit.key, reply });
  if (!delivered.ok) return ctx.fail(delivered.error);
  return 'sent';
});

const auditFlow = H.flow('audit').for(Audit).does(async ctx => {
  await ctx.move('in-review');
  await ctx.halt(auditFinding, `Approval rate for ${ctx.unit.data.category} fell to ${ctx.unit.data.rate.toFixed(2)}. Review recent drafts and record findings.`);
  return 'resolved';
});

const escalationFlow = H.flow('escalation').for(Escalation).does(async ctx => {
  await ctx.move('in-review');
  await ctx.halt(escalationHandled, `Conversation ${ctx.unit.data.conversation}: ${ctx.unit.data.reason}`);
  return 'resolved';
});

const helpdeskHeaders = { authorization: H.env('HELPDESK_TOKEN') };

const helpdeskWebhook = http.webhook(Conversation, {
  path: '/helpdesk',
  secret: H.env('HELPDESK_WEBHOOK_SECRET'),
  body: z.object({
    event: z.enum(['opened', 'replied', 'closed']),
    conversationId: z.string(),
    customer: z.string(),
    subject: z.string(),
    message: z.string(),
    slaDueAt: z.string(),
  }),
  read: body =>
    body.event === 'opened'
      ? Conversation.create({ customer: body.customer, subject: body.subject, lastMessage: body.message, slaDueAt: body.slaDueAt }, body.conversationId)
      : body.event === 'replied'
        ? Conversation.update(body.conversationId, { patch: { lastMessage: body.message }, state: 'new' })
        : Conversation.update(body.conversationId, { state: 'closed-by-customer' }),
});

const helpdeskStore = http.store(Conversation, {
  url: 'https://helpdesk.example.com/api/conversations',
  headers: helpdeskHeaders,
  stateField: 'harness_state',
});

const conversations = H.lane('conversations', Conversation)
  .handler(conversationFlow)
  .suppliers(helpdeskWebhook)
  .store(helpdeskStore)
  .maxUsdPerUnit(0.4);

const escalations = H.lane('escalations', Escalation).handler(escalationFlow).store(sqlite.store(Escalation, 'state/support.sqlite'));
const audits = H.lane('audits', Audit).handler(auditFlow).store(sqlite.store(Audit, 'state/support.sqlite'));

const slaBreach = H.trigger(
  'sla-breach',
  H.on.deadline(Conversation, data => new Date(data.slaDueAt), ['new', 'classifying', 'drafting', 'awaiting-approval']),
  (event, act) => [
    act.create(escalations, { conversation: event.unit.key, reason: `SLA breached at ${event.at.toISOString()}` }, `escalation-${event.unit.key}`),
    act.move('escalated'),
  ],
);

const approvalAudit = H.trigger(
  'approval-audit',
  H.on.metric(
    metrics => metrics.rateBy({ among: approvals, count: approved, by: category, days: 7 }),
    { trip: { below: 0.9 }, reset: { above: 0.95 }, minSamples: 50 },
  ),
  (event, act) => {
    const key = `audit-${event.group}-${event.crossing}`;
    if (event.state === 'reset') return act.move(audits, key, 'withdrawn');
    const rate = (event.rate.value ?? 0).toFixed(2);
    return [
      act.create(audits, { category: event.group, rate: event.rate.value ?? 0 }, key),
      act.remember(drafterLessons, {
        text: `when drafting for ${event.group}, recall the stricter phrasing`,
        because: `approvals fell to ${rate} over ${event.rate.samples} samples`,
        when: { roles: [drafterRole], skills: [event.group] },
        status: 'candidate',
      }),
    ];
  },
);

const modelErrorBrake = H.trigger(
  'model-error-brake',
  H.on.metric(
    metrics => metrics.rate({ among: H.modelInvocations(), count: H.modelInvocations({ ok: false }), hours: 1 }),
    { trip: { above: 0.2 }, reset: { below: 0.05 }, minSamples: 20 },
  ),
  (event, act) => (event.state === 'tripped' ? act.pause(conversations) : act.resume(conversations)),
);

const scheduler = H.policy.scheduler('breach-first', ({ now, pending, metrics }) => {
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const pausedMsThisMonth = metrics.sum({ of: 'durationMs', among: conversations.pauses(), since: monthStart }).value ?? 0;
  const auditQueue = pending
    .flatMap(unit => (unit.is(Audit) ? [unit] : []))
    .sort((x, y) =>
      metrics.count({ among: approvalAudit.tripped().where(category, y.data.category), since: monthStart })
      - metrics.count({ among: approvalAudit.tripped().where(category, x.data.category), since: monthStart }));
  const conversationQueue = pending
    .flatMap(unit => (unit.is(Conversation) ? [unit] : []))
    .sort((x, y) => Date.parse(x.data.slaDueAt) - Date.parse(y.data.slaDueAt));
  const escalationQueue = pending.flatMap(unit => (unit.is(Escalation) ? [unit] : []));
  const laneUnhealthy = pausedMsThisMonth > 4 * 3_600_000;
  return {
    start: laneUnhealthy
      ? [...escalationQueue, ...auditQueue, ...conversationQueue]
      : [...escalationQueue, ...conversationQueue, ...auditQueue],
  };
});

const pool = H.pool('api', [{ account: anthropic.account('anthropic-api', { apiKey: H.env('ANTHROPIC_API_KEY') }), share: 1 }]);

export const harness = H.harness('support-self-watch')
  .ledger(sqlite.ledger('state/ledger.sqlite'))
  .lanes(conversations, escalations, audits)
  .pools(pool)
  .triggers(slaBreach, approvalAudit, modelErrorBrake)
  .scheduler(scheduler)
  .clients(claudeCode.supervisor({
    grants: [H.ops.readWork, H.ops.writeWork, H.ops.resolveHalts, H.ops.readMemory, H.ops.writeMemory, H.ops.curateMemory, H.ops.readTelemetry],
  }))
  .observers(markdown.board('BOARD.md'), markdown.telemetry('TELEMETRY.md'));
