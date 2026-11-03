import { z } from 'zod';
import { H } from 'harness-dsl';
import type { DataOf, StateOf, EntryFilter, Mean, PendingView, Rate, Supply } from 'harness-dsl';
import * as anthropic from 'harness-dsl/anthropic';
import * as sqlite from 'harness-dsl/sqlite';
import * as jsonl from 'harness-dsl/jsonl';
import * as http from 'harness-dsl/http';
import * as shell from 'harness-dsl/shell';
import * as markdown from 'harness-dsl/markdown';
import * as claudeCode from 'harness-dsl/claude-code';

const categories = H.resources('categories', ['billing', 'refund', 'technical', 'account', 'shipping']);

const Conversation = H.kind('conversation')
  .data(z.object({
    conversationId: z.string(),
    customer: z.string(),
    message: z.string(),
    slaDueAt: z.string(),
    category: categories.schema.optional(),
  }))
  .states({
    new: 'pending',
    classifying: 'pending',
    drafting: 'active',
    'awaiting-approval': 'active',
    sent: 'waiting',
    'closed-by-customer': 'success',
    escalated: 'failure',
  }, 'new');

type ConversationData = DataOf<typeof Conversation>;
type ConversationState = StateOf<typeof Conversation>;

const Escalation = H.kind('escalation')
  .data(z.object({ conversationId: z.string(), reason: z.string() }))
  .states({ open: 'pending', resolved: 'success', 'handed-back': 'neutral' }, 'open');

const Audit = H.kind('audit')
  .data(z.object({ category: z.string(), approvalRate: z.number().nullable(), samples: z.number() }))
  .states({ open: 'pending', 'findings-recorded': 'success', withdrawn: 'neutral' }, 'open');

const helpdeskEvent = z.object({
  type: z.enum(['created', 'customer-replied', 'closed']),
  conversationId: z.string(),
  customer: z.string(),
  message: z.string(),
  slaDueAt: z.string(),
});
type HelpdeskEvent = z.infer<typeof helpdeskEvent>;

function fromHelpdesk(event: HelpdeskEvent): Supply<ConversationData, ConversationState> {
  if (event.type === 'created') {
    return {
      create: { conversationId: event.conversationId, customer: event.customer, message: event.message, slaDueAt: event.slaDueAt },
      key: event.conversationId,
    };
  }
  if (event.type === 'customer-replied') {
    return { update: event.conversationId, patch: { message: event.message }, state: 'classifying' };
  }
  return { update: event.conversationId, state: 'closed-by-customer' };
}

const helpdeskHeaders = { authorization: H.env('HELPDESK_TOKEN') };

const helpdeskHook = http.webhook(Conversation, {
  path: '/hooks/helpdesk',
  secret: H.env('HELPDESK_WEBHOOK_SECRET'),
  body: helpdeskEvent,
  read: fromHelpdesk,
});

const helpdeskPoll = http.poll(Conversation, {
  url: 'https://helpdesk.example.com/api/conversations?open=true',
  every: { minutes: 5 },
  headers: helpdeskHeaders,
  body: z.object({ conversations: z.array(helpdeskEvent) }),
  read: body => body.conversations.filter(event => event.type === 'created').map(fromHelpdesk),
});

const helpdeskStore = http.store(Conversation, {
  url: 'https://helpdesk.example.com/api/conversations',
  headers: helpdeskHeaders,
  stateField: 'harnessStatus',
});

const taste = H.memory('taste', 'owner');
const experience = H.memory('experience', 'fallible');

const specificFirst = H.policy.recall('specific-first', view =>
  [...view.items]
    .sort((x, y) => y.specificity - x.specificity || (y.trackRecord.value ?? 0) - (x.trackRecord.value ?? 0))
    .slice(0, 10));

const tasteLibrary = H.library('support-taste', taste, jsonl.memory('memory/taste.jsonl')).recall(specificFirst);
const experienceLibrary = H.library('support-experience', experience, jsonl.memory('memory/experience.jsonl')).recall(specificFirst);

const classifierRole = H.role('classifier')
  .input(z.object({ message: z.string() }))
  .output(z.object({ category: categories.schema }))
  .prompt(input => `Classify this customer message into one category.\n\n${input.message}`);

const drafterRole = H.role('drafter')
  .input(z.object({ customer: z.string(), message: z.string(), category: categories.schema }))
  .output(z.object({ reply: z.string() }))
  .prompt(input => `Draft a reply to ${input.customer} about a ${input.category} matter.\n\n${input.message}`);

const cheap = anthropic.model('claude-haiku-4-5');
const strong = anthropic.model('claude-sonnet-4-5');

const classifier = H.agent('classifier', classifierRole).model(cheap);
const drafter = H.agent('drafter', drafterRole).model(strong).recalls(tasteLibrary, experienceLibrary);

const local = shell.local('local', { slots: 4 });

const sendReply = H.command('send-reply')
  .input(z.object({ conversationId: z.string(), reply: z.string() }))
  .argv(input => ['helpdesk-reply', '--conversation', input.conversationId, '--body', input.reply])
  .on(local)
  .restart('park');

const approvals: EntryFilter = { entry: 'halt', halt: 'approve-reply', status: 'resolved' };
const approved: EntryFilter = { decision: { approved: true } };
const noSamples: Rate = { value: null, hits: 0, samples: 0 };
const noMean: Mean = { value: null, samples: 0 };

const safeCategory = H.policy.rule<string, boolean>('safe-category', (category, metrics) => {
  const rate = metrics.rateBy({ among: approvals, count: approved, by: { tag: 'category' }, days: 365 })[category] ?? noSamples;
  return rate.samples >= 200 && rate.hits === rate.samples;
});

const conversationFlow = H.flow('conversation').for(Conversation).does(async ctx => {
  const { conversationId, customer, message } = ctx.unit.data;

  const classified = await ctx.run(classifier, { message });
  if (!classified.ok) return ctx.fail(classified.error);
  const category = classified.value.category;
  ctx.tag({ category });
  await ctx.update({ category });

  await ctx.move('drafting');
  const drafted = await ctx.run(drafter, { customer, message, category });
  if (!drafted.ok) return ctx.fail(drafted.error);
  let reply = drafted.value.reply;

  if (!(await ctx.decide(safeCategory, category))) {
    await ctx.move('awaiting-approval');
    const review = await ctx.halt({
      name: 'approve-reply',
      show: reply,
      decision: z.object({ approved: z.boolean(), reply: z.string(), tasteNote: z.string() }),
    });
    if (review.tasteNote) {
      await ctx.remember(tasteLibrary, {
        text: review.tasteNote,
        because: `the reviewer edited a ${category} reply`,
        when: { kinds: [Conversation], roles: [drafterRole] },
      });
    }
    if (!review.approved) return 'escalated';
    reply = review.reply;
  }

  const sent = await ctx.run(sendReply, { conversationId, reply });
  if (!sent.ok) return ctx.fail(sent.error);
  return 'sent';
});

const conversations = H.lane('conversations', Conversation)
  .handler(conversationFlow)
  .suppliers(helpdeskHook, helpdeskPoll)
  .store(helpdeskStore)
  .maxUsdPerUnit(0.4)
  .touches(data => (data.category ? [categories.of(data.category)] : []));

const escalationFlow = H.flow('escalation').for(Escalation).does(async ctx => {
  const handled = await ctx.halt({
    name: 'handle-escalation',
    show: `Conversation ${ctx.unit.data.conversationId}: ${ctx.unit.data.reason}`,
    decision: z.object({ resolved: z.boolean() }),
  });
  return handled.resolved ? 'resolved' : 'handed-back';
});

const escalations = H.lane('escalations', Escalation).handler(escalationFlow);

const auditHistory = H.policy.rule<{ readonly category: string; readonly since: Date }, { readonly opened: number; readonly pausedMs: number }>(
  'audit-history',
  (input, metrics) => {
    const opened = metrics.count({
      among: { entry: 'firing', trigger: 'approval-watch', tags: { direction: 'entered' } },
      by: { tag: 'group' },
      since: input.since,
    })[input.category] ?? 0;
    const paused = metrics.duration({
      opened: { entry: 'lane', lane: 'conversations', status: 'paused' },
      closed: { entry: 'lane', lane: 'conversations', status: 'resumed' },
      by: 'lane',
      since: input.since,
    })['conversations'] ?? noMean;
    return { opened, pausedMs: (paused.value ?? 0) * paused.samples };
  },
);

const auditFlow = H.flow('audit').for(Audit).does(async ctx => {
  const now = ctx.now();
  const history = await ctx.decide(auditHistory, {
    category: ctx.unit.data.category,
    since: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)),
  });
  await ctx.halt({
    name: 'audit-category',
    show: [
      `Approval rate for ${ctx.unit.data.category} fell to ${ctx.unit.data.approvalRate ?? 'unknown'} over ${ctx.unit.data.samples} samples.`,
      `Audits opened for this category this month: ${history.opened}.`,
      `Conversations lane paused this month: ${Math.round(history.pausedMs / 60000)} minutes.`,
    ].join('\n'),
    decision: z.object({ findings: z.string() }),
  });
  return 'findings-recorded';
});

const audits = H.lane('audits', Audit).handler(auditFlow);

const approvalWatch = H.trigger('approval-watch', H.on.threshold({
  read: metrics => metrics.rateBy({ among: approvals, count: approved, by: { tag: 'category' }, days: 7 }),
  enter: { below: 0.9, minSamples: 50 },
  exit: { above: 0.95 },
}), (crossing, act) => {
  if (crossing.direction === 'exited') return act.close(audits, crossing.group, 'withdrawn');
  const category = categories.ids.find(id => id === crossing.group);
  const rate = crossing.rate.value === null ? 'unknown' : crossing.rate.value.toFixed(2);
  return [
    act.create(audits, {
      category: crossing.group,
      approvalRate: crossing.rate.value,
      samples: crossing.rate.samples,
    }, { dedupe: crossing.group }),
    act.remember(experienceLibrary, {
      text: `when drafting for ${crossing.group}, recall the stricter phrasing`,
      because: `approvals fell to ${rate}`,
      status: 'candidate',
      when: { roles: [drafterRole], resources: category ? [categories.of(category)] : [] },
    }),
  ];
});

const modelErrorWatch = H.trigger('model-error-watch', H.on.threshold({
  read: metrics => {
    const finished = (executable: string): EntryFilter => ({ entry: 'invocation', status: 'finished', lane: 'conversations', executable });
    const classifierErrors = metrics.rate({ among: finished(classifier.name), count: { ok: false }, hours: 1 });
    const drafterErrors = metrics.rate({ among: finished(drafter.name), count: { ok: false }, hours: 1 });
    const hits = classifierErrors.hits + drafterErrors.hits;
    const samples = classifierErrors.samples + drafterErrors.samples;
    return { conversations: { value: samples > 0 ? hits / samples : null, hits, samples } };
  },
  enter: { above: 0.2, minSamples: 20 },
  exit: { below: 0.05 },
}), (crossing, act) => (crossing.direction === 'entered' ? act.pause(conversations) : act.resume(conversations)));

const slaBreach = H.trigger(
  'sla-breach',
  H.on.deadline(Conversation, data => new Date(data.slaDueAt), ['new', 'classifying', 'drafting', 'awaiting-approval']),
  (event, act) => [
    act.create(escalations, { conversationId: event.unit.data.conversationId, reason: 'SLA breached' }, { key: `sla:${event.unit.key}` }),
    act.move('escalated'),
  ],
);

const api = anthropic.account('support-api', { apiKey: H.env('ANTHROPIC_API_KEY'), quota: sqlite.quota('quota.db') });
const pool = H.pool('api', [{ account: api, share: 1 }], H.policy.account('only-api', choice =>
  choice.accounts.find(view => view.eligible)?.account ?? null));

const urgency = (unit: PendingView, now: Date) => {
  if (unit.lane === 'escalations') return Number.MIN_SAFE_INTEGER;
  if (unit.is(Conversation)) return Date.parse(unit.data.slaDueAt) - now.getTime();
  return Number.MAX_SAFE_INTEGER;
};

export const supportSelfWatch = H.harness('support')
  .ledger(sqlite.ledger('support.db'))
  .lanes(conversations, escalations, audits)
  .pools(pool)
  .triggers(approvalWatch, modelErrorWatch, slaBreach)
  .scheduler(H.policy.scheduler('time-to-breach', ({ pending, now }) => ({
    start: [...pending].sort((x, y) => urgency(x, now) - urgency(y, now)),
  })))
  .clients(claudeCode.supervisor({
    grants: [
      H.ops.readWork,
      H.ops.writeWork,
      H.ops.resolveHalts,
      H.ops.readMemory,
      H.ops.writeMemory,
      H.ops.curateMemory,
      H.ops.readTelemetry,
    ],
  }))
  .observers(markdown.board('board.md'), markdown.telemetry('telemetry.md'));
