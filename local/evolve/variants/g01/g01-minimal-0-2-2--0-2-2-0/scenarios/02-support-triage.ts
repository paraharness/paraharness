import { z } from 'zod';
import { H } from 'harness-dsl';
import type { Metrics, PendingView, SupplyOf } from 'harness-dsl';
import * as anthropic from 'harness-dsl/anthropic';
import * as cc from 'harness-dsl/claude-code';
import * as http from 'harness-dsl/http';
import * as sqlite from 'harness-dsl/sqlite';
import * as jsonl from 'harness-dsl/jsonl';
import * as shell from 'harness-dsl/shell';
import * as markdown from 'harness-dsl/markdown';

const hour = 60 * 60 * 1000;
const slaHours = 4;

const categories = z.enum(['billing', 'refunds', 'shipping', 'technical', 'other']);
const category = H.facet('category', categories);

const fresh = H.state('new', 'pending');
const classifying = H.state('classifying', 'pending');
const sent = H.state('sent', 'terminal', 'success');
const closedByCustomer = H.state('closedByCustomer', 'terminal', 'neutral');
const escalated = H.state('escalated', 'terminal', 'failure');

const open = H.state('open', 'pending');
const resolved = H.state('resolved', 'terminal', 'success');
const handedOff = H.state('handedOff', 'terminal', 'neutral');

const conversation = H.kind('Conversation')
  .data(z.object({ conversationId: z.string(), customer: z.string(), message: z.string(), slaDueAt: z.date() }))
  .states(fresh, classifying, sent, closedByCustomer, escalated);

const escalationData = z.object({ conversationId: z.string(), reason: z.string() });
const escalation = H.kind('Escalation').data(escalationData).states(open, resolved, handedOff);

const taste = H.memory('reply-taste', 'taste');
const experience = H.memory('support-experience', 'experience');
const tasteJournal = H.library('reply-taste-journal', taste, jsonl.memory('memory/taste.jsonl'));
const experienceJournal = H.library('support-experience-journal', experience, jsonl.memory('memory/experience.jsonl'));

const apiAccount = anthropic.account('helpdesk-api', { apiKey: H.env('ANTHROPIC_API_KEY') });
const pool = H.pool('helpdesk-models', [{ account: apiAccount, share: 1 }]);
const haiku = anthropic.model('claude-haiku-4-5');
const sonnet = anthropic.model('claude-sonnet-4-5');
const opus = anthropic.model('claude-opus-4-1');

const approvalDecision = z.object({ approved: z.boolean(), text: z.string() });
const approvalAbout = z.object({ category: categories, draft: z.string() });
type Approval = z.infer<typeof approvalDecision>;
type ApprovalAbout = z.infer<typeof approvalAbout>;

const safeCategory = H.policy.rule('safe-category-auto-approval', (about: ApprovalAbout, metrics: Metrics): Approval | null => {
  const approvals = metrics.rate({
    among: { ...replyApproval.resolved(), resolver: 'human', facets: [category.of(about.category)] },
    count: replyApproval.resolved({ approved: true }),
    days: 365,
  });
  const safe = approvals.samples >= 200 && approvals.hits === approvals.samples;
  return safe ? { approved: true, text: about.draft } : null;
});

const replyApproval = H.halt('reply-approval', approvalDecision).about(approvalAbout).policy(safeCategory);

const escalationHandling = H.halt(
  'escalation-handling',
  z.object({ outcome: z.enum(['resolved', 'handedOff']), notes: z.string() })
).about(escalationData);

const drafterModel = H.policy.model('drafter-by-approval-rate', [sonnet, opus], choice => {
  const byModel = choice.metrics.rateBy({
    by: 'model',
    among: replyApproval.resolved(),
    count: replyApproval.resolved({ approved: true }),
    days: 30,
  });
  const current = byModel[sonnet.name];
  const slipping = current !== undefined && current.samples >= 100 && current.value !== null && current.value < 0.8;
  return slipping ? opus : sonnet;
});

const classifierRole = H.role('classifier')
  .input(z.object({ message: z.string() }))
  .output(z.object({ category: categories }))
  .prompt(input => `Classify this customer message:\n\n${input.message}`);

const drafterRole = H.role('drafter')
  .input(z.object({ message: z.string(), category: categories, notes: z.string() }))
  .output(z.object({ reply: z.string() }))
  .prompt(input => `Draft a ${input.category} reply to:\n\n${input.message}\n\nReviewer notes: ${input.notes}`);

const classifier = H.seat('classifier', classifierRole).model(haiku);
const drafter = H.seat('drafter', drafterRole).model(drafterModel).recalls(tasteJournal, experienceJournal);

const local = shell.local('local', { slots: 4 });
const sendReply = H.command('send-reply')
  .input(z.object({ conversationId: z.string(), text: z.string() }))
  .argv(input => ['helpdesk', 'reply', input.conversationId, '--text', input.text])
  .on(local)
  .recovery('park');

const triage = H.flow('triage-conversation')
  .for(conversation)
  .does(async ctx => {
    const { message, customer, conversationId } = ctx.unit.data;
    const classified = await ctx.run(classifier, { message });
    if (!classified.ok) return ctx.fail(classified.error);
    const topic = classified.value.category;
    ctx.tag(category.of(topic));
    const scope = { skills: [category.of(topic)] };
    let notes = '';
    for (let round = 1; round <= 3; round++) {
      const drafted = await ctx.run(drafter, { message, category: topic, notes }, { scope });
      if (!drafted.ok) return ctx.fail(drafted.error);
      const decision = await ctx.halt(replyApproval, `Reply to ${customer}`, { category: topic, draft: drafted.value.reply });
      if (decision.approved) {
        if (decision.text !== drafted.value.reply) {
          await ctx.remember(tasteJournal, {
            text: `When replying about ${topic}, phrase it the way the reviewer did: "${decision.text}"`,
            because: 'the reviewer edited the drafted reply before approving it',
            when: { roles: [drafterRole], skills: [category.of(topic)] },
            status: 'candidate',
          });
        }
        const delivered = await ctx.run(sendReply, { conversationId, text: decision.text });
        if (!delivered.ok) return ctx.fail(delivered.error);
        return 'sent';
      }
      notes = decision.text;
    }
    return 'escalated';
  });

const handleEscalation = H.flow('handle-escalation')
  .for(escalation)
  .does(async ctx => {
    const decision = await ctx.halt(escalationHandling, `Escalated: ${ctx.unit.data.reason}`, ctx.unit.data);
    return decision.outcome;
  });

const helpdeskConversation = z.object({ id: z.string(), customer: z.string(), message: z.string(), createdAt: z.string() });
const slaFor = (createdAt: string): Date => new Date(Date.parse(createdAt) + slaHours * hour);
const helpdeskHeaders = { Authorization: H.env('HELPDESK_TOKEN') };

const webhook = http.webhook(conversation, {
  path: '/helpdesk/events',
  secret: H.env('HELPDESK_WEBHOOK_SECRET'),
  body: z.object({ event: z.enum(['created', 'replied', 'closed']), conversation: helpdeskConversation }),
  read: (body): SupplyOf<typeof conversation> | null => {
    const c = body.conversation;
    if (body.event === 'created') {
      return {
        create: { conversationId: c.id, customer: c.customer, message: c.message, slaDueAt: slaFor(c.createdAt) },
        key: c.id,
      };
    }
    if (body.event === 'replied') return { update: c.id, patch: { message: c.message }, state: 'classifying' };
    return { update: c.id, state: 'closedByCustomer' };
  },
});

const missedPoll = http.poll(conversation, {
  url: 'https://helpdesk.example.com/api/conversations?status=open',
  every: { minutes: 10 },
  headers: helpdeskHeaders,
  body: z.object({ conversations: z.array(helpdeskConversation) }),
  read: body =>
    body.conversations.map((c): SupplyOf<typeof conversation> => ({
      create: { conversationId: c.id, customer: c.customer, message: c.message, slaDueAt: slaFor(c.createdAt) },
      key: c.id,
    })),
});

const helpdeskStore = http.store(conversation, {
  url: 'https://helpdesk.example.com/api/conversations',
  headers: helpdeskHeaders,
  stateField: 'harness_state',
});

const retryTwice = H.policy.attemptRetry('retry-twice', view =>
  view.failedAttempts >= 3 ? 'stop' : { retryInMs: 60 * 1000 * view.failedAttempts }
);

const conversations = H.lane('conversations', conversation)
  .handler(triage)
  .suppliers(webhook, missedPoll)
  .store(helpdeskStore)
  .wip(6)
  .maxUsdPerUnit(0.4)
  .retry(retryTwice, 'escalated');

const escalations = H.lane('escalations', escalation).handler(handleEscalation).wip(20);

const slaBreach = H.trigger(
  'sla-breach-escalates',
  H.on.deadline(conversation, data => data.slaDueAt, ['new', 'classifying']),
  (event, act) => act.move('escalated')
);

const escalatedOpensEscalation = H.trigger(
  'escalated-opens-escalation',
  H.on.enters(conversation, 'escalated'),
  (event, act) =>
    act.create(
      escalations,
      { conversationId: event.unit.data.conversationId, reason: `conversation ${event.unit.key} escalated at ${event.at.toISOString()}` },
      event.unit.key
    )
);

const timeToBreach = (unit: PendingView, now: Date): number =>
  unit.is(conversation) ? unit.data.slaDueAt.getTime() - now.getTime() : Number.NEGATIVE_INFINITY;

const breachFirst = H.policy.scheduler('time-to-breach', view => ({
  start: [...view.pending].sort((a, b) => timeToBreach(a, view.now) - timeToBreach(b, view.now)),
}));

const supervisor = cc.supervisor({
  grants: [H.ops.readWork, H.ops.writeWork, H.ops.resolveHalts, H.ops.writeMemory, H.ops.readMemory, H.ops.readTelemetry],
});

export const supportTriage = H.harness('support-triage')
  .ledger(sqlite.ledger('.harness/support.sqlite'))
  .lanes(conversations, escalations)
  .pools(pool)
  .triggers(slaBreach, escalatedOpensEscalation)
  .scheduler(breachFirst)
  .clients(supervisor)
  .observers(markdown.board('BOARD.md'), markdown.telemetry('TELEMETRY.md'));

export const running = supportTriage.start();
