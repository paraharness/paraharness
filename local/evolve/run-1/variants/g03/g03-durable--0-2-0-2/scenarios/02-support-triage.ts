import { z } from 'zod';
import { H, Router, Route, MetricRef } from 'harness-dsl';
import { sqlite } from 'harness-dsl/sqlite';
import { jsonl } from 'harness-dsl/jsonl';
import { anthropic } from 'harness-dsl/anthropic';
import { claudeCode } from 'harness-dsl/claude-code';
import { local } from 'harness-dsl/local';
import { markdown } from 'harness-dsl/markdown';
import { zendesk, ZendeskEvent } from 'harness-dsl/zendesk';

const conversationSchema = z.object({
  ticketId: z.string(),
  subject: z.string(),
  message: z.string(),
  customerEmail: z.string(),
  slaDue: z.date(),
});
type ConversationAttrs = z.infer<typeof conversationSchema>;

const New = H.state('New', 'pending');
const Classifying = H.state('Classifying', 'active');
const Drafting = H.state('Drafting', 'active');
const AwaitingApproval = H.state('AwaitingApproval', 'waiting');
const Sending = H.state('Sending', 'active');
const Sent = H.terminal('Sent', 'success');
const ClosedByCustomer = H.terminal('ClosedByCustomer', 'neutral');
const Escalated = H.terminal('Escalated', 'failure');
const Dismissed = H.terminal('Dismissed', 'neutral');

const Conversation = H.kind('Conversation')
  .attributes(conversationSchema)
  .states(New, Classifying, Drafting, AwaitingApproval, Sending, Sent, ClosedByCustomer, Escalated, Dismissed)
  .key(attrs => attrs.ticketId)
  .initial(New)
  .onAttemptFailed(Escalated)
  .onCancelled(Dismissed);

const escalationSchema = z.object({ ticketId: z.string(), reason: z.string() });

const Open = H.state('Open', 'pending');
const WithHuman = H.state('WithHuman', 'waiting');
const Resolved = H.terminal('Resolved', 'success');
const HandedOff = H.terminal('HandedOff', 'neutral');
const Unresolved = H.terminal('Unresolved', 'failure');
const Withdrawn = H.terminal('Withdrawn', 'neutral');

const Escalation = H.kind('Escalation')
  .attributes(escalationSchema)
  .states(Open, WithHuman, Resolved, HandedOff, Unresolved, Withdrawn)
  .key(attrs => attrs.ticketId)
  .initial(Open)
  .onAttemptFailed(Unresolved)
  .onCancelled(Withdrawn);

const customerReplied = H.signal('customerReplied').payload(z.object({ message: z.string() }));
const customerClosed = H.signal('customerClosed');
const slaBreached = H.signal('slaBreached');

const slaHours: Record<ZendeskEvent['priority'], number> = { urgent: 1, high: 4, normal: 12, low: 24 };

const routeConversation = (event: ZendeskEvent, to: Router<ConversationAttrs, string>): Route => {
  if (event.type === 'replied') {
    return to.signal(customerReplied, event.ticketId, { message: event.message });
  }
  if (event.status === 'closed' || event.status === 'solved') {
    return to.signal(customerClosed, event.ticketId, {});
  }
  if (event.type === 'created' || event.status === 'new') {
    return to.create({
      ticketId: event.ticketId,
      subject: event.subject,
      message: event.message,
      customerEmail: event.customerEmail,
      slaDue: new Date(event.createdAt.getTime() + slaHours[event.priority] * 3600000),
    });
  }
  return to.skip();
};

const apiAccount = anthropic.account('anthropic-api', { apiKey: H.env('ANTHROPIC_API_KEY') });
const supportPool = H.pool('support-pool').accounts(apiAccount);

const cheapModel = anthropic.model('haiku', { id: 'claude-haiku-4-5' });
const strongModel = anthropic.model('sonnet', { id: 'claude-sonnet-4-5' });

const classifierRole = H.role('classifier').intents('read').instructions('Classify the conversation into one support category.');
const drafterRole = H.role('drafter').intents('read', 'search').instructions('Draft the reply to the customer.');
const reviewerRole = H.role('reviewer').intents('record');

const category = H.skill('category');

const classifier = H.agent('classifier')
  .role(classifierRole)
  .model(cheapModel)
  .pool(supportPool)
  .output(z.object({ category: z.string() }));

const drafter = H.agent('drafter')
  .role(drafterRole)
  .model(strongModel)
  .pool(supportPool)
  .output(z.object({ reply: z.string() }));

const taste = H.corpus('support-taste', H.memory('taste', 'taste'))
  .store(jsonl.memoryStore({ path: './.harness/memory/taste.jsonl' }))
  .recall({ by: 'specificity', limit: 12 })
  .readBy(drafterRole)
  .recordedBy(reviewerRole);

const experience = H.corpus('support-experience', H.memory('experience', 'experience'))
  .store(jsonl.memoryStore({ path: './.harness/memory/experience.jsonl' }))
  .recall({ by: 'specificity', limit: 8 })
  .readBy(drafterRole);

const sendReply = H.command('send-reply')
  .input(z.object({ ticketId: z.string(), body: z.string() }))
  .argv(input => ['./scripts/send-reply.sh', input.ticketId, input.body])
  .runner(local.runner('local'));

const conversationFlow = H.flow('conversation')
  .input(conversationSchema)
  .step('classify', classifier, ctx => ({
    task: `Subject: ${ctx.unit.attributes.subject}\n\n${ctx.unit.attributes.message}`,
  }))
  .loop(
    'drafting',
    flow => flow
      .step('draft', drafter, ctx => ({
        task: `Draft a reply.\nSubject: ${ctx.unit.attributes.subject}\n\n${ctx.unit.attributes.message}`,
        skills: [category.of(ctx.steps.classify.category)],
      }))
      .halt('approval', {
        ask: ctx => `Approve this reply for ${ctx.unit.attributes.ticketId}:\n\n${ctx.steps.draft.reply}`,
        decision: z.object({
          approved: z.boolean(),
          editedReply: z.string().optional(),
          notes: z.string().optional(),
        }),
        skip: ctx => {
          const record = ctx.metrics.rate(approvalRate, { group: ctx.steps.classify.category });
          return record.samples >= 200 && record.hits === record.samples ? { approved: true } : undefined;
        },
      }),
    { max: 3, until: ctx => ctx.steps.approval.approved },
  )
  .exit('unapproved', ctx => !ctx.steps.approval.approved)
  .step('send', sendReply, ctx => ({
    ticketId: ctx.unit.attributes.ticketId,
    body: ctx.steps.approval.editedReply ?? ctx.steps.draft.reply,
  }))
  .exit('sent');

const conversations = H.lane('conversations', Conversation)
  .supply(
    zendesk.webhook({ port: H.slot.port(0), path: '/zendesk', secret: H.env('ZENDESK_WEBHOOK_SECRET') }),
    routeConversation,
  )
  .supply(
    zendesk.poll({ subdomain: 'acme', token: H.env('ZENDESK_TOKEN'), everyMinutes: 10 }),
    routeConversation,
  )
  .store(zendesk.store({ subdomain: 'acme', token: H.env('ZENDESK_TOKEN') }), {
    New: 'new',
    Classifying: 'open',
    Drafting: 'open',
    AwaitingApproval: 'open',
    Sending: 'open',
    Sent: 'solved',
    ClosedByCustomer: 'closed',
    Escalated: 'open',
    Dismissed: 'closed',
  })
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
  .ceiling({ maxUsd: 0.4, onExceed: 'halt' })
  .retry({ maxAttempts: 3, backoff: 'exponential', initialDelayMs: 60000 });

const approvalRate: MetricRef<'rate'> = H.metric('approval-rate', H.when.step(conversations, 'approval'))
  .samples(event => {
    const group = event.outputs.classify?.category ?? 'uncategorised';
    const model = event.models.draft ?? 'unknown-model';
    const hit = event.output?.approved === true;
    return [
      { group, hit },
      { group: `${group}@${model}`, hit },
    ];
  });

const escalationFlow = H.flow('escalation')
  .input(escalationSchema)
  .halt('resolve', {
    ask: ctx => `Escalated ticket ${ctx.unit.attributes.ticketId}: ${ctx.unit.attributes.reason}`,
    decision: z.object({ resolution: z.enum(['resolved', 'handedOff']) }),
  })
  .exit('resolved', ctx => ctx.steps.resolve.resolution === 'resolved')
  .exit('handedOff');

const escalations = H.lane('escalations', Escalation)
  .supply(H.operator)
  .handler(escalationFlow, {
    exits: { resolved: Resolved, handedOff: HandedOff },
    during: { resolve: WithHuman },
  })
  .retry({ maxAttempts: 1, backoff: 'fixed', initialDelayMs: 0 });

const slaBreach = H.trigger('sla-breach-escalates')
  .on(H.when.timer(conversations, { at: unit => unit.attributes.slaDue }))
  .create(escalations, event => ({
    ticketId: event.unit.attributes.ticketId,
    reason: `SLA breached at ${event.at.toISOString()}`,
  }))
  .signal(slaBreached, conversations, event => ({ key: event.unit.key, payload: {} }));

const reviewerEdits = H.trigger('reviewer-notes-become-taste')
  .on(H.when.step(conversations, 'approval', { if: event => event.output?.notes !== undefined }))
  .record(taste, event => {
    const notes = event.output?.notes;
    const group = event.outputs.classify?.category;
    if (notes === undefined) return undefined;
    return {
      text: notes,
      status: 'candidate',
      when: { roles: [drafterRole], skills: group === undefined ? [] : [category.of(group)] },
    };
  });

const scheduler = H.scheduler('support')
  .priority(escalations, conversations)
  .rank(conversations, unit => unit.attributes.slaDue.getTime());

const supervisor = claudeCode.supervisor('support-supervisor', {
  grants: [
    H.ops.workRead,
    H.ops.workUpdate,
    H.ops.workCancel,
    H.ops.blockersResolve,
    H.ops.memoryRead,
    H.ops.memoryWrite,
    H.ops.telemetryRead,
  ],
});

export const supportTriage = H.harness('support-triage')
  .ledger(sqlite.ledger({ path: './.harness/ledger.db' }))
  .lanes(conversations, escalations)
  .corpora(taste, experience)
  .triggers(slaBreach, reviewerEdits)
  .metrics(approvalRate)
  .scheduler(scheduler)
  .clients(supervisor)
  .observers(
    markdown.board({ path: './.harness/board.md' }),
    markdown.telemetry({ path: './.harness/telemetry.md' }),
  );
