import { z } from 'zod';
import { H } from 'harness-dsl';
import * as claudeCode from 'harness-dsl/claude-code';
import * as anthropic from 'harness-dsl/anthropic';
import * as http from 'harness-dsl/http';
import * as sqlite from 'harness-dsl/sqlite';
import * as jsonl from 'harness-dsl/jsonl';
import * as shell from 'harness-dsl/shell';
import * as markdown from 'harness-dsl/markdown';

const categories = z.enum(['billing', 'refund', 'technical', 'account', 'other']);

const conversation = H.kind('conversation')
  .data(
    z.object({
      customer: z.string(),
      subject: z.string(),
      message: z.string(),
      slaDueAt: z.string(),
      category: categories.optional(),
    })
  )
  .states(
    H.state('new', 'pending'),
    H.state('classifying', 'pending'),
    H.state('drafting', 'pending'),
    H.state('awaiting-approval', 'pending'),
    H.state('sent', 'terminal', 'success'),
    H.state('closed-by-customer', 'terminal', 'neutral'),
    H.state('escalated', 'terminal', 'failure')
  );

const escalation = H.kind('escalation')
  .data(z.object({ conversation: z.string(), subject: z.string(), reason: z.string() }))
  .states(H.state('open', 'pending'), H.state('handled', 'terminal', 'success'), H.state('unhandled', 'terminal', 'failure'));

const category = H.facet('category', categories);

const tasteKind = H.memory('reply-taste', 'taste');
const experienceKind = H.memory('support-experience', 'experience');
const taste = H.journal('reviewer-taste', tasteKind, jsonl.memory('.harness/taste.jsonl'));
const experience = H.journal('support-experience', experienceKind, jsonl.memory('.harness/experience.jsonl'));

const haiku = anthropic.model('claude-haiku-4-5');
const sonnet = anthropic.model('claude-sonnet-4-5');
const opus = anthropic.model('claude-opus-4-1');

const anthropicPool = H.pool('anthropic', [
  { account: anthropic.account('support-api', { apiKey: H.env('ANTHROPIC_API_KEY') }), share: 1 },
]).serves(haiku, sonnet, opus);

const approval = H.halt(
  'reply-approval',
  z.object({ approved: z.boolean(), editedReply: z.string().optional(), tasteNote: z.string().optional() })
)
  .about(z.object({ category: categories }))
  .policy('safe-category-auto-approve', (about, metrics, self) => {
    const rejections = metrics.rate({
      among: { ...self.resolved(), resolver: 'human', facets: [category.of(about.category)] },
      count: { ...self.resolved({ approved: false }), resolver: 'human', facets: [category.of(about.category)] },
    });
    const approvals = rejections.samples - rejections.hits;
    return approvals >= 200 && rejections.hits === 0 ? { approved: true } : null;
  });

const drafterModel = H.policy.model('drafter-by-approval', [sonnet, opus], choice => {
  const byModel = choice.metrics.rateBy({
    among: approval.resolved(),
    count: approval.resolved({ approved: true }),
    by: { modelOf: choice.seat },
    days: 30,
  });
  const cheaper = byModel.of(sonnet);
  return cheaper.samples >= 50 && (cheaper.value ?? 0) < 0.9 ? opus : sonnet;
});

const classifierRole = H.role('classifier')
  .input(z.object({ subject: z.string(), message: z.string() }))
  .output(z.object({ category: categories }))
  .prompt(input => `Classify this support conversation.\nSubject: ${input.subject}\n\n${input.message}`);

const drafterRole = H.role('drafter')
  .input(z.object({ subject: z.string(), message: z.string(), category: categories }))
  .output(z.object({ reply: z.string() }))
  .prompt(input => `Draft a reply for a ${input.category} conversation.\nSubject: ${input.subject}\n\n${input.message}`);

const classifier = H.seat('classifier', classifierRole).model(haiku);
const drafter = H.seat('drafter', drafterRole).model(drafterModel).recalls(taste, experience);

const local = shell.local('local', { slots: 4 });

const sendReply = H.command('send-reply')
  .input(z.object({ conversation: z.string(), reply: z.string() }))
  .argv(input => ['helpdesk', 'reply', input.conversation, input.reply])
  .on(local);

const triage = H.flow('triage')
  .for(conversation)
  .does(async ctx => {
    await ctx.move('classifying');
    const classified = await ctx.run(classifier, { subject: ctx.unit.data.subject, message: ctx.unit.data.message });
    if (!classified.ok) return ctx.fail(classified.error);
    await ctx.update({ category: classified.value.category });
    await ctx.move('drafting');
    const drafted = await ctx.run(drafter, {
      subject: ctx.unit.data.subject,
      message: ctx.unit.data.message,
      category: classified.value.category,
    });
    if (!drafted.ok) return ctx.fail(drafted.error);
    await ctx.move('awaiting-approval');
    const decision = await ctx.halt(approval, drafted.value.reply, { category: classified.value.category });
    if (decision.tasteNote !== undefined) {
      await ctx.remember(taste, {
        text: decision.tasteNote,
        because: 'the reviewer edited a draft this way',
        when: { roles: [drafterRole], facets: [category.of(classified.value.category)] },
        status: 'candidate',
      });
    }
    if (!decision.approved) return ctx.fail('reviewer rejected the draft');
    const sent = await ctx.run(sendReply, {
      conversation: ctx.unit.key,
      reply: decision.editedReply ?? drafted.value.reply,
    });
    return sent.ok ? 'sent' : ctx.fail(sent.error);
  });

const escalationHandled = H.halt('escalation-handled', z.object({ handled: z.boolean(), note: z.string() }));

const handleEscalation = H.flow('handle-escalation')
  .for(escalation)
  .does(async ctx => {
    const decision = await ctx.halt(
      escalationHandled,
      `Escalated conversation ${ctx.unit.data.conversation}: ${ctx.unit.data.subject} (${ctx.unit.data.reason})`
    );
    return decision.handled ? 'handled' : 'unhandled';
  });

const helpdeskHeaders = { authorization: H.env('HELPDESK_TOKEN') };

const helpdeskWebhook = http.webhook(conversation, {
  path: '/helpdesk/events',
  secret: H.env('HELPDESK_WEBHOOK_SECRET'),
  body: z.object({
    event: z.enum(['created', 'replied', 'closed']),
    conversationId: z.string(),
    customer: z.string(),
    subject: z.string(),
    message: z.string(),
    slaDueAt: z.string(),
  }),
  read: (body, supply) => {
    if (body.event === 'created') {
      return supply.create(
        { customer: body.customer, subject: body.subject, message: body.message, slaDueAt: body.slaDueAt },
        { key: body.conversationId }
      );
    }
    if (body.event === 'replied') {
      return supply.update(body.conversationId, {
        patch: { message: body.message },
        state: 'classifying',
        cancels: ['waiting'],
      });
    }
    return supply.update(body.conversationId, { state: 'closed-by-customer' });
  },
});

const helpdeskPoll = http.poll(conversation, {
  url: 'https://helpdesk.example.com/api/conversations?status=open',
  every: { minutes: 10 },
  headers: helpdeskHeaders,
  body: z.object({
    conversations: z.array(
      z.object({ id: z.string(), customer: z.string(), subject: z.string(), message: z.string(), slaDueAt: z.string() })
    ),
  }),
  read: (body, supply) =>
    body.conversations.map(item =>
      supply.create(
        { customer: item.customer, subject: item.subject, message: item.message, slaDueAt: item.slaDueAt },
        { key: item.id }
      )
    ),
});

const conversations = H.lane('conversations', conversation)
  .handler(triage)
  .retries(2, { backoff: { first: { minutes: 2 } }, exhausted: 'escalated' })
  .suppliers(helpdeskWebhook, helpdeskPoll)
  .store(http.store(conversation, { url: 'https://helpdesk.example.com/api/conversations', headers: helpdeskHeaders, stateField: 'harness_state' }))
  .maxUsdPerUnit(0.4)
  .facet(category, data => data.category);

const escalations = H.lane('escalations', escalation)
  .handler(handleEscalation)
  .retries(0, { exhausted: 'unhandled' });

const slaBreach = H.trigger(
  'sla-breach-escalates',
  H.on.deadline(conversation, data => new Date(data.slaDueAt), ['new', 'classifying', 'drafting', 'awaiting-approval']),
  (event, act) => act.move('escalated')
);

const escalate = H.trigger('escalated-opens-escalation', H.on.enters(conversation, 'escalated'), (event, act) =>
  act.create(
    escalations,
    { conversation: event.unit.key, subject: event.unit.data.subject, reason: `escalated at ${event.at.toISOString()}` },
    `escalation-${event.unit.key}`
  )
);

const timeToBreach = H.policy.scheduler('time-to-breach', view => ({
  start: view.sorted(unit => (unit.is(conversation) ? new Date(unit.data.slaDueAt).getTime() : 0)),
}));

export const supportTriage = H.harness('support-triage')
  .ledger(sqlite.ledger('.harness/support-ledger.db'))
  .lanes(conversations, escalations)
  .pools(anthropicPool)
  .triggers(slaBreach, escalate)
  .scheduler(timeToBreach)
  .clients(
    claudeCode.supervisor({
      grants: [
        H.ops.readWork,
        H.ops.resolve(approval, escalationHandled, H.halts.costCeiling),
        H.ops.readMemory,
        H.ops.writeMemory,
        H.ops.readTelemetry,
      ],
    })
  )
  .observers(markdown.board('BOARD.md'), markdown.telemetry('TELEMETRY.md'));
