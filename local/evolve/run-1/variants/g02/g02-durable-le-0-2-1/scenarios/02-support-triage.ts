import { z } from 'zod';
import { H, Metrics, MetricRef, Route, Router } from 'harness-dsl';
import { sqlite } from 'harness-dsl/sqlite';
import { jsonl } from 'harness-dsl/jsonl';
import { anthropic } from 'harness-dsl/anthropic';
import { claudeCode } from 'harness-dsl/claude-code';
import { local } from 'harness-dsl/local';
import { zendesk, ZendeskEvent } from 'harness-dsl/zendesk';
import { markdown } from 'harness-dsl/markdown';

const apiAccount = anthropic.account('apiAccount', { apiKey: H.env('ANTHROPIC_API_KEY') });
const haiku = anthropic.model('haiku', { id: 'claude-haiku-4-5' });
const sonnet = anthropic.model('sonnet', { id: 'claude-sonnet-4-5' });
const apiPool = H.pool('api').accounts(apiAccount).serves(haiku, sonnet);

const classifierRole = H.role('classifier')
  .intents('read')
  .instructions('Classify the customer conversation into one support category.');
const drafterRole = H.role('drafter')
  .intents('read')
  .instructions('Draft the reply to the customer in the house tone.');

const classifier = H.agent('classifier')
  .role(classifierRole)
  .model(haiku)
  .output(z.object({ category: z.string(), summary: z.string() }));

const drafter = H.agent('drafter')
  .role(drafterRole)
  .model(sonnet)
  .output(z.object({ reply: z.string() }));

const Taste = H.memory('Taste').trust('taste');
const Experience = H.memory('Experience').trust('experience');
const byScope = H.recall('byScope', { by: 'specificity', limit: 10 });

const taste = H.journal('taste', Taste)
  .store(jsonl.memoryStore({ path: '.harness/taste.jsonl' }))
  .recall(byScope)
  .readBy(drafterRole);

const experience = H.journal('experience', Experience)
  .store(jsonl.memoryStore({ path: '.harness/experience.jsonl' }))
  .recall(byScope)
  .readBy(drafterRole);

const New = H.state('New', 'pending');
const Classifying = H.state('Classifying', 'active');
const Drafting = H.state('Drafting', 'active');
const AwaitingApproval = H.state('AwaitingApproval', 'waiting');
const Sending = H.state('Sending', 'active');
const Sent = H.state('Sent', 'waiting');
const ClosedByCustomer = H.terminal('ClosedByCustomer', 'success');
const Escalated = H.terminal('Escalated', 'failure');

const conversationSchema = z.object({
  ticketId: z.string(),
  subject: z.string(),
  message: z.string(),
  customerEmail: z.string(),
  slaDueAt: z.string(),
});
type ConversationAttrs = z.infer<typeof conversationSchema>;

const Conversation = H.kind('Conversation')
  .attributes(conversationSchema)
  .states(New, Classifying, Drafting, AwaitingApproval, Sending, Sent, ClosedByCustomer, Escalated)
  .key(a => a.ticketId)
  .initial(New);

const approval = H.signal('approval').payload(
  z.object({ approved: z.boolean(), editedReply: z.string().optional(), notes: z.string().optional() }),
);
const customerReplied = H.signal('customerReplied').payload(z.object({ message: z.string() }));
const customerClosed = H.signal('customerClosed');
const slaBreached = H.signal('slaBreached');
const escalationResolved = H.signal('escalationResolved').payload(z.object({ note: z.string() }));

const approvalRate: MetricRef<'rate'> = H.metric('approvalRate')
  .from(H.when.step(conversations(), 'approval'))
  .samples(event => {
    const category = event.outputs.classify?.category;
    const model = event.models.draft;
    if (event.auto || event.output === undefined || category === undefined || model === undefined) return [];
    const hit = event.output.approved;
    return [
      { group: `category:${category}`, hit },
      { group: `model:${model}`, hit },
      { group: `category:${category}|model:${model}`, hit },
    ];
  });

function isSafeCategory(metrics: Metrics, category: string): boolean {
  const record = metrics.rate(approvalRate, { group: `category:${category}` });
  return record.hits >= 200 && record.hits === record.samples;
}

const postReply = H.command('postReply')
  .input(z.object({ ticketId: z.string(), reply: z.string() }))
  .argv(input => ['helpdesk-reply', '--ticket', input.ticketId, '--body', input.reply])
  .env({ HELPDESK_TOKEN: H.env('ZENDESK_TOKEN') })
  .runner(local.runner('local'));

const conversationFlow = H.flow('conversation')
  .input(z.object({ ticketId: z.string(), subject: z.string(), message: z.string() }))
  .step('classify', classifier, ctx => ({
    task: `Subject: ${ctx.unit.attributes.subject}\n\n${ctx.unit.attributes.message}`,
  }))
  .loop(
    'draftRounds',
    round =>
      round
        .step('draft', drafter, ctx => ({
          task: `Draft a reply. Category: ${ctx.steps.classify.category}. Summary: ${ctx.steps.classify.summary}\n\nCustomer wrote:\n${ctx.unit.attributes.message}`,
          skills: [ctx.steps.classify.category],
        }))
        .await('approval', approval, {
          ask: ctx => `Approve this reply to "${ctx.unit.attributes.subject}" (${ctx.steps.classify.category}):\n\n${ctx.steps.draft.reply}`,
          skip: ctx => (isSafeCategory(ctx.metrics, ctx.steps.classify.category) ? { approved: true } : undefined),
        }),
    { max: 3, until: ctx => ctx.steps.approval.approved },
  )
  .exit('unapproved', ctx => !ctx.steps.approval.approved)
  .step('send', postReply, ctx => ({
    ticketId: ctx.unit.attributes.ticketId,
    reply: ctx.steps.approval.editedReply ?? ctx.steps.draft.reply,
  }))
  .exit('sent');

const slaHours = { low: 72, normal: 24, high: 4, urgent: 1 };

function routeHelpdesk(event: ZendeskEvent, to: Router<ConversationAttrs, string>): Route {
  if (event.status === 'solved' || event.status === 'closed') return to.signal(customerClosed, event.ticketId, {});
  if (event.type === 'replied') return to.signal(customerReplied, event.ticketId, { message: event.message });
  if (event.type === 'created') {
    return to.create({
      ticketId: event.ticketId,
      subject: event.subject,
      message: event.message,
      customerEmail: event.customerEmail,
      slaDueAt: new Date(event.createdAt.getTime() + slaHours[event.priority] * 3600000).toISOString(),
    });
  }
  return to.skip();
}

const helpdeskToken = H.env('ZENDESK_TOKEN');

const conversationLane = H.lane('conversations', Conversation)
  .supply(zendesk.webhook({ port: H.slot.port(0), path: '/helpdesk', secret: H.env('ZENDESK_WEBHOOK_SECRET') }), routeHelpdesk)
  .supply(zendesk.poll({ subdomain: 'acme', token: helpdeskToken, everyMinutes: 10 }), routeHelpdesk)
  .store(zendesk.store({ subdomain: 'acme', token: helpdeskToken }))
  .handler(conversationFlow, {
    exits: { unapproved: Escalated, sent: Sent },
    during: { classify: Classifying, draft: Drafting, approval: AwaitingApproval, send: Sending },
  })
  .on(customerReplied, {
    update: (attrs, payload) => ({ ...attrs, message: payload.message }),
    restart: 'classify',
  })
  .on(customerClosed, { enter: ClosedByCustomer })
  .on(slaBreached, { enter: Escalated })
  .ceiling({ maxUsd: 0.4, onExceed: 'halt' });

function conversations(): typeof conversationLane {
  return conversationLane;
}

const Open = H.state('Open', 'pending');
const WithHuman = H.state('WithHuman', 'waiting');
const Resolved = H.terminal('Resolved', 'success');

const Escalation = H.kind('Escalation')
  .attributes(z.object({ conversationKey: z.string(), subject: z.string(), reason: z.string() }))
  .states(Open, WithHuman, Resolved)
  .key(a => a.conversationKey)
  .initial(Open);

const escalationFlow = H.flow('escalation')
  .input(z.object({ subject: z.string(), reason: z.string() }))
  .await('resolution', escalationResolved, {
    ask: ctx => `Escalated conversation "${ctx.unit.attributes.subject}": ${ctx.unit.attributes.reason}. Resolve it with the customer.`,
  })
  .exit('resolved');

const escalations = H.lane('escalations', Escalation).handler(escalationFlow, {
  exits: { resolved: Resolved },
  during: { resolution: WithHuman },
});

const slaBreach = H.trigger('slaBreach')
  .on(H.when.timer(conversationLane, { at: unit => new Date(unit.attributes.slaDueAt) }))
  .signal(slaBreached, conversationLane, event =>
    event.unit.state === 'Sent' ? undefined : { key: event.unit.key, payload: {} },
  );

const escalate = H.trigger('escalate')
  .on(H.when.transition(conversationLane, { to: Escalated }))
  .create(escalations, event => ({
    conversationKey: event.unit.key,
    subject: event.unit.attributes.subject,
    reason: event.cause.by === 'signal' ? 'SLA breached' : 'no reply approved after three drafts',
  }));

const captureReviewerTaste = H.trigger('captureReviewerTaste')
  .on(H.when.step(conversationLane, 'approval', { if: event => event.output?.notes !== undefined }))
  .record(taste, event => {
    const notes = event.output?.notes;
    const category = event.outputs.classify?.category;
    if (notes === undefined) return undefined;
    return {
      body: { text: `when drafting a reply, ${notes}, because the reviewer asked for it` },
      when: { roles: [drafterRole], skills: category === undefined ? [] : [category] },
      status: 'candidate',
    };
  });

const scheduler = H.scheduler('triageScheduler')
  .priority(escalations, conversationLane)
  .rank(conversationLane, unit => Date.parse(unit.attributes.slaDueAt));

const supervisor = claudeCode.supervisor('reviewer', {
  grants: [
    H.ops.workRead,
    H.ops.send(approval, { lanes: [conversationLane] }),
    H.ops.send(escalationResolved, { lanes: [escalations] }),
    H.ops.send(H.overBudget, { lanes: [conversationLane] }),
    H.ops.memoryRead,
    H.ops.memoryWrite,
    H.ops.memoryCurate,
    H.ops.telemetryRead,
  ],
});

export const supportTriage = H.harness('supportTriage')
  .ledger(sqlite.ledger({ path: '.harness/ledger.db' }))
  .pools(apiPool)
  .lanes(conversationLane, escalations)
  .journals(taste, experience)
  .triggers(slaBreach, escalate, captureReviewerTaste)
  .metrics(approvalRate)
  .scheduler(scheduler)
  .clients(supervisor)
  .observers(markdown.board({ path: 'BOARD.md' }), markdown.telemetry({ path: 'TELEMETRY.md' }));
