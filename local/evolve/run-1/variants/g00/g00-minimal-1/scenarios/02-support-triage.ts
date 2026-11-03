import { z } from 'zod';
import { H } from 'harness-dsl';
import type { MemoryItem, RecallContext, UnitView } from 'harness-dsl';
import { anthropic } from 'harness-dsl/anthropic';
import { claudeCode } from 'harness-dsl/claude-code';
import { sqlite } from 'harness-dsl/sqlite';
import { jsonl } from 'harness-dsl/jsonl';
import { zendesk } from 'harness-dsl/zendesk';
import { shell } from 'harness-dsl/shell';
import { markdown } from 'harness-dsl/markdown';

const ConversationData = z.object({
  ticketId: z.string(),
  customer: z.string(),
  subject: z.string(),
  message: z.string(),
  receivedAt: z.string(),
  slaMinutes: z.number(),
});

const Conversation = H.kind('Conversation', {
  data: ConversationData,
  states: {
    new: 'pending',
    classifying: 'active',
    drafting: 'active',
    awaitingApproval: 'active',
    sent: 'succeeded',
    closedByCustomer: 'concluded',
    escalated: 'failed',
  },
  initial: 'new',
});

const Escalation = H.kind('Escalation', {
  data: z.object({ ticketId: z.string(), customer: z.string(), reason: z.string() }),
  states: { open: 'pending', handling: 'active', handedOver: 'succeeded', unresolved: 'failed', dropped: 'cancelled' },
  initial: 'open',
});

const subdomain = 'acme';
const helpdeskToken = H.env('ZENDESK_TOKEN');

const helpdesk = zendesk.tickets(Conversation, {
  subdomain,
  token: helpdeskToken,
  pollMinutes: 10,
  statuses: {
    new: 'new',
    classifying: 'open',
    drafting: 'open',
    awaitingApproval: 'pending',
    sent: 'solved',
    closedByCustomer: 'closed',
    escalated: 'hold',
  },
  map: (ticket) => ({
    ticketId: ticket.id,
    customer: ticket.requester,
    subject: ticket.subject,
    message: ticket.latestMessage,
    receivedAt: ticket.createdAt,
    slaMinutes: 240,
  }),
});

const helpdeskPush = zendesk.webhook(Conversation, {
  path: '/zendesk',
  port: H.slot.port(8601),
  secret: H.env('ZENDESK_WEBHOOK_SECRET'),
  map: (ticket) => ({
    ticketId: ticket.id,
    customer: ticket.requester,
    subject: ticket.subject,
    message: ticket.latestMessage,
    receivedAt: ticket.createdAt,
    slaMinutes: 240,
  }),
});

const api = anthropic.account({ name: 'support-api', key: H.env('ANTHROPIC_API_KEY') });
const haiku = anthropic.model({ name: 'haiku', id: 'claude-haiku-4-5', account: api, price: { inputUsdPerMTok: 1, outputUsdPerMTok: 5 } });
const sonnet = anthropic.model({ name: 'sonnet', id: 'claude-sonnet-4-5', account: api, price: { inputUsdPerMTok: 3, outputUsdPerMTok: 15 } });

const classifier = H.role('classifier', { instructions: 'Classify the conversation into one category.', intents: ['read'] });
const drafter = H.role('drafter', { instructions: 'Draft the reply in the house tone, citing policy where it applies.', intents: ['read'] });

const Classification = z.object({
  category: z.enum(['billing', 'refund', 'bug', 'howto', 'account', 'other']),
  urgent: z.boolean(),
});
const DraftReply = z.object({ reply: z.string() });
const Approval = z.object({ approved: z.boolean(), body: z.string() });

const approvalByCategory = H.metric('approval-by-category', {
  on: 'halt',
  select: z.object({
    step: z.literal('approval'),
    decision: z.object({ approved: z.boolean() }),
    out: z.object({ classify: z.object({ category: z.string() }) }),
  }),
  success: (event) => event.decision.approved,
  key: (event) => event.out.classify.category,
});

const approvalByModel = H.metric('approval-by-model', {
  on: 'halt',
  select: z.object({
    step: z.literal('approval'),
    decision: z.object({ approved: z.boolean() }),
    cast: z.object({ drafter: z.string() }),
  }),
  success: (event) => event.decision.approved,
  key: (event) => event.cast.drafter,
});

const conversationFlow = H.flow('conversation', { kinds: [Conversation] })
  .mark('classifying')
  .step('classify', (ctx) =>
    H.ask(classifier, { prompt: `${ctx.unit.data.subject}\n\n${ctx.unit.data.message}`, output: Classification, budgetTokens: 2000 }),
  )
  .loop(
    'review',
    3,
    (round) =>
      round
        .mark('drafting')
        .step('draft', (ctx) =>
          H.ask(drafter, {
            prompt: `Category: ${ctx.out.classify.category}. Customer ${ctx.unit.data.customer} wrote:\n${ctx.unit.data.message}`,
            output: DraftReply,
            budgetTokens: 8000,
          }),
        )
        .mark('awaitingApproval')
        .halt('approval', {
          question: (ctx) => `Approve or edit this reply to ${ctx.unit.data.customer}:\n\n${ctx.out.draft.reply}`,
          decision: Approval,
          unless: (ctx) => {
            const record = ctx.metrics.rate(approvalByCategory, { key: ctx.out.classify.category });
            return record.samples >= 200 && record.value === 1;
          },
        }),
    (ctx) => ctx.out.approval === undefined || ctx.out.approval.approved,
  )
  .end((ctx) => (ctx.out.review.satisfied ? undefined : 'escalated'), { note: () => 'three drafts were rejected' })
  .step('send', (ctx) =>
    zendesk.reply({
      subdomain,
      token: helpdeskToken,
      ticketId: ctx.unit.data.ticketId,
      body: ctx.out.review.last.approval?.body ?? ctx.out.review.last.draft.reply,
    }),
  )
  .end('sent');

const slaDue = (unit: UnitView<z.infer<typeof ConversationData>>) =>
  new Date(Date.parse(unit.data.receivedAt) + unit.data.slaMinutes * 60_000);

const conversationLane = H.lane(Conversation)
  .from(helpdeskPush, helpdesk)
  .store(helpdesk)
  .handle(conversationFlow)
  .cast({ classifier: haiku, drafter: sonnet })
  .states({
    classifying: 'classifying',
    drafting: 'drafting',
    awaitingApproval: 'awaitingApproval',
    sent: 'sent',
    escalated: 'escalated',
    failed: 'new',
    cancelled: 'classifying',
  })
  .deadline(slaDue)
  .maxUsd(0.4, { onExceed: 'halt' })
  .runOn(shell.local({ name: 'support', slots: 8 }));

const escalationFlow = H.flow('escalation', { kinds: [Escalation] })
  .mark('handling')
  .halt('takeover', {
    question: (ctx) => `Conversation ${ctx.unit.data.ticketId} with ${ctx.unit.data.customer} needs a human: ${ctx.unit.data.reason}`,
    decision: z.object({ owner: z.string(), resolution: z.string() }),
  })
  .end((ctx) => (ctx.out.takeover === undefined ? 'unresolved' : 'handedOver'));

const escalationLane = H.lane(Escalation)
  .handle(escalationFlow)
  .states({ handling: 'handling', handedOver: 'handedOver', unresolved: 'unresolved', failed: 'unresolved', cancelled: 'dropped' })
  .runOn(shell.local({ name: 'escalations', slots: 2 }));

const slaBreachEscalates = H.trigger(
  'sla-breach-escalates',
  H.when.overdue(Conversation, { in: ['new', 'classifying', 'drafting', 'awaitingApproval'], at: slaDue }),
  (then) => [
    then.cancel('escalated'),
    then.create(escalationLane, (event) => ({
      key: `escalation-${event.unit.data.ticketId}`,
      data: {
        ticketId: event.unit.data.ticketId,
        customer: event.unit.data.customer,
        reason: `SLA breached at ${event.dueAt.toISOString()}`,
      },
    })),
  ],
);

const customerReplyRestarts = H.trigger(
  'customer-reply-restarts-classification',
  H.when.updated(Conversation, { in: ['awaitingApproval'] }).where((event) => event.unit.data.message !== event.previous.message),
  (then) => then.cancel('classifying'),
);

const within = (allowed: readonly string[] | undefined, present: readonly string[]) =>
  allowed === undefined || allowed.length === 0 || allowed.some((entry) => present.includes(entry));

const applies = (item: MemoryItem, ctx: RecallContext) =>
  item.status === 'active' &&
  within(item.when.kinds, [ctx.scope.kind]) &&
  within(item.when.roles, [ctx.scope.role]) &&
  within(item.when.tags, ctx.scope.tags);

const Taste = H.memory('taste', { stance: 'taste' });
const Experience = H.memory('experience', { stance: 'experience' });

const tasteJournal = H.journal('support-taste', Taste, jsonl.memory({ path: '.harness/taste.jsonl' }))
  .recall(
    H.policy.recall('taste-most-specific', async (ctx) =>
      (await ctx.items()).filter((item) => applies(item, ctx)).sort((a, b) => ctx.specificity(b) - ctx.specificity(a)).slice(0, ctx.limit),
    ),
  )
  .recalledBy(drafter)
  .recordedBy(H.operator);

const experienceJournal = H.journal('support-experience', Experience, jsonl.memory({ path: '.harness/experience.jsonl' }))
  .recall(
    H.policy.recall('experience-specific-then-proven', async (ctx) =>
      (await ctx.items())
        .filter((item) => applies(item, ctx))
        .sort((a, b) => ctx.specificity(b) - ctx.specificity(a) || ctx.trackRecord(b).value - ctx.trackRecord(a).value)
        .slice(0, ctx.limit),
    ),
  )
  .recalledBy(drafter)
  .recordedBy(H.operator);

const timeToBreach = H.policy.order('time-to-breach', (ctx) => ({
  order: [...ctx.pending].sort((a, b) => {
    const escalationFirst = Number(b.kind === Escalation.name) - Number(a.kind === Escalation.name);
    const dueA = a.deadline?.getTime() ?? Number.POSITIVE_INFINITY;
    const dueB = b.deadline?.getTime() ?? Number.POSITIVE_INFINITY;
    return escalationFirst || dueA - dueB;
  }),
}));

const projections = H.trigger('projections', H.when.transition(), (then) => [
  then.run(markdown.board({ path: 'BOARD.md' })),
  then.run(markdown.telemetry({ path: 'TELEMETRY.md', sinceDays: 7 })),
]);

const reviewerConsole = claudeCode.supervisor({
  name: 'reviewer-console',
  endpoint: H.slot.port(7402),
  grants: [H.op.readWork, H.op.resolveBlocker, H.op.cancelWork, H.op.writeMemory, H.op.curateMemory, H.op.readMemory, H.op.readTelemetry],
});

export const supportTriage = H.harness('support-triage')
  .ledger(sqlite.ledger({ path: '.harness/ledger.sqlite' }))
  .lanes(conversationLane, escalationLane)
  .journals(tasteJournal, experienceJournal)
  .triggers(slaBreachEscalates, customerReplyRestarts, projections)
  .metrics(approvalByCategory, approvalByModel)
  .scheduler(timeToBreach)
  .clients(reviewerConsole);

export const running = supportTriage.start();
