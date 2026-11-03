import { z } from 'zod';
import { H } from 'harness-dsl';
import { linear } from 'harness-dsl/linear';
import type { LinearIssue } from 'harness-dsl/linear';
import { folder } from 'harness-dsl/folder';
import { claudeCode } from 'harness-dsl/claude-code';
import { anthropic } from 'harness-dsl/anthropic';
import { sqlite } from 'harness-dsl/sqlite';
import { jsonl } from 'harness-dsl/jsonl';
import { git } from 'harness-dsl/git';
import { local } from 'harness-dsl/local';
import { markdown } from 'harness-dsl/markdown';

const areaSchema = z.enum(['payments', 'checkout', 'platform']);
type Area = z.infer<typeof areaSchema>;
const workItem = z.object({ ref: z.string(), title: z.string(), body: z.string(), area: areaSchema });
type WorkItem = z.infer<typeof workItem>;
const epicItem = z.object({ ref: z.string(), title: z.string(), body: z.string() });
const heartbeatItem = z.object({ service: z.string() });

const areaResources = {
  payments: H.resource('payments'),
  checkout: H.resource('checkout'),
  platform: H.resource('platform'),
};
const areaOf = (labels: readonly string[]): Area =>
  labels.includes('payments') ? 'payments' : labels.includes('checkout') ? 'checkout' : 'platform';
const issueItem = (issue: LinearIssue): WorkItem => ({
  ref: issue.identifier,
  title: issue.title,
  body: issue.description,
  area: areaOf(issue.labels),
});

const Todo = H.state('Todo', 'pending');
const Triage = H.state('Triage', 'waiting');
const Done = H.terminal('Done', 'success');
const Abandoned = H.terminal('Abandoned', 'failure');
const Canceled = H.terminal('Canceled', 'neutral');
const Due = H.state('Due', 'pending');
const Healthy = H.terminal('Healthy', 'success');
const Unhealthy = H.terminal('Unhealthy', 'failure');

const Bug = H.kind('Bug').attributes(workItem).states(Todo, Triage, Done, Abandoned, Canceled).key(a => a.ref);
const Feature = H.kind('Feature').attributes(workItem).states(Todo, Triage, Done, Abandoned, Canceled).key(a => a.ref);
const Epic = H.kind('Epic').attributes(epicItem).states(Todo, Triage, Done, Abandoned, Canceled).key(a => a.ref);
const Heartbeat = H.kind('ServiceHeartbeat').attributes(heartbeatItem).states(Due, Healthy, Unhealthy).key(a => a.service);

const quota = sqlite.quota('claude-accounts', { path: '.harness/quota.db' });
const subscriptionA = claudeCode.subscription('subscription-a', { token: H.env('CLAUDE_TOKEN_A'), quota });
const subscriptionB = claudeCode.subscription('subscription-b', { token: H.env('CLAUDE_TOKEN_B'), quota });
const subscriptionC = claudeCode.subscription('subscription-c', { token: H.env('CLAUDE_TOKEN_C'), quota });
const apiAccount = anthropic.account('api-fallback', { apiKey: H.env('ANTHROPIC_API_KEY'), quota });

const soonestExpiring = H.policy.account('soonest-expiring-first', ({ candidates, now }) =>
  [...candidates]
    .filter(c => c.shareUsed < c.shareCap && (c.cooldownUntil === undefined || c.cooldownUntil.getTime() <= now.getTime()))
    .sort((a, b) => a.windowResetsAt.getTime() - b.windowResetsAt.getTime())[0]);

const subscriptions = H.pool('subscriptions')
  .accounts(subscriptionA, subscriptionB, subscriptionC)
  .share(subscriptionA, 0.5)
  .share(subscriptionB, 0.5)
  .share(subscriptionC, 0.3)
  .drain(soonestExpiring)
  .fallback(apiAccount);

const sonnet = claudeCode.model('sonnet', { id: 'claude-sonnet-4-5' });
const opus = claudeCode.model('opus', { id: 'claude-opus-4-5' });

const builderModel = H.policy.model('builder-model', [sonnet, opus], ({ kind, seat, metrics }) => {
  const cheaper = metrics.attempts({ of: kind, seat, model: sonnet, window: { lastDays: 14 } });
  return cheaper.samples >= 20 && cheaper.successRate < 0.85 ? opus : sonnet;
});

const builder = H.role('builder')
  .intents('read', 'edit', 'run', 'search')
  .instructions('Implement the task. Address every deficit from earlier rounds. If an owner decision is needed, put it in question.');
const auditor = H.role('auditor')
  .intents('read', 'run', 'record')
  .instructions('Find deficits in the change. Report none only when the work is complete.');
const planner = H.role('planner')
  .intents('read', 'search')
  .instructions('Decompose the epic into independently deliverable features.');

const localRunner = local.runner('local').slots(4);
const projectChecks = H.command('project-checks').argv(['npm', 'run', 'check']).runner(localRunner);
const probeService = H.command('probe-service')
  .input(heartbeatItem)
  .argv(i => ['./scripts/probe', i.service])
  .output(z.object({ healthy: z.boolean(), detail: z.string() }))
  .runner(localRunner);
const probeProduction = H.command('probe-production')
  .argv(['./scripts/probe-production'])
  .output(z.object({ healthy: z.boolean(), detail: z.string() }))
  .runner(localRunner);

const worktree = git.worktree({ repo: '.', base: 'main' });

const builderSeat = H.seat('builder')
  .role(builder)
  .model(builderModel)
  .pool(subscriptions)
  .output(z.object({ summary: z.string(), question: z.string().optional() }))
  .workspace(worktree, { leaseFiles: true, beforeStop: projectChecks });

const auditorSeat = H.seat('auditor')
  .role(auditor)
  .model(opus)
  .pool(subscriptions)
  .output(z.object({ deficits: z.array(z.object({ file: z.string(), problem: z.string() })) }))
  .workspace(worktree);

const plannerSeat = H.seat('planner')
  .role(planner)
  .model(opus)
  .pool(subscriptions)
  .output(z.object({ features: z.array(z.object({ slug: z.string(), title: z.string(), body: z.string(), area: areaSchema })) }));

const ownerDecision = H.halt('owner-decision').decision(z.object({ answer: z.string() }));

const deliver = H.flow('deliver')
  .input(workItem)
  .params(z.object({ rounds: z.number() }))
  .loop(
    'rounds',
    z.object({ deficits: z.array(z.string()), ownerAnswer: z.string().optional() }),
    body => body
      .step('build', builderSeat, ctx => ({
        task: [
          ctx.unit.attributes.title,
          ctx.unit.attributes.body,
          ...ctx.steps.rounds.map((round, index) =>
            `Round ${index + 1} deficits: ${round.deficits.join('; ')}${round.ownerAnswer ? `. Owner answered: ${round.ownerAnswer}` : ''}`),
        ].join('\n\n'),
        resources: [areaResources[ctx.unit.attributes.area]],
      }))
      .halt('askOwner', ownerDecision, {
        when: ctx => ctx.steps.build.question !== undefined,
        ask: ctx => ctx.steps.build.question ?? '',
      })
      .step('audit', auditorSeat, ctx => ({
        task: `Audit the change for "${ctx.unit.attributes.title}". Builder summary: ${ctx.steps.build.summary}${ctx.steps.askOwner ? `. Owner decided: ${ctx.steps.askOwner.answer}` : ''}`,
        resources: [areaResources[ctx.unit.attributes.area]],
      })),
    {
      max: ctx => ctx.params.rounds,
      until: ctx => ctx.steps.audit.deficits.length === 0,
      feed: ctx => ({
        deficits: ctx.steps.audit.deficits.map(d => `${d.file}: ${d.problem}`),
        ownerAnswer: ctx.steps.askOwner?.answer,
      }),
    },
  )
  .exit('clean', ctx => ctx.steps.audit.deficits.length === 0)
  .exit('unresolved');

const heartbeatFlow = H.flow('heartbeat')
  .input(heartbeatItem)
  .step('probe', probeService, ctx => ({ service: ctx.unit.attributes.service }))
  .exit('healthy', ctx => ctx.steps.probe.healthy)
  .exit('unhealthy');

const linearKey = H.env('LINEAR_API_KEY');
const tracker = linear.store({
  apiKey: linearKey,
  team: 'ENG',
  workflow: ['Todo', 'In Progress', 'Triage', 'Done', 'Canceled'],
});

const bugs = H.lane('bugs', Bug)
  .supply(linear.issues({ apiKey: linearKey, team: 'ENG', labels: ['bug'] }), (issue, to) => to.create(issueItem(issue)))
  .supply(folder.files({ path: 'bugs', glob: '*.md' }), (file, to) =>
    to.create({ ref: `file:${file.name}`, title: file.name, body: file.body, area: 'platform' }))
  .supply(H.operator)
  .store(tracker, {
    states: { Todo: 'Todo', Triage: 'Triage', Done: 'Done', Abandoned: 'Canceled', Canceled: 'Canceled' },
    inFlight: 'In Progress',
  })
  .handler(deliver, { exits: { clean: Done, unresolved: Triage }, params: { rounds: 3 } })
  .retry({ maxAttempts: 2, backoff: 'exponential', initialDelayMs: 60000, exhausted: Abandoned })
  .on(H.cancel, { enter: Canceled });

const features = H.lane('features', Feature)
  .supply(linear.issues({ apiKey: linearKey, team: 'ENG', labels: ['feature'] }), (issue, to) => to.create(issueItem(issue)))
  .supply(H.operator)
  .store(tracker, {
    states: { Todo: 'Todo', Triage: 'Triage', Done: 'Done', Abandoned: 'Canceled', Canceled: 'Canceled' },
    inFlight: 'In Progress',
  })
  .handler(deliver, { exits: { clean: Done, unresolved: Triage }, params: { rounds: 5 } })
  .retry({ maxAttempts: 2, backoff: 'exponential', initialDelayMs: 60000, exhausted: Abandoned })
  .on(H.cancel, { enter: Canceled });

const planEpic = H.flow('plan-epic')
  .input(epicItem)
  .step('plan', plannerSeat, ctx => ({
    task: `Decompose this epic into features.\n\n${ctx.unit.attributes.title}\n\n${ctx.unit.attributes.body}`,
  }))
  .spawn('features', features, (ctx): WorkItem[] =>
    ctx.steps.plan.features.map(f => ({
      ref: `${ctx.unit.attributes.ref}/${f.slug}`,
      title: f.title,
      body: f.body,
      area: f.area,
    })))
  .exit('complete', ctx => ctx.steps.features.every(child => child.verdict === 'success'))
  .exit('incomplete');

const epics = H.lane('epics', Epic)
  .supply(linear.issues({ apiKey: linearKey, team: 'ENG', labels: ['epic'] }), (issue, to) =>
    to.create({ ref: issue.identifier, title: issue.title, body: issue.description }))
  .store(tracker, {
    states: { Todo: 'Todo', Triage: 'Triage', Done: 'Done', Abandoned: 'Canceled', Canceled: 'Canceled' },
    inFlight: 'In Progress',
  })
  .handler(planEpic, { exits: { complete: Done, incomplete: Triage } })
  .retry({ maxAttempts: 2, backoff: 'exponential', initialDelayMs: 60000, exhausted: Abandoned })
  .on(H.cancel, { enter: Canceled });

const services = ['checkout-api', 'payments-api', 'web'];

const heartbeats = H.lane('heartbeats', Heartbeat)
  .supply(H.clock('every-five-minutes').every({ minutes: 5 }), (_tick, to) => services.map(service => to.create({ service })))
  .handler(heartbeatFlow, { exits: { healthy: Healthy, unhealthy: Unhealthy } })
  .retry({ maxAttempts: 1, exhausted: Unhealthy });

const heartbeatFailure = H.trigger('failed-heartbeat-files-bug')
  .on(H.when.transition(heartbeats, { to: Unhealthy }))
  .create(bugs, (event): WorkItem => ({
    ref: `heartbeat:${event.unit.attributes.service}`,
    title: `${event.unit.attributes.service} heartbeat failed`,
    body: `The heartbeat for ${event.unit.attributes.service} failed at ${event.at.toISOString()}.`,
    area: 'platform',
  }));

const experienceJournal = H.journal('coding-experience', H.memory('experience', 'experience'))
  .store(jsonl.memoryStore({ path: '.harness/experience.jsonl' }))
  .recall({ by: 'specificity', limit: 12 })
  .readBy(builder, auditor)
  .recordedBy(auditor);

const tasteJournal = H.journal('owner-taste', H.memory('taste', 'taste'))
  .store(jsonl.memoryStore({ path: '.harness/taste.jsonl' }))
  .recall({ by: 'specificity', limit: 12 })
  .readBy(builder, planner);

const scheduler = H.scheduler('coding-team')
  .standard(heartbeats, bugs, features, epics)
  .wip(bugs, 2)
  .wip(epics, 1)
  .aging(features, { afterMinutes: 240 });

const supervisor = claudeCode.supervisor('supervisor', {
  port: H.slot.port(1),
  grants: [
    H.ops.workRead,
    H.ops.workCreate,
    H.ops.workUpdate,
    H.ops.workCancel,
    H.ops.resolve(ownerDecision),
    H.ops.memoryWrite,
    H.ops.telemetryRead,
    H.ops.accountsShare,
    H.operation('production-health-probe', probeProduction),
  ],
});

const harness = H.harness('coding-team')
  .ledger(sqlite.ledger({ path: '.harness/ledger.db' }))
  .lanes(heartbeats, bugs, features, epics)
  .journals(experienceJournal, tasteJournal)
  .triggers(heartbeatFailure)
  .scheduler(scheduler)
  .clients(supervisor)
  .observers(markdown.board({ path: 'BOARD.md' }), markdown.telemetry({ path: 'TELEMETRY.md' }));

void harness.start();
