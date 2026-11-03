import { z } from 'zod';
import { H, type SupplyOf } from 'harness-dsl';
import * as anthropic from 'harness-dsl/anthropic';
import * as sqlite from 'harness-dsl/sqlite';
import * as jsonl from 'harness-dsl/jsonl';
import * as http from 'harness-dsl/http';
import * as shell from 'harness-dsl/shell';
import * as claude from 'harness-dsl/claude-code';
import * as markdown from 'harness-dsl/markdown';

const categories = z.enum(['billing', 'refund', 'technical', 'account']);
type Category = z.infer<typeof categories>;
const category = H.facet('category', categories);

const api = anthropic.account('support-api', { apiKey: H.env('ANTHROPIC_API_KEY') });
const cheap = anthropic.model('claude-haiku-4-5');
const strong = anthropic.model('claude-sonnet-4-5');
const pool = H.pool('support-accounts', [{ account: api, share: 1 }]);
const local = shell.local('local', { slots: 4 });

const taste = H.memory('taste', 'taste');
const experience = H.memory('experience', 'experience');
const toneTaste = H.journal('tone-taste', taste, jsonl.memory('./harness/taste.jsonl'));
const draftingExperience = H.journal('drafting-experience', experience, jsonl.memory('./harness/experience.jsonl'));

const fresh = H.state('new', 'pending');
const sent = H.state('sent', 'terminal', 'success');
const closedByCustomer = H.state('closed-by-customer', 'terminal', 'neutral');
const escalated = H.state('escalated', 'terminal', 'neutral');
const failedConversation = H.state('failed', 'terminal', 'failure');

const conversation = H.kind('conversation')
  .data(z.object({ message: z.string(), slaDue: z.string(), category: categories.optional() }))
  .states(fresh, sent, closedByCustomer, escalated, failedConversation);

const classify = H.role('classifier')
  .input(z.object({ message: z.string() }))
  .output(z.object({ category: categories }))
  .prompt(input => `Classify this support message:\n${input.message}`);

const draftRole = H.role('drafter')
  .input(z.object({ message: z.string(), category: categories }))
  .output(z.object({ reply: z.string() }))
  .prompt(input => `Draft a reply for a ${input.category} conversation:\n${input.message}`);

const classifier = H.seat('classifier', classify).model(cheap);
const drafter = H.seat('drafter', draftRole).model(strong).recalls(toneTaste, draftingExperience);

const approval = H.halt('reply-approval', z.object({ approved: z.boolean(), reply: z.string() }))
  .about(z.object({ category: categories, draft: z.string() }));

const sendReply = H.command('send-reply')
  .input(z.object({ conversation: z.string(), reply: z.string() }))
  .argv(input => ['./bin/helpdesk-send', input.conversation, input.reply])
  .on(local)
  .recovery('park');

const handleConversation = H.flow('handle-conversation').for(conversation).does(async ctx => {
  const classified = await ctx.run(classifier, { message: ctx.unit.data.message });
  if (!classified.ok) return ctx.fail(classified.error);
  await ctx.update({ category: classified.value.category });
  const draft = await ctx.run(drafter, { message: ctx.unit.data.message, category: classified.value.category });
  if (!draft.ok) return ctx.fail(draft.error);
  const decision = await ctx.halt(approval, draft.value.reply, { category: classified.value.category, draft: draft.value.reply });
  if (!decision.approved) return 'escalated';
  const delivered = await ctx.run(sendReply, { conversation: ctx.unit.key, reply: decision.reply });
  if (!delivered.ok) return ctx.fail(delivered.error);
  return 'sent';
});

const helpdeskHeaders = { authorization: H.env('HELPDESK_TOKEN') };

const helpdeskHook = http.webhook(conversation, {
  path: '/hooks/helpdesk',
  secret: H.env('HELPDESK_WEBHOOK_SECRET'),
  body: z.object({ id: z.string(), message: z.string(), slaDue: z.string(), reply: z.boolean() }),
  read: body => body.reply
    ? { update: body.id, patch: { message: body.message }, state: 'new' }
    : { create: { message: body.message, slaDue: body.slaDue }, key: body.id },
});

const helpdeskPoll = http.poll(conversation, {
  url: 'https://helpdesk.example.com/api/conversations?open=true',
  every: { minutes: 10 },
  headers: helpdeskHeaders,
  body: z.object({ conversations: z.array(z.object({ id: z.string(), message: z.string(), slaDue: z.string() })) }),
  read: body => body.conversations.map((item): SupplyOf<typeof conversation> => ({
    create: { message: item.message, slaDue: item.slaDue },
    key: item.id,
  })),
});

const conversations = H.lane('conversations', conversation)
  .handler(handleConversation)
  .retry({ times: 2, backoff: { first: { minutes: 1 }, factor: 2 }, exhausted: 'failed' })
  .suppliers(helpdeskHook, helpdeskPoll)
  .store(http.store(conversation, { url: 'https://helpdesk.example.com/api/conversations', headers: helpdeskHeaders, stateField: 'status' }))
  .maxUsdPerUnit(0.4)
  .facet(category, data => data.category);

const escalationOpen = H.state('open', 'pending');
const handled = H.state('handled', 'terminal', 'success');
const escalationFailed = H.state('failed', 'terminal', 'failure');

const escalation = H.kind('escalation')
  .data(z.object({ conversation: z.string(), category: categories.optional() }))
  .states(escalationOpen, handled, escalationFailed);

const escalationHandled = H.halt('escalation-handled', z.object({ resolution: z.string() }));

const handleEscalation = H.flow('handle-escalation').for(escalation).does(async ctx => {
  await ctx.halt(escalationHandled, `SLA breached on ${ctx.unit.data.conversation}`);
  return 'handled';
});

const escalations = H.lane('escalations', escalation)
  .handler(handleEscalation)
  .retry({ times: 0, exhausted: 'failed' })
  .store(sqlite.store(escalation, './harness/escalations.sqlite'))
  .facet(category, data => data.category);

const auditOpen = H.state('open', 'pending');
const concluded = H.state('concluded', 'terminal', 'success');
const auditCancelled = H.state('cancelled', 'terminal', 'neutral');
const auditFailed = H.state('failed', 'terminal', 'failure');

const audit = H.kind('audit')
  .data(z.object({ category: categories }))
  .states(auditOpen, concluded, auditCancelled, auditFailed);

const auditsThisMonth = H.policy.rule('audits-opened-this-month', (input: { category: Category; since: Date }, metrics) =>
  metrics.count({
    of: { entry: 'transition', kind: audit, status: 'created', facets: [category.of(input.category)] },
    since: input.since,
  }));

const pausedThisMonth = H.policy.rule('conversations-paused-this-month', (since: Date, metrics) =>
  metrics.sum({ of: 'durationMs', among: { entry: 'lane', lane: conversations, status: 'resumed' }, since }));

const auditFinding = H.halt('audit-finding', z.object({ conclusion: z.string() }));

const reviewAudit = H.flow('review-audit').for(audit).does(async ctx => {
  const now = ctx.now();
  const since = new Date(now.getFullYear(), now.getMonth(), 1);
  const opened = await ctx.decide(auditsThisMonth, { category: ctx.unit.data.category, since });
  const paused = await ctx.decide(pausedThisMonth, since);
  const pausedMinutes = Math.round((paused.value ?? 0) / 60000);
  await ctx.halt(auditFinding, `Approval audit for ${ctx.unit.data.category}: ${opened} audits this month, lane paused ${pausedMinutes} minutes (${paused.samples} pauses).`);
  return 'concluded';
});

const audits = H.lane('audits', audit)
  .handler(reviewAudit)
  .retry({ times: 0, exhausted: 'failed' })
  .store(sqlite.store(audit, './harness/audits.sqlite'))
  .facet(category, data => data.category);

const approvalDrop = H.trigger(
  'approval-rate-drop',
  H.on.metric(
    metrics => metrics.rateBy({
      days: 7,
      among: approval.resolved(),
      count: approval.resolved({ approved: true }),
      by: category,
    }),
    { trip: { below: 0.9 }, reset: { above: 0.95 }, minSamples: 50 },
  ),
  (event, act) => event.state === 'tripped'
    ? [
        act.create(audits, { category: event.group }, `audit-${event.group}`),
        act.remember(draftingExperience, {
          text: `When drafting for ${event.group}, recall the stricter phrasing`,
          because: `approvals fell to ${event.rate.value ?? 0} over ${event.rate.samples} samples`,
          when: { roles: [draftRole], facets: [category.of(event.group)] },
          status: 'candidate',
        }),
      ]
    : act.move(audits, `audit-${event.group}`, 'cancelled'),
);

const modelErrors = H.trigger(
  'model-error-rate',
  H.on.metric(
    metrics => metrics.rate({
      hours: 1,
      among: { entry: 'invocation', mode: 'model', status: 'ended' },
      count: { entry: 'invocation', mode: 'model', status: 'ended', ok: false },
    }),
    { trip: { above: 0.2 }, reset: { below: 0.05 }, minSamples: 20 },
  ),
  (event, act) => event.state === 'tripped' ? act.pause(conversations) : act.resume(conversations),
);

const slaBreach = H.trigger(
  'sla-breach',
  H.on.deadline(conversation, data => new Date(data.slaDue), ['new']),
  (event, act) => [
    act.create(escalations, { conversation: event.unit.key, category: event.unit.data.category }, `escalation-${event.unit.key}`),
    act.move('escalated'),
  ],
);

export const support = H.harness('support')
  .ledger(sqlite.ledger('./harness/support.sqlite'))
  .lanes(conversations, escalations, audits)
  .pools(pool)
  .triggers(approvalDrop, modelErrors, slaBreach)
  .clients(claude.supervisor({
    grants: [
      H.ops.readWork, H.ops.writeWork, H.ops.writeMemory, H.ops.curateMemory, H.ops.readTelemetry,
      H.ops.resolve(approval, escalationHandled, auditFinding, H.halts.costCeiling, H.halts.interrupted, H.halts.definitionChanged),
    ],
  }))
  .observers(markdown.board('./harness/BOARD.md'), markdown.telemetry('./harness/TELEMETRY.md'));
