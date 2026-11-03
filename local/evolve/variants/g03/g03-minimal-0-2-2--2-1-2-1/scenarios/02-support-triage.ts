import { z } from 'zod';
import { H } from 'harness-dsl';
import type { EntryFilter, Metrics, PendingView } from 'harness-dsl';
import * as claude from 'harness-dsl/claude-code';
import * as anthropic from 'harness-dsl/anthropic';
import * as http from 'harness-dsl/http';
import * as sqlite from 'harness-dsl/sqlite';
import * as jsonl from 'harness-dsl/jsonl';
import * as shell from 'harness-dsl/shell';
import * as markdown from 'harness-dsl/markdown';

const categorySchema = z.enum(['billing', 'refund', 'technical', 'account', 'other']);
const categoryFacet = H.facet('category', categorySchema);

const fresh = H.state('new', 'pending');
const classifying = H.state('classifying', 'pending');
const sent = H.state('sent', 'waiting');
const closedByCustomer = H.state('closed-by-customer', 'terminal', 'success');
const escalated = H.state('escalated', 'terminal', 'neutral');

const escalationOpen = H.state('open', 'pending');
const escalationResolved = H.state('resolved', 'terminal', 'success');

export const conversation = H.kind('Conversation')
  .data(
    z.object({
      subject: z.string(),
      lastMessage: z.string(),
      customer: z.string(),
      slaDueAt: z.string(),
      category: categorySchema.optional(),
    })
  )
  .states(fresh, classifying, sent, closedByCustomer, escalated);

export const escalation = H.kind('Escalation')
  .data(z.object({ conversation: z.string(), reason: z.string() }))
  .states(escalationOpen, escalationResolved);

const classifying_ = H.role('classifier')
  .input(z.object({ subject: z.string(), message: z.string() }))
  .output(z.object({ category: categorySchema }))
  .prompt(input => `Classify this support conversation.\n\nSubject: ${input.subject}\n\n${input.message}`);

const drafting = H.role('drafter')
  .input(
    z.object({
      subject: z.string(),
      message: z.string(),
      category: categorySchema,
      reviewerNotes: z.string().optional(),
    })
  )
  .output(z.object({ reply: z.string() }))
  .prompt(input =>
    [
      `Draft a reply to this ${input.category} conversation.`,
      `Subject: ${input.subject}`,
      input.message,
      input.reviewerNotes !== undefined ? `The reviewer rejected the last draft: ${input.reviewerNotes}` : '',
    ].join('\n\n')
  );

const tasteMemory = H.memory('reply-taste', 'taste');
const experienceMemory = H.memory('support-experience', 'experience');
const taste = H.journal('reply-taste', tasteMemory, jsonl.memory('memory/taste.jsonl'));
const experience = H.journal('support-experience', experienceMemory, jsonl.memory('memory/experience.jsonl'));

const approvalAbout = z.object({ category: categorySchema, draft: z.string() });
const approvalDecision = z.object({
  verdict: z.enum(['approve', 'reject']),
  editedReply: z.string().optional(),
  notes: z.string().optional(),
  tasteNote: z.string().optional(),
});
type ApprovalAbout = z.infer<typeof approvalAbout>;
type ApprovalDecision = z.infer<typeof approvalDecision>;

const humanResolved = (extra: EntryFilter): EntryFilter => ({
  entry: 'halt',
  halt: replyApproval,
  status: 'resolved',
  resolver: 'human',
  ...extra,
});

const safeApprovalSamples = 200;

const safeCategory = H.policy.rule(
  'auto-approve-safe-category',
  (about: ApprovalAbout, metrics: Metrics): ApprovalDecision | null => {
    const inCategory = { facets: [categoryFacet.of(about.category)] };
    const record = metrics.rate({
      among: humanResolved(inCategory),
      count: humanResolved({ ...inCategory, decision: { verdict: 'approve' } }),
    });
    return record.samples >= safeApprovalSamples && record.hits === record.samples ? { verdict: 'approve' } : null;
  }
);

const replyApproval = H.halt('reply-approval', approvalDecision).about(approvalAbout).policy(safeCategory);

const escalationHandling = H.halt('escalation-handling', z.object({ resolution: z.string() }));

const haiku = anthropic.model('claude-haiku-4-5');
const sonnet = anthropic.model('claude-sonnet-4-5');
const opus = anthropic.model('claude-opus-4-1');

const drafterApprovalFloor = 0.8;
const drafterMinSamples = 100;

const drafterModel = H.policy.model('drafter-by-approval-rate', [sonnet, opus], choice => {
  const byModel = choice.metrics.rateBy({
    among: humanResolved({}),
    count: humanResolved({ decision: { verdict: 'approve' } }),
    by: { modelOf: choice.seat },
    days: 30,
  });
  const current = byModel.of(sonnet);
  if (current.samples < drafterMinSamples || current.value === null) return sonnet;
  return current.value < drafterApprovalFloor ? opus : sonnet;
});

const helpdeskAccount = anthropic.account('anthropic-support', { apiKey: H.env('ANTHROPIC_API_KEY') });
const supportPool = H.pool('support', [{ account: helpdeskAccount, share: 1 }]);

const classifier = H.seat('classifier', classifying_).model(haiku);
const drafter = H.seat('drafter', drafting).model(drafterModel).recalls(taste, experience);

const local = shell.local('local', { slots: 4 });

const sendReply = H.command('send-reply')
  .input(z.object({ conversation: z.string(), text: z.string() }))
  .argv(input => ['helpdesk-send', '--conversation', input.conversation, '--text', input.text])
  .recovery('park')
  .on(local);

const triage = H.flow('triage')
  .for(conversation)
  .does(async ctx => {
    const { subject, lastMessage } = ctx.unit.data;
    const classified = await ctx.run(classifier, { subject, message: lastMessage });
    if (!classified.ok) return ctx.fail(classified.error);
    const category = classified.value.category;
    await ctx.update({ category });
    let reviewerNotes: string | undefined;
    for (;;) {
      const drafted = await ctx.run(drafter, { subject, message: lastMessage, category, reviewerNotes });
      if (!drafted.ok) return ctx.fail(drafted.error);
      const decision = await ctx.halt(replyApproval, drafted.value.reply, { category, draft: drafted.value.reply });
      if (decision.tasteNote !== undefined) {
        await ctx.remember(taste, { text: decision.tasteNote, when: { roles: [drafting] }, status: 'accepted' });
      }
      if (decision.verdict === 'approve') {
        const delivered = await ctx.run(sendReply, {
          conversation: ctx.unit.key,
          text: decision.editedReply ?? drafted.value.reply,
        });
        if (!delivered.ok) return ctx.fail(delivered.error);
        return 'sent';
      }
      reviewerNotes = decision.notes;
    }
  });

const handleEscalation = H.flow('handle-escalation')
  .for(escalation)
  .does(async ctx => {
    await ctx.halt(escalationHandling, `Conversation ${ctx.unit.data.conversation} escalated: ${ctx.unit.data.reason}`);
    return 'resolved';
  });

const helpdeskToken = H.env('HELPDESK_TOKEN');

const helpdeskEvent = z.object({
  event: z.enum(['conversation.created', 'customer.replied', 'conversation.closed']),
  conversationId: z.string(),
  subject: z.string(),
  message: z.string(),
  customer: z.string(),
  slaDueAt: z.string(),
});

const helpdeskWebhook = http.webhook(conversation, {
  path: '/hooks/helpdesk',
  secret: H.env('HELPDESK_WEBHOOK_SECRET'),
  body: helpdeskEvent,
  read: body => {
    if (body.event === 'conversation.created') {
      return {
        create: { subject: body.subject, lastMessage: body.message, customer: body.customer, slaDueAt: body.slaDueAt },
        key: body.conversationId,
      };
    }
    if (body.event === 'customer.replied') {
      return { update: body.conversationId, patch: { lastMessage: body.message }, state: 'classifying' };
    }
    return { update: body.conversationId, state: 'closed-by-customer' };
  },
});

const helpdeskPoll = http.poll(conversation, {
  url: 'https://helpdesk.example.com/api/conversations?status=open',
  every: { minutes: 10 },
  headers: { authorization: helpdeskToken },
  body: z.object({
    conversations: z.array(
      z.object({ id: z.string(), subject: z.string(), message: z.string(), customer: z.string(), slaDueAt: z.string() })
    ),
  }),
  read: body =>
    body.conversations.map(found => ({
      create: { subject: found.subject, lastMessage: found.message, customer: found.customer, slaDueAt: found.slaDueAt },
      key: found.id,
    })),
});

const helpdeskStore = http.store(conversation, {
  url: 'https://helpdesk.example.com/api/conversations',
  headers: { authorization: helpdeskToken },
  stateField: 'harness_state',
});

export const conversationsLane = H.lane('conversations', conversation)
  .handler(triage, { retries: 2, backoff: { first: { minutes: 1 }, factor: 2 }, exhausted: H.halts.exhausted })
  .suppliers(helpdeskWebhook, helpdeskPoll)
  .store(helpdeskStore)
  .maxUsdPerUnit(0.4)
  .facet(categoryFacet, data => data.category);

export const escalationsLane = H.lane('escalations', escalation)
  .handler(handleEscalation, { exhausted: H.halts.exhausted })
  .suppliers(H.operator);

const slaBreachEscalates = H.trigger(
  'sla-breach-escalates',
  H.on.deadline(conversation, data => new Date(data.slaDueAt), ['new', 'classifying']),
  (event, act) => [
    act.create(
      escalationsLane,
      { conversation: event.unit.key, reason: `SLA breached at ${event.at.toISOString()}` },
      `escalation-${event.unit.key}`
    ),
    act.move('escalated'),
  ]
);

const timeToBreachMs = (unit: PendingView, now: Date): number =>
  unit.is(conversation) ? Date.parse(unit.data.slaDueAt) - now.getTime() : Number.NEGATIVE_INFINITY;

const breachFirst = H.policy.scheduler('escalations-then-time-to-breach', view => ({
  start: [...view.pending].sort((a, b) => timeToBreachMs(a, view.now) - timeToBreachMs(b, view.now)),
}));

const reviewer = claude.supervisor({
  grants: [
    H.ops.readWork,
    H.ops.writeWork,
    H.ops.resolve(replyApproval, escalationHandling, H.halts.costCeiling, H.halts.exhausted, H.halts.interrupted, H.halts.definitionChanged),
    H.ops.readMemory,
    H.ops.writeMemory,
    H.ops.curateMemory,
    H.ops.readTelemetry,
  ],
});

export const supportTriage = H.harness('support-triage')
  .ledger(sqlite.ledger('.harness/support.sqlite'))
  .lanes(conversationsLane, escalationsLane)
  .pools(supportPool)
  .triggers(slaBreachEscalates)
  .scheduler(breachFirst)
  .clients(reviewer)
  .observers(markdown.board('BOARD.md'), markdown.telemetry('TELEMETRY.md'));
