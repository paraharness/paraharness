import { z } from 'zod';
import { H } from 'harness-dsl';
import type { Metrics, PendingUnit, SupplyEvent } from 'harness-dsl';
import { anthropic } from 'harness-dsl/anthropic';
import { claudeCode } from 'harness-dsl/claude-code';
import { sqlite } from 'harness-dsl/sqlite';
import { jsonl } from 'harness-dsl/jsonl';
import { zendesk } from 'harness-dsl/zendesk';
import type { ZendeskTicket } from 'harness-dsl/zendesk';
import { byApplicability } from 'harness-dsl/policies';
import { board, telemetry } from 'harness-dsl/observers';
import { local } from 'harness-dsl/local';

const conversation = z.object({
  ticketId: z.string(),
  subject: z.string(),
  latestMessage: z.string(),
  category: z.string(),
  slaDueAt: z.date(),
});
type ConversationData = z.infer<typeof conversation>;

const escalation = z.object({ conversationKey: z.string(), ticketId: z.string(), reason: z.string() });

const New = H.state('new').pending();
const Classifying = H.state('classifying').pending();
const Drafting = H.state('drafting').active();
const AwaitingApproval = H.state('awaiting-approval').active();
const Sent = H.state('sent').active();
const ClosedByCustomer = H.state('closed-by-customer').succeeded();
const Escalated = H.state('escalated').ended();
const ConversationFailed = H.state('conversation-failed').failed();

const EscalationOpen = H.state('escalation-open').pending();
const EscalationInProgress = H.state('escalation-in-progress').active();
const EscalationClosed = H.state('escalation-closed').succeeded();

const Conversation = H.work('conversation')
  .schema(conversation)
  .states(New, Classifying, Drafting, AwaitingApproval, Sent, ClosedByCustomer, Escalated, ConversationFailed);
const Escalation = H.work('escalation')
  .schema(escalation)
  .states(EscalationOpen, EscalationInProgress, EscalationClosed);

const Taste = H.memory('taste').content(z.object({ rule: z.string(), because: z.string() }));
const Experience = H.memory('experience').content(
  z.object({ do: z.string(), when: z.string(), because: z.string() }),
);

const tasteJournal = H.journal('reply-taste')
  .of(Taste)
  .store(jsonl.store('.harness/taste.jsonl'))
  .recall(byApplicability({ budgetTokens: 800 }));
const experienceJournal = H.journal('support-experience')
  .of(Experience)
  .store(jsonl.store('.harness/experience.jsonl'))
  .recall(byApplicability({ budgetTokens: 1200 }));

const apiAccount = H.account('anthropic-api', anthropic.api({ apiKey: H.env('ANTHROPIC_API_KEY') }));
const haiku = H.model('haiku', apiAccount, 'claude-haiku-4-5');
const sonnet = H.model('sonnet', apiAccount, 'claude-sonnet-4-5');

const classifier = H.agent('classifier')
  .role(H.role('classifier').prompt('Classify the customer conversation into one support category.'))
  .model(haiku);
const drafter = H.agent('drafter')
  .role(
    H.role('drafter')
      .prompt('Draft the next reply to the customer. Follow house tone and cited policies.')
      .recall(Taste, Experience),
  )
  .model(sonnet);

const classify = H.skill('classify')
  .input(z.object({ subject: z.string(), message: z.string() }))
  .output(z.object({ category: z.string() }))
  .prompt(c => `Subject: ${c.subject}\n\n${c.message}`);
const draftReply = H.skill('draft-reply')
  .input(z.object({ category: z.string(), subject: z.string(), message: z.string() }))
  .output(z.object({ reply: z.string() }))
  .prompt(c => `Category: ${c.category}\nSubject: ${c.subject}\n\n${c.message}`);

const ReplyApproval = H.blocker('reply-approval').resolution(
  z.object({
    approved: z.boolean(),
    editedReply: z.string().optional(),
    note: z.string().optional(),
  }),
);
const EscalationHandled = H.blocker('escalation-handled').resolution(
  z.object({ outcome: z.string() }),
);

const localRunner = H.runner('local', local()).slots(8);

const sendReply = H.command('send-reply')
  .input(z.object({ ticketId: z.string(), reply: z.string() }))
  .runner(localRunner)
  .env({ ZENDESK_TOKEN: H.env('ZENDESK_API_TOKEN') })
  .run(async ({ input, exec }) => {
    const result = await exec(
      `curl -fsS -X PUT -H "Authorization: Bearer $ZENDESK_TOKEN" -H "Content-Type: application/json" --data @- https://acme.zendesk.com/api/v2/tickets/${input.ticketId}.json`,
      { stdin: JSON.stringify({ ticket: { comment: { body: input.reply, public: true } } }) },
    );
    if (result.exitCode !== 0) {
      throw new Error(result.stderr);
    }
  });

function requiresApproval(category: string, metrics: Metrics): boolean {
  const record = metrics.rate(approvals, {
    key: `category:${category}`,
    window: { since: new Date(0) },
  });
  return !(record.samples >= 200 && record.hits === record.samples);
}

const triage = H.flow('triage')
  .for(Conversation)
  .step('classify', classify.by(classifier), {
    input: (_, ctx) => ({ subject: ctx.unit.data.subject, message: ctx.unit.data.latestMessage }),
  })
  .patch(classified => ({ category: classified.category }))
  .transition(Drafting)
  .step('draft', draftReply.by(drafter), {
    input: (classified, ctx) => ({
      category: classified.category,
      subject: ctx.unit.data.subject,
      message: ctx.unit.data.latestMessage,
    }),
  })
  .transition(AwaitingApproval)
  .haltIf(
    (_, ctx) => requiresApproval(ctx.unit.data.category, ctx.metrics),
    ReplyApproval,
    drafted => drafted.reply,
  )
  .map(decision => ({
    reply: decision.resolution?.editedReply ?? decision.value.reply,
    approved: decision.resolution === null || decision.resolution.approved,
  }))
  .when(
    outgoing => !outgoing.approved,
    rejected => rejected.transition(Escalated),
  )
  .step('send', sendReply, {
    input: (outgoing, ctx) => ({ ticketId: ctx.unit.data.ticketId, reply: outgoing.reply }),
  })
  .transition(Sent)
  .onError(ConversationFailed);

const escalationFlow = H.flow('escalation')
  .for(Escalation)
  .transition(EscalationInProgress)
  .halt(EscalationHandled, (_, ctx) => `Conversation ${ctx.unit.data.conversationKey}: ${ctx.unit.data.reason}`)
  .transition(EscalationClosed);

const slaMs = 4 * 60 * 60 * 1000;
const fromTicket = (ticket: ZendeskTicket): ConversationData => ({
  ticketId: ticket.id,
  subject: ticket.subject,
  latestMessage: ticket.latestComment,
  category: ticket.tags.find(tag => tag.startsWith('category:'))?.slice('category:'.length) ?? '',
  slaDueAt: new Date(ticket.createdAt.getTime() + slaMs),
});
const toSupply = (ticket: ZendeskTicket): SupplyEvent<ConversationData> | null =>
  ticket.status === 'solved' || ticket.status === 'closed'
    ? { key: ticket.id, patch: {}, state: ClosedByCustomer }
    : { key: ticket.id, data: fromTicket(ticket) };

const zendeskToken = H.env('ZENDESK_API_TOKEN');

const conversations = H.lane('conversations')
  .of(Conversation)
  .from(
    zendesk.webhook<ConversationData>({
      port: 8443,
      path: '/zendesk',
      secret: H.env('ZENDESK_WEBHOOK_SECRET'),
      map: toSupply,
    }),
    zendesk.poll<ConversationData>({
      subdomain: 'acme',
      apiToken: zendeskToken,
      every: '10m',
      map: toSupply,
    }),
  )
  .store(
    zendesk.store<ConversationData>({
      subdomain: 'acme',
      apiToken: zendeskToken,
      map: fromTicket,
      states: {
        new: 'new',
        classifying: 'open',
        drafting: 'open',
        'awaiting-approval': 'open',
        sent: 'pending',
        'closed-by-customer': 'solved',
        escalated: 'on-hold',
        'conversation-failed': 'open',
      },
    }),
  )
  .handle(triage)
  .deadline(unit => (unit.state.name === Sent.name ? null : unit.data.slaDueAt))
  .maxUsdPerUnit(0.4, { onExceed: 'halt' });

const escalations = H.lane('escalations').of(Escalation).handle(escalationFlow);

const approvals = H.metric('reply-approval')
  .over(conversations.resolved(ReplyApproval))
  .sample(decision => [
    { key: `category:${decision.unit.data.category}`, hit: decision.resolution.approved },
    {
      key: `model:${decision.attempt.models[drafter.name] ?? 'unknown'}`,
      hit: decision.resolution.approved,
    },
  ]);

const slaBreachEscalates = H.trigger('sla-breach-escalates')
  .on(conversations.overdue())
  .add(escalations, breach => ({
    conversationKey: breach.unit.key,
    ticketId: breach.unit.data.ticketId,
    reason: `SLA breached at ${breach.deadline.toISOString()}`,
  }))
  .transition(Escalated);

const customerReplyReclassifies = H.trigger('customer-reply-reclassifies')
  .on(
    conversations
      .updated()
      .where(
        change =>
          (change.unit.state.name === AwaitingApproval.name || change.unit.state.name === Sent.name) &&
          change.unit.data.latestMessage !== change.previous.data.latestMessage,
      ),
  )
  .transition(Classifying);

const reviewerEditsBecomeTaste = H.trigger('reviewer-edits-become-taste')
  .on(conversations.resolved(ReplyApproval).where(decision => decision.resolution.editedReply !== undefined))
  .record(
    tasteJournal,
    decision => ({
      content: {
        rule: `Phrase ${decision.unit.data.category} replies like: ${decision.resolution.editedReply ?? ''}`,
        because: decision.resolution.note ?? 'the reviewer rewrote the draft this way',
      },
      when: { kinds: [Conversation] },
    }),
    { candidate: true },
  );

const timeToBreach = (unit: PendingUnit): number =>
  unit.deadline === null ? Number.MAX_SAFE_INTEGER : unit.deadline.getTime();

const scheduler = H.scheduler('support')
  .concurrency(6)
  .policy(
    H.policy.schedule('earliest-breach-first', ctx => ({
      start: [...ctx.pending].sort(
        (a, b) => timeToBreach(a) - timeToBreach(b) || a.enqueuedAt.getTime() - b.enqueuedAt.getTime(),
      ),
    })),
  );

const supervisor = H.supervisor('reviewer')
  .client(claudeCode.client({ port: 7410 }))
  .grant(
    H.ops.work.read,
    H.ops.blockers.resolve,
    H.ops.memory.write,
    H.ops.memory.curate,
    H.ops.telemetry.read,
  );

export const supportTriage = H.harness('support-triage')
  .ledger(sqlite.ledger('.harness/ledger.db'))
  .lanes(conversations, escalations)
  .journals(tasteJournal, experienceJournal)
  .triggers(slaBreachEscalates, customerReplyReclassifies, reviewerEditsBecomeTaste)
  .metrics(approvals)
  .scheduler(scheduler)
  .supervisor(supervisor)
  .observe(board('BOARD.md'), telemetry('TELEMETRY.md'));

export const running = supportTriage.start();
