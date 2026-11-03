import { z } from 'zod';
import { H } from 'harness-dsl';
import type { PendingView } from 'harness-dsl';
import * as anthropic from 'harness-dsl/anthropic';
import * as claudeCode from 'harness-dsl/claude-code';
import * as http from 'harness-dsl/http';
import * as sqlite from 'harness-dsl/sqlite';
import * as jsonl from 'harness-dsl/jsonl';
import * as shell from 'harness-dsl/shell';
import * as markdown from 'harness-dsl/markdown';

const apiAccount = anthropic.account('support-api', { apiKey: H.env('ANTHROPIC_API_KEY') });
const haiku = anthropic.model('claude-haiku-4-5');
const sonnet = anthropic.model('claude-sonnet-4-5');
const runner = shell.local('local', { slots: 4 });

const categories = ['billing', 'refund', 'shipping', 'account', 'other'] as const satisfies readonly string[];
const categorySchema = z.enum(categories);
const categoryFacet = H.facet('category', categorySchema);

const fresh = H.state('new', 'pending');
const reopened = H.state('reopened', 'pending');
const sent = H.state('sent', 'terminal', 'success');
const closedByCustomer = H.state('closed-by-customer', 'terminal', 'neutral');
const escalated = H.state('escalated', 'terminal', 'neutral');

const conversation = H.kind('conversation')
  .data(z.object({
    conversationId: z.string(),
    messages: z.string(),
    slaDueAt: z.string(),
    category: categorySchema.optional(),
  }))
  .states(fresh, reopened, sent, closedByCustomer, escalated);

const helpdeskHeaders = { Authorization: H.env('HELPDESK_TOKEN') };

const helpdeskWebhook = http.webhook(conversation, {
  path: '/helpdesk',
  secret: H.env('HELPDESK_WEBHOOK_SECRET'),
  body: z.discriminatedUnion('event', [
    z.object({ event: z.literal('created'), id: z.string(), message: z.string(), slaDueAt: z.string() }),
    z.object({ event: z.literal('replied'), id: z.string(), message: z.string() }),
    z.object({ event: z.literal('closed'), id: z.string() }),
  ]),
  read: body =>
    body.event === 'created'
      ? { create: { conversationId: body.id, messages: body.message, slaDueAt: body.slaDueAt }, key: body.id }
      : body.event === 'replied'
        ? { update: body.id, patch: { messages: body.message }, state: 'reopened' }
        : { update: body.id, state: 'closed-by-customer' },
});

const helpdeskPoll = http.poll(conversation, {
  url: 'https://helpdesk.example.com/api/conversations?status=open',
  every: { minutes: 10 },
  headers: helpdeskHeaders,
  body: z.object({ items: z.array(z.object({ id: z.string(), message: z.string(), slaDueAt: z.string() })) }),
  read: body => body.items.map(item => ({
    create: { conversationId: item.id, messages: item.message, slaDueAt: item.slaDueAt },
    key: item.id,
  })),
});

const helpdeskStore = http.store(conversation, {
  url: 'https://helpdesk.example.com/api/conversations',
  headers: helpdeskHeaders,
  stateField: 'status',
});

const supportTaste = H.memory('support-taste', 'taste');
const supportExperience = H.memory('support-experience', 'experience');
const tasteJournal = H.journal('support-taste-journal', supportTaste, jsonl.memory('/srv/support/taste.jsonl'));
const experienceJournal = H.journal('support-experience-journal', supportExperience, jsonl.memory('/srv/support/experience.jsonl'));

const classifierRole = H.role('classifier')
  .input(z.object({ messages: z.string() }))
  .output(z.object({ category: categorySchema }))
  .prompt(input => `Classify this customer conversation:\n${input.messages}`);

const drafterRole = H.role('drafter')
  .input(z.object({ messages: z.string(), category: categorySchema }))
  .output(z.object({ reply: z.string() }))
  .prompt(input => `Draft a reply for a ${input.category} conversation:\n${input.messages}`);

const classifier = H.seat('classifier', classifierRole).model(haiku);
const drafter = H.seat('drafter', drafterRole).model(sonnet).recalls(tasteJournal, experienceJournal);

const approvalAbout = z.object({ category: categorySchema });
const approval = H.halt('reply-approval', z.object({ approve: z.boolean(), editedReply: z.string().optional() }))
  .about(approvalAbout)
  .policy(
    H.policy.rule('safe-category-auto-approval', (about: z.infer<typeof approvalAbout>, metrics) => {
      const record = metrics.rate({
        among: { entry: 'grade', seat: drafter, facets: [categoryFacet.value(about.category)] },
        count: { entry: 'grade', seat: drafter, grade: 'accepted', facets: [categoryFacet.value(about.category)] },
      });
      return record.samples >= 200 && record.hits === record.samples ? { approve: true } : null;
    })
  );

const costCeiling = H.halt('cost-ceiling', z.object({ continue: z.boolean() }))
  .about(z.object({ spentUsd: z.number(), limitUsd: z.number() }));

const sendReply = H.command('send-reply')
  .input(z.object({ conversationId: z.string(), reply: z.string() }))
  .argv(input => ['helpdesk', 'reply', input.conversationId, input.reply])
  .on(runner)
  .recovery('park');

const conversationHandling = H.flow('conversation-handling')
  .for(conversation)
  .does(async ctx => {
    const classified = await ctx.run(classifier, { messages: ctx.unit.data.messages });
    if (!classified.ok) return ctx.fail(classified.error);
    const category = classified.value.category;
    ctx.tag(categoryFacet, category);
    await ctx.update({ category });
    const drafted = await ctx.run(drafter, { messages: ctx.unit.data.messages, category }, {
      scope: { facets: [categoryFacet.value(category)] },
    });
    if (!drafted.ok) return ctx.fail(drafted.error);
    const decision = await ctx.halt(approval, drafted.value.reply, { category });
    await ctx.grade(drafted, decision.approve ? 'accepted' : 'rejected');
    const reply = decision.approve ? drafted.value.reply : decision.editedReply ?? drafted.value.reply;
    const delivered = await ctx.run(sendReply, { conversationId: ctx.unit.data.conversationId, reply });
    if (!delivered.ok) return ctx.fail(delivered.error);
    return 'sent';
  });

const conversations = H.lane('conversations', conversation)
  .handler(conversationHandling)
  .suppliers(helpdeskWebhook, helpdeskPoll)
  .store(helpdeskStore)
  .allowance(H.allowance('conversation-allowance', conversation).maxUsd(0.4, costCeiling));

const escalationOpen = H.state('escalation-open', 'pending');
const escalationResolved = H.state('escalation-resolved', 'terminal', 'success');

const escalation = H.kind('escalation')
  .data(z.object({ conversationId: z.string(), slaDueAt: z.string() }))
  .states(escalationOpen, escalationResolved);

const escalationHandled = H.halt('escalation-handled', z.object({ resolution: z.string() }));

const escalationHandling = H.flow('escalation-handling')
  .for(escalation)
  .does(async ctx => {
    await ctx.halt(escalationHandled, `SLA breached on conversation ${ctx.unit.data.conversationId}`);
    return 'escalation-resolved';
  });

const escalations = H.lane('escalations', escalation)
  .handler(escalationHandling)
  .store(sqlite.store(escalation, '/srv/support/escalations.sqlite'));

const auditOpen = H.state('audit-open', 'pending');
const auditClosed = H.state('audit-closed', 'terminal', 'success');
const auditCancelled = H.state('audit-cancelled', 'terminal', 'neutral');

const audit = H.kind('audit')
  .data(z.object({ category: z.string(), approvalRate: z.number(), samples: z.number() }))
  .states(auditOpen, auditClosed, auditCancelled);

const auditFindings = H.halt('audit-findings', z.object({ findings: z.string() }));

const auditHandling = H.flow('audit-handling')
  .for(audit)
  .does(async ctx => {
    await ctx.halt(
      auditFindings,
      `Approval rate for ${ctx.unit.data.category} fell to ${ctx.unit.data.approvalRate} over ${ctx.unit.data.samples} samples`
    );
    return 'audit-closed';
  });

const audits = H.lane('audits', audit)
  .handler(auditHandling)
  .store(sqlite.store(audit, '/srv/support/audits.sqlite'));

const slaBreach = H.trigger(
  'sla-breach',
  H.on.deadline(conversation, data => new Date(data.slaDueAt), ['new', 'reopened']),
  (event, act) => [
    act.create(escalations, { conversationId: event.unit.data.conversationId, slaDueAt: event.unit.data.slaDueAt }),
    act.move('escalated'),
  ]
);

const auditKey = (category: string, trippedAt: Date) => `audit-${category}-${trippedAt.toISOString()}`;

const approvalWatch = H.trigger(
  'approval-rate-watch',
  H.on.metric(
    metrics => metrics.rateBy({
      among: { entry: 'grade', seat: drafter },
      count: { entry: 'grade', seat: drafter, grade: 'accepted' },
      by: categoryFacet,
      days: 7,
    }),
    { trip: { below: 0.9 }, reset: { above: 0.95 }, minSamples: 50 }
  ),
  (event, act) =>
    event.state === 'tripped'
      ? [
          act.create(
            audits,
            { category: event.group, approvalRate: event.rate.value ?? 0, samples: event.rate.samples },
            auditKey(event.group, event.trippedAt)
          ),
          act.remember(experienceJournal, {
            text: `When drafting for ${event.group}, recall the stricter phrasing`,
            because: `approvals fell to ${event.rate.value ?? 'unknown'} over ${event.rate.samples} samples`,
            when: { roles: [drafterRole], facets: [{ facet: categoryFacet.name, value: event.group }] },
            status: 'candidate',
          }),
        ]
      : act.move(audits, auditKey(event.group, event.trippedAt), 'audit-cancelled')
);

const modelErrorWatch = H.trigger(
  'model-error-watch',
  H.on.metric(
    metrics => metrics.rate({
      among: { entry: 'invocation', mode: 'model', status: 'ended' },
      count: { entry: 'invocation', mode: 'model', status: 'ended', ok: false },
      hours: 1,
    }),
    { trip: { above: 0.2 }, reset: { below: 0.05 }, minSamples: 20 }
  ),
  (event, act) => (event.state === 'tripped' ? act.pause(conversations) : act.resume(conversations))
);

const timeToBreach = (unit: PendingView) =>
  unit.is(conversation) ? Date.parse(unit.data.slaDueAt) : Number.MAX_SAFE_INTEGER;

const breachFirst = H.policy.scheduler('time-to-breach-first', view => ({
  start: [...view.pending].sort((a, b) => timeToBreach(a) - timeToBreach(b)),
}));

const selfWatch = H.report('self-watch', (metrics, now) => {
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const rows: Record<string, number> = {};
  for (const category of categories) {
    rows[`audits-opened/${category}`] = metrics.count({
      of: { entry: 'firing', trigger: approvalWatch, status: 'tripped', group: category },
      since: monthStart,
    });
  }
  return {
    ...rows,
    conversationsPausedMs: metrics.sum({
      of: 'durationMs',
      among: { entry: 'lane', lane: conversations, status: 'resumed' },
      since: monthStart,
    }),
    approvalByModel: metrics.rate({
      among: { entry: 'grade', seat: drafter },
      count: { entry: 'grade', seat: drafter, grade: 'accepted' },
      days: 30,
    }),
  };
});

export const supportHarness = H.harness('support-self-watch')
  .ledger(sqlite.ledger('/srv/support/ledger.sqlite'))
  .lanes(conversations, escalations, audits)
  .pools(H.pool('support-pool', [{ account: apiAccount, share: 1 }]))
  .triggers(slaBreach, approvalWatch, modelErrorWatch)
  .scheduler(breachFirst)
  .reports(selfWatch)
  .clients(
    claudeCode.supervisor({
      grants: [
        H.ops.readWork,
        H.ops.writeWork,
        H.ops.resolve(approval, costCeiling, escalationHandled, auditFindings, H.halts.changed, H.halts.interrupted),
        H.ops.writeMemory,
        H.ops.curateMemory,
        H.ops.readTelemetry,
      ],
    })
  )
  .observers(markdown.board('/srv/support/BOARD.md'), markdown.telemetry('/srv/support/TELEMETRY.md'));
