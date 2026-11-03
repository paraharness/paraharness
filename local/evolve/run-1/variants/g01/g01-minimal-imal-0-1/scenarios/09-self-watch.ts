import { z } from 'zod';
import { H } from 'harness-dsl';
import type { Metrics, Rate, SupplyOf } from 'harness-dsl';
import * as anthropic from 'harness-dsl/anthropic';
import * as http from 'harness-dsl/http';
import * as sqlite from 'harness-dsl/sqlite';
import * as jsonl from 'harness-dsl/jsonl';
import * as shell from 'harness-dsl/shell';
import * as markdown from 'harness-dsl/markdown';
import * as claude from 'harness-dsl/claude-code';

const helpdeskHeaders = { Authorization: H.env('HELPDESK_TOKEN') };
const local = shell.local('local', { slots: 4 });

const Conversation = H.kind('conversation')
  .data(z.object({
    conversationId: z.string(),
    subject: z.string(),
    lastMessage: z.string(),
    category: z.string().optional(),
    slaDueAt: z.string(),
  }))
  .states([
    H.state('new', 'pending'),
    H.state('classifying', 'active'),
    H.state('drafting', 'active'),
    H.state('awaiting-approval', 'active'),
    H.state('needs-human', 'waiting'),
    H.state('sent', 'terminal', 'success'),
    H.state('closed-by-customer', 'terminal', 'neutral'),
    H.state('escalated', 'terminal', 'neutral'),
  ], { initial: 'new', afterFailure: 'needs-human' });

const Escalation = H.kind('escalation')
  .data(z.object({ conversationId: z.string(), reason: z.string() }))
  .states([H.state('open', 'pending'), H.state('handling', 'active'), H.state('resolved', 'terminal', 'success')], {
    initial: 'open',
    afterFailure: 'open',
  });

const Audit = H.kind('audit')
  .data(z.object({ category: z.string(), rate: z.number().nullable(), samples: z.number() }))
  .states([
    H.state('opened', 'pending'),
    H.state('reviewing', 'active'),
    H.state('done', 'terminal', 'success'),
    H.state('cancelled', 'terminal', 'neutral'),
  ], { initial: 'opened', afterFailure: 'opened' });

const Taste = H.memory('reply-taste', 'taste');
const Experience = H.memory('support-experience', 'experience');
const taste = H.library('reply-taste', Taste, jsonl.memory('memory/taste.jsonl'));
const experience = H.library('support-experience', Experience, jsonl.memory('memory/experience.jsonl'));

const classifierRole = H.role('classifier')
  .input(z.object({ subject: z.string(), message: z.string() }))
  .output(z.object({ category: z.string() }))
  .prompt(i => `Classify this support message.\nSubject: ${i.subject}\n\n${i.message}`);

const drafterRole = H.role('drafter')
  .input(z.object({ category: z.string(), message: z.string() }))
  .output(z.object({ reply: z.string() }))
  .prompt(i => `Draft a reply for a ${i.category} conversation:\n\n${i.message}`);

const classifier = H.agent('classifier', classifierRole).model(anthropic.model('claude-haiku-4-5'));
const drafter = H.agent('drafter', drafterRole).model(anthropic.model('claude-sonnet-4-5')).recalls(taste, experience);

const sendReply = H.command('send-reply')
  .input(z.object({ conversationId: z.string(), reply: z.string() }))
  .argv(i => ['./scripts/helpdesk-reply', i.conversationId, i.reply])
  .on(local);

const safeCategory = H.policy.rule('safe-category', (category: string, metrics: Metrics): boolean => {
  const approvals = metrics.rate({
    among: { entry: 'halt', halt: 'approval', status: 'resolved', tags: { category } },
    count: { entry: 'halt', halt: 'approval', status: 'resolved', tags: { category }, decision: { approved: true } },
  });
  return approvals.samples >= 200 && approvals.hits === approvals.samples;
});

const conversationFlow = H.flow('conversation').for(Conversation).does(async ctx => {
  const c = ctx.unit.data;
  await ctx.move('classifying');
  const classified = await ctx.run(classifier, { subject: c.subject, message: c.lastMessage });
  if (!classified.ok) return ctx.fail(classified.error);
  const category = classified.value.category;
  await ctx.update({ category });
  ctx.tag({ category });

  await ctx.move('drafting');
  const draft = await ctx.run(drafter, { category, message: c.lastMessage }, { scope: { skills: [category] } });
  if (!draft.ok) return ctx.fail(draft.error);

  let reply = draft.value.reply;
  if (!(await ctx.decide(safeCategory, category))) {
    await ctx.move('awaiting-approval');
    const approval = await ctx.halt({
      name: 'approval',
      show: reply,
      decision: z.object({ approved: z.boolean(), reply: z.string(), tasteNote: z.string().optional() }),
    });
    if (approval.tasteNote !== undefined && approval.tasteNote !== '') {
      await ctx.remember(taste, { text: approval.tasteNote, when: { roles: [drafterRole], skills: [category] } });
    }
    if (!approval.approved) return 'needs-human';
    reply = approval.reply;
  }
  const sent = await ctx.run(sendReply, { conversationId: c.conversationId, reply });
  if (!sent.ok) return ctx.fail(sent.error);
  return 'sent';
});

const helpdeskWebhook = http.webhook(Conversation, {
  path: '/hooks/helpdesk',
  secret: H.env('HELPDESK_WEBHOOK_SECRET'),
  body: z.object({
    event: z.enum(['created', 'customer-replied', 'closed']),
    conversationId: z.string(),
    subject: z.string(),
    message: z.string(),
    slaDueAt: z.string(),
  }),
  read: (b): SupplyOf<typeof Conversation> => {
    if (b.event === 'created') {
      return { create: { conversationId: b.conversationId, subject: b.subject, lastMessage: b.message, slaDueAt: b.slaDueAt }, key: b.conversationId };
    }
    if (b.event === 'closed') return { update: b.conversationId, state: 'closed-by-customer' };
    return { update: b.conversationId, patch: { lastMessage: b.message }, state: 'new' };
  },
});

const helpdeskPoll = http.poll(Conversation, {
  url: 'https://helpdesk.example.com/api/conversations?status=open',
  every: { minutes: 5 },
  headers: helpdeskHeaders,
  body: z.object({
    conversations: z.array(z.object({ id: z.string(), subject: z.string(), lastMessage: z.string(), slaDueAt: z.string() })),
  }),
  read: b => b.conversations.map((c): SupplyOf<typeof Conversation> => ({
    create: { conversationId: c.id, subject: c.subject, lastMessage: c.lastMessage, slaDueAt: c.slaDueAt },
    key: c.id,
  })),
});

const conversations = H.lane('conversations', Conversation)
  .handler(conversationFlow)
  .suppliers(helpdeskWebhook, helpdeskPoll)
  .store(http.store(Conversation, { url: 'https://helpdesk.example.com/api/conversations', headers: helpdeskHeaders, stateField: 'harness_state' }))
  .maxUsdPerUnit(0.4);

const escalationFlow = H.flow('escalation').for(Escalation).does(async ctx => {
  await ctx.move('handling');
  await ctx.halt({
    name: 'handle-escalation',
    show: `Conversation ${ctx.unit.data.conversationId}: ${ctx.unit.data.reason}`,
    decision: z.object({ resolution: z.string() }),
  });
  return 'resolved';
});
const escalations = H.lane('escalations', Escalation).handler(escalationFlow).store(sqlite.store(Escalation, 'support.db'));

const startOfMonth = (now: Date): Date => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));

const selfWatchReport = H.policy.rule(
  'self-watch-report',
  (input: { readonly category: string; readonly since: Date }, metrics: Metrics) => {
    const opened = metrics.countBy({
      among: { entry: 'firing', trigger: 'approval-watch', edge: 'entered' },
      by: 'group',
      since: input.since,
    });
    const paused = metrics.duration({ lane: 'conversations', condition: 'paused', since: input.since });
    return { auditsThisMonth: opened[input.category] ?? 0, pausedMs: paused.totalMs, pauses: paused.spans };
  }
);

const auditFlow = H.flow('audit').for(Audit).does(async ctx => {
  const a = ctx.unit.data;
  await ctx.move('reviewing');
  const report = await ctx.decide(selfWatchReport, { category: a.category, since: startOfMonth(ctx.now()) });
  await ctx.halt({
    name: 'audit-findings',
    show: `Approval rate for ${a.category} fell to ${a.rate ?? 'n/a'} over ${a.samples} samples. ` +
      `Audits this month: ${report.auditsThisMonth}. Lane paused ${Math.round(report.pausedMs / 60_000)} minutes in ${report.pauses} spans.`,
    decision: z.object({ findings: z.string() }),
  });
  return 'done';
});
const audits = H.lane('audits', Audit).handler(auditFlow).store(sqlite.store(Audit, 'support.db'));

const slaBreach = H.trigger(
  'sla-breach-escalates',
  H.on.deadline(Conversation, c => new Date(c.slaDueAt), ['new', 'classifying', 'drafting', 'awaiting-approval', 'needs-human']),
  (event, act) => [
    act.create(escalations, { conversationId: event.unit.data.conversationId, reason: 'SLA breached' }, `escalation:${event.unit.key}`),
    act.move('escalated'),
  ]
);

const approvalWatch = H.trigger(
  'approval-watch',
  H.on.metric({
    every: { minutes: 15 },
    read: metrics => metrics.rateBy({
      among: { entry: 'halt', halt: 'approval', status: 'resolved' },
      count: { entry: 'halt', halt: 'approval', status: 'resolved', decision: { approved: true } },
      by: { tag: 'category' },
      days: 7,
    }),
    enter: rate => rate.samples >= 50 && rate.value !== null && rate.value < 0.9,
    exit: rate => rate.value !== null && rate.value > 0.95,
  }),
  (event, act) => event.edge === 'entered'
    ? [
      act.create(audits, { category: event.group, rate: event.rate.value, samples: event.rate.samples }, `audit:${event.group}`),
      act.remember(experience, {
        text: `When drafting for ${event.group}, recall the stricter phrasing`,
        because: `approvals fell to ${event.rate.value ?? 'n/a'} over ${event.rate.samples} samples`,
        when: { roles: [drafterRole], skills: [event.group] },
        status: 'candidate',
      }),
    ]
    : act.moveUnit(audits, `audit:${event.group}`, 'cancelled')
);

function combine(a: Rate, b: Rate): Rate {
  const hits = a.hits + b.hits;
  const samples = a.samples + b.samples;
  return { hits, samples, value: samples === 0 ? null : hits / samples };
}

const modelErrorRate = (metrics: Metrics, executable: string): Rate => metrics.rate({
  among: { entry: 'invocation', executable, status: ['ok', 'failed', 'timed-out'] },
  count: { entry: 'invocation', executable, ok: false },
  hours: 1,
});

const modelHealth = H.trigger(
  'model-health-pauses-conversations',
  H.on.metric({
    every: { minutes: 1 },
    read: metrics => ({ 'model-errors': combine(modelErrorRate(metrics, classifier.name), modelErrorRate(metrics, drafter.name)) }),
    enter: rate => rate.samples >= 20 && rate.value !== null && rate.value > 0.2,
    exit: rate => rate.value !== null && rate.value < 0.05,
  }),
  (event, act) => event.edge === 'entered' ? act.pause(conversations) : act.resume(conversations)
);

const api = anthropic.account('api', { apiKey: H.env('ANTHROPIC_API_KEY') });

const timeToBreach = H.policy.scheduler('audits-escalations-then-breach-order', view => {
  const dueMs = (data: unknown): number => {
    const parsed = z.object({ slaDueAt: z.string() }).safeParse(data);
    return parsed.success ? new Date(parsed.data.slaDueAt).getTime() : 0;
  };
  return { start: [...view.pending].sort((a, b) => dueMs(a.data) - dueMs(b.data)) };
});

export const support = H.harness('support-self-watch')
  .ledger(sqlite.ledger('support-ledger.db'))
  .lanes(conversations, escalations, audits)
  .pools(H.pool('models', [{ account: api, share: 1 }], H.policy.account('api-only', c => c.accounts.find(a => a.eligible)?.account ?? null)))
  .triggers(slaBreach, approvalWatch, modelHealth)
  .scheduler(timeToBreach)
  .clients(claude.supervisor({
    grants: [H.ops.readWork, H.ops.writeWork, H.ops.resolveHalts, H.ops.writeMemory, H.ops.curateMemory, H.ops.readTelemetry],
  }))
  .observers(markdown.board('board.md'), markdown.telemetry('telemetry.md'));
