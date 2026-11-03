import { H, type PendingView } from 'harness-dsl';
import * as claudeCode from 'harness-dsl/claude-code';
import * as anthropic from 'harness-dsl/anthropic';
import * as http from 'harness-dsl/http';
import * as sqlite from 'harness-dsl/sqlite';
import * as jsonl from 'harness-dsl/jsonl';
import * as shell from 'harness-dsl/shell';
import * as markdown from 'harness-dsl/markdown';
import { z } from 'zod';

const fresh = H.state('new', 'pending');
const classifying = H.state('classifying', 'pending');
const sent = H.state('sent', 'terminal', 'success');
const closedByCustomer = H.state('closed-by-customer', 'terminal', 'neutral');
const escalated = H.state('escalated', 'terminal', 'neutral');
const open = H.state('open', 'pending');
const handled = H.state('handled', 'terminal', 'success');

const conversation = H.kind('conversation')
  .data(z.object({ subject: z.string(), lastMessage: z.string(), slaDueAt: z.string() }))
  .states(fresh, classifying, sent, closedByCustomer, escalated);
const escalation = H.kind('escalation')
  .data(z.object({ conversation: z.string(), reason: z.string() }))
  .states(open, handled);

const categorySchema = z.enum(['billing', 'refund', 'technical', 'account', 'other']);
const categoryFacet = H.facet('category', categorySchema);

const classifyRole = H.role('classifier')
  .input(z.object({ subject: z.string(), message: z.string() }))
  .output(z.object({ category: categorySchema }))
  .prompt((i) => `Classify this support message.\nSubject: ${i.subject}\n\n${i.message}`);
const draftRole = H.role('drafter')
  .input(z.object({ subject: z.string(), message: z.string(), category: categorySchema, notes: z.string() }))
  .output(z.object({ reply: z.string() }))
  .prompt((i) => `Draft a ${i.category} reply.\nSubject: ${i.subject}\n\n${i.message}\n\nReviewer notes on the last draft: ${i.notes}`);

const taste = H.journal('reply-taste', H.memory('taste', 'taste'), jsonl.memory('memory/taste.jsonl'));
const experience = H.journal('support-experience', H.memory('experience', 'experience'), jsonl.memory('memory/experience.jsonl'));

const cheap = anthropic.model('claude-haiku-4-5');
const stronger = anthropic.model('claude-sonnet-4-5');

const classifier = H.seat('classifier', classifyRole).model(cheap);
const drafter = H.seat('drafter', draftRole).model(stronger).recalls(taste, experience);

const approvalAbout = z.object({ category: categorySchema, draft: z.string() });
const approvalDecision = z.object({ approved: z.boolean(), reply: z.string().optional(), notes: z.string().optional() });
type ApprovalAbout = z.infer<typeof approvalAbout>;
type Approval = z.infer<typeof approvalDecision>;

const replyApproval = H.halt('reply-approval', approvalDecision).about(approvalAbout);
const safeCategory = H.policy.rule<ApprovalAbout, Approval | null>('safe-category', (about, metrics) => {
  const inCategory = [categoryFacet.value(about.category)];
  const record = metrics.rate({
    among: { ...replyApproval.resolved(undefined, 'human'), facets: inCategory },
    count: { ...replyApproval.resolved({ approved: true }, 'human'), facets: inCategory },
  });
  return record.samples >= 200 && record.hits === record.samples ? { approved: true } : null;
});
const approval = replyApproval.policy(safeCategory);

const costCeiling = H.halt('conversation-cost-ceiling', z.object({ continue: z.boolean() }))
  .about(z.object({ spentUsd: z.number(), limitUsd: z.number() }));
const escalationHandled = H.halt('escalation-handled', z.object({ resolution: z.string() }))
  .about(z.object({ conversation: z.string(), reason: z.string() }));

const local = shell.local('local', { slots: 4 });
const sendReply = H.command('send-reply')
  .input(z.object({ conversationId: z.string(), reply: z.string() }))
  .argv((i) => ['helpdesk-cli', 'reply', i.conversationId, i.reply])
  .on(local)
  .recovery('park');

const triage = H.flow('triage')
  .for(conversation)
  .does(async (ctx) => {
    const { subject, lastMessage } = ctx.unit.data;
    const classified = await ctx.run(classifier, { subject, message: lastMessage });
    if (!classified.ok) return ctx.fail(classified.error);
    const category = classified.value.category;
    ctx.tag(categoryFacet, category);
    let notes = '';
    for (let round = 1; round <= 3; round += 1) {
      const draft = await ctx.run(drafter, { subject, message: lastMessage, category, notes });
      if (!draft.ok) return ctx.fail(draft.error);
      const decision = await ctx.halt(approval, `Reply to "${subject}" (${category})`, { category, draft: draft.value.reply });
      if (decision.approved) {
        const posted = await ctx.run(sendReply, { conversationId: ctx.unit.key, reply: decision.reply ?? draft.value.reply });
        if (!posted.ok) return ctx.fail(posted.error);
        return 'sent';
      }
      notes = decision.notes ?? '';
      if (notes !== '') {
        await ctx.remember(taste, {
          text: `When drafting a ${category} reply, ${notes}`,
          because: 'the reviewer rejected a draft with this note',
          when: { roles: [draftRole], facets: [categoryFacet.value(category)] },
          status: 'candidate',
        });
      }
    }
    return 'escalated';
  });

const handleEscalation = H.flow('handle-escalation')
  .for(escalation)
  .does(async (ctx) => {
    await ctx.halt(escalationHandled, `Escalated conversation ${ctx.unit.data.conversation}`, {
      conversation: ctx.unit.data.conversation,
      reason: ctx.unit.data.reason,
    });
    return 'handled';
  });

const helpdeskHeaders = { 'X-Api-Key': H.env('HELPDESK_API_KEY') };
const defaultSlaMs = 4 * 3600000;

const helpdeskWebhook = http.webhook(conversation, {
  path: '/hooks/helpdesk',
  secret: H.env('HELPDESK_WEBHOOK_SECRET'),
  body: z.object({
    event: z.enum(['created', 'customer-replied', 'closed']),
    conversationId: z.string(),
    subject: z.string().optional(),
    message: z.string(),
    slaDueAt: z.string().optional(),
  }),
  read: (body) => {
    if (body.event === 'created') {
      return {
        create: {
          subject: body.subject ?? '(no subject)',
          lastMessage: body.message,
          slaDueAt: body.slaDueAt ?? new Date(Date.now() + defaultSlaMs).toISOString(),
        },
        key: body.conversationId,
      };
    }
    if (body.event === 'customer-replied') {
      return { update: body.conversationId, patch: { lastMessage: body.message }, state: 'classifying' };
    }
    return { update: body.conversationId, state: 'closed-by-customer' };
  },
});

const helpdeskPoll = http.poll(conversation, {
  url: 'https://helpdesk.example.com/api/conversations?status=open',
  every: { minutes: 10 },
  headers: helpdeskHeaders,
  body: z.object({
    conversations: z.array(z.object({ id: z.string(), subject: z.string(), lastMessage: z.string(), slaDueAt: z.string() })),
  }),
  read: (body) =>
    body.conversations.map((c) => ({
      create: { subject: c.subject, lastMessage: c.lastMessage, slaDueAt: c.slaDueAt },
      key: c.id,
    })),
});

const helpdeskStore = http.store(conversation, {
  url: 'https://helpdesk.example.com/api/conversations',
  headers: helpdeskHeaders,
  stateField: 'harness_state',
});

const conversations = H.lane('conversations', conversation)
  .handler(triage)
  .suppliers(helpdeskWebhook, helpdeskPoll)
  .store(helpdeskStore)
  .maxUsdPerUnit(0.4, costCeiling)
  .retry(H.retry({ times: 2 }), 'escalated');
const escalations = H.lane('escalations', escalation).handler(handleEscalation);

const sla = H.deadline('sla', conversation, (data) => new Date(data.slaDueAt), ['new', 'classifying']);

const slaBreach = H.trigger('sla-breach-escalates', H.on.deadline(sla), (_event, act) => act.move('escalated'));
const escalationOpens = H.trigger('escalated-opens-escalation', H.on.enters(conversation, 'escalated'), (event, act) =>
  act.create(
    escalations,
    { conversation: event.unit.key, reason: `Conversation "${event.unit.data.subject}" escalated at ${event.at.toISOString()}` },
    `escalation-${event.unit.key}`
  )
);

const timeToBreach = (unit: PendingView) => (unit.is(conversation) ? Date.parse(unit.data.slaDueAt) : 0);
const breachFirst = H.policy.scheduler('escalations-then-time-to-breach', (view) => ({
  start: [...view.pending].sort((a, b) => timeToBreach(a) - timeToBreach(b)),
}));

const approvals = H.report('approvals', (metrics) => ({
  ...Object.fromEntries(
    Object.entries(
      metrics.rateBy({
        among: approval.resolved(undefined, 'human'),
        count: approval.resolved({ approved: true }, 'human'),
        by: categoryFacet,
        days: 30,
      })
    ).map(([category, rate]) => [`approval rate, category ${category}`, rate])
  ),
  ...Object.fromEntries(
    Object.entries(
      metrics.rateBy({
        among: approval.resolved(undefined, 'human'),
        count: approval.resolved({ approved: true }, 'human'),
        by: { modelOf: drafter },
        days: 30,
      })
    ).map(([model, rate]) => [`approval rate, model ${model}`, rate])
  ),
}));

const api = anthropic.account('api', { apiKey: H.env('ANTHROPIC_API_KEY') });

export default H.harness('support-triage')
  .ledger(sqlite.ledger('harness/ledger.db'))
  .lanes(conversations, escalations)
  .pools(H.pool('api', [{ account: api, share: 1 }]))
  .triggers(slaBreach, escalationOpens)
  .scheduler(breachFirst)
  .reports(approvals)
  .clients(
    claudeCode.supervisor({
      grants: [
        H.ops.readWork,
        H.ops.resolve(approval, costCeiling, escalationHandled, H.parked),
        H.ops.readMemory,
        H.ops.writeMemory,
        H.ops.readTelemetry,
      ],
    })
  )
  .observers(markdown.board('BOARD.md'), markdown.telemetry('TELEMETRY.md'));
