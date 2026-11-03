import { H, type PendingView, type SupplyOf } from 'harness-dsl';
import { z } from 'zod';
import * as claudeCode from 'harness-dsl/claude-code';
import * as anthropic from 'harness-dsl/anthropic';
import * as sqlite from 'harness-dsl/sqlite';
import * as jsonl from 'harness-dsl/jsonl';
import * as shell from 'harness-dsl/shell';
import * as http from 'harness-dsl/http';
import * as markdown from 'harness-dsl/markdown';

const category = z.enum(['billing', 'refund', 'shipping', 'technical', 'account']);

const conversationData = z.object({
  conversationId: z.string(),
  customer: z.string(),
  subject: z.string(),
  latestMessage: z.string(),
  slaDueAt: z.string(),
  category: category.optional(),
});

const Conversation = H.kind('conversation')
  .data(conversationData)
  .states(
    [
      H.state('new', 'pending'),
      H.state('classifying', 'pending'),
      H.state('drafting', 'active'),
      H.state('awaiting-approval', 'active'),
      H.state('sent', 'waiting'),
      H.state('closed-by-customer', { terminal: 'success' }),
      H.state('escalated', { terminal: 'failure' }),
    ],
    'new'
  );

const Escalation = H.kind('escalation')
  .data(z.object({ conversationId: z.string(), customer: z.string(), subject: z.string() }))
  .states(
    [
      H.state('escalation-open', 'pending'),
      H.state('escalation-resolved', { terminal: 'success' }),
      H.state('escalation-dismissed', { terminal: 'neutral' }),
    ],
    'escalation-open'
  );

const Taste = H.memory('taste', 'owner');
const Experience = H.memory('experience', 'fallible');

const specificThenProven = H.policy.recall('specific-then-proven', (view) =>
  [...view.items]
    .filter((item) => item.status === 'accepted')
    .sort((a, b) => b.specificity - a.specificity || (b.trackRecord.value ?? 0) - (a.trackRecord.value ?? 0))
    .slice(0, 10)
);

const taste = H.library('support-taste', Taste, jsonl.memory('memory/taste.jsonl')).recall(specificThenProven);
const experience = H.library('support-experience', Experience, jsonl.memory('memory/experience.jsonl')).recall(specificThenProven);

const haiku = anthropic.model('claude-haiku-4-5');
const sonnet = anthropic.model('claude-sonnet-4-5');
const opus = anthropic.model('claude-opus-4-1');

const drafterByApproval = H.policy.model('drafter-by-approval-rate', (choice) => {
  const approvals = choice.metrics.rate({
    among: { entry: 'halt', halt: 'approve-reply', status: 'resolved', tags: { model: sonnet.name } },
    count: { decision: { approved: true } },
    days: 30,
  });
  if (approvals.value === null || approvals.samples < 100) return sonnet;
  return approvals.value >= 0.8 ? sonnet : opus;
});

const safeCategory = H.policy.rule('safe-category', (input: { readonly category: string }, metrics) => {
  const rejections = metrics.rate({
    among: { entry: 'halt', halt: 'approve-reply', status: 'resolved', tags: { category: input.category } },
    count: { decision: { approved: false } },
  });
  return rejections.samples >= 200 && rejections.hits === 0;
});

const firstEligible = H.policy.account('first-eligible', (choice) => choice.accounts.find((view) => view.eligible)?.account ?? null);

const apiPool = H.pool(
  'api',
  [{ account: anthropic.account('support-api', { apiKey: H.env('ANTHROPIC_API_KEY') }), share: 1 }],
  firstEligible
);

const classifierRole = H.role('classifier')
  .input(z.object({ subject: z.string(), message: z.string() }))
  .output(z.object({ category }))
  .prompt((input) => `Classify this customer conversation.\nSubject: ${input.subject}\n\n${input.message}`);

const drafterRole = H.role('drafter')
  .input(z.object({ subject: z.string(), message: z.string(), category, reviewerNotes: z.string() }))
  .output(z.object({ reply: z.string() }))
  .prompt((input) =>
    `Draft a reply for a ${input.category} conversation.\nSubject: ${input.subject}\n\n${input.message}\n\nReviewer notes on the previous draft: ${input.reviewerNotes || 'none'}`
  );

const classifier = H.agent('classifier', classifierRole).model(haiku);
const drafter = H.agent('drafter', drafterRole).model(drafterByApproval).recalls(taste, experience);

const local = shell.local('local', { slots: 4 });

const sendReply = H.command('send-reply')
  .input(z.object({ conversationId: z.string(), reply: z.string() }))
  .argv((input) => ['helpdesk-reply', '--conversation', input.conversationId, '--body', input.reply])
  .on(local);

const reviewDecision = z.object({
  approved: z.boolean(),
  editedReply: z.string().optional(),
  notes: z.string().optional(),
});

const conversationFlow = H.flow('triage-and-reply').for(Conversation).does(async (ctx) => {
  const { conversationId, subject, latestMessage } = ctx.unit.data;
  const classified = await ctx.run(classifier, { subject, message: latestMessage });
  if (!classified.ok) return ctx.fail(classified.error);
  const chosen = classified.value.category;
  await ctx.update({ category: chosen });
  ctx.tag({ category: chosen });
  await ctx.move('drafting');
  const safe = await ctx.decide(safeCategory, { category: chosen });
  let reviewerNotes = '';
  for (let round = 1; round <= 3; round += 1) {
    const drafted = await ctx.run(
      drafter,
      { subject, message: latestMessage, category: chosen, reviewerNotes },
      { scope: { skills: [chosen] } }
    );
    if (!drafted.ok) return ctx.fail(drafted.error);
    ctx.tag({ model: drafted.model ?? drafter.name });
    let reply = drafted.value.reply;
    if (!safe) {
      await ctx.move('awaiting-approval');
      const review = await ctx.halt({ name: 'approve-reply', show: reply, decision: reviewDecision });
      if (review.notes) {
        await ctx.remember(taste, {
          text: review.notes,
          because: `the reviewer wrote it while reviewing a ${chosen} reply`,
          when: { roles: [drafterRole], skills: [chosen] },
          status: 'candidate',
        });
      }
      if (!review.approved) {
        reviewerNotes = review.notes ?? 'rejected without notes';
        await ctx.move('drafting');
        continue;
      }
      reply = review.editedReply ?? reply;
    }
    const sent = await ctx.run(sendReply, { conversationId, reply });
    if (!sent.ok) return ctx.fail(sent.error);
    return 'sent';
  }
  return 'escalated';
});

const escalationFlow = H.flow('human-escalation').for(Escalation).does(async (ctx) => {
  const handled = await ctx.halt({
    name: 'handle-escalation',
    show: `Escalated conversation ${ctx.unit.data.conversationId} with ${ctx.unit.data.customer}: ${ctx.unit.data.subject}`,
    decision: z.object({ resolution: z.enum(['resolved', 'dismissed']), notes: z.string() }),
  });
  return handled.resolution === 'resolved' ? 'escalation-resolved' : 'escalation-dismissed';
});

const helpdeskConversation = z.object({
  id: z.string(),
  customer: z.string(),
  subject: z.string(),
  message: z.string(),
  slaDueAt: z.string(),
});

const helpdeskHeaders = { 'X-Api-Token': H.env('HELPDESK_TOKEN') };

const helpdeskWebhook = http.webhook(Conversation, {
  path: '/hooks/helpdesk',
  secret: H.env('HELPDESK_WEBHOOK_SECRET'),
  body: z.object({
    event: z.enum(['conversation.created', 'message.created', 'conversation.closed']),
    conversation: helpdeskConversation,
  }),
  read: (body): SupplyOf<typeof Conversation> | null => {
    const found = body.conversation;
    if (body.event === 'conversation.created') {
      return {
        create: {
          conversationId: found.id,
          customer: found.customer,
          subject: found.subject,
          latestMessage: found.message,
          slaDueAt: found.slaDueAt,
        },
        key: found.id,
      };
    }
    if (body.event === 'conversation.closed') return { update: found.id, state: 'closed-by-customer' };
    return { update: found.id, patch: { latestMessage: found.message }, state: 'classifying' };
  },
});

const helpdeskPoll = http.poll(Conversation, {
  url: 'https://helpdesk.example.com/api/conversations?status=open',
  every: { minutes: 10 },
  headers: helpdeskHeaders,
  body: z.object({ conversations: z.array(helpdeskConversation) }),
  read: (body) =>
    body.conversations.map((found): SupplyOf<typeof Conversation> => ({
      create: {
        conversationId: found.id,
        customer: found.customer,
        subject: found.subject,
        latestMessage: found.message,
        slaDueAt: found.slaDueAt,
      },
      key: found.id,
    })),
});

const helpdeskStore = http.store(Conversation, {
  url: 'https://helpdesk.example.com/api/conversations',
  headers: helpdeskHeaders,
  stateField: 'harness_state',
});

const conversationLane = H.lane('conversations', Conversation)
  .handler(conversationFlow)
  .suppliers(helpdeskWebhook, helpdeskPoll)
  .store(helpdeskStore)
  .maxUsdPerUnit(0.4);

const escalationLane = H.lane('escalations', Escalation).handler(escalationFlow);

const slaBreachEscalates = H.trigger(
  'sla-breach-escalates',
  H.on.deadline(Conversation, (data) => new Date(data.slaDueAt), ['new', 'classifying', 'drafting', 'awaiting-approval']),
  (_event, act) => act.move('escalated')
);

const escalatedOpensEscalation = H.trigger('escalated-opens-escalation', H.on.enters(Conversation, 'escalated'), (event, act) =>
  act.create(
    escalationLane,
    {
      conversationId: event.unit.data.conversationId,
      customer: event.unit.data.customer,
      subject: event.unit.data.subject,
    },
    `escalation-${event.unit.data.conversationId}`
  )
);

const escalationsThenTimeToBreach = H.policy.scheduler('escalations-then-time-to-breach', (view) => {
  const breachInMs = (unit: PendingView): number =>
    unit.is(Conversation) ? Date.parse(unit.data.slaDueAt) - view.now.getTime() : Number.NEGATIVE_INFINITY;
  return { start: [...view.pending].sort((a, b) => breachInMs(a) - breachInMs(b)) };
});

const supervisor = claudeCode.supervisor({
  grants: [H.ops.readWork, H.ops.writeWork, H.ops.resolveHalts, H.ops.readMemory, H.ops.writeMemory, H.ops.readTelemetry],
});

export const supportTriage = H.harness('support-triage')
  .ledger(sqlite.ledger('.harness/support.sqlite'))
  .lanes(conversationLane, escalationLane)
  .pools(apiPool)
  .triggers(slaBreachEscalates, escalatedOpensEscalation)
  .scheduler(escalationsThenTimeToBreach)
  .clients(supervisor)
  .observers(markdown.board('BOARD.md'), markdown.telemetry('TELEMETRY.md'));
