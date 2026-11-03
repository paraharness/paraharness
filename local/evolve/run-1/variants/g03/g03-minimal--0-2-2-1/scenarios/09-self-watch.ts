import { z } from 'zod';
import { H, type Metrics, type PendingView, type SupplyOf, type Trigger } from 'harness-dsl';
import * as anthropic from 'harness-dsl/anthropic';
import * as http from 'harness-dsl/http';
import * as sqlite from 'harness-dsl/sqlite';
import * as jsonl from 'harness-dsl/jsonl';
import * as shell from 'harness-dsl/shell';
import * as claudeCode from 'harness-dsl/claude-code';
import * as markdown from 'harness-dsl/markdown';

const conversationData = z.object({
  customer: z.string(),
  subject: z.string(),
  lastMessage: z.string(),
  category: z.string(),
  slaDueAt: z.string(),
});

const conversationNew = H.state('conversation-new', 'pending');
const conversationClassifying = H.state('conversation-classifying', 'active');
const conversationDrafting = H.state('conversation-drafting', 'active');
const conversationAwaitingApproval = H.state('conversation-awaiting-approval', 'active');
const conversationSent = H.state('conversation-sent', 'terminal', 'success');
const conversationClosed = H.state('conversation-closed-by-customer', 'terminal', 'neutral');
const conversationEscalated = H.state('conversation-escalated', 'terminal', 'failure');

const conversation = H.kind('conversation')
  .data(conversationData)
  .states(conversationNew, conversationClassifying, conversationDrafting, conversationAwaitingApproval, conversationSent, conversationClosed, conversationEscalated)
  .failsTo('conversation-escalated');

const categoryTag = H.tag('category');

const classifierRole = H.role('classifier')
  .input(z.object({ subject: z.string(), lastMessage: z.string() }))
  .output(z.object({ category: z.string() }))
  .prompt((c) => `Classify this support conversation into one category.\n\n${c.subject}\n\n${c.lastMessage}`);

const drafterRole = H.role('drafter')
  .input(z.object({ subject: z.string(), lastMessage: z.string(), category: z.string() }))
  .output(z.object({ reply: z.string() }))
  .prompt((c) => `Draft a reply for a ${c.category} conversation.\n\n${c.subject}\n\n${c.lastMessage}`);

const tone = H.library('reply-taste', H.memory('reply-taste', 'taste'), jsonl.memory('memory/reply-taste.jsonl'));
const drafterLessons = H.library('drafting-experience', H.memory('drafting-lessons', 'experience'), jsonl.memory('memory/drafting-experience.jsonl'));

const haiku = anthropic.model('claude-haiku-4-5');
const sonnet = anthropic.model('claude-sonnet-4-5');

const classifier = H.agent('classifier', classifierRole).model(haiku);
const drafter = H.agent('drafter', drafterRole).model(sonnet).recalls(tone, drafterLessons);

const approval = H.halt('reply-approval', z.object({
  action: z.enum(['approve', 'reject']),
  reply: z.string(),
}));

const safeCategory = H.policy.rule('safe-category', (category: string, metrics: Metrics) => {
  const approvals = metrics.rateBy({
    among: approval.resolved(),
    count: approval.resolved({ action: 'approve' }),
    by: categoryTag,
  }).get(category);
  return approvals.samples >= 200 && approvals.hits === approvals.samples;
});

const local = shell.local('local', { slots: 4 });

const sendReply = H.command('send-reply')
  .input(z.object({ conversation: z.string(), reply: z.string() }))
  .argv((r) => ['helpdesk', 'reply', '--conversation', r.conversation, '--body', r.reply])
  .on(local);

const handleConversation = H.flow('handle-conversation').for(conversation).does(async (ctx) => {
  await ctx.move('conversation-classifying');
  const { subject, lastMessage } = ctx.unit.data;
  const classified = await ctx.run(classifier, { subject, lastMessage });
  if (!classified.ok) return ctx.fail(classified.error);
  const category = classified.value.category;
  ctx.tag(categoryTag, category);
  await ctx.update({ category });
  await ctx.move('conversation-drafting');
  const drafted = await ctx.run(drafter, { subject, lastMessage, category }, { scope: { resources: [category] } });
  if (!drafted.ok) return ctx.fail(drafted.error);
  let reply = drafted.value.reply;
  const safe = await ctx.decide(safeCategory, category);
  if (!safe) {
    await ctx.move('conversation-awaiting-approval');
    const review = await ctx.halt(approval, drafted.value.reply);
    if (review.action === 'reject') return 'conversation-escalated';
    reply = review.reply;
  }
  const sent = await ctx.run(sendReply, { conversation: ctx.unit.key, reply });
  if (!sent.ok) return ctx.fail(sent.error);
  return 'conversation-sent';
});

const helpdeskEvent = z.object({
  conversation: z.string(),
  type: z.enum(['opened', 'customer-replied', 'closed']),
  customer: z.string(),
  subject: z.string(),
  message: z.string(),
  slaDueAt: z.string(),
});
type HelpdeskEvent = z.infer<typeof helpdeskEvent>;

const fromHelpdesk = (e: HelpdeskEvent): SupplyOf<typeof conversation> => {
  if (e.type === 'closed') return { update: e.conversation, state: 'conversation-closed-by-customer' };
  if (e.type === 'customer-replied') return { update: e.conversation, patch: { lastMessage: e.message }, state: 'conversation-new' };
  return {
    create: { customer: e.customer, subject: e.subject, lastMessage: e.message, category: 'unclassified', slaDueAt: e.slaDueAt },
    key: e.conversation,
  };
};

const helpdeskHook = http.webhook(conversation, {
  path: '/helpdesk',
  secret: H.env('HELPDESK_WEBHOOK_SECRET'),
  body: helpdeskEvent,
  read: fromHelpdesk,
});

const helpdeskPoll = http.poll(conversation, {
  url: 'https://helpdesk.example.com/api/events?missed=true',
  every: { minutes: 10 },
  headers: { authorization: H.env('HELPDESK_TOKEN') },
  body: z.object({ events: z.array(helpdeskEvent) }),
  read: (body) => body.events.map(fromHelpdesk),
});

const helpdeskStore = http.store(conversation, {
  url: 'https://helpdesk.example.com/api/conversations',
  headers: { authorization: H.env('HELPDESK_TOKEN') },
  stateField: 'harness_state',
});

const conversations = H.lane('conversations', conversation)
  .handler(handleConversation)
  .suppliers(helpdeskHook, helpdeskPoll)
  .store(helpdeskStore)
  .maxUsdPerUnit(0.4);

const slaBreach = H.trigger(
  'sla-breach',
  H.on.deadline(conversation, (c) => new Date(c.slaDueAt), ['conversation-new', 'conversation-classifying', 'conversation-drafting', 'conversation-awaiting-approval']),
  (_event, act) => act.move('conversation-escalated')
);

const auditData = z.object({ category: z.string(), rateAtOpen: z.number() });

const auditOpen = H.state('audit-open', 'pending');
const auditReviewing = H.state('audit-reviewing', 'active');
const auditClosed = H.state('audit-closed', 'terminal', 'success');
const auditRecovered = H.state('audit-recovered', 'terminal', 'neutral');

const audit = H.kind('audit').data(auditData).states(auditOpen, auditReviewing, auditClosed, auditRecovered);

const auditFindings = H.halt('audit-findings', z.object({ findings: z.string() }));

const auditBrief = H.policy.rule('audit-brief', (query: { readonly category: string; readonly now: Date }, metrics: Metrics) => {
  const since = new Date(Date.UTC(query.now.getUTCFullYear(), query.now.getUTCMonth(), 1));
  const openedThisMonth = metrics.rateBy({
    among: { entry: 'firing', trigger: approvalWatch, status: 'tripped' },
    count: { entry: 'firing', trigger: approvalWatch, status: 'tripped' },
    by: 'trigger-group',
    since,
  }).get(query.category).samples;
  const pausedMsThisMonth = metrics.sum({
    of: 'durationMs',
    among: { entry: 'lane', lane: conversations, status: 'resumed' },
    since,
  }).value ?? 0;
  return { openedThisMonth, pausedMsThisMonth };
});

const auditCategory = H.flow('audit-category').for(audit).does(async (ctx) => {
  await ctx.move('audit-reviewing');
  const { category, rateAtOpen } = ctx.unit.data;
  const brief = await ctx.decide(auditBrief, { category, now: ctx.now() });
  await ctx.halt(
    auditFindings,
    `Approval rate for ${category} fell to ${rateAtOpen}. Audits opened for ${category} this month: ${brief.openedThisMonth}. Conversations lane paused this month: ${Math.round(brief.pausedMsThisMonth / 60_000)} min.`
  );
  return 'audit-closed';
});

const audits = H.lane('audits', audit)
  .handler(auditCategory)
  .store(sqlite.store(audit, 'support.db'));

const approvalWatch: Trigger = H.trigger(
  'approval-rate-watch',
  H.on.metric(
    (metrics) => metrics.rateBy({
      among: approval.resolved(),
      count: approval.resolved({ action: 'approve' }),
      by: categoryTag,
      days: 7,
    }),
    { trip: { below: 0.9 }, reset: { above: 0.95 }, minSamples: 50 }
  ),
  (event, act) =>
    event.state === 'tripped'
      ? [
          act.create(audits, { category: event.group, rateAtOpen: event.rate.value ?? 0 }, `audit-${event.group}`),
          act.remember(drafterLessons, {
            text: `When drafting for ${event.group}, recall the stricter phrasing`,
            because: `approvals fell to ${event.rate.value ?? 0} over ${event.rate.samples} reviews`,
            when: { roles: [drafterRole], resources: [event.group] },
            status: 'candidate',
          }),
        ]
      : act.move(audits, `audit-${event.group}`, 'audit-recovered')
);

const modelErrorWatch = H.trigger(
  'model-error-watch',
  H.on.metric(
    (metrics) => metrics.rate({
      among: { entry: 'invocation', status: 'ended', mode: 'model' },
      count: { entry: 'invocation', status: 'ended', mode: 'model', ok: false },
      hours: 1,
    }),
    { trip: { above: 0.2 }, reset: { below: 0.05 }, minSamples: 20 }
  ),
  (event, act) => (event.state === 'tripped' ? act.pause(conversations) : act.resume(conversations))
);

const timeToBreach = (unit: PendingView) =>
  unit.is(conversation) ? new Date(unit.data.slaDueAt).getTime() : Number.MAX_SAFE_INTEGER;

const byTimeToBreach = H.policy.scheduler('time-to-breach', ({ pending }) => ({
  start: [...pending].sort((x, y) => timeToBreach(x) - timeToBreach(y)),
}));

const api = anthropic.account('anthropic-api', { apiKey: H.env('ANTHROPIC_API_KEY') });
const pool = H.pool('anthropic', [{ account: api, share: 1 }]);

export const harness = H.harness('support-self-watch')
  .ledger(sqlite.ledger('support-ledger.db'))
  .lanes(conversations, audits)
  .pools(pool)
  .triggers(slaBreach, approvalWatch, modelErrorWatch)
  .scheduler(byTimeToBreach)
  .clients(claudeCode.supervisor({
    grants: [
      H.ops.readWork,
      H.ops.writeWork,
      H.ops.resolveHalts,
      H.ops.readMemory,
      H.ops.writeMemory,
      H.ops.curateMemory,
      H.ops.readTelemetry,
    ],
  }))
  .observers(markdown.board('BOARD.md'), markdown.telemetry('TELEMETRY.md'));
