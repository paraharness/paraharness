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
const replied = H.state('sent').waiting();
const closedByCustomer = H.state('closed-by-customer').terminal('success');
const escalated = H.state('escalated').terminal('failure');
const opened = H.state('opened').pending();
const handled = H.state('handled').terminal('success');
const unhandled = H.state('unhandled').terminal('failure');

const conversationSchema = z.object({
  id: z.string(),
  customer: z.string(),
  subject: z.string(),
  lastMessage: z.string(),
  lastMessageId: z.string(),
  status: z.enum(['open', 'closed']),
  slaDue: z.string(),
});
const escalationSchema = z.object({ conversationId: z.string(), customer: z.string(), reason: z.string() });

const conversation = H.work('Conversation').schema(conversationSchema).states(fresh, replied, closedByCustomer, escalated);
const escalation = H.work('Escalation').schema(escalationSchema).states(opened, handled, unhandled);

const category = H.resource('category');

const taste = H.memory('reply-taste').content(z.object({ rule: z.string() })).trust('taste').curated();
const experience = H.memory('support-experience').content(z.object({ rule: z.string() })).trust('experience');
const tasteJournal = H.journal('reply-taste').of(taste).store(jsonl.memory('.harness/taste.jsonl')).recall(policies.specificity({ limit: 10 }));
const experienceJournal = H.journal('support-experience').of(experience).store(jsonl.memory('.harness/experience.jsonl')).recall(policies.specificity({ limit: 8 }));

const api = H.account('api', anthropic.api({ apiKey: H.env('ANTHROPIC_API_KEY') })).quota(sqlite.quota('.harness/quota.db'));
const haiku = H.model('claude-haiku-4-5').pricing(anthropic.pricing());
const sonnet = H.model('claude-sonnet-4-5').pricing(anthropic.pricing());
const pool = H.pool('anthropic', [api]).share(api, 1).serves(haiku, sonnet);

const classifyMessage = H.skill('classify-message')
  .input(z.object({ subject: z.string(), message: z.string() }))
  .output(z.object({ category: z.string() }))
  .prompt(i => `Subject: ${i.subject}\n\n${i.message}\n\nName the support category.`);
const draftReply = H.skill('draft-reply')
  .input(z.object({ category: z.string(), customer: z.string(), message: z.string() }))
  .output(z.object({ reply: z.string() }))
  .prompt(i => `Draft a reply to ${i.customer} about a ${i.category} question:\n\n${i.message}`);

const classifierRole = H.role('classifier').prompt('You sort support conversations into exactly one category.');
const drafterRole = H.role('drafter').prompt('You draft replies a human will approve before sending.').recall(taste, experience);

const classifier = H.seat('classifier').role(classifierRole).skill(classifyMessage).models(haiku);
const drafter = H.seat('drafter').role(drafterRole).skill(draftReply).models(sonnet);

const replyApproval = H.halt('reply-approval')
  .context(z.object({ category: z.string(), draft: z.string() }))
  .decision(z.object({ approved: z.boolean(), edited: z.string().optional() }))
  .ask(c => `Approve this ${c.category} reply?\n\n${c.draft}`);
const costCeiling = H.halt('conversation-cost-ceiling')
  .context(z.object({ spentUsd: z.number(), nextStep: z.string() }))
  .decision(z.object({ raiseToUsd: z.number().optional() }))
  .ask(c => `This conversation has spent $${c.spentUsd.toFixed(2)}; ${c.nextStep} would pass $0.40.`);
const escalationHandled = H.halt('escalation-handled')
  .context(z.object({ conversationId: z.string(), reason: z.string() }))
  .decision(z.object({ resolution: z.string() }))
  .ask(c => `Escalated conversation ${c.conversationId}: ${c.reason}`);

const approvals = H.metric('approval-rate', H.events.decisions(replyApproval).where(d => d.resolver === 'human').credit(drafter))
  .rate(c => c.event.decision.approved)
  .by(category, 'model')
  .window('90d');

const safeCategory = H.policy.decision('safe-category', replyApproval, c => {
  const record = c.metrics.read(approvals, category.is(c.context.category));
  return record.samples >= 200 && record.value === 1 ? { approved: true } : undefined;
});

const helpdeskUrl = H.env('HELPDESK_URL');
const helpdeskToken = H.env('HELPDESK_TOKEN');
const helpdeskRunner = runners.local({ name: 'helpdesk', slots: 4 }).env({ HELPDESK_URL: helpdeskUrl, HELPDESK_TOKEN: helpdeskToken });

const sendReply = H.command('send-reply')
  .input(z.object({ conversationId: z.string(), body: z.string() }))
  .output(z.object({ messageId: z.string() }))
  .runner(helpdeskRunner)
  .effect('unrepeatable')
  .run(async (input, ctx) => {
    const result = await ctx.exec(['./bin/helpdesk-reply', input.conversationId], { stdin: input.body });
    if (result.code !== 0) throw new Error(result.stderr);
    return { messageId: result.stdout.trim() };
  });
const postNote = H.command('post-escalation-note')
  .input(z.object({ conversationId: z.string(), note: z.string() }))
  .output(z.object({ posted: z.boolean() }))
  .runner(helpdeskRunner)
  .effect('repeatable')
  .run(async (input, ctx) => {
    const result = await ctx.exec(['./bin/helpdesk-note', input.conversationId], { stdin: input.note });
    return { posted: result.code === 0 };
  });

const replyFlow = H.flow('reply')
  .input(conversationSchema)
  .step('classify', classifier, s => ({ subject: s.input.subject, message: s.input.lastMessage }))
  .tag(category, s => s.classify.category)
  .step('draft', drafter, s => ({ category: s.classify.category, customer: s.input.customer, message: s.input.lastMessage }))
  .halt('approval', replyApproval, s => ({ category: s.classify.category, draft: s.draft.reply }), { resolver: safeCategory })
  .when(s => !s.approval.approved, f => f.exit('rejected'))
  .step('send', sendReply, s => ({ conversationId: s.input.id, body: s.approval.edited ?? s.draft.reply }))
  .exit('sent');

const escalationFlow = H.flow('escalation')
  .input(escalationSchema)
  .halt('handled', escalationHandled, s => ({ conversationId: s.input.conversationId, reason: s.input.reason }))
  .step('note', postNote, s => ({ conversationId: s.input.conversationId, note: s.handled.resolution }))
  .exit('handled');

const conversations = H.lane('conversations').of(conversation);
const escalations = H.lane('escalations').of(escalation);

const conversationLane = conversations
  .from(
    http.webhook({
      name: 'helpdesk-webhook',
      path: '/helpdesk',
      port: H.slot.port(0),
      secret: H.env('HELPDESK_WEBHOOK_SECRET'),
      body: z.object({ conversation: conversationSchema }),
      key: b => b.conversation.id,
      data: b => b.conversation,
      mode: 'upsert',
    }),
    rest.poll({
      name: 'helpdesk-sweep',
      baseUrl: helpdeskUrl,
      token: helpdeskToken,
      path: '/conversations?status=open',
      interval: '10m',
      item: conversationSchema,
      key: c => c.id,
      data: c => c,
      mode: 'upsert',
    }),
  )
  .store(rest.store({ name: 'helpdesk', baseUrl: helpdeskUrl, token: helpdeskToken, path: '/conversations', schema: conversationSchema }))
  .handle(replyFlow, {
    exits: { sent: replied, rejected: { to: fresh, atMost: 2, then: escalated } },
    retry: { retries: 2, backoff: { initial: '30s', factor: 2 }, exhausted: escalated },
  })
  .ceiling({
    maxUsd: 0.4,
    halt: costCeiling,
    context: c => ({ spentUsd: c.spentUsd, nextStep: c.nextStep }),
    stopped: escalated,
  });

const escalationLane = escalations.handle(escalationFlow, {
  exits: { handled },
  retry: { retries: 1, backoff: 'none', exhausted: unhandled },
});

const slaBreach = H.trigger('sla-breach')
  .on(H.time.at(conversations, d => (d.status === 'open' ? new Date(d.slaDue) : undefined)))
  .do(
    escalations.create(e => ({
      key: `escalation-${e.unit.key}`,
      data: { conversationId: e.unit.data.id, customer: e.unit.data.customer, reason: `SLA breached at ${e.deadline.toISOString()}` },
    })),
    conversations.cancel(e => e.unit.key, escalated),
  );

const customerReplied = H.trigger('customer-replied')
  .on(H.events.updates(conversations).where(u => u.unit.data.lastMessageId !== u.previous.lastMessageId && u.unit.data.status === 'open'))
  .do(
    conversations.cancel({ halted: replyApproval, key: u => u.unit.key }, fresh),
    conversations.move(u => u.unit.key, fresh),
  );

const customerClosed = H.trigger('customer-closed')
  .on(H.events.updates(conversations).where(u => u.unit.data.status === 'closed' && u.previous.status === 'open'))
  .do(conversations.cancel(u => u.unit.key, closedByCustomer));

const reviewerEdits = H.trigger('reviewer-edits-become-taste')
  .on(H.events.decisions(replyApproval).where(d => d.resolver === 'human' && d.decision.edited !== undefined))
  .do(tasteJournal.record(d => ({
    content: { rule: `When replying about ${d.context.category}, write it the way the reviewer did: "${d.decision.edited ?? ''}", because the reviewer rewrote "${d.context.draft}".` },
    when: { roles: [drafterRole], resources: [category.is(d.context.category)] },
  })));

const urgency = (candidate: Candidate): number =>
  conversations.holds(candidate) ? Date.parse(candidate.data.slaDue) : 0;
const timeToBreach = H.policy.units('time-to-breach', c => [...c.candidates].sort((a, b) => urgency(a) - urgency(b)));

const reviewer = H.grant(
  claudeCode.client({ name: 'reviewer' }),
  H.ops.work.read,
  H.ops.work.write,
  H.ops.resolve(replyApproval),
  H.ops.resolve(costCeiling),
  H.ops.resolve(escalationHandled),
  H.ops.memory.write(taste),
  H.ops.memory.curate(taste),
  H.ops.memory.write(experience),
  H.ops.telemetry.read,
);

export const supportTriage = H.harness('support-triage')
  .ledger(sqlite.ledger('.harness/ledger.db'))
  .pools(pool)
  .lanes(conversationLane, escalationLane)
  .journals(tasteJournal, experienceJournal)
  .triggers(slaBreach, customerReplied, customerClosed, reviewerEdits)
  .scheduler(timeToBreach)
  .grants(reviewer)
  .observe(observers.board({ path: 'BOARD.md' }), observers.telemetry({ path: 'TELEMETRY.md' }));

void supportTriage.start();
