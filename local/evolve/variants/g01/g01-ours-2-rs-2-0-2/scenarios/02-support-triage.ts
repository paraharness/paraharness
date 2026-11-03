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

const fresh = H.state('new').pending();
const handling = H.state('handling').active();
const awaitingCustomer = H.state('awaitingCustomer').waiting();
const closedByCustomer = H.state('closedByCustomer').terminal('success');
const escalated = H.state('escalated').terminal('failure');

const raised = H.state('raised').pending();
const resolvedByHuman = H.state('resolvedByHuman').terminal('success');
const escalationAbandoned = H.state('escalationAbandoned').terminal('failure');

const messageSchema = z.object({ from: z.enum(['customer', 'agent']), text: z.string(), at: z.string() });
const conversationSchema = z.object({
  id: z.string(),
  subject: z.string(),
  status: z.enum(['open', 'closed']),
  messages: z.array(messageSchema),
  slaDueAt: z.string(),
});
const escalationSchema = z.object({ conversationId: z.string(), reason: z.string() });

const Conversation = H.work('Conversation').schema(conversationSchema).states(fresh, handling, awaitingCustomer, closedByCustomer, escalated);
const Escalation = H.work('Escalation').schema(escalationSchema).states(raised, handling, resolvedByHuman, escalationAbandoned);

const category = H.facet('category');

const taste = H.memory('replyTaste').content(z.object({ preference: z.string() })).trust('taste');
const experience = H.memory('replyExperience').content(z.object({ lesson: z.string() })).trust('experience');

const tasteJournal = H.journal('replyTaste').of(taste).store(jsonl.store('memory/taste.jsonl')).recall(policies.specificity({ limit: 10 }));
const experienceJournal = H.journal('replyExperience').of(experience).store(jsonl.store('memory/experience.jsonl')).recall(policies.specificity({ limit: 6 }));

const apiAccount = H.account('api', anthropic.api({ apiKey: H.env('ANTHROPIC_API_KEY') }));
const haiku = H.model('claude-haiku-4-5').pricing(anthropic.pricing());
const sonnet = H.model('claude-sonnet-4-5').pricing(anthropic.pricing());
const pool = H.pool('api', [apiAccount]).serves(haiku, sonnet);

const classifierRole = H.role('classifier').prompt('You classify a customer conversation into one support category.').intents([]);
const drafterRole = H.role('drafter')
  .prompt('You draft the next reply to a customer in the company voice.')
  .intents([])
  .recall(taste, experience);

const classifier = H.seat('classifier').role(classifierRole).models(haiku);
const drafter = H.seat('drafter').role(drafterRole).models(sonnet);

const categories = z.enum(['billing', 'refund', 'shipping', 'account', 'other']);

const classifySkill = H.skill('classify')
  .input(z.object({ subject: z.string(), messages: z.array(messageSchema) }))
  .output(z.object({ category: categories }))
  .prompt(i => `Subject: ${i.subject}\n${i.messages.map(m => `${m.from}: ${m.text}`).join('\n')}`);

const draftSkill = H.skill('draftReply')
  .input(z.object({ category: z.string(), messages: z.array(messageSchema) }))
  .output(z.object({ reply: z.string() }))
  .prompt(i => `Category: ${i.category}\n${i.messages.map(m => `${m.from}: ${m.text}`).join('\n')}\n\nDraft the next reply.`);

const approval = H.halt('replyApproval')
  .context(z.object({ conversationId: z.string(), category: z.string(), draft: z.string() }))
  .ask(c => `Approve the ${c.category} reply for conversation ${c.conversationId}?`)
  .decision(z.object({ approved: z.boolean(), reply: z.string().optional() }));

const costCeiling = H.halt('costCeiling')
  .context(z.object({ spentUsd: z.number(), maxUsd: z.number() }))
  .ask(c => `This conversation has spent $${c.spentUsd.toFixed(2)} of $${c.maxUsd.toFixed(2)}. Continue?`)
  .decision(z.object({ continue: z.boolean(), extraUsd: z.number().optional() }));

const escalationHalt = H.halt('escalationHandled')
  .context(escalationSchema)
  .ask(c => `Conversation ${c.conversationId} was escalated: ${c.reason}`)
  .decision(z.object({ outcome: z.string() }));

const helpdeskBase = 'https://helpdesk.example.com/api';
const helpdeskToken = H.env('HELPDESK_TOKEN');
const helpdeskRecord = z.object({ conversation: conversationSchema, stage: z.string() });

const helpdeskStore = http.store({
  load: async (unit, ctx) => {
    const response = await fetch(`${helpdeskBase}/conversations/${unit.key}/harness`, {
      headers: { authorization: `Bearer ${ctx.resolve(helpdeskToken)}` },
    });
    if (!response.ok) return undefined;
    const record = helpdeskRecord.parse(await response.json());
    return { data: record.conversation, state: record.stage };
  },
  save: async (unit, change, ctx) => {
    await fetch(`${helpdeskBase}/conversations/${unit.key}/harness`, {
      method: 'PUT',
      headers: { authorization: `Bearer ${ctx.resolve(helpdeskToken)}`, 'content-type': 'application/json' },
      body: JSON.stringify({ stage: change.state, conversation: change.data }),
    });
  },
});

const pushed = http
  .webhook({ path: '/hooks/helpdesk', schema: conversationSchema, secret: H.env('HELPDESK_WEBHOOK_SECRET') })
  .key(conversation => conversation.id);

const sweep = supply
  .poll({
    every: '10m',
    fetch: async ctx => {
      const response = await fetch(`${helpdeskBase}/conversations?updatedWithin=15m`, {
        headers: { authorization: `Bearer ${ctx.resolve(helpdeskToken)}` },
      });
      return z.array(conversationSchema).parse(await response.json());
    },
  })
  .key(conversation => conversation.id);

const sendReply = H.command('sendReply')
  .input(z.object({ conversationId: z.string(), text: z.string() }))
  .effect('unrepeatable')
  .run(async (input, ctx) => {
    const response = await fetch(`${helpdeskBase}/conversations/${input.conversationId}/replies`, {
      method: 'POST',
      headers: { authorization: `Bearer ${ctx.resolve(helpdeskToken)}`, 'content-type': 'application/json' },
      body: JSON.stringify({ text: input.text, idempotencyKey: `${ctx.attempt.id}/${ctx.attempt.step}` }),
    });
    if (!response.ok) throw new Error(`helpdesk refused the reply: ${response.status}`);
  });

const triage = H.flow('triage')
  .input(conversationSchema)
  .when(s => s.input.status === 'closed', f => f.exit('closedByCustomer'))
  .step('classify', classifier.call(classifySkill), s => ({ subject: s.input.subject, messages: s.input.messages }))
  .facet(category, s => s.steps.classify.category)
  .step('draft', drafter.call(draftSkill), s => ({ category: s.steps.classify.category, messages: s.input.messages }))
  .halt('approval', approval, s => ({ conversationId: s.input.id, category: s.steps.classify.category, draft: s.steps.draft.reply }))
  .when(s => !s.steps.approval.approved, f => f.exit('rejected'))
  .step('send', sendReply, s => ({ conversationId: s.input.id, text: s.steps.approval.reply ?? s.steps.draft.reply }))
  .exit('sent');

const conversations = H.lane('conversations')
  .of(Conversation)
  .from(pushed, sweep)
  .store(helpdeskStore)
  .handle(triage, {
    exits: {
      closedByCustomer,
      sent: awaitingCustomer,
      rejected: { to: fresh, maxTimes: 3, then: escalated },
    },
    retry: { tries: 2, backoff: 'exponential', delaySeconds: 30, exhausted: escalated },
  })
  .wip(8)
  .ceiling({ maxUsd: 0.4, onExceed: costCeiling })
  .deadline(unit => (unit.state === awaitingCustomer.name ? undefined : new Date(unit.data.slaDueAt)));

const humanResolution = H.flow('humanResolution')
  .input(escalationSchema)
  .halt('handled', escalationHalt, s => s.input)
  .exit('resolved');

const escalations = H.lane('escalations')
  .of(Escalation)
  .handle(humanResolution, {
    exits: { resolved: resolvedByHuman },
    retry: { tries: 0, backoff: 'none', exhausted: escalationAbandoned },
  });

const approvalRate = H.metric('approvalRate').rate(
  H.events.decisions(approval, { match: d => d.approved }),
  H.events.decisions(approval),
);
const humanApprovals = H.metric('humanApprovals').count(H.events.decisions(approval, { match: d => d.approved, resolver: 'human' }));
const rejections = H.metric('rejections').count(H.events.decisions(approval, { match: d => !d.approved }));

const safeCategory = H.policy.halt('safeCategory', approval, ({ context, metrics }) => {
  const where = { facet: { facet: category, value: context.category } };
  const approved = metrics.read(humanApprovals, { where });
  const rejected = metrics.read(rejections, { where });
  const proven = (approved.value ?? 0) >= 200 && (rejected.value ?? 0) === 0;
  return proven ? { approved: true } : undefined;
});

const safeCategoriesSkipApproval = H.trigger('safeCategoriesSkipApproval')
  .on(H.opened(approval))
  .do(H.resolve(approval, safeCategory));

const slaBreachEscalates = H.trigger('slaBreachEscalates')
  .on(H.due(conversations))
  .do(
    H.create(escalations, p => ({ conversationId: p.unit.key, reason: `SLA breached at ${p.deadline.toISOString()}` }), {
      key: p => p.unit.key,
    }),
    H.move(conversations, escalated),
  );

const reviewerEditsBecomeTaste = H.trigger('reviewerEditsBecomeTaste')
  .on(H.resolved(approval))
  .when(p => p.resolver === 'human' && p.decision.reply !== undefined && p.decision.reply !== p.context.draft)
  .do(
    H.record(tasteJournal, p => ({
      content: {
        preference: `When replying about ${p.context.category}, write like "${p.decision.reply ?? ''}" instead of "${p.context.draft}", because the reviewer rewrote the draft that way`,
      },
      status: 'candidate',
      when: { roles: [drafterRole] },
    })),
  );

const dueTime = (candidate: Candidate): number => candidate.deadline?.getTime() ?? Number.MAX_SAFE_INTEGER;

const timeToBreach = H.policy.schedule('timeToBreach', ({ candidates }) =>
  [...candidates].sort((a, b) => dueTime(a) - dueTime(b) || b.waitingSeconds - a.waitingSeconds),
);

const reviewer = claudeCode.client('reviewer');

const reviewerGrant = H.grant(
  reviewer,
  H.ops.work.read,
  H.ops.resolve(approval),
  H.ops.resolve(costCeiling),
  H.ops.resolve(escalationHalt),
  H.ops.memory.write(tasteJournal, experienceJournal),
  H.ops.memory.curate(tasteJournal),
  H.ops.telemetry.read,
);

export default H.harness('support-triage')
  .ledger(sqlite.ledger('.harness/ledger.db'))
  .pools(pool)
  .lanes(conversations, escalations)
  .journals(tasteJournal, experienceJournal)
  .triggers(safeCategoriesSkipApproval, slaBreachEscalates, reviewerEditsBecomeTaste)
  .schedule(timeToBreach)
  .grants(reviewerGrant)
  .metrics(approvalRate, humanApprovals, rejections)
  .observe(observers.board({ path: 'BOARD.md' }), observers.telemetry({ path: 'TELEMETRY.md' }));
