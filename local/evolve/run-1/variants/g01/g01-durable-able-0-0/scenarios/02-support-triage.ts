import { z } from 'zod';
import { H } from 'harness-dsl';
import type { Metrics, Route, Router } from 'harness-dsl';
import { sqlite } from 'harness-dsl/sqlite';
import { jsonl } from 'harness-dsl/jsonl';
import { anthropic } from 'harness-dsl/anthropic';
import { claudeCode } from 'harness-dsl/claude-code';
import { local } from 'harness-dsl/local';
import { zendesk } from 'harness-dsl/zendesk';
import type { ZendeskEvent } from 'harness-dsl/zendesk';
import { markdown } from 'harness-dsl/markdown';

const New = H.state('New', 'pending');
const Classifying = H.state('Classifying', 'active');
const Drafting = H.state('Drafting', 'active');
const AwaitingApproval = H.state('AwaitingApproval', 'waiting');
const Sent = H.state('Sent', 'terminal', 'success');
const ClosedByCustomer = H.state('ClosedByCustomer', 'terminal', 'neutral');
const Escalated = H.state('Escalated', 'terminal', 'failure');

const Open = H.state('Open', 'pending');
const WithHuman = H.state('WithHuman', 'waiting');
const Resolved = H.state('Resolved', 'terminal', 'success');

const conversation = z.object({
  ticketId: z.string(),
  subject: z.string(),
  message: z.string(),
  customerEmail: z.string(),
  slaDueAt: z.string(),
});

type ConversationAttrs = z.infer<typeof conversation>;

const Conversation = H.kind('Conversation')
  .attributes(conversation)
  .states(New, Classifying, Drafting, AwaitingApproval, Sent, ClosedByCustomer, Escalated)
  .key(attrs => attrs.ticketId);

const Escalation = H.kind('Escalation')
  .attributes(z.object({ ticketId: z.string(), reason: z.string() }))
  .states(Open, WithHuman, Resolved)
  .key(attrs => attrs.ticketId);

const customerReplied = H.signal('customerReplied').payload(z.object({ message: z.string() }));
const customerClosed = H.signal('customerClosed');
const slaBreached = H.signal('slaBreached').payload(z.object({ breachedAt: z.string() }));

const slaHours: Readonly<Record<ZendeskEvent['priority'], number>> = {
  urgent: 1,
  high: 4,
  normal: 12,
  low: 24,
};

function routeHelpdesk(event: ZendeskEvent, to: Router<ConversationAttrs>): Route {
  switch (event.type) {
    case 'created':
      return to.create({
        ticketId: event.ticketId,
        subject: event.subject,
        message: event.message,
        customerEmail: event.customerEmail,
        slaDueAt: new Date(event.createdAt.getTime() + slaHours[event.priority] * 3_600_000).toISOString(),
      });
    case 'replied':
      return to.signal(customerReplied, event.ticketId, { message: event.message });
    case 'closed':
      return to.signal(customerClosed, event.ticketId, {});
    case 'updated':
      return to.skip();
  }
}

function isSafeCategory(metrics: Metrics, category: string): boolean {
  const record = metrics.rate(approvals, { group: category });
  return record.samples >= 200 && record.hits === record.samples;
}

const apiAccount = anthropic.account('anthropic-api', { apiKey: H.env('ANTHROPIC_API_KEY') });
const haiku = anthropic.model('haiku', { id: 'claude-haiku-4-5' });
const sonnet = anthropic.model('sonnet', { id: 'claude-sonnet-4-5' });
const apiPool = H.pool('api').accounts(apiAccount);

const classifierRole = H.role('classifier')
  .instructions('Assign exactly one support category: billing, refund, shipping, account, bug, other.');

const drafterRole = H.role('drafter')
  .instructions('Draft a reply the customer can act on. Follow the recalled tone and policies.');

const classifier = H.agent('classifier')
  .role(classifierRole)
  .model(haiku)
  .output(z.object({ category: z.string() }));

const drafter = H.agent('drafter')
  .role(drafterRole)
  .model(sonnet)
  .output(z.object({ reply: z.string() }));

const approval = z.object({
  approved: z.boolean(),
  reply: z.string().optional(),
  notes: z.string().optional(),
  auto: z.boolean().optional(),
});

const helpdeskToken = H.env('ZENDESK_TOKEN');

const sendReply = H.command('send-reply')
  .input(z.object({ ticketId: z.string(), reply: z.string() }))
  .argv(input => ['helpdesk-reply', '--ticket', input.ticketId, '--body', input.reply])
  .env({ HELPDESK_TOKEN: helpdeskToken })
  .runner(local.runner('local'));

const triage = H.flow('triage')
  .input(conversation)
  .step('classify', classifier, ctx => ({
    task: `Subject: ${ctx.unit.attributes.subject}\n\n${ctx.unit.attributes.message}`,
  }))
  .loop(
    'drafting',
    attempt => attempt
      .step('draft', drafter, ctx => ({
        task: `Reply to ${ctx.unit.attributes.customerEmail}.\n\n${ctx.unit.attributes.message}`,
        skills: [ctx.steps.classify.category],
      }))
      .halt('approve', {
        ask: ctx => `Approve this reply to ${ctx.unit.attributes.customerEmail}:\n\n${ctx.steps.draft.reply}`,
        decision: approval,
        skip: ctx => isSafeCategory(ctx.metrics, ctx.steps.classify.category)
          ? { approved: true, auto: true }
          : undefined,
      }),
    { max: 3, until: ctx => ctx.steps.approve.approved },
  )
  .exit('unapproved', ctx => !ctx.steps.approve.approved)
  .step(
    'send',
    sendReply,
    ctx => ({ ticketId: ctx.unit.attributes.ticketId, reply: ctx.steps.approve.reply ?? ctx.steps.draft.reply }),
    { restart: 'park' },
  )
  .exit('sent');

const helpdesk = zendesk.store({ subdomain: 'acme', token: helpdeskToken });

const conversations = H.lane('conversations', Conversation)
  .supply(zendesk.webhook({ port: H.slot.port(0), path: '/helpdesk', secret: H.env('ZENDESK_WEBHOOK_SECRET') }), routeHelpdesk)
  .supply(zendesk.poll({ subdomain: 'acme', token: helpdeskToken, everyMinutes: 10 }), routeHelpdesk)
  .store(helpdesk)
  .handler(triage, {
    exits: { sent: Sent, unapproved: Escalated },
    during: { classify: Classifying, draft: Drafting, approve: AwaitingApproval },
    failure: Escalated,
  })
  .on(customerReplied, { update: (attrs, payload) => ({ ...attrs, message: payload.message }), restart: 'classify' })
  .on(customerClosed, { enter: ClosedByCustomer })
  .on(slaBreached, { enter: Escalated })
  .ceiling({ maxUsd: 0.4, onExceed: 'halt' });

const escalationFlow = H.flow('escalation')
  .input(z.object({ ticketId: z.string(), reason: z.string() }))
  .halt('resolve', {
    ask: ctx => `Ticket ${ctx.unit.attributes.ticketId} escalated: ${ctx.unit.attributes.reason}. How was it resolved?`,
    decision: z.object({ resolution: z.string() }),
  })
  .exit('resolved');

const escalations = H.lane('escalations', Escalation)
  .store(helpdesk)
  .handler(escalationFlow, {
    exits: { resolved: Resolved },
    during: { resolve: WithHuman },
  });

const approvals = H.metric('approvals')
  .from(H.when.step(conversations, 'approve'))
  .samples(event => {
    if (event.output === undefined || event.output.auto === true) return [];
    const category = event.steps.classify?.category ?? 'unclassified';
    const model = event.models.draft ?? 'unknown';
    const hit = event.output.approved;
    return [
      { group: category, hit },
      { group: `model:${model}`, hit },
      { group: `${category}@${model}`, hit },
    ];
  });

const slaBreach = H.trigger('sla-breach')
  .on(H.when.timer(conversations, {
    at: unit => new Date(unit.attributes.slaDueAt),
    if: unit => unit.position !== 'terminal',
  }))
  .signal(slaBreached, event => ({ breachedAt: event.at.toISOString() }));

const escalate = H.trigger('escalate')
  .on(H.when.transition(conversations, { to: Escalated }))
  .create(escalations, event => ({
    ticketId: event.unit.attributes.ticketId,
    reason: event.from === undefined ? 'escalated' : `escalated from ${event.from}`,
  }));

const taste = H.memory('taste').trust('taste');
const experience = H.memory('experience').trust('experience');

const tastePlaybook = H.playbook('support-taste', taste)
  .store(jsonl.memoryStore({ path: '.harness/memory/taste.jsonl' }))
  .recall(H.recall('taste-by-specificity', { by: 'specificity', limit: 10 }))
  .readBy(drafterRole);

const experiencePlaybook = H.playbook('support-experience', experience)
  .store(jsonl.memoryStore({ path: '.harness/memory/experience.jsonl' }))
  .recall(H.recall('experience-by-specificity', { by: 'specificity', limit: 8 }))
  .readBy(drafterRole);

const tasteFromReviewerEdits = H.trigger('taste-from-reviewer-edits')
  .on(H.when.step(conversations, 'approve', { if: event => event.output?.notes !== undefined }))
  .record(tastePlaybook, event => {
    const notes = event.output?.notes;
    return notes === undefined
      ? undefined
      : { body: { text: `When drafting replies, ${notes}` }, when: { roles: [drafterRole] }, status: 'candidate' };
  });

const reviewer = claudeCode.supervisor('reviewer', {
  grants: [
    H.ops.workRead,
    H.ops.workUpdate,
    H.ops.workCancel,
    H.ops.blockersResolve,
    H.ops.memoryRead,
    H.ops.memoryWrite,
    H.ops.memoryCurate,
    H.ops.telemetryRead,
  ],
});

const scheduler = H.scheduler('support')
  .priority(escalations, conversations)
  .rank(conversations, unit => new Date(unit.attributes.slaDueAt).getTime());

export const supportTriage = H.harness('support-triage')
  .ledger(sqlite.ledger({ path: '.harness/ledger.sqlite' }))
  .pools(apiPool)
  .lanes(conversations, escalations)
  .playbooks(tastePlaybook, experiencePlaybook)
  .metrics(approvals)
  .triggers(slaBreach, escalate, tasteFromReviewerEdits)
  .scheduler(scheduler)
  .clients(reviewer)
  .observers(markdown.board({ path: 'BOARD.md' }), markdown.telemetry({ path: 'TELEMETRY.md' }));
