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

const fresh = H.state('new').pending();
const handling = H.state('handling').active();
const sentState = H.state('sent').terminal('success');
const closedByCustomer = H.state('closed-by-customer').terminal('neutral');
const escalated = H.state('escalated').terminal('failure');

const conversationSchema = z.object({
  id: z.string(),
  customer: z.string(),
  latestMessage: z.string(),
  slaDue: z.string(),
  closed: z.boolean(),
});

const conversation = H.work('conversation')
  .schema(conversationSchema)
  .states(fresh, handling, sentState, closedByCustomer, escalated);

const escalationOpen = H.state('escalation-open').pending();
const escalationHandling = H.state('escalation-handling').active();
const escalationClosed = H.state('escalation-closed').terminal('success');
const escalationDropped = H.state('escalation-dropped').terminal('failure');

const escalationSchema = z.object({ conversationId: z.string(), reason: z.string() });
const escalation = H.work('escalation')
  .schema(escalationSchema)
  .states(escalationOpen, escalationHandling, escalationClosed, escalationDropped);

const category = H.facet('category');

const tasteMemory = H.memory('reply-taste')
  .content(z.object({ prefer: z.string(), because: z.string() }))
  .trust('taste');
const experienceMemory = H.memory('reply-experience')
  .content(z.object({ do: z.string(), when: z.string(), because: z.string() }))
  .trust('experience');

const tasteJournal = H.journal('reply-taste-journal')
  .of(tasteMemory)
  .store(jsonl.store('memory/taste.jsonl'))
  .recall(policies.specificity({ limit: 10 }));
const experienceJournal = H.journal('reply-experience-journal')
  .of(experienceMemory)
  .store(jsonl.store('memory/experience.jsonl'))
  .recall(policies.specificity({ limit: 10 }));

const haiku = H.model('claude-haiku-4-5').pricing(anthropic.pricing());
const sonnet = H.model('claude-sonnet-4-5').pricing(anthropic.pricing());
const apiAccount = H.account('api', anthropic.api({ apiKey: H.env('ANTHROPIC_API_KEY') }));
const pool = H.pool('api', [apiAccount]).serves(haiku, sonnet).policy(policies.soonestExpiring());

const classifierRole = H.role('classifier').promptFile('prompts/classifier.md').intents(['read']);
const drafterRole = H.role('drafter').promptFile('prompts/drafter.md').intents(['read']).recall(tasteMemory, experienceMemory);

const classifier = H.seat('classifier').role(classifierRole).models(haiku);
const drafter = H.seat('drafter').role(drafterRole).models(sonnet);

const classify = H.skill('classify')
  .input(z.object({ message: z.string() }))
  .output(z.object({ category: z.string() }))
  .prompt(input => `Classify this customer message:\n${input.message}`);
const draftReply = H.skill('draft-reply')
  .input(z.object({ message: z.string(), category: z.string() }))
  .output(z.object({ reply: z.string() }))
  .prompt(input => `Draft a reply in category ${input.category} to:\n${input.message}`);

const approval = H.halt('reply-approval')
  .context(z.object({ conversationId: z.string(), category: z.string(), draft: z.string() }))
  .ask(context => `Approve this ${context.category} reply?\n\n${context.draft}`)
  .decision(z.object({ approved: z.boolean(), editedReply: z.string().optional(), notes: z.string().optional() }));

const costCeiling = H.halt('cost-ceiling')
  .context(z.object({ spentUsd: z.number(), maxUsd: z.number() }))
  .ask(context => `This conversation spent ${context.spentUsd} USD of ${context.maxUsd} USD. Continue?`)
  .decision(z.object({ continue: z.boolean(), extraUsd: z.number().optional() }));

const escalationReview = H.halt('escalation-review')
  .context(z.object({ conversationId: z.string(), reason: z.string() }))
  .ask(context => `Conversation ${context.conversationId} escalated: ${context.reason}`)
  .decision(z.object({ handled: z.boolean(), note: z.string() }));

const helpdeskUrl = H.env('HELPDESK_URL');
const helpdeskToken = H.env('HELPDESK_TOKEN');
const helpdeskSecret = H.env('HELPDESK_WEBHOOK_SECRET');

const sendReply = H.command('send-reply')
  .input(z.object({ conversationId: z.string(), body: z.string() }))
  .effect('unrepeatable')
  .run(async (input, ctx) => {
    const response = await fetch(`${ctx.resolve(helpdeskUrl)}/conversations/${input.conversationId}/replies`, {
      method: 'POST',
      headers: { authorization: `Bearer ${ctx.resolve(helpdeskToken)}`, 'content-type': 'application/json' },
      body: JSON.stringify({ body: input.body }),
    });
    if (response.ok) return;
    throw new Error(`helpdesk refused the reply: ${response.status}`);
  });

const flagEscalation = H.command('flag-escalation')
  .input(z.object({ conversationId: z.string(), note: z.string() }))
  .run(async (input, ctx) => {
    await fetch(`${ctx.resolve(helpdeskUrl)}/conversations/${input.conversationId}/tags`, {
      method: 'POST',
      headers: { authorization: `Bearer ${ctx.resolve(helpdeskToken)}`, 'content-type': 'application/json' },
      body: JSON.stringify({ tag: 'escalated', note: input.note }),
    });
  });

const triage = H.flow('triage')
  .input(conversationSchema)
  .step('classify', classifier.call(classify), s => ({ message: s.input.latestMessage }))
  .facet(category, s => s.steps.classify.category)
  .step('draft', drafter.call(draftReply), s => ({ message: s.input.latestMessage, category: s.steps.classify.category }))
  .halt('approve', approval, s => ({ conversationId: s.input.id, category: s.steps.classify.category, draft: s.steps.draft.reply }))
  .when(s => s.steps.approve.approved === false, f => f.exit('rejected'))
  .step('send', sendReply, s => ({ conversationId: s.input.id, body: s.steps.approve.editedReply ?? s.steps.draft.reply }))
  .exit('sent');

const triageHandler = H.handler('triage-conversation')
  .of(conversation)
  .flow(triage)
  .exits({ sent: sentState, rejected: { to: fresh, maxTimes: 2, then: escalated } })
  .retry({ tries: 2, backoff: 'exponential', delaySeconds: 30, exhausted: escalated });

const escalationFlow = H.flow('escalation')
  .input(escalationSchema)
  .halt('review', escalationReview, s => ({ conversationId: s.input.conversationId, reason: s.input.reason }))
  .step('flag', flagEscalation, s => ({ conversationId: s.input.conversationId, note: s.steps.review.note }))
  .exit(s => (s.steps.review.handled ? 'handled' : 'dropped'));

const escalationHandler = H.handler('handle-escalation')
  .of(escalation)
  .flow(escalationFlow)
  .exits({ handled: escalationClosed, dropped: escalationDropped })
  .retry({ tries: 1, backoff: 'linear', delaySeconds: 60, exhausted: escalationDropped });

const storedConversation = z.object({ data: conversationSchema, state: z.string() });

const helpdeskStore = http.store({
  load: async (unit, ctx) => {
    const response = await fetch(`${ctx.resolve(helpdeskUrl)}/conversations/${unit.key}/harness`, {
      headers: { authorization: `Bearer ${ctx.resolve(helpdeskToken)}` },
    });
    if (response.status === 404) return undefined;
    return storedConversation.parse(await response.json());
  },
  save: async (unit, change, ctx) => {
    await fetch(`${ctx.resolve(helpdeskUrl)}/conversations/${unit.key}/harness`, {
      method: 'PUT',
      headers: { authorization: `Bearer ${ctx.resolve(helpdeskToken)}`, 'content-type': 'application/json' },
      body: JSON.stringify(change),
    });
  },
});

const newConversations = http.webhook({ path: '/helpdesk/conversations', schema: conversationSchema, secret: helpdeskSecret })
  .key(data => data.id);
const missedConversations = supply.poll({
  every: '10m',
  fetch: async ctx => {
    const response = await fetch(`${ctx.resolve(helpdeskUrl)}/conversations?status=open`, {
      headers: { authorization: `Bearer ${ctx.resolve(helpdeskToken)}` },
    });
    return z.array(conversationSchema).parse(await response.json());
  },
}).key(data => data.id);
const customerReplies = http.webhook({
  path: '/helpdesk/replies',
  schema: z.object({ conversationId: z.string(), body: z.string() }),
  secret: helpdeskSecret,
})
  .map(reply => ({ id: reply.conversationId, latestMessage: reply.body }))
  .key(data => data.id)
  .updatesOnly();
const customerClosures = http.webhook({
  path: '/helpdesk/closed',
  schema: z.object({ conversationId: z.string() }),
  secret: helpdeskSecret,
})
  .map(event => ({ id: event.conversationId, closed: true }))
  .key(data => data.id)
  .updatesOnly();

const conversations = H.lane('conversations', triageHandler)
  .from(newConversations, missedConversations, customerReplies, customerClosures)
  .store(helpdeskStore)
  .ceiling({ maxUsd: 0.4, onExceed: costCeiling });

const escalations = H.lane('escalations', escalationHandler)
  .store(sqlite.store('.harness/escalations.db'));

const slaBreach = H.trigger('sla-breach-escalates')
  .on(conversations.due(unit => new Date(unit.data.slaDue)))
  .when(p => p.unit.position !== 'terminal')
  .do(
    escalations.create(p => ({ conversationId: p.unit.data.id, reason: `SLA breached at ${p.deadline.toISOString()}` }), p => p.unit.data.id),
    conversations.move(escalated),
  );

const customerReplied = H.trigger('customer-reply-reclassifies')
  .on(conversations.updated())
  .when(p => p.unit.data.closed === false && p.previous.latestMessage !== p.unit.data.latestMessage && typeof p.attempt === 'object')
  .do(conversations.move(fresh));

const customerClosed = H.trigger('customer-closed')
  .on(conversations.updated())
  .when(p => p.unit.data.closed && p.unit.position !== 'terminal')
  .do(conversations.move(closedByCustomer));

const approvedByHuman = H.metric('approved-by-human').count(
  H.events.decisions(approval, { match: d => d.approved, resolver: 'human' }),
);
const rejected = H.metric('rejected').count(
  H.events.decisions(approval, { match: d => d.approved === false }),
);
const approvalRate = H.metric('approval-rate').rate(
  H.events.decisions(approval, { match: d => d.approved }),
  H.events.decisions(approval),
);

const safeCategory = H.policy.halt('safe-category-skips-approval', approval, input => {
  const where = { halt: approval, facet: { facet: category, value: input.context.category } };
  const approvals = input.metrics.read(approvedByHuman, { where });
  const rejections = input.metrics.read(rejected, { where });
  if (approvals.samples < 200) return undefined;
  if ((rejections.value ?? 0) > 0) return undefined;
  return { approved: true };
});

const autoApprove = H.trigger('auto-approve-safe-category')
  .on(approval.opened())
  .do(H.ops.resolve(approval).by(safeCategory));

const tasteFromEdits = H.trigger('reviewer-edits-become-taste')
  .on(approval.resolved())
  .when(p => p.resolver === 'human' && typeof p.decision.editedReply === 'string')
  .do(tasteJournal.record(p => ({
    content: { prefer: p.decision.editedReply ?? '', because: p.decision.notes ?? `reviewer edited a ${p.context.category} reply` },
    status: 'candidate',
    when: { kinds: [conversation], roles: [drafterRole] },
  })));

const byTimeToBreach = H.policy.schedule('time-to-breach', input => [
  ...input.of(escalations),
  ...input.of(conversations).slice().sort((a, b) => Date.parse(a.unit.data.slaDue) - Date.parse(b.unit.data.slaDue)),
]);

const reviewer = claudeCode.client('reviewer');
const reviewerGrant = H.grant(
  reviewer,
  H.ops.work.read,
  H.ops.work.write,
  H.ops.resolve(approval),
  H.ops.resolve(costCeiling),
  H.ops.resolve(escalationReview),
  H.ops.memory.write(tasteJournal, experienceJournal),
  H.ops.telemetry.read,
);

export const harness = H.harness('support-triage')
  .ledger(sqlite.ledger('.harness/ledger.db'))
  .pools(pool)
  .lanes(conversations, escalations)
  .journals(tasteJournal, experienceJournal)
  .triggers(slaBreach, customerReplied, customerClosed, autoApprove, tasteFromEdits)
  .scheduler(H.scheduler().policy(byTimeToBreach))
  .grants(reviewerGrant)
  .metrics(approvedByHuman, rejected, approvalRate)
  .observe(observers.board({ path: 'BOARD.md' }), observers.telemetry({ path: 'TELEMETRY.md' }));

void harness.start();
