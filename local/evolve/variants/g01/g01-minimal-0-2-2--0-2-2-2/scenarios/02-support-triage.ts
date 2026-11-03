import { z } from 'zod';
import { H } from 'harness-dsl';
import type { Metrics, PendingView } from 'harness-dsl';
import * as anthropic from 'harness-dsl/anthropic';
import * as claude from 'harness-dsl/claude-code';
import * as http from 'harness-dsl/http';
import * as sqlite from 'harness-dsl/sqlite';
import * as jsonl from 'harness-dsl/jsonl';
import * as shell from 'harness-dsl/shell';
import * as markdown from 'harness-dsl/markdown';

const fresh = H.state('new', 'pending');
const classifying = H.state('classifying', 'pending');
const sent = H.state('sent', 'waiting');
const closedByCustomer = H.state('closed', 'terminal', 'success');
const escalated = H.state('escalated', 'terminal', 'neutral');

const Conversation = H.kind('Conversation')
  .data(z.object({
    customer: z.string(),
    messages: z.array(z.string()),
    slaDue: z.string(),
    category: z.string().optional(),
  }))
  .states(fresh, classifying, sent, closedByCustomer, escalated);

const escalationOpen = H.state('open', 'pending');
const escalationResolved = H.state('resolved', 'terminal', 'success');

const Escalation = H.kind('Escalation')
  .data(z.object({ conversation: z.string(), reason: z.string() }))
  .states(escalationOpen, escalationResolved);

const category = H.facet('category', z.string());

const taste = H.memory('taste', 'taste');
const experience = H.memory('experience', 'experience');
const tasteJournal = H.journal('taste', taste, jsonl.memory('.harness/taste.jsonl'));
const experienceJournal = H.journal('experience', experience, jsonl.memory('.harness/experience.jsonl'));

const approvalDecision = z.object({
  verdict: z.enum(['approve', 'edit', 'reject']),
  text: z.string().optional(),
  note: z.string().optional(),
});
const approvalAbout = z.object({ category: z.string(), draft: z.string() });
type ApprovalDecision = z.infer<typeof approvalDecision>;
type ApprovalAbout = z.infer<typeof approvalAbout>;

const safeCategory = H.policy.rule(
  'safe-category',
  (about: ApprovalAbout, metrics: Metrics): ApprovalDecision | null => {
    const among = {
      entry: 'halt' as const,
      halt: replyApproval,
      status: 'resolved',
      resolver: 'human' as const,
      facets: [category.value(about.category)],
    };
    const approvals = metrics.rate({ among, count: { ...among, decision: { verdict: 'approve' } } });
    const rejections = metrics.rate({ among, count: { ...among, decision: { verdict: 'reject' } } });
    return approvals.hits >= 200 && rejections.hits === 0 ? { verdict: 'approve' } : null;
  }
);

const replyApproval = H.halt('reply-approval', approvalDecision).about(approvalAbout).policy(safeCategory);

const costCeiling = H.halt('cost-ceiling', z.object({ continue: z.boolean() }))
  .about(z.object({ spentUsd: z.number(), limitUsd: z.number() }));

const escalationHandled = H.halt('escalation-handled', z.object({ resolution: z.string() }))
  .about(z.object({ conversation: z.string(), reason: z.string() }));

const haiku = anthropic.model('claude-haiku-4-5');
const sonnet = anthropic.model('claude-sonnet-4-5');
const opus = anthropic.model('claude-opus-4-1');

const drafterModel = H.policy.model('drafter-model', choice => {
  const among = { entry: 'halt' as const, halt: replyApproval, status: 'resolved', resolver: 'human' as const };
  const byModel = choice.metrics.rateBy({
    among,
    count: { ...among, decision: { verdict: 'approve' } },
    by: { modelOf: choice.seat },
    days: 14,
  });
  const sonnetRate = byModel[sonnet.name];
  const opusRate = byModel[opus.name];
  const sonnetSamples = sonnetRate ? sonnetRate.samples : 0;
  const opusSamples = opusRate ? opusRate.samples : 0;
  if (sonnetSamples < 30) return sonnet;
  if (opusSamples < 30) return opus;
  return (opusRate?.value ?? 0) > (sonnetRate?.value ?? 0) ? opus : sonnet;
});

const classifierRole = H.role('classifier')
  .input(z.object({ messages: z.array(z.string()) }))
  .output(z.object({ category: z.string() }))
  .prompt(input => `Classify this support conversation into one category.\n\n${input.messages.join('\n---\n')}`);

const drafterRole = H.role('drafter')
  .input(z.object({ messages: z.array(z.string()), category: z.string(), notes: z.string() }))
  .output(z.object({ reply: z.string() }))
  .prompt(input => `Draft a reply for a ${input.category} conversation.\nReviewer notes: ${input.notes}\n\n${input.messages.join('\n---\n')}`);

const classifier = H.seat('classifier', classifierRole).model(haiku);
const drafter = H.seat('drafter', drafterRole).model(drafterModel).recalls(tasteJournal, experienceJournal);

const local = shell.local('local', { slots: 4 });

const sendReply = H.command('send-reply')
  .input(z.object({ conversation: z.string(), text: z.string() }))
  .argv(input => ['helpdesk-reply', '--token', H.env('HELPDESK_TOKEN'), input.conversation, input.text])
  .on(local)
  .recovery('park');

const triage = H.flow('triage')
  .for(Conversation)
  .does(async ctx => {
    const messages = ctx.unit.data.messages;
    const classified = await ctx.run(classifier, { messages });
    if (!classified.ok) return ctx.fail(classified.error);
    const kind = classified.value.category;
    ctx.tag(category, kind);
    await ctx.update({ category: kind });
    let notes = '';
    for (let round = 0; round < 3; round++) {
      const draft = await ctx.run(drafter, { messages, category: kind, notes });
      if (!draft.ok) return ctx.fail(draft.error);
      const decision = await ctx.halt(replyApproval, draft.value.reply, { category: kind, draft: draft.value.reply });
      if (decision.verdict === 'reject') {
        notes = decision.note ?? '';
        continue;
      }
      if (decision.verdict === 'edit' && decision.note) {
        await ctx.remember(tasteJournal, {
          text: decision.note,
          when: { facets: [category.value(kind)] },
          status: 'candidate',
        });
      }
      const text = decision.verdict === 'edit' && decision.text ? decision.text : draft.value.reply;
      const delivered = await ctx.run(sendReply, { conversation: ctx.unit.key, text });
      if (!delivered.ok) return ctx.fail(delivered.error);
      return 'sent';
    }
    return 'escalated';
  });

const escalationFlow = H.flow('escalation')
  .for(Escalation)
  .does(async ctx => {
    await ctx.halt(escalationHandled, `Escalated conversation ${ctx.unit.data.conversation}: ${ctx.unit.data.reason}`, ctx.unit.data);
    return 'resolved';
  });

const helpdeskHeaders = { Authorization: H.env('HELPDESK_TOKEN') };

const helpdeskWebhook = http.webhook(Conversation, {
  path: '/helpdesk',
  secret: H.env('HELPDESK_WEBHOOK_SECRET'),
  body: z.object({
    event: z.enum(['created', 'replied', 'closed']),
    conversation: z.object({ id: z.string(), customer: z.string(), messages: z.array(z.string()), slaDue: z.string() }),
  }),
  read: body => {
    const c = body.conversation;
    if (body.event === 'created') {
      return { create: { customer: c.customer, messages: c.messages, slaDue: c.slaDue }, key: c.id };
    }
    if (body.event === 'closed') return { update: c.id, state: 'closed' };
    return { update: c.id, patch: { messages: c.messages }, state: 'classifying' };
  },
});

const helpdeskPoll = http.poll(Conversation, {
  url: 'https://helpdesk.example.com/api/conversations?status=open',
  every: { minutes: 10 },
  headers: helpdeskHeaders,
  body: z.object({
    conversations: z.array(z.object({ id: z.string(), customer: z.string(), messages: z.array(z.string()), slaDue: z.string() })),
  }),
  read: body =>
    body.conversations.map((c): { create: { customer: string; messages: string[]; slaDue: string }; key: string } => ({
      create: { customer: c.customer, messages: c.messages, slaDue: c.slaDue },
      key: c.id,
    })),
});

const conversations = H.lane('conversations', Conversation)
  .handler(triage)
  .suppliers(helpdeskWebhook, helpdeskPoll)
  .store(http.store(Conversation, {
    url: 'https://helpdesk.example.com/api/conversations',
    headers: helpdeskHeaders,
    stateField: 'harness_status',
  }))
  .maxUsdPerUnit(0.4, costCeiling);

const escalations = H.lane('escalations', Escalation).handler(escalationFlow);

const slaBreach = H.trigger(
  'sla-breach-escalates',
  H.on.deadline(Conversation, data => new Date(data.slaDue), ['new', 'classifying']),
  (_event, act) => act.move('escalated')
);

const escalatedCreatesEscalation = H.trigger(
  'escalated-creates-escalation',
  H.on.enters(Conversation, 'escalated'),
  (event, act) => act.create(escalations, { conversation: event.unit.key, reason: 'escalated' }, event.unit.key)
);

const timeToBreach = H.policy.scheduler('time-to-breach', view => {
  const breachAt = (unit: PendingView): number => {
    if (unit.is(Escalation)) return Number.NEGATIVE_INFINITY;
    if (unit.is(Conversation)) return new Date(unit.data.slaDue).getTime();
    return Number.POSITIVE_INFINITY;
  };
  return { start: [...view.pending].sort((a, b) => breachAt(a) - breachAt(b)) };
});

const reviewer = claude.supervisor({
  grants: [
    H.ops.readWork,
    H.ops.resolve(replyApproval, costCeiling, escalationHandled),
    H.ops.writeMemory,
    H.ops.readTelemetry,
  ],
});

export const harness = H.harness('support-triage')
  .ledger(sqlite.ledger('.harness/ledger.db'))
  .lanes(conversations, escalations)
  .pools(H.pool('anthropic', [{ account: anthropic.account('api', { apiKey: H.env('ANTHROPIC_API_KEY') }), share: 1 }]))
  .triggers(slaBreach, escalatedCreatesEscalation)
  .scheduler(timeToBreach)
  .clients(reviewer)
  .observers(markdown.board('.harness/board.md'), markdown.telemetry('.harness/telemetry.md'));

export const running = harness.start();
