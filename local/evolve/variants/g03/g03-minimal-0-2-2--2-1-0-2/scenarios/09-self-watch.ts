import { z } from 'zod';
import { H, type PendingView, type SupplyOf } from 'harness-dsl';
import * as anthropic from 'harness-dsl/anthropic';
import * as claudeCode from 'harness-dsl/claude-code';
import * as sqlite from 'harness-dsl/sqlite';
import * as jsonl from 'harness-dsl/jsonl';
import * as shell from 'harness-dsl/shell';
import * as http from 'harness-dsl/http';
import * as markdown from 'harness-dsl/markdown';

const haiku = anthropic.model('claude-haiku-4-5');
const sonnet = anthropic.model('claude-sonnet-4-5');
const api = anthropic.account('support-api', { apiKey: H.env('ANTHROPIC_API_KEY'), serves: [haiku, sonnet] });

const local = shell.local('local', { slots: 4 });

const categoryValues = z.enum(['billing', 'shipping', 'refund', 'other']);
type CategoryValue = z.infer<typeof categoryValues>;
const category = H.facet('category', categoryValues);

const fresh = H.state('new', 'pending');
const sent = H.state('sent', 'waiting');
const closed = H.state('closed-by-customer', 'terminal', 'success');
const escalated = H.state('escalated', 'terminal', 'failure');

const conversation = H.kind('conversation')
  .data(z.object({ lastMessage: z.string(), slaDue: z.string(), category: categoryValues.optional() }))
  .states(fresh, sent, closed, escalated);

const auditOpen = H.state('audit-open', 'pending');
const auditDone = H.state('audit-done', 'terminal', 'success');
const auditCancelled = H.state('audit-cancelled', 'terminal', 'neutral');
const auditAbandoned = H.state('audit-abandoned', 'terminal', 'failure');

const audit = H.kind('audit')
  .data(z.object({ category: categoryValues, rate: z.number() }))
  .states(auditOpen, auditDone, auditCancelled, auditAbandoned);

const escalationOpen = H.state('escalation-open', 'pending');
const escalationHandled = H.state('escalation-handled', 'terminal', 'success');
const escalationAbandoned = H.state('escalation-abandoned', 'terminal', 'failure');

const escalation = H.kind('escalation')
  .data(z.object({ conversation: z.string(), reason: z.string() }))
  .states(escalationOpen, escalationHandled, escalationAbandoned);

const tasteMemory = H.memory('reply-taste', 'taste');
const experienceMemory = H.memory('reply-experience', 'experience');
const taste = H.journal('reply-taste-journal', tasteMemory, jsonl.memory('.harness/taste.jsonl'));
const experience = H.journal('reply-experience-journal', experienceMemory, jsonl.memory('.harness/experience.jsonl'));

const classifyRole = H.role('classify')
  .input(z.object({ message: z.string() }))
  .output(z.object({ category: categoryValues }))
  .prompt(i => `Classify this customer message: ${i.message}`);

const draftRole = H.role('draft-reply')
  .input(z.object({ message: z.string(), category: categoryValues }))
  .output(z.object({ reply: z.string() }))
  .prompt(i => `Draft a reply for a ${i.category} conversation: ${i.message}`);

const classifier = H.seat('classifier', classifyRole).model(haiku);
const drafter = H.seat('drafter', draftRole).model(sonnet).recalls(taste, experience);

const approvalAbout = z.object({ category: categoryValues, draft: z.string() });
type ApprovalAbout = z.infer<typeof approvalAbout>;
const approvalDecision = z.object({ approved: z.boolean(), edited: z.string().optional() });

const approvalQuestion = H.halt('reply-approval', approvalDecision).about(approvalAbout);

const safeCategory = H.policy.rule('safe-category-approval', (about: ApprovalAbout, metrics) => {
  const facets = [category.of(about.category)];
  const approved = metrics.count({ of: { ...approvalQuestion.resolved({ approved: true }), resolver: 'human', facets } });
  const rejected = metrics.count({ of: { ...approvalQuestion.resolved({ approved: false }), facets } });
  return approved >= 200 && rejected === 0 ? { approved: true } : null;
});

const replyApproval = approvalQuestion.policy(safeCategory);

const sendReply = H.command('send-reply')
  .input(z.object({ conversation: z.string(), body: z.string() }))
  .argv(i => ['helpdesk-reply', '--conversation', i.conversation, '--body', i.body])
  .on(local)
  .recovery('park');

const handleConversation = H.flow('handle-conversation')
  .for(conversation)
  .does(async ctx => {
    const classified = await ctx.run(classifier, { message: ctx.unit.data.lastMessage });
    if (!classified.ok) return ctx.fail(classified.error);
    await ctx.update({ category: classified.value.category });
    const drafted = await ctx.run(drafter, { message: ctx.unit.data.lastMessage, category: classified.value.category });
    if (!drafted.ok) return ctx.fail(drafted.error);
    const decision = await ctx.halt(replyApproval, drafted.value.reply, { category: classified.value.category, draft: drafted.value.reply });
    if (!decision.approved) return ctx.fail('reply rejected by the reviewer');
    const delivered = await ctx.run(sendReply, { conversation: ctx.unit.key, body: decision.edited ?? drafted.value.reply });
    return delivered.ok ? 'sent' : ctx.fail(delivered.error);
  });

const helpdeskHeaders = { authorization: H.env('HELPDESK_TOKEN') };

const helpdeskWebhook = http.webhook(conversation, {
  path: '/helpdesk',
  secret: H.env('HELPDESK_WEBHOOK_SECRET'),
  body: z.object({ event: z.enum(['created', 'replied', 'closed']), conversation: z.string(), message: z.string(), slaDue: z.string() }),
  read: body =>
    body.event === 'created'
      ? { create: { lastMessage: body.message, slaDue: body.slaDue }, key: body.conversation }
      : body.event === 'replied'
        ? { update: body.conversation, patch: { lastMessage: body.message }, state: 'new', cancels: ['waiting'] }
        : { update: body.conversation, state: 'closed-by-customer' },
});

const helpdeskPoll = http.poll(conversation, {
  url: 'https://helpdesk.example.com/api/conversations?status=open',
  every: { minutes: 10 },
  headers: helpdeskHeaders,
  body: z.object({ conversations: z.array(z.object({ id: z.string(), message: z.string(), slaDue: z.string() })) }),
  read: body => body.conversations.map((c): SupplyOf<typeof conversation> => ({ create: { lastMessage: c.message, slaDue: c.slaDue }, key: c.id })),
});

const conversations = H.lane('conversations', conversation)
  .handler(handleConversation)
  .retries(2, { backoff: { first: { minutes: 1 }, factor: 2 }, exhausted: 'escalated' })
  .suppliers(helpdeskWebhook, helpdeskPoll)
  .store(http.store(conversation, { url: 'https://helpdesk.example.com/api/conversations', headers: helpdeskHeaders, stateField: 'status' }))
  .maxUsdPerUnit(0.4)
  .facet(category, d => d.category);

const auditFindings = H.halt('audit-findings', z.object({ findings: z.string() }))
  .about(z.object({ category: categoryValues, rate: z.number(), auditsThisMonth: z.number(), pausedMinutes: z.number() }));

const auditContext = H.policy.rule('audit-context', (input: { readonly category: CategoryValue }, metrics) => {
  const auditsThisMonth = metrics.count({
    of: { entry: 'transition', kind: audit, state: 'audit-open', facets: [category.of(input.category)] },
    days: 30,
  });
  const paused = metrics.sum({ of: 'durationMs', among: { entry: 'lane', status: 'resumed', lane: conversations }, days: 30 });
  return { auditsThisMonth, pausedMinutes: (paused.value ?? 0) / 60000 };
});

const runAudit = H.flow('run-audit')
  .for(audit)
  .does(async ctx => {
    const context = await ctx.decide(auditContext, { category: ctx.unit.data.category });
    await ctx.halt(auditFindings, `Approval rate for ${ctx.unit.data.category} fell to ${ctx.unit.data.rate}`, {
      category: ctx.unit.data.category,
      rate: ctx.unit.data.rate,
      auditsThisMonth: context.auditsThisMonth,
      pausedMinutes: context.pausedMinutes,
    });
    return 'audit-done';
  });

const audits = H.lane('audits', audit)
  .handler(runAudit)
  .retries(0, { exhausted: 'audit-abandoned' })
  .facet(category, d => d.category);

const escalationResolution = H.halt('escalation-resolution', z.object({ note: z.string() }));

const handleEscalation = H.flow('handle-escalation')
  .for(escalation)
  .does(async ctx => {
    await ctx.halt(escalationResolution, `Conversation ${ctx.unit.data.conversation}: ${ctx.unit.data.reason}`);
    return 'escalation-handled';
  });

const escalations = H.lane('escalations', escalation)
  .handler(handleEscalation)
  .retries(0, { exhausted: 'escalation-abandoned' });

const approvalWatch = H.trigger(
  'approval-rate-watch',
  H.on.metric(
    m => m.rateBy({ among: replyApproval.resolved(), count: replyApproval.resolved({ approved: true }), days: 7, by: category }),
    { trip: { below: 0.9 }, reset: { above: 0.95 }, minSamples: 50 }
  ),
  (event, act) =>
    event.state === 'tripped'
      ? [
          act.create(audits, { category: event.group, rate: event.rate.value ?? 0 }, `audit-${event.group}`),
          act.remember(experience, {
            text: `When drafting for ${event.group}, recall the stricter phrasing`,
            because: `approvals fell to ${event.rate.value ?? 0} over ${event.rate.samples} samples`,
            when: { roles: [draftRole], facets: [category.of(event.group)] },
            status: 'candidate',
          }),
        ]
      : act.move(audits, `audit-${event.group}`, 'audit-cancelled')
);

const errorRateWatch = H.trigger(
  'model-error-rate-watch',
  H.on.metric(
    m => m.rate({
      among: { entry: 'invocation', status: 'ended', mode: ['model', 'batch'] },
      count: { entry: 'invocation', status: 'ended', mode: ['model', 'batch'], ok: false },
      hours: 1,
    }),
    { trip: { above: 0.2 }, reset: { below: 0.05 }, minSamples: 20 }
  ),
  (event, act) => (event.state === 'tripped' ? act.pause(conversations) : act.resume(conversations))
);

const slaBreach = H.trigger('sla-breach', H.on.deadline(conversation, d => new Date(d.slaDue), ['new']), (event, act) => [
  act.move('escalated'),
  act.create(escalations, { conversation: event.unit.key, reason: 'SLA breached' }, `escalation-${event.unit.key}`),
]);

const timeToBreach = (unit: PendingView): number => {
  if (unit.is(audit) || unit.is(escalation)) return Number.MIN_SAFE_INTEGER;
  if (unit.is(conversation)) return Date.parse(unit.data.slaDue);
  return Number.MAX_SAFE_INTEGER;
};

export default H.harness('support')
  .ledger(sqlite.ledger('.harness/ledger.db'))
  .lanes(conversations, audits, escalations)
  .pools(H.pool('support-api', [{ account: api, share: 1 }]))
  .triggers(approvalWatch, errorRateWatch, slaBreach)
  .scheduler(H.policy.scheduler('time-to-breach', view => ({ start: [...view.pending].sort((a, b) => timeToBreach(a) - timeToBreach(b)) })))
  .clients(claudeCode.supervisor({
    grants: [
      H.ops.readWork, H.ops.writeWork, H.ops.resolve(replyApproval, auditFindings, escalationResolution),
      H.ops.readMemory, H.ops.writeMemory, H.ops.curateMemory, H.ops.readTelemetry,
    ],
  }))
  .observers(markdown.board('.harness/board.md'), markdown.telemetry('.harness/telemetry.md'));
