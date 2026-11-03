import { H } from 'harness-dsl';
import { z } from 'zod';
import { sqlite } from 'harness-dsl/sqlite';
import { jsonl } from 'harness-dsl/jsonl';
import { claudeCode } from 'harness-dsl/claude-code';
import { anthropic } from 'harness-dsl/anthropic';
import { zendesk } from 'harness-dsl/zendesk';
import { local } from 'harness-dsl/local';
import { markdown } from 'harness-dsl/markdown';

const New = H.state('New', 'pending');
const Classifying = H.state('Classifying', 'active');
const Drafting = H.state('Drafting', 'active');
const AwaitingApproval = H.state('AwaitingApproval', 'waiting');
const Sent = H.terminal('Sent', 'success');
const ClosedByCustomer = H.terminal('ClosedByCustomer', 'neutral');
const Escalated = H.terminal('Escalated', 'failure');

const Open = H.state('Open', 'pending');
const WithHuman = H.state('WithHuman', 'waiting');
const Resolved = H.terminal('Resolved', 'success');
const Unresolved = H.terminal('Unresolved', 'failure');

const conversationSchema = z.object({
  ticketId: z.string(),
  subject: z.string(),
  message: z.string(),
  customerEmail: z.string(),
  slaDueAt: z.string(),
});

const escalationSchema = z.object({
  ticketId: z.string(),
  subject: z.string(),
  reason: z.string(),
});

const Conversation = H.kind('Conversation')
  .attributes(conversationSchema)
  .states(New, Classifying, Drafting, AwaitingApproval, Sent, ClosedByCustomer, Escalated)
  .key(a => a.ticketId)
  .initial(New);

const Escalation = H.kind('Escalation')
  .attributes(escalationSchema)
  .states(Open, WithHuman, Resolved, Unresolved)
  .key(a => a.ticketId)
  .initial(Open)
  .onAttemptFailed(Unresolved);

const customerReplied = H.signal('customerReplied').payload(z.object({ message: z.string() }));
const closedByCustomer = H.signal('closedByCustomer');
const slaBreached = H.signal('slaBreached');

const apiAccount = anthropic.account('helpdesk-api', { apiKey: H.env('ANTHROPIC_API_KEY') });
const pool = H.pool('helpdesk').accounts(apiAccount);

const haiku = anthropic.model('haiku', { id: 'claude-haiku-4-5' });
const sonnet = anthropic.model('sonnet', { id: 'claude-sonnet-4-5' });

const classifierRole = H.role('classifier')
  .intents('read')
  .instructions('Classify the customer conversation into one support category.');

const drafterRole = H.role('drafter')
  .intents('read', 'search')
  .instructions('Draft the next reply to the customer.');

const reviewerRole = H.role('reviewer')
  .intents('read', 'record')
  .instructions('Approve or edit outgoing replies.');

const classifier = H.agent('classifier')
  .role(classifierRole)
  .model(haiku)
  .pool(pool)
  .output(z.object({ category: z.string() }));

const drafter = H.agent('drafter')
  .role(drafterRole)
  .model(sonnet)
  .pool(pool);

const tasteKind = H.memory('replyTaste', 'taste');
const experienceKind = H.memory('supportExperience', 'experience');

const taste = H.journal('replyTaste', tasteKind)
  .store(jsonl.memoryStore({ path: '.harness/taste.jsonl' }))
  .recall({ by: 'specificity', limit: 10 })
  .readBy(drafterRole)
  .recordedBy(reviewerRole);

const experience = H.journal('supportExperience', experienceKind)
  .store(jsonl.memoryStore({ path: '.harness/experience.jsonl' }))
  .recall({ by: 'specificity', limit: 10 })
  .readBy(drafterRole)
  .recordedBy(reviewerRole);

const approvalByCategory = H.metric.rate('approvalByCategory');
const approvalByModel = H.metric.rate('approvalByModel');

const sendReply = H.command('sendReply')
  .input(z.object({ ticketId: z.string(), reply: z.string() }))
  .argv(i => ['helpdesk-reply', '--ticket', i.ticketId, '--body', i.reply])
  .runner(local.runner('local'));

const conversationFlow = H.flow('triageConversation')
  .input(conversationSchema)
  .step('classify', classifier, ctx => ({
    task: `Subject: ${ctx.unit.attributes.subject}\n\n${ctx.unit.attributes.message}`,
  }))
  .loop(
    'review',
    f => f
      .step('draft', drafter, ctx => ({
        task: `Reply to ${ctx.unit.attributes.customerEmail}:\n\n${ctx.unit.attributes.message}`,
        skills: [ctx.steps.classify.category],
      }))
      .halt('approval', {
        ask: ctx => `Approve this reply to "${ctx.unit.attributes.subject}"?\n\n${ctx.steps.draft}`,
        decision: z.object({ approved: z.boolean(), reply: z.string() }),
        skip: ctx => {
          const record = ctx.metrics.rate(approvalByCategory, { group: ctx.steps.classify.category });
          return record.samples >= 200 && record.hits === record.samples
            ? { approved: true, reply: ctx.steps.draft }
            : undefined;
        },
      }),
    { max: 3, until: ctx => ctx.steps.approval.approved },
  )
  .exit('escalate', ctx => !ctx.steps.approval.approved)
  .step(
    'send',
    sendReply,
    ctx => ({ ticketId: ctx.unit.attributes.ticketId, reply: ctx.steps.approval.reply }),
    { afterCrash: 'park' },
  )
  .exit('sent');

const escalationFlow = H.flow('handleEscalation')
  .input(escalationSchema)
  .halt('handle', {
    ask: ctx => `Escalated ticket ${ctx.unit.attributes.ticketId} (${ctx.unit.attributes.subject}): ${ctx.unit.attributes.reason}`,
    decision: z.object({ resolution: z.string() }),
  })
  .exit('resolved');

const slaHours = { low: 24, normal: 8, high: 4, urgent: 1 };

const conversations = H.lane('conversations', Conversation)
  .supply(
    [
      zendesk.webhook({ port: H.slot.port(0), path: '/helpdesk', secret: H.env('ZENDESK_WEBHOOK_SECRET') }),
      zendesk.poll({ subdomain: 'acme', token: H.env('ZENDESK_TOKEN'), everyMinutes: 10 }),
    ],
    (event, to) => {
      if (event.status === 'closed' || event.status === 'solved') {
        return to.signal(closedByCustomer, event.ticketId, {});
      }
      if (event.type === 'replied') {
        return to.signal(customerReplied, event.ticketId, { message: event.message });
      }
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
    },
  )
  .store(zendesk.store({ subdomain: 'acme', token: H.env('ZENDESK_TOKEN') }))
  .handler(conversationFlow, {
    exits: { escalate: Escalated, sent: Sent },
    during: {
      classify: Classifying,
      draft: Drafting,
      approval: AwaitingApproval,
    },
  })
  .retry({ maxAttempts: 3, initialDelayMs: 60000, exhausted: Escalated })
  .on(customerReplied, {
    update: (attrs, payload) => ({ ...attrs, message: payload.message }),
    restart: 'classify',
  })
  .on(closedByCustomer, { enter: ClosedByCustomer })
  .on(slaBreached, { enter: Escalated })
  .ceiling({ maxUsd: 0.4, onExceed: 'halt' });

const escalations = H.lane('escalations', Escalation)
  .handler(escalationFlow, {
    exits: { resolved: Resolved },
    during: { handle: WithHuman },
  });

const slaBreachEscalates = H.trigger('slaBreachEscalates')
  .on(H.when.timer(conversations, { at: unit => new Date(unit.attributes.slaDueAt) }))
  .create(escalations, e => ({
    ticketId: e.unit.attributes.ticketId,
    subject: e.unit.attributes.subject,
    reason: `SLA breached at ${e.unit.attributes.slaDueAt}`,
  }))
  .signal(slaBreached, conversations, e => ({ key: e.unit.key, payload: {} }));

const reviewerEditsBecomeTaste = H.trigger('reviewerEditsBecomeTaste')
  .on(H.when.step(conversations, 'approval', {
    if: e => e.output !== undefined && e.outputs.draft !== undefined && e.output.reply !== e.outputs.draft,
  }))
  .record(taste, e => e.output === undefined ? undefined : {
    text: `When replying about ${e.outputs.classify?.category ?? 'any topic'}, prefer wording like "${e.output.reply}" over "${e.outputs.draft ?? ''}", because the reviewer edited the draft to it.`,
    when: { roles: [drafterRole], skills: e.outputs.classify === undefined ? [] : [e.outputs.classify.category] },
    status: 'candidate',
  });

const approvalsByCategory = H.measure(
  approvalByCategory,
  H.when.step(conversations, 'approval'),
  e => e.output === undefined ? [] : [{ group: e.outputs.classify?.category ?? 'unclassified', hit: e.output.approved }],
);

const approvalsByModel = H.measure(
  approvalByModel,
  H.when.step(conversations, 'approval'),
  e => e.output === undefined ? [] : [{ group: e.models.draft ?? 'unknown', hit: e.output.approved }],
);

const scheduler = H.scheduler('triage')
  .priority(escalations, conversations)
  .rank(conversations, unit => Date.parse(unit.attributes.slaDueAt));

const supervisor = claudeCode.supervisor('reviewer', {
  grants: [
    H.ops.workRead,
    H.ops.workUpdate,
    H.ops.blockersResolve,
    H.ops.memoryRead,
    H.ops.memoryWrite,
    H.ops.telemetryRead,
  ],
});

export const supportTriage = H.harness('supportTriage')
  .ledger(sqlite.ledger({ path: '.harness/ledger.db' }))
  .lanes(conversations, escalations)
  .journals(taste, experience)
  .triggers(slaBreachEscalates, reviewerEditsBecomeTaste)
  .measurements(approvalsByCategory, approvalsByModel)
  .scheduler(scheduler)
  .clients(supervisor)
  .observers(
    markdown.board({ path: '.harness/board.md' }),
    markdown.telemetry({ path: '.harness/telemetry.md' }),
  );

void supportTriage.start();
