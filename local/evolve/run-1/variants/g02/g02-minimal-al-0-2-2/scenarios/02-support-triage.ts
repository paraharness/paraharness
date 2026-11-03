import { H } from 'harness-dsl';
import type { PendingView, Rate, SupplyOf } from 'harness-dsl';
import { z } from 'zod';
import * as anthropic from 'harness-dsl/anthropic';
import * as claude from 'harness-dsl/claude-code';
import * as http from 'harness-dsl/http';
import * as jsonl from 'harness-dsl/jsonl';
import * as sqlite from 'harness-dsl/sqlite';
import * as shell from 'harness-dsl/shell';
import * as markdown from 'harness-dsl/markdown';

const fresh = H.state('new', 'pending');
const classifying = H.state('classifying', 'active');
const drafting = H.state('drafting', 'active');
const awaitingApproval = H.state('awaiting-approval', 'active');
const sent = H.state('sent', 'terminal', 'success');
const closedByCustomer = H.state('closed-by-customer', 'terminal', 'neutral');
const escalated = H.state('escalated', 'terminal', 'failure');

const escalationOpen = H.state('escalation-open', 'pending');
const escalationHandling = H.state('escalation-handling', 'active');
const escalationClosed = H.state('escalation-closed', 'terminal', 'success');

export const Conversation = H.kind('conversation')
  .data(z.object({
    id: z.string(),
    customer: z.string(),
    message: z.string(),
    category: z.string().nullable(),
    slaDue: z.string(),
  }))
  .states(fresh, classifying, drafting, awaitingApproval, sent, closedByCustomer, escalated);

export const Escalation = H.kind('escalation')
  .data(z.object({ conversationId: z.string(), customer: z.string() }))
  .states(escalationOpen, escalationHandling, escalationClosed);

const classifierRole = H.role('classifier')
  .input(z.object({ message: z.string() }))
  .output(z.object({ category: z.string() }))
  .prompt((input) => `Classify this customer message into one support category:\n\n${input.message}`);

const drafterRole = H.role('drafter')
  .input(z.object({ customer: z.string(), message: z.string(), category: z.string() }))
  .output(z.object({ reply: z.string() }))
  .prompt((input) => `Draft a reply to ${input.customer} about a ${input.category} request:\n\n${input.message}`);

const haiku = anthropic.model('claude-haiku-4-5');
const sonnet = anthropic.model('claude-sonnet-4-5');
const opus = anthropic.model('claude-opus-4-1');

const replyApproval = H.halt('reply-approval', z.object({
  verdict: z.enum(['approve', 'edit', 'reject']),
  reply: z.string(),
  tasteNote: z.string().nullable(),
}));

const escalationResolution = H.halt('escalation-resolution', z.object({ resolution: z.string() }));

const noSamples: Rate = { value: null, hits: 0, samples: 0 };
const rateOf = (rates: Readonly<Record<string, Rate>>, key: string): Rate => rates[key] ?? noSamples;

const drafterModel = H.policy.model('drafter-model', ({ metrics }) => {
  const approvalByModel = metrics.rateBy({
    among: replyApproval.resolved(),
    count: replyApproval.resolved({ verdict: 'approve' }),
    byTag: 'model',
    days: 30,
  });
  const incumbent = rateOf(approvalByModel, opus.name);
  const challenger = rateOf(approvalByModel, sonnet.name);
  if (challenger.samples < 100) {
    return incumbent.samples >= 200 && incumbent.samples % 5 === 0 ? sonnet : opus;
  }
  if (challenger.value === null || incumbent.value === null) return opus;
  return challenger.value >= incumbent.value ? sonnet : opus;
});

const safeToSend = H.policy.rule('safe-to-send', (category: string, metrics) => {
  const rejections = metrics.rate({
    among: { ...replyApproval.resolved(), tags: { category } },
    count: replyApproval.resolved({ verdict: 'reject' }),
  });
  return rejections.samples >= 200 && rejections.hits === 0;
});

const experience = H.memory('support-experience', 'experience');
const taste = H.memory('reply-taste', 'taste');
const supportExperience = H.library('support-experience', experience, jsonl.memory('.harness/experience.jsonl'));
const reviewerTaste = H.library('reviewer-taste', taste, jsonl.memory('.harness/taste.jsonl'));

const classifier = H.agent('classifier', classifierRole).model(haiku);
const drafter = H.agent('drafter', drafterRole).model(drafterModel).recalls(reviewerTaste, supportExperience);

const local = shell.local('local', { slots: 4 });
const sendReply = H.command('send-reply')
  .input(z.object({ conversationId: z.string(), reply: z.string() }))
  .argv((input) => ['helpdesk-cli', 'reply', input.conversationId, '--body', input.reply])
  .on(local);

const triage = H.flow('conversation-triage').for(Conversation).does(async (ctx) => {
  const { id, customer, message } = ctx.unit.data;
  await ctx.move('classifying');
  const classified = await ctx.run(classifier, { message });
  if (!classified.ok) return ctx.fail(classified.error);
  const { category } = classified.value;
  ctx.tag({ category });
  await ctx.update({ category });
  await ctx.move('drafting');
  const drafted = await ctx.run(drafter, { customer, message, category }, { scope: { skills: [category] } });
  if (!drafted.ok) return ctx.fail(drafted.error);
  ctx.tag({ model: drafted.model ?? 'unknown' });
  let reply = drafted.value.reply;
  const safe = await ctx.decide(safeToSend, category);
  if (!safe) {
    await ctx.move('awaiting-approval');
    const decision = await ctx.halt(replyApproval, `[${category}] reply to ${customer}:\n\n${reply}`);
    if (decision.verdict === 'reject') return 'escalated';
    if (decision.tasteNote !== null) {
      await ctx.remember(reviewerTaste, {
        text: decision.tasteNote,
        when: { roles: [drafterRole.name] },
        status: 'accepted',
      });
    }
    reply = decision.reply;
  }
  const delivered = await ctx.run(sendReply, { conversationId: id, reply });
  if (!delivered.ok) return ctx.fail(delivered.error);
  return 'sent';
});

const escalationDesk = H.flow('escalation-desk').for(Escalation).does(async (ctx) => {
  await ctx.move('escalation-handling');
  await ctx.halt(escalationResolution, `Escalated conversation ${ctx.unit.data.conversationId} from ${ctx.unit.data.customer}`);
  return 'escalation-closed';
});

const helpdeskHeaders = { Authorization: H.env('HELPDESK_AUTHORIZATION') };

const helpdeskWebhook = http.webhook(Conversation, {
  path: '/hooks/helpdesk',
  secret: H.env('HELPDESK_WEBHOOK_SECRET'),
  body: z.object({
    event: z.enum(['created', 'replied', 'closed']),
    conversationId: z.string(),
    customer: z.string(),
    text: z.string(),
    slaDue: z.string(),
  }),
  read: (body) =>
    body.event === 'created'
      ? {
          create: { id: body.conversationId, customer: body.customer, message: body.text, category: null, slaDue: body.slaDue },
          key: body.conversationId,
        }
      : body.event === 'replied'
        ? { update: body.conversationId, patch: { message: body.text }, state: 'new' }
        : { update: body.conversationId, state: 'closed-by-customer' },
});

const helpdeskPoll = http.poll(Conversation, {
  url: 'https://helpdesk.example.com/api/conversations?status=open',
  every: { minutes: 10 },
  headers: helpdeskHeaders,
  body: z.object({
    conversations: z.array(z.object({
      id: z.string(),
      customer: z.string(),
      lastMessage: z.string(),
      slaDue: z.string(),
    })),
  }),
  read: (body) => body.conversations.map((item): SupplyOf<typeof Conversation> => ({
    create: { id: item.id, customer: item.customer, message: item.lastMessage, category: null, slaDue: item.slaDue },
    key: item.id,
  })),
});

const helpdeskStore = http.store(Conversation, {
  url: 'https://helpdesk.example.com/api/conversations',
  headers: helpdeskHeaders,
  stateField: 'harness_state',
});

export const conversations = H.lane('conversations', Conversation)
  .handler(triage)
  .suppliers(helpdeskWebhook, helpdeskPoll)
  .store(helpdeskStore)
  .maxUsdPerUnit(0.4);

export const escalations = H.lane('escalations', Escalation).handler(escalationDesk);

const slaBreachEscalates = H.trigger(
  'sla-breach-escalates',
  H.on.deadline(Conversation, (data) => new Date(data.slaDue), ['new', 'classifying', 'drafting', 'awaiting-approval']),
  (_event, act) => act.move('escalated'),
);

const escalatedOpensEscalation = H.trigger(
  'escalated-opens-escalation',
  H.on.enters(Conversation, 'escalated'),
  (event, act) => act.create(escalations, {
    conversationId: event.unit.data.id,
    customer: event.unit.data.customer,
  }, event.unit.data.id),
);

const timeToBreach = H.policy.scheduler('time-to-breach', ({ now, pending }) => {
  const breachInMs = (unit: PendingView): number =>
    unit.is(Conversation) ? Date.parse(unit.data.slaDue) - now.getTime() : Number.MIN_SAFE_INTEGER;
  return { start: [...pending].sort((a, b) => breachInMs(a) - breachInMs(b)) };
});

const apiAccount = anthropic.account('anthropic-api', { apiKey: H.env('ANTHROPIC_API_KEY') });

const reviewer = claude.supervisor({
  grants: [
    H.ops.readWork,
    H.ops.writeWork,
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
  .pools(H.pool('anthropic', [{ account: apiAccount, share: 1 }]))
  .triggers(slaBreachEscalates, escalatedOpensEscalation)
  .scheduler(timeToBreach)
  .clients(reviewer)
  .observers(markdown.board('.harness/board.md'), markdown.telemetry('.harness/telemetry.md'));

export const running = supportTriage.start();
