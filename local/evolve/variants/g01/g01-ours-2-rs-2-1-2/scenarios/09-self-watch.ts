import { z } from 'zod';
import { H } from 'harness-dsl';
import { anthropic } from 'harness-dsl/anthropic';
import { claudeCode } from 'harness-dsl/claude-code';
import { sqlite } from 'harness-dsl/sqlite';
import { jsonl } from 'harness-dsl/jsonl';
import { http } from 'harness-dsl/http';
import { rest } from 'harness-dsl/rest';
import { policies } from 'harness-dsl/policies';
import { observers } from 'harness-dsl/observers';

const api = H.account('anthropic-api', anthropic.api({ apiKey: H.env('ANTHROPIC_API_KEY') }));
const haiku = H.model('claude-haiku-4-5').pricing(anthropic.pricing());
const sonnet = H.model('claude-sonnet-4-5').pricing(anthropic.pricing());

const category = H.resource('category');

const taste = H.memory('taste').content(z.object({ rule: z.string(), because: z.string() })).trust('taste');
const experience = H.memory('experience')
  .content(z.object({ situation: z.string(), action: z.string(), because: z.string() }))
  .trust('experience')
  .curated();

const conversationSchema = z.object({
  id: z.string(),
  customer: z.string(),
  messages: z.array(z.string()),
  slaDeadline: z.string(),
});
const fresh = H.state('new').pending();
const sent = H.state('sent').terminal('success');
const closedByCustomer = H.state('closed-by-customer').terminal('neutral');
const escalated = H.state('escalated').terminal('neutral');
const conversation = H.work('Conversation').schema(conversationSchema).states(fresh, sent, closedByCustomer, escalated);

const classifier = H.role('classifier').promptFile('./prompts/classifier.md');
const drafter = H.role('drafter').promptFile('./prompts/drafter.md').recall(taste, experience);

const classify = H.skill('classify')
  .input(z.object({ messages: z.array(z.string()) }))
  .output(z.object({ category: z.string() }))
  .prompt(i => `Classify this conversation:\n${i.messages.join('\n---\n')}`);
const draftReply = H.skill('draft-reply')
  .input(z.object({ category: z.string(), messages: z.array(z.string()) }))
  .output(z.object({ reply: z.string() }))
  .prompt(i => `Draft a ${i.category} reply to:\n${i.messages.join('\n---\n')}`);

const classifierSeat = H.seat('classifier').role(classifier).skill(classify).models(haiku);
const drafterSeat = H.seat('drafter').role(drafter).skill(draftReply).models(sonnet);

const replyApproval = H.halt('reply-approval')
  .context(z.object({ category: z.string(), reply: z.string() }))
  .decision(z.object({ approved: z.boolean(), editedReply: z.string().optional() }));

const sendReply = H.command('send-reply')
  .input(z.object({ conversation: z.string(), reply: z.string() }))
  .output(z.object({ messageId: z.string() }))
  .effect('unrepeatable')
  .run(async (input, ctx) => {
    const posted = await ctx.exec(['helpdesk', 'reply', input.conversation], { stdin: input.reply });
    return { messageId: posted.stdout.trim() };
  });

const triage = H.flow('triage')
  .input(conversationSchema)
  .step('classify', classifierSeat, s => ({ messages: s.input.messages }))
  .tag(category, s => s.classify.category)
  .step('draft', drafterSeat, s => ({ category: s.classify.category, messages: s.input.messages }))
  .halt('approval', replyApproval, s => ({ category: s.classify.category, reply: s.draft.reply }))
  .when(s => !s.approval.approved, f => f.exit('rejected'))
  .step('send', sendReply, s => ({ conversation: s.input.id, reply: s.approval.editedReply ?? s.draft.reply }))
  .exit('sent');

const conversations = H.lane('conversations')
  .of(conversation)
  .from(
    http.webhook({ name: 'helpdesk-push', path: '/helpdesk', port: H.slot.port(0), secret: H.env('HELPDESK_SECRET'), body: conversationSchema, key: b => b.id, data: b => b, mode: 'upsert' }),
    rest.poll({ name: 'helpdesk-sweep', baseUrl: H.env('HELPDESK_URL'), token: H.env('HELPDESK_TOKEN'), path: '/conversations?status=open', interval: '5m', item: conversationSchema, key: i => i.id, data: i => i, mode: 'upsert' }),
  )
  .store(rest.store({ name: 'helpdesk', baseUrl: H.env('HELPDESK_URL'), token: H.env('HELPDESK_TOKEN'), path: '/conversations', schema: conversationSchema }))
  .handle(triage, {
    exits: { sent, rejected: { to: fresh, atMost: 3, then: escalated } },
    retry: { retries: 2, backoff: { initial: '30s', factor: 2 }, exhausted: escalated },
  })
  .wip(6);

const escalationSchema = z.object({ conversation: z.string(), reason: z.string() });
const escalationOpen = H.state('escalation-open').pending();
const escalationHandled = H.state('escalation-handled').terminal('success');
const escalationAbandoned = H.state('escalation-abandoned').terminal('failure');
const escalation = H.work('Escalation').schema(escalationSchema).states(escalationOpen, escalationHandled, escalationAbandoned);
const escalationHandling = H.halt('escalation-handling')
  .context(escalationSchema)
  .decision(z.object({ resolution: z.string() }));
const escalationFlow = H.flow('escalation')
  .input(escalationSchema)
  .halt('handling', escalationHandling, s => s.input)
  .exit('handled');
const escalations = H.lane('escalations')
  .of(escalation)
  .store(sqlite.store('./.harness/units.sqlite'))
  .handle(escalationFlow, {
    exits: { handled: escalationHandled },
    retry: { retries: 0, backoff: 'none', exhausted: escalationAbandoned },
  });

const auditSchema = z.object({ category: z.string(), rate: z.number(), samples: z.number() });
const auditOpen = H.state('audit-open').pending();
const auditDone = H.state('audit-done').terminal('success');
const auditWithdrawn = H.state('audit-withdrawn').terminal('neutral');
const audit = H.work('Audit').schema(auditSchema).states(auditOpen, auditDone, auditWithdrawn);
const auditReview = H.halt('audit-review')
  .context(auditSchema)
  .decision(z.object({ findings: z.string() }));
const auditFlow = H.flow('audit')
  .input(auditSchema)
  .halt('review', auditReview, s => s.input)
  .exit('done');
const audits = H.lane('audits')
  .of(audit)
  .store(sqlite.store('./.harness/units.sqlite'))
  .handle(auditFlow, {
    exits: { done: auditDone },
    retry: { retries: 0, backoff: 'none', exhausted: auditWithdrawn },
  });

const drafterLessons = H.journal('drafter-lessons')
  .of(experience)
  .store(jsonl.memory('./.harness/experience.jsonl'))
  .recall(policies.specificity({ limit: 8 }));
const ownerTaste = H.journal('owner-taste')
  .of(taste)
  .store(jsonl.memory('./.harness/taste.jsonl'))
  .recall(policies.specificity({ limit: 12 }));

const approvalRate = H.metric('approval-rate', H.events.decisions(replyApproval).where(e => e.resolver === 'human'))
  .rate(e => e.decision.approved)
  .by(category)
  .window('7d');
const approvalSwing = approvalRate.crossing({ below: 0.9, above: 0.95, samples: 50 });

const modelErrorRate = H.metric('model-error-rate', H.events.invocations())
  .rate(e => e.error)
  .window('1h');
const errorSwing = modelErrorRate.crossing({ below: 0.05, above: 0.2, samples: 20 });

const auditsOpened = H.metric('audits-opened', H.events.transitions(audits, { to: auditOpen }))
  .count()
  .by(category)
  .window('calendarMonth');
const lanePausedMs = H.metric('conversations-paused', H.events.pauses(conversations))
  .sum(e => e.durationMs)
  .window('calendarMonth');

const triggers = [
  H.trigger('approval-fell')
    .on(approvalSwing.down)
    .do(
      audits.create(
        e => ({ key: `audit-${e.of(category)}-${e.at.toISOString()}`, data: { category: e.of(category), rate: e.value, samples: e.samples } }),
        e => [category.is(e.of(category))],
      ),
      drafterLessons.record(e => ({
        content: {
          situation: `when drafting for ${e.of(category)}`,
          action: 'recall the stricter phrasing',
          because: `approvals fell to ${e.value.toFixed(2)} over ${e.samples} samples`,
        },
        when: { roles: [drafter], resources: [category.is(e.of(category))] },
      })),
    ),
  H.trigger('approval-recovered')
    .on(approvalSwing.up)
    .do(audits.cancel({ state: auditOpen, where: (data, e) => data.category === e.of(category) }, auditWithdrawn)),
  H.trigger('model-errors-high')
    .on(errorSwing.up)
    .do(conversations.pause(e => `model error rate ${e.value.toFixed(2)} over ${e.samples} invocations`)),
  H.trigger('model-errors-recovered')
    .on(errorSwing.down)
    .do(conversations.resume()),
  H.trigger('sla-breach')
    .on(H.time.at(conversations, d => new Date(d.slaDeadline)))
    .do(
      escalations.create(e => ({ key: `escalation-${e.unit.key}`, data: { conversation: e.unit.key, reason: `SLA breached at ${e.deadline.toISOString()}` } })),
      conversations.cancel(e => e.unit.key, escalated),
    ),
  H.trigger('customer-replied-during-approval')
    .on(H.events.updates(conversations))
    .do(conversations.cancel({ halted: replyApproval, key: e => e.unit.key }, fresh)),
];

const selfAware = H.policy.units('time-to-breach', c => {
  const paused = c.metrics.read(lanePausedMs);
  const pausedLong = (paused.value ?? 0) > 60 * 60 * 1000;
  const urgent = c.candidates.filter(escalations.holds);
  const openAudits = c.candidates
    .filter(audits.holds)
    .sort((a, b) => (c.metrics.read(auditsOpened, category.is(b.data.category)).value ?? 0) - (c.metrics.read(auditsOpened, category.is(a.data.category)).value ?? 0));
  const waiting = c.candidates
    .filter(conversations.holds)
    .sort((a, b) => Date.parse(a.data.slaDeadline) - Date.parse(b.data.slaDeadline));
  return pausedLong ? [...urgent, ...openAudits, ...waiting] : [...urgent, ...waiting, ...openAudits];
});

const pool = H.pool('api', [api]).serves(haiku, sonnet).policy(policies.soonestReset());

export const support = H.harness('support')
  .ledger(sqlite.ledger('./.harness/ledger.sqlite'))
  .pools(pool)
  .lanes(conversations, escalations, audits)
  .journals(drafterLessons, ownerTaste)
  .triggers(...triggers)
  .scheduler(selfAware)
  .grants(
    H.grant(
      claudeCode.client({ name: 'reviewer' }),
      H.ops.resolve(replyApproval),
      H.ops.resolve(auditReview),
      H.ops.resolve(escalationHandling),
      H.ops.work.read,
      H.ops.work.write,
      H.ops.memory.write(taste),
      H.ops.memory.curate(experience),
      H.ops.telemetry.read,
    ),
  )
  .observe(observers.board({ path: './BOARD.md' }), observers.telemetry({ path: './TELEMETRY.md' }));
