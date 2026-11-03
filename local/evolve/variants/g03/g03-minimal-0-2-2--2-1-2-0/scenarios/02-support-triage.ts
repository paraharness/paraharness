import { z } from 'zod';
import { H } from 'harness-dsl';
import type { PendingView } from 'harness-dsl';
import * as claude from 'harness-dsl/claude-code';
import * as anthropic from 'harness-dsl/anthropic';
import * as http from 'harness-dsl/http';
import * as sqlite from 'harness-dsl/sqlite';
import * as jsonl from 'harness-dsl/jsonl';
import * as shell from 'harness-dsl/shell';
import * as markdown from 'harness-dsl/markdown';

const categories = z.enum(['billing', 'refund', 'shipping', 'account', 'other']);
const category = H.facet('category', categories);

const conversation = H.kind('Conversation')
  .data(
    z.object({
      customer: z.string(),
      messages: z.array(z.string()),
      slaDue: z.string(),
      category: categories.optional(),
    })
  )
  .states(
    H.state('new', 'pending'),
    H.state('classifying', 'pending'),
    H.state('sent', 'waiting'),
    H.state('closed', 'terminal', 'success'),
    H.state('escalated', 'terminal', 'failure')
  );

const escalation = H.kind('Escalation')
  .data(z.object({ conversation: z.string(), customer: z.string() }))
  .states(
    H.state('open', 'pending'),
    H.state('handled', 'terminal', 'success'),
    H.state('dropped', 'terminal', 'neutral')
  );

const approval = H.halt(
  'reply-approval',
  z.object({ approved: z.boolean(), edited: z.string().optional(), note: z.string().optional() })
)
  .about(z.object({ category: categories }))
  .policy('safe-category', view => {
    const inCategory = { facets: [category.of(view.about.category)] };
    const human = view.metrics.rate({
      among: { ...view.resolved(), ...inCategory, resolver: 'human' },
      count: { ...view.resolved({ approved: true }), ...inCategory, resolver: 'human' },
    });
    return human.samples >= 200 && human.hits === human.samples ? { approved: true } : null;
  });

const escalationHandled = H.halt(
  'escalation-handled',
  z.object({ outcome: z.enum(['handled', 'dropped']), note: z.string() })
);

const haiku = anthropic.model('claude-haiku');
const sonnet = anthropic.model('claude-sonnet');
const opus = anthropic.model('claude-opus');

const drafterModel = H.policy.model('drafter-by-approval', [sonnet, opus], choice => {
  const byModel = choice.metrics.rateBy({
    days: 30,
    among: approval.resolved(),
    count: approval.resolved({ approved: true }),
    by: { modelOf: choice.seat },
  });
  const current = byModel.of(sonnet);
  return current.samples < 50 || (current.value ?? 1) >= 0.9 ? sonnet : opus;
});

const specificFirst = H.policy.recall('specific-first', view => view.ranked.slice(0, 8));
const taste = H.journal('reply-taste', H.memory('taste', 'taste'), jsonl.memory('memory/taste.jsonl'), specificFirst);
const experience = H.journal('support-experience', H.memory('experience', 'experience'), jsonl.memory('memory/experience.jsonl'), specificFirst);

const classifierRole = H.role('classifier')
  .input(z.object({ thread: z.string() }))
  .output(z.object({ category: categories }))
  .prompt(i => `Classify this customer conversation:\n\n${i.thread}`);

const drafterRole = H.role('drafter')
  .input(z.object({ thread: z.string(), category: categories }))
  .output(z.object({ reply: z.string() }))
  .prompt(i => `Draft a reply for this ${i.category} conversation:\n\n${i.thread}`);

const classifier = H.seat('classifier', classifierRole).model(haiku);
const drafter = H.seat('drafter', drafterRole).model(drafterModel).recalls(taste, experience);

const local = shell.local('local', { slots: 4 });

const sendReply = H.command('send-reply')
  .input(z.object({ conversation: z.string(), text: z.string() }))
  .argv(i => ['./bin/helpdesk-reply', i.conversation, i.text])
  .on(local)
  .recovery('park');

const triage = H.flow('triage').for(conversation).does(async ctx => {
  const thread = ctx.unit.data.messages.join('\n\n');
  const classified = await ctx.run(classifier, { thread });
  if (!classified.ok) return ctx.fail(classified);
  const kind = classified.value.category;
  await ctx.update({ category: kind });
  const drafted = await ctx.run(drafter, { thread, category: kind });
  if (!drafted.ok) return ctx.fail(drafted);
  const decision = await ctx.halt(approval, drafted.value.reply, { category: kind });
  if (decision.note !== undefined) {
    await ctx.remember(taste, {
      text: `When drafting ${kind} replies, ${decision.note}`,
      because: 'the reviewer said so on a reviewed draft',
      when: { roles: [drafterRole], facets: [category.of(kind)] },
      status: 'candidate',
    });
  }
  if (!decision.approved) return 'classifying';
  const sent = await ctx.run(sendReply, { conversation: ctx.unit.key, text: decision.edited ?? drafted.value.reply });
  if (!sent.ok) return ctx.fail(sent);
  if (decision.edited !== undefined) {
    await ctx.remember(taste, {
      text: `When drafting ${kind} replies, prefer phrasing like: ${decision.edited}`,
      because: 'the reviewer edited a draft into this before sending',
      when: { roles: [drafterRole], facets: [category.of(kind)] },
      status: 'candidate',
    });
  }
  return 'sent';
});

const handleEscalation = H.flow('human-escalation').for(escalation).does(async ctx => {
  const decision = await ctx.halt(
    escalationHandled,
    `SLA breached for ${ctx.unit.data.customer} on conversation ${ctx.unit.data.conversation}`
  );
  return decision.outcome;
});

const helpdeskHeaders = { authorization: H.env('HELPDESK_TOKEN') };

const webhook = http.webhook(conversation, {
  path: '/helpdesk/events',
  secret: H.env('HELPDESK_WEBHOOK_SECRET'),
  body: z.object({
    event: z.enum(['created', 'replied', 'closed']),
    id: z.string(),
    customer: z.string(),
    messages: z.array(z.string()),
    slaDue: z.string(),
  }),
  read: body => {
    if (body.event === 'created') {
      return { create: { customer: body.customer, messages: body.messages, slaDue: body.slaDue }, key: body.id };
    }
    if (body.event === 'closed') return { update: body.id, state: 'closed' };
    return { update: body.id, patch: { messages: body.messages }, state: 'classifying' };
  },
});

const missedPoll = http.poll(conversation, {
  url: 'https://helpdesk.example.com/api/conversations?status=open',
  every: { minutes: 10 },
  headers: helpdeskHeaders,
  body: z.object({
    conversations: z.array(
      z.object({ id: z.string(), customer: z.string(), messages: z.array(z.string()), slaDue: z.string() })
    ),
  }),
  read: body =>
    body.conversations.map(c => ({
      create: { customer: c.customer, messages: c.messages, slaDue: c.slaDue },
      key: c.id,
    })),
});

const conversations = H.lane('conversations', conversation)
  .handler(triage)
  .retries(2, 'escalated', { first: { minutes: 2 }, factor: 2 })
  .suppliers(webhook, missedPoll)
  .store(http.store(conversation, { url: 'https://helpdesk.example.com/api/conversations', headers: helpdeskHeaders, stateField: 'harness_state' }))
  .maxUsdPerUnit(0.4)
  .facet(category, data => data.category);

const escalations = H.lane('escalations', escalation)
  .handler(handleEscalation)
  .retries(0, 'dropped');

const slaBreachEscalates = H.trigger(
  'sla-breach-escalates',
  H.on.deadline(conversation, data => new Date(data.slaDue), ['new', 'classifying']),
  (event, act) => [
    act.create(escalations, { conversation: event.unit.key, customer: event.unit.data.customer }, `escalation-${event.unit.key}`),
    act.move('escalated'),
  ]
);

const breachAt = (unit: PendingView): number => (unit.is(conversation) ? Date.parse(unit.data.slaDue) : 0);

const scheduler = H.policy.scheduler('time-to-breach', view => ({
  start: [...view.pending].sort((a, b) => breachAt(a) - breachAt(b)),
}));

const reviewer = claude.supervisor({
  grants: [
    H.ops.readWork,
    H.ops.writeWork,
    H.ops.resolve(approval, escalationHandled, H.halts.costCeiling),
    H.ops.readMemory,
    H.ops.writeMemory,
    H.ops.curateMemory,
    H.ops.readTelemetry,
  ],
});

export const harness = H.harness('support-triage')
  .ledger(sqlite.ledger('.harness/ledger.db'))
  .lanes(conversations, escalations)
  .pools(H.pool('anthropic', [{ account: anthropic.account('anthropic-api', { apiKey: H.env('ANTHROPIC_API_KEY') }), share: 1 }]))
  .triggers(slaBreachEscalates)
  .scheduler(scheduler)
  .clients(reviewer)
  .observers(markdown.board('BOARD.md'), markdown.telemetry('TELEMETRY.md'));
