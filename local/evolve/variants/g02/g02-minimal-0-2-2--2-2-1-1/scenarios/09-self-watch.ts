import { z } from 'zod';
import { H } from 'harness-dsl';
import type { Halt, Metrics, PendingView, Rate, SupplyOf, Trigger } from 'harness-dsl';
import * as anthropic from 'harness-dsl/anthropic';
import * as claude from 'harness-dsl/claude-code';
import * as http from 'harness-dsl/http';
import * as jsonl from 'harness-dsl/jsonl';
import * as sqlite from 'harness-dsl/sqlite';
import * as shell from 'harness-dsl/shell';
import * as markdown from 'harness-dsl/markdown';

const apiAccount = anthropic.account('anthropic-api', { apiKey: H.env('ANTHROPIC_API_KEY') });
const haiku = anthropic.model('claude-haiku-4');
const sonnet = anthropic.model('claude-sonnet-4');
const pool = H.pool('accounts', [{ account: apiAccount, share: 1 }]);
const localRunner = shell.local('local', { slots: 4 });

const categories = z.enum(['billing', 'refunds', 'shipping', 'technical', 'other']);
type Category = z.infer<typeof categories>;
const category = H.facet('category', categories);

const tasteMemory = H.memory('taste', 'taste');
const experienceMemory = H.memory('experience', 'experience');
const replyTaste = H.library('reply-taste', tasteMemory, jsonl.memory('.harness/taste.jsonl'));
const drafterExperience = H.library('drafter-experience', experienceMemory, jsonl.memory('.harness/experience.jsonl'));

const conversation = H.kind('conversation')
  .data(
    z.object({
      subject: z.string(),
      customerMessage: z.string(),
      slaDue: z.string(),
      category: categories.optional(),
    })
  )
  .states(
    H.state('new', 'pending'),
    H.state('sent', 'waiting'),
    H.state('closed', 'terminal', 'success'),
    H.state('escalated', 'terminal', 'neutral'),
    H.state('unanswered', 'terminal', 'failure')
  );

const escalation = H.kind('escalation')
  .data(z.object({ conversation: z.string(), reason: z.string() }))
  .states(H.state('escalation-open', 'pending'), H.state('handled', 'terminal', 'success'), H.state('escalation-stuck', 'terminal', 'failure'));

const audit = H.kind('audit')
  .data(z.object({ category: categories, rate: z.number().nullable() }))
  .states(
    H.state('audit-open', 'pending'),
    H.state('audit-closed', 'terminal', 'success'),
    H.state('withdrawn', 'terminal', 'neutral'),
    H.state('audit-stuck', 'terminal', 'failure')
  );

const classifierRole = H.role('classifier')
  .input(z.object({ subject: z.string(), message: z.string() }))
  .output(z.object({ category: categories }))
  .prompt(input => `Classify this support conversation.\nSubject: ${input.subject}\n${input.message}`);
const drafterRole = H.role('drafter')
  .input(z.object({ message: z.string(), category: categories }))
  .output(z.object({ reply: z.string() }))
  .prompt(input => `Draft a reply for a ${input.category} conversation:\n${input.message}`);

const classifier = H.seat('classifier', classifierRole).model(haiku);
const drafter = H.seat('drafter', drafterRole).model(sonnet).recalls(replyTaste, drafterExperience);

const approvalDecision = z.object({ approve: z.boolean(), editedReply: z.string().optional(), note: z.string().optional() });
const approvalAbout = z.object({ category: categories });
type ApprovalDecision = z.infer<typeof approvalDecision>;
type ApprovalAbout = z.infer<typeof approvalAbout>;

const safeCategory = H.policy.rule(
  'safe-category',
  (about: ApprovalAbout, metrics: Metrics): ApprovalDecision | null => {
    const history = metrics.rate({
      among: { entry: 'halt', halt: approval, status: 'resolved', resolver: 'human', facets: [category.of(about.category)] },
      count: { ...approval.resolved({ approve: true }), resolver: 'human', facets: [category.of(about.category)] },
    });
    return history.samples >= 200 && history.hits === history.samples ? { approve: true, note: 'safe category' } : null;
  }
);

const approval: Halt<ApprovalDecision, ApprovalAbout> = H.halt('reply-approval', approvalDecision)
  .about(approvalAbout)
  .policy(safeCategory);

const sendReply = H.command('send-reply')
  .input(z.object({ conversation: z.string(), reply: z.string() }))
  .argv(input => ['./helpdesk/send.sh', input.conversation, input.reply])
  .on(localRunner)
  .recovery('park');

const answerConversation = H.flow('answer-conversation')
  .for(conversation)
  .does(async ctx => {
    const classified = await ctx.run(classifier, { subject: ctx.unit.data.subject, message: ctx.unit.data.customerMessage });
    if (!classified.ok) return ctx.fail(classified.error);
    await ctx.update({ category: classified.value.category });
    const draft = await ctx.run(drafter, { message: ctx.unit.data.customerMessage, category: classified.value.category });
    if (!draft.ok) return ctx.fail(draft.error);
    const decision = await ctx.halt(approval, draft.value.reply, { category: classified.value.category });
    if (decision.editedReply !== undefined) {
      await ctx.remember(replyTaste, {
        text: `Prefer phrasing like: ${decision.editedReply}`,
        because: decision.note ?? 'the reviewer edited the draft this way',
        when: { roles: [drafterRole] },
        status: 'candidate',
      });
    }
    if (!decision.approve) return ctx.fail('reply rejected by the reviewer');
    const sent = await ctx.run(sendReply, { conversation: ctx.unit.key, reply: decision.editedReply ?? draft.value.reply });
    return sent.ok ? 'sent' : ctx.fail(sent.error);
  });

const helpdeskHeaders = { authorization: H.env('HELPDESK_TOKEN') };
const conversationBody = z.object({
  id: z.string(),
  event: z.enum(['created', 'replied']),
  subject: z.string(),
  message: z.string(),
  slaDue: z.string(),
});

const helpdeskWebhook = http.webhook(conversation, {
  path: '/helpdesk/events',
  secret: H.env('HELPDESK_WEBHOOK_SECRET'),
  body: conversationBody,
  read: body =>
    body.event === 'created'
      ? { create: { subject: body.subject, customerMessage: body.message, slaDue: body.slaDue }, key: body.id }
      : { update: body.id, patch: { customerMessage: body.message }, state: 'new' },
});
const helpdeskPoll = http.poll(conversation, {
  url: 'https://helpdesk.example.com/api/conversations?status=open',
  every: { minutes: 10 },
  headers: helpdeskHeaders,
  body: z.object({ conversations: z.array(conversationBody) }),
  read: body =>
    body.conversations.map(
      (item): SupplyOf<typeof conversation> => ({
        create: { subject: item.subject, customerMessage: item.message, slaDue: item.slaDue },
        key: item.id,
      })
    ),
});
const helpdeskStore = http.store(conversation, {
  url: 'https://helpdesk.example.com/api/conversations',
  headers: helpdeskHeaders,
  stateField: 'harness_state',
});

const conversations = H.lane('conversations', conversation)
  .handler(answerConversation)
  .retries(2, { backoff: { first: { minutes: 2 }, factor: 2 }, exhausted: 'unanswered' })
  .suppliers(helpdeskWebhook, helpdeskPoll)
  .store(helpdeskStore)
  .wip(5)
  .maxUsdPerUnit(0.4)
  .facet(category, data => data.category);

const escalationHandled = H.halt('escalation-handled', z.object({ resolution: z.string() }));
const handleEscalation = H.flow('handle-escalation')
  .for(escalation)
  .does(async ctx => {
    await ctx.halt(escalationHandled, `Escalated conversation ${ctx.unit.data.conversation}: ${ctx.unit.data.reason}`);
    return 'handled';
  });
const escalations = H.lane('escalations', escalation)
  .handler(handleEscalation)
  .retries(0, { exhausted: 'escalation-stuck' });

interface AuditContext {
  readonly auditsThisMonth: number;
  readonly pausedHours: number;
  readonly pauseSamples: number;
}

const monthStart = (now: Date): Date => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));

const auditContext = H.policy.rule(
  'audit-context',
  (input: { readonly category: Category; readonly now: Date }, metrics: Metrics): AuditContext => {
    const since = monthStart(input.now);
    const auditsThisMonth = metrics.count({
      of: { entry: 'firing', trigger: approvalAudit, status: 'tripped', facets: [category.of(input.category)] },
      since,
    });
    const paused = metrics.sum({ of: 'durationMs', among: { entry: 'lane', lane: conversations, status: 'resumed' }, since });
    return { auditsThisMonth, pausedHours: (paused.value ?? 0) / 3600000, pauseSamples: paused.samples };
  }
);

const auditReview = H.halt('audit-review', z.object({ findings: z.string() }));
const runAudit = H.flow('run-audit')
  .for(audit)
  .does(async ctx => {
    const context = await ctx.decide(auditContext, { category: ctx.unit.data.category, now: ctx.now() });
    await ctx.halt(
      auditReview,
      `Approval rate for ${ctx.unit.data.category} fell to ${ctx.unit.data.rate ?? 'unknown'}. ` +
        `${context.auditsThisMonth} audits opened this month; lane paused ${context.pausedHours.toFixed(1)} hours over ${context.pauseSamples} pauses.`
    );
    return 'audit-closed';
  });
const audits = H.lane('audits', audit)
  .handler(runAudit)
  .retries(0, { exhausted: 'audit-stuck' })
  .facet(category, data => data.category);

const formatRate = (rate: Rate): string => (rate.value === null ? 'unknown' : `${rate.value.toFixed(2)} over ${rate.samples} samples`);

const approvalAudit: Trigger = H.trigger(
  'approval-audit',
  H.on.metric(
    metrics =>
      metrics.rateBy({
        among: { entry: 'halt', halt: approval, status: 'resolved' },
        count: approval.resolved({ approve: true }),
        by: category,
        days: 7,
      }),
    { trip: { below: 0.9 }, reset: { above: 0.95 }, minSamples: 50 }
  ),
  (event, act) =>
    event.state === 'tripped'
      ? [
          act.create(audits, { category: event.group, rate: event.rate.value }, `audit-${event.group}`),
          act.remember(drafterExperience, {
            text: `When drafting for ${event.group}, recall the stricter phrasing`,
            because: `approvals fell to ${formatRate(event.rate)}`,
            when: { roles: [drafterRole], facets: [category.of(event.group)] },
            status: 'candidate',
          }),
        ]
      : act.move(audits, `audit-${event.group}`, 'withdrawn')
);

const modelErrorBrake: Trigger = H.trigger(
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

const slaBreach = H.trigger(
  'sla-breach',
  H.on.deadline(conversation, data => new Date(data.slaDue), ['new', 'sent']),
  (event, act) => [
    act.create(escalations, { conversation: event.unit.key, reason: `SLA breached at ${event.at.toISOString()}` }),
    act.move('escalated'),
  ]
);

const timeToBreach = H.policy.scheduler('self-audits-then-time-to-breach', view => {
  const urgency = (unit: PendingView): number =>
    unit.is(conversation) ? new Date(unit.data.slaDue).getTime() - view.now.getTime() : Number.MIN_SAFE_INTEGER;
  return { start: [...view.pending].sort((a, b) => urgency(a) - urgency(b)) };
});

export const support = H.harness('support')
  .ledger(sqlite.ledger('.harness/ledger.sqlite'))
  .lanes(conversations, escalations, audits)
  .pools(pool)
  .triggers(approvalAudit, modelErrorBrake, slaBreach)
  .scheduler(timeToBreach)
  .clients(
    claude.supervisor('reviewer', {
      grants: [
        H.ops.readWork,
        H.ops.writeWork,
        H.ops.resolve(approval, escalationHandled, auditReview, H.halts.interrupted, H.halts.costCeiling),
        H.ops.readMemory,
        H.ops.writeMemory,
        H.ops.curateMemory,
        H.ops.readTelemetry,
      ],
    })
  )
  .observers(markdown.board('.harness/board.md'), markdown.telemetry('.harness/telemetry.md'));
