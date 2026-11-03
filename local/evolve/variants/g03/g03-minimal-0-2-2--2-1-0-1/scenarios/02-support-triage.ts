import { z } from 'zod';
import { H } from 'harness-dsl';
import type { Metrics, PendingView, SupplyOf } from 'harness-dsl';
import * as claudeCode from 'harness-dsl/claude-code';
import * as anthropic from 'harness-dsl/anthropic';
import * as sqlite from 'harness-dsl/sqlite';
import * as jsonl from 'harness-dsl/jsonl';
import * as shell from 'harness-dsl/shell';
import * as http from 'harness-dsl/http';
import * as markdown from 'harness-dsl/markdown';

const categories = z.enum(['billing', 'refund', 'technical', 'account', 'other']);
const category = H.facet('category', categories);

const fresh = H.state('new', 'pending');
const classifying = H.state('classifying', 'pending');
const sent = H.state('sent', 'terminal', 'success');
const closedByCustomer = H.state('closedByCustomer', 'terminal', 'neutral');
const escalated = H.state('escalated', 'terminal', 'failure');
const open = H.state('open', 'pending');
const handled = H.state('handled', 'terminal', 'success');
const unhandled = H.state('unhandled', 'terminal', 'failure');

const Conversation = H.kind('Conversation')
  .data(z.object({
    customer: z.string(),
    subject: z.string(),
    messages: z.array(z.string()),
    slaDue: z.date(),
    category: categories.optional(),
  }))
  .states(fresh, classifying, sent, closedByCustomer, escalated);

const Escalation = H.kind('Escalation')
  .data(z.object({ conversation: z.string(), subject: z.string() }))
  .states(open, handled, unhandled);

const classifierRole = H.role('classifier')
  .input(z.object({ subject: z.string(), messages: z.array(z.string()) }))
  .output(z.object({ category: categories }))
  .prompt(input => `Classify this support conversation.\n\nSubject: ${input.subject}\n\n${input.messages.join('\n---\n')}`);

const drafterRole = H.role('drafter')
  .input(z.object({
    subject: z.string(),
    messages: z.array(z.string()),
    category: categories,
    note: z.string().optional(),
  }))
  .output(z.object({ reply: z.string() }))
  .prompt(input => [
    `Draft a reply to this ${input.category} conversation.`,
    `Subject: ${input.subject}`,
    input.messages.join('\n---\n'),
    input.note !== undefined ? `The reviewer rejected the last draft: ${input.note}` : '',
  ].join('\n\n'));

const haiku = anthropic.model('claude-haiku-4-5');
const sonnet = anthropic.model('claude-sonnet-4-5');
const opus = anthropic.model('claude-opus-4-1');

const apiAccount = anthropic.account('anthropic-api', { apiKey: H.env('ANTHROPIC_API_KEY') });
const pool = H.pool('anthropic', [{ account: apiAccount, share: 1, serves: [haiku, sonnet, opus] }]);

const taste = H.journal('replyTaste', H.memory('replyTaste', 'taste'), jsonl.memory('memory/taste.jsonl'));
const experience = H.journal('supportExperience', H.memory('supportExperience', 'experience'), jsonl.memory('memory/experience.jsonl'));

const approvalDecision = z.object({
  approved: z.boolean(),
  edited: z.string().optional(),
  note: z.string().optional(),
});
const approvalAbout = z.object({ category: categories });
type ApprovalDecision = z.infer<typeof approvalDecision>;
type ApprovalAbout = z.infer<typeof approvalAbout>;

const drafterModel = H.policy.model('approvedDraftsByModel', [sonnet, opus], choice => {
  const byModel = choice.metrics.rateBy({
    among: { ...replyApproval.resolved(), resolver: 'human' },
    count: { ...replyApproval.resolved({ approved: true }), resolver: 'human' },
    by: { modelOf: choice.seat },
    days: 30,
  });
  const cheaper = byModel.of(sonnet);
  const stronger = byModel.of(opus);
  if (cheaper.samples < 50 || stronger.samples < 50) return cheaper.samples <= stronger.samples ? sonnet : opus;
  return (stronger.value ?? 0) > (cheaper.value ?? 0) + 0.05 ? opus : sonnet;
});

const classifier = H.seat('classifier', classifierRole).model(haiku);
const drafter = H.seat('drafter', drafterRole).model(drafterModel).recalls(taste, experience);

const safeCategory = H.policy.rule('safeCategory', (about: ApprovalAbout, metrics: Metrics): ApprovalDecision | null => {
  const scope = [category.of(about.category)];
  const human = metrics.rate({
    among: { ...replyApproval.resolved(), resolver: 'human', facets: scope },
    count: { ...replyApproval.resolved({ approved: true }), resolver: 'human', facets: scope },
  });
  return human.samples >= 200 && human.hits === human.samples ? { approved: true } : null;
});

const replyApproval = H.halt('replyApproval', approvalDecision)
  .about(approvalAbout)
  .policy(safeCategory)
  .credits(() => [drafter]);

const escalationHandled = H.halt('escalationHandled', z.object({ resolution: z.string() }));

const local = shell.local('local', { slots: 4 });

const sendReply = H.command('sendReply')
  .input(z.object({ conversation: z.string(), text: z.string() }))
  .argv(input => ['helpdesk-reply', '--conversation', input.conversation, '--text', input.text])
  .on(local);

const triage = H.flow('triage')
  .for(Conversation)
  .does(async ctx => {
    const data = ctx.unit.data;
    const classified = await ctx.run(classifier, { subject: data.subject, messages: data.messages });
    if (!classified.ok) return ctx.fail(classified.error);
    const kind = classified.value.category;
    await ctx.update({ category: kind });
    let note: string | undefined;
    for (let round = 0; round < 3; round += 1) {
      const drafted = await ctx.run(drafter, { subject: data.subject, messages: data.messages, category: kind, note });
      if (!drafted.ok) return ctx.fail(drafted.error);
      const decision = await ctx.halt(replyApproval, drafted.value.reply, { category: kind });
      if (decision.approved) {
        if (decision.edited !== undefined) {
          await ctx.remember(taste, {
            text: `When replying to a ${kind} conversation, write as the reviewer did: "${decision.edited}"`,
            because: `the reviewer rewrote the draft "${drafted.value.reply}"`,
            when: { roles: [drafterRole], facets: [category.of(kind)] },
            status: 'candidate',
          });
        }
        const delivered = await ctx.run(sendReply, { conversation: ctx.unit.key, text: decision.edited ?? drafted.value.reply });
        return delivered.ok ? 'sent' : ctx.fail(delivered.error);
      }
      note = decision.note;
    }
    return ctx.fail('three drafts were rejected');
  });

const escalationDesk = H.flow('escalationDesk')
  .for(Escalation)
  .does(async ctx => {
    await ctx.halt(escalationHandled, `Escalated conversation ${ctx.unit.data.conversation}: ${ctx.unit.data.subject}`);
    return 'handled';
  });

const helpdeskHeaders = { Authorization: H.env('HELPDESK_TOKEN') };

const conversationBody = z.object({
  id: z.string(),
  customer: z.string(),
  subject: z.string(),
  messages: z.array(z.string()),
  slaDue: z.string(),
});

const helpdeskHook = http.webhook(Conversation, {
  path: '/helpdesk',
  secret: H.env('HELPDESK_WEBHOOK_SECRET'),
  body: z.object({ event: z.enum(['created', 'customerReplied', 'closed']), conversation: conversationBody }),
  read: (body): SupplyOf<typeof Conversation> => {
    const c = body.conversation;
    if (body.event === 'created') {
      return { create: { customer: c.customer, subject: c.subject, messages: c.messages, slaDue: new Date(c.slaDue) }, key: c.id };
    }
    if (body.event === 'customerReplied') {
      return { update: c.id, patch: { messages: c.messages }, state: 'classifying', cancels: ['waiting'] };
    }
    return { update: c.id, state: 'closedByCustomer', cancels: ['active', 'waiting'] };
  },
});

const helpdeskPoll = http.poll(Conversation, {
  url: 'https://helpdesk.example.com/api/conversations?status=open',
  every: { minutes: 10 },
  headers: helpdeskHeaders,
  body: z.object({ conversations: z.array(conversationBody) }),
  read: body => body.conversations.map((c): SupplyOf<typeof Conversation> => ({
    create: { customer: c.customer, subject: c.subject, messages: c.messages, slaDue: new Date(c.slaDue) },
    key: c.id,
  })),
});

const conversations = H.lane('conversations', Conversation)
  .handler(triage)
  .attempts(2, { backoff: { first: { minutes: 1 } }, exhausted: 'escalated' })
  .suppliers(helpdeskHook, helpdeskPoll)
  .store(http.store(Conversation, {
    url: 'https://helpdesk.example.com/api/conversations',
    headers: helpdeskHeaders,
    stateField: 'harness_state',
  }))
  .maxUsdPerUnit(0.4)
  .facet(category, data => data.category);

const escalations = H.lane('escalations', Escalation)
  .handler(escalationDesk)
  .attempts(1, { exhausted: 'unhandled' });

const slaBreach = H.trigger(
  'slaBreach',
  H.on.deadline(Conversation, data => data.slaDue, ['new', 'classifying']),
  (event, act) => act.move('escalated'),
);

const escalationOpens = H.trigger(
  'escalationOpens',
  H.on.enters(Conversation, 'escalated'),
  (event, act) => act.create(escalations, { conversation: event.unit.key, subject: event.unit.data.subject }, event.unit.key),
);

const timeToBreach = H.policy.scheduler('timeToBreach', view => {
  const breachAt = (unit: PendingView): number => unit.is(Conversation) ? unit.data.slaDue.getTime() : 0;
  return { start: view.pending.slice().sort((a, b) => breachAt(a) - breachAt(b)) };
});

const supervisor = claudeCode.supervisor({
  grants: [
    H.ops.readWork,
    H.ops.resolve(replyApproval, escalationHandled, H.halts.costCeiling),
    H.ops.readMemory,
    H.ops.writeMemory,
    H.ops.curateMemory,
    H.ops.readTelemetry,
  ],
});

export const supportTriage = H.harness('support-triage')
  .ledger(sqlite.ledger('.harness/ledger.sqlite'))
  .lanes(conversations, escalations)
  .pools(pool)
  .triggers(slaBreach, escalationOpens)
  .scheduler(timeToBreach)
  .clients(supervisor)
  .observers(markdown.board('BOARD.md'), markdown.telemetry('TELEMETRY.md'));
