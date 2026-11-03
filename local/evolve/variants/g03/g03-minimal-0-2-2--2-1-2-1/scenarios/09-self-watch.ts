import { z } from 'zod';
import { H } from 'harness-dsl';
import type { Metrics, PendingView, Rate, SupplyOf } from 'harness-dsl';
import * as claude from 'harness-dsl/claude-code';
import * as anthropic from 'harness-dsl/anthropic';
import * as jsonl from 'harness-dsl/jsonl';
import * as shell from 'harness-dsl/shell';
import * as http from 'harness-dsl/http';
import * as sqlite from 'harness-dsl/sqlite';
import * as markdown from 'harness-dsl/markdown';

const categorySchema = z.enum(['billing', 'refund', 'shipping', 'account', 'other']);
type Category = z.infer<typeof categorySchema>;
const category = H.facet('category', categorySchema);

const helpdeskHeaders = { Authorization: H.env('HELPDESK_TOKEN') };

const conversation = H.kind('conversation')
  .data(
    z.object({
      customer: z.string(),
      message: z.string(),
      slaDueAt: z.string(),
      category: categorySchema.optional(),
    })
  )
  .states(
    H.state('new', 'pending'),
    H.state('classifying', 'pending'),
    H.state('drafting', 'pending'),
    H.state('sent', 'waiting'),
    H.state('closed-by-customer', 'terminal', 'success'),
    H.state('escalated', 'terminal', 'neutral')
  );

const escalation = H.kind('escalation')
  .data(z.object({ conversation: z.string(), reason: z.string() }))
  .states(H.state('open', 'pending'), H.state('handled', 'terminal', 'success'));

const audit = H.kind('audit')
  .data(z.object({ category: categorySchema }))
  .states(H.state('open', 'pending'), H.state('resolved', 'terminal', 'success'), H.state('withdrawn', 'terminal', 'neutral'));

const cheap = anthropic.model('claude-haiku-4-5');
const strong = anthropic.model('claude-sonnet-4-5');
const apiAccount = anthropic.account('anthropic-api', { apiKey: H.env('ANTHROPIC_API_KEY') });
const local = shell.local('local', { slots: 4 });

const experience = H.journal('support-experience', H.memory('experience', 'experience'), jsonl.memory('/srv/support/experience.jsonl'));
const reviewerTaste = H.journal('reviewer-taste', H.memory('taste', 'taste'), jsonl.memory('/srv/support/taste.jsonl'));

const classifierRole = H.role('classifier')
  .input(z.object({ message: z.string() }))
  .output(z.object({ category: categorySchema }))
  .prompt((input) => `Classify this customer message:\n${input.message}`);

const drafterRole = H.role('drafter')
  .input(z.object({ message: z.string(), category: categorySchema }))
  .output(z.object({ reply: z.string() }))
  .prompt((input) => `Draft a reply for a ${input.category} conversation:\n${input.message}`);

const classifier = H.seat('classifier', classifierRole).model(cheap);
const drafter = H.seat('drafter', drafterRole).model(strong).recalls(reviewerTaste, experience);

const approvalSchema = z.object({ approved: z.boolean(), edited: z.string().optional() });
type Approval = z.infer<typeof approvalSchema>;
const approvalAbout = z.object({ category: categorySchema });
type ApprovalAbout = z.infer<typeof approvalAbout>;

function humanApprovals(metrics: Metrics, of: Category, days: number): Rate {
  return metrics.rate({
    among: { ...replyApproval.resolved(), resolver: 'human', facets: [category.of(of)] },
    count: { ...replyApproval.resolved({ approved: true }), resolver: 'human', facets: [category.of(of)] },
    days,
  });
}

const safeCategory = H.policy.rule<ApprovalAbout, Approval | null>('safe-category-auto-approves', (about, metrics) => {
  const record = humanApprovals(metrics, about.category, 365);
  return record.samples >= 200 && record.hits === record.samples ? { approved: true } : null;
});

const replyApproval = H.halt('reply-approval', approvalSchema).about(approvalAbout).policy(safeCategory);
const escalationHandled = H.halt('escalation-handled', z.object({ note: z.string() }));
const auditFindings = H.halt('audit-findings', z.object({ findings: z.string() }));

const sendReply = H.command('send-reply')
  .input(z.object({ conversation: z.string(), text: z.string() }))
  .argv((input) => ['helpdesk-reply', '--conversation', input.conversation, '--text', input.text])
  .on(local)
  .recovery('park');

const conversationFlow = H.flow('triage').for(conversation).does(async (ctx) => {
  const message = ctx.unit.data.message;
  const classified = await ctx.run(classifier, { message });
  if (!classified.ok) return ctx.fail(classified.error);
  const kindOf = classified.value.category;
  await ctx.update({ category: kindOf });
  const drafted = await ctx.run(drafter, { message, category: kindOf });
  if (!drafted.ok) return ctx.fail(drafted.error);
  const approval = await ctx.halt(replyApproval, drafted.value.reply, { category: kindOf });
  if (!approval.approved) return 'drafting';
  const sent = await ctx.run(sendReply, { conversation: ctx.unit.key, text: approval.edited ?? drafted.value.reply });
  if (!sent.ok) return ctx.fail(sent.error);
  return 'sent';
});

const escalationFlow = H.flow('escalate-to-human').for(escalation).does(async (ctx) => {
  await ctx.halt(escalationHandled, `Conversation ${ctx.unit.data.conversation}: ${ctx.unit.data.reason}`);
  return 'handled';
});

const auditHistory = H.policy.rule(
  'audit-history',
  (input: { readonly category: Category; readonly since: Date }, metrics) => ({
    auditsOpened: metrics.count({
      of: { entry: 'transition', kind: audit, state: 'open', facets: [category.of(input.category)] },
      since: input.since,
    }),
    lanePaused: metrics.sum({ of: 'durationMs', among: { entry: 'lane', lane: conversationsLane, status: 'resumed' }, since: input.since }),
  })
);

const auditFlow = H.flow('category-audit').for(audit).does(async (ctx) => {
  const now = ctx.now();
  const history = await ctx.decide(auditHistory, {
    category: ctx.unit.data.category,
    since: new Date(now.getFullYear(), now.getMonth(), 1),
  });
  await ctx.halt(
    auditFindings,
    `Audit ${ctx.unit.data.category}: ${history.auditsOpened} audits this month; conversations lane paused ${Math.round(
      (history.lanePaused.value ?? 0) / 60_000
    )} minutes over ${history.lanePaused.samples} pauses.`
  );
  return 'resolved';
});

const helpdeskWebhook = http.webhook(conversation, {
  path: '/helpdesk/events',
  secret: H.env('HELPDESK_WEBHOOK_SECRET'),
  body: z.object({
    type: z.enum(['created', 'customer-reply']),
    conversation: z.string(),
    customer: z.string(),
    message: z.string(),
    slaDueAt: z.string(),
  }),
  read: (body) =>
    body.type === 'created'
      ? { create: { customer: body.customer, message: body.message, slaDueAt: body.slaDueAt }, key: body.conversation }
      : { update: body.conversation, patch: { message: body.message }, state: 'classifying' },
});

const helpdeskPoll = http.poll(conversation, {
  url: 'https://helpdesk.example.com/api/conversations?status=open',
  every: { minutes: 10 },
  headers: helpdeskHeaders,
  body: z.object({
    conversations: z.array(z.object({ id: z.string(), customer: z.string(), message: z.string(), slaDueAt: z.string() })),
  }),
  read: (body) =>
    body.conversations.map(
      (item): SupplyOf<typeof conversation> => ({
        create: { customer: item.customer, message: item.message, slaDueAt: item.slaDueAt },
        key: item.id,
      })
    ),
});

const conversationsLane = H.lane('conversations', conversation)
  .handler(conversationFlow, { retries: 2, backoff: { first: { minutes: 1 }, factor: 2 }, exhausted: 'escalated' })
  .suppliers(helpdeskWebhook, helpdeskPoll)
  .store(http.store(conversation, { url: 'https://helpdesk.example.com/api/conversations', headers: helpdeskHeaders, stateField: 'harness_state' }))
  .maxUsdPerUnit(0.4)
  .facet(category, (data) => data.category);

const escalationsLane = H.lane('escalations', escalation).handler(escalationFlow, { exhausted: H.halts.exhausted });

const auditsLane = H.lane('audits', audit)
  .handler(auditFlow, { exhausted: H.halts.exhausted })
  .store(sqlite.store(audit, '/srv/support/.harness/audits.sqlite'))
  .facet(category, (data) => data.category);

const slaBreach = H.trigger(
  'sla-breach-escalates',
  H.on.deadline(conversation, (data) => new Date(data.slaDueAt), ['new', 'classifying', 'drafting']),
  (event, act) => [
    act.create(escalationsLane, { conversation: event.unit.key, reason: 'SLA breached' }, `escalation-${event.unit.key}`),
    act.move('escalated'),
  ]
);

const approvalDrift = H.trigger(
  'approval-drift-opens-audit',
  H.on.metric(
    (metrics) =>
      metrics.rateBy({
        among: { ...replyApproval.resolved(), resolver: 'human' },
        count: { ...replyApproval.resolved({ approved: true }), resolver: 'human' },
        by: category,
        days: 7,
      }),
    { trip: { below: 0.9 }, reset: { above: 0.95 }, minSamples: 50 }
  ),
  (event, act) =>
    event.state === 'tripped'
      ? [
          act.create(auditsLane, { category: event.group }, `audit-${event.group}`),
          act.remember(experience, {
            text: `when drafting for ${event.group}, recall the stricter phrasing`,
            because: `approvals fell to ${(event.rate.value ?? 0).toFixed(2)} over ${event.rate.samples} samples`,
            when: { roles: [drafterRole], facets: [category.of(event.group)] },
            status: 'candidate',
          }),
        ]
      : act.move(auditsLane, `audit-${event.group}`, 'withdrawn')
);

const modelErrorsPauseLane = H.trigger(
  'model-errors-pause-conversations',
  H.on.metric(
    (metrics) =>
      metrics.rate({
        among: { entry: 'invocation', mode: 'model', status: 'ended' },
        count: { entry: 'invocation', mode: 'model', status: 'ended', ok: false },
        hours: 1,
      }),
    { trip: { above: 0.2 }, reset: { below: 0.05 }, minSamples: 20 }
  ),
  (event, act) => (event.state === 'tripped' ? act.pause(conversationsLane) : act.resume(conversationsLane))
);

const timeToBreach = H.policy.scheduler('human-work-then-time-to-breach', (view) => {
  const rank = (unit: PendingView): number => {
    if (unit.is(escalation)) return 0;
    if (unit.is(audit)) return 1;
    if (unit.is(conversation)) return 2 + new Date(unit.data.slaDueAt).getTime() - view.now.getTime();
    return Number.MAX_SAFE_INTEGER;
  };
  return { start: [...view.pending].sort((a, b) => rank(a) - rank(b)) };
});

export const supportHarness = H.harness('support-triage')
  .ledger(sqlite.ledger('/srv/support/.harness/ledger.sqlite'))
  .lanes(conversationsLane, escalationsLane, auditsLane)
  .pools(H.pool('api', [{ account: apiAccount, share: 1 }]))
  .triggers(slaBreach, approvalDrift, modelErrorsPauseLane)
  .scheduler(timeToBreach)
  .clients(
    claude.supervisor({
      grants: [
        H.ops.readWork,
        H.ops.writeWork,
        H.ops.readMemory,
        H.ops.writeMemory,
        H.ops.curateMemory,
        H.ops.readTelemetry,
        H.ops.resolve(replyApproval, escalationHandled, auditFindings, H.halts.costCeiling, H.halts.exhausted, H.halts.interrupted),
      ],
    })
  )
  .observers(markdown.board('/srv/support/.harness/board.md'), markdown.telemetry('/srv/support/.harness/telemetry.md'));
