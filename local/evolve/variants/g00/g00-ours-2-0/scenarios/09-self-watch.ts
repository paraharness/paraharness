import { z } from 'zod';
import { H } from 'harness-dsl';
import { anthropic } from 'harness-dsl/anthropic';
import { claudeCode } from 'harness-dsl/claude-code';
import { sqlite } from 'harness-dsl/sqlite';
import { jsonl } from 'harness-dsl/jsonl';
import { http } from 'harness-dsl/http';
import { supply } from 'harness-dsl/supply';
import { policies } from 'harness-dsl/policies';
import { observers } from 'harness-dsl/observers';

const apiAccount = H.account('anthropic-api', anthropic.api({ apiKey: H.env('ANTHROPIC_API_KEY') }));
const haiku = H.model('claude-haiku-4-5').pricing(anthropic.pricing());
const sonnet = H.model('claude-sonnet-4-5').pricing(anthropic.pricing());
const apiPool = H.pool('api', [apiAccount]).serves(haiku, sonnet).policy(policies.soonestExpiring());

const categorySchema = z.enum(['billing', 'refunds', 'shipping', 'technical']);
const categoryArea = {
  billing: H.resource('category-billing'),
  refunds: H.resource('category-refunds'),
  shipping: H.resource('category-shipping'),
  technical: H.resource('category-technical'),
};
const areaOf = (key: string | undefined) => {
  const parsed = categorySchema.safeParse(key);
  return parsed.success ? [categoryArea[parsed.data]] : [];
};
const category = H.facet('category');

const taste = H.memory('taste').content(z.object({ rule: z.string() })).trust('taste');
const experience = H.memory('experience').content(z.object({ rule: z.string() })).trust('experience');
const tasteJournal = H.journal('taste').of(taste).store(jsonl.store('.harness/taste.jsonl')).recall(policies.specificity({ limit: 10 }));
const experienceJournal = H.journal('experience')
  .of(experience)
  .store(jsonl.store('.harness/experience.jsonl'))
  .recall(policies.specificity({ limit: 10 }));

const newConversation = H.state('new').pending();
const handling = H.state('handling').active();
const sent = H.state('sent').waiting();
const closedByCustomer = H.state('closed-by-customer').terminal('success');
const escalated = H.state('escalated').terminal('failure');

const conversationSchema = z.object({
  conversationId: z.string(),
  customer: z.string(),
  latestMessage: z.string(),
  status: z.enum(['open', 'closed']),
  slaDeadline: z.string(),
});
const conversationKind = H.work('Conversation').schema(conversationSchema).states(newConversation, handling, sent, closedByCustomer, escalated);

const helpdeskUrl = H.env('HELPDESK_URL');
const helpdeskToken = H.env('HELPDESK_TOKEN');
const helpdeskStore = http.store({
  load: async (unit, ctx) => {
    const response = await fetch(`${ctx.resolve(helpdeskUrl)}/conversations/${unit.key}`, {
      headers: { authorization: `Bearer ${ctx.resolve(helpdeskToken)}` },
    });
    return response.ok ? z.object({ data: conversationSchema, state: z.string() }).parse(await response.json()) : undefined;
  },
  save: async (unit, change, ctx) => {
    await fetch(`${ctx.resolve(helpdeskUrl)}/conversations/${unit.key}`, {
      method: 'PUT',
      headers: { authorization: `Bearer ${ctx.resolve(helpdeskToken)}`, 'content-type': 'application/json' },
      body: JSON.stringify(change),
    });
  },
});

const helpdeskPush = http
  .webhook({ path: '/helpdesk/events', schema: conversationSchema, secret: H.env('HELPDESK_WEBHOOK_SECRET') })
  .key((d) => d.conversationId);
const helpdeskSweep = supply
  .poll({
    every: '10m',
    fetch: async (ctx) => {
      const response = await fetch(`${ctx.resolve(helpdeskUrl)}/conversations?status=open`, {
        headers: { authorization: `Bearer ${ctx.resolve(helpdeskToken)}` },
      });
      return z.array(conversationSchema).parse(await response.json());
    },
  })
  .key((d) => d.conversationId);

const classifierRole = H.role('classifier').prompt('Classify the customer message into one category.').intents(['read']);
const drafterRole = H.role('drafter').promptFile('prompts/drafter.md').intents(['read']).recall(taste, experience);
const classifier = H.agent('classifier').role(classifierRole).model(haiku);
const drafter = H.agent('drafter').role(drafterRole).model(sonnet);

const classify = H.skill('classify')
  .input(z.object({ message: z.string() }))
  .output(z.object({ category: categorySchema }))
  .prompt((i) => i.message);
const draftReply = H.skill('draft-reply')
  .input(z.object({ category: categorySchema, message: z.string() }))
  .output(z.object({ reply: z.string() }))
  .prompt((i) => `Category ${i.category}. Customer wrote:\n${i.message}`);

const approval = H.halt('reply-approval')
  .context(z.object({ category: categorySchema, customer: z.string(), draft: z.string() }))
  .ask((c) => `Approve this ${c.category} reply to ${c.customer}?\n\n${c.draft}`)
  .decision(z.object({ approved: z.boolean(), editedReply: z.string().optional() }));
const overBudget = H.halt('conversation-over-budget')
  .context(z.object({ spentUsd: z.number(), maxUsd: z.number() }))
  .decision(z.object({ continue: z.boolean(), extraUsd: z.number().optional() }));

const sendReply = H.command('send-reply')
  .input(z.object({ conversationId: z.string(), reply: z.string() }))
  .effect('unrepeatable')
  .run(async (i, ctx) => {
    const response = await fetch(`${ctx.resolve(helpdeskUrl)}/conversations/${i.conversationId}/replies`, {
      method: 'POST',
      headers: { authorization: `Bearer ${ctx.resolve(helpdeskToken)}`, 'content-type': 'application/json' },
      body: JSON.stringify({ body: i.reply }),
    });
    if (!response.ok) throw new Error(`helpdesk refused the reply: ${response.status}`);
  });

const handleConversation = H.flow('conversation')
  .input(conversationSchema)
  .when((s) => s.input.status === 'closed', (f) => f.exit('closed'))
  .step('classify', classifier.call(classify), (s) => ({ message: s.input.latestMessage }))
  .facet(category, (s) => s.steps.classify.category)
  .resources((s) => [categoryArea[s.steps.classify.category]])
  .step('draft', drafter.call(draftReply), (s) => ({ category: s.steps.classify.category, message: s.input.latestMessage }))
  .halt('approval', approval, (s) => ({ category: s.steps.classify.category, customer: s.input.customer, draft: s.steps.draft.reply }))
  .when((s) => !s.steps.approval.approved, (f) => f.exit('rejected'))
  .step('send', sendReply, (s) => ({
    conversationId: s.input.conversationId,
    reply: s.steps.approval.editedReply ?? s.steps.draft.reply,
  }))
  .exit('sent');

const conversations = H.lane('conversations')
  .of(conversationKind)
  .from(helpdeskPush, helpdeskSweep)
  .store(helpdeskStore)
  .handle(handleConversation)
  .exits({ closed: closedByCustomer, rejected: { to: newConversation, maxTimes: 2, then: escalated }, sent })
  .retry({ tries: 2, backoff: 'exponential', delaySeconds: 60, exhausted: escalated })
  .ceiling({ maxUsd: 0.4, onExceed: overBudget })
  .wip(6);

const escalationOpen = H.state('escalation-open').pending();
const escalationHandling = H.state('escalation-handling').active();
const escalationResolved = H.state('escalation-resolved').terminal('success');
const escalationDropped = H.state('escalation-dropped').terminal('neutral');
const escalationSchema = z.object({ conversationId: z.string(), reason: z.string() });
const escalationKind = H.work('Escalation')
  .schema(escalationSchema)
  .states(escalationOpen, escalationHandling, escalationResolved, escalationDropped);
const escalationReview = H.halt('escalation-review')
  .context(escalationSchema)
  .ask((c) => `Conversation ${c.conversationId} escalated: ${c.reason}`)
  .decision(z.object({ resolution: z.string() }));
const handleEscalation = H.flow('escalation')
  .input(escalationSchema)
  .halt('review', escalationReview, (s) => s.input)
  .exit('resolved');
const escalations = H.lane('escalations')
  .of(escalationKind)
  .from(supply.manual())
  .store(sqlite.store('.harness/escalations.sqlite'))
  .handle(handleEscalation)
  .exits({ resolved: escalationResolved })
  .retry({ tries: 0, backoff: 'none', exhausted: escalationDropped });

const auditOpen = H.state('audit-open').pending();
const auditReviewing = H.state('audit-reviewing').active();
const auditDone = H.state('audit-done').terminal('success');
const auditCancelled = H.state('audit-cancelled').terminal('neutral');
const auditSchema = z.object({ category: z.string(), approvalRate: z.number(), samples: z.number() });
const auditKind = H.work('Audit').schema(auditSchema).states(auditOpen, auditReviewing, auditDone, auditCancelled);
const auditReview = H.halt('category-audit')
  .context(auditSchema)
  .ask((c) => `Approvals for ${c.category} fell to ${c.approvalRate.toFixed(2)} over ${c.samples} samples. What did you find?`)
  .decision(z.object({ findings: z.string() }));
const handleAudit = H.flow('audit')
  .input(auditSchema)
  .halt('review', auditReview, (s) => s.input)
  .exit('done');
const auditKey = (key: string | undefined) => `audit-${key ?? 'uncategorised'}`;
const audits = H.lane('audits')
  .of(auditKind)
  .from(supply.manual())
  .store(sqlite.store('.harness/audits.sqlite'))
  .handle(handleAudit)
  .exits({ done: auditDone })
  .retry({ tries: 0, backoff: 'none', exhausted: auditCancelled })
  .facet(category, (d) => d.category);

const approvedDecisions = H.events.decisions(approval, { match: (d) => d.approved });
const humanApprovals = H.metric('human-approvals').count(H.events.decisions(approval, { match: (d) => d.approved, resolver: 'human' }));
const rejections = H.metric('rejections').count(H.events.decisions(approval, { match: (d) => !d.approved }));
const approvalRate = H.metric('approval-rate').rate(approvedDecisions, H.events.decisions(approval));
const modelErrorRate = H.metric('model-error-rate').rate(H.events.invocations({ outcome: 'failed' }), H.events.invocations());
const auditsOpened = H.metric('audits-opened').count(H.events.created());
const pausedSeconds = H.metric('lane-paused-seconds').sum(H.events.pauses(), 'durationSeconds');

const safeCategory = H.policy.halt('safe-category', approval, ({ context, metrics }) => {
  const where = { facet: { facet: category, value: context.category } };
  const approved = metrics.read(humanApprovals, { where });
  const rejected = metrics.read(rejections, { where });
  return (approved.value ?? 0) >= 200 && (rejected.value ?? 0) === 0 ? { approved: true } : undefined;
});

const approvalCrossing = approvalRate.crossing({ below: 0.9, above: 0.95, samples: 50, window: '7d', by: category });
const errorCrossing = modelErrorRate.crossing({ above: 0.2, below: 0.05, samples: 20, window: '1h' });

const autoApproveSafe = H.trigger('auto-approve-safe-category').on(approval.opened()).do(H.ops.resolve(approval).by(safeCategory));

const editsBecomeTaste = H.trigger('reviewer-edits-become-taste')
  .on(approval.resolved())
  .when((p) => p.resolver === 'human' && p.decision.editedReply !== undefined)
  .do(
    tasteJournal.record((p) => ({
      content: { rule: `prefer phrasing like "${p.decision.editedReply ?? ''}" over "${p.context.draft}"` },
      when: { roles: [drafterRole], resources: [categoryArea[p.context.category]] },
      status: 'candidate',
    })),
  );

const slaBreach = H.trigger('sla-breach')
  .on(conversations.due((u) => new Date(u.data.slaDeadline)))
  .do(
    escalations.create(
      (p) => ({ conversationId: p.unit.data.conversationId, reason: `SLA breached at ${p.deadline.toISOString()}` }),
      (p) => p.unit.data.conversationId,
    ),
    conversations.move(escalated),
  );

const approvalDropOpensAudit = H.trigger('approval-drop-opens-audit')
  .on(approvalCrossing.falls())
  .do(
    audits.create((p) => ({ category: p.key ?? 'uncategorised', approvalRate: p.value, samples: p.samples }), (p) => auditKey(p.key)),
    experienceJournal.record((p) => ({
      content: {
        rule: `when drafting for ${p.key ?? 'uncategorised'}, recall the stricter phrasing, because approvals fell to ${p.value.toFixed(2)}`,
      },
      when: { roles: [drafterRole], resources: areaOf(p.key) },
      status: 'candidate',
    })),
  );

const approvalRecoveryCancelsAudit = H.trigger('approval-recovery-cancels-audit')
  .on(approvalCrossing.rises())
  .do(audits.move(auditCancelled, (p) => auditKey(p.key)));

const errorsPauseConversations = H.trigger('model-errors-pause-conversations')
  .on(errorCrossing.rises())
  .do(conversations.pause('model error rate above 0.2 over the last hour'));

const errorsRecoveredResumeConversations = H.trigger('model-errors-recovered-resume-conversations')
  .on(errorCrossing.falls())
  .do(conversations.resume());

const timeToBreach = H.policy.schedule('time-to-breach', ({ candidates, metrics, now }) => {
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const auditsThisMonth = metrics.group(auditsOpened, { by: category, window: { since: monthStart }, where: { lane: audits } });
  const pausedThisMonth = metrics.read(pausedSeconds, { window: { since: monthStart }, where: { lane: conversations } });
  const escalationsFirst = (pausedThisMonth.value ?? 0) > 3600;
  const auditsOf = (key: string) => auditsThisMonth.find((group) => group.key === key)?.value ?? 0;
  const score = (candidate: (typeof candidates)[number]) => {
    const conversation = conversations.unitOf(candidate);
    if (conversation) return Date.parse(conversation.data.slaDeadline) - now.getTime();
    const audit = audits.unitOf(candidate);
    if (audit) return -auditsOf(audit.data.category) * 3_600_000;
    return escalationsFirst ? Number.NEGATIVE_INFINITY : 0;
  };
  return [...candidates].sort((a, b) => score(a) - score(b));
});

export const support = H.harness('support')
  .ledger(sqlite.ledger('.harness/ledger.sqlite'))
  .pools(apiPool)
  .lanes(conversations, escalations, audits)
  .journals(tasteJournal, experienceJournal)
  .triggers(
    autoApproveSafe,
    editsBecomeTaste,
    slaBreach,
    approvalDropOpensAudit,
    approvalRecoveryCancelsAudit,
    errorsPauseConversations,
    errorsRecoveredResumeConversations,
  )
  .scheduler(H.scheduler().policy(timeToBreach))
  .grants(
    H.grant(
      claudeCode.client('reviewer', { session: 'reviewer' }),
      H.ops.work.read,
      H.ops.work.write,
      H.ops.resolve(approval),
      H.ops.resolve(overBudget),
      H.ops.resolve(escalationReview),
      H.ops.resolve(auditReview),
      H.ops.memory.write(tasteJournal),
      H.ops.memory.curate(tasteJournal, experienceJournal),
      H.ops.telemetry.read,
    ),
  )
  .metrics(approvalRate, modelErrorRate, auditsOpened, pausedSeconds)
  .observe(observers.board({ path: '.harness/board.md' }), observers.telemetry({ path: '.harness/telemetry.md' }));
