import { z } from 'zod';
import { H } from 'harness-dsl';
import type { Candidate, DeadlineEvent, DecisionEvent, UpdateEvent } from 'harness-dsl/kernel';
import { claudeCode } from 'harness-dsl/claude-code';
import { anthropic } from 'harness-dsl/anthropic';
import { sqlite } from 'harness-dsl/sqlite';
import { jsonl } from 'harness-dsl/jsonl';
import { http } from 'harness-dsl/http';
import { rest } from 'harness-dsl/rest';
import { runners } from 'harness-dsl/runners';
import { policies } from 'harness-dsl/policies';
import { observers } from 'harness-dsl/observers';

const category = H.facet('category');

const fresh = H.state('new').pending();
const classifying = H.state('classifying').pending();
const sent = H.state('sent').terminal('success');
const closedByCustomer = H.state('closed-by-customer').terminal('neutral');
const escalated = H.state('escalated').terminal('failure');

const escalationOpen = H.state('escalation-open').pending();
const escalationHandled = H.state('escalation-handled').terminal('success');
const escalationDropped = H.state('escalation-dropped').terminal('failure');

const conversationSchema = z.object({
  conversationId: z.string(),
  customer: z.string(),
  messages: z.array(z.string()),
  slaDue: z.string(),
  status: z.string(),
});
type Conversation = z.infer<typeof conversationSchema>;
const escalationSchema = z.object({ conversationId: z.string(), reason: z.string() });

const conversation = H.work('conversation').schema(conversationSchema).states(fresh, classifying, sent, closedByCustomer, escalated);
const escalation = H.work('escalation').schema(escalationSchema).states(escalationOpen, escalationHandled, escalationDropped);

const taste = H.memory('reply-taste').content(z.object({ rule: z.string() })).trust('taste');
const experience = H.memory('support-experience').content(z.object({ rule: z.string() })).trust('experience');
const tasteLog = H.journal('reply-taste').of(taste).store(jsonl.memory('memory/taste.jsonl')).recall(policies.specificity({ limit: 10 }));
const experienceLog = H.journal('support-experience')
  .of(experience)
  .store(jsonl.memory('memory/experience.jsonl'))
  .recall(policies.specificity({ limit: 6 }));

const quotaEvents = sqlite.quota('.harness/quota.sqlite');
const apiAccount = H.account('api', anthropic.api({ apiKey: H.env('ANTHROPIC_API_KEY') })).quota(quotaEvents);
const haiku = H.model('claude-haiku-4-5').pricing(anthropic.pricing());
const sonnet = H.model('claude-sonnet-4-5').pricing(anthropic.pricing());
const apiPool = H.pool('support-api', [apiAccount]).serves(haiku, sonnet).policy(policies.soonestReset());

const classifierRole = H.role('classifier').promptFile('prompts/classifier.md');
const drafterRole = H.role('drafter').promptFile('prompts/drafter.md').recall(taste, experience);

const classifySkill = H.skill('classify')
  .input(z.object({ messages: z.array(z.string()) }))
  .output(z.object({ category: z.string() }))
  .prompt(i => i.messages.join('\n---\n'));
const draftSkill = H.skill('draft-reply')
  .input(z.object({ messages: z.array(z.string()), category: z.string() }))
  .output(z.object({ reply: z.string() }))
  .prompt(i => `Category: ${i.category}\n\n${i.messages.join('\n---\n')}`);

const classifier = H.seat('classifier').role(classifierRole).skill(classifySkill).models(haiku);
const drafter = H.seat('drafter').role(drafterRole).skill(draftSkill).models(sonnet);

const approvalContext = z.object({ category: z.string(), customer: z.string(), reply: z.string() });
const approvalDecision = z.object({ approved: z.boolean(), reply: z.string(), edited: z.boolean(), lesson: z.string() });
type ApprovalEvent = DecisionEvent<z.infer<typeof approvalContext>, z.infer<typeof approvalDecision>>;

const approval = H.halt('reply-approval')
  .context(approvalContext)
  .decision(approvalDecision)
  .ask(c => `Send this ${c.category} reply to ${c.customer}?\n\n${c.reply}`);

const conversationBudget = H.halt('conversation-budget')
  .context(z.object({ conversation: z.string(), spentUsd: z.number() }))
  .decision(
    z.discriminatedUnion('action', [
      z.object({ action: z.literal('raise'), extraUsd: z.number() }),
      z.object({ action: z.literal('stop') }),
    ]),
  )
  .ask(c => `Conversation ${c.conversation} has spent $${c.spentUsd.toFixed(2)}. Raise or stop?`);

const escalationReview = H.halt('escalation-review')
  .context(escalationSchema)
  .decision(z.object({ note: z.string() }))
  .ask(c => `Escalated conversation ${c.conversationId}: ${c.reason}`);

const humanApprovalRate = H.metric('human-approval-rate', H.events.decisions(approval).where(e => e.resolver === 'human'))
  .rate(e => e.decision.approved)
  .by(category, 'model')
  .window('90d');

const safeCategory = H.policy.decision('safe-category-auto-approve', approval, choice => {
  const reading = choice.metrics.read(humanApprovalRate, category.is(choice.context.category));
  if (reading.samples >= 200 && reading.value === 1) {
    return { approved: true, reply: choice.context.reply, edited: false, lesson: '' };
  }
  return undefined;
});

const helpdeskRunner = runners.local({ name: 'local', slots: 2 }).env({ HELPDESK_TOKEN: H.env('HELPDESK_TOKEN') });

const sendReply = H.command('send-reply')
  .input(z.object({ conversationId: z.string(), reply: z.string() }))
  .output(z.object({ messageId: z.string() }))
  .runner(helpdeskRunner)
  .effect('unrepeatable')
  .run(async (input, ctx) => {
    const result = await ctx.exec(['./bin/helpdesk-reply', input.conversationId], { stdin: input.reply });
    if (result.code !== 0) throw new Error(result.stderr);
    return { messageId: result.stdout.trim() };
  });

const triage = H.flow('triage')
  .input(conversationSchema)
  .step('classify', classifier, s => ({ messages: s.input.messages }))
  .tag(category, s => s.classify.category)
  .step('draft', drafter, s => ({ messages: s.input.messages, category: s.classify.category }))
  .halt('approval', approval, s => ({ category: s.classify.category, customer: s.input.customer, reply: s.draft.reply }), { resolver: safeCategory })
  .when(s => !s.approval.approved, f => f.exit('rejected'))
  .step('send', sendReply, s => ({ conversationId: s.input.conversationId, reply: s.approval.reply }))
  .exit('sent');

const escalationFlow = H.flow('escalation')
  .input(escalationSchema)
  .halt('review', escalationReview, s => ({ conversationId: s.input.conversationId, reason: s.input.reason }))
  .exit('handled');

const helpdeskUrl = H.env('HELPDESK_URL');
const helpdeskToken = H.env('HELPDESK_TOKEN');

const conversations = H.lane('conversations')
  .of(conversation)
  .from(
    http.webhook({
      name: 'helpdesk-webhook',
      path: '/helpdesk',
      port: H.slot.port(0),
      secret: H.env('HELPDESK_WEBHOOK_SECRET'),
      body: conversationSchema,
      key: b => b.conversationId,
      data: b => b,
      mode: 'upsert',
    }),
    rest.poll({
      name: 'helpdesk-sweep',
      baseUrl: helpdeskUrl,
      token: helpdeskToken,
      path: '/conversations?status=open',
      interval: '10m',
      item: conversationSchema,
      key: c => c.conversationId,
      data: c => c,
      mode: 'upsert',
    }),
  )
  .store(rest.store({ name: 'helpdesk', baseUrl: helpdeskUrl, token: helpdeskToken, path: '/conversations', schema: conversationSchema }))
  .handle(triage, {
    exits: { sent, rejected: { to: classifying, atMost: 2, then: escalated } },
    retry: { retries: 1, backoff: { initial: '30s', factor: 2 }, exhausted: escalated },
  })
  .ceiling({
    maxUsd: 0.4,
    onExceed: conversationBudget,
    context: spent => ({ conversation: spent.unit.key, spentUsd: spent.spentUsd }),
    stopped: escalated,
  });

const escalations = H.lane('escalations')
  .of(escalation)
  .handle(escalationFlow, {
    exits: { handled: escalationHandled },
    retry: { retries: 0, backoff: 'none', exhausted: escalationDropped },
  });

const slaBreach = H.trigger('sla-breach-escalates')
  .on(H.time.at(conversations, d => new Date(d.slaDue)))
  .do(
    escalations.create((e: DeadlineEvent<Conversation>) => ({
      key: `breach-${e.unit.key}`,
      data: { conversationId: e.unit.data.conversationId, reason: `SLA breached at ${e.deadline.toISOString()}` },
    })),
    conversations.move((e: DeadlineEvent<Conversation>) => e.unit.key, escalated),
  );

const customerReplied = H.trigger('customer-reply-reclassifies')
  .on(H.events.updates(conversations).where(e => e.unit.data.messages.length > e.previous.messages.length))
  .do(conversations.move({ halted: approval, key: (e: UpdateEvent<Conversation>) => e.unit.key }, classifying));

const customerClosed = H.trigger('customer-closed')
  .on(H.events.updates(conversations).where(e => e.unit.data.status === 'closed'))
  .do(conversations.move((e: UpdateEvent<Conversation>) => e.unit.key, closedByCustomer));

const reviewerEditsBecomeTaste = H.trigger('reviewer-edits-become-taste')
  .on(H.events.decisions(approval).where(e => e.resolver === 'human' && e.decision.edited && e.decision.lesson.length > 0))
  .do(tasteLog.record((e: ApprovalEvent) => ({ content: { rule: e.decision.lesson }, when: { roles: [drafterRole] } })));

const breachTime = (candidate: Candidate): number =>
  conversations.holds(candidate) ? Date.parse(candidate.data.slaDue) : candidate.queuedAt.getTime();

const timeToBreach = H.policy.units('time-to-breach', choice =>
  [...choice.candidates].sort((a, b) => {
    const aEscalation = a.lane === escalations.name ? 0 : 1;
    const bEscalation = b.lane === escalations.name ? 0 : 1;
    return aEscalation - bEscalation || breachTime(a) - breachTime(b);
  }),
);

const supervisor = claudeCode.client({ name: 'support-supervisor' });

export const supportTriage = H.harness('support-triage')
  .ledger(sqlite.ledger('.harness/ledger.sqlite'))
  .pools(apiPool)
  .lanes(conversations, escalations)
  .journals(tasteLog, experienceLog)
  .triggers(slaBreach, customerReplied, customerClosed, reviewerEditsBecomeTaste)
  .scheduler(timeToBreach)
  .grants(
    H.grant(
      supervisor,
      H.ops.work.read,
      H.ops.resolve(approval),
      H.ops.resolve(conversationBudget),
      H.ops.resolve(escalationReview),
      H.ops.memory.write(taste),
      H.ops.memory.write(experience),
      H.ops.telemetry.read,
    ),
  )
  .observe(observers.board({ path: 'BOARD.md' }), observers.telemetry({ path: 'TELEMETRY.md' }));
