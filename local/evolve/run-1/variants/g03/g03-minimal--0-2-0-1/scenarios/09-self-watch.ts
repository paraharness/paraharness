import { H } from 'harness-dsl';
import type { Metrics, PendingView } from 'harness-dsl';
import * as anthropic from 'harness-dsl/anthropic';
import * as cc from 'harness-dsl/claude-code';
import * as http from 'harness-dsl/http';
import * as sqlite from 'harness-dsl/sqlite';
import * as jsonl from 'harness-dsl/jsonl';
import * as shell from 'harness-dsl/shell';
import * as markdown from 'harness-dsl/markdown';
import { z } from 'zod';

const category = H.tag('category');

const fresh = H.state('new', 'pending');
const classifying = H.state('classifying', 'pending');
const drafting = H.state('drafting', 'active');
const awaitingApproval = H.state('awaiting-approval', 'active');
const sent = H.state('sent', 'waiting');
const closedByCustomer = H.state('closed-by-customer', 'terminal', 'success');
const escalated = H.state('escalated', 'terminal', 'failure');

const Conversation = H.kind('conversation')
  .data(z.object({ customer: z.string(), latest: z.string(), category: z.string().optional(), slaDueAt: z.string() }))
  .states(fresh, classifying, drafting, awaitingApproval, sent, closedByCustomer, escalated)
  .failsTo('escalated', 'classifying');

const queued = H.state('queued', 'pending');
const handling = H.state('handling', 'active');
const resolved = H.state('resolved', 'terminal', 'success');

const Escalation = H.kind('escalation')
  .data(z.object({ conversation: z.string(), reason: z.string() }))
  .states(queued, handling, resolved);

const auditOpen = H.state('audit-open', 'pending');
const auditing = H.state('auditing', 'active');
const auditClosed = H.state('audit-closed', 'terminal', 'success');
const auditWithdrawn = H.state('audit-withdrawn', 'terminal', 'neutral');

const Audit = H.kind('audit')
  .data(z.object({ category: z.string(), rate: z.number() }))
  .states(auditOpen, auditing, auditClosed, auditWithdrawn);

const taste = H.archive('support-taste', H.memory('support-taste', 'taste'), jsonl.memory('./.harness/taste.jsonl'));
const experience = H.archive('support-experience', H.memory('support-experience', 'experience'), jsonl.memory('./.harness/experience.jsonl'));
const drafterBriefing = H.briefing('drafter-briefing', [taste, experience]);

const classifierRole = H.role('classifier')
  .input(z.object({ message: z.string() }))
  .output(z.object({ category: z.string() }))
  .prompt(m => `Classify this customer message into one support category:\n${m.message}`);
const drafterRole = H.role('drafter')
  .input(z.object({ customer: z.string(), category: z.string(), message: z.string() }))
  .output(z.object({ reply: z.string() }))
  .prompt(m => `Draft a reply to ${m.customer} about a ${m.category} issue:\n${m.message}`);

const classifier = H.agent('classifier', classifierRole).model(anthropic.model('claude-haiku-4-5'));
const drafter = H.agent('drafter', drafterRole).model(anthropic.model('claude-sonnet-4-5')).recalls(drafterBriefing);

const approval = H.halt('reply-approval', z.object({
  approved: z.boolean(),
  editedReply: z.string().optional(),
  tasteNote: z.string().optional(),
}));
const escalationResolution = H.halt('escalation-resolution', z.object({ note: z.string() }));
const auditFinding = H.halt('audit-finding', z.object({ finding: z.string() }));

const safeCategory = H.policy.rule('safe-category', (name: string, metrics: Metrics): boolean => {
  const scope = [category.is(name)];
  const record = metrics.rate({
    among: { ...approval.resolved(), tags: scope },
    count: { ...approval.resolved({ approved: true }), tags: scope },
    days: 3650,
  });
  return record.samples >= 200 && record.hits === record.samples;
});

const local = shell.local('local', { slots: 4 });
const helpdeskHeaders = { authorization: H.env('HELPDESK_TOKEN') };

const sendReply = H.command('send-reply')
  .input(z.object({ conversation: z.string(), text: z.string() }))
  .argv(r => ['helpdesk-reply', '--conversation', r.conversation, '--text', r.text])
  .on(local)
  .recovers('park');

const conversationFlow = H.flow('triage-and-reply').for(Conversation).does(async ctx => {
  const conversation = ctx.unit.data;
  const classified = await ctx.run(classifier, { message: conversation.latest });
  if (!classified.ok) return ctx.fail(classified.error);
  const cat = classified.value.category;
  await ctx.update({ category: cat });
  await ctx.tag(category, cat);

  await ctx.move('drafting');
  const draft = await ctx.run(
    drafter,
    { customer: conversation.customer, category: cat, message: conversation.latest },
    { scope: { tags: [category.is(cat)] } }
  );
  if (!draft.ok) return ctx.fail(draft.error);

  let reply = draft.value.reply;
  const safe = await ctx.decide(safeCategory, cat);
  if (!safe) {
    await ctx.move('awaiting-approval');
    const decision = await ctx.halt(approval, reply);
    if (decision.tasteNote) {
      await ctx.remember(taste, { text: decision.tasteNote, when: { roles: [drafterRole] }, status: 'candidate' });
    }
    if (!decision.approved) return ctx.fail('reply rejected by reviewer', 'classifying');
    reply = decision.editedReply ?? reply;
  }

  const posted = await ctx.run(sendReply, { conversation: ctx.unit.key, text: reply });
  if (!posted.ok) return ctx.fail(posted.error);
  return 'sent';
});

const escalationFlow = H.flow('human-escalation').for(Escalation).does(async ctx => {
  await ctx.move('handling');
  await ctx.halt(escalationResolution, `Conversation ${ctx.unit.data.conversation}: ${ctx.unit.data.reason}`);
  return 'resolved';
});

interface ReportInput {
  readonly category: string;
  readonly since: Date;
}

const selfWatchReport = H.policy.rule('self-watch-report', (input: ReportInput, metrics: Metrics): string => {
  const opened = metrics.countBy({ among: { entry: 'transition', kind: Audit, state: auditOpen }, by: category, since: input.since });
  const paused = metrics.sum({ of: 'durationMs', among: { entry: 'lane', lane: conversations, status: 'resumed' }, since: input.since });
  const thisCategory = opened[input.category]?.value ?? 0;
  return `${thisCategory} audits opened for ${input.category} this month; conversations lane paused ${Math.round(paused.value / 60000)} minutes over ${paused.samples} pauses.`;
});

function monthStart(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

const auditFlow = H.flow('human-audit').for(Audit).does(async ctx => {
  await ctx.move('auditing');
  const audit = ctx.unit.data;
  const report = await ctx.decide(selfWatchReport, { category: audit.category, since: monthStart(await ctx.now()) });
  await ctx.halt(auditFinding, `Approval rate for ${audit.category} fell to ${audit.rate.toFixed(2)}. ${report}`);
  return 'audit-closed';
});

const helpdeskEvents = http.webhook(Conversation, {
  path: '/helpdesk',
  secret: H.env('HELPDESK_WEBHOOK_SECRET'),
  body: z.object({
    type: z.enum(['created', 'replied', 'closed']),
    id: z.string(),
    customer: z.string(),
    message: z.string(),
    slaDueAt: z.string(),
  }),
  read: b =>
    b.type === 'created'
      ? { create: { customer: b.customer, latest: b.message, slaDueAt: b.slaDueAt }, key: b.id }
      : b.type === 'replied'
        ? { update: b.id, patch: { latest: b.message }, state: 'classifying' }
        : { update: b.id, state: 'closed-by-customer' },
});

const helpdeskPoll = http.poll(Conversation, {
  url: 'https://helpdesk.example.com/api/conversations?status=open',
  every: { minutes: 10 },
  headers: helpdeskHeaders,
  body: z.object({
    conversations: z.array(z.object({ id: z.string(), customer: z.string(), message: z.string(), slaDueAt: z.string() })),
  }),
  read: b => b.conversations.map(c => ({ create: { customer: c.customer, latest: c.message, slaDueAt: c.slaDueAt }, key: c.id })),
});

const conversations = H.lane('conversations', Conversation)
  .handler(conversationFlow)
  .suppliers(helpdeskEvents, helpdeskPoll)
  .store(http.store(Conversation, { url: 'https://helpdesk.example.com/api/conversations', headers: helpdeskHeaders, stateField: 'harness_state' }))
  .maxUsdPerUnit(0.4);
const escalations = H.lane('escalations', Escalation).handler(escalationFlow);
const audits = H.lane('audits', Audit).handler(auditFlow);

const slaBreach = H.trigger(
  'sla-breach-escalates',
  H.on.deadline(Conversation, c => new Date(c.slaDueAt), ['new', 'classifying', 'drafting', 'awaiting-approval']),
  (event, act) => [
    act.move('escalated'),
    act.create(escalations, { conversation: event.unit.key, reason: 'SLA breached' }, `escalation-${event.unit.key}`),
  ]
);

const approvalSlump = H.trigger(
  'approval-slump-opens-audit',
  H.on.metric(
    m => m.rateBy({ among: approval.resolved(), count: approval.resolved({ approved: true }), by: category, days: 7 }),
    { trip: { below: 0.9 }, reset: { above: 0.95 }, minSamples: 50, group: category }
  ),
  (event, act) =>
    event.state === 'tripped'
      ? [
          act.create(audits, { category: event.group, rate: event.rate.value ?? 0 }, `audit-${event.group}`),
          act.remember(experience, {
            text: `when drafting for ${event.group}, recall the stricter phrasing`,
            because: `approvals fell to ${(event.rate.value ?? 0).toFixed(2)} over ${event.rate.samples} samples`,
            when: { roles: [drafterRole], tags: [category.is(event.group)] },
            status: 'candidate',
          }),
        ]
      : act.move(audits, `audit-${event.group}`, 'audit-withdrawn')
);

const modelErrors = H.trigger(
  'model-errors-pause-conversations',
  H.on.metric(
    m => m.rate({
      among: { entry: 'invocation', mode: 'model', status: 'ended' },
      count: { entry: 'invocation', mode: 'model', status: 'ended', ok: false },
      hours: 1,
    }),
    { trip: { above: 0.2 }, reset: { below: 0.05 }, minSamples: 20 }
  ),
  (event, act) => (event.state === 'tripped' ? act.pause(conversations) : act.resume(conversations))
);

const breachAt = (p: PendingView): number => (p.is(Conversation) ? Date.parse(p.data.slaDueAt) : 0);

const timeToBreach = H.policy.scheduler('time-to-breach', view => ({
  start: [...view.pending].sort((x, y) => breachAt(x) - breachAt(y)),
}));

const pool = H.pool('anthropic', [{ account: anthropic.account('support', { apiKey: H.env('ANTHROPIC_API_KEY') }), share: 1 }]);

const reviewer = cc.supervisor({
  grants: [H.ops.readWork, H.ops.writeWork, H.ops.resolveHalts, H.ops.readMemory, H.ops.writeMemory, H.ops.curateMemory, H.ops.readTelemetry],
});

export const harness = H.harness('support-triage')
  .ledger(sqlite.ledger('./.harness/ledger.sqlite'))
  .lanes(conversations, escalations, audits)
  .pools(pool)
  .triggers(slaBreach, approvalSlump, modelErrors)
  .scheduler(timeToBreach)
  .clients(reviewer)
  .observers(markdown.board('./BOARD.md'), markdown.telemetry('./TELEMETRY.md'));

export const running = harness.start();
