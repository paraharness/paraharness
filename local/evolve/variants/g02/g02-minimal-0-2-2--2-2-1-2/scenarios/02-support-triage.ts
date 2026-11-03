import { z } from 'zod';
import { H } from 'harness-dsl';
import type { Metrics, PendingView } from 'harness-dsl';
import * as anthropic from 'harness-dsl/anthropic';
import * as claudeCode from 'harness-dsl/claude-code';
import * as http from 'harness-dsl/http';
import * as sqlite from 'harness-dsl/sqlite';
import * as jsonl from 'harness-dsl/jsonl';
import * as shell from 'harness-dsl/shell';
import * as markdown from 'harness-dsl/markdown';

const categories = z.enum(['billing', 'refund', 'technical', 'account', 'other']);
const category = H.facet('category', categories);

const fresh = H.state('new', 'pending');
const sent = H.state('sent', 'terminal', 'success');
const closedByCustomer = H.state('closed-by-customer', 'terminal', 'neutral');
const escalated = H.state('escalated', 'terminal', 'failure');
const open = H.state('open', 'pending');
const handled = H.state('handled', 'terminal', 'success');
const unhandled = H.state('unhandled', 'terminal', 'failure');

const conversation = H.kind('conversation')
  .data(z.object({ customer: z.string(), message: z.string(), slaDue: z.string(), category: categories.optional() }))
  .states(fresh, sent, closedByCustomer, escalated);

const escalation = H.kind('escalation')
  .data(z.object({ conversation: z.string(), customer: z.string(), reason: z.string() }))
  .states(open, handled, unhandled);

const helpdeskHeaders = { authorization: H.env('HELPDESK_TOKEN') };
const payload = z.object({ id: z.string(), customer: z.string(), message: z.string(), slaDue: z.string() });

const helpdeskWebhook = http.webhook(conversation, {
  path: '/helpdesk/events',
  secret: H.env('HELPDESK_WEBHOOK_SECRET'),
  body: z.object({ event: z.enum(['created', 'replied', 'closed']), conversation: payload }),
  read: body => {
    const incoming = body.conversation;
    if (body.event === 'created') {
      return {
        create: { customer: incoming.customer, message: incoming.message, slaDue: incoming.slaDue },
        key: incoming.id,
      };
    }
    if (body.event === 'replied') return { update: incoming.id, patch: { message: incoming.message }, state: 'new' };
    return { update: incoming.id, state: 'closed-by-customer' };
  },
});

const helpdeskPoll = http.poll(conversation, {
  url: 'https://helpdesk.example.com/api/conversations?status=open',
  every: { minutes: 10 },
  headers: helpdeskHeaders,
  body: z.object({ conversations: z.array(payload) }),
  read: body =>
    body.conversations.map(incoming => ({
      create: { customer: incoming.customer, message: incoming.message, slaDue: incoming.slaDue },
      key: incoming.id,
    })),
});

const helpdeskStore = http.store(conversation, {
  url: 'https://helpdesk.example.com/api/conversations',
  headers: helpdeskHeaders,
  stateField: 'harness_state',
});

const haiku = anthropic.model('claude-haiku-4-5');
const sonnet = anthropic.model('claude-sonnet-4-5');
const opus = anthropic.model('claude-opus-4-1');
const api = anthropic.account('anthropic-api', { apiKey: H.env('ANTHROPIC_API_KEY') });
const anthropicPool = H.pool('anthropic', [{ account: api, share: 1 }]);

const replyTaste = H.library('reply-taste', H.memory('reply-taste', 'taste'), jsonl.memory('.harness/taste.jsonl'));
const supportLessons = H.library(
  'support-lessons',
  H.memory('support-experience', 'experience'),
  jsonl.memory('.harness/experience.jsonl')
);

const local = shell.local('local', { slots: 4 });

const classifierRole = H.role('classifier')
  .input(z.object({ message: z.string() }))
  .output(z.object({ category: categories }))
  .prompt(input => `Classify this customer message into one category.\n\n${input.message}`);

const drafterRole = H.role('drafter')
  .input(z.object({ customer: z.string(), message: z.string(), category: categories }))
  .output(z.object({ reply: z.string() }))
  .prompt(input => `Draft a reply to ${input.customer} about a ${input.category} request.\n\n${input.message}`);

const approvalAbout = z.object({ category: categories, draft: z.string() });
const approvalDecision = z.object({
  approved: z.boolean(),
  reply: z.string().optional(),
  tasteNote: z.string().optional(),
});
type ApprovalAbout = z.infer<typeof approvalAbout>;
type ApprovalDecision = z.infer<typeof approvalDecision>;

const safeCategory = H.policy.rule(
  'safe-category',
  (about: ApprovalAbout, metrics: Metrics): ApprovalDecision | null => {
    const scope = [category.of(about.category)];
    const record = metrics.rate({
      among: { ...approval.resolved(), resolver: 'human', facets: scope },
      count: { ...approval.resolved({ approved: true }), resolver: 'human', facets: scope },
    });
    return record.samples >= 200 && record.hits === record.samples ? { approved: true } : null;
  }
);

const approval = H.halt('reply-approval', approvalDecision).about(approvalAbout).policy(safeCategory);

const drafterModel = H.policy.model('drafter-model', [sonnet, opus], choice => {
  const rates = choice.metrics.rateBy({
    among: { ...approval.resolved(), resolver: 'human' },
    count: { ...approval.resolved({ approved: true }), resolver: 'human' },
    by: { modelOf: choice.seat },
    days: 30,
  });
  const incumbent = rates.of(sonnet);
  const challenger = rates.of(opus);
  if (challenger.samples < 30) return incumbent.samples >= 30 ? opus : sonnet;
  return (challenger.value ?? 0) > (incumbent.value ?? 0) ? opus : sonnet;
});

const classifier = H.seat('classifier', classifierRole).model(haiku);
const drafter = H.seat('drafter', drafterRole).model(drafterModel).recalls(replyTaste, supportLessons);

const sendReply = H.command('send-reply')
  .input(z.object({ conversation: z.string(), reply: z.string() }))
  .argv(input => ['helpdesk', 'reply', '--conversation', input.conversation, '--body', input.reply])
  .on(local)
  .recovery('park');

const triage = H.flow('triage').for(conversation).does(async ctx => {
  const { customer, message } = ctx.unit.data;
  const classified = await ctx.run(classifier, { message });
  if (!classified.ok) return ctx.fail(classified.error);
  const assigned = classified.value.category;
  await ctx.update({ category: assigned });
  const drafted = await ctx.run(drafter, { customer, message, category: assigned });
  if (!drafted.ok) return ctx.fail(drafted.error);
  const decision = await ctx.halt(approval, drafted.value.reply, { category: assigned, draft: drafted.value.reply });
  if (decision.tasteNote !== undefined) {
    await ctx.remember(replyTaste, {
      text: decision.tasteNote,
      when: { roles: [drafterRole], facets: [category.of(assigned)] },
    });
  }
  if (!decision.approved) return ctx.fail('reply rejected by reviewer');
  const delivered = await ctx.run(sendReply, { conversation: ctx.unit.key, reply: decision.reply ?? drafted.value.reply });
  return delivered.ok ? 'sent' : ctx.fail(delivered.error);
});

const escalationOutcome = H.halt('escalation-outcome', z.object({ handled: z.boolean(), note: z.string() }))
  .about(z.object({ conversation: z.string(), reason: z.string() }));

const handleEscalation = H.flow('handle-escalation').for(escalation).does(async ctx => {
  const outcome = await ctx.halt(escalationOutcome, `Escalated conversation ${ctx.unit.data.conversation}`, {
    conversation: ctx.unit.data.conversation,
    reason: ctx.unit.data.reason,
  });
  return outcome.handled ? 'handled' : 'unhandled';
});

const conversations = H.lane('conversations', conversation)
  .handler(triage, { retries: 2, backoff: { first: { minutes: 1 }, factor: 2 }, exhausted: 'escalated' })
  .suppliers(helpdeskWebhook, helpdeskPoll)
  .store(helpdeskStore)
  .maxUsdPerUnit(0.4)
  .facet(category, data => data.category);

const escalations = H.lane('escalations', escalation).handler(handleEscalation, { retries: 0, exhausted: 'unhandled' });

const slaBreachEscalates = H.trigger(
  'sla-breach-escalates',
  H.on.deadline(conversation, data => new Date(data.slaDue), ['new']),
  (event, act) => [
    act.create(
      escalations,
      {
        conversation: event.unit.key,
        customer: event.unit.data.customer,
        reason: `SLA breached at ${event.at.toISOString()}`,
      },
      `sla-${event.unit.key}`
    ),
    act.move('escalated'),
  ]
);

const breachAt = (unit: PendingView): number =>
  unit.is(conversation) ? Date.parse(unit.data.slaDue) : unit.is(escalation) ? 0 : Number.MAX_SAFE_INTEGER;

const timeToBreach = H.policy.scheduler('time-to-breach', view => ({
  start: [...view.pending].sort((a, b) => breachAt(a) - breachAt(b)),
}));

const supervisor = claudeCode.supervisor({
  grants: [
    H.ops.readWork,
    H.ops.writeWork,
    H.ops.resolve(approval, escalationOutcome, H.halts.costCeiling, H.halts.interrupted, H.halts.definitionChanged),
    H.ops.readMemory,
    H.ops.writeMemory,
    H.ops.readTelemetry,
  ],
});

export const supportTriage = H.harness('support-triage')
  .ledger(sqlite.ledger('.harness/ledger.db'))
  .lanes(conversations, escalations)
  .pools(anthropicPool)
  .triggers(slaBreachEscalates)
  .scheduler(timeToBreach)
  .clients(supervisor)
  .observers(markdown.board('BOARD.md'), markdown.telemetry('TELEMETRY.md'));
