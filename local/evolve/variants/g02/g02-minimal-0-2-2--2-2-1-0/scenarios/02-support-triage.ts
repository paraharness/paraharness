import { z } from 'zod';
import { H, type Metrics, type PendingView } from 'harness-dsl';
import * as anthropic from 'harness-dsl/anthropic';
import * as claudeCode from 'harness-dsl/claude-code';
import * as http from 'harness-dsl/http';
import * as sqlite from 'harness-dsl/sqlite';
import * as jsonl from 'harness-dsl/jsonl';
import * as shell from 'harness-dsl/shell';
import * as markdown from 'harness-dsl/markdown';

const categories = z.enum(['billing', 'refund', 'shipping', 'account', 'other']);
const category = H.facet('category', categories);

const fresh = H.state('new', 'pending');
const sent = H.state('sent', 'waiting');
const closed = H.state('closed', 'terminal', 'success');
const escalated = H.state('escalated', 'terminal', 'neutral');
const escalationOpen = H.state('escalationOpen', 'pending');
const escalationHandled = H.state('escalationHandled', 'terminal', 'success');
const escalationDropped = H.state('escalationDropped', 'terminal', 'failure');

const conversation = H.kind('Conversation')
  .data(z.object({
    subject: z.string(),
    customer: z.string(),
    lastMessage: z.string(),
    category: categories.optional(),
    slaDue: z.string(),
  }))
  .states(fresh, sent, closed, escalated);

const escalation = H.kind('Escalation')
  .data(z.object({ conversation: z.string(), reason: z.string() }))
  .states(escalationOpen, escalationHandled, escalationDropped);

const tasteMemory = H.memory('replyTaste', 'taste');
const experienceMemory = H.memory('supportExperience', 'experience');
const tasteJournal = H.journal('tasteJournal', tasteMemory, jsonl.memory('memory/taste.jsonl'));
const experienceJournal = H.journal('experienceJournal', experienceMemory, jsonl.memory('memory/experience.jsonl'));

const haiku = anthropic.model('claude-haiku-4-5');
const sonnet = anthropic.model('claude-sonnet-4-5');
const opus = anthropic.model('claude-opus-4-1');
const apiAccount = anthropic.account('supportApi', { apiKey: H.env('ANTHROPIC_API_KEY') });
const pool = H.pool('supportPool', [{ account: apiAccount, share: 1 }]);

const local = shell.local('local', { slots: 4 });

const approvalAbout = z.object({ category: categories, draft: z.string() });
const approvalQuestion = H.halt(
  'replyApproval',
  z.object({ approved: z.boolean(), reply: z.string(), tasteNote: z.string().optional() })
).about(approvalAbout);

const safeCategory = H.policy.rule('safeCategoryAutoApproval', (input: z.infer<typeof approvalAbout>, metrics: Metrics) => {
  const scope = [category.of(input.category)];
  const record = metrics.rate({
    among: { ...approvalQuestion.resolved(), resolver: 'human', facets: scope },
    count: { ...approvalQuestion.resolved({ approved: true }), resolver: 'human', facets: scope },
  });
  return record.samples >= 200 && record.hits === record.samples ? { approved: true, reply: input.draft } : null;
});

const approval = approvalQuestion.policy(safeCategory);

const escalationHandling = H.halt('escalationHandling', z.object({ handled: z.boolean(), note: z.string() }));

const classifyRole = H.role('classify')
  .input(z.object({ subject: z.string(), message: z.string() }))
  .output(z.object({ category: categories }))
  .prompt(input => `Classify this support message.\nSubject: ${input.subject}\n\n${input.message}`);

const draftRole = H.role('draftReply')
  .input(z.object({ subject: z.string(), message: z.string(), category: categories }))
  .output(z.object({ reply: z.string() }))
  .prompt(input => `Draft a reply to this ${input.category} conversation.\nSubject: ${input.subject}\n\n${input.message}`);

const drafterModel = H.policy.model('drafterByApprovalRate', [sonnet, opus], choice => {
  const byModel = choice.metrics.rateBy({
    among: { ...approvalQuestion.resolved(), resolver: 'human' },
    count: { ...approvalQuestion.resolved({ approved: true }), resolver: 'human' },
    days: 30,
    by: { modelOf: choice.seat },
  });
  const cheaper = byModel.of(sonnet);
  if (cheaper.samples < 50 || cheaper.value === null) return sonnet;
  return cheaper.value < 0.9 ? opus : sonnet;
});

const classifier = H.seat('classifier', classifyRole).model(haiku);
const drafter = H.seat('drafter', draftRole).model(drafterModel).recalls(tasteJournal, experienceJournal);

const sendReply = H.command('sendReply')
  .input(z.object({ conversation: z.string(), reply: z.string() }))
  .argv(input => ['helpdesk', 'reply', input.conversation, input.reply])
  .on(local)
  .recovery('park');

const handleConversation = H.flow('handleConversation')
  .for(conversation)
  .does(async ctx => {
    const { subject, customer, lastMessage } = ctx.unit.data;
    const classified = await ctx.run(classifier, { subject, message: lastMessage });
    if (!classified.ok) return ctx.fail(classified.error);
    await ctx.update({ category: classified.value.category });
    const drafted = await ctx.run(drafter, { subject, message: lastMessage, category: classified.value.category });
    if (!drafted.ok) return ctx.fail(drafted.error);
    const decision = await ctx.halt(approval, `Reply to ${customer}:\n\n${drafted.value.reply}`, {
      category: classified.value.category,
      draft: drafted.value.reply,
    });
    if (decision.tasteNote !== undefined) {
      await ctx.remember(tasteJournal, { text: decision.tasteNote, status: 'candidate', when: { roles: [draftRole] } });
    }
    if (!decision.approved) return 'escalated';
    const delivered = await ctx.run(sendReply, { conversation: ctx.unit.key, reply: decision.reply });
    if (!delivered.ok) return ctx.fail(delivered.error);
    return 'sent';
  });

const handleEscalation = H.flow('handleEscalation')
  .for(escalation)
  .does(async ctx => {
    const decision = await ctx.halt(
      escalationHandling,
      `Conversation ${ctx.unit.data.conversation} escalated: ${ctx.unit.data.reason}`
    );
    return decision.handled ? 'escalationHandled' : 'escalationDropped';
  });

const helpdeskToken = H.env('HELPDESK_TOKEN');

const webhook = http.webhook(conversation, {
  path: '/helpdesk/events',
  secret: H.env('HELPDESK_WEBHOOK_SECRET'),
  body: z.object({
    event: z.enum(['created', 'replied', 'closed']),
    conversationId: z.string(),
    subject: z.string(),
    customer: z.string(),
    message: z.string(),
    slaDue: z.string(),
  }),
  read: body => {
    if (body.event === 'created') {
      return {
        create: { subject: body.subject, customer: body.customer, lastMessage: body.message, slaDue: body.slaDue },
        key: body.conversationId,
      };
    }
    if (body.event === 'replied') {
      return {
        update: body.conversationId,
        patch: { lastMessage: body.message },
        state: 'new',
        cancels: ['active', 'waiting'],
      };
    }
    return { update: body.conversationId, state: 'closed' };
  },
});

const missedPoll = http.poll(conversation, {
  url: 'https://helpdesk.example.com/api/conversations?status=open',
  every: { minutes: 15 },
  headers: { authorization: helpdeskToken },
  body: z.object({
    conversations: z.array(z.object({
      id: z.string(),
      subject: z.string(),
      customer: z.string(),
      message: z.string(),
      slaDue: z.string(),
    })),
  }),
  read: body =>
    body.conversations.map(item => ({
      create: { subject: item.subject, customer: item.customer, lastMessage: item.message, slaDue: item.slaDue },
      key: item.id,
    })),
});

const helpdeskStore = http.store(conversation, {
  url: 'https://helpdesk.example.com/api/conversations',
  headers: { authorization: helpdeskToken },
  stateField: 'harness_state',
});

const conversations = H.lane('conversations', conversation)
  .handler(handleConversation)
  .retries(2, { backoff: { first: { minutes: 1 }, factor: 2 }, exhausted: 'escalated' })
  .suppliers(webhook, missedPoll)
  .store(helpdeskStore)
  .maxUsdPerUnit(0.4)
  .facet(category, data => data.category);

const escalations = H.lane('escalations', escalation)
  .handler(handleEscalation)
  .retries(0, { exhausted: 'escalationDropped' });

const slaBreach = H.trigger(
  'slaBreachEscalates',
  H.on.deadline(conversation, data => new Date(data.slaDue), ['new']),
  (event, act) => act.move('escalated')
);

const escalatedOpensEscalation = H.trigger('escalatedOpensEscalation', H.on.enters(conversation, 'escalated'), (event, act) =>
  act.create(
    escalations,
    { conversation: event.unit.key, reason: `escalated at ${event.at.toISOString()}` },
    `escalation-${event.unit.key}`
  )
);

const breachAt = (unit: PendingView): number => {
  if (unit.is(escalation)) return 0;
  if (unit.is(conversation)) return new Date(unit.data.slaDue).getTime();
  return Number.MAX_SAFE_INTEGER;
};

const timeToBreach = H.policy.scheduler('timeToBreach', view => ({
  start: [...view.pending].sort((a, b) => breachAt(a) - breachAt(b)),
}));

const supervisor = claudeCode.supervisor({
  grants: [
    H.ops.readWork,
    H.ops.writeWork,
    H.ops.resolve(approval, escalationHandling, H.halts.costCeiling),
    H.ops.readMemory,
    H.ops.writeMemory,
    H.ops.curateMemory,
    H.ops.readTelemetry,
  ],
});

export const support = H.harness('supportTriage')
  .ledger(sqlite.ledger('.harness/support.db'))
  .lanes(conversations, escalations)
  .pools(pool)
  .triggers(slaBreach, escalatedOpensEscalation)
  .scheduler(timeToBreach)
  .clients(supervisor)
  .observers(markdown.board('BOARD.md'), markdown.telemetry('TELEMETRY.md'));

export const running = support.start();
