import { z } from 'zod';
import { H, type PendingView } from 'harness-dsl';
import * as claudeCode from 'harness-dsl/claude-code';
import * as anthropic from 'harness-dsl/anthropic';
import * as http from 'harness-dsl/http';
import * as sqlite from 'harness-dsl/sqlite';
import * as jsonl from 'harness-dsl/jsonl';
import * as shell from 'harness-dsl/shell';
import * as markdown from 'harness-dsl/markdown';

const categories = z.enum(['billing', 'shipping', 'account', 'refund', 'other']);
const categoryFacet = H.facet('category', categories);

const fresh = H.state('new', 'pending');
const sent = H.state('sent', 'waiting');
const closedByCustomer = H.state('closed', 'terminal', 'success');
const escalated = H.state('escalated', 'terminal', 'failure');
const escalationOpen = H.state('open', 'pending');
const resolved = H.state('resolved', 'terminal', 'success');
const dismissed = H.state('dismissed', 'terminal', 'neutral');

const conversation = H.kind('conversation')
  .data(
    z.object({
      customer: z.string(),
      latestMessage: z.string(),
      slaDueAt: z.string(),
      category: categories.optional(),
    })
  )
  .states(fresh, sent, closedByCustomer, escalated);

const escalation = H.kind('escalation')
  .data(z.object({ conversation: z.string(), reason: z.string() }))
  .states(escalationOpen, resolved, dismissed);

const classifierRole = H.role('classifier')
  .input(z.object({ message: z.string() }))
  .output(z.object({ category: categories }))
  .prompt(i => `Classify this customer message into one category:\n${i.message}`);

const drafterRole = H.role('drafter')
  .input(z.object({ message: z.string(), category: categories, reviewerNotes: z.string() }))
  .output(z.object({ reply: z.string() }))
  .prompt(i => `Draft a reply for a ${i.category} conversation.\nCustomer: ${i.message}\nReviewer notes: ${i.reviewerNotes}`);

const taste = H.journal('reply-taste', H.memory('reply-taste', 'taste'), jsonl.memory('memory/taste.jsonl'));
const experience = H.journal('support-experience', H.memory('support-experience', 'experience'), jsonl.memory('memory/experience.jsonl'));

const api = anthropic.account('helpdesk-api', { apiKey: H.env('ANTHROPIC_API_KEY') });
const pool = H.pool('support', [{ account: api, share: 1 }]);

const haiku = anthropic.model('claude-haiku-4-5');
const sonnet = anthropic.model('claude-sonnet-4-5');

const classifier = H.seat('classifier', classifierRole).model(haiku);
const drafter = H.seat('drafter', drafterRole).model(sonnet).recalls(taste, experience);

const approvalAbout = z.object({ category: categories });
const approvalDecision = z.object({ approved: z.boolean(), reply: z.string().optional(), notes: z.string().optional() });
type ApprovalAbout = z.infer<typeof approvalAbout>;
type ApprovalDecision = z.infer<typeof approvalDecision>;

const safeCategory = H.policy.rule<ApprovalAbout, ApprovalDecision | null>('safe-category', (about, metrics) => {
  const scoped = [categoryFacet.value(about.category)];
  const approved = metrics.count({
    of: { entry: 'halt', halt: replyApproval, status: 'resolved', resolver: 'human', decision: { approved: true }, facets: scoped },
  });
  const rejected = metrics.count({
    of: { entry: 'halt', halt: replyApproval, status: 'resolved', resolver: 'human', decision: { approved: false }, facets: scoped },
  });
  return approved >= 200 && rejected === 0 ? { approved: true } : null;
});

const replyApproval = H.halt('reply-approval', approvalDecision).about(approvalAbout).policy(safeCategory);

const overBudget = H.halt('over-budget', z.object({ continue: z.boolean() })).about(
  z.object({ spentUsd: z.number(), limitUsd: z.number() })
);

const escalationHandled = H.halt('escalation-handled', z.object({ outcome: z.enum(['resolved', 'dismissed']), note: z.string() }));

const local = shell.local('local', { slots: 4 });
const sendReply = H.command('send-reply')
  .input(z.object({ conversation: z.string(), reply: z.string() }))
  .argv(i => ['helpdesk-reply', '--conversation', i.conversation, '--body', i.reply])
  .on(local)
  .recovery('park');

const triage = H.flow('triage')
  .for(conversation)
  .does(async ctx => {
    const message = ctx.unit.data.latestMessage;
    const classified = await ctx.run(classifier, { message });
    if (!classified.ok) return ctx.fail(classified.error);
    const category = classified.value.category;
    await ctx.update({ category });
    ctx.tag(categoryFacet, category);
    let reviewerNotes = '';
    for (let draftRound = 1; draftRound <= 2; draftRound++) {
      const drafted = await ctx.run(
        drafter,
        { message, category, reviewerNotes },
        { scope: { facets: [categoryFacet.value(category)] } }
      );
      if (!drafted.ok) return ctx.fail(drafted.error);
      const decision = await ctx.halt(replyApproval, drafted.value.reply, { category });
      await ctx.grade(drafted, decision.approved ? 'accepted' : 'rejected');
      if (decision.notes) {
        await ctx.remember(taste, {
          text: `When replying in ${category} conversations, ${decision.notes}`,
          because: 'the reviewer edited a draft this way',
          when: { roles: [drafterRole], facets: [categoryFacet.value(category)] },
          status: 'candidate',
        });
      }
      if (decision.approved) {
        const posted = await ctx.run(sendReply, { conversation: ctx.unit.key, reply: decision.reply ?? drafted.value.reply });
        if (!posted.ok) return ctx.fail(posted.error);
        return 'sent';
      }
      reviewerNotes = decision.notes ?? '';
    }
    return 'escalated';
  });

const handleEscalation = H.flow('handle-escalation')
  .for(escalation)
  .does(async ctx => {
    const decision = await ctx.halt(
      escalationHandled,
      `Conversation ${ctx.unit.data.conversation} escalated: ${ctx.unit.data.reason}`
    );
    return decision.outcome;
  });

const helpdeskHeaders = { Authorization: H.env('HELPDESK_TOKEN') };

const helpdeskWebhook = http.webhook(conversation, {
  path: '/helpdesk/events',
  secret: H.env('HELPDESK_WEBHOOK_SECRET'),
  body: z.object({
    conversationId: z.string(),
    event: z.enum(['created', 'customer_replied', 'closed']),
    customer: z.string(),
    message: z.string(),
    slaDueAt: z.string(),
  }),
  read: body =>
    body.event === 'created'
      ? { create: { customer: body.customer, latestMessage: body.message, slaDueAt: body.slaDueAt }, key: body.conversationId }
      : body.event === 'closed'
        ? { update: body.conversationId, state: 'closed' }
        : { update: body.conversationId, patch: { latestMessage: body.message }, state: 'new' },
});

const helpdeskSweep = http.poll(conversation, {
  url: 'https://helpdesk.example.com/api/conversations?status=open',
  every: { minutes: 10 },
  headers: helpdeskHeaders,
  body: z.object({
    conversations: z.array(z.object({ id: z.string(), customer: z.string(), message: z.string(), slaDueAt: z.string() })),
  }),
  read: body =>
    body.conversations.map(c => ({
      create: { customer: c.customer, latestMessage: c.message, slaDueAt: c.slaDueAt },
      key: c.id,
    })),
});

const helpdeskStore = http.store(conversation, {
  url: 'https://helpdesk.example.com/api/conversations',
  headers: helpdeskHeaders,
  stateField: 'harness_state',
});

const conversationBudget = H.allowance('conversation-budget', conversation).maxUsd(0.4, overBudget);

const conversations = H.lane('conversations', conversation)
  .handler(triage)
  .suppliers(helpdeskWebhook, helpdeskSweep)
  .store(helpdeskStore)
  .allowance(conversationBudget);

const escalations = H.lane('escalations', escalation).handler(handleEscalation);

const slaBreachEscalates = H.trigger(
  'sla-breach-escalates',
  H.on.deadline(conversation, data => new Date(data.slaDueAt), ['new']),
  (_event, act) => act.move('escalated')
);

const escalatedOpensEscalation = H.trigger('escalated-opens-escalation', H.on.enters(conversation, 'escalated'), (event, act) =>
  act.create(escalations, { conversation: event.unit.key, reason: `entered escalated at ${event.at.toISOString()}` })
);

const breachAt = (unit: PendingView): number => {
  if (unit.is(escalation)) return -Infinity;
  if (unit.is(conversation)) return new Date(unit.data.slaDueAt).getTime();
  return Infinity;
};
const timeToBreach = H.policy.scheduler('time-to-breach', view => ({
  start: [...view.pending].sort((a, b) => breachAt(a) - breachAt(b)),
}));

const approvalRates = H.report('approval-rates', metrics => {
  const byCategory = metrics.rateBy({
    among: { entry: 'grade', seat: drafter },
    count: { entry: 'grade', seat: drafter, grade: 'accepted' },
    by: categoryFacet,
    days: 30,
  });
  const byModel = metrics.rateBy({
    among: { entry: 'grade', seat: drafter },
    count: { entry: 'grade', seat: drafter, grade: 'accepted' },
    by: 'model',
    days: 30,
  });
  const rows: Record<string, (typeof byModel)[string]> = {};
  for (const key in byCategory) rows[`category ${key}`] = byCategory[key];
  for (const key in byModel) rows[`model ${key}`] = byModel[key];
  return rows;
});

const supervisor = claudeCode.supervisor({
  grants: [
    H.ops.readWork,
    H.ops.writeWork,
    H.ops.resolve(replyApproval, overBudget, escalationHandled, H.halts.changed, H.halts.interrupted),
    H.ops.readMemory,
    H.ops.writeMemory,
    H.ops.readTelemetry,
  ],
});

export const harness = H.harness('support-triage')
  .ledger(sqlite.ledger('ledger.db'))
  .lanes(conversations, escalations)
  .pools(pool)
  .triggers(slaBreachEscalates, escalatedOpensEscalation)
  .scheduler(timeToBreach)
  .reports(approvalRates)
  .clients(supervisor)
  .observers(markdown.board('BOARD.md'), markdown.telemetry('TELEMETRY.md'));

export const running = harness.start();
