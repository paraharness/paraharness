import { z } from 'zod';
import { H } from 'harness-dsl';
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
const local = H.runner.local('worker', { slots: 4 });

const apiAccount = H.account('anthropic-api', anthropic.api({ apiKey: H.env('ANTHROPIC_API_KEY') }));
const haiku = H.model('claude-haiku-4-5').pricing(anthropic.pricing());
const sonnet = H.model('claude-sonnet-4-5').pricing(anthropic.pricing());
const opus = H.model('claude-opus-4-1').pricing(anthropic.pricing());
const pool = H.pool('api', [apiAccount]).serves(haiku, sonnet, opus);

const category = H.facet('category');
const categoryResources = [H.resource('billing'), H.resource('refunds'), H.resource('shipping'), H.resource('account')];

const taste = H.memory('taste').content(z.object({ rule: z.string() })).trust('taste');
const experience = H.memory('experience').content(z.object({ rule: z.string() })).trust('experience');
const tasteJournal = H.journal('reviewer-taste').of(taste).store(jsonl.store('.harness/taste.jsonl')).recall(policies.specificity({ limit: 10 }));
const experienceJournal = H.journal('drafting-experience')
  .of(experience)
  .store(jsonl.store('.harness/experience.jsonl'))
  .recall(policies.specificity({ limit: 10 }));

const newState = H.state('new').pending();
const handling = H.state('handling').active();
const sent = H.state('sent').terminal('success');
const escalated = H.state('escalated').terminal('neutral');
const unhandled = H.state('unhandled').terminal('failure');

const messageSchema = z.object({ from: z.enum(['customer', 'agent']), text: z.string() });
const conversationSchema = z.object({
  conversationId: z.string(),
  customer: z.string(),
  messages: z.array(messageSchema),
  slaDeadline: z.string(),
});
const conversation = H.work('conversation').schema(conversationSchema).states(newState, handling, sent, escalated, unhandled);

const classifierRole = H.role('classifier').prompt('Classify the support conversation.');
const drafterRole = H.role('drafter').prompt('Draft a reply to the customer.').recall(taste, experience);

const classify = H.skill('classify')
  .input(z.object({ messages: z.array(messageSchema) }))
  .output(z.object({ category: z.enum(['billing', 'refunds', 'shipping', 'account']) }))
  .prompt(i => i.messages.map(m => `${m.from}: ${m.text}`).join('\n'));
const draftReply = H.skill('draft-reply')
  .input(z.object({ messages: z.array(messageSchema), category: z.string() }))
  .output(z.object({ reply: z.string() }))
  .prompt(i => `Category ${i.category}.\n${i.messages.map(m => `${m.from}: ${m.text}`).join('\n')}`);

const approval = H.halt('reply-approval')
  .context(z.object({ conversationId: z.string(), category: z.string(), draft: z.string() }))
  .ask(c => `Approve this ${c.category} reply?\n${c.draft}`)
  .decision(z.object({ approved: z.boolean(), reply: z.string() }));

const overBudget = H.halt('conversation-over-budget')
  .context(z.object({ spentUsd: z.number(), maxUsd: z.number() }))
  .ask(c => `Conversation spent $${c.spentUsd} of $${c.maxUsd}. Continue?`)
  .decision(z.object({ continue: z.boolean(), extraUsd: z.number().optional() }));

const approvalRate = H.metric('approval-rate').rate(
  H.events.decisions(approval, { match: d => d.approved }),
  H.events.decisions(approval),
);
const humanApprovals = H.metric('human-approvals').count(H.events.decisions(approval, { match: d => d.approved, resolver: 'human' }));
const humanRejections = H.metric('human-rejections').count(H.events.decisions(approval, { match: d => !d.approved, resolver: 'human' }));
const modelErrorRate = H.metric('model-error-rate').rate(H.events.invocations({ outcome: 'failed' }), H.events.invocations());
const auditsOpened = H.metric('audits-opened').count(H.events.created());
const pausedSeconds = H.metric('lane-paused-seconds').sum(H.events.pauses(), 'durationSeconds');

const fallbackAfterPauses = H.policy.seat('fallback-after-pauses', ({ metrics, now }) => {
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const paused = metrics.read(pausedSeconds, { window: { since: monthStart }, where: { lane: conversations } });
  return (paused.value ?? 0) > 3600 ? [opus, sonnet] : [sonnet, opus];
});

const classifier = H.seat('classifier').role(classifierRole).models(haiku);
const drafter = H.seat('drafter').role(drafterRole).models(sonnet, opus).policy(fallbackAfterPauses);

const sendReply = H.command('send-reply')
  .input(z.object({ conversationId: z.string(), reply: z.string() }))
  .output(z.object({ messageId: z.string() }))
  .runner(local)
  .effect('unrepeatable')
  .detect(async (i, ctx) => {
    const response = await fetch(`${ctx.resolve(helpdeskUrl)}/conversations/${i.conversationId}/replies?attempt=${ctx.attempt.id}`, {
      headers: { authorization: `Bearer ${ctx.resolve(helpdeskToken)}` },
    });
    const found = z.object({ messageId: z.string().optional() }).parse(await response.json());
    return found.messageId === undefined ? undefined : { messageId: found.messageId };
  })
  .run(async (i, ctx) => {
    const response = await fetch(`${ctx.resolve(helpdeskUrl)}/conversations/${i.conversationId}/replies`, {
      method: 'POST',
      headers: { authorization: `Bearer ${ctx.resolve(helpdeskToken)}` },
      body: JSON.stringify({ body: i.reply, attempt: ctx.attempt.id }),
    });
    return z.object({ messageId: z.string() }).parse(await response.json());
  });

const triage = H.flow('triage')
  .input(conversationSchema)
  .step('classify', classifier.call(classify), s => ({ messages: s.input.messages }))
  .facet(category, s => s.steps.classify.category)
  .step('draft', drafter.call(draftReply), s => ({ messages: s.input.messages, category: s.steps.classify.category }))
  .halt('approval', approval, s => ({
    conversationId: s.input.conversationId,
    category: s.steps.classify.category,
    draft: s.steps.draft.reply,
  }))
  .when(
    s => s.steps.approval.approved,
    f => f.step('send', sendReply, s => ({ conversationId: s.input.conversationId, reply: s.steps.approval.reply })),
  )
  .exit(s => (s.steps.approval.approved ? 'sent' : 'rejected'));

const storedConversation = conversationSchema.extend({ harnessState: z.string() });
const helpdeskStore = http.store({
  load: async (unit, ctx) => {
    const response = await fetch(`${ctx.resolve(helpdeskUrl)}/conversations/${unit.key}`, {
      headers: { authorization: `Bearer ${ctx.resolve(helpdeskToken)}` },
    });
    if (!response.ok) return undefined;
    const stored = storedConversation.parse(await response.json());
    return { data: stored, state: stored.harnessState };
  },
  save: async (unit, change, ctx) => {
    await fetch(`${ctx.resolve(helpdeskUrl)}/conversations/${unit.key}/harness`, {
      method: 'PUT',
      headers: { authorization: `Bearer ${ctx.resolve(helpdeskToken)}` },
      body: JSON.stringify({ state: change.state, data: change.data }),
    });
  },
});

const conversations = H.lane('conversations')
  .of(conversation)
  .from(
    http.webhook({ path: '/helpdesk/events', schema: conversationSchema, secret: H.env('HELPDESK_SECRET') }).key(d => d.conversationId),
    supply
      .poll({
        every: '10m',
        fetch: async ctx => {
          const response = await fetch(`${ctx.resolve(helpdeskUrl)}/conversations?status=open`, {
            headers: { authorization: `Bearer ${ctx.resolve(helpdeskToken)}` },
          });
          return z.array(conversationSchema).parse(await response.json());
        },
      })
      .key(d => d.conversationId),
  )
  .store(helpdeskStore)
  .wip(6)
  .ceiling({ maxUsd: 0.4, onExceed: overBudget })
  .deadline(unit => (unit.position === 'terminal' ? undefined : new Date(unit.data.slaDeadline)))
  .handle(triage, {
    exits: { sent, rejected: { to: newState, maxTimes: 2, then: escalated } },
    retry: { tries: 3, backoff: 'exponential', delaySeconds: 30, exhausted: unhandled },
  });

const escalationOpen = H.state('escalation-open').pending();
const escalationActive = H.state('escalation-active').active();
const escalationResolved = H.state('escalation-resolved').terminal('success');
const escalationDropped = H.state('escalation-dropped').terminal('failure');

const escalationSchema = z.object({ conversationId: z.string(), reason: z.string() });
const escalation = H.work('escalation')
  .schema(escalationSchema)
  .states(escalationOpen, escalationActive, escalationResolved, escalationDropped);

const handleEscalation = H.halt('handle-escalation')
  .context(escalationSchema)
  .ask(c => `Escalated conversation ${c.conversationId}: ${c.reason}`)
  .decision(z.object({ resolution: z.string() }));

const escalationFlow = H.flow('escalation')
  .input(escalationSchema)
  .halt('handled', handleEscalation, s => s.input)
  .exit('handled');

const escalations = H.lane('escalations')
  .of(escalation)
  .handle(escalationFlow, {
    exits: { handled: escalationResolved },
    retry: { tries: 1, backoff: 'none', exhausted: escalationDropped },
  });

const auditOpen = H.state('audit-open').pending();
const auditing = H.state('auditing').active();
const auditDone = H.state('audit-done').terminal('success');
const auditCancelled = H.state('audit-cancelled').terminal('neutral');
const auditFailed = H.state('audit-failed').terminal('failure');

const auditSchema = z.object({ category: z.string(), rate: z.number(), samples: z.number() });
const audit = H.work('audit').schema(auditSchema).states(auditOpen, auditing, auditDone, auditCancelled, auditFailed);

const auditReview = H.halt('audit-review')
  .context(auditSchema)
  .ask(c => `Approval rate for ${c.category} fell to ${c.rate} over ${c.samples} samples. Review the drafts.`)
  .decision(z.object({ findings: z.string() }));

const auditFlow = H.flow('category-audit')
  .input(auditSchema)
  .halt('review', auditReview, s => s.input)
  .exit('reviewed');

const audits = H.lane('audits')
  .of(audit)
  .facet(category, d => d.category)
  .handle(auditFlow, {
    exits: { reviewed: auditDone },
    retry: { tries: 1, backoff: 'none', exhausted: auditFailed },
  });

const safeCategory = H.policy.halt('safe-category', approval, ({ context, metrics }) => {
  const where = { facet: { facet: category, value: context.category } };
  const approved = metrics.read(humanApprovals, { where });
  const rejected = metrics.read(humanRejections, { where });
  return (approved.value ?? 0) >= 200 && (rejected.value ?? 0) === 0 ? { approved: true, reply: context.draft } : undefined;
});

const approvalCrossing = H.crossing(approvalRate, { below: 0.9, above: 0.95, samples: 50, window: '7d', by: category });
const errorCrossing = H.crossing(modelErrorRate, { above: 0.2, below: 0.05, samples: 20, window: '1h' });

const autoApproveSafe = H.trigger('auto-approve-safe').on(H.opened(approval)).do(H.resolve(approval, safeCategory));

const slaBreach = H.trigger('sla-breach')
  .on(H.due(conversations))
  .do(
    H.create(escalations, p => ({ conversationId: p.unit.data.conversationId, reason: `SLA breached at ${p.deadline.toISOString()}` }), {
      key: p => p.unit.data.conversationId,
    }),
    H.move(conversations, escalated),
  );

const approvalsFell = H.trigger('approvals-fell')
  .on(approvalCrossing.falls())
  .do(
    H.create(audits, p => ({ category: p.key ?? 'all', rate: p.value, samples: p.samples }), { key: p => p.key ?? 'all' }),
    H.record(experienceJournal, p => ({
      content: {
        rule: `when drafting for ${p.key ?? 'all'}, recall the stricter phrasing, because approvals fell to ${p.value.toFixed(2)}`,
      },
      when: { roles: [drafterRole], resources: categoryResources.filter(r => r.name === p.key) },
      status: 'candidate',
    })),
  );

const approvalsRecovered = H.trigger('approvals-recovered')
  .on(approvalCrossing.rises())
  .do(H.move(audits, auditCancelled, p => p.key ?? 'all'));

const errorsRose = H.trigger('model-errors-rose').on(errorCrossing.rises()).do(H.pause(conversations));
const errorsFell = H.trigger('model-errors-fell').on(errorCrossing.falls()).do(H.resume(conversations));

const breachFirst = H.policy.schedule('breach-first', ({ candidates, metrics, now }) => {
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const opened = metrics.group(auditsOpened, { window: { since: monthStart }, where: { lane: audits }, by: category });
  const openedFor = (value: string | undefined) => opened.find(g => g.key === value)?.value ?? 0;
  const breachIn = (deadline: Date | undefined) => (deadline === undefined ? Number.MAX_SAFE_INTEGER : deadline.getTime() - now.getTime());
  const auditQueue = candidates
    .filter(c => c.lane === audits)
    .sort((a, b) => openedFor(b.unit.facet(category)) - openedFor(a.unit.facet(category)));
  const rest = candidates.filter(c => c.lane !== audits).sort((a, b) => breachIn(a.deadline) - breachIn(b.deadline));
  return [...rest, ...auditQueue];
});

export default H.harness('support-self-watch')
  .ledger(sqlite.ledger('.harness/ledger.db'))
  .pools(pool)
  .lanes(conversations, escalations, audits)
  .journals(tasteJournal, experienceJournal)
  .triggers(autoApproveSafe, slaBreach, approvalsFell, approvalsRecovered, errorsRose, errorsFell)
  .schedule(breachFirst)
  .grants(
    H.grant(
      claudeCode.client('reviewer-supervisor'),
      H.ops.work.read,
      H.ops.work.write,
      H.ops.resolve(approval),
      H.ops.resolve(overBudget),
      H.ops.resolve(handleEscalation),
      H.ops.resolve(auditReview),
      H.ops.memory.write(tasteJournal),
      H.ops.memory.curate(experienceJournal),
      H.ops.telemetry.read,
    ),
  )
  .metrics(approvalRate, humanApprovals, humanRejections, modelErrorRate, auditsOpened, pausedSeconds)
  .observe(observers.board({ path: '.harness/board.md' }), observers.telemetry({ path: '.harness/telemetry.md' }));
