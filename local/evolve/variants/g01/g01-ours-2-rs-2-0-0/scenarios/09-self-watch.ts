import { z } from 'zod';
import { H } from 'harness-dsl';
import type { Resource } from 'harness-dsl';
import { anthropic } from 'harness-dsl/anthropic';
import { claudeCode } from 'harness-dsl/claude-code';
import { sqlite } from 'harness-dsl/sqlite';
import { jsonl } from 'harness-dsl/jsonl';
import { http } from 'harness-dsl/http';
import { supply } from 'harness-dsl/supply';
import { policies } from 'harness-dsl/policies';
import { observers } from 'harness-dsl/observers';

const helpdeskUrl = H.env('HELPDESK_URL');
const helpdeskToken = H.env('HELPDESK_TOKEN');

const categorySchema = z.enum(['billing', 'refunds', 'shipping', 'account']);
type Category = z.infer<typeof categorySchema>;

const categories: Record<Category, Resource> = {
  billing: H.resource('billing'),
  refunds: H.resource('refunds'),
  shipping: H.resource('shipping'),
  account: H.resource('account'),
};
const categoryNamed = (name: string | undefined): readonly Resource[] => Object.values(categories).filter(r => r.name === name);

const haiku = H.model('claude-haiku-4-5').pricing(anthropic.pricing());
const sonnet = H.model('claude-sonnet-4-5').pricing(anthropic.pricing());

const subscription = H.account('max-1', claudeCode.driver({ configDir: H.env('CLAUDE_CONFIG_MAX_1') }));
const api = H.account('api', anthropic.api({ apiKey: H.env('ANTHROPIC_API_KEY') }));

const local = H.runner.local('local', { slots: 8 });

const taste = H.memory('taste').content(z.object({ preference: z.string() })).trust('taste');
const experience = H.memory('experience').content(z.object({ text: z.string() })).trust('experience');

const tasteJournal = H.journal('reply-taste').of(taste).store(jsonl.store('./support/.harness/taste.jsonl')).recall(policies.specificity({ limit: 10 }));
const experienceJournal = H.journal('reply-experience')
  .of(experience)
  .store(jsonl.store('./support/.harness/experience.jsonl'))
  .recall(policies.specificity({ limit: 10 }));

const conversationSchema = z.object({
  id: z.string(),
  customer: z.string(),
  lastMessage: z.string(),
  status: z.enum(['open', 'closed']),
  slaDeadline: z.string(),
});

const fresh = H.state('new').pending();
const handling = H.state('handling').active();
const awaitingCustomer = H.state('sent').waiting();
const closedByCustomer = H.state('closed-by-customer').terminal('success');
const escalated = H.state('escalated').terminal('neutral');
const failed = H.state('failed').terminal('failure');

const conversation = H.work('conversation')
  .schema(conversationSchema)
  .states(fresh, handling, awaitingCustomer, closedByCustomer, escalated, failed);

const classifierRole = H.role('classifier').prompt('Classify the customer message into one category.').intents(['read']);
const drafterRole = H.role('drafter').prompt('Draft a reply in the house tone.').intents(['read']).recall(taste, experience);

const classifySkill = H.skill('classify')
  .input(z.object({ message: z.string() }))
  .output(z.object({ category: categorySchema }))
  .prompt(i => i.message);

const draftSkill = H.skill('draft-reply')
  .input(z.object({ message: z.string(), category: categorySchema }))
  .output(z.object({ reply: z.string() }))
  .prompt(i => `Category ${i.category}. Customer wrote:\n${i.message}`);

const classifier = H.seat('classifier').role(classifierRole).models(haiku);
const drafter = H.seat('drafter').role(drafterRole).models(sonnet);

const approval = H.halt('reply-approval')
  .context(z.object({ conversation: z.string(), category: categorySchema, draft: z.string() }))
  .ask(c => `Approve this ${c.category} reply?\n${c.draft}`)
  .decision(z.object({ approved: z.boolean(), edited: z.string().optional() }));

const overBudget = H.halt('conversation-over-budget')
  .context(z.object({ spentUsd: z.number(), maxUsd: z.number() }))
  .ask(c => `Spent $${c.spentUsd} of $${c.maxUsd}. Continue?`)
  .decision(z.object({ continue: z.boolean(), extraUsd: z.number().optional() }));

const sendReply = H.command('send-reply')
  .input(z.object({ conversation: z.string(), text: z.string() }))
  .runner(local)
  .effect('unrepeatable')
  .run(async (input, ctx) => {
    const response = await fetch(`${ctx.resolve(helpdeskUrl)}/conversations/${input.conversation}/replies`, {
      method: 'POST',
      headers: { authorization: `Bearer ${ctx.resolve(helpdeskToken)}`, 'content-type': 'application/json' },
      body: JSON.stringify({ body: input.text }),
    });
    if (!response.ok) throw new Error(`helpdesk answered ${response.status}`);
  });

const answer = H.flow('answer')
  .input(conversationSchema)
  .step('classify', classifier.call(classifySkill), s => ({ message: s.input.lastMessage }))
  .resources(s => [categories[s.steps.classify.category]])
  .step('draft', drafter.call(draftSkill), s => ({ message: s.input.lastMessage, category: s.steps.classify.category }))
  .halt('approval', approval, s => ({ conversation: s.input.id, category: s.steps.classify.category, draft: s.steps.draft.reply }))
  .when(s => !s.steps.approval.approved, f => f.exit('rejected'))
  .step('send', sendReply, s => ({ conversation: s.input.id, text: s.steps.approval.edited ?? s.steps.draft.reply }))
  .exit('sent');

const answerHandler = H.handler('answer')
  .of(conversation)
  .flow(answer)
  .exits({ rejected: { to: fresh, maxTimes: 2, then: escalated }, sent: awaitingCustomer })
  .retry({ tries: 2, backoff: 'exponential', delaySeconds: 30, exhausted: failed });

const helpdeskStored = z.object({ data: conversationSchema, state: z.string() });

const conversations = H.lane('conversations', answerHandler)
  .from(
    http.webhook({ path: '/helpdesk', schema: conversationSchema, secret: H.env('HELPDESK_SECRET') }).key(d => d.id),
    supply
      .poll({
        every: '10m',
        fetch: async ctx =>
          z.array(conversationSchema).parse(
            await (await fetch(`${ctx.resolve(helpdeskUrl)}/conversations?updated=recent`, {
              headers: { authorization: `Bearer ${ctx.resolve(helpdeskToken)}` },
            })).json(),
          ),
      })
      .key(d => d.id),
  )
  .store(
    http.store({
      load: async (unit, ctx) => {
        const response = await fetch(`${ctx.resolve(helpdeskUrl)}/conversations/${unit.key}/harness`, {
          headers: { authorization: `Bearer ${ctx.resolve(helpdeskToken)}` },
        });
        if (!response.ok) return undefined;
        const stored = helpdeskStored.parse(await response.json());
        return { data: stored.data, state: stored.state };
      },
      save: async (unit, change, ctx) => {
        const response = await fetch(`${ctx.resolve(helpdeskUrl)}/conversations/${unit.key}/harness`, {
          method: 'PUT',
          headers: { authorization: `Bearer ${ctx.resolve(helpdeskToken)}`, 'content-type': 'application/json' },
          body: JSON.stringify(change),
        });
        if (!response.ok) throw new Error(`helpdesk answered ${response.status}`);
      },
    }),
  )
  .ceiling({ maxUsd: 0.4, onExceed: overBudget });

const escalationSchema = z.object({ conversationId: z.string(), reason: z.string() });
const escalationOpen = H.state('escalation-open').pending();
const escalationHandling = H.state('escalation-handling').active();
const escalationResolved = H.state('escalation-resolved').terminal('success');
const escalationAbandoned = H.state('escalation-abandoned').terminal('failure');
const escalation = H.work('escalation').schema(escalationSchema).states(escalationOpen, escalationHandling, escalationResolved, escalationAbandoned);

const escalationReview = H.halt('escalation-review')
  .context(escalationSchema)
  .ask(c => `Conversation ${c.conversationId} escalated: ${c.reason}`)
  .decision(z.object({ resolution: z.string() }));

const handleEscalation = H.flow('handle-escalation')
  .input(escalationSchema)
  .halt('review', escalationReview, s => s.input)
  .exit('resolved');

const escalations = H.lane(
  'escalations',
  H.handler('handle-escalation')
    .of(escalation)
    .flow(handleEscalation)
    .exits({ resolved: escalationResolved })
    .retry({ tries: 1, backoff: 'none', exhausted: escalationAbandoned }),
).store(sqlite.store('./support/.harness/store.sqlite'));

const auditSchema = z.object({ category: z.string(), rate: z.number(), samples: z.number() });
const auditOpen = H.state('audit-open').pending();
const auditing = H.state('auditing').active();
const auditDone = H.state('audit-done').terminal('success');
const auditRecovered = H.state('audit-recovered').terminal('neutral');
const auditAbandoned = H.state('audit-abandoned').terminal('failure');
const audit = H.work('audit').schema(auditSchema).states(auditOpen, auditing, auditDone, auditRecovered, auditAbandoned);

const auditReview = H.halt('category-audit')
  .context(auditSchema)
  .ask(c => `Approvals for ${c.category} fell to ${c.rate} over ${c.samples} samples. What did you find?`)
  .decision(z.object({ findings: z.string() }));

const runAudit = H.flow('run-audit').input(auditSchema).halt('review', auditReview, s => s.input).exit('done');

const auditCategory = H.facet('audit-category');

const audits = H.lane(
  'audits',
  H.handler('run-audit')
    .of(audit)
    .flow(runAudit)
    .exits({ done: auditDone })
    .retry({ tries: 1, backoff: 'none', exhausted: auditAbandoned }),
)
  .store(sqlite.store('./support/.harness/store.sqlite'))
  .facet(auditCategory, d => d.category);

const humanApprovalRate = H.metric('human-approval-rate').rate(
  H.events.decisions(approval, { resolver: 'human', match: d => d.approved }),
  H.events.decisions(approval, { resolver: 'human' }),
);
const modelErrorRate = H.metric('model-error-rate').rate(H.events.invocations({ outcome: 'failed' }), H.events.invocations());
const auditsOpened = H.metric('audits-opened').count(H.events.created());
const pausedSeconds = H.metric('paused-seconds').sum(H.events.pauses(), 'durationSeconds');

const approvalCrossing = humanApprovalRate.crossing({ below: 0.9, above: 0.95, samples: 50, window: '7d', by: 'resource' });
const errorCrossing = modelErrorRate.crossing({ above: 0.2, below: 0.05, samples: 20, window: '1h' });

const openAudit = H.trigger('approval-fell-open-audit')
  .on(approvalCrossing.falls())
  .do(
    audits.create(p => ({ category: p.key ?? 'unknown', rate: p.value, samples: p.samples }), p => p.key ?? 'unknown'),
    experienceJournal.record(p => ({
      content: {
        text: `when drafting for ${p.key ?? 'this category'}, recall the stricter phrasing, because approvals fell to ${p.value.toFixed(2)}`,
      },
      when: { roles: [drafterRole], resources: categoryNamed(p.key) },
      status: 'candidate',
    })),
  );

const closeAudit = H.trigger('approval-recovered-cancel-audit')
  .on(approvalCrossing.rises())
  .do(audits.move(auditRecovered, p => p.key ?? 'unknown'));

const pauseOnErrors = H.trigger('model-errors-pause').on(errorCrossing.rises()).do(conversations.pause());
const resumeOnRecovery = H.trigger('model-errors-resume').on(errorCrossing.falls()).do(conversations.resume());

const customerReplied = H.trigger('customer-replied')
  .on(conversations.updated())
  .when(p => p.unit.position !== 'terminal' && p.unit.data.lastMessage !== p.previous.lastMessage)
  .do(conversations.move(fresh));

const customerClosed = H.trigger('customer-closed')
  .on(conversations.updated())
  .when(p => p.unit.data.status === 'closed' && p.previous.status === 'open')
  .do(conversations.move(closedByCustomer));

const slaBreached = H.trigger('sla-breached')
  .on(conversations.due(u => (u.position === 'terminal' ? undefined : new Date(u.data.slaDeadline))))
  .do(
    escalations.create(p => ({ conversationId: p.unit.key, reason: `SLA breached at ${p.deadline.toISOString()}` }), p => p.unit.key),
    conversations.move(escalated),
  );

const safeCategory = H.policy.halt('safe-category', approval, input => {
  const reading = input.metrics.read(humanApprovalRate, { where: { resource: categories[input.context.category] } });
  return reading.samples >= 200 && reading.value === 1 ? { approved: true } : undefined;
});

const autoApproveSafe = H.trigger('auto-approve-safe-category').on(approval.opened()).do(H.ops.resolve(approval).by(safeCategory));

const editsBecomeTaste = H.trigger('reviewer-edits-become-taste')
  .on(approval.resolved())
  .when(p => p.resolver === 'human' && p.decision.edited !== undefined)
  .do(
    tasteJournal.record(p => ({
      content: { preference: `prefer "${p.decision.edited ?? ''}" over "${p.context.draft}"` },
      when: { resources: categoryNamed(p.context.category) },
      status: 'candidate',
    })),
  );

const reviewer = claudeCode.client('reviewer', { session: 'support-review' });

export const support = H.harness('support')
  .ledger(sqlite.ledger('./support/.harness/ledger.sqlite'))
  .pools(H.pool('support', [subscription]).serves(haiku, sonnet).policy(policies.soonestExpiring()).fallback(api))
  .lanes(conversations, escalations, audits)
  .journals(tasteJournal, experienceJournal)
  .triggers(
    openAudit,
    closeAudit,
    pauseOnErrors,
    resumeOnRecovery,
    customerReplied,
    customerClosed,
    slaBreached,
    autoApproveSafe,
    editsBecomeTaste,
  )
  .scheduler(
    H.scheduler().policy(
      H.policy.schedule('time-to-breach', input => {
        const monthStart = new Date(Date.UTC(input.now.getUTCFullYear(), input.now.getUTCMonth(), 1));
        const opened = input.metrics.group(auditsOpened, { window: { since: monthStart }, where: { lane: audits }, by: auditCategory });
        const paused = input.metrics.read(pausedSeconds, { window: { since: monthStart }, where: { lane: conversations } });
        const openedFor = (category: string) => opened.find(g => g.key === category)?.value ?? 0;
        const byBreach = [...input.of(conversations)].sort(
          (a, b) => Date.parse(a.unit.data.slaDeadline) - Date.parse(b.unit.data.slaDeadline),
        );
        const byRecurrence = [...input.of(audits)].sort((a, b) => openedFor(b.unit.data.category) - openedFor(a.unit.data.category));
        const auditsFirst = (paused.value ?? 0) > 3600;
        return auditsFirst
          ? [...input.of(escalations), ...byRecurrence, ...byBreach]
          : [...input.of(escalations), ...byBreach, ...byRecurrence];
      }),
    ),
  )
  .grants(
    H.grant(
      reviewer,
      H.ops.resolve(approval),
      H.ops.resolve(overBudget),
      H.ops.resolve(escalationReview),
      H.ops.resolve(auditReview),
      H.ops.work.read,
      H.ops.work.write,
      H.ops.memory.write(tasteJournal),
      H.ops.memory.curate(tasteJournal, experienceJournal),
      H.ops.telemetry.read,
    ),
  )
  .metrics(humanApprovalRate, modelErrorRate, auditsOpened, pausedSeconds)
  .observe(observers.board({ path: './support/BOARD.md' }), observers.telemetry({ path: './support/TELEMETRY.md' }));
