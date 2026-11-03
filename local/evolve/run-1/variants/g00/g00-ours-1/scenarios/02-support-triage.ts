import { H, type Json, type Metrics, type Model } from 'harness-dsl';
import { z } from 'zod';
import { claudeCode } from 'harness-dsl/claude-code';
import { anthropic } from 'harness-dsl/anthropic';
import { sqlite } from 'harness-dsl/sqlite';
import { jsonl } from 'harness-dsl/jsonl';
import { rest } from 'harness-dsl/rest';
import { webhook } from 'harness-dsl/webhook';
import { local } from 'harness-dsl/runners';
import { byApplicability } from 'harness-dsl/policies';
import { board, telemetry } from 'harness-dsl/projections';

const New = H.state('New').pending();
const Classifying = H.state('Classifying').active();
const Drafting = H.state('Drafting').active();
const AwaitingApproval = H.state('AwaitingApproval').active();
const Sent = H.state('Sent').dormant();
const ClosedByCustomer = H.state('ClosedByCustomer').succeeded();
const Escalated = H.state('Escalated').ended();
const Failed = H.state('Failed').failed();
const EscalationOpen = H.state('EscalationOpen').pending();
const EscalationHandling = H.state('EscalationHandling').active();
const EscalationHandled = H.state('EscalationHandled').succeeded();
const EscalationFailed = H.state('EscalationFailed').failed();

const conversationSchema = z.object({
  ticketId: z.string(),
  customer: z.string(),
  lastMessage: z.string(),
  lastMessageAt: z.string(),
  slaDueAt: z.string(),
  status: z.enum(['open', 'closed']),
  category: z.string().nullable(),
  reviewerNote: z.string().nullable(),
});
type ConversationData = z.infer<typeof conversationSchema>;

const Conversation = H.work('conversation')
  .schema(conversationSchema)
  .states(New, Classifying, Drafting, AwaitingApproval, Sent, ClosedByCustomer, Escalated, Failed)
  .key(d => d.ticketId);

const Escalation = H.work('escalation')
  .schema(z.object({ conversation: z.string(), customer: z.string(), reason: z.string() }))
  .states(EscalationOpen, EscalationHandling, EscalationHandled, EscalationFailed)
  .key(d => d.conversation);

const helpdeskPayload = z.object({
  ticket: z.object({ id: z.string(), customer: z.string(), status: z.enum(['open', 'closed']), sla_due_at: z.string() }),
  message: z.object({ body: z.string(), created_at: z.string() }),
});

const fromHelpdesk = (body: Json): ConversationData | null => {
  const parsed = helpdeskPayload.safeParse(body);
  if (!parsed.success) return null;
  return {
    ticketId: parsed.data.ticket.id,
    customer: parsed.data.ticket.customer,
    lastMessage: parsed.data.message.body,
    lastMessageAt: parsed.data.message.created_at,
    slaDueAt: parsed.data.ticket.sla_due_at,
    status: parsed.data.ticket.status,
    category: null,
    reviewerNote: null,
  };
};

const Taste = H.memory('reply-taste').content(z.object({ preference: z.string() })).taste();
const Experience = H.memory('support-experience').content(z.object({ action: z.string(), condition: z.string(), reason: z.string() }));

const tasteJournal = H.journal('reply-taste').of(Taste).store(jsonl.memory('memory/taste.jsonl')).recall(byApplicability({ budgetTokens: 800 }));
const experienceJournal = H.journal('support-experience').of(Experience).store(jsonl.memory('memory/experience.jsonl')).recall(byApplicability({ budgetTokens: 1200 }));

const api = H.account('anthropic-api', anthropic.api({ apiKey: H.env('ANTHROPIC_API_KEY') }));
const haiku = H.model('haiku', api, 'claude-haiku-4-5').pricing(anthropic.pricing());
const opus = H.model('opus', api, 'claude-opus-4-1').pricing(anthropic.pricing());

const classifierRole = H.role('classifier').prompt('You classify a customer message into one support category.').tools();
const drafterRole = H.role('drafter').prompt('You draft a reply to the customer that resolves their issue.').tools('read').recall(Taste, Experience);

const classify = H.skill('classify')
  .input(z.object({ message: z.string() }))
  .output(z.object({ category: z.string(), confidence: z.number() }))
  .prompt(i => `Classify this message:\n${i.message}`);

const draftReply = H.skill('draft-reply')
  .input(z.object({ message: z.string(), category: z.string(), feedback: z.string().nullable() }))
  .output(z.object({ text: z.string() }))
  .prompt(i => `Category: ${i.category}\nCustomer wrote:\n${i.message}\n${i.feedback === null ? '' : `Reviewer feedback on the previous draft: ${i.feedback}`}`);

const classifier = H.agent('classifier').role(classifierRole).model(haiku);
const drafter = H.agent('drafter').role(drafterRole).model(opus);

const helpdeskRunner = local('helpdesk-runner').slots(8);

const sendReply = H.command('send-reply')
  .input(z.object({ ticketId: z.string(), text: z.string() }))
  .runner(helpdeskRunner)
  .env({ HELPDESK_TOKEN: H.env('HELPDESK_TOKEN'), HELPDESK_URL: H.env('HELPDESK_URL') })
  .run(async ctx => {
    await ctx.exec('helpdesk-reply', [ctx.input.ticketId], { stdin: ctx.input.text });
  });

interface ApprovalStats {
  readonly approved: number;
  readonly rejected: number;
  readonly samples: number;
  readonly rate: number | null;
}

const approvalStats = (metrics: Metrics, filter: { readonly category?: string; readonly model?: Model }): ApprovalStats => {
  const reviewed = metrics
    .transitions(Conversation, { windowDays: 180, to: [Sent, Drafting] })
    .filter(e => e.from === 'AwaitingApproval')
    .filter(e => filter.category === undefined || e.unit.data.category === filter.category)
    .filter(e => {
      const model = filter.model;
      return model === undefined || (e.attempt?.invocations.some(i => i.step === 'draft' && i.model === model.name) ?? false);
    });
  const approved = reviewed.filter(e => e.to === 'Sent').length;
  const rejected = reviewed.length - approved;
  return { approved, rejected, samples: reviewed.length, rate: reviewed.length === 0 ? null : approved / reviewed.length };
};

const provenSafe = (metrics: Metrics, category: string): boolean => {
  const stats = approvalStats(metrics, { category, model: opus });
  return stats.approved >= 200 && stats.rejected === 0;
};

const verdict = z.object({ verdict: z.enum(['approve', 'reject']), finalText: z.string(), note: z.string() });

const conversationFlow = H.flow('conversation')
  .of(Conversation)
  .transition(Classifying)
  .step('classify', classifier.perform(classify), s => ({ message: s.unit.data.lastMessage }))
  .update(s => ({ category: s.steps.classify.category }))
  .loop('drafts', {
    maxIterations: 3,
    body: b =>
      b
        .transition(Drafting)
        .step('draft', drafter.perform(draftReply), s => ({
          message: s.unit.data.lastMessage,
          category: s.steps.classify.category,
          feedback: s.steps.drafts?.note ?? null,
        }))
        .when(
          s => !provenSafe(s.metrics, s.steps.classify.category),
          w =>
            w.transition(AwaitingApproval).halt('approval', {
              ask: s => `Approve the reply to ${s.unit.data.customer} (${s.steps.classify.category}):\n\n${s.steps.draft.text}`,
              decision: verdict,
            }),
        ),
    carry: {
      schema: z.object({ note: z.string() }),
      from: s => ({ note: s.steps.approval?.note ?? '' }),
    },
    until: s => s.steps.approval?.verdict !== 'reject',
  })
  .when(
    s => s.steps.approval?.verdict === 'reject',
    w => w.transition(Escalated),
  )
  .step('send', sendReply, s => ({ ticketId: s.unit.data.ticketId, text: s.steps.approval?.finalText ?? s.steps.draft.text }))
  .update(s => ({ reviewerNote: s.steps.approval?.note || null }))
  .transition(Sent);

const escalationFlow = H.flow('escalation')
  .of(Escalation)
  .transition(EscalationHandling)
  .halt('handled', {
    ask: s => `Escalated conversation ${s.unit.data.conversation} for ${s.unit.data.customer}: ${s.unit.data.reason}. Record how it was handled.`,
    decision: z.object({ resolution: z.string() }),
  })
  .transition(EscalationHandled);

const helpdeskToken = H.env('HELPDESK_TOKEN');

const conversations = H.lane('conversations')
  .of(Conversation)
  .from(
    webhook.supply({ path: '/helpdesk/events', secret: H.env('HELPDESK_WEBHOOK_SECRET'), mode: 'upsert', map: fromHelpdesk }),
    rest.poll({ url: H.env('HELPDESK_OPEN_TICKETS_URL'), token: helpdeskToken, everyMinutes: 10, map: fromHelpdesk }),
  )
  .store(rest.store({ baseUrl: H.env('HELPDESK_URL'), token: helpdeskToken, path: (_kind, key) => `/tickets/${key}` }))
  .handle(conversationFlow)
  .maxUsdPerUnit(0.4);

const escalations = H.lane('escalations').of(Escalation).handle(escalationFlow);

const slaBreach = conversations.deadline(u => new Date(u.data.slaDueAt), { during: [New, Classifying, Drafting, AwaitingApproval] });

const breachEscalates = H.trigger('sla-breach-escalates').on(slaBreach).move(Escalated);

const escalationOpens = H.trigger('escalation-opens')
  .on(conversations.enters(Escalated))
  .create(escalations, e => ({
    conversation: e.unit.key,
    customer: e.unit.data.customer,
    reason: e.actor.sort === 'trigger' ? 'SLA breached' : 'Reviewer rejected every draft',
  }));

const customerReplied = H.trigger('customer-replied')
  .on(conversations.updated())
  .where(e => e.unit.data.lastMessageAt !== e.previous.lastMessageAt && e.unit.data.status === 'open')
  .where(e => ['Classifying', 'Drafting', 'AwaitingApproval', 'Sent'].includes(e.unit.state))
  .move(New);

const customerClosed = H.trigger('customer-closed')
  .on(conversations.updated())
  .where(e => e.unit.data.status === 'closed' && e.previous.status === 'open')
  .move(ClosedByCustomer);

const reviewerTaste = H.trigger('reviewer-edits-become-taste')
  .on(conversations.enters(Sent))
  .record(
    tasteJournal,
    e => (e.unit.data.reviewerNote === null ? null : { content: { preference: e.unit.data.reviewerNote }, when: { kinds: [Conversation], roles: [drafterRole] } }),
    { candidate: true },
  );

const timeToBreach = H.policy.schedule('escalations-then-time-to-breach', ctx => {
  const urgent = [...ctx.of(conversations).pending].sort((a, b) => Date.parse(a.unit.data.slaDueAt) - Date.parse(b.unit.data.slaDueAt));
  return { start: [...ctx.of(escalations).pending, ...urgent] };
});

const supervisor = H.supervisor('support-desk')
  .endpoint(claudeCode.endpoint({ server: 'support-triage' }))
  .grant(H.ops.work.read, H.ops.blockers.resolve, H.ops.memory.read, H.ops.memory.write, H.ops.memory.curate, H.ops.telemetry.read);

export const supportTriage = H.harness('support-triage')
  .ledger(sqlite.ledger('.harness/ledger.sqlite'))
  .lanes(conversations, escalations)
  .journals(tasteJournal, experienceJournal)
  .triggers(breachEscalates, escalationOpens, customerReplied, customerClosed, reviewerTaste)
  .scheduler(H.scheduler('support').concurrency(8).policy(timeToBreach))
  .supervisor(supervisor)
  .projections(board('BOARD.md'), telemetry('TELEMETRY.md'));

export const run = supportTriage.start();
