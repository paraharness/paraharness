import { z } from 'zod';
import { H } from 'harness-dsl';
import type { Candidate } from 'harness-dsl/kernel';
import { anthropic } from 'harness-dsl/anthropic';
import { claudeCode } from 'harness-dsl/claude-code';
import { sqlite } from 'harness-dsl/sqlite';
import { jsonl } from 'harness-dsl/jsonl';
import { http } from 'harness-dsl/http';
import { rest } from 'harness-dsl/rest';
import { policies } from 'harness-dsl/policies';
import { observers } from 'harness-dsl/observers';

const helpdesk = { baseUrl: H.env('HELPDESK_URL'), token: H.env('HELPDESK_TOKEN') };

const api = H.account('api', anthropic.api({ apiKey: H.env('ANTHROPIC_API_KEY') }));
const haiku = H.model('claude-haiku-4-5').pricing(anthropic.pricing());
const sonnet = H.model('claude-sonnet-4-5').pricing(anthropic.pricing());
const opus = H.model('claude-opus-4-1').pricing(anthropic.pricing());
const pool = H.pool('support', [api]).serves(haiku, sonnet, opus);

const category = H.facet('category');

const taste = H.memory('taste').content(z.object({ text: z.string() })).trust('taste');
const experience = H.memory('experience').content(z.object({ text: z.string() })).trust('experience').curated();
const tasteJournal = H.journal('support-taste').of(taste).store(jsonl.memory('.harness/taste.jsonl')).recall(policies.specificity());
const experienceJournal = H.journal('support-experience').of(experience).store(jsonl.memory('.harness/experience.jsonl')).recall(policies.specificity());

const conversation = z.object({
  conversationId: z.string(),
  customer: z.string(),
  messages: z.array(z.string()),
  status: z.enum(['open', 'closed']),
  slaDeadline: z.string(),
});
const fresh = H.state('new').pending();
const sent = H.state('sent').terminal('success');
const closed = H.state('closed-by-customer').terminal('neutral');
const escalated = H.state('escalated').terminal('failure');
const conversationKind = H.work('Conversation').schema(conversation).states(fresh, sent, closed, escalated);

const auditData = z.object({ category: z.string(), rate: z.number(), samples: z.number() });
const auditOpen = H.state('open').pending();
const auditClosed = H.state('closed').terminal('success');
const auditCancelled = H.state('recovered').terminal('neutral');
const auditKind = H.work('Audit').schema(auditData).states(auditOpen, auditClosed, auditCancelled);

const approval = H.halt('approval')
  .context(z.object({ category: z.string(), reply: z.string() }))
  .decision(z.object({ approved: z.boolean(), reply: z.string().optional() }))
  .ask(context => `Approve this ${context.category} reply?\n\n${context.reply}`);
const auditReview = H.halt('audit-review')
  .context(z.object({ category: z.string(), rate: z.number(), samples: z.number() }))
  .decision(z.object({ findings: z.string() }))
  .ask(context => `Approvals for ${context.category} fell to ${context.rate.toFixed(2)} over ${context.samples} samples.`);

const auditFlow = H.flow('audit-category')
  .input(auditData)
  .halt('review', auditReview, state => ({ category: state.input.category, rate: state.input.rate, samples: state.input.samples }))
  .exit('closed');

const audits = H.lane('audits')
  .of(auditKind)
  .store(sqlite.store('.harness/support.db'))
  .handle(auditFlow, { exits: { closed: auditClosed }, retry: { retries: 0, backoff: 'none', exhausted: auditCancelled } });

const approvals7d = H.metric('approval-rate-7d', H.events.decisions(approval))
  .rate(event => event.decision.approved)
  .by(category)
  .window('7d');
const approvalsAllTime = H.metric('approval-rate-year', H.events.decisions(approval))
  .rate(event => event.decision.approved)
  .by(category, 'model')
  .window('365d');
const modelErrors = H.metric('model-error-rate', H.events.invocations())
  .rate(event => event.error)
  .window('1h');
const auditsOpened = H.metric('audits-opened', H.events.transitions(audits, { to: auditOpen }))
  .count()
  .by(category)
  .window('calendarMonth');
const pausedThisMonth = H.metric('conversations-paused-ms', H.events.pauses())
  .sum(event => event.durationMs)
  .by('lane')
  .window('calendarMonth');

const approvalCrossing = approvals7d.crossing({ below: 0.9, above: 0.95, samples: 50 });
const errorCrossing = modelErrors.crossing({ below: 0.05, above: 0.2, samples: 20 });

const safeCategory = H.policy.decision('safe-category', approval, choice => {
  const history = choice.metrics.read(approvalsAllTime, category.is(choice.context.category));
  const audited = choice.metrics.read(auditsOpened, category.is(choice.context.category));
  const safe = history.samples >= 200 && history.value === 1 && (audited.value ?? 0) === 0;
  return safe ? { approved: true } : undefined;
});

const classifierRole = H.role('classifier').prompt('Classify the customer conversation into one support category.');
const drafterRole = H.role('drafter').promptFile('prompts/drafter.md').recall(taste, experience);

const classify = H.skill('classify')
  .input(z.object({ messages: z.array(z.string()) }))
  .output(z.object({ category: z.string(), summary: z.string() }))
  .prompt(input => input.messages.join('\n---\n'));
const draftReply = H.skill('draft-reply')
  .input(z.object({ category: z.string(), messages: z.array(z.string()) }))
  .output(z.object({ reply: z.string() }))
  .prompt(input => `Category: ${input.category}\n\n${input.messages.join('\n---\n')}`);

let conversationsLaneName = 'conversations';

const stableDrafter = H.policy.models('drafter-stability', choice => {
  const paused = choice.metrics.read(pausedThisMonth, conversations);
  return (paused.value ?? 0) > 60 * 60 * 1000 ? [sonnet, opus] : [opus, sonnet];
});

const classifier = H.seat('classifier').role(classifierRole).skill(classify).models(haiku);
const drafter = H.seat('drafter').role(drafterRole).skill(draftReply).models(opus, sonnet).policy(stableDrafter);

const sendReply = H.command('send-reply')
  .input(z.object({ conversationId: z.string(), reply: z.string() }))
  .output(z.object({ messageId: z.string() }))
  .effect('unrepeatable')
  .detect(async (input, ctx) => {
    const found = await ctx.exec(['./bin/helpdesk', 'find-reply', input.conversationId, ctx.attempt]);
    return found.code === 0 ? { messageId: found.stdout.trim() } : undefined;
  })
  .run(async (input, ctx) => {
    const posted = await ctx.exec(['./bin/helpdesk', 'reply', input.conversationId, ctx.attempt], { stdin: input.reply });
    return { messageId: posted.stdout.trim() };
  });

const handleConversation = H.flow('handle-conversation')
  .input(conversation)
  .step('classify', classifier, state => ({ messages: state.input.messages }))
  .tag(category, state => state.classify.category)
  .step('draft', drafter, state => ({ category: state.classify.category, messages: state.input.messages }))
  .halt('approval', approval, state => ({ category: state.classify.category, reply: state.draft.reply }), { resolver: safeCategory })
  .when(state => state.approval.approved === false, flow => flow.exit('rejected'))
  .step('send', sendReply, state => ({ conversationId: state.input.conversationId, reply: state.approval.reply ?? state.draft.reply }))
  .exit('sent');

const conversations = H.lane('conversations')
  .of(conversationKind)
  .from(
    http.webhook({ name: 'helpdesk-webhook', path: '/helpdesk', port: H.slot.port(0), secret: H.env('HELPDESK_SECRET'), body: conversation, key: body => body.conversationId, data: body => body }),
    rest.poll({ name: 'helpdesk-poll', ...helpdesk, path: '/conversations?status=open', interval: '5m', item: conversation, key: item => item.conversationId, data: item => item }),
  )
  .store(rest.store({ name: 'helpdesk', ...helpdesk, path: '/conversations', schema: conversation }))
  .handle(handleConversation, {
    exits: { sent, rejected: { to: fresh, atMost: 2, then: escalated } },
    retry: { retries: 2, backoff: { initial: '30s', factor: 2 }, exhausted: escalated },
  });

conversationsLaneName = conversations.name;

const openAudit = H.trigger('open-audit-on-approval-drop')
  .on(approvalCrossing.down)
  .do(
    audits.create(
      event => ({
        key: `audit-${event.key.category}-${event.at.toISOString()}`,
        data: { category: event.key.category, rate: event.value, samples: event.samples },
      }),
      event => [category.is(event.key.category)],
    ),
    experienceJournal.record(event => ({
      content: { text: `when drafting for ${event.key.category}, recall the stricter phrasing, because approvals fell to ${event.value.toFixed(2)}` },
      when: { roles: [drafterRole], facets: [category.is(event.key.category)] },
    })),
  );

const cancelAudit = H.trigger('cancel-audit-on-recovery')
  .on(approvalCrossing.up)
  .do(audits.move({ state: auditOpen, where: (data, event) => data.category === event.key.category }, auditCancelled));

const pauseOnErrors = H.trigger('pause-on-model-errors')
  .on(errorCrossing.up)
  .do(conversations.pause(event => `model error rate ${event.value.toFixed(2)} over ${event.samples} invocations`));

const resumeOnRecovery = H.trigger('resume-on-model-recovery')
  .on(errorCrossing.down)
  .do(conversations.resume());

const slaBreach = H.trigger('sla-breach')
  .on(H.time.at(conversations, data => new Date(data.slaDeadline)))
  .do(conversations.move(event => event.unit.key, escalated));

const customerReplied = H.trigger('customer-replied')
  .on(H.events.updates(conversations).where(event => event.unit.data.status === 'open' && event.unit.data.messages.length > event.previous.messages.length))
  .do(conversations.move(event => event.unit.key, fresh));

const customerClosed = H.trigger('customer-closed')
  .on(H.events.updates(conversations).where(event => event.unit.data.status === 'closed'))
  .do(conversations.move(event => event.unit.key, closed));

const breachAt = (candidate: Candidate): number =>
  conversations.holds(candidate) ? new Date(candidate.data.slaDeadline).getTime() : Number.POSITIVE_INFINITY;

const timeToBreach = H.policy.units('audits-then-time-to-breach', choice =>
  [...choice.candidates].sort((a, b) => {
    const auditFirst = Number(b.lane === audits.name) - Number(a.lane === audits.name);
    return auditFirst || breachAt(a) - breachAt(b);
  }),
);

const reviewer = claudeCode.client({ name: 'reviewer' });

export const harness = H.harness('support')
  .ledger(sqlite.ledger('.harness/support-ledger.db'))
  .pools(pool)
  .lanes(conversations, audits)
  .journals(tasteJournal, experienceJournal)
  .triggers(openAudit, cancelAudit, pauseOnErrors, resumeOnRecovery, slaBreach, customerReplied, customerClosed)
  .metrics(approvals7d, approvalsAllTime, modelErrors, auditsOpened, pausedThisMonth)
  .scheduler(timeToBreach)
  .grants(H.grant(
    reviewer,
    H.ops.work.read,
    H.ops.work.write,
    H.ops.resolve(approval),
    H.ops.resolve(auditReview),
    H.ops.memory.write(taste),
    H.ops.memory.curate(experience),
    H.ops.telemetry.read,
  ))
  .observe(observers.board({ path: '.harness/board.md' }), observers.telemetry({ path: '.harness/telemetry.md' }));

export const watchedLane = conversationsLaneName;
