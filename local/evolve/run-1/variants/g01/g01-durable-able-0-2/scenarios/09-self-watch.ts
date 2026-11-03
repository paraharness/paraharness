import { z } from 'zod';
import { H, Metrics, Route, Router, Sample } from 'harness-dsl';
import { anthropic } from 'harness-dsl/anthropic';
import { claudeCode } from 'harness-dsl/claude-code';
import { jsonl } from 'harness-dsl/jsonl';
import { local } from 'harness-dsl/local';
import { markdown } from 'harness-dsl/markdown';
import { sqlite } from 'harness-dsl/sqlite';
import { zendesk, ZendeskEvent } from 'harness-dsl/zendesk';

const apiAccount = anthropic.account('supportApi', { apiKey: H.env('ANTHROPIC_API_KEY') });
const pool = H.pool('supportPool').accounts(apiAccount);
const haiku = anthropic.model('haiku', { id: 'claude-haiku-4-5' });
const sonnet = anthropic.model('sonnet', { id: 'claude-sonnet-4-5' });
const opus = anthropic.model('opus', { id: 'claude-opus-4-1' });

const ConversationAttributes = z.object({
  ticketId: z.string(),
  subject: z.string(),
  customerEmail: z.string(),
  lastMessage: z.string(),
  slaDeadline: z.string(),
});
type ConversationAttributes = z.infer<typeof ConversationAttributes>;

const New = H.state('New', 'pending');
const Classifying = H.state('Classifying', 'active');
const Drafting = H.state('Drafting', 'active');
const AwaitingApproval = H.state('AwaitingApproval', 'active');
const Sent = H.state('Sent', 'waiting');
const ClosedByCustomer = H.terminal('ClosedByCustomer', 'success');
const Escalated = H.terminal('Escalated', 'failure');

const Conversation = H.kind('Conversation')
  .attributes(ConversationAttributes)
  .states(New, Classifying, Drafting, AwaitingApproval, Sent, ClosedByCustomer, Escalated)
  .key(c => c.ticketId)
  .initial(New)
  .onAttemptFailed(New);

const customerReplied = H.signal('customerReplied').payload(z.object({ message: z.string() }));
const closedByCustomer = H.signal('closedByCustomer');
const slaBreached = H.signal('slaBreached');

const classifierRole = H.role('classifier').intents('read').instructions('Classify the conversation into one support category.');
const drafterRole = H.role('drafter').intents('read').instructions('Draft the reply in the house tone.');

const classifierModel = H.policy.model('classifierModel', [haiku, sonnet], ctx =>
  ctx.metrics.paused({ lane: conversations, window: { calendar: 'month' } }).totalMs > 3600000 ? sonnet : haiku,
);
const drafterModel = H.policy.model('drafterModel', [sonnet, opus], ctx =>
  ctx.metrics.total(auditsOpened, { window: { calendar: 'month' } }).total >= 3 ? opus : sonnet,
);

const classifier = H.agent('classifier')
  .role(classifierRole)
  .model(classifierModel)
  .output(z.object({ category: z.string(), urgent: z.boolean() }));
const drafter = H.agent('drafter').role(drafterRole).model(drafterModel).output(z.object({ reply: z.string() }));

const sendReply = H.command('sendReply')
  .input(z.object({ ticketId: z.string(), reply: z.string() }))
  .argv(input => ['send-reply', '--ticket', input.ticketId, '--body', input.reply])
  .runner(local.runner('supportRunner'));

const categoryResource = (category: string) => `category:${category}`;

function safeCategory(metrics: Metrics, category: string): boolean {
  const record = metrics.rate(approvalRate, { group: category });
  return record.samples >= 200 && record.hits === record.samples;
}

const Approval = z.object({ approved: z.boolean(), auto: z.boolean(), editedReply: z.string().optional() });

const conversationFlow = H.flow('conversation')
  .input(ConversationAttributes)
  .step('classify', classifier, ctx => ({ task: `Subject: ${ctx.unit.attributes.subject}\n\n${ctx.unit.attributes.lastMessage}` }))
  .step('draft', drafter, ctx => ({
    task: `Reply to ${ctx.unit.attributes.customerEmail}:\n\n${ctx.unit.attributes.lastMessage}`,
    resources: [categoryResource(ctx.steps.classify.category)],
  }))
  .halt('approval', {
    ask: ctx => `Approve the reply on ${ctx.unit.attributes.ticketId} (${ctx.steps.classify.category}):\n\n${ctx.steps.draft.reply}`,
    decision: Approval,
    skip: ctx => (safeCategory(ctx.metrics, ctx.steps.classify.category) ? { approved: true, auto: true } : undefined),
  })
  .exit('rejected', ctx => ctx.steps.approval.approved === false)
  .step('send', sendReply, ctx => ({
    ticketId: ctx.unit.attributes.ticketId,
    reply: ctx.steps.approval.editedReply ?? ctx.steps.draft.reply,
  }), { afterCrash: 'park' })
  .exit('sent');

const slaHours: Record<ZendeskEvent['priority'], number> = { low: 48, normal: 24, high: 8, urgent: 2 };

function routeHelpdesk<SN extends string>(event: ZendeskEvent, to: Router<ConversationAttributes, SN>): Route {
  if (event.type === 'created') {
    return to.create({
      ticketId: event.ticketId,
      subject: event.subject,
      customerEmail: event.customerEmail,
      lastMessage: event.message,
      slaDeadline: new Date(event.createdAt.getTime() + slaHours[event.priority] * 3600000).toISOString(),
    });
  }
  if (event.status === 'solved' || event.status === 'closed') return to.signal(closedByCustomer, event.ticketId, {});
  return to.signal(customerReplied, event.ticketId, { message: event.message });
}

const helpdeskToken = H.env('ZENDESK_TOKEN');

const conversations = H.lane('conversations', Conversation)
  .supply(zendesk.webhook({ port: H.slot.port(1), path: '/helpdesk', secret: H.env('ZENDESK_WEBHOOK_SECRET') }), routeHelpdesk)
  .supply(zendesk.poll({ subdomain: 'acme', token: helpdeskToken, everyMinutes: 15 }), routeHelpdesk)
  .store(zendesk.store({ subdomain: 'acme', token: helpdeskToken }))
  .handler(conversationFlow, {
    exits: { rejected: New, sent: Sent },
    during: { classify: Classifying, draft: Drafting, approval: AwaitingApproval },
  })
  .on(customerReplied, { update: (attributes, payload) => ({ ...attributes, lastMessage: payload.message }), restart: 'classify' })
  .on(closedByCustomer, { enter: ClosedByCustomer })
  .on(slaBreached, { enter: Escalated })
  .ceiling({ maxUsd: 0.4, onExceed: 'halt' });

const slaBreach = H.trigger('slaBreach')
  .on(H.when.timer(conversations, { at: unit => new Date(unit.attributes.slaDeadline) }))
  .signal(slaBreached, conversations, event => (event.unit.state === 'Sent' ? undefined : { key: event.unit.key, payload: {} }));

const approvalRate = H.metric('approvalRate')
  .from(H.when.step(conversations, 'approval'))
  .samples(event => {
    const decision = event.output;
    const category = event.outputs.classify?.category;
    if (decision === undefined || decision.auto || category === undefined) return [];
    const samples: Sample[] = [{ group: category, hit: decision.approved }];
    const model = event.models.draft;
    if (typeof model === 'string') samples.push({ group: `model:${model}`, hit: decision.approved });
    return samples;
  });

const modelErrorRate = H.metric('modelErrorRate')
  .from(H.when.invocation({ lanes: [conversations] }))
  .samples(event => (typeof event.model === 'string' ? [{ group: 'conversations', hit: event.ok === false }] : []));

const AuditAttributes = z.object({ category: z.string(), openedAtRate: z.number() });
const AuditOpen = H.state('AuditOpen', 'pending');
const AuditInReview = H.state('AuditInReview', 'active');
const AuditClosed = H.terminal('AuditClosed', 'success');
const AuditWithdrawn = H.terminal('AuditWithdrawn', 'neutral');
const Audit = H.kind('Audit')
  .attributes(AuditAttributes)
  .states(AuditOpen, AuditInReview, AuditClosed, AuditWithdrawn)
  .key(a => a.category)
  .initial(AuditOpen)
  .onCancelled(AuditWithdrawn);

const auditFlow = H.flow('categoryAudit')
  .input(AuditAttributes)
  .halt('review', {
    ask: ctx => `Approval rate for ${ctx.unit.attributes.category} fell to ${ctx.unit.attributes.openedAtRate}. Audit recent replies and record findings.`,
    decision: z.object({ findings: z.string() }),
  })
  .exit('reviewed');

const audits = H.lane('audits', Audit)
  .store(sqlite.store({ path: 'state/units.db' }))
  .handler(auditFlow, { exits: { reviewed: AuditClosed }, during: { review: AuditInReview } });

const auditsOpened = H.metric('auditsOpened')
  .from(H.when.transition(audits, { to: AuditOpen }))
  .amounts(event => [{ group: event.unit.attributes.category, amount: 1 }]);

const tasteKind = H.memory('replyTaste').trust('taste');
const experienceKind = H.memory('draftingLesson').trust('experience');

const replyTaste = H.journal('replyTasteJournal', tasteKind)
  .store(jsonl.memoryStore({ path: 'memory/taste.jsonl' }))
  .recall(H.recall('replyTasteRecall', { by: 'specificity', limit: 20 }))
  .readBy(drafterRole);

const drafterExperience = H.journal('drafterExperience', experienceKind)
  .store(jsonl.memoryStore({ path: 'memory/experience.jsonl' }))
  .recall(H.recall('drafterExperienceRecall', { by: 'specificity', limit: 10 }))
  .readBy(drafterRole);

const categoryApprovalDrift = H.trigger('categoryApprovalDrift')
  .on(
    H.when.crossing(approvalRate, {
      window: { lastDays: 7 },
      minSamples: 50,
      enter: { below: 0.9 },
      exit: { above: 0.95 },
      groups: group => group.startsWith('model:') === false,
    }),
  )
  .create(audits, event => (event.edge === 'entered' ? { category: event.group, openedAtRate: event.value } : undefined))
  .record(drafterExperience, event =>
    event.edge === 'entered'
      ? {
          body: {
            text: `When drafting for ${event.group}, recall the stricter phrasing, because approvals fell to ${event.value} over ${event.samples} samples.`,
          },
          status: 'candidate',
          when: { kinds: [Conversation], roles: [drafterRole], resources: [categoryResource(event.group)] },
        }
      : undefined,
  )
  .signal(H.cancel, audits, event =>
    event.edge === 'exited'
      ? { key: event.group, payload: { reason: `approval rate recovered to ${event.value} over ${event.samples} samples` } }
      : undefined,
  );

const modelErrorBrake = H.trigger('modelErrorBrake')
  .on(
    H.when.crossing(modelErrorRate, {
      window: { lastHours: 1 },
      minSamples: 20,
      enter: { above: 0.2 },
      exit: { below: 0.05 },
    }),
  )
  .pause(conversations, event =>
    event.edge === 'entered' ? `model error rate ${event.value} over ${event.samples} invocations in the last hour` : undefined,
  )
  .resume(conversations, event =>
    event.edge === 'exited' ? `model error rate recovered to ${event.value} over ${event.samples} invocations` : undefined,
  );

export const supportSelfWatch = H.harness('supportSelfWatch')
  .ledger(sqlite.ledger({ path: 'state/ledger.db' }))
  .pools(pool)
  .lanes(conversations, audits)
  .journals(replyTaste, drafterExperience)
  .triggers(slaBreach, categoryApprovalDrift, modelErrorBrake)
  .metrics(approvalRate, modelErrorRate, auditsOpened)
  .scheduler(
    H.scheduler('supportScheduler')
      .priority(conversations, audits)
      .rank(conversations, unit => new Date(unit.attributes.slaDeadline).getTime())
      .admit(audits, ctx =>
        ctx.active(audits) === 0 ||
        ctx.metrics.total(auditsOpened, { group: ctx.unit.attributes.category, window: { calendar: 'month' } }).total <= 3,
      ),
  )
  .clients(
    claudeCode.supervisor('reviewerDesk', {
      grants: [
        H.ops.workRead,
        H.ops.workUpdate,
        H.ops.workSignal,
        H.ops.workCancel,
        H.ops.blockersResolve,
        H.ops.lanesPause,
        H.ops.memoryRead,
        H.ops.memoryWrite,
        H.ops.memoryCurate,
        H.ops.telemetryRead,
      ],
    }),
  )
  .observers(markdown.board({ path: 'BOARD.md' }), markdown.telemetry({ path: 'TELEMETRY.md' }));
