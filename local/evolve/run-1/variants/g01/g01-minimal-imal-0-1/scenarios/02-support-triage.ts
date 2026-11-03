import { z } from 'zod';
import { H } from 'harness-dsl';
import type { PendingView } from 'harness-dsl';
import * as claudeCode from 'harness-dsl/claude-code';
import * as anthropic from 'harness-dsl/anthropic';
import * as http from 'harness-dsl/http';
import * as sqlite from 'harness-dsl/sqlite';
import * as jsonl from 'harness-dsl/jsonl';
import * as shell from 'harness-dsl/shell';
import * as markdown from 'harness-dsl/markdown';

const category = z.enum(['billing', 'refund', 'shipping', 'account', 'other']);

const Conversation = H.kind('Conversation')
  .data(
    z.object({
      conversationId: z.string(),
      customer: z.string(),
      latestMessage: z.string(),
      slaDueAt: z.string(),
      category: z.string().optional(),
    })
  )
  .states(
    [
      H.state('new', 'pending'),
      H.state('classifying', 'active'),
      H.state('drafting', 'active'),
      H.state('awaiting-approval', 'active'),
      H.state('sent', 'terminal', 'success'),
      H.state('closed-by-customer', 'terminal', 'neutral'),
      H.state('escalated', 'terminal', 'failure'),
    ],
    { initial: 'new', afterFailure: 'new' }
  );

const Escalation = H.kind('Escalation')
  .data(z.object({ conversationId: z.string(), reason: z.string() }))
  .states(
    [
      H.state('open', 'pending'),
      H.state('handling', 'active'),
      H.state('resolved', 'terminal', 'success'),
      H.state('handed-off', 'terminal', 'neutral'),
    ],
    { initial: 'open', afterFailure: 'open' }
  );

const taste = H.memory('reply-taste', 'taste');
const experience = H.memory('support-experience', 'experience');

const specificThenProven = H.policy.recall('specific-then-proven', view =>
  view.items
    .filter(item => item.status === 'accepted')
    .sort((a, b) => b.specificity - a.specificity || (b.trackRecord.value ?? 0) - (a.trackRecord.value ?? 0))
    .slice(0, 10)
);

const tasteLibrary = H.library('reply-taste', taste, jsonl.memory('memory/taste.jsonl')).recall(specificThenProven);
const experienceLibrary = H.library('support-experience', experience, jsonl.memory('memory/experience.jsonl')).recall(specificThenProven);

const api = anthropic.account('anthropic-api', { apiKey: H.env('ANTHROPIC_API_KEY') });
const haiku = anthropic.model('claude-haiku-4-5');
const sonnet = anthropic.model('claude-sonnet-4-5');
const opus = anthropic.model('claude-opus-4-1');

const firstEligible = H.policy.account('first-eligible', choice => {
  const open = choice.accounts.find(view => view.eligible);
  return open === undefined ? null : open.account;
});
const apiPool = H.pool('api', [{ account: api, share: 1 }], firstEligible);

const approvalHalt = 'approve-reply';

const drafterByApproval = H.policy.model('drafter-by-approval', choice => {
  const among = { entry: 'halt' as const, halt: approvalHalt, status: 'resolved', tags: { category: choice.tags['category'] } };
  const byModel = choice.metrics.rateBy({
    among,
    count: { ...among, decision: { approved: true } },
    by: { tag: 'drafterModel' },
    days: 30,
  });
  const current = byModel[sonnet.name];
  if (current === undefined || current.samples < 50) return sonnet;
  return current.value === null || current.value >= 0.9 ? sonnet : opus;
});

const classifyRole = H.role('classifier')
  .input(z.object({ message: z.string() }))
  .output(z.object({ category }))
  .prompt(input => `Classify this customer message into one category:\n\n${input.message}`);

const draftRole = H.role('drafter')
  .input(z.object({ customer: z.string(), message: z.string(), category: z.string() }))
  .output(z.object({ reply: z.string() }))
  .prompt(input => `Draft a reply to ${input.customer} about ${input.category}:\n\n${input.message}`);

const classifier = H.agent('classifier', classifyRole).model(haiku);
const drafter = H.agent('drafter', draftRole).model(drafterByApproval).recalls(tasteLibrary, experienceLibrary);

const local = shell.local('local', { slots: 4 });

const sendReply = H.command('send-reply')
  .input(z.object({ conversationId: z.string(), reply: z.string() }))
  .argv(input => ['./bin/helpdesk-send', input.conversationId, input.reply])
  .on(local)
  .ifInterrupted('park');

const safeCategory = H.policy.rule<{ readonly category: string }, boolean>('safe-category', (input, metrics) => {
  const among = { entry: 'halt' as const, halt: approvalHalt, status: 'resolved', tags: { category: input.category } };
  const approvals = metrics.rate({ among, count: { ...among, decision: { approved: true } } });
  return approvals.samples >= 200 && approvals.hits === approvals.samples;
});

const conversationFlow = H.flow('conversation')
  .for(Conversation)
  .does(async ctx => {
    await ctx.move('classifying');
    const classified = await ctx.run(classifier, { message: ctx.unit.data.latestMessage });
    if (classified.ok === false) return ctx.fail(classified.error);
    const chosen = classified.value.category;
    ctx.tag({ category: chosen });
    await ctx.update({ category: chosen });

    await ctx.move('drafting');
    const drafted = await ctx.run(
      drafter,
      { customer: ctx.unit.data.customer, message: ctx.unit.data.latestMessage, category: chosen },
      { scope: { skills: [chosen] } }
    );
    if (drafted.ok === false) return ctx.fail(drafted.error);
    ctx.tag({ drafterModel: drafted.model ?? 'unknown' });

    let reply = drafted.value.reply;
    const safe = await ctx.decide(safeCategory, { category: chosen });
    if (safe === false) {
      await ctx.move('awaiting-approval');
      const decision = await ctx.halt({
        name: approvalHalt,
        show: reply,
        decision: z.object({
          approved: z.boolean(),
          editedReply: z.string().optional(),
          tasteNote: z.string().optional(),
        }),
      });
      if (decision.tasteNote) {
        await ctx.remember(tasteLibrary, {
          text: decision.tasteNote,
          when: { kinds: [Conversation], roles: [draftRole], skills: [chosen] },
        });
      }
      if (decision.approved === false) return 'new';
      reply = decision.editedReply ?? reply;
    }

    const sent = await ctx.run(sendReply, { conversationId: ctx.unit.data.conversationId, reply });
    if (sent.ok === false) return ctx.fail(sent.error);
    return 'sent';
  });

const escalationFlow = H.flow('escalation')
  .for(Escalation)
  .does(async ctx => {
    await ctx.move('handling');
    const outcome = await ctx.halt({
      name: 'handle-escalation',
      show: `Conversation ${ctx.unit.data.conversationId} escalated: ${ctx.unit.data.reason}`,
      decision: z.object({ resolved: z.boolean(), note: z.string() }),
    });
    return outcome.resolved ? 'resolved' : 'handed-off';
  });

const helpdeskUrl = 'https://helpdesk.example.com/api';
const helpdeskHeaders = { authorization: H.env('HELPDESK_TOKEN') };

const helpdeskWebhook = http.webhook(Conversation, {
  path: '/hooks/helpdesk',
  secret: H.env('HELPDESK_WEBHOOK_SECRET'),
  body: z.object({
    event: z.enum(['conversation.created', 'customer.replied', 'conversation.closed']),
    conversationId: z.string(),
    customer: z.string(),
    message: z.string(),
    slaDueAt: z.string(),
  }),
  read: body =>
    body.event === 'conversation.created'
      ? {
          create: {
            conversationId: body.conversationId,
            customer: body.customer,
            latestMessage: body.message,
            slaDueAt: body.slaDueAt,
          },
          key: body.conversationId,
        }
      : body.event === 'customer.replied'
        ? { update: body.conversationId, patch: { latestMessage: body.message }, state: 'new' }
        : { update: body.conversationId, state: 'closed-by-customer' },
});

const helpdeskPoll = http.poll(Conversation, {
  url: `${helpdeskUrl}/conversations?status=open`,
  every: { minutes: 15 },
  headers: helpdeskHeaders,
  body: z.object({
    open: z.array(z.object({ id: z.string(), customer: z.string(), lastMessage: z.string(), slaDueAt: z.string() })),
  }),
  read: body =>
    body.open.map(item => ({
      create: { conversationId: item.id, customer: item.customer, latestMessage: item.lastMessage, slaDueAt: item.slaDueAt },
      key: item.id,
    })),
});

const conversations = H.lane('conversations', Conversation)
  .handler(conversationFlow)
  .suppliers(helpdeskWebhook, helpdeskPoll)
  .store(http.store(Conversation, { url: `${helpdeskUrl}/conversations`, headers: helpdeskHeaders, stateField: 'harness_state' }))
  .maxUsdPerUnit(0.4);

const escalations = H.lane('escalations', Escalation).handler(escalationFlow);

const slaBreachEscalates = H.trigger(
  'sla-breach-escalates',
  H.on.deadline(Conversation, data => new Date(data.slaDueAt), ['new', 'classifying', 'drafting', 'awaiting-approval']),
  (event, act) => [
    act.create(
      escalations,
      { conversationId: event.unit.data.conversationId, reason: `SLA breached at ${event.at.toISOString()}` },
      `escalation-${event.unit.data.conversationId}`
    ),
    act.move('escalated'),
  ]
);

const timeToBreach = (unit: PendingView) => (unit.is(Conversation) ? Date.parse(unit.data.slaDueAt) : 0);

const breachFirst = H.policy.scheduler('time-to-breach', view => ({
  start: view.pending.slice().sort((a, b) => timeToBreach(a) - timeToBreach(b)),
}));

const supervisor = claudeCode.supervisor({
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
  .ledger(sqlite.ledger('support.db'))
  .lanes(conversations, escalations)
  .pools(apiPool)
  .triggers(slaBreachEscalates)
  .scheduler(breachFirst)
  .clients(supervisor)
  .observers(markdown.board('BOARD.md'), markdown.telemetry('TELEMETRY.md'));
