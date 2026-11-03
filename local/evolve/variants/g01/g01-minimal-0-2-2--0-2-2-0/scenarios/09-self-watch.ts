import { H, type Halt, type PendingView, type SupplyOf } from 'harness-dsl';
import { z } from 'zod';
import * as claudeCode from 'harness-dsl/claude-code';
import * as anthropic from 'harness-dsl/anthropic';
import * as sqlite from 'harness-dsl/sqlite';
import * as jsonl from 'harness-dsl/jsonl';
import * as shell from 'harness-dsl/shell';
import * as http from 'harness-dsl/http';
import * as markdown from 'harness-dsl/markdown';

const apiAccount = anthropic.account('api', { apiKey: H.env('ANTHROPIC_API_KEY') });
const haiku = anthropic.model('claude-haiku-4-5');
const sonnet = anthropic.model('claude-sonnet-4-5');
const apiPool = H.pool('api', [{ account: apiAccount, share: 1 }]);
const localRunner = shell.local('local', { slots: 4 });

const categories = z.enum(['billing', 'refunds', 'shipping', 'account', 'other']);
type Category = z.infer<typeof categories>;
const category = H.facet('category', categories);

const fresh = H.state('new', 'pending');
const sent = H.state('sent', 'terminal', 'success');
const closedByCustomer = H.state('closed-by-customer', 'terminal', 'neutral');
const escalated = H.state('escalated', 'terminal', 'failure');

const conversation = H.kind('Conversation')
  .data(z.object({ ticket: z.string(), customer: z.string(), message: z.string(), slaDue: z.string() }))
  .states(fresh, sent, closedByCustomer, escalated);

const open = H.state('open', 'pending');
const handled = H.state('handled', 'terminal', 'success');
const closed = H.state('closed', 'terminal', 'success');
const withdrawn = H.state('withdrawn', 'terminal', 'neutral');

const escalation = H.kind('Escalation').data(z.object({ conversation: z.string(), reason: z.string() })).states(open, handled);
const audit = H.kind('Audit').data(z.object({ category: categories })).states(open, closed, withdrawn);

const taste = H.memory('taste', 'taste');
const experience = H.memory('experience', 'experience');
const toneTaste = H.library('tone-taste', taste, jsonl.memory('.harness/taste.jsonl'));
const draftingExperience = H.library('drafting-experience', experience, jsonl.memory('.harness/experience.jsonl'));

const classifierRole = H.role('classifier')
  .input(z.object({ message: z.string() }))
  .output(z.object({ category: categories }))
  .prompt(input => `Classify this customer message:\n${input.message}`);

const drafterRole = H.role('drafter')
  .input(z.object({ message: z.string(), category: categories }))
  .output(z.object({ reply: z.string() }))
  .prompt(input => `Draft a reply to this ${input.category} conversation:\n${input.message}`);

const classifier = H.seat('classifier', classifierRole).model(haiku);
const drafter = H.seat('drafter', drafterRole).model(sonnet).recalls(toneTaste, draftingExperience);

const sendReply = H.command('send-reply')
  .input(z.object({ ticket: z.string(), reply: z.string() }))
  .argv(input => ['./helpdesk/send', input.ticket, input.reply])
  .on(localRunner)
  .recovery('park');

const approvalDecision = z.object({ approved: z.boolean(), edited: z.string().optional() });
const approvalAbout = z.object({ category: categories });

const approval: Halt<z.infer<typeof approvalDecision>, z.infer<typeof approvalAbout>> = H.halt('reply-approval', approvalDecision)
  .about(approvalAbout)
  .policy(
    H.policy.rule('safe-category', (about: z.infer<typeof approvalAbout>, metrics) => {
      const record = metrics.rate({
        days: 365,
        among: { entry: 'halt', halt: approval, status: 'resolved', resolver: 'human', facets: [category.of(about.category)] },
        count: { entry: 'halt', halt: approval, status: 'resolved', resolver: 'human', facets: [category.of(about.category)], decision: { approved: true } }
      });
      return record.samples >= 200 && record.hits === record.samples ? { approved: true } : null;
    })
  );

const escalationHandled = H.halt('escalation-handled', z.object({ note: z.string() }));
const auditReview = H.halt('audit-review', z.object({ findings: z.string() }));

const handleConversation = H.flow('handle-conversation')
  .for(conversation)
  .does(async ctx => {
    const classified = await ctx.run(classifier, { message: ctx.unit.data.message });
    if (!classified.ok) return ctx.fail(classified.error);
    const label = classified.value.category;
    ctx.tag(category.of(label));
    const drafted = await ctx.run(drafter, { message: ctx.unit.data.message, category: label }, { scope: { skills: [category.of(label)] } });
    if (!drafted.ok) return ctx.fail(drafted.error);
    const decision = await ctx.halt(approval, drafted.value.reply, { category: label });
    if (!decision.approved) return 'new';
    if (decision.edited) {
      await ctx.remember(toneTaste, {
        text: `Prefer phrasing like "${decision.edited}" over "${drafted.value.reply}"`,
        because: 'the reviewer edited the draft before approving it',
        when: { roles: [drafterRole], skills: [category.of(label)] },
        status: 'candidate'
      });
    }
    const delivered = await ctx.run(sendReply, { ticket: ctx.unit.data.ticket, reply: decision.edited ?? drafted.value.reply });
    if (!delivered.ok) return ctx.fail(delivered.error);
    return 'sent';
  });

const handleEscalation = H.flow('handle-escalation')
  .for(escalation)
  .does(async ctx => {
    await ctx.halt(escalationHandled, `Escalated conversation ${ctx.unit.data.conversation}: ${ctx.unit.data.reason}`);
    return 'handled';
  });

const handleAudit = H.flow('handle-audit')
  .for(audit)
  .does(async ctx => {
    await ctx.halt(auditReview, `Approval rate fell for ${ctx.unit.data.category}`);
    return 'closed';
  });

const ticket = z.object({ id: z.string(), customer: z.string(), message: z.string(), slaDue: z.string() });

const helpdeskWebhook = http.webhook(conversation, {
  path: '/helpdesk',
  secret: H.env('HELPDESK_WEBHOOK_SECRET'),
  body: z.object({ event: z.enum(['created', 'replied', 'closed']), ticket }),
  read: body =>
    body.event === 'created'
      ? { create: { ticket: body.ticket.id, customer: body.ticket.customer, message: body.ticket.message, slaDue: body.ticket.slaDue }, key: body.ticket.id }
      : body.event === 'replied'
        ? { update: body.ticket.id, patch: { message: body.ticket.message }, state: 'new' }
        : { update: body.ticket.id, state: 'closed-by-customer' }
});

const helpdeskPoll = http.poll(conversation, {
  url: 'https://helpdesk.example.com/api/tickets?status=open',
  every: { minutes: 10 },
  headers: { authorization: H.env('HELPDESK_TOKEN') },
  body: z.object({ tickets: z.array(ticket) }),
  read: body =>
    body.tickets.map((item): SupplyOf<typeof conversation> => ({
      create: { ticket: item.id, customer: item.customer, message: item.message, slaDue: item.slaDue },
      key: item.id
    }))
});

const helpdeskStore = http.store(conversation, {
  url: 'https://helpdesk.example.com/api/tickets',
  headers: { authorization: H.env('HELPDESK_TOKEN') },
  stateField: 'harness_state'
});

const conversationLane = H.lane('conversations', conversation)
  .handler(handleConversation)
  .suppliers(helpdeskWebhook, helpdeskPoll)
  .store(helpdeskStore)
  .maxUsdPerUnit(0.4);
const escalationLane = H.lane('escalations', escalation).handler(handleEscalation).store(sqlite.store(escalation, '.harness/escalations.db'));
const auditLane = H.lane('audits', audit).handler(handleAudit).store(sqlite.store(audit, '.harness/audits.db'));

const slaBreach = H.trigger(
  'sla-breach',
  H.on.deadline(conversation, data => new Date(data.slaDue), ['new']),
  (event, act) => [
    act.create(escalationLane, { conversation: event.unit.key, reason: `SLA breached at ${event.at.toISOString()}` }, `escalation-${event.unit.key}`),
    act.move('escalated')
  ]
);

const approvalDrop = H.trigger(
  'approval-drop',
  H.on.metric(
    category,
    metrics =>
      metrics.rateBy({
        days: 7,
        by: category,
        among: { entry: 'halt', halt: approval, status: 'resolved' },
        count: { entry: 'halt', halt: approval, status: 'resolved', decision: { approved: true } }
      }),
    { trip: { below: 0.9 }, reset: { above: 0.95 }, minSamples: 50 }
  ),
  (event, act) =>
    event.state === 'tripped'
      ? [
          act.create(auditLane, { category: event.group }, `audit-${event.group}`),
          act.remember(draftingExperience, {
            text: `When drafting for ${event.group}, recall the stricter phrasing`,
            because: `approvals fell to ${event.rate.value ?? 0} over ${event.rate.samples} samples`,
            when: { roles: [drafterRole], skills: [category.of(event.group)] },
            status: 'candidate'
          })
        ]
      : act.move(auditLane, `audit-${event.group}`, 'withdrawn')
);

const modelErrors = H.trigger(
  'model-error-brake',
  H.on.metric(
    metrics =>
      metrics.rate({
        hours: 1,
        among: { entry: 'invocation', mode: 'model', status: 'ended' },
        count: { entry: 'invocation', mode: 'model', status: 'ended', ok: false }
      }),
    { trip: { above: 0.2 }, reset: { below: 0.05 }, minSamples: 20 }
  ),
  (event, act) => (event.state === 'tripped' ? act.pause(conversationLane) : act.resume(conversationLane))
);

export const auditsOpened = H.policy.rule('audits-opened-per-category', (query: { category: Category; since: Date }, metrics) =>
  metrics.count({ of: { entry: 'firing', trigger: approvalDrop, status: 'tripped', facets: [category.of(query.category)] }, since: query.since })
);

export const pausedTotal = H.policy.rule('conversations-paused-total', (query: { since: Date }, metrics) =>
  metrics.sum({ of: 'durationMs', among: { entry: 'lane', lane: conversationLane, status: 'resumed' }, since: query.since })
);

const msToBreach = (unit: PendingView) => (unit.is(conversation) ? Date.parse(unit.data.slaDue) : Number.NEGATIVE_INFINITY);
const timeToBreach = H.policy.scheduler('time-to-breach', view => ({
  start: [...view.pending].sort((a, b) => msToBreach(a) - msToBreach(b))
}));

export const harness = H.harness('support-triage')
  .ledger(sqlite.ledger('.harness/ledger.db'))
  .lanes(conversationLane, escalationLane, auditLane)
  .pools(apiPool)
  .triggers(slaBreach, approvalDrop, modelErrors)
  .scheduler(timeToBreach)
  .clients(
    claudeCode.supervisor({
      grants: [
        H.ops.readWork,
        H.ops.writeWork,
        H.ops.resolve(approval, escalationHandled, auditReview),
        H.ops.readMemory,
        H.ops.writeMemory,
        H.ops.curateMemory,
        H.ops.readTelemetry
      ]
    })
  )
  .observers(markdown.board('BOARD.md'), markdown.telemetry('TELEMETRY.md'));
