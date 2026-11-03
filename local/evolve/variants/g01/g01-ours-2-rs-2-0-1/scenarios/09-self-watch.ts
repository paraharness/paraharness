import { z } from 'zod';
import { H } from 'harness-dsl';
import type { Candidate, ResolveContext } from 'harness-dsl/kernel';
import { claudeCode } from 'harness-dsl/claude-code';
import { anthropic } from 'harness-dsl/anthropic';
import { sqlite } from 'harness-dsl/sqlite';
import { jsonl } from 'harness-dsl/jsonl';
import { http } from 'harness-dsl/http';
import { supply } from 'harness-dsl/supply';
import { policies } from 'harness-dsl/policies';
import { observers } from 'harness-dsl/observers';

const helpdeskUrl = H.env('HELPDESK_URL');
const helpdeskToken = H.env('HELPDESK_TOKEN');

const helpdesk = (ctx: ResolveContext, path: string, init?: { readonly method: string; readonly body: string }) =>
  fetch(`${ctx.resolve(helpdeskUrl)}${path}`, {
    method: init?.method ?? 'GET',
    body: init?.body,
    headers: { authorization: `Bearer ${ctx.resolve(helpdeskToken)}`, 'content-type': 'application/json' },
  });

const local = H.runner.local('local', { slots: 8 });
const api = H.account('anthropic-api', anthropic.api({ apiKey: H.env('ANTHROPIC_API_KEY') }));
const haiku = H.model('claude-haiku-4-5').pricing(anthropic.pricing());
const sonnet = H.model('claude-sonnet-4-5').pricing(anthropic.pricing());

const categoryNames = ['billing', 'shipping', 'refunds', 'account'] as const satisfies readonly string[];
const categoryResources = categoryNames.map(name => H.resource(`category-${name}`));
const categoryScope = (key: string | undefined) => categoryResources.filter(r => r.name === `category-${key ?? ''}`);
const category = H.facet('category');

const taste = H.memory('taste').content(z.object({ rule: z.string() })).trust('taste');
const experience = H.memory('experience').content(z.object({ rule: z.string() })).trust('experience');
const tasteJournal = H.journal('reply-taste').of(taste).store(jsonl.store('./support/.harness/taste.jsonl')).recall(policies.specificity({ limit: 10 }));
const experienceJournal = H.journal('support-experience').of(experience).store(jsonl.store('./support/.harness/experience.jsonl')).recall(policies.specificity({ limit: 10 }));

const classifierRole = H.role('classifier').prompt('Classify the customer conversation.').intents(['read']);
const drafterRole = H.role('drafter').promptFile('./prompts/drafter.md').intents(['read']).recall(taste, experience);
const classifier = H.seat('classifier').role(classifierRole).models(haiku);
const drafter = H.seat('drafter').role(drafterRole).models(sonnet);

const conversationSchema = z.object({
  conversationId: z.string(),
  customer: z.string(),
  message: z.string(),
  slaDue: z.coerce.date(),
  status: z.enum(['open', 'closed']),
});
type ConversationData = z.infer<typeof conversationSchema>;

const newConversation = H.state('new').pending();
const handling = H.state('handling').active();
const sent = H.state('sent').waiting();
const closedByCustomer = H.state('closed-by-customer').terminal('success');
const escalated = H.state('escalated').terminal('neutral');
const conversation = H.work('conversation').schema(conversationSchema).states(newConversation, handling, sent, closedByCustomer, escalated);

const classify = H.skill('classify')
  .input(z.object({ message: z.string() }))
  .output(z.object({ category: z.enum(categoryNames) }))
  .prompt(i => `Classify:\n${i.message}`);

const draftReply = H.skill('draft-reply')
  .input(z.object({ message: z.string(), category: z.string() }))
  .output(z.object({ reply: z.string() }))
  .prompt(i => `Draft a reply for a ${i.category} conversation:\n${i.message}`);

const approval = H.halt('reply-approval')
  .context(z.object({ conversationId: z.string(), category: z.string(), draft: z.string() }))
  .ask(c => `Approve this ${c.category} reply?\n\n${c.draft}`)
  .decision(z.object({ approved: z.boolean(), finalReply: z.string(), tasteNote: z.string().optional() }));

const budget = H.halt('conversation-budget')
  .context(z.object({ spentUsd: z.number(), maxUsd: z.number() }))
  .ask(c => `This conversation has spent $${c.spentUsd} of $${c.maxUsd}. Continue?`)
  .decision(z.object({ continue: z.boolean(), extraUsd: z.number().optional() }));

const sendReply = H.command('send-reply')
  .input(z.object({ conversationId: z.string(), reply: z.string() }))
  .runner(local)
  .effect('unrepeatable')
  .run(async (input, ctx) => {
    const res = await helpdesk(ctx, `/conversations/${input.conversationId}/replies`, { method: 'POST', body: JSON.stringify({ body: input.reply }) });
    if (res.ok) return;
    throw new Error(`helpdesk refused reply: ${res.status}`);
  });

const converse = H.flow('converse')
  .input(conversationSchema)
  .when(s => s.input.status === 'closed', f => f.exit('closed'))
  .step('classify', classifier.call(classify), s => ({ message: s.input.message }))
  .facet(category, s => s.steps.classify.category)
  .step('draft', drafter.call(draftReply), s => ({ message: s.input.message, category: s.steps.classify.category }))
  .halt('approval', approval, s => ({ conversationId: s.input.conversationId, category: s.steps.classify.category, draft: s.steps.draft.reply }))
  .when(s => s.steps.approval.approved === false, f => f.exit('redraft'))
  .step('send', sendReply, s => ({ conversationId: s.input.conversationId, reply: s.steps.approval.finalReply }))
  .exit('sent');

const helpdeskRecord = z.object({ state: z.string(), conversation: conversationSchema });

const conversations = H.lane('conversations')
  .of(conversation)
  .from(
    http.webhook({ path: '/helpdesk', schema: conversationSchema, secret: H.env('HELPDESK_WEBHOOK_SECRET') }).key(d => d.conversationId),
    supply.poll<ConversationData>({
      every: '5m',
      fetch: async ctx => conversationSchema.array().parse(await (await helpdesk(ctx, '/conversations?awaiting=agent')).json()),
    }).key(d => d.conversationId),
  )
  .store(http.store({
    load: async (unit, ctx) => {
      const res = await helpdesk(ctx, `/conversations/${unit.key}`);
      if (res.status === 404) return undefined;
      const record = helpdeskRecord.parse(await res.json());
      return { data: record.conversation, state: record.state };
    },
    save: async (unit, change, ctx) => {
      await helpdesk(ctx, `/conversations/${unit.key}/harness-state`, { method: 'PUT', body: JSON.stringify(change) });
    },
  }))
  .handle(converse)
  .exits({
    closed: closedByCustomer,
    redraft: { to: newConversation, maxTimes: 2, then: escalated },
    sent,
    failed: { tries: 2, backoff: 'exponential', delaySeconds: 60, then: escalated },
  })
  .ceiling({ maxUsd: 0.4, onExceed: budget })
  .deadline(u => u.data.slaDue);

const escalationSchema = z.object({ conversationId: z.string(), reason: z.string() });
const escalationOpen = H.state('escalation-open').pending();
const escalationHandling = H.state('escalation-handling').active();
const escalationResolved = H.state('escalation-resolved').terminal('success');
const escalationDropped = H.state('escalation-dropped').terminal('failure');
const escalation = H.work('escalation').schema(escalationSchema).states(escalationOpen, escalationHandling, escalationResolved, escalationDropped);

const escalationHandled = H.halt('escalation-handled')
  .context(escalationSchema)
  .ask(c => `Escalated conversation ${c.conversationId}: ${c.reason}`)
  .decision(z.object({ resolution: z.string() }));

const escalationFlow = H.flow('handle-escalation')
  .input(escalationSchema)
  .halt('handled', escalationHandled, s => s.input)
  .exit('resolved');

const escalations = H.lane('escalations')
  .of(escalation)
  .store(sqlite.store('./support/.harness/units.sqlite'))
  .handle(escalationFlow)
  .exits({ resolved: escalationResolved, failed: { tries: 1, backoff: 'none', then: escalationDropped } });

const auditSchema = z.object({ category: z.string(), rate: z.number(), samples: z.number() });
const auditOpen = H.state('audit-open').pending();
const auditing = H.state('auditing').active();
const auditClosed = H.state('audit-closed').terminal('success');
const auditWithdrawn = H.state('audit-withdrawn').terminal('neutral');
const audit = H.work('audit').schema(auditSchema).states(auditOpen, auditing, auditClosed, auditWithdrawn);

const auditReview = H.halt('audit-review')
  .context(auditSchema)
  .ask(c => `Approvals for ${c.category} fell to ${c.rate.toFixed(2)} over ${c.samples} replies. What went wrong?`)
  .decision(z.object({ findings: z.string() }));

const auditFlow = H.flow('audit-category')
  .input(auditSchema)
  .halt('review', auditReview, s => s.input)
  .exit('closed');

const audits = H.lane('audits')
  .of(audit)
  .store(sqlite.store('./support/.harness/units.sqlite'))
  .handle(auditFlow)
  .exits({ closed: auditClosed, failed: { tries: 1, backoff: 'none', then: auditWithdrawn } })
  .facet(category, d => d.category);

const humanApprovalRate = H.metric('human-approval-rate').rate(
  H.events.decisions(approval, { match: d => d.approved, resolver: 'human' }),
  H.events.decisions(approval, { resolver: 'human' }),
);
const modelErrorRate = H.metric('model-error-rate').rate(H.events.invocations({ outcome: 'failed' }), H.events.invocations());
const auditsOpened = H.metric('audits-opened').count(H.events.created());
const pausedSeconds = H.metric('lane-paused-seconds').sum(H.events.pauses(), 'durationSeconds');

const approvalBand = humanApprovalRate.crossing({ below: 0.9, above: 0.95, samples: 50, window: '7d', by: category });
const errorBand = modelErrorRate.crossing({ above: 0.2, below: 0.05, samples: 20, window: '1h' });

const openAudit = H.trigger('open-audit-on-falling-approvals')
  .on(approvalBand.falls())
  .do(
    audits.create(c => ({ category: c.key ?? 'all', rate: c.value, samples: c.samples }), c => c.key ?? 'all'),
    experienceJournal.record(c => ({
      content: { rule: `when drafting for ${c.key ?? 'all'}, recall the stricter phrasing, because approvals fell to ${c.value.toFixed(2)}` },
      when: { roles: [drafterRole], resources: categoryScope(c.key) },
      status: 'candidate',
    })),
  );

const withdrawAudit = H.trigger('withdraw-audit-on-recovery')
  .on(approvalBand.rises())
  .do(audits.move(auditWithdrawn, c => c.key ?? 'all'));

const pauseOnModelErrors = H.trigger('pause-conversations-on-model-errors').on(errorBand.rises()).do(conversations.pause());
const resumeOnRecovery = H.trigger('resume-conversations-on-recovery').on(errorBand.falls()).do(conversations.resume());

const safeCategory = H.policy.halt('safe-category-auto-approve', approval, input => {
  const reading = input.metrics.read(humanApprovalRate, { where: { facet: { facet: category, value: input.context.category } } });
  return reading.samples >= 200 && reading.value === 1 ? { approved: true, finalReply: input.context.draft } : undefined;
});

const autoApprove = H.trigger('auto-approve-safe-categories').on(approval.opened()).do(H.ops.resolve(approval).by(safeCategory));

const escalateOnBreach = H.trigger('escalate-on-sla-breach')
  .on(conversations.overdue())
  .do(
    escalations.create(d => ({ conversationId: d.unit.data.conversationId, reason: `SLA breached at ${d.deadline.toISOString()}` }), d => d.unit.data.conversationId),
    conversations.move(escalated),
  );

const tasteFromEdits = H.trigger('taste-from-reviewer-edits')
  .on(approval.resolved())
  .when(r => r.resolver === 'human' && typeof r.decision.tasteNote === 'string')
  .do(tasteJournal.record(r => ({ content: { rule: r.decision.tasteNote ?? '' }, status: 'candidate' })));

const monthStart = (now: Date) => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));

const timeToBreach = H.policy.schedule('audits-then-time-to-breach', input => {
  const since = monthStart(input.now);
  const auditCounts = input.metrics.group(auditsOpened, { by: category, window: { since }, where: { lane: audits } });
  const paused = input.metrics.read(pausedSeconds, { window: { since }, where: { lane: conversations } });
  const scrutiny = (c: Candidate) => auditCounts.find(g => g.key === c.unit.facet(category))?.value ?? 0;
  const auditsFirst = (paused.value ?? 0) > 3600;
  const breachAt = (c: Candidate) => c.unit.deadline?.getTime() ?? Number.MAX_SAFE_INTEGER;
  const laneRank = (c: Candidate) => (c.lane === escalations ? 0 : c.lane === audits ? (auditsFirst ? 1 : 3) : 2);
  return [...input.candidates].sort((a, b) =>
    laneRank(a) - laneRank(b) || breachAt(a) - breachAt(b) || scrutiny(b) - scrutiny(a));
});

const reviewer = claudeCode.client('reviewer', { session: 'support-review' });

export const harness = H.harness('support-self-watch')
  .ledger(sqlite.ledger('./support/.harness/ledger.sqlite'))
  .pools(H.pool('api', [api]).serves(haiku, sonnet))
  .lanes(conversations, escalations, audits)
  .journals(tasteJournal, experienceJournal)
  .triggers(openAudit, withdrawAudit, pauseOnModelErrors, resumeOnRecovery, autoApprove, escalateOnBreach, tasteFromEdits)
  .scheduler(H.scheduler().policy(timeToBreach))
  .grants(H.grant(
    reviewer,
    H.ops.work.read,
    H.ops.work.write,
    H.ops.resolve(approval),
    H.ops.resolve(budget),
    H.ops.resolve(escalationHandled),
    H.ops.resolve(auditReview),
    H.ops.memory.write(tasteJournal),
    H.ops.memory.curate(tasteJournal, experienceJournal),
    H.ops.telemetry.read,
  ))
  .metrics(humanApprovalRate, modelErrorRate, auditsOpened, pausedSeconds)
  .observe(observers.board({ path: './support/BOARD.md' }), observers.telemetry({ path: './support/TELEMETRY.md' }));
