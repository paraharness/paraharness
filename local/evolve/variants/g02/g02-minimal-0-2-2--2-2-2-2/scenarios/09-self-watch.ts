import { z } from 'zod';
import { H } from 'harness-dsl';
import type { Metrics, Measurement, PendingView, SupplyOf } from 'harness-dsl';
import * as anthropic from 'harness-dsl/anthropic';
import * as claudeCode from 'harness-dsl/claude-code';
import * as sqlite from 'harness-dsl/sqlite';
import * as jsonl from 'harness-dsl/jsonl';
import * as shell from 'harness-dsl/shell';
import * as http from 'harness-dsl/http';
import * as markdown from 'harness-dsl/markdown';

const local = shell.local('local', { slots: 4 });
const apiAccount = anthropic.account('anthropic-api', { apiKey: H.env('ANTHROPIC_API_KEY') });
const classifierModel = anthropic.model('claude-haiku-4-5');
const drafterModelA = anthropic.model('claude-sonnet-4-5');
const drafterModelB = anthropic.model('claude-opus-4-1');

const categorySchema = z.enum(['billing', 'refund', 'shipping', 'account']);
const categoryFacet = H.facet('category', z.string());

const taste = H.journal('support-taste', H.memory('support-taste', 'taste'), jsonl.memory('/srv/support/taste.jsonl'));
const experience = H.journal(
  'support-experience',
  H.memory('support-experience', 'experience'),
  jsonl.memory('/srv/support/experience.jsonl')
);

const fresh = H.state('new', 'pending');
const classifying = H.state('classifying', 'pending');
const sent = H.state('sent', 'waiting');
const closedByCustomer = H.state('closed-by-customer', 'terminal', 'success');
const escalated = H.state('escalated', 'terminal', 'neutral');

const conversation = H.kind('conversation')
  .data(
    z.object({
      customer: z.string(),
      subject: z.string(),
      messages: z.array(z.string()),
      slaDueAt: z.string(),
      category: categorySchema.optional(),
    })
  )
  .states(fresh, classifying, sent, closedByCustomer, escalated);

const classifierRole = H.role('classifier')
  .input(z.object({ messages: z.array(z.string()) }))
  .output(z.object({ category: categorySchema }))
  .prompt(input => `Classify this conversation:\n${input.messages.join('\n---\n')}`);

const drafterRole = H.role('drafter')
  .input(z.object({ messages: z.array(z.string()), category: categorySchema, notes: z.string() }))
  .output(z.object({ reply: z.string() }))
  .prompt(
    input =>
      `Draft a reply for a ${input.category} conversation.\nReviewer notes: ${input.notes}\n${input.messages.join('\n---\n')}`
  );

const approvalDecision = z.object({
  approved: z.boolean(),
  edited: z.string().optional(),
  notes: z.string().optional(),
});
const approvalAbout = z.object({ category: categorySchema, reply: z.string(), drafterInvocation: z.string() });
type ApprovalDecision = z.infer<typeof approvalDecision>;
type ApprovalAbout = z.infer<typeof approvalAbout>;

const safeCategory = H.policy.rule(
  'safe-category-after-200-clean-approvals',
  (about: ApprovalAbout, metrics: Metrics): ApprovalDecision | null => {
    const inCategory = [categoryFacet.value(about.category)];
    const record = metrics.rate({
      among: { ...approval.resolved(undefined, 'human'), facets: inCategory },
      count: { ...approval.resolved({ approved: false }, 'human'), facets: inCategory },
    });
    return record.samples >= 200 && record.hits === 0 ? { approved: true } : null;
  }
);

const approval = H.halt('reply-approval', approvalDecision)
  .about(approvalAbout)
  .policy(safeCategory)
  .credits((decision, about) => (decision.approved ? [about.drafterInvocation] : []));

const drafterByApproval = H.policy.model('drafter-by-approval-rate', choice => {
  const byModel = choice.metrics.rateBy({
    among: { entry: 'invocation', seat: choice.seat, status: 'ended', ok: true },
    count: { entry: 'credit', halt: approval },
    by: 'model',
    days: 30,
  });
  const a = byModel[drafterModelA.name];
  const b = byModel[drafterModelB.name];
  if (a && b && a.samples >= 50 && b.samples >= 50 && a.value !== null && b.value !== null) {
    return a.value >= b.value ? drafterModelA : drafterModelB;
  }
  return (a ? a.samples : 0) <= (b ? b.samples : 0) ? drafterModelA : drafterModelB;
});

const classifier = H.seat('classifier', classifierRole).model(classifierModel);
const drafter = H.seat('drafter', drafterRole).model(drafterByApproval).recalls(taste, experience);

const sendReply = H.command('send-reply')
  .input(z.object({ conversation: z.string(), reply: z.string() }))
  .argv(input => ['helpdesk', 'reply', input.conversation, input.reply])
  .on(local)
  .recovery('park');

const costCeiling = H.halt('conversation-cost-ceiling', z.object({ continue: z.boolean() })).about(
  z.object({ spentUsd: z.number(), limitUsd: z.number() })
);

const handleConversation = H.flow('handle-conversation')
  .for(conversation)
  .does(async ctx => {
    const classified = await ctx.run(classifier, { messages: ctx.unit.data.messages });
    if (classified.ok === false) return ctx.fail(classified.error);
    const category = classified.value.category;
    await ctx.update({ category });
    ctx.tag(categoryFacet, category);
    let notes = '';
    for (let round = 0; round < 3; round++) {
      const draft = await ctx.run(
        drafter,
        { messages: ctx.unit.data.messages, category, notes },
        { scope: { facets: [categoryFacet.value(category)] } }
      );
      if (draft.ok === false) return ctx.fail(draft.error);
      const decision = await ctx.halt(approval, draft.value.reply, {
        category,
        reply: draft.value.reply,
        drafterInvocation: draft.invocation,
      });
      if (decision.approved) {
        const delivered = await ctx.run(sendReply, {
          conversation: ctx.unit.key,
          reply: decision.edited ?? draft.value.reply,
        });
        if (delivered.ok === false) return ctx.fail(delivered.error);
        return 'sent';
      }
      notes = decision.notes ?? '';
    }
    return 'escalated';
  });

const helpdeskHeaders = { Authorization: H.env('HELPDESK_TOKEN') };
const conversationBody = z.object({
  conversationId: z.string(),
  event: z.enum(['created', 'customer-reply', 'closed']),
  customer: z.string(),
  subject: z.string(),
  messages: z.array(z.string()),
  slaDueAt: z.string(),
});

const helpdeskWebhook = http.webhook(conversation, {
  path: '/helpdesk',
  secret: H.env('HELPDESK_WEBHOOK_SECRET'),
  body: conversationBody,
  read: body =>
    body.event === 'created'
      ? {
          create: { customer: body.customer, subject: body.subject, messages: body.messages, slaDueAt: body.slaDueAt },
          key: body.conversationId,
        }
      : body.event === 'closed'
        ? { update: body.conversationId, state: 'closed-by-customer' }
        : { update: body.conversationId, patch: { messages: body.messages }, state: 'classifying' },
});

const helpdeskPoll = http.poll(conversation, {
  url: 'https://helpdesk.example.com/api/conversations?open=true',
  every: { minutes: 10 },
  headers: helpdeskHeaders,
  body: z.object({ conversations: z.array(conversationBody) }),
  read: body =>
    body.conversations.map(
      (item): SupplyOf<typeof conversation> => ({
        create: { customer: item.customer, subject: item.subject, messages: item.messages, slaDueAt: item.slaDueAt },
        key: item.conversationId,
      })
    ),
});

const helpdeskStore = http.store(conversation, {
  url: 'https://helpdesk.example.com/api/conversations',
  headers: helpdeskHeaders,
  stateField: 'harness_state',
});

const conversations = H.lane('conversations', conversation)
  .handler(handleConversation)
  .suppliers(helpdeskWebhook, helpdeskPoll)
  .store(helpdeskStore)
  .wip(6)
  .maxUsdPerUnit(0.4, costCeiling);

const escalationOpen = H.state('escalation-open', 'pending');
const escalationClosed = H.state('escalation-closed', 'terminal', 'success');
const escalation = H.kind('escalation')
  .data(z.object({ conversation: z.string(), reason: z.string() }))
  .states(escalationOpen, escalationClosed);

const escalationHandled = H.halt('escalation-handled', z.object({ resolution: z.string() })).about(
  z.object({ conversation: z.string(), reason: z.string() })
);

const handleEscalation = H.flow('handle-escalation')
  .for(escalation)
  .does(async ctx => {
    await ctx.halt(escalationHandled, `Escalated conversation ${ctx.unit.data.conversation}`, ctx.unit.data);
    return 'escalation-closed';
  });

const escalations = H.lane('escalations', escalation)
  .handler(handleEscalation)
  .suppliers(H.operator)
  .store(sqlite.store(escalation, '/srv/support/units.db'));

const auditOpen = H.state('audit-open', 'pending');
const auditClosed = H.state('audit-closed', 'terminal', 'success');
const auditCancelled = H.state('audit-cancelled', 'terminal', 'neutral');
const audit = H.kind('audit')
  .data(z.object({ category: z.string(), rate: z.number() }))
  .states(auditOpen, auditClosed, auditCancelled);

const auditReview = H.halt('audit-review', z.object({ findings: z.string() })).about(
  z.object({ category: z.string(), rate: z.number() })
);

const handleAudit = H.flow('handle-audit')
  .for(audit)
  .does(async ctx => {
    await ctx.halt(auditReview, `Approval rate for ${ctx.unit.data.category} fell to ${ctx.unit.data.rate}`, ctx.unit.data);
    return 'audit-closed';
  });

const audits = H.lane('audits', audit)
  .handler(handleAudit)
  .suppliers(H.operator)
  .store(sqlite.store(audit, '/srv/support/units.db'));

const sla = H.deadline('conversation-sla', conversation, data => new Date(data.slaDueAt), ['new', 'classifying']);

const slaBreach = H.trigger('sla-breach', H.on.deadline(sla), (_event, act) => act.move('escalated'));

const openEscalation = H.trigger('open-escalation', H.on.enters(conversation, 'escalated'), (event, act) =>
  act.create(escalations, { conversation: event.unit.key, reason: 'escalated' }, `escalation-${event.unit.key}`)
);

const approvalWatch = H.trigger(
  'approval-watch',
  H.on.metric(
    metrics =>
      metrics.rateBy({
        among: approval.resolved(),
        count: approval.resolved({ approved: true }),
        by: categoryFacet,
        days: 7,
      }),
    { trip: { below: 0.9 }, reset: { above: 0.95 }, minSamples: 50 }
  ),
  (event, act) => {
    const auditKey = `audit-${event.group}-${event.trippedAt.toISOString()}`;
    if (event.state === 'reset') return act.move(audits, auditKey, 'audit-cancelled');
    const rate = event.rate.value ?? 0;
    return [
      act.create(audits, { category: event.group, rate }, auditKey),
      act.remember(experience, {
        text: `when drafting for ${event.group}, recall the stricter phrasing`,
        because: `approvals fell to ${rate}`,
        when: { roles: [drafterRole], facets: [categoryFacet.value(event.group)] },
        status: 'candidate',
      }),
    ];
  }
);

const modelErrorBrake = H.trigger(
  'model-error-brake',
  H.on.metric(
    metrics =>
      metrics.rate({
        among: { entry: 'invocation', mode: 'model', status: 'ended' },
        count: { entry: 'invocation', mode: 'model', status: 'ended', ok: false },
        hours: 1,
      }),
    { trip: { above: 0.2 }, reset: { below: 0.05 }, minSamples: 20 }
  ),
  (event, act) => (event.state === 'tripped' ? act.pause(conversations) : act.resume(conversations))
);

const byTimeToBreach = H.policy.scheduler('time-to-breach', view => {
  const dueAt = (unit: PendingView): number => (unit.is(conversation) ? new Date(unit.data.slaDueAt).getTime() : 0);
  return { start: [...view.pending].sort((a, b) => dueAt(a) - dueAt(b)) };
});

const selfWatch = H.report('self-watch', (metrics, now) => {
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const values: Record<string, Measurement> = {};
  for (const category of categorySchema.options) {
    values[`auditsOpened.${category}`] = metrics.count({
      of: { entry: 'firing', trigger: approvalWatch, status: 'tripped', group: category },
      since: monthStart,
    });
  }
  values['lanePausedMs'] = metrics.sum({
    of: 'durationMs',
    among: { entry: 'lane', lane: conversations, status: 'resumed' },
    since: monthStart,
  });
  const byCategory = metrics.rateBy({
    among: approval.resolved(),
    count: approval.resolved({ approved: true }),
    by: categoryFacet,
    days: 30,
  });
  for (const [category, rate] of Object.entries(byCategory)) values[`approvalRate.category.${category}`] = rate;
  const byModel = metrics.rateBy({
    among: { entry: 'invocation', seat: drafter, status: 'ended', ok: true },
    count: { entry: 'credit', halt: approval },
    by: { modelOf: drafter },
    days: 30,
  });
  for (const [model, rate] of Object.entries(byModel)) values[`approvalRate.model.${model}`] = rate;
  return values;
});

export const support = H.harness('support')
  .ledger(sqlite.ledger('/srv/support/ledger.db'))
  .lanes(conversations, escalations, audits)
  .pools(H.pool('api', [{ account: apiAccount, share: 1 }]))
  .triggers(slaBreach, openEscalation, approvalWatch, modelErrorBrake)
  .scheduler(byTimeToBreach)
  .reports(selfWatch)
  .clients(
    claudeCode.supervisor({
      grants: [
        H.ops.readWork,
        H.ops.resolve(approval, costCeiling, escalationHandled, auditReview, H.parked),
        H.ops.reschedule(sla),
        H.ops.writeMemory,
        H.ops.readMemory,
        H.ops.readTelemetry,
      ],
    })
  )
  .observers(markdown.board('/srv/support/BOARD.md'), markdown.telemetry('/srv/support/TELEMETRY.md'));

export const running = support.start();
