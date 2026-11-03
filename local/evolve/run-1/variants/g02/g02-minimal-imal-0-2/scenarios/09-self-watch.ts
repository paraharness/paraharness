import { z } from 'zod';
import { H } from 'harness-dsl';
import type { DataOf, MetricRead, Metrics, PendingView, Rate, StateOf, Supply } from 'harness-dsl';
import * as anthropic from 'harness-dsl/anthropic';
import * as claudeCode from 'harness-dsl/claude-code';
import * as http from 'harness-dsl/http';
import * as jsonl from 'harness-dsl/jsonl';
import * as shell from 'harness-dsl/shell';
import * as sqlite from 'harness-dsl/sqlite';
import * as markdown from 'harness-dsl/markdown';

const Category = z.enum(['billing', 'refund', 'shipping', 'account', 'other']);
const categoryResource = H.resource('category');

const fresh = H.state.pending('new');
const classifying = H.state.active('classifying');
const drafting = H.state.active('drafting');
const awaitingApproval = H.state.active('awaiting-approval');
const sent = H.state.waiting('sent');
const closedByCustomer = H.state.terminal('closed-by-customer', 'success');
const escalated = H.state.terminal('escalated', 'failure');

const Conversation = H.kind('conversation')
  .data(z.object({
    ticket: z.string(),
    customer: z.string(),
    subject: z.string(),
    latest: z.string(),
    slaDue: z.coerce.date(),
    category: Category.optional(),
  }))
  .states([fresh, classifying, drafting, awaitingApproval, sent, closedByCustomer, escalated], 'new');

const escalationQueued = H.state.pending('queued');
const handling = H.state.active('handling');
const handled = H.state.terminal('handled', 'success');

const Escalation = H.kind('escalation')
  .data(z.object({ conversation: z.string(), subject: z.string() }))
  .states([escalationQueued, handling, handled], 'queued');

const auditOpen = H.state.pending('open');
const auditReviewing = H.state.active('reviewing');
const auditResolved = H.state.terminal('resolved', 'success');
const auditRecovered = H.state.terminal('recovered', 'neutral');

const Audit = H.kind('audit')
  .data(z.object({
    category: z.string(),
    rate: z.number().nullable(),
    samples: z.number(),
    openedAt: z.coerce.date(),
  }))
  .states([auditOpen, auditReviewing, auditResolved, auditRecovered], 'open');

const Taste = H.memory('taste', 'owner');
const Experience = H.memory('experience', 'fallible');

const specificThenProven = H.policy.recall('specific-then-proven', view =>
  view.items
    .filter(item => item.status === 'accepted')
    .sort((x, y) => y.specificity - x.specificity || (y.trackRecord.value ?? 0) - (x.trackRecord.value ?? 0))
    .slice(0, 12));

const replyTaste = H.library('reply-taste', Taste, jsonl.memory('memory/taste.jsonl')).recall(specificThenProven);
const draftingExperience = H.library('drafting-experience', Experience, jsonl.memory('memory/experience.jsonl')).recall(specificThenProven);

const classifierRole = H.role('classifier')
  .input(z.object({ subject: z.string(), latest: z.string() }))
  .output(z.object({ category: Category }))
  .prompt(c => `Classify this support message.\nSubject: ${c.subject}\n\n${c.latest}`);

const drafterRole = H.role('drafter')
  .input(z.object({ category: Category, subject: z.string(), latest: z.string(), reviewerNote: z.string().optional() }))
  .output(z.object({ reply: z.string() }))
  .prompt(c => `Draft a reply for a ${c.category} conversation.\nSubject: ${c.subject}\n\n${c.latest}\n\nReviewer note: ${c.reviewerNote ?? 'none'}`);

const classifier = H.agent('classifier', classifierRole).model(anthropic.model('claude-haiku-4-5'));
const drafter = H.agent('drafter', drafterRole)
  .model(anthropic.model('claude-sonnet-4-5'))
  .recalls(replyTaste, draftingExperience);

const local = shell.local('local', { slots: 4 });

const sendReply = H.command('send-reply')
  .input(z.object({ ticket: z.string(), reply: z.string() }))
  .output(z.object({ messageId: z.string() }))
  .argv(input => ['./helpdesk/send-reply', '--ticket', input.ticket, '--body', input.reply])
  .on(local)
  .restart('park');

function approvalRate(metrics: Metrics, category: string, window: { readonly days?: number }): Rate {
  return metrics.rate({
    among: { entry: 'halt', halt: 'approve-reply', status: 'resolved', tags: { category } },
    count: { decision: { approved: true } },
    ...window,
  });
}

const autoSendProvenSafe = H.policy.rule('auto-send-proven-safe', (category: string, metrics: Metrics): boolean => {
  const allTime = approvalRate(metrics, category, {});
  return allTime.samples >= 200 && allTime.hits === allTime.samples;
});

const triageConversation = H.flow('triage-conversation').for(Conversation).does(async ctx => {
  const conversation = ctx.unit.data;
  await ctx.move('classifying');
  const classified = await ctx.run(classifier, { subject: conversation.subject, latest: conversation.latest });
  if (!classified.ok) return ctx.fail(classified.error);
  const category = classified.value.category;
  ctx.tag({ category });
  await ctx.update({ category });

  const scope = { resources: [categoryResource.of(category)] };
  let reviewerNote: string | undefined;
  for (let round = 1; round <= 3; round++) {
    await ctx.move('drafting');
    const draft = await ctx.run(drafter, {
      category,
      subject: conversation.subject,
      latest: conversation.latest,
      reviewerNote,
    }, { scope });
    if (!draft.ok) return ctx.fail(draft.error);
    let reply = draft.value.reply;

    if (!(await ctx.decide(autoSendProvenSafe, category))) {
      await ctx.move('awaiting-approval');
      const review = await ctx.halt({
        name: 'approve-reply',
        show: reply,
        decision: z.object({ approved: z.boolean(), edited: z.string().optional(), note: z.string().optional() }),
      });
      if (!review.approved) {
        reviewerNote = review.note;
        continue;
      }
      reply = review.edited ?? reply;
    }

    const delivered = await ctx.run(sendReply, { ticket: conversation.ticket, reply });
    if (!delivered.ok) return ctx.fail(delivered.error);
    return ctx.rest('sent');
  }
  return 'escalated';
});

const HelpdeskEvent = z.object({
  ticket: z.string(),
  customer: z.string(),
  subject: z.string(),
  text: z.string(),
  slaDue: z.coerce.date(),
  event: z.enum(['created', 'customer-replied', 'closed']),
});
type HelpdeskEvent = z.infer<typeof HelpdeskEvent>;

function fromHelpdesk(event: HelpdeskEvent): Supply<DataOf<typeof Conversation>, StateOf<typeof Conversation>> {
  if (event.event === 'created') {
    return {
      create: { ticket: event.ticket, customer: event.customer, subject: event.subject, latest: event.text, slaDue: event.slaDue },
      key: event.ticket,
    };
  }
  if (event.event === 'customer-replied') {
    return { update: event.ticket, patch: { latest: event.text }, state: 'new' };
  }
  return { update: event.ticket, state: 'closed-by-customer' };
}

const helpdeskHeaders = { authorization: H.env('HELPDESK_TOKEN') };

const conversations = H.lane('conversations', Conversation)
  .handler(triageConversation)
  .suppliers(
    http.webhook(Conversation, {
      path: '/hooks/helpdesk',
      secret: H.env('HELPDESK_WEBHOOK_SECRET'),
      body: HelpdeskEvent,
      read: fromHelpdesk,
    }),
    http.poll(Conversation, {
      url: 'https://helpdesk.example.com/api/tickets?open=true',
      every: { minutes: 10 },
      headers: helpdeskHeaders,
      body: z.object({ tickets: z.array(HelpdeskEvent) }),
      read: body => body.tickets.map(fromHelpdesk),
    }),
  )
  .store(http.store(Conversation, {
    url: 'https://helpdesk.example.com/api/tickets',
    headers: helpdeskHeaders,
    stateField: 'harness_state',
  }))
  .maxUsdPerUnit(0.4);

const handleEscalation = H.flow('handle-escalation').for(Escalation).does(async ctx => {
  await ctx.move('handling');
  await ctx.halt({
    name: 'handle-escalation',
    show: `Escalated conversation ${ctx.unit.data.conversation}: ${ctx.unit.data.subject}`,
    decision: z.object({ resolution: z.string() }),
  });
  return 'handled';
});

const escalations = H.lane('escalations', Escalation).handler(handleEscalation);

const auditHistory = H.policy.rule('audit-history', (input: { readonly category: string; readonly since: Date }, metrics: Metrics) => {
  const opened = metrics.tally({
    among: { entry: 'transition', lane: 'audits', state: 'open' },
    by: { field: 'category' },
    since: input.since,
  });
  const paused = metrics.paused({ lane: 'conversations', since: input.since });
  return { auditsThisMonth: opened[input.category] ?? 0, pausedMinutes: Math.round((paused.value ?? 0) / 60_000) };
});

const auditCategory = H.flow('audit-category').for(Audit).does(async ctx => {
  const audit = ctx.unit.data;
  const now = ctx.now();
  const history = await ctx.decide(auditHistory, {
    category: audit.category,
    since: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)),
  });
  await ctx.move('reviewing');
  await ctx.halt({
    name: 'audit-findings',
    show: `Approvals for ${audit.category} fell to ${audit.rate ?? 'n/a'} over ${audit.samples} samples. Audits opened for it this month: ${history.auditsThisMonth}. Conversations lane paused ${history.pausedMinutes} minutes this month.`,
    decision: z.object({ findings: z.string() }),
  });
  return 'resolved';
});

const audits = H.lane('audits', Audit).handler(auditCategory);

function describe(reading: MetricRead): string {
  return `${reading.value === null ? 'n/a' : reading.value.toFixed(3)} (n=${reading.samples})`;
}

const slaBreach = H.trigger(
  'sla-breach',
  H.on.deadline(Conversation, data => data.slaDue, ['new', 'classifying', 'drafting', 'awaiting-approval']),
  (_event, act) => act.move('escalated'),
);

const escalatedOpensEscalation = H.trigger(
  'escalated-opens-escalation',
  H.on.enters(Conversation, 'escalated'),
  (event, act) => act.create(
    escalations,
    { conversation: event.unit.key, subject: event.unit.data.subject },
    { key: `escalation-${event.unit.key}` },
  ),
);

const approvalSlump = H.trigger(
  'approval-slump',
  H.on.metric({
    every: { minutes: 15 },
    groups: () => Category.options,
    read: (metrics, category) => approvalRate(metrics, category, { days: 7 }),
    enter: { below: 0.9 },
    exit: { above: 0.95 },
    minSamples: 50,
  }),
  (event, act) => event.crossing === 'entered'
    ? [
        act.create(
          audits,
          { category: event.group, rate: event.reading.value, samples: event.reading.samples, openedAt: event.at },
          { key: `audit-${event.group}-${event.at.toISOString()}`, oneOpenPer: event.group },
        ),
        act.remember(draftingExperience, {
          text: `When drafting for ${event.group}, recall the stricter phrasing`,
          because: `approvals fell to ${describe(event.reading)}`,
          when: { roles: [drafterRole], resources: [categoryResource.of(event.group)] },
          status: 'candidate',
        }),
      ]
    : act.close(audits, event.group, 'recovered'),
);

const modelErrorBrake = H.trigger(
  'model-error-brake',
  H.on.metric({
    every: { minutes: 1 },
    read: metrics => metrics.rate({
      among: { entry: 'invocation', status: 'ended', mode: 'live', lane: 'conversations' },
      count: { ok: false },
      hours: 1,
    }),
    enter: { above: 0.2 },
    exit: { below: 0.05 },
    minSamples: 20,
  }),
  (event, act) => event.crossing === 'entered'
    ? act.pause(conversations, `model error rate ${describe(event.reading)} over the last hour`)
    : act.resume(conversations, `model error rate recovered to ${describe(event.reading)}`),
);

const humansThenTimeToBreach = H.policy.scheduler('humans-then-time-to-breach', view => {
  const urgency = (unit: PendingView): number =>
    unit.is(Conversation) ? unit.data.slaDue.getTime() - view.now.getTime() : -Number.MAX_SAFE_INTEGER;
  return { start: [...view.pending].sort((x, y) => urgency(x) - urgency(y)) };
});

const apiPool = H.pool(
  'anthropic-api',
  [{ account: anthropic.account('anthropic-api', { apiKey: H.env('ANTHROPIC_API_KEY') }), share: 1 }],
  H.policy.account('first-eligible', choice => choice.accounts.find(view => view.eligible)?.account ?? null),
);

export const supportSelfWatch = H.harness('support-triage')
  .ledger(sqlite.ledger('.harness/support.db'))
  .lanes(conversations, escalations, audits)
  .pools(apiPool)
  .triggers(slaBreach, escalatedOpensEscalation, approvalSlump, modelErrorBrake)
  .scheduler(humansThenTimeToBreach)
  .clients(claudeCode.supervisor({
    grants: [
      H.ops.readWork,
      H.ops.writeWork,
      H.ops.resolveHalts,
      H.ops.readMemory,
      H.ops.writeMemory,
      H.ops.curateMemory,
      H.ops.readTelemetry,
    ],
  }))
  .observers(markdown.board('BOARD.md'), markdown.telemetry('TELEMETRY.md'));
