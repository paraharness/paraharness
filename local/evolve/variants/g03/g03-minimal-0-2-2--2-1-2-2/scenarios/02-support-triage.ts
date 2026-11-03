import { z } from 'zod';
import { H } from 'harness-dsl';
import type { PendingView, Metrics, RulePolicy, ModelPolicy, EntryFilter } from 'harness-dsl';
import * as anthropic from 'harness-dsl/anthropic';
import * as claudeCode from 'harness-dsl/claude-code';
import * as http from 'harness-dsl/http';
import * as sqlite from 'harness-dsl/sqlite';
import * as jsonl from 'harness-dsl/jsonl';
import * as shell from 'harness-dsl/shell';
import * as markdown from 'harness-dsl/markdown';

const categories = z.enum(['billing', 'refund', 'shipping', 'account', 'other']);
const category = H.facet('category', categories);

const fresh = H.state('new', 'pending');
const classifying = H.state('classifying', 'pending');
const drafting = H.state('drafting', 'pending');
const sent = H.state('sent', 'terminal', 'success');
const closedByCustomer = H.state('closed-by-customer', 'terminal', 'neutral');
const escalated = H.state('escalated', 'terminal', 'failure');

const conversation = H.kind('Conversation')
  .data(z.object({
    subject: z.string(),
    customer: z.string(),
    lastMessage: z.string(),
    slaDue: z.date(),
    category: categories.optional(),
  }))
  .states(fresh, classifying, drafting, sent, closedByCustomer, escalated);

const open = H.state('open', 'pending');
const handled = H.state('handled', 'terminal', 'success');
const unresolved = H.state('unresolved', 'terminal', 'failure');

const escalation = H.kind('Escalation')
  .data(z.object({ conversation: z.string(), subject: z.string(), reason: z.string() }))
  .states(open, handled, unresolved);

const classifierRole = H.role('classifier')
  .input(z.object({ subject: z.string(), message: z.string() }))
  .output(z.object({ category: categories }))
  .prompt(input => `Classify this support conversation.\nSubject: ${input.subject}\n\n${input.message}`);

const drafterRole = H.role('drafter')
  .input(z.object({ subject: z.string(), message: z.string(), category: categories }))
  .output(z.object({ reply: z.string() }))
  .prompt(input => `Draft a reply to this ${input.category} conversation.\nSubject: ${input.subject}\n\n${input.message}`);

const taste = H.memory('reply-taste', 'taste');
const experience = H.memory('support-experience', 'experience');
const tasteJournal = H.journal('reply-taste', taste, jsonl.memory('./memory/taste.jsonl'));
const experienceJournal = H.journal('support-experience', experience, jsonl.memory('./memory/experience.jsonl'));

const apiAccount = anthropic.account('helpdesk-api', { apiKey: H.env('ANTHROPIC_API_KEY') });
const pool = H.pool('anthropic', [{ account: apiAccount, share: 1 }]);

const haiku = anthropic.model('claude-haiku-4-5');
const sonnet = anthropic.model('claude-sonnet-4-5');
const opus = anthropic.model('claude-opus-4-1');

const approvalAbout = z.object({ category: categories, draft: z.string() });
const approvalDecision = z.object({
  approved: z.boolean(),
  reply: z.string().optional(),
  tasteNote: z.string().optional(),
});
type ApprovalAbout = z.infer<typeof approvalAbout>;
type ApprovalDecision = z.infer<typeof approvalDecision>;

const humanApprovals = (): EntryFilter => ({ entry: 'halt', halt: replyApproval, status: 'resolved', resolver: 'human' });

const safeCategory: RulePolicy<ApprovalAbout, ApprovalDecision | null> = H.policy.rule(
  'safe-category-after-200-clean-approvals',
  (about: ApprovalAbout, metrics: Metrics): ApprovalDecision | null => {
    const among: EntryFilter = { ...humanApprovals(), facets: [category.of(about.category)] };
    const rate = metrics.rate({ among, count: { ...among, decision: { approved: true } } });
    return rate.samples >= 200 && rate.hits === rate.samples ? { approved: true } : null;
  },
);

const replyApproval = H.halt('reply-approval', approvalDecision).about(approvalAbout).policy(safeCategory);

const drafterModel: ModelPolicy = H.policy.model('drafter-by-approval-rate', [sonnet, opus], choice => {
  const rates = choice.metrics.rateBy({
    by: { modelOf: choice.seat },
    among: humanApprovals(),
    count: { ...humanApprovals(), decision: { approved: true } },
    days: 30,
  });
  const sonnetRate = rates.of(sonnet);
  const opusRate = rates.of(opus);
  if (sonnetRate.samples < 50 || opusRate.samples < 50) return sonnetRate.samples <= opusRate.samples ? sonnet : opus;
  return (sonnetRate.value ?? 0) >= (opusRate.value ?? 0) ? sonnet : opus;
});

const classifier = H.seat('classifier', classifierRole).model(haiku);
const drafter = H.seat('drafter', drafterRole).model(drafterModel).recalls(tasteJournal, experienceJournal);

const local = shell.local('local', { slots: 4 });

const sendReply = H.command('send-reply')
  .input(z.object({ conversation: z.string(), reply: z.string() }))
  .argv(input => ['helpdesk-cli', 'reply', input.conversation, '--body', input.reply])
  .on(local)
  .recovery('park');

const triage = H.flow('triage-conversation')
  .for(conversation)
  .does(async ctx => {
    const { subject, lastMessage } = ctx.unit.data;
    let topic = ctx.unit.data.category;
    if (ctx.unit.state !== 'drafting' || topic === undefined) {
      const classified = await ctx.run(classifier, { subject, message: lastMessage });
      if (!classified.ok) return ctx.fail(classified.error);
      topic = classified.value.category;
      await ctx.update({ category: topic });
    }
    const draft = await ctx.run(drafter, { subject, message: lastMessage, category: topic });
    if (!draft.ok) return ctx.fail(draft.error);
    const decision = await ctx.halt(replyApproval, `Reply to "${subject}"`, { category: topic, draft: draft.value.reply });
    if (decision.tasteNote !== undefined) {
      await ctx.remember(tasteJournal, { text: decision.tasteNote, when: { roles: [drafterRole] }, status: 'accepted' });
    }
    if (!decision.approved) return 'drafting';
    const delivered = await ctx.run(sendReply, { conversation: ctx.unit.key, reply: decision.reply ?? draft.value.reply });
    if (!delivered.ok) return ctx.fail(delivered.error);
    return 'sent';
  });

const escalationOutcome = H.halt('escalation-outcome', z.object({ resolved: z.boolean(), note: z.string() }));

const handleEscalation = H.flow('handle-escalation')
  .for(escalation)
  .does(async ctx => {
    const outcome = await ctx.halt(escalationOutcome, `Escalated: ${ctx.unit.data.subject} (${ctx.unit.data.reason})`);
    return outcome.resolved ? 'handled' : 'unresolved';
  });

const helpdeskHeaders = { 'X-Api-Key': H.env('HELPDESK_API_KEY') };

const helpdeskEvent = z.object({
  event: z.enum(['conversation.created', 'customer.replied', 'conversation.closed']),
  conversationId: z.string(),
  subject: z.string(),
  customer: z.string(),
  text: z.string(),
  slaDue: z.string(),
});

const helpdeskWebhook = http.webhook(conversation, {
  path: '/helpdesk/events',
  secret: H.env('HELPDESK_WEBHOOK_SECRET'),
  body: helpdeskEvent,
  read: body => {
    if (body.event === 'conversation.created') {
      return {
        create: { subject: body.subject, customer: body.customer, lastMessage: body.text, slaDue: new Date(body.slaDue) },
        key: body.conversationId,
      };
    }
    if (body.event === 'customer.replied') {
      return { update: body.conversationId, patch: { lastMessage: body.text }, state: 'classifying' };
    }
    return { update: body.conversationId, state: 'closed-by-customer' };
  },
});

const helpdeskPoll = http.poll(conversation, {
  url: 'https://helpdesk.example.com/api/conversations?status=open',
  every: { minutes: 10 },
  headers: helpdeskHeaders,
  body: z.object({
    conversations: z.array(z.object({
      id: z.string(),
      subject: z.string(),
      customer: z.string(),
      lastMessage: z.string(),
      slaDue: z.string(),
    })),
  }),
  read: body => body.conversations.map(item => ({
    create: { subject: item.subject, customer: item.customer, lastMessage: item.lastMessage, slaDue: new Date(item.slaDue) },
    key: item.id,
  })),
});

const conversations = H.lane('conversations', conversation)
  .handler(triage)
  .retry({ times: 2, backoff: { first: { minutes: 1 }, factor: 2 }, exhausted: 'escalated' })
  .suppliers(helpdeskWebhook, helpdeskPoll)
  .store(http.store(conversation, {
    url: 'https://helpdesk.example.com/api/conversations',
    headers: helpdeskHeaders,
    stateField: 'harness_state',
  }))
  .maxUsdPerUnit(0.4)
  .wip(6)
  .facet(category, data => data.category);

const escalations = H.lane('escalations', escalation)
  .handler(handleEscalation)
  .retry({ times: 0, exhausted: 'unresolved' });

const slaBreachEscalates = H.trigger(
  'sla-breach-escalates',
  H.on.deadline(conversation, data => data.slaDue, ['new', 'classifying', 'drafting']),
  (_event, act) => act.move('escalated'),
);

const escalatedOpensEscalation = H.trigger(
  'escalated-opens-escalation',
  H.on.enters(conversation, 'escalated'),
  (event, act) => act.create(escalations, {
    conversation: event.unit.key,
    subject: event.unit.data.subject,
    reason: event.unit.data.slaDue.getTime() <= event.at.getTime() ? 'SLA breached' : 'retries exhausted',
  }, event.unit.key),
);

const msUntilBreach = (unit: PendingView, now: Date): number =>
  unit.is(conversation) ? unit.data.slaDue.getTime() - now.getTime() : Number.NEGATIVE_INFINITY;

const timeToBreach = H.policy.scheduler('time-to-breach', view => ({
  start: [...view.pending].sort((a, b) => msUntilBreach(a, view.now) - msUntilBreach(b, view.now)),
}));

const supervisor = claudeCode.supervisor({
  grants: [
    H.ops.readWork,
    H.ops.writeWork,
    H.ops.resolve(replyApproval, escalationOutcome, H.halts.costCeiling, H.halts.interrupted, H.halts.definitionChanged),
    H.ops.readMemory,
    H.ops.writeMemory,
    H.ops.curateMemory,
    H.ops.readTelemetry,
  ],
});

const harness = H.harness('support-triage')
  .ledger(sqlite.ledger('./.harness/support.sqlite'))
  .lanes(conversations, escalations)
  .pools(pool)
  .triggers(slaBreachEscalates, escalatedOpensEscalation)
  .scheduler(timeToBreach)
  .clients(supervisor)
  .observers(markdown.board('./BOARD.md'), markdown.telemetry('./TELEMETRY.md'));

export const running = harness.start();
