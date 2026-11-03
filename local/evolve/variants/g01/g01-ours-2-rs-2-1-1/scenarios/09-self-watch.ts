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

const category = H.facet('category');
const local = runners.local({ name: 'local', slots: 4 });

const apiAccount = H.account('anthropic-api', anthropic.api({ apiKey: H.env('ANTHROPIC_API_KEY') }));
const haiku = H.model('claude-haiku-4-5').pricing(anthropic.pricing());
const sonnet = H.model('claude-sonnet-4-5').pricing(anthropic.pricing());
const pool = H.pool('support', [apiAccount]).serves(haiku, sonnet).policy(policies.soonestReset());

const taste = H.memory('reply-taste').content(z.object({ rule: z.string() })).trust('taste');
const experience = H.memory('drafting-experience').content(z.object({ rule: z.string() })).trust('experience').curated();
const tasteJournal = H.journal('reply-taste-journal').of(taste).store(jsonl.memory('./.harness/taste.jsonl')).recall(policies.specificity({ limit: 6 }));
const experienceJournal = H.journal('drafting-experience-journal').of(experience).store(jsonl.memory('./.harness/experience.jsonl')).recall(policies.specificity({ limit: 6 }));

const conversationSchema = z.object({ subject: z.string(), message: z.string(), customer: z.string(), slaAt: z.string() });
const fresh = H.state('new').pending();
const sent = H.state('sent').terminal('success');
const closedByCustomer = H.state('closed-by-customer').terminal('neutral');
const escalated = H.state('escalated').terminal('failure');
const failed = H.state('failed').terminal('failure');
const conversation = H.work('Conversation').schema(conversationSchema).states(fresh, sent, closedByCustomer, escalated, failed);

const classifierRole = H.role('classifier').prompt('Name the support category of the conversation.');
const drafterRole = H.role('drafter').prompt('Draft a reply in the house tone.').recall(taste, experience);
const classifySkill = H.skill('classify').input(z.object({ subject: z.string(), message: z.string() })).output(z.object({ category: z.string() }));
const draftSkill = H.skill('draft-reply').input(z.object({ message: z.string(), category: z.string() })).output(z.object({ reply: z.string() }));
const classifier = H.seat('classifier').role(classifierRole).skill(classifySkill).models(haiku);
const drafter = H.seat('drafter').role(drafterRole).skill(draftSkill).models(sonnet);

const approval = H.halt('reply-approval')
  .context(z.object({ category: z.string(), draft: z.string() }))
  .decision(z.object({ approved: z.boolean(), edited: z.string().nullable() }))
  .ask(c => `Approve this ${c.category} reply?`);

const sendReply = H.command('send-reply')
  .input(z.object({ customer: z.string(), text: z.string() }))
  .output(z.object({ messageId: z.string() }))
  .runner(local)
  .effect('unrepeatable')
  .run(async (input, ctx) => {
    const result = await ctx.exec(['helpdesk', 'reply', input.customer], { stdin: input.text });
    return { messageId: result.stdout.trim() };
  });

const handleConversation = H.flow('handle-conversation')
  .input(conversationSchema)
  .step('classify', classifier, s => ({ subject: s.input.subject, message: s.input.message }))
  .tag(category, s => s.classify.category)
  .step('draft', drafter, s => ({ message: s.input.message, category: s.classify.category }))
  .halt('approval', approval, s => ({ category: s.classify.category, draft: s.draft.reply }))
  .when(s => !s.approval.approved, f => f.exit('rejected'))
  .step('send', sendReply, s => ({ customer: s.input.customer, text: s.approval.edited ?? s.draft.reply }))
  .exit('sent');

const helpdeskUrl = H.env('HELPDESK_URL');
const helpdeskToken = H.env('HELPDESK_TOKEN');
const helpdeskItem = z.object({ id: z.string(), subject: z.string(), lastMessage: z.string(), customerEmail: z.string(), slaDueAt: z.string() });

const conversations = H.lane('conversations').of(conversation)
  .from(
    http.webhook({
      name: 'helpdesk-webhook',
      path: '/helpdesk',
      port: H.slot.port(0),
      secret: H.env('HELPDESK_WEBHOOK_SECRET'),
      body: helpdeskItem,
      key: b => b.id,
      data: b => ({ subject: b.subject, message: b.lastMessage, customer: b.customerEmail, slaAt: b.slaDueAt }),
    }),
    rest.poll({
      name: 'helpdesk-poll',
      baseUrl: helpdeskUrl,
      token: helpdeskToken,
      path: '/conversations?status=open',
      interval: '5m',
      item: helpdeskItem,
      key: i => i.id,
      data: i => ({ subject: i.subject, message: i.lastMessage, customer: i.customerEmail, slaAt: i.slaDueAt }),
    }),
  )
  .store(rest.store({ name: 'helpdesk', baseUrl: helpdeskUrl, token: helpdeskToken, path: '/conversations', schema: conversationSchema }))
  .handle(handleConversation, {
    exits: { rejected: { to: fresh, atMost: 2, then: escalated }, sent },
    retry: { retries: 2, backoff: { initial: '30s', factor: 2 }, exhausted: failed },
  })
  .wip(6);

const auditSchema = z.object({ category: z.string(), rate: z.number() });
const auditOpen = H.state('open').pending();
const auditClosed = H.state('closed').terminal('success');
const auditWithdrawn = H.state('withdrawn').terminal('neutral');
const auditAbandoned = H.state('abandoned').terminal('failure');
const audit = H.work('Audit').schema(auditSchema).states(auditOpen, auditClosed, auditWithdrawn, auditAbandoned);

const auditReview = H.halt('audit-review')
  .context(auditSchema)
  .decision(z.object({ findings: z.string() }))
  .ask(c => `Approvals for ${c.category} fell to ${c.rate.toFixed(2)}. What is wrong?`);

const auditFlow = H.flow('audit-category')
  .input(auditSchema)
  .halt('review', auditReview, s => s.input)
  .exit('closed');

const audits = H.lane('audits').of(audit)
  .store(sqlite.store('./.harness/audits.sqlite'))
  .handle(auditFlow, { exits: { closed: auditClosed }, retry: { retries: 0, exhausted: auditAbandoned } });

export const approvalRate = H.metric('approval-rate', H.events.decisions(approval)).rate(e => e.decision.approved).by(category).window('7d');
const approvalSwing = approvalRate.crossing({ below: 0.9, above: 0.95, samples: 50 });

export const modelErrorRate = H.metric('model-error-rate', H.events.invocations()).rate(e => e.error).window('1h');
const errorSwing = modelErrorRate.crossing({ below: 0.05, above: 0.2, samples: 20 });

export const auditsOpened = H.metric('audits-opened', H.events.transitions(audits, { to: auditOpen })).count().by(category).window('calendarMonth');
export const lanePaused = H.metric('conversations-paused', H.events.pauses(conversations)).sum(e => e.durationMs).window('calendarMonth');

const triggers = [
  H.trigger('open-audit-on-approval-drop').on(approvalSwing.down).do(
    audits.create(
      e => ({ key: `audit-${e.facet(category)}-${e.at.toISOString()}`, data: { category: e.facet(category), rate: e.value } }),
      e => [category.is(e.facet(category))],
    ),
    experienceJournal.record(e => ({
      content: { rule: `when drafting for ${e.facet(category)}, recall the stricter phrasing, because approvals fell to ${e.value.toFixed(2)}` },
      when: { roles: [drafterRole], facets: [category.is(e.facet(category))] },
    })),
  ),
  H.trigger('withdraw-audit-on-recovery').on(approvalSwing.up).do(
    audits.move({ state: auditOpen, where: (data, e) => data.category === e.facet(category) }, auditWithdrawn),
  ),
  H.trigger('pause-on-model-errors').on(errorSwing.up).do(
    conversations.pause(e => `model error rate ${e.value.toFixed(2)} over ${e.samples} invocations in the last hour`),
  ),
  H.trigger('resume-on-model-recovery').on(errorSwing.down).do(conversations.resume()),
  H.trigger('sla-breach').on(H.time.at(conversations, d => new Date(d.slaAt))).do(conversations.move(e => e.unit.key, escalated)),
  H.trigger('customer-replied').on(H.events.updates(conversations)).do(conversations.move({ halted: approval, key: e => e.unit.key }, fresh)),
];

const scheduling = H.policy.units('audits-then-time-to-breach', choice => {
  const pausedMs = choice.metrics.read(lanePaused).value ?? 0;
  const conversationsFirst = pausedMs > 30 * 60_000;
  const urgency = (c: Candidate) => {
    if (audits.holds(c)) {
      const opened = choice.metrics.read(auditsOpened, category.is(c.data.category)).value ?? 0;
      return (conversationsFirst ? 1e12 : -1e12) - opened;
    }
    if (conversations.holds(c)) return Date.parse(c.data.slaAt) - choice.now.getTime();
    return 2e12;
  };
  return [...choice.candidates].sort((a, b) => urgency(a) - urgency(b));
});

const reviewer = claudeCode.client({ name: 'reviewer' });

export const harness = H.harness('support-self-watch')
  .ledger(sqlite.ledger('./.harness/ledger.sqlite'))
  .pools(pool)
  .lanes(conversations, audits)
  .journals(tasteJournal, experienceJournal)
  .triggers(...triggers)
  .scheduler(scheduling)
  .grants(H.grant(
    reviewer,
    H.ops.resolve(approval),
    H.ops.resolve(auditReview),
    H.ops.work.read,
    H.ops.work.write,
    H.ops.memory.write(taste),
    H.ops.memory.curate(experience),
    H.ops.telemetry.read,
  ))
  .observe(observers.board({ path: './BOARD.md' }), observers.telemetry({ path: './TELEMETRY.md' }));
