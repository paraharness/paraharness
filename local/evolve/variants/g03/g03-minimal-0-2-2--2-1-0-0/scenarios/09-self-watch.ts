import { H } from 'harness-dsl';
import { z } from 'zod';
import * as claudeCode from 'harness-dsl/claude-code';
import * as anthropic from 'harness-dsl/anthropic';
import * as sqlite from 'harness-dsl/sqlite';
import * as jsonl from 'harness-dsl/jsonl';
import * as shell from 'harness-dsl/shell';
import * as http from 'harness-dsl/http';
import * as markdown from 'harness-dsl/markdown';

const haiku = anthropic.model('claude-haiku-4-5');
const sonnet = anthropic.model('claude-sonnet-4-5');
const local = shell.local('support-local', { slots: 4 });

const categoryValues = z.enum(['billing', 'shipping', 'refund', 'technical']);
const category = H.facet('category', categoryValues);

const fresh = H.state('new', 'pending');
const classifying = H.state('classifying', 'pending');
const drafting = H.state('drafting', 'pending');
const awaitingApproval = H.state('awaiting-approval', 'pending');
const sent = H.state('sent', 'terminal', 'success');
const closedByCustomer = H.state('closed-by-customer', 'terminal', 'neutral');
const escalated = H.state('escalated', 'terminal', 'neutral');

const conversation = H.kind('Conversation')
  .data(z.object({ message: z.string(), slaDue: z.string(), category: categoryValues.optional() }))
  .states(fresh, classifying, drafting, awaitingApproval, sent, closedByCustomer, escalated);

const opened = H.state('open', 'pending');
const closed = H.state('closed', 'terminal', 'success');
const withdrawn = H.state('withdrawn', 'terminal', 'neutral');
const unresolved = H.state('unresolved', 'terminal', 'failure');

const audit = H.kind('Audit')
  .data(z.object({ category: categoryValues, approvalRate: z.number() }))
  .states(opened, closed, withdrawn, unresolved);

const escalation = H.kind('Escalation')
  .data(z.object({ conversation: z.string(), reason: z.string() }))
  .states(opened, closed, unresolved);

const taste = H.journal('support-taste', H.memory('taste', 'taste'), jsonl.memory('support/.harness/taste.jsonl'));
const drafterExperience = H.journal('drafter-experience', H.memory('experience', 'experience'), jsonl.memory('support/.harness/experience.jsonl'));

const classifierRole = H.role('classifier')
  .input(z.object({ message: z.string() }))
  .output(z.object({ category: categoryValues }))
  .prompt((input) => `Classify this customer message:\n${input.message}`);

const drafterRole = H.role('drafter')
  .input(z.object({ message: z.string(), category: categoryValues }))
  .output(z.object({ reply: z.string() }))
  .prompt((input) => `Draft a reply for a ${input.category} conversation:\n${input.message}`);

const classifier = H.seat('classifier', classifierRole).model(haiku);
const drafter = H.seat('drafter', drafterRole).model(sonnet).recalls(taste, drafterExperience);

const approval = H.halt('reply-approval', z.object({ approved: z.boolean(), editedReply: z.string().optional() }))
  .about(z.object({ category: categoryValues }))
  .policy('safe-category-auto-approve', (about, metrics, self) => {
    const history = metrics.rate({
      among: { ...self.resolved(), resolver: 'human', facets: [category.of(about.category)] },
      count: { ...self.resolved({ approved: true }), resolver: 'human', facets: [category.of(about.category)] },
    });
    return history.samples >= 200 && history.hits === history.samples ? { approved: true } : null;
  });

const sendReply = H.command('send-reply')
  .input(z.object({ conversation: z.string(), reply: z.string() }))
  .argv((input) => ['helpdesk', 'reply', input.conversation, input.reply])
  .on(local)
  .recovery('park');

const answerConversation = H.flow('answer-conversation')
  .for(conversation)
  .does(async (ctx) => {
    await ctx.move('classifying');
    const classified = await ctx.run(classifier, { message: ctx.unit.data.message });
    if (!classified.ok) return ctx.fail(classified.error);
    await ctx.update({ category: classified.value.category });
    await ctx.move('drafting');
    const drafted = await ctx.run(drafter, { message: ctx.unit.data.message, category: classified.value.category });
    if (!drafted.ok) return ctx.fail(drafted.error);
    await ctx.move('awaiting-approval');
    const verdict = await ctx.halt(approval, drafted.value.reply, { category: classified.value.category });
    if (!verdict.approved) return ctx.fail('reply rejected by reviewer');
    const delivered = await ctx.run(sendReply, { conversation: ctx.unit.key, reply: verdict.editedReply ?? drafted.value.reply });
    if (!delivered.ok) return ctx.fail(delivered.error);
    return 'sent';
  });

const helpdeskHeaders = { authorization: H.env('HELPDESK_TOKEN') };

const helpdeskWebhook = http.webhook(conversation, {
  path: '/helpdesk/events',
  secret: H.env('HELPDESK_WEBHOOK_SECRET'),
  body: z.object({ conversation: z.string(), message: z.string(), slaDue: z.string(), isNew: z.boolean(), closed: z.boolean() }),
  read: (body, supply) =>
    body.closed
      ? supply.update(body.conversation, { state: 'closed-by-customer' })
      : body.isNew
        ? supply.create({ message: body.message, slaDue: body.slaDue }, { key: body.conversation })
        : supply.update(body.conversation, { patch: { message: body.message }, state: 'classifying', cancels: ['waiting'] }),
});

const helpdeskPoll = http.poll(conversation, {
  url: 'https://helpdesk.example.com/api/conversations?status=open',
  every: { minutes: 10 },
  headers: helpdeskHeaders,
  body: z.object({ conversations: z.array(z.object({ id: z.string(), message: z.string(), slaDue: z.string() })) }),
  read: (body, supply) => body.conversations.map((item) => supply.create({ message: item.message, slaDue: item.slaDue }, { key: item.id })),
});

const conversations = H.lane('conversations', conversation)
  .handler(answerConversation)
  .retries(2, { exhausted: 'escalated' })
  .suppliers(helpdeskWebhook, helpdeskPoll)
  .store(http.store(conversation, { url: 'https://helpdesk.example.com/api/conversations', headers: helpdeskHeaders, stateField: 'harness_state' }))
  .maxUsdPerUnit(0.4)
  .facet(category, (data) => data.category);

const auditReview = H.halt('audit-review', z.object({ findings: z.string() })).about(
  z.object({ category: categoryValues, approvalRate: z.number() })
);

const runAudit = H.flow('run-audit')
  .for(audit)
  .does(async (ctx) => {
    await ctx.halt(auditReview, `Approval rate for ${ctx.unit.data.category} fell to ${ctx.unit.data.approvalRate}`, ctx.unit.data);
    return 'closed';
  });

const audits = H.lane('audits', audit)
  .handler(runAudit)
  .retries(0, { exhausted: 'unresolved' })
  .facet(category, (data) => data.category);

const escalationHandled = H.halt('escalation-handled', z.object({ resolution: z.string() })).about(
  z.object({ conversation: z.string(), reason: z.string() })
);

const handleEscalation = H.flow('handle-escalation')
  .for(escalation)
  .does(async (ctx) => {
    await ctx.halt(escalationHandled, `Conversation ${ctx.unit.data.conversation}: ${ctx.unit.data.reason}`, ctx.unit.data);
    return 'closed';
  });

const escalations = H.lane('escalations', escalation).handler(handleEscalation).retries(0, { exhausted: 'unresolved' });

const slaBreach = H.trigger(
  'sla-breach',
  H.on.deadline(conversation, (data) => new Date(data.slaDue), ['new', 'classifying', 'drafting', 'awaiting-approval']),
  (event, act) => [
    act.create(escalations, { conversation: event.unit.key, reason: 'SLA breached' }, `escalation-${event.unit.key}`),
    act.move('escalated'),
  ]
);

const approvalWatch = H.trigger(
  'approval-rate-watch',
  H.on.metric(
    (metrics) => metrics.rateBy({ days: 7, among: approval.resolved(), count: approval.resolved({ approved: true }), by: category }),
    { trip: { below: 0.9 }, reset: { above: 0.95 }, minSamples: 50 }
  ),
  (event, act) =>
    event.state === 'tripped'
      ? [
          act.create(audits, { category: event.group, approvalRate: event.rate.value ?? 0 }, `audit-${event.group}`),
          act.remember(drafterExperience, {
            text: `When drafting for ${event.group}, recall the stricter phrasing`,
            because: `approvals fell to ${event.rate.value ?? 0} over ${event.rate.samples} samples`,
            when: { roles: [drafterRole], facets: [category.of(event.group)] },
            status: 'candidate',
          }),
        ]
      : act.move(audits, `audit-${event.group}`, 'withdrawn')
);

const modelErrorWatch = H.trigger(
  'model-error-watch',
  H.on.metric(
    (metrics) =>
      metrics.rate({
        hours: 1,
        among: { entry: 'invocation', status: 'ended', lane: conversations, mode: 'model' },
        count: { entry: 'invocation', status: 'ended', lane: conversations, mode: 'model', ok: false },
      }),
    { trip: { above: 0.2 }, reset: { below: 0.05 }, minSamples: 20 }
  ),
  (event, act) => (event.state === 'tripped' ? act.pause(conversations) : act.resume(conversations))
);

export const auditsOpenedThisMonth = H.policy.rule('audits-opened-this-month', z.object({ category: categoryValues }), (input, metrics) =>
  metrics.count({
    period: 'thisMonth',
    of: { entry: 'transition', kind: audit, state: 'open', facets: [category.of(input.category)] },
  })
);

export const conversationsPausedThisMonth = H.policy.rule('conversations-paused-this-month', z.object({}), (_input, metrics) =>
  metrics.sum({ of: 'durationMs', among: { entry: 'lane', status: 'resumed', lane: conversations }, period: 'thisMonth' })
);

export const harness = H.harness('support')
  .ledger(sqlite.ledger('support/.harness/ledger.sqlite'))
  .pools(H.pool('support-accounts', [{ account: anthropic.account('support-api', { apiKey: H.env('ANTHROPIC_API_KEY') }), share: 1 }]).serves(haiku, sonnet))
  .lanes(conversations, audits, escalations)
  .triggers(slaBreach, approvalWatch, modelErrorWatch)
  .scheduler(
    H.policy.scheduler('time-to-breach', (view) => ({
      start: view.sorted((unit) => (unit.is(conversation) ? Date.parse(unit.data.slaDue) : 0)),
    }))
  )
  .clients(
    claudeCode.supervisor({
      grants: [
        H.ops.readWork,
        H.ops.writeWork,
        H.ops.readMemory,
        H.ops.writeMemory,
        H.ops.curateMemory,
        H.ops.readTelemetry,
        H.ops.resolve(approval, auditReview, escalationHandled, H.halts.costCeiling, H.halts.interrupted),
      ],
    })
  )
  .observers(markdown.board('support/BOARD.md'), markdown.telemetry('support/TELEMETRY.md'));
