import { z } from 'zod';
import { H } from 'harness-dsl';
import type { EntryFilter, Metrics, PendingView, Rate } from 'harness-dsl';
import * as anthropic from 'harness-dsl/anthropic';
import * as http from 'harness-dsl/http';
import * as sqlite from 'harness-dsl/sqlite';
import * as jsonl from 'harness-dsl/jsonl';
import * as shell from 'harness-dsl/shell';
import * as claudeCode from 'harness-dsl/claude-code';
import * as markdown from 'harness-dsl/markdown';

const Category = z.enum(['billing', 'refunds', 'technical', 'account', 'shipping']);

const conversationData = z.object({
  id: z.string(),
  customer: z.string(),
  subject: z.string(),
  latestMessage: z.string(),
  slaDue: z.string(),
  category: Category.optional(),
});

const Conversation = H.kind('Conversation')
  .data(conversationData)
  .states({
    new: 'pending',
    classifying: 'active',
    drafting: 'active',
    'awaiting-approval': 'active',
    sent: 'waiting',
    'closed-by-customer': 'success',
    escalated: 'failure',
  }, 'new');

const Escalation = H.kind('Escalation')
  .data(z.object({ conversation: z.string(), customer: z.string(), reason: z.string() }))
  .states({ open: 'pending', handling: 'active', resolved: 'success', abandoned: 'failure' }, 'open');

const taste = H.memory('reply-taste', 'owner');
const experience = H.memory('support-experience', 'fallible');

const mostSpecific = H.policy.recall('most-specific', view =>
  [...view.items]
    .sort((a, b) => b.specificity - a.specificity || (b.trackRecord.value ?? 0) - (a.trackRecord.value ?? 0))
    .slice(0, 10)
);

const tasteLibrary = H.library('reply-taste', taste, jsonl.memory('memory/taste.jsonl')).recall(mostSpecific);
const experienceLibrary = H.library('support-experience', experience, jsonl.memory('memory/experience.jsonl')).recall(mostSpecific);

const quota = sqlite.quota('.harness/quota.sqlite');
const apiAccount = anthropic.account('anthropic-api', { apiKey: H.env('ANTHROPIC_API_KEY'), quota });
const apiPool = H.pool(
  'api',
  [{ account: apiAccount, share: 1 }],
  H.policy.account('first-eligible', choice => choice.accounts.find(view => view.eligible)?.account ?? null)
);

const cheapModel = anthropic.model('claude-haiku-4-5');
const midModel = anthropic.model('claude-sonnet-4-5');
const strongModel = anthropic.model('claude-opus-4-1');

const approvalHalts: EntryFilter = { entry: 'halt', halt: 'approve-reply', status: 'resolved' };
const approvedHalts: EntryFilter = { ...approvalHalts, decision: { approved: true } };
const noSamples: Rate = { value: null, hits: 0, samples: 0 };

const drafterByApproval = H.policy.model('drafter-by-approval-rate', choice => {
  const rates = choice.metrics.rateBy({ among: approvalHalts, count: approvedHalts, by: { tag: 'drafterModel' }, days: 30 });
  const mid = rates[midModel.name] ?? noSamples;
  const strong = rates[strongModel.name] ?? noSamples;
  if (mid.samples < 100) return strong.samples >= (mid.samples + 1) * 4 ? midModel : strongModel;
  return (mid.value ?? 0) >= (strong.value ?? 0) ? midModel : strongModel;
});

const safeToSend = H.policy.rule('safe-category', (input: { readonly category: string }, metrics: Metrics) => {
  const approvals = metrics.rate({
    among: { ...approvalHalts, tags: { category: input.category } },
    count: { ...approvedHalts, tags: { category: input.category } },
  });
  return approvals.samples >= 200 && approvals.hits === approvals.samples;
});

const classifierRole = H.role('classifier')
  .input(z.object({ subject: z.string(), message: z.string() }))
  .output(z.object({ category: Category }))
  .prompt(input => `Classify this support message.\nSubject: ${input.subject}\n\n${input.message}`);

const drafterRole = H.role('drafter')
  .input(z.object({ customer: z.string(), subject: z.string(), message: z.string(), category: Category }))
  .output(z.object({ reply: z.string() }))
  .prompt(input => `Draft a reply to ${input.customer} about "${input.subject}" (${input.category}).\n\n${input.message}`);

const classifier = H.agent('classifier', classifierRole).model(cheapModel);
const drafter = H.agent('drafter', drafterRole)
  .model(drafterByApproval)
  .recalls(tasteLibrary, experienceLibrary);

const local = shell.local('local', { slots: 4 });

const sendReply = H.command('send-reply')
  .input(z.object({ id: z.string(), reply: z.string() }))
  .argv(input => ['helpdesk', 'reply', input.id, '--body', input.reply])
  .on(local);

const review = z.object({
  approved: z.boolean(),
  editedReply: z.string().optional(),
  tasteNote: z.string().optional(),
});

const triage = H.flow('triage')
  .for(Conversation)
  .does(async ctx => {
    await ctx.move('classifying');
    const classified = await ctx.run(classifier, { subject: ctx.unit.data.subject, message: ctx.unit.data.latestMessage });
    if (classified.ok === false) return ctx.fail(classified.error);
    const category = classified.value.category;
    ctx.tag({ category });
    await ctx.update({ category });

    await ctx.move('drafting');
    const draft = await ctx.run(
      drafter,
      { customer: ctx.unit.data.customer, subject: ctx.unit.data.subject, message: ctx.unit.data.latestMessage, category },
      { skills: [category] }
    );
    if (draft.ok === false) return ctx.fail(draft.error);
    ctx.tag({ drafterModel: draft.model ?? 'unknown' });

    let reply = draft.value.reply;
    const safe = await ctx.decide(safeToSend, { category });
    if (safe === false) {
      await ctx.move('awaiting-approval');
      const decision = await ctx.halt({ name: 'approve-reply', show: reply, decision: review });
      if (typeof decision.tasteNote === 'string') {
        await ctx.remember(tasteLibrary, {
          text: decision.tasteNote,
          because: 'the reviewer edited a drafted reply this way',
          when: { roles: [drafterRole], skills: [category] },
        });
      }
      if (decision.approved === false) return 'escalated';
      reply = decision.editedReply ?? reply;
    }

    const sent = await ctx.run(sendReply, { id: ctx.unit.data.id, reply });
    if (sent.ok === false) return ctx.fail(sent.error);
    return 'sent';
  });

const handleEscalation = H.flow('handle-escalation')
  .for(Escalation)
  .does(async ctx => {
    await ctx.move('handling');
    const outcome = await ctx.halt({
      name: 'handle-escalation',
      show: `Conversation ${ctx.unit.data.conversation} with ${ctx.unit.data.customer}: ${ctx.unit.data.reason}`,
      decision: z.object({ resolved: z.boolean(), resolution: z.string() }),
    });
    return outcome.resolved ? 'resolved' : 'abandoned';
  });

const webhookBody = z.object({
  event: z.enum(['created', 'replied', 'closed']),
  conversation: z.object({
    id: z.string(),
    customer: z.string(),
    subject: z.string(),
    message: z.string(),
    slaDue: z.string(),
  }),
});

const helpdeskWebhook = http.webhook(Conversation, {
  path: '/hooks/helpdesk',
  secret: H.env('HELPDESK_WEBHOOK_SECRET'),
  body: webhookBody,
  read: body => {
    const c = body.conversation;
    if (body.event === 'created') {
      return {
        create: { id: c.id, customer: c.customer, subject: c.subject, latestMessage: c.message, slaDue: c.slaDue },
        key: c.id,
      };
    }
    if (body.event === 'replied') {
      return { update: c.id, patch: { latestMessage: c.message }, state: 'new' };
    }
    return { update: c.id, state: 'closed-by-customer' };
  },
});

const helpdeskPoll = http.poll(Conversation, {
  url: 'https://helpdesk.example.com/api/conversations?status=open',
  every: { minutes: 10 },
  headers: { 'X-Api-Key': H.env('HELPDESK_API_KEY') },
  body: z.object({ conversations: z.array(webhookBody.shape.conversation) }),
  read: body => body.conversations.map(c => ({
    create: { id: c.id, customer: c.customer, subject: c.subject, latestMessage: c.message, slaDue: c.slaDue },
    key: c.id,
  })),
});

const helpdeskStore = http.store(Conversation, {
  url: 'https://helpdesk.example.com/api/conversations',
  headers: { 'X-Api-Key': H.env('HELPDESK_API_KEY') },
  stateField: 'harness_state',
});

const conversations = H.lane('conversations', Conversation)
  .handler(triage)
  .suppliers(helpdeskWebhook, helpdeskPoll)
  .store(helpdeskStore)
  .maxUsdPerUnit(0.4);

const escalations = H.lane('escalations', Escalation)
  .handler(handleEscalation)
  .suppliers(H.operator);

const slaBreach = H.trigger(
  'sla-breach-escalates',
  H.on.deadline(Conversation, data => new Date(data.slaDue), ['new', 'classifying', 'drafting', 'awaiting-approval']),
  (event, act) => [
    act.create(
      escalations,
      { conversation: event.unit.data.id, customer: event.unit.data.customer, reason: `SLA breached at ${event.at.toISOString()}` },
      { key: `escalation-${event.unit.data.id}` }
    ),
    act.move('escalated'),
  ]
);

const timeToBreach = (unit: PendingView): number =>
  unit.is(Conversation) ? new Date(unit.data.slaDue).getTime() : 0;

const breachFirst = H.policy.scheduler('time-to-breach', view => ({
  start: [...view.pending].sort((a, b) => timeToBreach(a) - timeToBreach(b)),
}));

const supervisor = claudeCode.supervisor({
  grants: [H.ops.readWork, H.ops.writeWork, H.ops.resolveHalts, H.ops.readMemory, H.ops.writeMemory, H.ops.readTelemetry],
});

export default H.harness('support-triage')
  .ledger(sqlite.ledger('.harness/ledger.sqlite'))
  .lanes(conversations, escalations)
  .pools(apiPool)
  .triggers(slaBreach)
  .scheduler(breachFirst)
  .clients(supervisor)
  .observers(markdown.board('BOARD.md'), markdown.telemetry('TELEMETRY.md'));
