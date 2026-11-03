import { z } from 'zod';
import { H } from 'harness-dsl';
import type { Metrics, PendingView, SupplyOf } from 'harness-dsl';
import * as anthropic from 'harness-dsl/anthropic';
import * as claudeCode from 'harness-dsl/claude-code';
import * as http from 'harness-dsl/http';
import * as sqlite from 'harness-dsl/sqlite';
import * as jsonl from 'harness-dsl/jsonl';
import * as shell from 'harness-dsl/shell';
import * as markdown from 'harness-dsl/markdown';

const categorySchema = z.enum(['billing', 'refund', 'shipping', 'account', 'other']);
const category = H.facet('category', categorySchema);

const newConversation = H.state('new', 'pending');
const classifying = H.state('classifying', 'pending');
const sent = H.state('sent', 'terminal', 'success');
const closedByCustomer = H.state('closed-by-customer', 'terminal', 'neutral');
const escalated = H.state('escalated', 'terminal', 'failure');

export const conversation = H.kind('conversation')
  .data(z.object({ customer: z.string(), message: z.string(), slaDueAt: z.date(), category: categorySchema.optional() }))
  .states(newConversation, classifying, sent, closedByCustomer, escalated);

type ConversationSupply = SupplyOf<typeof conversation>;

const helpdeskHeaders = { Authorization: H.env('HELPDESK_TOKEN') };

const helpdeskWebhook = http.webhook(conversation, {
  path: '/helpdesk/events',
  secret: H.env('HELPDESK_WEBHOOK_SECRET'),
  body: z.object({
    event: z.enum(['created', 'replied', 'closed']),
    conversationId: z.string(),
    customer: z.string(),
    message: z.string(),
    slaDueAt: z.string(),
  }),
  read: (body): ConversationSupply =>
    body.event === 'created'
      ? { create: { customer: body.customer, message: body.message, slaDueAt: new Date(body.slaDueAt) }, key: body.conversationId }
      : body.event === 'replied'
        ? { update: body.conversationId, patch: { message: body.message }, state: 'classifying' }
        : { update: body.conversationId, state: 'closed-by-customer' },
});

const helpdeskPoll = http.poll(conversation, {
  url: 'https://helpdesk.example.com/api/conversations?status=open',
  every: { minutes: 10 },
  headers: helpdeskHeaders,
  body: z.object({
    open: z.array(z.object({ id: z.string(), customer: z.string(), message: z.string(), slaDueAt: z.string() })),
  }),
  read: body =>
    body.open.map(
      (found): ConversationSupply => ({
        create: { customer: found.customer, message: found.message, slaDueAt: new Date(found.slaDueAt) },
        key: found.id,
      })
    ),
});

const helpdeskStore = http.store(conversation, {
  url: 'https://helpdesk.example.com/api/conversations',
  headers: helpdeskHeaders,
  stateField: 'triage_state',
});

const classifyRole = H.role('classify')
  .input(z.object({ message: z.string() }))
  .output(z.object({ category: categorySchema }))
  .prompt(input => `Classify this customer message into one category:\n\n${input.message}`);

const draftRole = H.role('draft')
  .input(z.object({ customer: z.string(), message: z.string(), category: categorySchema, notes: z.array(z.string()) }))
  .output(z.object({ reply: z.string() }))
  .prompt(input => `Draft a reply to ${input.customer} about a ${input.category} matter.\n\n${input.message}\n\nReviewer notes so far:\n${input.notes.join('\n')}`);

const haiku = anthropic.model('claude-haiku-4-5');
const sonnet = anthropic.model('claude-sonnet-4-5');
const apiPool = H.pool('support-api', [{ account: anthropic.account('support-api', { apiKey: H.env('ANTHROPIC_API_KEY') }), share: 1 }]);

const supportTaste = H.journal('support-taste', H.memory('support-taste', 'taste'), jsonl.memory('memory/support-taste.jsonl'));
const supportExperience = H.journal('support-experience', H.memory('support-experience', 'experience'), jsonl.memory('memory/support-experience.jsonl'));

const classifier = H.seat('classifier', classifyRole).model(haiku);
export const drafter = H.seat('drafter', draftRole).model(sonnet).recalls(supportTaste, supportExperience);

const approvalAbout = z.object({ category: categorySchema, reply: z.string() });
const approvalDecision = z.object({ approve: z.boolean(), editedReply: z.string().optional(), notes: z.string().optional() });
type ApprovalAbout = z.infer<typeof approvalAbout>;
type ApprovalDecision = z.infer<typeof approvalDecision>;

export const approval = H.halt('reply-approval', approvalDecision)
  .about(approvalAbout)
  .policy(
    H.policy.rule('safe-category-auto-approve', (about: ApprovalAbout, metrics: Metrics): ApprovalDecision | null => {
      const inCategory = [category.value(about.category)];
      const humanDecisions = metrics.rate({
        among: { ...approval.resolved({ by: 'human' }), facets: inCategory },
        count: { ...approval.resolved({ match: { approve: true }, by: 'human' }), facets: inCategory },
      });
      return humanDecisions.samples >= 200 && humanDecisions.hits === humanDecisions.samples ? { approve: true } : null;
    })
  );

const costCeiling = H.halt('conversation-cost-ceiling', z.object({ continue: z.boolean() })).about(
  z.object({ spentUsd: z.number(), limitUsd: z.number() })
);

const local = shell.local('local', { slots: 4 });

const sendReply = H.command('send-reply')
  .input(z.object({ conversationId: z.string(), reply: z.string() }))
  .argv(input => ['helpdesk-send', '--conversation', input.conversationId, '--body', input.reply])
  .on(local)
  .recovery('park');

const triage = H.flow('triage')
  .for(conversation)
  .does(async ctx => {
    const classified = await ctx.call(classifier, { message: ctx.unit.data.message });
    if (!classified.ok) return ctx.fail(classified.error);
    const found = classified.value.category;
    ctx.tag(category, found);
    await ctx.update({ category: found });
    let notes: string[] = [];
    for (;;) {
      const drafted = await ctx.call(
        drafter,
        { customer: ctx.unit.data.customer, message: ctx.unit.data.message, category: found, notes },
        { scope: { facets: [category.value(found)] } }
      );
      if (!drafted.ok) return ctx.fail(drafted.error);
      const decision = await ctx.halt(approval, `Reply to ${ctx.unit.data.customer}`, { category: found, reply: drafted.value.reply });
      if (decision.approve) {
        const delivered = await ctx.call(sendReply, { conversationId: ctx.unit.key, reply: decision.editedReply ?? drafted.value.reply });
        return delivered.ok ? 'sent' : ctx.fail(delivered.error);
      }
      notes = [...notes, decision.notes ?? 'Rejected without notes.'];
    }
  });

export const conversations = H.lane('conversations', conversation)
  .handler(triage.maxUsdPerUnit(0.4, costCeiling))
  .suppliers(helpdeskWebhook, helpdeskPoll)
  .store(helpdeskStore)
  .retry(H.retry('conversation-retries', { retries: 2, backoff: { initialMs: 30_000, factor: 2 } }), 'escalated');

const raised = H.state('raised', 'pending');
const handled = H.state('handled', 'terminal', 'success');

export const escalation = H.kind('escalation')
  .data(z.object({ conversationId: z.string(), customer: z.string(), reason: z.string() }))
  .states(raised, handled);

const escalationReview = H.halt('escalation-review', z.object({ note: z.string() }));

const humanEscalation = H.flow('human-escalation')
  .for(escalation)
  .does(async ctx => {
    await ctx.halt(escalationReview, `Escalated conversation ${ctx.unit.data.conversationId} with ${ctx.unit.data.customer}: ${ctx.unit.data.reason}`);
    return 'handled';
  });

export const escalations = H.lane('escalations', escalation).handler(humanEscalation);

const slaBreach = H.trigger(
  'sla-breach',
  H.on.deadline(conversation, data => data.slaDueAt, ['new', 'classifying']),
  (_breach, act) => act.move('escalated')
);

const escalateConversation = H.trigger('escalate-conversation', H.on.enters(conversation, 'escalated'), (event, act) =>
  act.create(
    escalations,
    { conversationId: event.unit.key, customer: event.unit.data.customer, reason: 'SLA breached or retries exhausted' },
    `escalation-${event.unit.key}`
  )
);

const timeToBreach = H.policy.scheduler('time-to-breach', view => {
  const breachAt = (unit: PendingView): number => (unit.is(conversation) ? unit.data.slaDueAt.getTime() : Number.MAX_SAFE_INTEGER);
  return { start: [...view.pending].sort((a, b) => breachAt(a) - breachAt(b)) };
});

export const approvalRates = H.report('approval-rates', metrics => ({
  byCategory: metrics.rateBy({
    among: approval.resolved(),
    count: approval.resolved({ match: { approve: true } }),
    by: category,
    days: 30,
  }),
  byModel: metrics.rateBy({
    among: approval.resolved(),
    count: approval.resolved({ match: { approve: true } }),
    by: { modelOf: drafter },
    days: 30,
  }),
}));

const reviewer = claudeCode.supervisor({
  grants: [
    H.ops.readWork,
    H.ops.writeWork,
    H.ops.resolve(approval, costCeiling, escalationReview, H.parked),
    H.ops.readMemory,
    H.ops.writeMemory,
    H.ops.readTelemetry,
  ],
});

export const supportTriage = H.harness('support-triage')
  .ledger(sqlite.ledger('support.db'))
  .lanes(conversations, escalations)
  .pools(apiPool)
  .triggers(slaBreach, escalateConversation)
  .scheduler(timeToBreach)
  .reports(approvalRates)
  .clients(reviewer)
  .observers(markdown.board('BOARD.md'), markdown.telemetry('TELEMETRY.md'));
