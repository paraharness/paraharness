import { z } from 'zod';
import { H } from 'harness-dsl';
import type { Candidate } from 'harness-dsl/kernel';
import { claudeCode } from 'harness-dsl/claude-code';
import { anthropic } from 'harness-dsl/anthropic';
import { sqlite } from 'harness-dsl/sqlite';
import { jsonl } from 'harness-dsl/jsonl';
import { http } from 'harness-dsl/http';
import { supply } from 'harness-dsl/supply';
import { policies } from 'harness-dsl/policies';
import { observers } from 'harness-dsl/observers';

const conversationSchema = z.object({
  conversationId: z.string(),
  customer: z.string(),
  status: z.enum(['open', 'closed']),
  messages: z.array(z.string()),
  slaDueAt: z.string(),
});
const escalationSchema = z.object({ conversationId: z.string(), reason: z.string() });
const helpdeskRecord = z.object({ conversation: conversationSchema, harnessState: z.string() });

const fresh = H.state('new').pending();
const handling = H.state('handling').active();
const sent = H.state('sent').terminal('success');
const closedByCustomer = H.state('closedByCustomer').terminal('neutral');
const escalated = H.state('escalated').terminal('failure');

const raised = H.state('raised').pending();
const working = H.state('working').active();
const settled = H.state('settled').terminal('success');
const unsettled = H.state('unsettled').waiting();

const conversation = H.work('Conversation').schema(conversationSchema).states(fresh, handling, sent, closedByCustomer, escalated);
const escalation = H.work('Escalation').schema(escalationSchema).states(raised, working, settled, unsettled);

const category = H.facet('category');

const taste = H.memory('tone').content(z.object({ prefer: z.string() })).trust('taste');
const experience = H.memory('supportExperience')
  .content(z.object({ do: z.string(), when: z.string(), because: z.string() }))
  .trust('experience');
const tasteJournal = H.journal('tone').of(taste).store(jsonl.store('memory/tone.jsonl')).recall(policies.specificity({ limit: 10 }));
const experienceJournal = H.journal('supportExperience').of(experience).store(jsonl.store('memory/support.jsonl')).recall(policies.specificity({ limit: 10 }));

const approval = H.halt('replyApproval')
  .context(z.object({ category: z.string(), reply: z.string() }))
  .ask(c => `Approve this ${c.category} reply?\n\n${c.reply}`)
  .decision(z.object({ approved: z.boolean(), reply: z.string(), notes: z.string().optional() }));

const costCeiling = H.halt('costCeiling')
  .context(z.object({ spentUsd: z.number(), maxUsd: z.number() }))
  .ask(c => `Conversation spent $${c.spentUsd} of $${c.maxUsd}. Continue?`)
  .decision(z.object({ continue: z.boolean(), extraUsd: z.number().optional() }));

const escalationOutcome = H.halt('escalationOutcome')
  .context(escalationSchema)
  .ask(c => `Escalated conversation ${c.conversationId}: ${c.reason}`)
  .decision(z.object({ resolved: z.boolean(), resolution: z.string() }));

const helpdeskToken = H.env('HELPDESK_TOKEN');
const helpdeskBase = 'https://helpdesk.example.com/api';
const local = H.runner.local('local', { slots: 8 });

const sendReply = H.command('sendReply')
  .input(z.object({ conversationId: z.string(), reply: z.string() }))
  .runner(local)
  .effect('unrepeatable')
  .run(async (input, ctx) => {
    const response = await fetch(`${helpdeskBase}/conversations/${input.conversationId}/replies`, {
      method: 'POST',
      headers: { authorization: `Bearer ${ctx.resolve(helpdeskToken)}`, 'content-type': 'application/json', 'idempotency-key': ctx.attempt.id },
      body: JSON.stringify({ body: input.reply }),
    });
    if (!response.ok) throw new Error(`reply rejected: ${response.status}`);
  });

const postResolution = H.command('postResolution')
  .input(z.object({ conversationId: z.string(), resolution: z.string() }))
  .runner(local)
  .effect('repeatable')
  .run(async (input, ctx) => {
    await fetch(`${helpdeskBase}/conversations/${input.conversationId}/notes`, {
      method: 'PUT',
      headers: { authorization: `Bearer ${ctx.resolve(helpdeskToken)}`, 'content-type': 'application/json' },
      body: JSON.stringify({ note: input.resolution }),
    });
  });

const haiku = H.model('claude-haiku-4-5').pricing(anthropic.pricing());
const sonnet = H.model('claude-sonnet-4-5').pricing(anthropic.pricing());
const apiAccount = H.account('anthropic-api', anthropic.api({ apiKey: H.env('ANTHROPIC_API_KEY') })).quota(sqlite.quota('.harness/quota.db'));
const apiPool = H.pool('api', [apiAccount]).serves(haiku, sonnet);

const classifierRole = H.role('classifier').prompt('Classify the conversation into one support category.');
const drafterRole = H.role('drafter').promptFile('roles/drafter.md').recall(taste, experience);
const classifier = H.seat('classifier').role(classifierRole).models(haiku);
const drafter = H.seat('drafter').role(drafterRole).models(sonnet);

const classifySkill = H.skill('classify')
  .input(z.object({ messages: z.array(z.string()) }))
  .output(z.object({ category: z.string() }))
  .prompt(i => i.messages.join('\n---\n'));

const draftSkill = H.skill('draftReply')
  .input(z.object({ category: z.string(), messages: z.array(z.string()) }))
  .output(z.object({ reply: z.string() }))
  .prompt(i => `Category: ${i.category}\n\n${i.messages.join('\n---\n')}`);

const triage = H.flow('triage')
  .input(conversationSchema)
  .when(s => s.input.status === 'closed', closed => closed.exit('closedByCustomer'))
  .step('classify', classifier.call(classifySkill), s => ({ messages: s.input.messages }))
  .facet(category, s => s.steps.classify.category)
  .step('draft', drafter.call(draftSkill), s => ({ category: s.steps.classify.category, messages: s.input.messages }))
  .halt('approval', approval, s => ({ category: s.steps.classify.category, reply: s.steps.draft.reply }))
  .when(s => !s.steps.approval.approved, rejected => rejected.exit('rejected'))
  .step('send', sendReply, s => ({ conversationId: s.input.conversationId, reply: s.steps.approval.reply }))
  .exit('sent');

const handleEscalation = H.flow('handleEscalation')
  .input(escalationSchema)
  .halt('outcome', escalationOutcome, s => s.input)
  .step('note', postResolution, s => ({ conversationId: s.input.conversationId, resolution: s.steps.outcome.resolution }))
  .exit(s => (s.steps.outcome.resolved ? 'settled' : 'unsettled'));

const helpdeskStore = http.store({
  load: async (unit, ctx) => {
    const response = await fetch(`${helpdeskBase}/conversations/${unit.key}`, { headers: { authorization: `Bearer ${ctx.resolve(helpdeskToken)}` } });
    if (!response.ok) return undefined;
    const record = helpdeskRecord.parse(await response.json());
    return { data: record.conversation, state: record.harnessState };
  },
  save: async (unit, change, ctx) => {
    await fetch(`${helpdeskBase}/conversations/${unit.key}/harness`, {
      method: 'PUT',
      headers: { authorization: `Bearer ${ctx.resolve(helpdeskToken)}`, 'content-type': 'application/json' },
      body: JSON.stringify(change),
    });
  },
});

const webhook = http.webhook({ path: '/helpdesk/events', schema: conversationSchema, secret: H.env('HELPDESK_WEBHOOK_SECRET') })
  .key(c => c.conversationId);
const sweep = supply.poll({
  every: '10m',
  fetch: async ctx => {
    const response = await fetch(`${helpdeskBase}/conversations?status=open`, { headers: { authorization: `Bearer ${ctx.resolve(helpdeskToken)}` } });
    return z.array(conversationSchema).parse(await response.json());
  },
}).key(c => c.conversationId);

const conversations = H.lane('conversations')
  .of(conversation)
  .from(webhook, sweep)
  .store(helpdeskStore)
  .handle(triage)
  .exits({
    closedByCustomer,
    sent,
    rejected: { to: fresh, maxTimes: 2, then: escalated },
    failed: { tries: 2, backoff: 'exponential', delaySeconds: 30, then: escalated },
  })
  .ceiling({ maxUsd: 0.4, onExceed: costCeiling })
  .deadline(unit => new Date(unit.data.slaDueAt));

const escalations = H.lane('escalations')
  .of(escalation)
  .handle(handleEscalation)
  .exits({ settled, unsettled, failed: { tries: 1, backoff: 'none', then: unsettled } });

const approved = H.events.decisions(approval, { match: d => d.approved });
const approvedReplies = H.metric('approvedReplies').count(approved);
const rejectedReplies = H.metric('rejectedReplies').count(H.events.decisions(approval, { match: d => !d.approved, resolver: 'human' }));
const approvalRate = H.metric('approvalRate').rate(approved, H.events.decisions(approval));

const safeCategory = H.policy.halt('safeCategory', approval, ({ context, metrics }) => {
  const where = { facet: { facet: category, value: context.category } };
  const approvedReading = metrics.read(approvedReplies, { where });
  const rejectedReading = metrics.read(rejectedReplies, { where });
  const rate = metrics.read(approvalRate, { where });
  const safe = approvedReading.samples >= 200 && (approvedReading.value ?? 0) >= 200 && (rejectedReading.value ?? 0) === 0 && rate.value === 1;
  return safe ? { approved: true, reply: context.reply } : undefined;
});

const autoApproveSafe = H.trigger('autoApproveSafeCategory').on(approval.opened()).do(H.ops.resolve(approval).by(safeCategory));

const breachEscalates = H.trigger('slaBreachEscalates')
  .on(conversations.overdue())
  .do(
    escalations.create(
      p => ({ conversationId: p.unit.data.conversationId, reason: `SLA breached at ${p.deadline.toISOString()}` }),
      p => p.unit.data.conversationId,
    ),
    conversations.move(escalated),
  );

const editsBecomeTaste = H.trigger('reviewerEditsBecomeTaste')
  .on(approval.resolved())
  .when(p => p.resolver === 'human' && (p.decision.reply !== p.context.reply || p.decision.notes !== undefined))
  .do(tasteJournal.record(p => ({
    content: { prefer: p.decision.notes ?? `Prefer this phrasing: ${p.decision.reply}` },
    when: { roles: [drafterRole] },
    status: 'candidate',
  })));

function timeToBreach(candidate: Candidate, now: Date): number {
  return candidate.unit.deadline === undefined ? Number.POSITIVE_INFINITY : candidate.unit.deadline.getTime() - now.getTime();
}

const breachFirst = H.policy.schedule('breachFirst', ({ candidates, now }) =>
  [...candidates].sort((a, b) => {
    if (a.lane === escalations && b.lane !== escalations) return -1;
    if (b.lane === escalations && a.lane !== escalations) return 1;
    return timeToBreach(a, now) - timeToBreach(b, now);
  }),
);

const reviewer = claudeCode.client('reviewer');

export const harness = H.harness('support-triage')
  .ledger(sqlite.ledger('.harness/ledger.db'))
  .pools(apiPool)
  .lanes(conversations, escalations)
  .journals(tasteJournal, experienceJournal)
  .triggers(autoApproveSafe, breachEscalates, editsBecomeTaste)
  .scheduler(H.scheduler().policy(breachFirst))
  .grants(H.grant(
    reviewer,
    H.ops.work.read,
    H.ops.resolve(approval),
    H.ops.resolve(costCeiling),
    H.ops.resolve(escalationOutcome),
    H.ops.memory.write(tasteJournal, experienceJournal),
    H.ops.telemetry.read,
  ))
  .metrics(approvedReplies, rejectedReplies, approvalRate)
  .observe(observers.board({ path: 'BOARD.md' }), observers.telemetry({ path: 'TELEMETRY.md' }));

export const running = harness.start();
