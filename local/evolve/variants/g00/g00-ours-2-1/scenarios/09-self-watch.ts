import { z } from 'zod';
import { H } from 'harness-dsl';
import { claudeCode } from 'harness-dsl/claude-code';
import { anthropic } from 'harness-dsl/anthropic';
import { sqlite } from 'harness-dsl/sqlite';
import { jsonl } from 'harness-dsl/jsonl';
import { http } from 'harness-dsl/http';
import { rest } from 'harness-dsl/rest';
import { policies } from 'harness-dsl/policies';
import { observers } from 'harness-dsl/observers';

const api = H.account('anthropic-api', anthropic.api({ apiKey: H.env('ANTHROPIC_API_KEY') }));
const haiku = H.model('claude-haiku-4-5').pricing(anthropic.pricing());
const sonnet = H.model('claude-sonnet-4-5').pricing(anthropic.pricing());
const pool = H.pool('api', [api]).serves(haiku, sonnet).policy(policies.soonestReset());

const category = H.facet('category');

const taste = H.memory('taste').content(z.object({ rule: z.string() })).trust('taste');
const experience = H.memory('experience').content(z.object({ rule: z.string() })).trust('experience').curated();
const tasteJournal = H.journal('support-taste').of(taste).store(jsonl.memory('./support/taste.jsonl')).recall(policies.specificity({ limit: 8 }));
const experienceJournal = H.journal('support-experience')
  .of(experience)
  .store(jsonl.memory('./support/experience.jsonl'))
  .recall(policies.specificity({ limit: 6 }));

const open = H.state('open').pending();
const handling = H.state('handling').active();
const held = H.state('held').waiting();
const sent = H.state('sent').terminal('success');
const closed = H.state('closed').terminal('neutral');
const escalated = H.state('escalated').terminal('neutral');

const conversationSchema = z.object({
  conversationId: z.string(),
  customer: z.string(),
  message: z.string(),
  slaDueAt: z.string(),
});
const conversation = H.work('Conversation').schema(conversationSchema).states(open, handling, held, sent, closed, escalated);

const auditOpen = H.state('audit-open').pending();
const auditing = H.state('auditing').active();
const auditStalled = H.state('audit-stalled').waiting();
const auditClosed = H.state('audit-closed').terminal('success');
const auditCancelled = H.state('audit-cancelled').terminal('neutral');

const auditSchema = z.object({ category: z.string(), rate: z.number(), samples: z.number() });
const audit = H.work('Audit').schema(auditSchema).states(auditOpen, auditing, auditStalled, auditClosed, auditCancelled);

const escalationOpen = H.state('escalation-open').pending();
const escalationHandling = H.state('escalation-handling').active();
const escalationStalled = H.state('escalation-stalled').waiting();
const escalationResolved = H.state('escalation-resolved').terminal('success');

const escalationSchema = z.object({ conversationId: z.string(), reason: z.string() });
const escalation = H.work('Escalation').schema(escalationSchema).states(escalationOpen, escalationHandling, escalationStalled, escalationResolved);

const approval = H.halt('reply-approval')
  .context(z.object({ conversationId: z.string(), category: z.string(), draft: z.string() }))
  .decision(z.object({ approved: z.boolean(), reply: z.string() }))
  .ask(c => `Approve this ${c.category} reply?\n\n${c.draft}`);

const auditReview = H.halt('audit-review')
  .context(z.object({ category: z.string(), rate: z.number(), samples: z.number() }))
  .decision(z.object({ findings: z.string() }))
  .ask(c => `Approvals for ${c.category} fell to ${c.rate.toFixed(2)} over ${c.samples} samples. What went wrong?`);

const escalationHalt = H.halt('escalation')
  .context(z.object({ conversationId: z.string(), reason: z.string() }))
  .decision(z.object({ resolution: z.string() }))
  .ask(c => `Escalated conversation ${c.conversationId}: ${c.reason}`);

const auditFlow = H.flow('audit')
  .input(auditSchema)
  .tag(category, s => s.input.category)
  .halt('review', auditReview, s => ({ category: s.input.category, rate: s.input.rate, samples: s.input.samples }))
  .exit('closed');

const audits = H.lane('audits')
  .of(audit)
  .store(sqlite.store('./support/audits.sqlite'))
  .handle(auditFlow, {
    exits: { closed: auditClosed },
    retry: { retries: 1, backoff: 'none', exhausted: auditStalled },
  });

const escalationFlow = H.flow('escalation')
  .input(escalationSchema)
  .halt('handle', escalationHalt, s => ({ conversationId: s.input.conversationId, reason: s.input.reason }))
  .exit('resolved');

const escalations = H.lane('escalations')
  .of(escalation)
  .store(sqlite.store('./support/escalations.sqlite'))
  .handle(escalationFlow, {
    exits: { resolved: escalationResolved },
    retry: { retries: 1, backoff: 'none', exhausted: escalationStalled },
  });

const humanApprovals = H.events.decisions(approval).where(e => e.resolver === 'human');

export const approvalRate = H.metric('approval-rate-7d', humanApprovals).rate(e => e.decision.approved).by(category).window('7d');
export const approvalHistory = H.metric('approval-rate-365d', humanApprovals).rate(e => e.decision.approved).by(category).window('365d');
export const auditsOpened = H.metric('audits-opened', H.events.transitions(audits, { to: auditOpen })).count().by(category).window('calendarMonth');

const approvalCrossing = approvalRate.crossing({ below: 0.9, above: 0.95, samples: 50 });

const classifierRole = H.role('classifier').prompt('Classify the customer conversation.').intents(['read']);
const drafterRole = H.role('drafter').prompt('Draft a reply in the house tone.').intents(['read']).recall(taste, experience);

const classifySkill = H.skill('classify')
  .input(z.object({ message: z.string() }))
  .output(z.object({ category: z.string() }))
  .prompt(i => `Classify:\n${i.message}`);
const draftSkill = H.skill('draft-reply')
  .input(z.object({ customer: z.string(), message: z.string(), category: z.string() }))
  .output(z.object({ reply: z.string() }))
  .prompt(i => `Reply to ${i.customer} (${i.category}):\n${i.message}`);

const classifier = H.seat('classifier').role(classifierRole).skill(classifySkill).models(haiku);
const drafter = H.seat('drafter').role(drafterRole).skill(draftSkill).models(sonnet);

const safeCategory = H.policy.decision('safe-category', approval, ({ context, metrics }) => {
  const history = metrics.read(approvalHistory, { category: context.category });
  const auditsThisMonth = metrics.read(auditsOpened, { category: context.category });
  const safe = history.samples >= 200 && history.value === 1 && (auditsThisMonth.value ?? 0) === 0;
  return safe ? { approved: true, reply: context.draft } : undefined;
});

const sendReply = H.command('send-reply')
  .input(z.object({ conversationId: z.string(), reply: z.string() }))
  .output(z.object({ messageId: z.string() }))
  .effect('unrepeatable')
  .detect(async (input, ctx) => {
    const found = await ctx.exec(['helpdesk', 'find-reply', input.conversationId, '--ref', ctx.attempt]);
    return found.code === 0 && found.stdout.trim() ? { messageId: found.stdout.trim() } : undefined;
  })
  .run(async (input, ctx) => {
    const result = await ctx.exec(['helpdesk', 'reply', input.conversationId, '--ref', ctx.attempt], { stdin: input.reply });
    return { messageId: result.stdout.trim() };
  });

const answer = H.flow('answer-conversation')
  .input(conversationSchema)
  .step('classify', classifier, s => ({ message: s.input.message }))
  .tag(category, s => s.classify.category)
  .step('draft', drafter, s => ({ customer: s.input.customer, message: s.input.message, category: s.classify.category }))
  .halt('approval', approval, s => ({ conversationId: s.input.conversationId, category: s.classify.category, draft: s.draft.reply }), {
    resolver: safeCategory,
  })
  .when(s => !s.approval.approved, f => f.exit('rejected'))
  .step('send', sendReply, s => ({ conversationId: s.input.conversationId, reply: s.approval.reply }))
  .exit('sent');

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
      name: 'helpdesk-poll',
      baseUrl: helpdeskUrl,
      token: helpdeskToken,
      path: '/conversations?status=open',
      interval: '5m',
      item: conversationSchema,
      key: c => c.conversationId,
      data: c => c,
      mode: 'upsert',
    }),
  )
  .store(rest.store({ name: 'helpdesk', baseUrl: helpdeskUrl, token: helpdeskToken, path: '/conversations', schema: conversationSchema }))
  .handle(answer, {
    exits: { sent, rejected: { to: open, atMost: 2, then: held } },
    retry: { retries: 2, backoff: { initial: '30s', factor: 2 }, exhausted: held },
  })
  .wip(10);

export const modelErrorRate = H.metric('model-error-rate', H.events.invocations()).rate(e => e.error).window('1h');
const errorCrossing = modelErrorRate.crossing({ below: 0.05, above: 0.2, samples: 20 });

export const conversationsPaused = H.metric('conversations-paused-ms', H.events.pauses(conversations))
  .sum(e => e.durationMs)
  .window('calendarMonth');

const triggers = [
  H.trigger('audit-on-approval-drop')
    .on(approvalCrossing.down)
    .do(
      audits.create(
        e => ({
          key: `audit-${e.key.category}-${e.at.toISOString()}`,
          data: { category: e.key.category, rate: e.value, samples: e.samples },
        }),
        e => [category.is(e.key.category)],
      ),
      experienceJournal.record(e => ({
        content: {
          rule: `when drafting for ${e.key.category}, recall the stricter phrasing, because approvals fell to ${e.value.toFixed(2)}`,
        },
        when: { roles: [drafterRole], facets: [category.is(e.key.category)] },
      })),
    ),
  H.trigger('cancel-audit-on-recovery')
    .on(approvalCrossing.up)
    .do(
      audits.move({ state: auditOpen, where: (data, e) => data.category === e.key.category }, auditCancelled),
      audits.move({ state: auditing, where: (data, e) => data.category === e.key.category }, auditCancelled),
    ),
  H.trigger('pause-on-model-errors')
    .on(errorCrossing.up)
    .do(conversations.pause(e => `model error rate ${e.value.toFixed(3)} over ${e.samples} invocations`)),
  H.trigger('resume-on-model-recovery').on(errorCrossing.down).do(conversations.resume()),
  H.trigger('sla-breach')
    .on(H.time.at(conversations, d => new Date(d.slaDueAt)))
    .do(
      escalations.create(e => ({
        key: `escalation-${e.unit.key}`,
        data: { conversationId: e.unit.data.conversationId, reason: `SLA breached at ${e.deadline.toISOString()}` },
      })),
      conversations.move(e => e.unit.key, escalated),
    ),
];

const order = H.policy.units('time-to-breach', ({ candidates, metrics }) => {
  const paused = metrics.read(conversationsPaused);
  const longPause = (paused.value ?? 0) > 3_600_000;
  const breachAt = (c: (typeof candidates)[number]) =>
    conversations.holds(c) ? new Date(c.data.slaDueAt).getTime() : longPause ? 0 : Number.MAX_SAFE_INTEGER;
  return [...candidates].sort((a, b) => breachAt(a) - breachAt(b));
});

export const harness = H.harness('support')
  .ledger(sqlite.ledger('./support/ledger.sqlite'))
  .pools(pool)
  .lanes(conversations, audits, escalations)
  .journals(tasteJournal, experienceJournal)
  .triggers(...triggers)
  .scheduler(order)
  .grants(
    H.grant(
      claudeCode.client({ name: 'reviewer' }),
      H.ops.work.read,
      H.ops.work.write,
      H.ops.resolve(approval),
      H.ops.resolve(auditReview),
      H.ops.resolve(escalationHalt),
      H.ops.memory.write(taste),
      H.ops.memory.curate(experience),
      H.ops.telemetry.read,
    ),
  )
  .observe(observers.board({ path: './support/BOARD.md' }), observers.telemetry({ path: './support/TELEMETRY.md' }));

export const running = harness.start();
