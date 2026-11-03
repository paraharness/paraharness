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

const messageSchema = z.object({ from: z.enum(['customer', 'agent']), text: z.string(), at: z.string() });
const conversationSchema = z.object({
  conversationId: z.string(),
  customerId: z.string(),
  status: z.enum(['open', 'closed']),
  messages: z.array(messageSchema),
  slaDueAt: z.string(),
});
type Conversation = z.infer<typeof conversationSchema>;
const escalationSchema = z.object({ conversationId: z.string(), reason: z.string() });

const fresh = H.state('new').pending();
const handling = H.state('handling').active();
const sent = H.state('sent').waiting();
const closedByCustomer = H.state('closedByCustomer').terminal('success');
const escalated = H.state('escalated').terminal('failure');

const escalationOpen = H.state('escalationOpen').pending();
const escalationHandling = H.state('escalationHandling').active();
const escalationResolved = H.state('escalationResolved').terminal('success');
const escalationAbandoned = H.state('escalationAbandoned').terminal('failure');

const conversation = H.work('Conversation').schema(conversationSchema).states(fresh, handling, sent, closedByCustomer, escalated);
const escalation = H.work('Escalation').schema(escalationSchema).states(escalationOpen, escalationHandling, escalationResolved, escalationAbandoned);

const category = H.facet('category');

const storedSchema = z.object({ data: z.unknown(), state: z.string() });
const helpdeskStore = (collection: string) => http.store({
  load: async (unit, ctx) => {
    const response = await fetch(`${ctx.resolve(helpdeskUrl)}/${collection}/${unit.key}`, {
      headers: { authorization: `Bearer ${ctx.resolve(helpdeskToken)}` },
    });
    if (response.status === 404) return undefined;
    const body = storedSchema.parse(await response.json());
    return { data: body.data, state: body.state };
  },
  save: async (unit, change, ctx) => {
    await fetch(`${ctx.resolve(helpdeskUrl)}/${collection}/${unit.key}`, {
      method: 'PUT',
      headers: { authorization: `Bearer ${ctx.resolve(helpdeskToken)}`, 'content-type': 'application/json' },
      body: JSON.stringify(change),
    });
  },
});

const experience = H.memory('experience')
  .content(z.object({ action: z.string(), condition: z.string(), reason: z.string() }))
  .trust('experience');
const taste = H.memory('taste').content(z.object({ preference: z.string() })).trust('taste');

const experienceJournal = H.journal('experience').of(experience).store(jsonl.store('memory/experience.jsonl')).recall(policies.specificity({ limit: 10 }));
const tasteJournal = H.journal('taste').of(taste).store(jsonl.store('memory/taste.jsonl')).recall(policies.specificity({ limit: 10 }));

const apiAccount = H.account('support-api', anthropic.api({ apiKey: H.env('ANTHROPIC_API_KEY') }));
const haiku = H.model('claude-haiku-4-5').pricing(anthropic.pricing());
const sonnet = H.model('claude-sonnet-4-5').pricing(anthropic.pricing());
const pool = H.pool('support', [apiAccount]).serves(haiku, sonnet);

const classifierRole = H.role('classifier').promptFile('prompts/classifier.md').intents(['read']);
const drafterRole = H.role('drafter').promptFile('prompts/drafter.md').intents(['read']).recall(taste, experience);

const classifier = H.agent('classifier').role(classifierRole).model(haiku);
const drafter = H.agent('drafter').role(drafterRole).model(sonnet);

const categories = z.enum(['billing', 'refund', 'technical', 'account', 'other']);

const classify = H.skill('classify')
  .input(z.object({ messages: z.array(messageSchema) }))
  .output(z.object({ category: categories }))
  .prompt(i => `Classify this conversation:\n${i.messages.map(m => `${m.from}: ${m.text}`).join('\n')}`);

const draft = H.skill('draft')
  .input(z.object({ category: categories, messages: z.array(messageSchema) }))
  .output(z.object({ reply: z.string() }))
  .prompt(i => `Draft the next reply for a ${i.category} conversation:\n${i.messages.map(m => `${m.from}: ${m.text}`).join('\n')}`);

const approval = H.halt('reply-approval')
  .context(z.object({ conversationId: z.string(), category: categories, draft: z.string() }))
  .ask(c => `Approve this ${c.category} reply?\n\n${c.draft}`)
  .decision(z.object({ approved: z.boolean(), reply: z.string().optional() }));

const budget = H.halt('conversation-budget')
  .context(z.object({ spentUsd: z.number(), maxUsd: z.number() }))
  .ask(c => `This conversation has spent $${c.spentUsd} of $${c.maxUsd}. Continue?`)
  .decision(z.object({ continue: z.boolean(), extraUsd: z.number().optional() }));

const takeOver = H.halt('escalation-take-over')
  .context(escalationSchema)
  .ask(c => `Conversation ${c.conversationId} escalated: ${c.reason}`)
  .decision(z.object({ resolution: z.string() }));

const workstation = H.runner.local('workstation', { slots: 8 });

const sendReply = H.command('send-reply')
  .input(z.object({ conversationId: z.string(), reply: z.string() }))
  .runner(workstation)
  .effect('unrepeatable')
  .run(async (input, ctx) => {
    const response = await fetch(`${ctx.resolve(helpdeskUrl)}/conversations/${input.conversationId}/replies`, {
      method: 'POST',
      headers: { authorization: `Bearer ${ctx.resolve(helpdeskToken)}`, 'content-type': 'application/json' },
      body: JSON.stringify({ body: input.reply }),
    });
    if (!response.ok) throw new Error(`helpdesk returned ${response.status}`);
  });

const reply = H.flow('reply')
  .input(conversationSchema)
  .when(s => s.input.status === 'closed', closed => closed.exit('closed'))
  .step('classify', classifier.call(classify), s => ({ messages: s.input.messages }))
  .facet(category, s => s.steps.classify.category)
  .step('draft', drafter.call(draft), s => ({ category: s.steps.classify.category, messages: s.input.messages }))
  .halt('approval', approval, s => ({
    conversationId: s.input.conversationId,
    category: s.steps.classify.category,
    draft: s.steps.draft.reply,
  }))
  .when(s => !s.steps.approval.approved, rejected => rejected.exit('rejected'))
  .step('send', sendReply, s => ({
    conversationId: s.input.conversationId,
    reply: s.steps.approval.reply ?? s.steps.draft.reply,
  }))
  .exit('sent');

const escalationFlow = H.flow('escalation')
  .input(escalationSchema)
  .halt('takeOver', takeOver, s => s.input)
  .exit('resolved');

const conversations = H.lane('conversations')
  .of(conversation)
  .from(
    http.webhook({ path: '/helpdesk/events', schema: conversationSchema, secret: H.env('HELPDESK_WEBHOOK_SECRET') })
      .key(data => data.conversationId),
    supply.poll({
      every: '10m',
      fetch: async (ctx): Promise<Conversation[]> => {
        const response = await fetch(`${ctx.resolve(helpdeskUrl)}/conversations?status=open`, {
          headers: { authorization: `Bearer ${ctx.resolve(helpdeskToken)}` },
        });
        return z.array(conversationSchema).parse(await response.json());
      },
    }).key(data => data.conversationId),
  )
  .store(helpdeskStore('conversations'))
  .handle(reply)
  .exits({ closed: closedByCustomer, rejected: { to: fresh, maxTimes: 2, then: escalated }, sent })
  .retry({ tries: 2, backoff: 'exponential', delaySeconds: 30, exhausted: escalated })
  .ceiling({ maxUsd: 0.4, onExceed: budget });

const escalations = H.lane('escalations')
  .of(escalation)
  .store(helpdeskStore('escalations'))
  .handle(escalationFlow)
  .exits({ resolved: escalationResolved })
  .retry({ tries: 1, backoff: 'none', exhausted: escalationAbandoned });

const humanApprovalRate = H.metric('human-approval-rate').rate(
  H.events.decisions(approval, { match: d => d.approved, resolver: 'human' }),
  H.events.decisions(approval, { resolver: 'human' }),
);

const safeCategory = H.policy.halt('safe-category-auto-approval', approval, ({ context, metrics }) => {
  const reading = metrics.read(humanApprovalRate, {
    where: { facet: { facet: category, value: context.category }, model: sonnet },
  });
  return reading.samples >= 200 && reading.value === 1 ? { approved: true } : undefined;
});

const autoApproveSafeCategories = H.trigger('auto-approve-safe-categories')
  .on(approval.opened())
  .do(H.ops.resolve(approval).by(safeCategory));

const reviewerEditsBecomeTaste = H.trigger('reviewer-edits-become-taste')
  .on(approval.resolved())
  .when(p => p.resolver === 'human' && p.decision.reply !== undefined && p.decision.reply !== p.context.draft)
  .do(tasteJournal.record(p => ({
    content: { preference: `For ${p.context.category} replies, write it the way the reviewer did: "${p.decision.reply ?? ''}" rather than "${p.context.draft}"` },
    when: { roles: [drafterRole] },
    status: 'candidate',
  })));

const slaBreachEscalates = H.trigger('sla-breach-escalates')
  .on(conversations.due(unit => new Date(unit.data.slaDueAt)))
  .do(
    escalations.create(
      p => ({ conversationId: p.unit.data.conversationId, reason: `SLA breached at ${p.deadline.toISOString()}` }),
      p => p.unit.data.conversationId,
    ),
    conversations.move(escalated),
  );

const timeToBreach = H.policy.schedule('time-to-breach', ({ candidates, now }) => {
  const remaining = (candidate: (typeof candidates)[number]) => {
    const unit = conversations.unitOf(candidate);
    return unit === undefined ? Number.NEGATIVE_INFINITY : Date.parse(unit.data.slaDueAt) - now.getTime();
  };
  return [...candidates].sort((a, b) => remaining(a) - remaining(b));
});

const reviewer = H.grant(
  claudeCode.client('reviewer', { session: 'support' }),
  H.ops.work.read,
  H.ops.resolve(approval),
  H.ops.resolve(budget),
  H.ops.resolve(takeOver),
  H.ops.memory.write(tasteJournal, experienceJournal),
  H.ops.memory.curate(tasteJournal),
  H.ops.telemetry.read,
);

export default H.harness('support-triage')
  .ledger(sqlite.ledger('.harness/ledger.db'))
  .pools(pool)
  .lanes(conversations, escalations)
  .journals(experienceJournal, tasteJournal)
  .triggers(autoApproveSafeCategories, reviewerEditsBecomeTaste, slaBreachEscalates)
  .scheduler(H.scheduler().policy(timeToBreach))
  .grants(reviewer)
  .observe(observers.board({ path: 'BOARD.md' }), observers.telemetry({ path: 'TELEMETRY.md' }));
