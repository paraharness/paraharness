import { H } from 'harness-dsl';
import type { Metrics, PendingView, Rate } from 'harness-dsl';
import { z } from 'zod';
import * as anthropic from 'harness-dsl/anthropic';
import * as claudeCode from 'harness-dsl/claude-code';
import * as http from 'harness-dsl/http';
import * as sqlite from 'harness-dsl/sqlite';
import * as jsonl from 'harness-dsl/jsonl';
import * as shell from 'harness-dsl/shell';
import * as markdown from 'harness-dsl/markdown';

const haiku = anthropic.model('claude-haiku-4');
const sonnet = anthropic.model('claude-sonnet-4');
const opus = anthropic.model('claude-opus-4');
const local = shell.local('local', { slots: 4 });

const fresh = H.state('new', 'pending');
const classifying = H.state('classifying', 'active');
const drafting = H.state('drafting', 'active');
const awaitingApproval = H.state('awaitingApproval', 'active');
const sent = H.state('sent', 'terminal', 'success');
const closedByCustomer = H.state('closedByCustomer', 'terminal', 'neutral');
const escalated = H.state('escalated', 'terminal', 'failure');

const Conversation = H.kind('Conversation')
  .data(z.object({
    conversationId: z.string(),
    customer: z.string(),
    latest: z.string(),
    category: z.string().optional(),
    slaDue: z.string(),
  }))
  .states(fresh, classifying, drafting, awaitingApproval, sent, closedByCustomer, escalated);

const opened = H.state('opened', 'pending');
const concluded = H.state('concluded', 'terminal', 'success');
const withdrawn = H.state('withdrawn', 'terminal', 'neutral');

const Audit = H.kind('Audit')
  .data(z.object({ category: z.string(), rate: z.number().nullable() }))
  .states(opened, concluded, withdrawn);

const raised = H.state('raised', 'pending');
const resolved = H.state('resolved', 'terminal', 'success');

const Escalation = H.kind('Escalation')
  .data(z.object({ conversationId: z.string(), reason: z.string() }))
  .states(raised, resolved);

const category = H.tag('category');

const approveReply = H.halt('approve-reply', z.object({
  approved: z.boolean(),
  reply: z.string(),
  notes: z.string(),
  tasteNote: z.string().optional(),
}));
const auditFindings = H.halt('audit-findings', z.object({ findings: z.string() }));
const escalationHandled = H.halt('escalation-handled', z.object({ resolution: z.string() }));

const taste = H.memory('support-taste', 'taste');
const experience = H.memory('support-experience', 'experience');
const tasteArchive = H.archive('support-taste', taste, jsonl.memory('memory/taste.jsonl'));
const experienceArchive = H.archive('support-experience', experience, jsonl.memory('memory/experience.jsonl'));
const drafterBriefing = H.briefing('drafter-briefing', [tasteArchive, experienceArchive]);

const classifierRole = H.role('classifier')
  .input(z.object({ message: z.string() }))
  .output(z.object({ category: z.string() }))
  .prompt((i) => `Classify this customer message into one support category:\n${i.message}`);

const drafterRole = H.role('drafter')
  .input(z.object({ message: z.string(), category: z.string(), notes: z.string() }))
  .output(z.object({ reply: z.string() }))
  .prompt((i) => `Draft a reply for a ${i.category} conversation.\nCustomer: ${i.message}\nReviewer notes: ${i.notes}`);

const drafterModel = H.policy.model('drafter-model', (choice) => {
  const paused = choice.metrics.sum({
    of: 'durationMs',
    among: { entry: 'lane', lane: conversations, status: 'resumed' },
    days: 1,
  });
  return (paused.value ?? 0) > 3_600_000 ? opus : sonnet;
});

const classifier = H.agent('classifier', classifierRole).model(haiku);
const drafter = H.agent('drafter', drafterRole).model(drafterModel).recalls(drafterBriefing);

const sendReply = H.command('send-reply')
  .input(z.object({ conversationId: z.string(), reply: z.string() }))
  .argv((i) => ['helpdesk-reply', '--conversation', i.conversationId, '--body', i.reply])
  .on(local)
  .recovers('park');

const monthStart = (now: Date): Date => new Date(now.getFullYear(), now.getMonth(), 1);

const safeCategory = H.policy.rule('safe-category', (input: { category: string; now: Date }, metrics: Metrics): boolean => {
  const approvals: Rate | undefined = metrics.rateBy({
    among: approveReply.resolved(),
    count: approveReply.resolved({ approved: true }),
    by: category,
    days: 365,
  })[input.category];
  const audits: Rate | undefined = metrics.rateBy({
    among: { entry: 'firing', trigger: auditTrigger },
    count: { entry: 'firing', trigger: auditTrigger, status: 'tripped' },
    by: category,
    since: monthStart(input.now),
  })[input.category];
  const auditsOpenedThisMonth = audits ? audits.hits : 0;
  return approvals !== undefined
    && approvals.samples >= 200
    && approvals.hits === approvals.samples
    && auditsOpenedThisMonth === 0;
});

const conversationFlow = H.flow('conversation').for(Conversation).does(async (ctx) => {
  const data = ctx.unit.data;
  await ctx.move('classifying');
  const classified = await ctx.run(classifier, { message: data.latest });
  if (!classified.ok) return ctx.fail(classified.error);
  const cat = classified.value.category;
  ctx.tag(category, cat);
  await ctx.update({ category: cat });

  const scope = { resources: [`category:${cat}`] };
  let notes = '';
  for (let round = 0; round < 3; round++) {
    await ctx.move('drafting');
    const drafted = await ctx.run(drafter, { message: data.latest, category: cat, notes }, { scope });
    if (!drafted.ok) return ctx.fail(drafted.error);
    let reply = drafted.value.reply;
    const safe = await ctx.decide(safeCategory, { category: cat, now: ctx.now() });
    if (!safe) {
      await ctx.move('awaitingApproval');
      const decision = await ctx.halt(approveReply, reply);
      if (decision.tasteNote) {
        await ctx.remember(tasteArchive, { text: decision.tasteNote, when: { roles: ['drafter'] } });
      }
      if (!decision.approved) {
        notes = decision.notes;
        continue;
      }
      reply = decision.reply;
    }
    const posted = await ctx.run(sendReply, { conversationId: data.conversationId, reply });
    if (!posted.ok) return ctx.fail(posted.error);
    return 'sent';
  }
  return 'escalated';
});

const auditFlow = H.flow('audit').for(Audit).does(async (ctx) => {
  await ctx.halt(auditFindings, `Approval rate for ${ctx.unit.data.category} fell to ${ctx.unit.data.rate ?? 'unknown'}`);
  return 'concluded';
});

const escalationFlow = H.flow('escalation').for(Escalation).does(async (ctx) => {
  await ctx.halt(escalationHandled, `Conversation ${ctx.unit.data.conversationId}: ${ctx.unit.data.reason}`);
  return 'resolved';
});

const helpdeskHeaders = { Authorization: H.env('HELPDESK_TOKEN') };

const helpdeskWebhook = http.webhook(Conversation, {
  path: '/hooks/helpdesk',
  secret: H.env('HELPDESK_WEBHOOK_SECRET'),
  body: z.object({
    event: z.enum(['created', 'replied', 'closed']),
    conversationId: z.string(),
    customer: z.string(),
    message: z.string(),
    slaDue: z.string(),
  }),
  read: (body) => {
    if (body.event === 'created') {
      return {
        create: { conversationId: body.conversationId, customer: body.customer, latest: body.message, slaDue: body.slaDue },
        key: body.conversationId,
      };
    }
    if (body.event === 'replied') return { update: body.conversationId, patch: { latest: body.message }, state: 'new' };
    return { update: body.conversationId, state: 'closedByCustomer' };
  },
});

const helpdeskPoll = http.poll(Conversation, {
  url: 'https://helpdesk.example.com/api/conversations?status=open',
  every: { minutes: 5 },
  headers: helpdeskHeaders,
  body: z.object({
    conversations: z.array(z.object({
      id: z.string(),
      customer: z.string(),
      lastMessage: z.string(),
      slaDue: z.string(),
    })),
  }),
  read: (body) => body.conversations.map((c) => ({
    create: { conversationId: c.id, customer: c.customer, latest: c.lastMessage, slaDue: c.slaDue },
    key: c.id,
  })),
});

const helpdeskStore = http.store(Conversation, {
  url: 'https://helpdesk.example.com/api/conversations',
  headers: helpdeskHeaders,
  stateField: 'harness_state',
});

const conversations = H.lane('conversations', Conversation)
  .handler(conversationFlow)
  .suppliers(helpdeskWebhook, helpdeskPoll)
  .store(helpdeskStore)
  .maxUsdPerUnit(0.4);

const audits = H.lane('audits', Audit).handler(auditFlow);
const escalations = H.lane('escalations', Escalation).handler(escalationFlow);

const auditTrigger = H.trigger(
  'approval-audit',
  H.on.metric(
    (metrics) => metrics.rateBy({
      among: approveReply.resolved(),
      count: approveReply.resolved({ approved: true }),
      by: category,
      days: 7,
    }),
    { trip: { below: 0.9 }, reset: { above: 0.95 }, minSamples: 50, group: category }
  ),
  (event, act) => {
    const key = `audit:${event.group}`;
    if (event.state === 'reset') return act.move(audits, key, 'withdrawn');
    return [
      act.create(audits, { category: event.group, rate: event.rate.value }, key),
      act.remember(experienceArchive, {
        text: `when drafting for ${event.group}, recall the stricter phrasing`,
        because: `approvals fell to ${event.rate.value ?? 'unknown'} over ${event.rate.samples} samples`,
        when: { roles: ['drafter'], resources: [`category:${event.group}`] },
        status: 'candidate',
      }),
    ];
  }
);

const modelErrorBrake = H.trigger(
  'model-error-brake',
  H.on.metric(
    (metrics) => metrics.rate({
      among: { entry: 'invocation', mode: ['model', 'batch'] },
      count: { entry: 'invocation', mode: ['model', 'batch'], ok: false },
      hours: 1,
    }),
    { trip: { above: 0.2 }, reset: { below: 0.05 }, minSamples: 20 }
  ),
  (event, act) => (event.state === 'tripped' ? act.pause(conversations) : act.resume(conversations))
);

const slaBreach = H.trigger(
  'sla-breach',
  H.on.deadline(Conversation, (data) => new Date(data.slaDue), ['new', 'classifying', 'drafting', 'awaitingApproval']),
  (_event, act) => act.move('escalated')
);

const escalate = H.trigger('escalate', H.on.enters(Conversation, 'escalated'), (event, act) =>
  act.create(escalations, { conversationId: event.unit.data.conversationId, reason: 'escalated' }, `escalation:${event.unit.key}`)
);

const timeToBreach = (unit: PendingView): number =>
  unit.is(Conversation) ? Date.parse(unit.data.slaDue) : Number.MAX_SAFE_INTEGER;

const slaFirst = H.policy.scheduler('sla-first', (view) => ({
  start: [...view.pending].sort((a, b) => timeToBreach(a) - timeToBreach(b)),
}));

const pool = H.pool('anthropic', [
  { account: anthropic.account('anthropic-api', { apiKey: H.env('ANTHROPIC_API_KEY') }), share: 1 },
]);

export const support = H.harness('support-self-watch')
  .ledger(sqlite.ledger('.harness/support.db'))
  .lanes(conversations, audits, escalations)
  .pools(pool)
  .triggers(auditTrigger, modelErrorBrake, slaBreach, escalate)
  .scheduler(slaFirst)
  .clients(claudeCode.supervisor({
    grants: [H.ops.readWork, H.ops.writeWork, H.ops.resolveHalts, H.ops.readMemory, H.ops.writeMemory, H.ops.curateMemory, H.ops.readTelemetry],
  }))
  .observers(markdown.board('BOARD.md'), markdown.telemetry('TELEMETRY.md'));
