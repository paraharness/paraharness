import { H } from 'harness-dsl';
import type { ModelPolicy, PendingView } from 'harness-dsl';
import { z } from 'zod';
import * as claudeCode from 'harness-dsl/claude-code';
import * as anthropic from 'harness-dsl/anthropic';
import * as http from 'harness-dsl/http';
import * as sqlite from 'harness-dsl/sqlite';
import * as jsonl from 'harness-dsl/jsonl';
import * as shell from 'harness-dsl/shell';
import * as markdown from 'harness-dsl/markdown';

const Conversation = H.kind('conversation')
  .data(z.object({
    customer: z.string(),
    lastMessage: z.string(),
    slaDueAt: z.string(),
    category: z.string().optional()
  }))
  .states(
    H.state('new', 'pending'),
    H.state('classifying', 'active'),
    H.state('drafting', 'active'),
    H.state('awaiting-approval', 'active'),
    H.state('sent', 'terminal', 'success'),
    H.state('closed-by-customer', 'terminal', 'neutral'),
    H.state('escalated', 'terminal', 'failure')
  );

const Escalation = H.kind('escalation')
  .data(z.object({ conversationId: z.string(), customer: z.string(), reason: z.string() }))
  .states(
    H.state('escalation-open', 'pending'),
    H.state('escalation-active', 'active'),
    H.state('escalation-resolved', 'terminal', 'success'),
    H.state('escalation-dropped', 'terminal', 'neutral')
  );

const category = H.tag('category');

const tasteLibrary = H.library('support-tone', H.memory('support-taste', 'taste'), jsonl.memory('.harness/support-taste.jsonl'));
const experienceLibrary = H.library('support-lessons', H.memory('support-experience', 'experience'), jsonl.memory('.harness/support-experience.jsonl'));

const haiku = anthropic.model('claude-haiku-4-5');
const sonnet = anthropic.model('claude-sonnet-4-5');
const opus = anthropic.model('claude-opus-4-1');

const replyApproval = H.halt('reply-approval', z.object({
  approved: z.boolean(),
  reply: z.string().optional(),
  tasteNote: z.string().optional()
}));

const escalationResolution = H.halt('escalation-resolution', z.object({ resolved: z.boolean(), note: z.string() }));

const classifierRole = H.role('classifier')
  .input(z.object({ message: z.string() }))
  .output(z.object({ category: z.enum(['billing', 'refund', 'technical', 'account', 'other']) }))
  .prompt((input) => `Classify this customer message into one category.\n\n${input.message}`);

const drafterRole = H.role('drafter')
  .input(z.object({ message: z.string(), category: z.string() }))
  .output(z.object({ reply: z.string() }))
  .prompt((input) => `Draft a reply to this ${input.category} conversation.\n\n${input.message}`);

const drafterModel: ModelPolicy = H.policy.model('drafter-model', ({ metrics }) => {
  const byModel = metrics.rateBy({
    among: replyApproval.resolved(),
    count: replyApproval.resolved({ approved: true }),
    by: { model: drafter },
    days: 30
  });
  const sonnetRate = byModel.get(sonnet);
  const opusRate = byModel.get(opus);
  if (sonnetRate.samples < 50 || opusRate.samples < 50) {
    return sonnetRate.samples <= opusRate.samples ? sonnet : opus;
  }
  return (sonnetRate.value ?? 0) >= (opusRate.value ?? 0) - 0.02 ? sonnet : opus;
});

const classifier = H.agent('classifier', classifierRole).model(haiku);
const drafter = H.agent('drafter', drafterRole).model(drafterModel).recalls(tasteLibrary, experienceLibrary);

const autoSendSafe = H.policy.rule('auto-send-safe')
  .input(z.object({ category: z.string() }))
  .decides((input, metrics) => {
    const approvals = metrics.rate({
      among: replyApproval.resolved().where(category, input.category),
      count: replyApproval.resolved({ approved: true }).where(category, input.category)
    });
    return approvals.samples >= 200 && approvals.hits === approvals.samples;
  });

const localShell = shell.local('local-shell', { slots: 4 });
const helpdeskAuth = H.env('HELPDESK_AUTH_HEADER');

const sendReply = H.command('send-reply')
  .input(z.object({ conversationId: z.string(), reply: z.string() }))
  .argv((input) => [
    'curl', '-fsS', '-X', 'POST',
    '-H', helpdeskAuth,
    '-H', 'Content-Type: application/json',
    `https://helpdesk.example.com/api/conversations/${input.conversationId}/replies`,
    '-d', JSON.stringify({ body: input.reply })
  ])
  .on(localShell)
  .recovery('park');

const conversationWork = H.flow('conversation-work')
  .for(Conversation)
  .does(async (ctx) => {
    const message = ctx.unit.data.lastMessage;
    await ctx.move('classifying');
    const classified = await ctx.run(classifier, { message });
    if (!classified.ok) return ctx.fail(classified.error);
    const chosen = classified.value.category;
    ctx.tag(category, chosen);
    await ctx.update({ category: chosen });

    await ctx.move('drafting');
    const drafted = await ctx.run(drafter, { message, category: chosen });
    if (!drafted.ok) return ctx.fail(drafted.error);
    let reply = drafted.value.reply;

    const safe = await ctx.decide(autoSendSafe, { category: chosen });
    if (!safe) {
      await ctx.move('awaiting-approval');
      const review = await ctx.halt(replyApproval, `Category: ${chosen}\n\n${reply}`);
      if (review.tasteNote !== undefined) {
        await ctx.remember(tasteLibrary, {
          text: review.tasteNote,
          because: `reviewer edited a ${chosen} reply`,
          when: { roles: [drafterRole] },
          status: 'candidate'
        });
      }
      if (!review.approved) return 'escalated';
      reply = review.reply ?? reply;
    }

    const sent = await ctx.run(sendReply, { conversationId: ctx.unit.key, reply });
    if (!sent.ok) return ctx.fail(sent.error);
    return 'sent';
  });

const escalationWork = H.flow('escalation-handling')
  .for(Escalation)
  .does(async (ctx) => {
    await ctx.move('escalation-active');
    const outcome = await ctx.halt(
      escalationResolution,
      `Conversation ${ctx.unit.data.conversationId} with ${ctx.unit.data.customer} escalated: ${ctx.unit.data.reason}`
    );
    return outcome.resolved ? 'escalation-resolved' : 'escalation-dropped';
  });

const helpdeskWebhook = http.webhook(Conversation, {
  path: '/hooks/helpdesk',
  secret: H.env('HELPDESK_WEBHOOK_SECRET'),
  body: z.object({
    event: z.enum(['conversation.created', 'message.created', 'conversation.closed']),
    conversationId: z.string(),
    customer: z.string(),
    message: z.string(),
    slaDueAt: z.string()
  }),
  read: (body) => {
    switch (body.event) {
      case 'conversation.created':
        return Conversation.create({ customer: body.customer, lastMessage: body.message, slaDueAt: body.slaDueAt }, body.conversationId);
      case 'message.created':
        return Conversation.update(body.conversationId, { patch: { lastMessage: body.message }, state: 'new' });
      case 'conversation.closed':
        return Conversation.update(body.conversationId, { state: 'closed-by-customer' });
    }
  }
});

const helpdeskPoll = http.poll(Conversation, {
  url: 'https://helpdesk.example.com/api/conversations?status=open',
  every: { minutes: 10 },
  headers: { Authorization: helpdeskAuth },
  body: z.object({
    conversations: z.array(z.object({
      id: z.string(),
      customer: z.string(),
      lastMessage: z.string(),
      slaDueAt: z.string()
    }))
  }),
  read: (body) => body.conversations.map((item) =>
    Conversation.create({ customer: item.customer, lastMessage: item.lastMessage, slaDueAt: item.slaDueAt }, item.id))
});

const helpdeskStore = http.store(Conversation, {
  url: 'https://helpdesk.example.com/api/conversations',
  headers: { Authorization: helpdeskAuth },
  stateField: 'harness_state'
});

const conversationLane = H.lane('conversations', Conversation)
  .handler(conversationWork)
  .suppliers(helpdeskWebhook, helpdeskPoll)
  .store(helpdeskStore)
  .maxUsdPerUnit(0.4);

const escalationLane = H.lane('escalations', Escalation).handler(escalationWork);

const slaBreach = H.trigger(
  'sla-breach-escalates',
  H.on.deadline(Conversation, (data) => new Date(data.slaDueAt), ['new', 'classifying', 'drafting', 'awaiting-approval']),
  (_event, act) => act.move('escalated')
);

const escalationOpens = H.trigger('escalated-conversation-opens-escalation', H.on.enters(Conversation, 'escalated'), (event, act) =>
  act.create(escalationLane, {
    conversationId: event.unit.key,
    customer: event.unit.data.customer,
    reason: event.unit.data.lastMessage
  }, `escalation-${event.unit.key}`));

const breachTime = (unit: PendingView): number => {
  if (unit.is(Escalation)) return Number.NEGATIVE_INFINITY;
  if (unit.is(Conversation)) return Date.parse(unit.data.slaDueAt);
  return Number.POSITIVE_INFINITY;
};

const byTimeToBreach = H.policy.scheduler('time-to-breach', ({ pending }) => ({
  start: [...pending].sort((a, b) => breachTime(a) - breachTime(b))
}));

const apiPool = H.pool('support-accounts', [
  { account: anthropic.account('support-api', { apiKey: H.env('ANTHROPIC_API_KEY') }), share: 1 }
]);

export default H.harness('support-triage')
  .ledger(sqlite.ledger('.harness/support.db'))
  .lanes(conversationLane, escalationLane)
  .pools(apiPool)
  .triggers(slaBreach, escalationOpens)
  .scheduler(byTimeToBreach)
  .clients(claudeCode.supervisor({
    grants: [H.ops.readWork, H.ops.writeWork, H.ops.resolveHalts, H.ops.readMemory, H.ops.writeMemory, H.ops.readTelemetry]
  }))
  .observers(markdown.board('BOARD.md'), markdown.telemetry('TELEMETRY.md'));
