import { z } from 'zod';
import { H, type Halt, type PendingView, type RulePolicy, type SupplyOf } from 'harness-dsl';
import * as claudeCode from 'harness-dsl/claude-code';
import * as anthropic from 'harness-dsl/anthropic';
import * as http from 'harness-dsl/http';
import * as sqlite from 'harness-dsl/sqlite';
import * as jsonl from 'harness-dsl/jsonl';
import * as shell from 'harness-dsl/shell';
import * as markdown from 'harness-dsl/markdown';

const categories = z.enum(['billing', 'refund', 'shipping', 'account', 'other']);
const categoryFacet = H.facet('category', categories);

const fresh = H.state('new', 'pending');
const sent = H.state('sent', 'waiting');
const closedByCustomer = H.state('closed-by-customer', 'terminal', 'success');
const escalated = H.state('escalated', 'terminal', 'failure');

const conversation = H.kind('conversation')
  .data(
    z.object({
      customer: z.string(),
      subject: z.string(),
      lastMessage: z.string(),
      slaDue: z.string(),
      category: categories.optional(),
    })
  )
  .states(fresh, sent, closedByCustomer, escalated);

const open = H.state('open', 'pending');
const handled = H.state('handled', 'terminal', 'success');
const dropped = H.state('dropped', 'terminal', 'neutral');
const unhandled = H.state('unhandled', 'terminal', 'failure');

const escalation = H.kind('escalation')
  .data(z.object({ conversation: z.string(), reason: z.string() }))
  .states(open, handled, dropped, unhandled);

const haiku = anthropic.model('claude-haiku-4-5');
const sonnet = anthropic.model('claude-sonnet-4-5');
const opus = anthropic.model('claude-opus-4-1');
const api = anthropic.account('helpdesk-api', { apiKey: H.env('ANTHROPIC_API_KEY'), serves: [haiku, sonnet, opus] });
const models = H.pool('models', [{ account: api, share: 1 }]);

const approvalDecision = z.object({ approved: z.boolean(), editedReply: z.string().optional() });
const approvalAbout = z.object({ category: categories });
type Approval = z.infer<typeof approvalDecision>;
type ApprovalAbout = z.infer<typeof approvalAbout>;

const safeCategory: RulePolicy<ApprovalAbout, Approval | null> = H.policy.rule(
  'safe-category-after-200-clean-approvals',
  (about: ApprovalAbout, metrics) => {
    const facets = [categoryFacet.of(about.category)];
    const rate = metrics.rate({
      among: { ...replyApproval.resolved(), resolver: 'human', facets },
      count: { ...replyApproval.resolved({ approved: true }), resolver: 'human', facets },
    });
    return rate.samples >= 200 && rate.hits === rate.samples ? { approved: true } : null;
  }
);

const replyApproval: Halt<Approval, ApprovalAbout> = H.halt('reply-approval', approvalDecision)
  .about(approvalAbout)
  .policy(safeCategory);

const escalationReview = H.halt('escalation-review', z.object({ outcome: z.enum(['handled', 'dropped']) }));

const toneTaste = H.memory('support-tone', 'taste');
const supportExperience = H.memory('support-experience', 'experience');
const tasteJournal = H.journal('support-taste', toneTaste, jsonl.memory('memory/support-taste.jsonl'));
const experienceJournal = H.journal('support-lessons', supportExperience, jsonl.memory('memory/support-experience.jsonl'));

const classifying = H.role('classifier')
  .input(z.object({ subject: z.string(), message: z.string() }))
  .output(z.object({ category: categories }))
  .prompt(input => `Classify this support conversation.\nSubject: ${input.subject}\n\n${input.message}`);

const drafting = H.role('drafter')
  .input(z.object({ customer: z.string(), subject: z.string(), message: z.string(), category: categories }))
  .output(z.object({ reply: z.string() }))
  .prompt(input => `Draft a reply to ${input.customer} about "${input.subject}" (${input.category}).\n\n${input.message}`);

const drafterModel = H.policy.model('drafter-by-approval-rate', [sonnet, opus], choice => {
  const byModel = choice.metrics.rateBy({
    days: 30,
    among: { ...replyApproval.resolved(), resolver: 'human' },
    count: { ...replyApproval.resolved(), resolver: 'human', credited: choice.seat },
    by: { modelOf: choice.seat },
  });
  const cheaper = byModel.of(sonnet);
  const stronger = byModel.of(opus);
  if (cheaper.samples < 100) return sonnet;
  if (stronger.samples < 100) return opus;
  return (stronger.value ?? 0) - (cheaper.value ?? 0) > 0.05 ? opus : sonnet;
});

const classifier = H.seat('classifier', classifying).model(haiku);
const drafter = H.seat('drafter', drafting)
  .model(drafterModel)
  .recalls(tasteJournal, experienceJournal)
  .creditedBy(replyApproval, decision => decision.approved);

const local = shell.local('local', { slots: 4 });
const sendReply = H.command('send-reply')
  .input(z.object({ conversation: z.string(), reply: z.string() }))
  .argv(input => ['helpdesk-reply', '--conversation', input.conversation, '--body', input.reply])
  .on(local)
  .recovery('park');

const triage = H.flow('triage-and-reply')
  .for(conversation)
  .does(async ctx => {
    const data = ctx.unit.data;
    const classified = await ctx.run(classifier, { subject: data.subject, message: data.lastMessage });
    if (classified.ok === false) return ctx.fail(classified.error);
    const category = classified.value.category;
    await ctx.update({ category });
    const draft = await ctx.run(drafter, {
      customer: data.customer,
      subject: data.subject,
      message: data.lastMessage,
      category,
    });
    if (draft.ok === false) return ctx.fail(draft.error);
    const approval = await ctx.halt(replyApproval, draft.value.reply, { category });
    if (approval.approved === false) return ctx.fail('reviewer rejected the draft');
    if (approval.editedReply) {
      await ctx.remember(tasteJournal, {
        text: `When replying about ${category}, prefer the reviewer's phrasing: "${approval.editedReply}"`,
        because: `the reviewer rewrote a drafted reply for conversation ${ctx.unit.key}`,
        when: { facets: [categoryFacet.of(category)] },
        status: 'candidate',
      });
    }
    const delivered = await ctx.run(sendReply, {
      conversation: ctx.unit.key,
      reply: approval.editedReply ?? draft.value.reply,
    });
    if (delivered.ok === false) return ctx.fail(delivered.error);
    return 'sent';
  });

const escalationHandling = H.flow('escalation-by-human')
  .for(escalation)
  .does(async ctx => {
    const review = await ctx.halt(escalationReview, `Escalated conversation ${ctx.unit.data.conversation}: ${ctx.unit.data.reason}`);
    return review.outcome;
  });

const helpdeskHeaders = { Authorization: H.env('HELPDESK_TOKEN') };

const helpdeskWebhook = http.webhook(conversation, {
  path: '/hooks/helpdesk',
  secret: H.env('HELPDESK_WEBHOOK_SECRET'),
  body: z.object({
    event: z.enum(['created', 'message', 'closed']),
    conversationId: z.string(),
    customer: z.string(),
    subject: z.string(),
    message: z.string(),
    slaDue: z.string(),
  }),
  read: (body): SupplyOf<typeof conversation> | null => {
    if (body.event === 'created') {
      return {
        create: { customer: body.customer, subject: body.subject, lastMessage: body.message, slaDue: body.slaDue },
        key: body.conversationId,
      };
    }
    if (body.event === 'closed') return { update: body.conversationId, state: 'closed-by-customer' };
    return {
      update: body.conversationId,
      patch: { lastMessage: body.message },
      state: 'new',
      cancels: ['waiting'],
    };
  },
});

const helpdeskPoll = http.poll(conversation, {
  url: 'https://helpdesk.example.com/api/conversations?status=open',
  every: { minutes: 10 },
  headers: helpdeskHeaders,
  body: z.object({
    conversations: z.array(
      z.object({ id: z.string(), customer: z.string(), subject: z.string(), lastMessage: z.string(), slaDue: z.string() })
    ),
  }),
  read: body =>
    body.conversations.map(
      (item): SupplyOf<typeof conversation> => ({
        create: { customer: item.customer, subject: item.subject, lastMessage: item.lastMessage, slaDue: item.slaDue },
        key: item.id,
      })
    ),
});

const helpdeskStore = http.store(conversation, {
  url: 'https://helpdesk.example.com/api/conversations',
  headers: helpdeskHeaders,
  stateField: 'harness_state',
});

const conversations = H.lane('conversations', conversation)
  .handler(triage)
  .retries(2, { backoff: { first: { minutes: 1 }, factor: 2 }, exhausted: 'escalated' })
  .suppliers(helpdeskWebhook, helpdeskPoll)
  .store(helpdeskStore)
  .maxUsdPerUnit(0.4)
  .facet(categoryFacet, data => data.category);

const escalations = H.lane('escalations', escalation)
  .handler(escalationHandling)
  .retries(0, { exhausted: 'unhandled' });

const slaBreach = H.trigger(
  'sla-breach-escalates',
  H.on.deadline(conversation, data => new Date(data.slaDue), ['new']),
  (event, act) => act.move('escalated')
);

const escalatedOpensEscalation = H.trigger(
  'escalated-opens-escalation',
  H.on.enters(conversation, 'escalated'),
  (event, act) =>
    act.create(
      escalations,
      { conversation: event.unit.key, reason: `conversation escalated at ${event.at.toISOString()}` },
      event.unit.key
    )
);

const timeToBreach = H.policy.scheduler('time-to-breach', view => {
  const dueAt = (unit: PendingView): number =>
    unit.is(conversation) ? new Date(unit.data.slaDue).getTime() : view.now.getTime();
  return { start: [...view.pending].sort((a, b) => dueAt(a) - dueAt(b)) };
});

const reviewer = claudeCode.supervisor({
  grants: [
    H.ops.readWork,
    H.ops.resolve(replyApproval, escalationReview, H.halts.costCeiling),
    H.ops.readMemory,
    H.ops.writeMemory,
    H.ops.curateMemory,
    H.ops.readTelemetry,
  ],
});

export const harness = H.harness('support-triage')
  .ledger(sqlite.ledger('.harness/support.db'))
  .lanes(conversations, escalations)
  .pools(models)
  .triggers(slaBreach, escalatedOpensEscalation)
  .scheduler(timeToBreach)
  .clients(reviewer)
  .observers(markdown.board('BOARD.md'), markdown.telemetry('TELEMETRY.md'));

export const running = harness.start();
