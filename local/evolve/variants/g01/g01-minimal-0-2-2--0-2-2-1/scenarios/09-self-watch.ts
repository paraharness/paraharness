import { H } from 'harness-dsl';
import type { Metrics, PendingView, SupplyOf } from 'harness-dsl';
import { z } from 'zod';
import * as anthropic from 'harness-dsl/anthropic';
import * as claude from 'harness-dsl/claude-code';
import * as sqlite from 'harness-dsl/sqlite';
import * as jsonl from 'harness-dsl/jsonl';
import * as http from 'harness-dsl/http';
import * as markdown from 'harness-dsl/markdown';

const categorySchema = z.enum(['billing', 'refunds', 'shipping', 'account']);
type Category = z.infer<typeof categorySchema>;
const category = H.facet('category', categorySchema);

const helpdeskHeaders = { Authorization: H.env('HELPDESK_TOKEN') };

const conversation = H.kind('Conversation')
  .data(
    z.object({
      ticket: z.string(),
      customer: z.string(),
      message: z.string(),
      slaDue: z.string(),
      category: categorySchema.optional(),
    })
  )
  .states(
    H.state('new', 'pending'),
    H.state('classifying', 'pending'),
    H.state('sent', 'waiting'),
    H.state('closed', 'terminal', 'success'),
    H.state('escalated', 'terminal', 'failure')
  );

const escalation = H.kind('Escalation')
  .data(z.object({ ticket: z.string(), reason: z.string() }))
  .states(H.state('raised', 'pending'), H.state('handled', 'terminal', 'success'));

const audit = H.kind('Audit')
  .data(z.object({ category: categorySchema }))
  .states(H.state('open', 'pending'), H.state('concluded', 'terminal', 'success'), H.state('withdrawn', 'terminal', 'neutral'));

const cheap = anthropic.model('claude-haiku');
const strong = anthropic.model('claude-sonnet');
const api = anthropic.account('anthropic-api', { apiKey: H.env('ANTHROPIC_API_KEY') });

const tone = H.library('tone', H.memory('taste', 'taste'), jsonl.memory('./.harness/taste.jsonl'));
const lessons = H.library('lessons', H.memory('experience', 'experience'), jsonl.memory('./.harness/experience.jsonl'));

const classifierRole = H.role('classifier')
  .input(z.object({ message: z.string() }))
  .output(z.object({ category: categorySchema }))
  .prompt((i) => `Classify this customer message:\n${i.message}`);

const drafterRole = H.role('drafter')
  .input(z.object({ message: z.string(), category: categorySchema }))
  .output(z.object({ reply: z.string() }))
  .prompt((i) => `Draft a reply for a ${i.category} conversation:\n${i.message}`);

const classifier = H.seat('classifier', classifierRole).model(cheap);
const drafter = H.seat('drafter', drafterRole).model(strong).recalls(tone, lessons);

const approvalDecision = z.object({ approved: z.boolean(), reply: z.string() });
const approvalAbout = z.object({ category: categorySchema, reply: z.string() });
const approvalGate = H.halt('approval', approvalDecision).about(approvalAbout);

const approvalRate = (metrics: Metrics, value: Category) =>
  metrics.rate({
    among: { ...approvalGate.resolved(), resolver: 'human', facets: [category.of(value)] },
    count: { ...approvalGate.resolved({ approved: true }), resolver: 'human', facets: [category.of(value)] },
  });

const safeCategory = H.policy.rule(
  'safeCategory',
  (about: z.infer<typeof approvalAbout>, metrics): z.infer<typeof approvalDecision> | null => {
    const record = approvalRate(metrics, about.category);
    return record.samples >= 200 && record.hits === record.samples ? { approved: true, reply: about.reply } : null;
  }
);
const approval = approvalGate.policy(safeCategory);

const sendReply = H.command('sendReply')
  .input(z.object({ ticket: z.string(), reply: z.string() }))
  .argv((i) => ['curl', '-X', 'POST', `https://helpdesk.example.com/tickets/${i.ticket}/reply`, '-d', i.reply])
  .recovery('park');

const converse = H.flow('converse')
  .for(conversation)
  .does(async (ctx) => {
    const classified = await ctx.run(classifier, { message: ctx.unit.data.message });
    if (!classified.ok) return ctx.fail(classified.error);
    const value = classified.value.category;
    await ctx.facet(category, value);
    await ctx.update({ category: value });
    const draft = await ctx.run(drafter, { message: ctx.unit.data.message, category: value });
    if (!draft.ok) return ctx.fail(draft.error);
    const decision = await ctx.halt(approval, draft.value.reply, { category: value, reply: draft.value.reply });
    if (!decision.approved) return 'escalated';
    if (decision.reply !== draft.value.reply) {
      await ctx.remember(tone, {
        text: `Write replies like: ${decision.reply}`,
        because: 'the reviewer edited the draft to this',
        when: { roles: [drafterRole], facets: [category.of(value)] },
        status: 'candidate',
      });
    }
    const sent = await ctx.run(sendReply, { ticket: ctx.unit.data.ticket, reply: decision.reply });
    if (!sent.ok) return ctx.fail(sent.error);
    return 'sent';
  });

const helpdeskEvent = z.object({
  ticket: z.string(),
  customer: z.string(),
  message: z.string(),
  slaDue: z.string(),
  event: z.enum(['opened', 'replied', 'closed']),
});
const readHelpdesk = (b: z.infer<typeof helpdeskEvent>): SupplyOf<typeof conversation> =>
  b.event === 'opened'
    ? { create: { ticket: b.ticket, customer: b.customer, message: b.message, slaDue: b.slaDue }, key: b.ticket }
    : b.event === 'replied'
      ? { update: b.ticket, patch: { message: b.message }, state: 'classifying' }
      : { update: b.ticket, state: 'closed' };

const conversations = H.lane('conversations', conversation)
  .handler(converse)
  .suppliers(
    http.webhook(conversation, { path: '/helpdesk', secret: H.env('HELPDESK_SECRET'), body: helpdeskEvent, read: readHelpdesk }),
    http.poll(conversation, {
      url: 'https://helpdesk.example.com/api/tickets?open=true',
      every: { minutes: 10 },
      headers: helpdeskHeaders,
      body: z.object({ tickets: z.array(helpdeskEvent) }),
      read: (b) => b.tickets.map(readHelpdesk),
    })
  )
  .store(http.store(conversation, { url: 'https://helpdesk.example.com/api/tickets', headers: helpdeskHeaders, stateField: 'harness_state' }))
  .wip(8)
  .maxUsdPerUnit(0.4);

const escalationHandled = H.halt('escalationHandled', z.object({ note: z.string() })).about(z.object({ ticket: z.string(), reason: z.string() }));

const escalate = H.flow('escalate')
  .for(escalation)
  .does(async (ctx) => {
    await ctx.halt(escalationHandled, `Escalated ${ctx.unit.data.ticket}: ${ctx.unit.data.reason}`, ctx.unit.data);
    return 'handled';
  });

const escalations = H.lane('escalations', escalation).handler(escalate).store(sqlite.store(escalation, './.harness/escalations.db'));

const auditReview = H.halt('auditReview', z.object({ findings: z.string() })).about(z.object({ category: categorySchema }));

const runAudit = H.flow('runAudit')
  .for(audit)
  .does(async (ctx) => {
    await ctx.facet(category, ctx.unit.data.category);
    await ctx.halt(auditReview, `Approvals for ${ctx.unit.data.category} fell; review recent drafts.`, ctx.unit.data);
    return 'concluded';
  });

const audits = H.lane('audits', audit).handler(runAudit).store(sqlite.store(audit, './.harness/audits.db'));

const escalateOnBreach = H.trigger(
  'escalateOnBreach',
  H.on.deadline(conversation, (d) => new Date(d.slaDue), ['new', 'classifying']),
  (event, act) => [act.create(escalations, { ticket: event.unit.data.ticket, reason: 'SLA breached' }), act.move('escalated')]
);

const auditOnApprovalDrop = H.trigger(
  'auditOnApprovalDrop',
  H.on.metric(
    (metrics) =>
      metrics.rateBy({
        among: { ...approvalGate.resolved(), resolver: 'human' },
        count: { ...approvalGate.resolved({ approved: true }), resolver: 'human' },
        days: 7,
        by: category,
      }),
    { trip: { below: 0.9 }, reset: { above: 0.95 }, minSamples: 50 }
  ),
  (event, act) =>
    event.state === 'tripped'
      ? [
          act.create(audits, { category: event.group }, `audit-${event.group}`),
          act.remember(lessons, {
            text: `When drafting for ${event.group}, recall the stricter phrasing`,
            because: `approvals fell to ${event.rate.value ?? 'unknown'} over ${event.rate.samples} samples`,
            when: { roles: [drafterRole], facets: [category.of(event.group)] },
            status: 'candidate',
          }),
        ]
      : act.move(audits, `audit-${event.group}`, 'withdrawn')
);

const pauseOnModelErrors = H.trigger(
  'pauseOnModelErrors',
  H.on.metric(
    (metrics) =>
      metrics.rate({
        among: { entry: 'invocation', status: 'ended', mode: ['model', 'batch'] },
        count: { entry: 'invocation', status: 'ended', mode: ['model', 'batch'], ok: false },
        hours: 1,
      }),
    { trip: { above: 0.2 }, reset: { below: 0.05 }, minSamples: 20 }
  ),
  (event, act) => (event.state === 'tripped' ? act.pause(conversations) : act.resume(conversations))
);

const auditsOpened = (metrics: Metrics, value: Category, since: Date) =>
  metrics.count({ of: { entry: 'firing', trigger: auditOnApprovalDrop, status: 'tripped', facets: [category.of(value)] }, since });

const lanePausedMs = (metrics: Metrics, since: Date) =>
  metrics.sum({ of: 'durationMs', among: { entry: 'lane', status: 'resumed', lane: conversations }, since });

const supportOrder = H.policy.scheduler('timeToBreach', (view) => {
  const monthStart = new Date(view.now.getFullYear(), view.now.getMonth(), 1);
  const catchUp = (lanePausedMs(view.metrics, monthStart).value ?? 0) > 3_600_000;
  const group = (p: PendingView) => (p.is(escalation) ? 0 : p.is(conversation) ? (catchUp ? 1 : 2) : catchUp ? 2 : 1);
  const within = (p: PendingView) =>
    p.is(conversation)
      ? Date.parse(p.data.slaDue)
      : p.is(audit)
        ? -auditsOpened(view.metrics, p.data.category, monthStart)
        : -p.waitedMs;
  return { start: [...view.pending].sort((a, b) => group(a) - group(b) || within(a) - within(b)) };
});

export const support = H.harness('support')
  .ledger(sqlite.ledger('./.harness/ledger.db'))
  .lanes(conversations, escalations, audits)
  .pools(H.pool('accounts', [{ account: api, share: 1 }]))
  .triggers(escalateOnBreach, auditOnApprovalDrop, pauseOnModelErrors)
  .scheduler(supportOrder)
  .clients(
    claude.supervisor({
      grants: [
        H.ops.readWork,
        H.ops.writeWork,
        H.ops.resolve(approval, escalationHandled, auditReview, H.halts.costCeiling),
        H.ops.writeMemory,
        H.ops.curateMemory,
        H.ops.readTelemetry,
      ],
    })
  )
  .observers(markdown.board('./BOARD.md'), markdown.telemetry('./TELEMETRY.md'));
