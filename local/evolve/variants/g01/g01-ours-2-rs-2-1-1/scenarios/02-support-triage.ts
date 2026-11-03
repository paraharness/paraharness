import { z } from 'zod';
import { H } from 'harness-dsl';
import type { Candidate } from 'harness-dsl/kernel';
import { claudeCode } from 'harness-dsl/claude-code';
import { anthropic } from 'harness-dsl/anthropic';
import { sqlite } from 'harness-dsl/sqlite';
import { jsonl } from 'harness-dsl/jsonl';
import { http } from 'harness-dsl/http';
import { rest } from 'harness-dsl/rest';
import { runners } from 'harness-dsl/runners';
import { policies } from 'harness-dsl/policies';
import { observers } from 'harness-dsl/observers';

const fresh = H.state('new').pending();
const sent = H.state('sent').waiting();
const closedByCustomer = H.state('closed-by-customer').terminal('success');
const escalated = H.state('escalated').terminal('failure');

const open = H.state('open').pending();
const handled = H.state('handled').terminal('success');
const unhandled = H.state('unhandled').terminal('failure');

const conversation = z.object({
  id: z.string(),
  customer: z.string(),
  messages: z.array(z.string()),
  latest: z.string(),
  slaDue: z.string(),
  closed: z.boolean(),
});
const escalation = z.object({ conversationId: z.string(), customer: z.string(), reason: z.string() });

const Conversation = H.work('Conversation').schema(conversation).states(fresh, sent, closedByCustomer, escalated);
const Escalation = H.work('Escalation').schema(escalation).states(open, handled, unhandled);

const category = H.facet('category');

const taste = H.memory('taste').content(z.object({ preference: z.string() })).trust('taste').curated();
const experience = H.memory('experience')
  .content(z.object({ do: z.string(), when: z.string(), because: z.string() }))
  .trust('experience');

const haiku = H.model('claude-haiku-4-5').pricing(anthropic.pricing());
const sonnet = H.model('claude-sonnet-4-5').pricing(anthropic.pricing());
const apiAccount = H.account('anthropic-api', anthropic.api({ apiKey: H.env('ANTHROPIC_API_KEY') }));
const apiPool = H.pool('anthropic', [apiAccount]).serves(haiku, sonnet);

const classifierRole = H.role('classifier').prompt('Classify the customer message into one support category.').intents([]);
const drafterRole = H.role('drafter')
  .prompt('Draft a reply to the customer in the house tone.')
  .intents([])
  .recall(taste, experience);

const classifySkill = H.skill('classify')
  .input(z.object({ message: z.string(), history: z.array(z.string()) }))
  .output(z.object({ category: z.string(), urgent: z.boolean() }))
  .prompt(input => `History:\n${input.history.join('\n')}\n\nLatest:\n${input.message}`);
const draftSkill = H.skill('draft-reply')
  .input(z.object({ category: z.string(), messages: z.array(z.string()) }))
  .output(z.object({ reply: z.string() }))
  .prompt(input => `Category: ${input.category}\n\n${input.messages.join('\n---\n')}`);

const classifier = H.seat('classifier').role(classifierRole).skill(classifySkill).models(haiku);
const drafter = H.seat('drafter').role(drafterRole).skill(draftSkill).models(sonnet);

const helpdeskRunner = runners.local({ name: 'helpdesk-cli', slots: 4 }).env({ HELPDESK_TOKEN: H.env('HELPDESK_TOKEN') });

const sendReply = H.command('send-reply')
  .input(z.object({ conversationId: z.string(), text: z.string() }))
  .output(z.object({ messageId: z.string() }))
  .runner(helpdeskRunner)
  .effect('unrepeatable')
  .run(async (input, ctx) => {
    const result = await ctx.exec(['helpdesk', 'reply', input.conversationId], { stdin: input.text });
    if (result.code !== 0) throw new Error(result.stderr);
    return { messageId: result.stdout.trim() };
  });

const replyApproval = H.halt('reply-approval')
  .context(z.object({ category: z.string(), customer: z.string(), draft: z.string() }))
  .decision(z.object({ approved: z.boolean(), reply: z.string().optional() }))
  .ask(context => `Approve this ${context.category} reply to ${context.customer}?\n\n${context.draft}`);

const overBudget = H.halt('conversation-over-budget')
  .context(z.object({ unit: z.string(), spentUsd: z.number(), maxUsd: z.number(), nextStep: z.string() }))
  .decision(z.object({ extraUsd: z.number() }))
  .ask(facts => `Conversation ${facts.unit} spent $${facts.spentUsd.toFixed(2)} of $${facts.maxUsd.toFixed(2)} before ${facts.nextStep}. Grant extra dollars, or 0 to stop.`);

const handleEscalation = H.halt('handle-escalation')
  .context(z.object({ conversationId: z.string(), customer: z.string(), reason: z.string() }))
  .decision(z.object({ resolved: z.boolean(), note: z.string() }))
  .ask(context => `Escalated conversation ${context.conversationId} (${context.customer}): ${context.reason}`);

const approvalRate = H.metric('approval-rate', H.events.decisions(replyApproval).where(event => event.resolver === 'human'))
  .rate(event => event.decision.approved)
  .by(category, 'model')
  .window('90d');

const safeSamples = 200;

const provenCategory = H.policy.decision('auto-approve-proven-category', replyApproval, choice => {
  const record = choice.metrics.read(approvalRate, category.is(choice.context.category));
  return record.samples >= safeSamples && record.value === 1 ? { approved: true } : undefined;
});

const triage = H.flow('triage')
  .input(conversation)
  .step('classify', classifier, state => ({ message: state.input.latest, history: state.input.messages }))
  .tag(category, state => state.classify.category)
  .step('draft', drafter, state => ({ category: state.classify.category, messages: state.input.messages }))
  .halt('approval', replyApproval, state => ({ category: state.classify.category, customer: state.input.customer, draft: state.draft.reply }), { resolver: provenCategory })
  .when(state => !state.approval.approved, refused => refused.exit('rejected'))
  .step('send', sendReply, state => ({ conversationId: state.input.id, text: state.approval.reply ?? state.draft.reply }))
  .exit('sent');

const escalate = H.flow('escalate')
  .input(escalation)
  .halt('handle', handleEscalation, state => ({ conversationId: state.input.conversationId, customer: state.input.customer, reason: state.input.reason }))
  .when(state => !state.handle.resolved, left => left.exit('unhandled'))
  .exit('handled');

const helpdeskUrl = H.env('HELPDESK_URL');
const helpdeskToken = H.env('HELPDESK_TOKEN');

const conversations = H.lane('conversations').of(Conversation)
  .from(
    http.webhook({
      name: 'helpdesk-webhook',
      path: '/helpdesk/events',
      port: H.slot.port(0),
      secret: H.env('HELPDESK_WEBHOOK_SECRET'),
      body: conversation,
      key: body => body.id,
      data: body => body,
    }),
    rest.poll({
      name: 'helpdesk-sweep',
      baseUrl: helpdeskUrl,
      token: helpdeskToken,
      path: '/conversations?status=open',
      interval: '10m',
      item: conversation,
      key: item => item.id,
      data: item => item,
    }),
  )
  .store(rest.store({ name: 'helpdesk', baseUrl: helpdeskUrl, token: helpdeskToken, path: '/conversations', schema: conversation }))
  .handle(triage, {
    exits: { sent, rejected: { to: fresh, atMost: 2, then: escalated } },
    retry: { retries: 2, backoff: { initial: '30s', factor: 2 }, exhausted: escalated },
  })
  .ceiling({ maxUsd: 0.4, onExceed: overBudget });

const escalations = H.lane('escalations').of(Escalation)
  .handle(escalate, {
    exits: { handled, unhandled },
    retry: { retries: 0, exhausted: unhandled },
  });

const breachEscalates = H.trigger('sla-breach-escalates')
  .on(H.time.at(conversations, data => new Date(data.slaDue)).where(event => event.unit.state === fresh.name))
  .do(
    escalations.create(event => ({
      key: `escalation-${event.unit.key}`,
      data: {
        conversationId: event.unit.data.id,
        customer: event.unit.data.customer,
        reason: `SLA breached at ${event.deadline.toISOString()}`,
      },
    })),
    conversations.move(event => event.unit.key, escalated),
  );

const customerReplyRestartsTriage = H.trigger('customer-reply-restarts-triage')
  .on(H.events.updates(conversations).where(event =>
    event.unit.position !== 'terminal' && !event.unit.data.closed && event.unit.data.messages.length > event.previous.messages.length))
  .do(conversations.move(event => event.unit.key, fresh));

const customerClosed = H.trigger('customer-closed-conversation')
  .on(H.events.updates(conversations).where(event => event.unit.data.closed && event.unit.position !== 'terminal'))
  .do(conversations.move(event => event.unit.key, closedByCustomer));

const reviewerEditsBecomeTaste = H.trigger('reviewer-edits-become-taste')
  .on(H.events.decisions(replyApproval).where(event =>
    event.resolver === 'human' && event.decision.reply !== undefined && event.decision.reply !== event.context.draft))
  .do(H.journal('taste').of(taste).record(event => ({
    content: { preference: `Prefer replies like "${event.decision.reply ?? ''}" over "${event.context.draft}".` },
    when: { roles: [drafterRole] },
  })));

const tasteJournal = H.journal('taste').of(taste)
  .store(jsonl.memory('.harness/taste.jsonl'))
  .recall(policies.specificity({ limit: 10 }));
const experienceJournal = H.journal('experience').of(experience)
  .store(jsonl.memory('.harness/experience.jsonl'))
  .recall(policies.specificity({ limit: 6 }));

const soonestBreachFirst = H.policy.units('soonest-breach-first', choice => {
  const deadline = (candidate: Candidate): number =>
    conversations.holds(candidate) ? Date.parse(candidate.data.slaDue) : choice.now.getTime();
  return [...choice.candidates].sort((a, b) => deadline(a) - deadline(b));
});

const reviewer = claudeCode.client({ name: 'reviewer' });

export const supportTriage = H.harness('support-triage')
  .ledger(sqlite.ledger('.harness/ledger.db'))
  .pools(apiPool)
  .lanes(conversations, escalations)
  .journals(tasteJournal, experienceJournal)
  .triggers(breachEscalates, customerReplyRestartsTriage, customerClosed, reviewerEditsBecomeTaste)
  .scheduler(soonestBreachFirst)
  .grants(H.grant(
    reviewer,
    H.ops.work.read,
    H.ops.resolve(replyApproval),
    H.ops.resolve(overBudget),
    H.ops.resolve(handleEscalation),
    H.ops.memory.write(taste),
    H.ops.memory.curate(taste),
    H.ops.memory.write(experience),
    H.ops.telemetry.read,
  ))
  .observe(observers.board({ path: 'BOARD.md' }), observers.telemetry({ path: 'TELEMETRY.md' }));

void supportTriage.start();
