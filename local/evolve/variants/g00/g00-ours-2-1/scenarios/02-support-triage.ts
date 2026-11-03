import { z } from 'zod';
import { H } from 'harness-dsl';
import { claudeCode } from 'harness-dsl/claude-code';
import { anthropic } from 'harness-dsl/anthropic';
import { sqlite } from 'harness-dsl/sqlite';
import { jsonl } from 'harness-dsl/jsonl';
import { http } from 'harness-dsl/http';
import { rest } from 'harness-dsl/rest';
import { runners } from 'harness-dsl/runners';
import { policies } from 'harness-dsl/policies';
import { observers } from 'harness-dsl/observers';

const conversation = z.object({
  id: z.string(),
  customer: z.string(),
  subject: z.string(),
  messages: z.array(z.string()),
  status: z.string(),
  slaDeadline: z.string(),
});
const escalationCase = z.object({ conversation: z.string(), reason: z.string() });

const fresh = H.state('new').pending();
const handling = H.state('handling').active();
const sent = H.state('sent').waiting();
const closedByCustomer = H.state('closed-by-customer').terminal('success');
const escalated = H.state('escalated').terminal('failure');

const open = H.state('open').pending();
const investigating = H.state('investigating').active();
const settled = H.state('settled').terminal('success');
const stuck = H.state('stuck').waiting();

const Conversation = H.work('conversation').schema(conversation).states(fresh, handling, sent, closedByCustomer, escalated);
const Escalation = H.work('escalation').schema(escalationCase).states(open, investigating, settled, stuck);

const category = H.facet('category');

const replyApproval = H.halt('reply-approval')
  .context(z.object({ category: z.string(), customer: z.string(), draft: z.string() }))
  .decision(z.object({ verdict: z.enum(['approve', 'reject']), reply: z.string(), edited: z.boolean() }))
  .ask(context => `Approve this ${context.category} reply to ${context.customer}?`);
const costCeiling = H.halt('cost-ceiling')
  .context(z.object({ conversation: z.string(), spentUsd: z.number(), maxUsd: z.number(), nextStep: z.string() }))
  .decision(z.object({ continue: z.boolean() }))
  .ask(context => `Conversation ${context.conversation} spent $${context.spentUsd} of $${context.maxUsd}; continue to ${context.nextStep}?`);
const escalationResolution = H.halt('escalation-resolution')
  .context(escalationCase)
  .decision(z.object({ resolution: z.string() }))
  .ask(context => `Resolve escalation for ${context.conversation}: ${context.reason}`);

const taste = H.memory('taste').content(z.object({ rule: z.string() })).trust('taste');
const experience = H.memory('experience').content(z.object({ rule: z.string() })).trust('experience');

const apiAccount = H.account('api', anthropic.api({ apiKey: H.env('ANTHROPIC_API_KEY') }));
const haiku = H.model('claude-haiku-4-5').pricing(anthropic.pricing());
const sonnet = H.model('claude-sonnet-4-5').pricing(anthropic.pricing());

const classifier = H.role('classifier').prompt('Classify the customer conversation into one support category.');
const drafter = H.role('drafter').promptFile('prompts/drafter.md').recall(taste, experience);

const classify = H.skill('classify')
  .input(z.object({ subject: z.string(), messages: z.array(z.string()) }))
  .output(z.object({ category: z.string() }))
  .prompt(input => `${input.subject}\n\n${input.messages.join('\n---\n')}`);
const draftReply = H.skill('draft-reply')
  .input(z.object({ category: z.string(), customer: z.string(), messages: z.array(z.string()) }))
  .output(z.object({ reply: z.string() }))
  .prompt(input => `Draft a ${input.category} reply to ${input.customer}:\n\n${input.messages.join('\n---\n')}`);

const classifierSeat = H.seat('classifier-seat').role(classifier).skill(classify).models(haiku);
const drafterSeat = H.seat('drafter-seat').role(drafter).skill(draftReply).models(sonnet);

const helpdeskRunner = runners.local({ name: 'helpdesk-runner', slots: 4 }).env({ HELPDESK_TOKEN: H.env('HELPDESK_TOKEN') });

const sendReply = H.command('send-reply')
  .input(z.object({ conversation: z.string(), reply: z.string() }))
  .output(z.object({ messageId: z.string() }))
  .runner(helpdeskRunner)
  .effect('unrepeatable')
  .run(async (input, ctx) => {
    const result = await ctx.exec(
      ['sh', '-c', `curl -fsS -X POST -H "Authorization: Bearer $HELPDESK_TOKEN" --data-binary @- https://helpdesk.example.com/api/conversations/${input.conversation}/replies`],
      { stdin: JSON.stringify({ body: input.reply }) },
    );
    if (result.code !== 0) throw new Error(result.stderr);
    return { messageId: result.stdout.trim() };
  });

const humanDecisions = H.events.decisions(replyApproval).where(event => event.resolver === 'human');
const approvalRate = H.metric('approval-rate', humanDecisions)
  .rate(event => event.decision.verdict === 'approve')
  .by(category, 'model')
  .window('30d');
const approvalHistory = H.metric('approval-history', humanDecisions)
  .rate(event => event.decision.verdict === 'approve')
  .by(category)
  .window('365d');

const autoApproveSafeCategory = H.policy.decision('auto-approve-safe-category', replyApproval, choice => {
  const history = choice.metrics.read(approvalHistory, { category: choice.context.category });
  const safe = history.samples >= 200 && history.value === 1;
  return safe ? { verdict: 'approve', reply: choice.context.draft, edited: false } : undefined;
});

const triage = H.flow('triage')
  .input(conversation)
  .step('classify', classifierSeat, state => ({ subject: state.input.subject, messages: state.input.messages }))
  .tag(category, state => state.classify.category)
  .step('draft', drafterSeat, state => ({ category: state.classify.category, customer: state.input.customer, messages: state.input.messages }))
  .halt('approval', replyApproval, state => ({ category: state.classify.category, customer: state.input.customer, draft: state.draft.reply }), { resolver: autoApproveSafeCategory })
  .when(state => state.approval.verdict === 'reject', rejected => rejected.exit('rejected'))
  .step('send', sendReply, state => ({ conversation: state.input.id, reply: state.approval.reply }))
  .exit('sent');

const humanEscalation = H.flow('human-escalation')
  .input(escalationCase)
  .halt('resolution', escalationResolution, state => state.input)
  .exit('settled');

const helpdeskUrl = 'https://helpdesk.example.com/api';
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
      mode: 'upsert',
    }),
    rest.poll({
      name: 'helpdesk-catch-up',
      baseUrl: helpdeskUrl,
      token: helpdeskToken,
      path: '/conversations',
      interval: '10m',
      item: conversation,
      key: item => item.id,
      data: item => item,
      mode: 'upsert',
    }),
  )
  .store(rest.store({ name: 'helpdesk', baseUrl: helpdeskUrl, token: helpdeskToken, path: '/conversations', schema: conversation }))
  .handle(triage, {
    exits: { sent, rejected: { to: fresh, atMost: 2, then: escalated } },
    retry: { retries: 2, backoff: { initial: '30s', factor: 2 }, exhausted: escalated },
  })
  .ceiling({
    maxUsd: 0.4,
    onExceed: costCeiling,
    context: spent => ({ conversation: spent.unit.key, spentUsd: spent.spentUsd, maxUsd: spent.maxUsd, nextStep: spent.nextStep }),
  });

const escalations = H.lane('escalations').of(Escalation)
  .handle(humanEscalation, {
    exits: { settled },
    retry: { retries: 0, backoff: 'none', exhausted: stuck },
  });

const slaBreachEscalates = H.trigger('sla-breach-escalates')
  .on(H.time.at(conversations, data => new Date(data.slaDeadline)).where(event => event.unit.position !== 'terminal'))
  .do(
    escalations.create(event => ({
      key: `escalation-${event.unit.key}`,
      data: { conversation: event.unit.key, reason: `SLA breached at ${event.deadline.toISOString()}` },
    })),
    conversations.move(event => event.unit.key, escalated),
  );

const customerReplyReclassifies = H.trigger('customer-reply-reclassifies')
  .on(H.events.updates(conversations).where(event =>
    event.unit.data.messages.length > event.previous.messages.length &&
    (event.unit.state === handling.name || event.unit.state === sent.name)))
  .do(conversations.move(event => event.unit.key, fresh));

const customerClosed = H.trigger('customer-closed')
  .on(H.events.updates(conversations).where(event => event.unit.data.status === 'closed' && event.unit.position !== 'terminal'))
  .do(conversations.move(event => event.unit.key, closedByCustomer));

const escalationsThenTimeToBreach = H.policy.units('escalations-then-time-to-breach', choice => {
  const breachAt = (candidate: (typeof choice.candidates)[number]) =>
    conversations.holds(candidate) ? Date.parse(candidate.data.slaDeadline) : 0;
  return [...choice.candidates].sort((a, b) => breachAt(a) - breachAt(b));
});

const reviewer = claudeCode.client({ name: 'reviewer' });

export const harness = H.harness('support-triage')
  .ledger(sqlite.ledger('.harness/ledger.sqlite'))
  .pools(H.pool('api', [apiAccount]).serves(haiku, sonnet))
  .lanes(conversations, escalations)
  .journals(
    H.journal('taste-journal').of(taste).store(jsonl.memory('.harness/taste.jsonl')).recall(policies.specificity({ limit: 10 })),
    H.journal('experience-journal').of(experience).store(jsonl.memory('.harness/experience.jsonl')).recall(policies.specificity({ limit: 6 })),
  )
  .triggers(slaBreachEscalates, customerReplyReclassifies, customerClosed)
  .scheduler(escalationsThenTimeToBreach)
  .grants(H.grant(
    reviewer,
    H.ops.work.read,
    H.ops.resolve(replyApproval),
    H.ops.resolve(costCeiling),
    H.ops.resolve(escalationResolution),
    H.ops.memory.write(taste),
    H.ops.memory.write(experience),
    H.ops.telemetry.read,
  ))
  .observe(observers.board({ path: 'BOARD.md' }), observers.telemetry({ path: 'TELEMETRY.md' }));

export const readsApprovalRate = approvalRate;
export default harness;
