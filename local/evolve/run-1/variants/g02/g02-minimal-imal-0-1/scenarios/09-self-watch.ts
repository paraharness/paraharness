import { z } from 'zod';
import { H } from 'harness-dsl';
import type { Metrics, PendingView, Rate, SupplyOf } from 'harness-dsl';
import type { EntryFilter } from 'harness-dsl/kernel';
import * as anthropic from 'harness-dsl/anthropic';
import * as claudeCode from 'harness-dsl/claude-code';
import * as http from 'harness-dsl/http';
import * as jsonl from 'harness-dsl/jsonl';
import * as shell from 'harness-dsl/shell';
import * as sqlite from 'harness-dsl/sqlite';
import * as markdown from 'harness-dsl/markdown';

const categorySchema = z.enum(['billing', 'shipping', 'returns', 'account', 'other']);
const conversationCategorySchema = z.enum(['billing', 'shipping', 'returns', 'account', 'other', 'unclassified']);

const queued = H.state('queued', 'pending');
const sent = H.state('sent', { terminal: 'success' });
const escalated = H.state('escalated', { terminal: 'failure' });
const closedByCustomer = H.state('closed-by-customer', { terminal: 'neutral' });

const Conversation = H.kind('conversation')
  .data(z.object({
    customer: z.string(),
    subject: z.string(),
    message: z.string(),
    category: conversationCategorySchema,
    slaDue: z.string(),
  }))
  .states([queued, sent, escalated, closedByCustomer], 'queued')
  .failsTo('escalated');

type ConversationSupply = SupplyOf<typeof Conversation>;

const auditOpen = H.state('audit-open', 'pending');
const auditResolved = H.state('audit-resolved', { terminal: 'success' });
const auditWithdrawn = H.state('audit-withdrawn', { terminal: 'neutral' });

const Audit = H.kind('audit')
  .data(z.object({ category: z.string() }))
  .states([auditOpen, auditResolved, auditWithdrawn], 'audit-open');

const taste = H.memory('support-taste', 'owner');
const experience = H.memory('support-experience', 'fallible');
const tasteLibrary = H.library('support-taste', taste, jsonl.memory('memory/taste.jsonl'));
const experienceLibrary = H.library('support-experience', experience, jsonl.memory('memory/experience.jsonl'));

const classifierRole = H.role('classifier')
  .input(z.object({ subject: z.string(), message: z.string() }))
  .output(z.object({ category: categorySchema }))
  .prompt(c => `Classify this support conversation.\n\nSubject: ${c.subject}\n\n${c.message}`);

const drafterRole = H.role('drafter')
  .input(z.object({ customer: z.string(), message: z.string(), category: categorySchema }))
  .output(z.object({ reply: z.string() }))
  .prompt(c => `Draft a reply to ${c.customer} about a ${c.category} question.\n\n${c.message}`);

const classifier = H.agent('classifier', classifierRole).model(anthropic.model('claude-haiku-4-5'));
const drafter = H.agent('drafter', drafterRole)
  .model(anthropic.model('claude-sonnet-4-5'))
  .recalls(tasteLibrary, experienceLibrary);

const helpdeskHeaders = { Authorization: H.env('HELPDESK_TOKEN') };
const helpdeskBox = shell.local('helpdesk-box', { slots: 4 });

const sendReply = H.command('send-reply')
  .input(z.object({ conversation: z.string(), reply: z.string() }))
  .argv(input => ['helpdesk-reply', input.conversation, input.reply])
  .on(helpdeskBox);

const approvalHalts: EntryFilter = { entry: 'halt', halt: 'reply-approval', status: 'resolved' };
const approvedReplies: EntryFilter = { ...approvalHalts, decision: { approved: true } };

const safeToSend = H.policy.rule('safe-to-send', (category: string, metrics: Metrics) => {
  const record = metrics.rate({
    among: { ...approvalHalts, tags: { category } },
    count: { ...approvedReplies, tags: { category } },
  });
  return record.samples >= 200 && record.hits === record.samples;
});

const handleConversation = H.flow('handle-conversation').for(Conversation).does(async ctx => {
  const conversation = ctx.unit.data;
  const classified = await ctx.run(classifier, { subject: conversation.subject, message: conversation.message });
  if (classified.ok === false) return ctx.fail(classified.error);
  const category = classified.value.category;
  await ctx.update({ category });
  ctx.tag({ category });

  const draft = await ctx.run(
    drafter,
    { customer: conversation.customer, message: conversation.message, category },
    { scope: { skills: [category] } },
  );
  if (draft.ok === false) return ctx.fail(draft.error);

  let reply = draft.value.reply;
  const autoSend = await ctx.decide(safeToSend, category);
  if (autoSend === false) {
    const decision = await ctx.halt({
      name: 'reply-approval',
      show: reply,
      decision: z.object({ approved: z.boolean(), reply: z.string() }),
    });
    if (decision.approved === false) return 'escalated';
    reply = decision.reply;
  }

  const delivered = await ctx.run(sendReply, { conversation: ctx.unit.key, reply });
  if (delivered.ok === false) return ctx.fail(delivered.error);
  return 'sent';
});

const messageBody = z.object({
  conversationId: z.string(),
  customer: z.string(),
  subject: z.string(),
  message: z.string(),
  slaDue: z.string(),
  isReply: z.boolean(),
});

function freshConversation(body: z.infer<typeof messageBody>): ConversationSupply {
  return {
    create: {
      customer: body.customer,
      subject: body.subject,
      message: body.message,
      category: 'unclassified',
      slaDue: body.slaDue,
    },
    key: body.conversationId,
  };
}

const helpdeskWebhook = http.webhook(Conversation, {
  path: '/hooks/helpdesk',
  secret: H.env('HELPDESK_WEBHOOK_SECRET'),
  body: messageBody,
  read: (body): ConversationSupply | null => body.isReply
    ? { update: body.conversationId, patch: { message: body.message }, state: 'queued' }
    : freshConversation(body),
});

const helpdeskPoll = http.poll(Conversation, {
  url: 'https://helpdesk.example.com/api/conversations?status=open',
  every: { minutes: 15 },
  headers: helpdeskHeaders,
  body: z.object({ conversations: z.array(messageBody) }),
  read: (body): readonly ConversationSupply[] => body.conversations.map(freshConversation),
});

const conversations = H.lane('conversations', Conversation)
  .handler(handleConversation)
  .suppliers(helpdeskWebhook, helpdeskPoll)
  .store(http.store(Conversation, { url: 'https://helpdesk.example.com/api/conversations', headers: helpdeskHeaders, stateField: 'status' }))
  .wip(6)
  .maxUsdPerUnit(0.4);

const selfWatchReport = H.policy.rule(
  'self-watch-report',
  (input: { readonly category: string; readonly since: Date }, metrics: Metrics) => {
    const opened = metrics.sum({
      of: 'entries',
      among: { entry: 'transition', kind: 'audit', state: 'audit-open', cause: 'trigger', tags: { category: input.category } },
      since: input.since,
    });
    const paused = metrics.sum({
      of: 'durationMs',
      among: { entry: 'lane', lane: 'conversations', status: 'resumed' },
      since: input.since,
    });
    return { auditsOpened: opened.value ?? 0, pausedMs: paused.value ?? 0 };
  },
);

const reviewAudit = H.flow('review-audit').for(Audit).does(async ctx => {
  const category = ctx.unit.data.category;
  const now = ctx.now();
  const report = await ctx.decide(selfWatchReport, { category, since: new Date(now.getFullYear(), now.getMonth(), 1) });
  const finding = await ctx.halt({
    name: 'audit-review',
    show: `Approval rate for ${category} fell. Audits opened for ${category} this month: ${report.auditsOpened}. Conversations lane paused this month: ${Math.round(report.pausedMs / 60000)} minutes.`,
    decision: z.object({ lesson: z.string(), because: z.string() }),
  });
  await ctx.remember(experienceLibrary, {
    text: finding.lesson,
    because: finding.because,
    when: { roles: [drafterRole], skills: [category] },
    status: 'accepted',
  });
  return 'audit-resolved';
});

const audits = H.lane('audits', Audit).handler(reviewAudit);

function describe(rate: Rate): string {
  return rate.value === null
    ? `no value over ${rate.samples} samples`
    : `${rate.value.toFixed(3)} over ${rate.samples} samples`;
}

const approvalWatch = H.trigger(
  'approval-rate-watch',
  H.on.threshold({
    measure: metrics => metrics.rateBy({ among: approvalHalts, count: approvedReplies, by: { tag: 'category' }, days: 7 }),
    crosses: { below: 0.9 },
    recovers: { above: 0.95 },
    minSamples: 50,
  }),
  (event, act) => event.phase === 'crossed'
    ? [
        act.create(audits, { category: event.group }, `audit-${event.group}`, { category: event.group }),
        act.remember(experienceLibrary, {
          text: `When drafting for ${event.group}, recall the stricter phrasing`,
          because: `approvals fell to ${describe(event.rate)}`,
          when: { roles: [drafterRole], skills: [event.group] },
          status: 'candidate',
        }),
      ]
    : act.move(audits, `audit-${event.group}`, 'audit-withdrawn'),
);

const modelInvocations: EntryFilter = { entry: 'invocation', lane: 'conversations', mode: ['live', 'batch'], status: 'ended' };

const modelErrorWatch = H.trigger(
  'model-error-watch',
  H.on.threshold({
    measure: metrics => ({
      conversations: metrics.rate({ among: modelInvocations, count: { ...modelInvocations, ok: false }, hours: 1 }),
    }),
    crosses: { above: 0.2 },
    recovers: { below: 0.05 },
    minSamples: 20,
  }),
  (event, act) => event.phase === 'crossed'
    ? act.pause(conversations, `model error rate ${describe(event.rate)} in the last hour`)
    : act.resume(conversations, `model error rate recovered to ${describe(event.rate)}`),
);

const slaBreach = H.trigger(
  'sla-breach',
  H.on.deadline(Conversation, data => new Date(data.slaDue), ['queued']),
  (_event, act) => act.move('escalated'),
);

function urgency(unit: PendingView): number {
  if (unit.is(Audit)) return 0;
  if (unit.is(Conversation)) return Date.parse(unit.data.slaDue);
  return Number.MAX_SAFE_INTEGER;
}

const auditsThenSoonestBreach = H.policy.scheduler('audits-then-soonest-breach', view => ({
  start: [...view.pending].sort((x, y) => urgency(x) - urgency(y)),
}));

const supportApi = anthropic.account('support-api', { apiKey: H.env('ANTHROPIC_API_KEY') });

const firstEligible = H.policy.account('first-eligible', choice => {
  const [first] = choice.accounts.filter(view => view.eligible);
  return first ? first.account : null;
});

export const supportSelfWatch = H.harness('support')
  .ledger(sqlite.ledger('support-ledger.db'))
  .lanes(conversations, audits)
  .pools(H.pool('support-api', [{ account: supportApi, share: 1 }], firstEligible))
  .triggers(approvalWatch, modelErrorWatch, slaBreach)
  .scheduler(auditsThenSoonestBreach)
  .clients(claudeCode.supervisor({
    grants: [H.ops.readWork, H.ops.writeWork, H.ops.resolveHalts, H.ops.readMemory, H.ops.writeMemory, H.ops.readTelemetry],
  }))
  .observers(markdown.board('BOARD.md'), markdown.telemetry('TELEMETRY.md'));
