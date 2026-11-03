import { z } from 'zod';
import { H, type MetricRef } from 'harness-dsl';
import { sqlite } from 'harness-dsl/sqlite';
import { jsonl } from 'harness-dsl/jsonl';
import { anthropic } from 'harness-dsl/anthropic';
import { claudeCode } from 'harness-dsl/claude-code';
import { zendesk, type ZendeskEvent } from 'harness-dsl/zendesk';
import { local } from 'harness-dsl/local';
import { markdown } from 'harness-dsl/markdown';

const conversationAttributes = z.object({
  ticketId: z.string(),
  subject: z.string(),
  message: z.string(),
  customerEmail: z.string(),
  slaDueAt: z.string(),
});
const escalationAttributes = z.object({ ticketId: z.string(), subject: z.string(), reason: z.string() });
const category = z.enum(['billing', 'refund', 'technical', 'account', 'other']);

const newConversation = H.state('New', 'pending');
const classifying = H.state('Classifying', 'active');
const drafting = H.state('Drafting', 'active');
const awaitingApproval = H.state('AwaitingApproval', 'waiting');
const sent = H.state('Sent', 'terminal', 'success');
const closedByCustomer = H.state('ClosedByCustomer', 'terminal', 'neutral');
const escalated = H.state('Escalated', 'terminal', 'failure');
const raised = H.state('Raised', 'pending');
const withHuman = H.state('WithHuman', 'waiting');
const handled = H.state('Handled', 'terminal', 'success');
const withdrawn = H.state('Withdrawn', 'terminal', 'neutral');

const Conversation = H.kind('Conversation')
  .attributes(conversationAttributes)
  .states(newConversation, classifying, drafting, awaitingApproval, sent, closedByCustomer, escalated)
  .key(attrs => attrs.ticketId);
const Escalation = H.kind('Escalation')
  .attributes(escalationAttributes)
  .states(raised, withHuman, handled, withdrawn)
  .key(attrs => attrs.ticketId);

const customerReplied = H.signal('customerReplied').payload(z.object({ message: z.string() }));
const customerClosed = H.signal('customerClosed');
const slaBreached = H.signal('slaBreached');

const apiAccount = anthropic.account('support-api', { apiKey: H.env('ANTHROPIC_API_KEY') });
const haiku = anthropic.model('haiku', { id: 'claude-haiku-4-5' });
const sonnet = anthropic.model('sonnet', { id: 'claude-sonnet-4-5' });
const supportPool = H.pool('support-pool').accounts(apiAccount);

const classifierRole = H.role('classifier')
  .intents('read')
  .instructions('Classify the customer conversation into exactly one category.');
const drafterRole = H.role('drafter')
  .intents('read')
  .instructions('Draft the reply the support team would send. Follow tone and policy memory.');

const classifier = H.agent('classifier-agent')
  .role(classifierRole)
  .model(haiku)
  .output(z.object({ category }));
const drafter = H.agent('drafter-agent')
  .role(drafterRole)
  .model(sonnet)
  .output(z.object({ reply: z.string() }));

const supportTaste = H.memory('support-taste', 'taste');
const supportExperience = H.memory('support-experience', 'experience');
const supportRecall = H.recall('support-recall', { by: 'specificity', limit: 10 });

const tasteJournal = H.journal('support-taste-journal', supportTaste)
  .store(jsonl.memoryStore({ path: '.harness/memory/support-taste.jsonl' }))
  .recall(supportRecall)
  .readBy(drafterRole);
const experienceJournal = H.journal('support-experience-journal', supportExperience)
  .store(jsonl.memoryStore({ path: '.harness/memory/support-experience.jsonl' }))
  .recall(supportRecall)
  .readBy(drafterRole);

const triageRunner = local.runner('triage-runner');
const helpdeskToken = H.env('ZENDESK_TOKEN');

const sendReply = H.command('send-reply')
  .input(z.object({ ticketId: z.string(), body: z.string() }))
  .argv(input => ['helpdesk-reply', '--ticket', input.ticketId, '--body', input.body])
  .env({ HELPDESK_TOKEN: helpdeskToken })
  .runner(triageRunner);

const approvalDecision = z.object({
  approved: z.boolean(),
  auto: z.boolean().optional(),
  editedReply: z.string().optional(),
  note: z.string().optional(),
});

const triageConversation = H.flow('triage-conversation')
  .input(conversationAttributes)
  .step('classify', classifier, ctx => ({
    task: `Subject: ${ctx.unit.attributes.subject}\n\n${ctx.unit.attributes.message}`,
  }))
  .loop(
    'drafting',
    attempt =>
      attempt
        .step('draft', drafter, ctx => ({
          task: `Reply to ${ctx.unit.attributes.customerEmail} about "${ctx.unit.attributes.subject}" (${ctx.steps.classify.category}):\n\n${ctx.unit.attributes.message}`,
          skills: [ctx.steps.classify.category],
        }))
        .halt('approval', {
          ask: ctx => `Approve the reply to "${ctx.unit.attributes.subject}":\n\n${ctx.steps.draft.reply}`,
          decision: approvalDecision,
          skip: ctx => {
            const record = ctx.metrics.rate(approvalRate, { group: `category:${ctx.steps.classify.category}` });
            return record.samples >= 200 && record.hits === record.samples ? { approved: true, auto: true } : undefined;
          },
        }),
    { max: 3, until: ctx => ctx.steps.approval.approved },
  )
  .exit('unapproved', ctx => !ctx.steps.approval.approved)
  .step(
    'send',
    sendReply,
    ctx => ({ ticketId: ctx.unit.attributes.ticketId, body: ctx.steps.approval.editedReply ?? ctx.steps.draft.reply }),
    { onCrash: 'park' },
  )
  .exit('sent');

const slaHours: Readonly<Record<ZendeskEvent['priority'], number>> = { low: 24, normal: 8, high: 4, urgent: 1 };

function conversationFrom(event: ZendeskEvent): z.infer<typeof conversationAttributes> {
  return {
    ticketId: event.ticketId,
    subject: event.subject,
    message: event.message,
    customerEmail: event.customerEmail,
    slaDueAt: new Date(event.createdAt.getTime() + slaHours[event.priority] * 3600000).toISOString(),
  };
}

const helpdeskStore = zendesk.store({ subdomain: 'acme', token: helpdeskToken });

const conversationLane = H.lane('conversations', Conversation)
  .supply(zendesk.webhook({ port: H.slot.port(0), path: '/helpdesk', secret: H.env('ZENDESK_WEBHOOK_SECRET') }), (event, to) =>
    event.status === 'solved' || event.status === 'closed'
      ? to.signal(customerClosed, event.ticketId, {})
      : event.type === 'replied'
        ? to.signal(customerReplied, event.ticketId, { message: event.message })
        : event.type === 'created'
          ? to.create(conversationFrom(event))
          : to.skip(),
  )
  .supply(zendesk.poll({ subdomain: 'acme', token: helpdeskToken, everyMinutes: 10 }), (event, to) =>
    event.status === 'solved' || event.status === 'closed' ? to.skip() : to.create(conversationFrom(event)),
  )
  .store(helpdeskStore)
  .handler(triageConversation, {
    exits: { unapproved: escalated, sent },
    during: { classify: classifying, draft: drafting, approval: awaitingApproval },
    failure: escalated,
  })
  .on(customerReplied, {
    update: (attrs, payload) => ({ ...attrs, message: payload.message }),
    restart: 'classify',
  })
  .on(customerClosed, { enter: closedByCustomer })
  .on(slaBreached, { enter: escalated })
  .ceiling({ maxUsd: 0.4, onExceed: 'halt' });

const handleEscalation = H.flow('handle-escalation')
  .input(escalationAttributes)
  .halt('handle', {
    ask: ctx => `Conversation ${ctx.unit.attributes.ticketId} ("${ctx.unit.attributes.subject}") was escalated: ${ctx.unit.attributes.reason}. Resolve it.`,
    decision: z.object({ resolution: z.string() }),
  })
  .exit('handled');

const escalationLane = H.lane('escalations', Escalation)
  .handler(handleEscalation, {
    exits: { handled },
    during: { handle: withHuman },
    cancelled: withdrawn,
  });

const approvalRate: MetricRef = H.metric('approval-rate')
  .from(H.when.step(conversationLane, 'approval'))
  .samples(event => {
    const decision = event.output;
    const drafted = event.steps.classify;
    const model = event.models.draft;
    if (!decision || decision.auto || !drafted) return [];
    const byCategory = { group: `category:${drafted.category}`, hit: decision.approved };
    return model ? [byCategory, { group: `model:${model}`, hit: decision.approved }] : [byCategory];
  });

const slaBreach = H.trigger('sla-breach')
  .on(H.when.timer(conversationLane, {
    at: unit => new Date(unit.attributes.slaDueAt),
    if: unit => unit.position !== 'terminal',
  }))
  .signal(conversationLane, slaBreached, event => ({ key: event.unit.key, payload: {} }));

const escalationOpens = H.trigger('escalation-opens')
  .on(H.when.transition(conversationLane, { to: escalated }))
  .create(escalationLane, event => ({
    ticketId: event.unit.attributes.ticketId,
    subject: event.unit.attributes.subject,
    reason: event.from === 'AwaitingApproval' || event.from === 'Drafting' ? 'reply not approved in time' : 'SLA or handling failure',
  }));

const reviewerEditsBecomeTaste = H.trigger('reviewer-edits-become-taste')
  .on(H.when.step(conversationLane, 'approval'))
  .record(tasteJournal, event => {
    const note = event.output?.note;
    return note
      ? { text: `When drafting a support reply, ${note}`, when: { kinds: [Conversation], roles: [drafterRole] }, status: 'active' }
      : undefined;
  });

const triageScheduler = H.scheduler('triage-scheduler')
  .priority(escalationLane, conversationLane)
  .rank(conversationLane, unit => Date.parse(unit.attributes.slaDueAt));

const reviewer = claudeCode.supervisor('reviewer-supervisor', {
  grants: [
    H.ops.workRead,
    H.ops.workUpdate,
    H.ops.blockersResolve,
    H.ops.memoryRead,
    H.ops.memoryWrite,
    H.ops.memoryCurate,
    H.ops.telemetryRead,
  ],
});

export const supportTriage = H.harness('support-triage')
  .ledger(sqlite.ledger({ path: '.harness/support-ledger.db' }))
  .pools(supportPool)
  .lanes(conversationLane, escalationLane)
  .journals(tasteJournal, experienceJournal)
  .triggers(slaBreach, escalationOpens, reviewerEditsBecomeTaste)
  .metrics(approvalRate)
  .scheduler(triageScheduler)
  .clients(reviewer)
  .observers(markdown.board({ path: 'BOARD.md' }), markdown.telemetry({ path: 'TELEMETRY.md' }));
