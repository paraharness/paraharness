import { z } from 'zod';
import { H, type PendingView, type EntryFilter } from 'harness-dsl';
import * as anthropic from 'harness-dsl/anthropic';
import * as claude from 'harness-dsl/claude-code';
import * as http from 'harness-dsl/http';
import * as jsonl from 'harness-dsl/jsonl';
import * as sqlite from 'harness-dsl/sqlite';
import * as shell from 'harness-dsl/shell';
import * as markdown from 'harness-dsl/markdown';

const categories = z.enum(['billing', 'refunds', 'shipping', 'account', 'other']);
const category = H.facet('category', categories);

const fresh = H.state('new', 'pending');
const classifying = H.state('classifying', 'pending');
const sent = H.state('sent', 'terminal', 'success');
const closedByCustomer = H.state('closed-by-customer', 'terminal', 'neutral');
const escalated = H.state('escalated', 'terminal', 'failure');

const open = H.state('open', 'pending');
const handled = H.state('handled', 'terminal', 'success');
const unhandled = H.state('unhandled', 'terminal', 'failure');

const conversation = H.kind('conversation')
  .data(
    z.object({
      ticketId: z.string(),
      customer: z.string(),
      latest: z.string(),
      slaDueAt: z.string(),
      category: categories.optional(),
    })
  )
  .states(fresh, classifying, sent, closedByCustomer, escalated);

const escalation = H.kind('escalation')
  .data(z.object({ ticketId: z.string(), reason: z.string() }))
  .states(open, handled, unhandled);

const tone = H.memory('support-tone', 'taste');
const supportExperience = H.memory('support-experience', 'experience');
const toneLibrary = H.library('tone', tone, jsonl.memory('.harness/tone.jsonl'));
const experienceLibrary = H.library('support-experience', supportExperience, jsonl.memory('.harness/support-experience.jsonl'));

const haiku = anthropic.model('claude-haiku-4-5');
const sonnet = anthropic.model('claude-sonnet-4-5');
const opus = anthropic.model('claude-opus-4-1');
const api = anthropic.account('anthropic-api', { apiKey: H.env('ANTHROPIC_API_KEY') });
const pool = H.pool('anthropic', [{ account: api, share: 1 }]);

const approvalDecision = z.object({
  approved: z.boolean(),
  edited: z.string().optional(),
  tasteNote: z.string().optional(),
});
const approvalAbout = z.object({ category: categories, draft: z.string() });
type ApprovalDecision = z.infer<typeof approvalDecision>;
type ApprovalAbout = z.infer<typeof approvalAbout>;

const approvalGate = H.halt('reply-approval', approvalDecision).about(approvalAbout);

const humanApprovals: EntryFilter = { ...approvalGate.resolved(), resolver: 'human' };
const humanRejections: EntryFilter = { ...approvalGate.resolved({ approved: false }), resolver: 'human' };
const humanAccepts: EntryFilter = { ...approvalGate.resolved({ approved: true }), resolver: 'human' };

const safeCategory = H.policy.rule(
  'safe-category-auto-approval',
  (about: ApprovalAbout, metrics): ApprovalDecision | null => {
    const record = metrics.rateBy({ among: humanApprovals, count: humanRejections, by: category }).get(about.category);
    return record.samples >= 200 && record.hits === 0 ? { approved: true } : null;
  }
);

const approval = approvalGate.policy(safeCategory);

const drafterModel = H.policy.model('drafter-model', [sonnet, opus], choice => {
  const byModel = choice.metrics.rateBy({
    among: humanApprovals,
    count: humanAccepts,
    days: 30,
    by: { seat: choice.seat, models: [sonnet, opus] },
  });
  const incumbent = byModel.get(sonnet);
  const challenger = byModel.get(opus);
  if (incumbent.samples < 50) return sonnet;
  if (challenger.samples < 20) return opus;
  return (challenger.value ?? 0) > (incumbent.value ?? 0) + 0.05 ? opus : sonnet;
});

const classifierRole = H.role('classifier')
  .input(z.object({ latest: z.string() }))
  .output(z.object({ category: categories }))
  .prompt(input => `Classify this customer message:\n${input.latest}`);

const drafterRole = H.role('drafter')
  .input(z.object({ latest: z.string(), category: categories }))
  .output(z.object({ reply: z.string() }))
  .prompt(input => `Draft a reply to this ${input.category} conversation:\n${input.latest}`);

const classifier = H.seat('classifier', classifierRole).model(haiku);
const drafter = H.seat('drafter', drafterRole).model(drafterModel).recalls(toneLibrary, experienceLibrary);

const local = shell.local('local', { slots: 4 });

const sendReply = H.command('send-reply')
  .input(z.object({ ticketId: z.string(), reply: z.string() }))
  .argv(input => ['./bin/send-reply', input.ticketId, input.reply])
  .on(local)
  .recovery('park');

const triage = H.flow('triage-conversation')
  .for(conversation)
  .does(async ctx => {
    const classified = await ctx.run(classifier, { latest: ctx.unit.data.latest });
    if (!classified.ok) return ctx.fail(classified.error);
    const kind = classified.value.category;
    await ctx.update({ category: kind });
    const drafted = await ctx.run(drafter, { latest: ctx.unit.data.latest, category: kind });
    if (!drafted.ok) return ctx.fail(drafted.error);
    const decision = await ctx.halt(approval, drafted.value.reply, { category: kind, draft: drafted.value.reply });
    if (decision.tasteNote !== undefined) {
      await ctx.remember(toneLibrary, {
        text: decision.tasteNote,
        status: 'candidate',
        when: { roles: [drafterRole], facets: [category.of(kind)] },
      });
    }
    if (!decision.approved) return 'classifying';
    const posted = await ctx.run(sendReply, {
      ticketId: ctx.unit.data.ticketId,
      reply: decision.edited ?? drafted.value.reply,
    });
    if (!posted.ok) return ctx.fail(posted.error);
    return 'sent';
  });

const escalationHandled = H.halt(
  'escalation-handled',
  z.object({ outcome: z.enum(['handled', 'unhandled']), note: z.string() })
).about(z.object({ ticketId: z.string(), reason: z.string() }));

const handleEscalation = H.flow('handle-escalation')
  .for(escalation)
  .does(async ctx => {
    const decided = await ctx.halt(escalationHandled, `Escalated ticket ${ctx.unit.data.ticketId}: ${ctx.unit.data.reason}`, {
      ticketId: ctx.unit.data.ticketId,
      reason: ctx.unit.data.reason,
    });
    return decided.outcome === 'handled' ? 'handled' : 'unhandled';
  });

const helpdeskHeaders = { authorization: H.env('HELPDESK_TOKEN') };

const webhook = http.webhook(conversation, {
  path: '/hooks/helpdesk',
  secret: H.env('HELPDESK_WEBHOOK_SECRET'),
  body: z.object({
    event: z.enum(['created', 'replied', 'closed']),
    ticketId: z.string(),
    customer: z.string(),
    message: z.string(),
    slaDueAt: z.string(),
  }),
  read: body => {
    if (body.event === 'created') {
      return {
        create: { ticketId: body.ticketId, customer: body.customer, latest: body.message, slaDueAt: body.slaDueAt },
        key: body.ticketId,
      };
    }
    if (body.event === 'replied') {
      return { update: body.ticketId, patch: { latest: body.message }, state: 'classifying', whileWaiting: 'cancel' };
    }
    return { update: body.ticketId, state: 'closed-by-customer', whileRunning: 'cancel' };
  },
});

const missedPoll = http.poll(conversation, {
  url: 'https://helpdesk.example.com/api/conversations?status=open',
  every: { minutes: 10 },
  headers: helpdeskHeaders,
  body: z.object({
    conversations: z.array(
      z.object({ id: z.string(), customer: z.string(), lastMessage: z.string(), slaDueAt: z.string() })
    ),
  }),
  read: body =>
    body.conversations.map(item => ({
      create: { ticketId: item.id, customer: item.customer, latest: item.lastMessage, slaDueAt: item.slaDueAt },
      key: item.id,
    })),
});

const conversationStore = http.store(conversation, {
  url: 'https://helpdesk.example.com/api/conversations',
  headers: helpdeskHeaders,
  stateField: 'harness_state',
});

const escalationStore = http.store(escalation, {
  url: 'https://helpdesk.example.com/api/escalations',
  headers: helpdeskHeaders,
  stateField: 'harness_state',
});

const conversations = H.lane('conversations', conversation)
  .handler(triage)
  .retries(2, { backoff: { first: { minutes: 1 }, factor: 2 }, exhausted: 'escalated' })
  .suppliers(webhook, missedPoll)
  .store(conversationStore)
  .maxUsdPerUnit(0.4)
  .facet(category, data => data.category)
  .reentries('classifying', { max: 3, then: 'escalated' });

const escalations = H.lane('escalations', escalation)
  .handler(handleEscalation)
  .retries(0, { exhausted: 'unhandled' })
  .store(escalationStore);

const slaBreach = H.trigger(
  'sla-breach-escalates',
  H.on.deadline(conversation, data => new Date(data.slaDueAt), ['new', 'classifying']),
  (_event, act) => act.move('escalated')
);

const escalatedOpensEscalation = H.trigger('escalated-opens-escalation', H.on.enters(conversation, 'escalated'), (event, act) =>
  act.create(
    escalations,
    { ticketId: event.unit.data.ticketId, reason: `Conversation escalated at ${event.at.toISOString()}` },
    `escalation-${event.unit.data.ticketId}`
  )
);

const breachAt = (unit: PendingView, now: Date): number => {
  if (unit.is(conversation)) return Date.parse(unit.data.slaDueAt);
  return now.getTime();
};

const byTimeToBreach = H.policy.scheduler('time-to-breach', view => ({
  start: [...view.pending].sort((a, b) => breachAt(a, view.now) - breachAt(b, view.now)),
}));

const reviewer = claude.supervisor('reviewer', {
  grants: [
    H.ops.readWork,
    H.ops.resolve(approval, escalationHandled, H.halts.costCeiling),
    H.ops.readMemory,
    H.ops.writeMemory,
    H.ops.readTelemetry,
  ],
});

export const supportTriage = H.harness('support-triage')
  .ledger(sqlite.ledger('.harness/ledger.sqlite'))
  .lanes(conversations, escalations)
  .pools(pool)
  .triggers(slaBreach, escalatedOpensEscalation)
  .scheduler(byTimeToBreach)
  .clients(reviewer)
  .observers(markdown.board('BOARD.md'), markdown.telemetry('TELEMETRY.md'));
