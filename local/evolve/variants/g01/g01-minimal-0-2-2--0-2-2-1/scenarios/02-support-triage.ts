import { z } from 'zod';
import { H } from 'harness-dsl';
import type { Metrics, EntryFilter, PendingView } from 'harness-dsl';
import * as claudeCode from 'harness-dsl/claude-code';
import * as anthropic from 'harness-dsl/anthropic';
import * as http from 'harness-dsl/http';
import * as sqlite from 'harness-dsl/sqlite';
import * as jsonl from 'harness-dsl/jsonl';
import * as shell from 'harness-dsl/shell';
import * as markdown from 'harness-dsl/markdown';

const categories = z.enum(['billing', 'refund', 'technical', 'account', 'other']);
type Category = z.infer<typeof categories>;
const category = H.facet('category', categories);

const fresh = H.state('new', 'pending');
const classifying = H.state('classifying', 'pending');
const sent = H.state('sent', 'terminal', 'success');
const closedByCustomer = H.state('closed-by-customer', 'terminal', 'neutral');
const escalated = H.state('escalated', 'terminal', 'failure');

const conversation = H.kind('conversation')
  .data(z.object({ ticket: z.string(), subject: z.string(), latest: z.string(), slaDue: z.string() }))
  .states(fresh, classifying, sent, closedByCustomer, escalated);

const escalationOpen = H.state('escalation-open', 'pending');
const escalationClosed = H.state('escalation-closed', 'terminal', 'success');
const escalation = H.kind('escalation')
  .data(z.object({ ticket: z.string(), reason: z.string() }))
  .states(escalationOpen, escalationClosed);

const approvalDecision = z.object({
  approved: z.boolean(),
  edited: z.string().optional(),
  notes: z.string().optional(),
});
type Approval = z.infer<typeof approvalDecision>;

function safeCategory(about: { category: Category }, metrics: Metrics): Approval | null {
  const among: EntryFilter = { entry: 'halt', halt: replyApproval, status: 'resolved', resolver: 'human' };
  const byCategory = metrics.rateBy({ among, count: { ...among, decision: { approved: true } }, by: category });
  const rate = byCategory[about.category];
  if (rate === undefined) return null;
  return rate.samples >= 200 && rate.hits === rate.samples ? { approved: true } : null;
}

const replyApproval = H.halt('reply-approval', approvalDecision)
  .about(z.object({ category: categories }))
  .policy(H.policy.rule('safe-category-skips-approval', safeCategory));

const escalationHandled = H.halt('escalation-handled', z.object({ outcome: z.string() }));

const humanApprovals: EntryFilter = { entry: 'halt', halt: replyApproval, status: 'resolved', resolver: 'human' };

const haiku = anthropic.model('claude-haiku-4-5');
const sonnet = anthropic.model('claude-sonnet-4-5');
const opus = anthropic.model('claude-opus-4-1');

const drafterModel = H.policy.model('drafter-model', [sonnet, opus], choice => {
  const byModel = choice.metrics.rateBy({
    among: humanApprovals,
    count: { ...humanApprovals, decision: { approved: true } },
    by: { modelOf: choice.seat },
    days: 30,
  });
  const sonnetRate = byModel[sonnet.name];
  if (sonnetRate === undefined || sonnetRate.samples < 100 || sonnetRate.value === null) return sonnet;
  return sonnetRate.value < 0.8 ? opus : sonnet;
});

const classifierRole = H.role('classifier')
  .input(z.object({ subject: z.string(), latest: z.string() }))
  .output(z.object({ category: categories }))
  .prompt(message => `Classify this support conversation.\nSubject: ${message.subject}\nLatest message: ${message.latest}`)
  .intents(['read']);

const drafterRole = H.role('drafter')
  .input(z.object({ subject: z.string(), latest: z.string(), category: categories, notes: z.string().optional() }))
  .output(z.object({ reply: z.string() }))
  .prompt(message => [
    `Draft a reply to a ${message.category} conversation.`,
    `Subject: ${message.subject}`,
    `Customer wrote: ${message.latest}`,
    message.notes ? `The reviewer rejected the last draft: ${message.notes}` : '',
  ].join('\n'))
  .intents(['read']);

const supportTaste = H.memory('support-taste', 'taste');
const supportExperience = H.memory('support-experience', 'experience');
const tasteJournal = H.library('support-taste-journal', supportTaste, jsonl.memory('.harness/taste.jsonl'));
const experienceJournal = H.library('support-experience-journal', supportExperience, jsonl.memory('.harness/experience.jsonl'));

const classifierAgent = H.seat('classifier-agent', classifierRole).model(haiku);
const drafterAgent = H.seat('drafter-agent', drafterRole).model(drafterModel).recalls(tasteJournal, experienceJournal);

const local = shell.local('local', { slots: 4 });
const helpdeskHeaders = { 'X-Api-Token': H.env('HELPDESK_TOKEN') };

const sendReply = H.command('send-reply')
  .input(z.object({ ticket: z.string(), text: z.string() }))
  .argv(reply => ['helpdesk-cli', 'reply', reply.ticket, '--body', reply.text])
  .on(local)
  .recovery('park');

const answerConversation = H.flow('answer-conversation').for(conversation).does(async ctx => {
  const { ticket, subject, latest } = ctx.unit.data;
  const classified = await ctx.run(classifierAgent, { subject, latest });
  if (!classified.ok) return ctx.fail(classified.error);
  const kindOfIssue = classified.value.category;
  await ctx.facet(category, kindOfIssue);
  let notes: string | undefined;
  for (let round = 0; round < 3; round++) {
    const draft = await ctx.run(drafterAgent, { subject, latest, category: kindOfIssue, notes });
    if (!draft.ok) return ctx.fail(draft.error);
    const decision = await ctx.halt(replyApproval, draft.value.reply, { category: kindOfIssue });
    if (decision.approved) {
      if (decision.edited) {
        await ctx.remember(tasteJournal, {
          text: `When replying about ${kindOfIssue}, write in the reviewer's phrasing: ${decision.edited}`,
          because: 'the reviewer rewrote a drafted reply to this before approving it',
          when: { roles: [drafterRole], facets: [category.of(kindOfIssue)] },
          status: 'candidate',
        });
      }
      const delivered = await ctx.run(sendReply, { ticket, text: decision.edited ?? draft.value.reply });
      return delivered.ok ? 'sent' : ctx.fail(delivered.error);
    }
    notes = decision.notes;
  }
  return 'escalated';
});

const handleEscalation = H.flow('handle-escalation').for(escalation).does(async ctx => {
  await ctx.halt(escalationHandled, `Escalated ticket ${ctx.unit.data.ticket}: ${ctx.unit.data.reason}`);
  return 'escalation-closed';
});

const conversationShape = z.object({
  ticket: z.string(),
  subject: z.string(),
  message: z.string(),
  slaDue: z.string(),
});

const helpdeskWebhook = http.webhook(conversation, {
  path: '/hooks/helpdesk',
  secret: H.env('HELPDESK_WEBHOOK_SECRET'),
  body: z.discriminatedUnion('event', [
    conversationShape.extend({ event: z.literal('created') }),
    z.object({ event: z.literal('customer-replied'), ticket: z.string(), message: z.string() }),
    z.object({ event: z.literal('closed'), ticket: z.string() }),
  ]),
  read: body => {
    switch (body.event) {
      case 'created':
        return {
          create: { ticket: body.ticket, subject: body.subject, latest: body.message, slaDue: body.slaDue },
          key: body.ticket,
        };
      case 'customer-replied':
        return { update: body.ticket, patch: { latest: body.message }, state: 'classifying' };
      case 'closed':
        return { update: body.ticket, state: 'closed-by-customer' };
    }
  },
});

const helpdeskPoll = http.poll(conversation, {
  url: 'https://helpdesk.example.com/api/conversations?status=open',
  every: { minutes: 10 },
  headers: helpdeskHeaders,
  body: z.object({ conversations: z.array(conversationShape) }),
  read: body => body.conversations.map(open => ({
    create: { ticket: open.ticket, subject: open.subject, latest: open.message, slaDue: open.slaDue },
    key: open.ticket,
  })),
});

const helpdeskStore = http.store(conversation, {
  url: 'https://helpdesk.example.com/api/conversations',
  headers: helpdeskHeaders,
  stateField: 'harness_state',
});

const escalations = H.lane('escalations', escalation).handler(handleEscalation);

const conversations = H.lane('conversations', conversation)
  .handler(answerConversation)
  .suppliers(helpdeskWebhook, helpdeskPoll)
  .store(helpdeskStore)
  .maxUsdPerUnit(0.4)
  .retries(2, { backoff: { first: { minutes: 2 }, factor: 2 }, exhausted: 'escalated' });

const slaBreachEscalates = H.trigger(
  'sla-breach-escalates',
  H.on.deadline(conversation, data => new Date(data.slaDue), ['new', 'classifying']),
  (event, act) => [
    act.create(escalations, {
      ticket: event.unit.data.ticket,
      reason: `SLA breached at ${event.at.toISOString()}`,
    }, event.unit.key),
    act.move('escalated'),
  ]
);

const timeToBreach = H.policy.scheduler('time-to-breach', view => {
  const remainingMs = (unit: PendingView): number =>
    unit.is(conversation) ? new Date(unit.data.slaDue).getTime() - view.now.getTime() : Number.MIN_SAFE_INTEGER;
  return { start: [...view.pending].sort((a, b) => remainingMs(a) - remainingMs(b)) };
});

const apiAccount = anthropic.account('anthropic-api', { apiKey: H.env('ANTHROPIC_API_KEY') });
const apiPool = H.pool('support-api', [{ account: apiAccount, share: 1 }]);

const reviewer = claudeCode.supervisor({
  grants: [
    H.ops.readWork,
    H.ops.writeWork,
    H.ops.resolve(replyApproval, escalationHandled),
    H.ops.readMemory,
    H.ops.writeMemory,
    H.ops.curateMemory,
    H.ops.readTelemetry,
  ],
});

export const supportTriage = H.harness('support-triage')
  .ledger(sqlite.ledger('.harness/ledger.db'))
  .lanes(conversations, escalations)
  .pools(apiPool)
  .triggers(slaBreachEscalates)
  .scheduler(timeToBreach)
  .clients(reviewer)
  .observers(markdown.board('BOARD.md'), markdown.telemetry('TELEMETRY.md'));
