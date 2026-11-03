import { H } from 'harness-dsl';
import type { PendingView } from 'harness-dsl';
import { z } from 'zod';
import * as claudeCode from 'harness-dsl/claude-code';
import * as anthropic from 'harness-dsl/anthropic';
import * as sqlite from 'harness-dsl/sqlite';
import * as jsonl from 'harness-dsl/jsonl';
import * as shell from 'harness-dsl/shell';
import * as http from 'harness-dsl/http';
import * as markdown from 'harness-dsl/markdown';

const categorySchema = z.enum(['billing', 'shipping', 'technical', 'account', 'other']);
type Category = z.infer<typeof categorySchema>;
const category = H.facet('category', ['billing', 'shipping', 'technical', 'account', 'other']);
const drafterModel = H.facet('drafter-model');

const Conversation = H.kind('Conversation')
  .data(
    z.object({
      ticketId: z.string(),
      customer: z.string(),
      message: z.string(),
      slaDueAt: z.string(),
      category: categorySchema.optional(),
      draft: z.string().optional(),
    })
  )
  .states(
    H.state('new', 'pending'),
    H.state('classifying', 'pending'),
    H.state('drafting', 'pending'),
    H.state('awaiting-approval', 'active'),
    H.state('sent', 'terminal', 'success'),
    H.state('closed-by-customer', 'terminal', 'neutral'),
    H.state('escalated', 'terminal', 'neutral')
  );

const Escalation = H.kind('Escalation')
  .data(z.object({ ticketId: z.string(), reason: z.string() }))
  .states(H.state('raised', 'pending'), H.state('handled', 'terminal', 'success'));

const tasteKind = H.memory('taste', 'taste');
const experienceKind = H.memory('experience', 'experience');
const reviewerTaste = H.archive('reviewer-taste', tasteKind, jsonl.memory('memory/taste.jsonl'));
const supportExperience = H.archive('support-experience', experienceKind, jsonl.memory('memory/experience.jsonl'));
const drafterBriefing = H.briefing('drafter-briefing', [reviewerTaste, supportExperience]);

const haiku = anthropic.model('claude-haiku-4-5');
const sonnet = anthropic.model('claude-sonnet-4-5');
const opus = anthropic.model('claude-opus-4-1');

const api = H.pool('api', [{ account: anthropic.account('api', { apiKey: H.env('ANTHROPIC_API_KEY') }), share: 1 }]);

const approval = H.halt(
  'reply-approval',
  z.object({ approved: z.boolean(), reply: z.string().optional(), tasteNote: z.string().optional() })
);

const escalationHandled = H.halt('escalation-handled', z.object({ resolution: z.string() }));

const drafterChoice = H.policy.model('drafter-by-approval', ({ facets, metrics }) => {
  const byModel = metrics.rateBy({
    among: { ...approval.resolved(), facets },
    count: { ...approval.resolved({ approved: true }), facets },
    by: drafterModel,
    days: 30,
  });
  const current = byModel[sonnet.name];
  const weak = current !== undefined && current.samples >= 50 && current.value !== null && current.value < 0.8;
  return weak ? opus : sonnet;
});

const safeCategory = H.policy.rule('safe-category', (value: Category, metrics) => {
  const inCategory = [category.is(value)];
  const approvals = metrics.rate({
    among: { ...approval.resolved(), facets: inCategory },
    count: { ...approval.resolved({ approved: true }), facets: inCategory },
  });
  return approvals.hits >= 200 && approvals.hits === approvals.samples;
});

const classify = H.role('classify')
  .input(z.object({ message: z.string() }))
  .output(z.object({ category: categorySchema }))
  .prompt((input) => `Classify this customer message:\n${input.message}`)
  .intents(['read']);

const draft = H.role('draft')
  .input(z.object({ message: z.string(), category: categorySchema }))
  .output(z.object({ reply: z.string() }))
  .prompt((input) => `Draft a reply to this ${input.category} conversation:\n${input.message}`)
  .intents(['read']);

const classifier = H.agent('classifier', classify).model(haiku);
const drafter = H.agent('drafter', draft).model(drafterChoice).recalls(drafterBriefing);

const local = shell.local('local', { slots: 4 });

const sendReply = H.command('send-reply')
  .input(z.object({ ticketId: z.string(), reply: z.string() }))
  .argv((input) => ['helpdesk-reply', '--ticket', input.ticketId, '--body', input.reply])
  .on(local);

const conversationFlow = H.flow('conversation')
  .for(Conversation)
  .does(async (ctx) => {
    const classified = await ctx.run(classifier, { message: ctx.unit.data.message });
    if (!classified.ok) return ctx.fail(classified.error);
    await ctx.update({ category: classified.value.category });
    return 'drafting';
  })
  .phase('drafting', async (ctx) => {
    const data = ctx.unit.data;
    const topic = data.category ?? 'other';
    ctx.facet(category, topic);
    const drafted = await ctx.run(drafter, { message: data.message, category: topic });
    if (!drafted.ok) return ctx.fail(drafted.error);
    ctx.facet(drafterModel, drafted.model ?? 'unknown');
    await ctx.update({ draft: drafted.value.reply });
    let reply = drafted.value.reply;
    const safe = await ctx.decide(safeCategory, topic);
    if (!safe) {
      await ctx.move('awaiting-approval');
      const decision = await ctx.halt(approval, `To ${data.customer} (${topic}):\n\n${reply}`);
      if (decision.tasteNote !== undefined) {
        await ctx.remember(reviewerTaste, { text: decision.tasteNote, status: 'candidate', when: { kinds: [Conversation] } });
      }
      if (!decision.approved) {
        await ctx.move('drafting');
        return ctx.fail('reviewer rejected the draft');
      }
      reply = decision.reply ?? reply;
    }
    const sent = await ctx.run(sendReply, { ticketId: data.ticketId, reply });
    if (!sent.ok) return ctx.fail(sent.error);
    return 'sent';
  });

const escalationFlow = H.flow('escalation')
  .for(Escalation)
  .does(async (ctx) => {
    await ctx.halt(escalationHandled, `Escalated conversation ${ctx.unit.data.ticketId}: ${ctx.unit.data.reason}`);
    return 'handled';
  });

const helpdeskHeaders = { Authorization: H.env('HELPDESK_TOKEN') };
const conversationBody = z.object({
  ticketId: z.string(),
  customer: z.string(),
  message: z.string(),
  slaDueAt: z.string(),
});

const helpdeskWebhook = http.webhook(Conversation, {
  path: '/helpdesk/events',
  secret: H.env('HELPDESK_WEBHOOK_SECRET'),
  body: z.object({
    event: z.enum(['created', 'customer-replied', 'closed']),
    conversation: conversationBody,
  }),
  read: (body) =>
    body.event === 'created'
      ? { create: body.conversation, key: body.conversation.ticketId }
      : body.event === 'customer-replied'
        ? { update: body.conversation.ticketId, patch: { message: body.conversation.message }, state: 'classifying' }
        : { update: body.conversation.ticketId, state: 'closed-by-customer' },
});

const helpdeskPoll = http.poll(Conversation, {
  url: 'https://helpdesk.example.com/api/conversations?status=open',
  every: { minutes: 10 },
  headers: helpdeskHeaders,
  body: z.object({ conversations: z.array(conversationBody) }),
  read: (body) => body.conversations.map((conversation) => ({ create: conversation, key: conversation.ticketId })),
});

const conversations = H.lane('conversations', Conversation)
  .handler(conversationFlow)
  .suppliers(helpdeskWebhook, helpdeskPoll)
  .store(
    http.store(Conversation, {
      url: 'https://helpdesk.example.com/api/conversations',
      headers: helpdeskHeaders,
      stateField: 'harness_state',
    })
  )
  .maxUsdPerUnit(0.4);

const escalations = H.lane('escalations', Escalation).handler(escalationFlow);

const slaBreach = H.trigger(
  'sla-breach',
  H.on.deadline(Conversation, (data) => new Date(data.slaDueAt), ['new', 'classifying', 'drafting', 'awaiting-approval']),
  (event, act) => [
    act.create(escalations, { ticketId: event.unit.data.ticketId, reason: 'SLA breached' }, event.unit.data.ticketId),
    act.move('escalated'),
  ]
);

const timeToBreach = H.policy.scheduler('time-to-breach', (view) => {
  const dueMs = (unit: PendingView): number => {
    if (unit.lane === escalations.name) return Number.NEGATIVE_INFINITY;
    return unit.is(Conversation) ? Date.parse(unit.data.slaDueAt) : Number.POSITIVE_INFINITY;
  };
  return { start: [...view.pending].sort((a, b) => dueMs(a) - dueMs(b)) };
});

const reviewerSupervisor = claudeCode.supervisor({
  grants: [
    H.ops.readWork,
    H.ops.resolveHalts,
    H.ops.readMemory,
    H.ops.writeMemory,
    H.ops.curateMemory,
    H.ops.readTelemetry,
  ],
});

export const supportTriage = H.harness('support-triage')
  .ledger(sqlite.ledger('.harness/ledger.db'))
  .lanes(conversations, escalations)
  .pools(api)
  .triggers(slaBreach)
  .scheduler(timeToBreach)
  .clients(reviewerSupervisor)
  .observers(markdown.board('BOARD.md'), markdown.telemetry('TELEMETRY.md'));
