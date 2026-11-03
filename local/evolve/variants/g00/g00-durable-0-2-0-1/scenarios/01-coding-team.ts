import { z } from 'zod';
import { H } from 'harness-dsl';
import { sqlite } from 'harness-dsl/sqlite';
import { jsonl } from 'harness-dsl/jsonl';
import { claudeCode } from 'harness-dsl/claude-code';
import { anthropic } from 'harness-dsl/anthropic';
import { linear } from 'harness-dsl/linear';
import { folder } from 'harness-dsl/folder';
import { git } from 'harness-dsl/git';
import { local } from 'harness-dsl/local';
import { markdown } from 'harness-dsl/markdown';

const ticket = z.object({ ref: z.string(), title: z.string(), body: z.string() });
const epicAttrs = z.object({ ref: z.string(), title: z.string(), body: z.string() });
const serviceAttrs = z.object({ service: z.string() });

const Todo = H.state('Todo', 'pending');
const Building = H.state('Building', 'active');
const Auditing = H.state('Auditing', 'active');
const Done = H.terminal('Done', 'success');
const Abandoned = H.terminal('Abandoned', 'neutral');
const Exhausted = H.terminal('Exhausted', 'failure');

const Bug = H.kind('Bug')
  .attributes(ticket)
  .states(Todo, Building, Auditing, Done, Abandoned, Exhausted)
  .key((attrs) => attrs.ref)
  .initial(Todo)
  .onCancelled(Abandoned);

const Feature = H.kind('Feature')
  .attributes(ticket)
  .states(Todo, Building, Auditing, Done, Abandoned, Exhausted)
  .key((attrs) => attrs.ref)
  .initial(Todo)
  .onCancelled(Abandoned);

const Planned = H.state('Planned', 'pending');
const Decomposing = H.state('Decomposing', 'active');
const AwaitingFeatures = H.state('AwaitingFeatures', 'waiting');
const EpicDone = H.terminal('EpicDone', 'success');
const EpicDropped = H.terminal('EpicDropped', 'neutral');
const EpicStalled = H.terminal('EpicStalled', 'failure');

const Epic = H.kind('Epic')
  .attributes(epicAttrs)
  .states(Planned, Decomposing, AwaitingFeatures, EpicDone, EpicDropped, EpicStalled)
  .key((attrs) => attrs.ref)
  .initial(Planned)
  .onCancelled(EpicDropped);

const HeartbeatDue = H.state('HeartbeatDue', 'pending');
const Probing = H.state('Probing', 'active');
const Healthy = H.terminal('Healthy', 'success');
const Unhealthy = H.terminal('Unhealthy', 'failure');

const ServiceHeartbeat = H.kind('ServiceHeartbeat')
  .attributes(serviceAttrs)
  .states(HeartbeatDue, Probing, Healthy, Unhealthy)
  .key((attrs) => attrs.service)
  .initial(HeartbeatDue)
  .onAttemptFailed(Unhealthy);

const builderRole = H.role('builder')
  .intents('read', 'edit', 'run', 'search', 'halt')
  .instructions('Implement the work item in the worktree. Halt for the owner when a product decision is needed.');
const auditorRole = H.role('auditor')
  .intents('read', 'search', 'run', 'record')
  .instructions('Find deficits in the change against the work item. Record forward-phrased experience when you find a lesson.');
const plannerRole = H.role('planner')
  .intents('read', 'search')
  .instructions('Decompose the epic into independently shippable features.');

const subscriptionA = claudeCode.subscription('claude-subscription-a', { token: H.env('CLAUDE_SUBSCRIPTION_A_TOKEN') });
const subscriptionB = claudeCode.subscription('claude-subscription-b', { token: H.env('CLAUDE_SUBSCRIPTION_B_TOKEN') });
const subscriptionC = claudeCode.subscription('claude-subscription-c', { token: H.env('CLAUDE_SUBSCRIPTION_C_TOKEN') });
const apiAccount = anthropic.account('anthropic-api', { apiKey: H.env('ANTHROPIC_API_KEY') });

const soonestExpiringFirst = H.policy.account('soonest-expiring-first', (ctx) =>
  ctx.candidates
    .filter((state) => state.shareUsed < state.shareCap)
    .filter((state) => state.cooldownUntil === undefined || state.cooldownUntil.getTime() <= ctx.now.getTime())
    .sort((left, right) => left.windowResetsAt.getTime() - right.windowResetsAt.getTime())[0],
);

const subscriptions = H.pool('claude-subscriptions')
  .accounts(subscriptionA, subscriptionB, subscriptionC)
  .share(subscriptionA, 0.5)
  .share(subscriptionB, 0.5)
  .share(subscriptionC, 0.8)
  .drain(soonestExpiringFirst)
  .fallback(apiAccount);

const sonnet = claudeCode.model('sonnet', { id: 'claude-sonnet-4-5' });
const opus = claudeCode.model('opus', { id: 'claude-opus-4-1' });

const builderModel = H.policy.model('cheaper-until-it-slips', [sonnet, opus], (ctx) => {
  const cheaper = ctx.metrics.attempts({ of: ctx.kind, model: sonnet, window: { lastDays: 14 } });
  return cheaper.samples >= 20 && cheaper.successRate < 0.85 ? opus : sonnet;
});

const localRunner = local.runner('local');

const projectChecks = H.command('project-checks').argv(['npm', 'run', 'check']).runner(localRunner);
const heartbeatProbe = H.command('heartbeat-probe')
  .input(serviceAttrs)
  .argv((input) => ['./ops/heartbeat.sh', input.service])
  .runner(localRunner);
const productionHealth = H.command('production-health').argv(['./ops/health.sh', 'production']).runner(localRunner);

const deficitReport = z.object({ deficits: z.array(z.string()) });
const featurePlan = z.object({
  features: z.array(z.object({ slug: z.string(), title: z.string(), body: z.string() })),
});

const builder = H.agent('builder')
  .role(builderRole)
  .model(builderModel)
  .pool(subscriptions)
  .workspace(git.worktree({ repo: '.', base: 'main' }))
  .guard({ leaseFiles: true, beforeStop: projectChecks });

const auditor = H.agent('auditor').role(auditorRole).model(sonnet).pool(subscriptions).output(deficitReport);

const planner = H.agent('planner').role(plannerRole).model(opus).pool(subscriptions).output(featurePlan);

const buildAndAudit = H.flow('build-and-audit')
  .input(ticket)
  .params(z.object({ rounds: z.number().int().positive() }))
  .loop(
    'rounds',
    (round) =>
      round
        .step('build', builder, (ctx) => ({
          task: `Implement ${ctx.unit.attributes.ref}: ${ctx.unit.attributes.title}\n\n${ctx.unit.attributes.body}`,
        }))
        .step('audit', auditor, (ctx) => ({
          task: `Audit the change for ${ctx.unit.attributes.ref} against:\n${ctx.unit.attributes.body}\n\nBuilder report:\n${ctx.steps.build}`,
        })),
    {
      max: (ctx) => ctx.params.rounds,
      until: (ctx) => ctx.steps.audit.deficits.length === 0,
    },
  )
  .exit('clean', (ctx) => ctx.steps.audit.deficits.length === 0)
  .exit('roundsExhausted');

const heartbeatFlow = H.flow('heartbeat')
  .input(serviceAttrs)
  .step('probe', heartbeatProbe, (ctx) => ({ service: ctx.unit.attributes.service }), { afterCrash: 'rerun' })
  .exit('healthy');

const tracker = linear.store({
  apiKey: H.env('LINEAR_API_KEY'),
  team: 'PRODUCT',
  workflow: ['Todo', 'In Progress', 'In Review', 'Done', 'Canceled', 'Needs Owner'],
});

const features = H.lane('features', Feature)
  .supply(linear.issues({ apiKey: H.env('LINEAR_API_KEY'), team: 'PRODUCT', labels: ['feature'] }), (issue, to) =>
    to.create({ ref: issue.identifier, title: issue.title, body: issue.description }),
  )
  .supply(H.operator)
  .store(tracker, {
    Todo: 'Todo',
    Building: 'In Progress',
    Auditing: 'In Review',
    Done: 'Done',
    Abandoned: 'Canceled',
    Exhausted: 'Needs Owner',
  })
  .handler(buildAndAudit, {
    exits: { clean: Done, roundsExhausted: Exhausted },
    during: { build: Building, audit: Auditing },
    params: { rounds: 5 },
  })
  .retry({ maxAttempts: 3, backoff: 'exponential', initialDelayMs: 60_000, exhausted: Exhausted });

const bugs = H.lane('bugs', Bug)
  .supply(linear.issues({ apiKey: H.env('LINEAR_API_KEY'), team: 'PRODUCT', labels: ['bug'] }), (issue, to) =>
    to.create({ ref: issue.identifier, title: issue.title, body: issue.description }),
  )
  .supply(folder.files({ path: 'bugs/inbox', glob: '*.md' }), (file, to) =>
    to.create({ ref: `file:${file.path}`, title: file.name, body: file.body }),
  )
  .supply(H.operator)
  .store(tracker, {
    Todo: 'Todo',
    Building: 'In Progress',
    Auditing: 'In Review',
    Done: 'Done',
    Abandoned: 'Canceled',
    Exhausted: 'Needs Owner',
  })
  .handler(buildAndAudit, {
    exits: { clean: Done, roundsExhausted: Exhausted },
    during: { build: Building, audit: Auditing },
    params: { rounds: 3 },
  })
  .retry({ maxAttempts: 3, backoff: 'exponential', initialDelayMs: 60_000, exhausted: Exhausted });

const decomposeEpic = H.flow('decompose-epic')
  .input(epicAttrs)
  .step('plan', planner, (ctx) => ({
    task: `Decompose epic ${ctx.unit.attributes.ref}: ${ctx.unit.attributes.title}\n\n${ctx.unit.attributes.body}`,
  }))
  .spawn('features', features, (ctx) =>
    ctx.steps.plan.features.map((feature) => ({
      ref: `${ctx.unit.attributes.ref}/${feature.slug}`,
      title: feature.title,
      body: feature.body,
    })),
  )
  .exit('complete', (ctx) => ctx.steps.features.every((child) => child.verdict === 'success'))
  .exit('incomplete');

const epics = H.lane('epics', Epic)
  .supply(linear.issues({ apiKey: H.env('LINEAR_API_KEY'), team: 'PRODUCT', labels: ['epic'] }), (issue, to) =>
    to.create({ ref: issue.identifier, title: issue.title, body: issue.description }),
  )
  .store(tracker, {
    Planned: 'Todo',
    Decomposing: 'In Progress',
    AwaitingFeatures: 'In Progress',
    EpicDone: 'Done',
    EpicDropped: 'Canceled',
    EpicStalled: 'Needs Owner',
  })
  .handler(decomposeEpic, {
    exits: { complete: EpicDone, incomplete: EpicStalled },
    during: { plan: Decomposing, features: AwaitingFeatures },
  })
  .retry({ maxAttempts: 2, backoff: 'exponential', initialDelayMs: 300_000, exhausted: EpicStalled });

const monitoredServices = ['api', 'web', 'worker'];

const heartbeats = H.lane('heartbeats', ServiceHeartbeat)
  .supply(H.clock('every-five-minutes').every({ minutes: 5 }), (tick, to) =>
    monitoredServices.map((service) => to.create({ service })),
  )
  .handler(heartbeatFlow, { exits: { healthy: Healthy }, during: { probe: Probing } });

const failedHeartbeatFilesBug = H.trigger('failed-heartbeat-files-bug')
  .on(H.when.transition(heartbeats, { to: Unhealthy }))
  .create(bugs, (event) => ({
    ref: `heartbeat:${event.unit.attributes.service}`,
    title: `Service ${event.unit.attributes.service} failed its heartbeat`,
    body: `The heartbeat probe for ${event.unit.attributes.service} failed at ${event.at.toISOString()}.`,
  }));

const experience = H.memory('experience', 'experience');
const taste = H.memory('taste', 'taste');

const codingExperience = H.journal('coding-experience', experience)
  .store(jsonl.memoryStore({ path: '.harness/experience.jsonl' }))
  .recall({ by: 'specificity', limit: 8 })
  .readBy(builderRole, auditorRole)
  .recordedBy(auditorRole);

const ownerTaste = H.journal('owner-taste', taste)
  .store(jsonl.memoryStore({ path: '.harness/taste.jsonl' }))
  .recall({ by: 'specificity', limit: 12 })
  .readBy(builderRole, plannerRole);

const productionHealthProbe = H.operation('production-health-probe', productionHealth);

const supervisor = claudeCode.supervisor('supervisor', {
  grants: [
    H.ops.workRead,
    H.ops.workCreate,
    H.ops.workUpdate,
    H.ops.workCancel,
    H.ops.blockersResolve,
    H.ops.memoryWrite,
    H.ops.telemetryRead,
    H.ops.accountsRead,
    H.ops.accountsShare,
    productionHealthProbe,
  ],
});

const scheduler = H.scheduler('coding-team')
  .priority(heartbeats, bugs, features, epics)
  .wip(bugs, 2)
  .wip(epics, 1)
  .boost(features, { afterMinutes: 240 });

export const codingTeam = H.harness('coding-team')
  .ledger(sqlite.ledger({ path: '.harness/ledger.db' }))
  .lanes(heartbeats, bugs, features, epics)
  .journals(codingExperience, ownerTaste)
  .triggers(failedHeartbeatFilesBug)
  .scheduler(scheduler)
  .clients(supervisor)
  .observers(markdown.board({ path: '.harness/BOARD.md' }), markdown.telemetry({ path: '.harness/TELEMETRY.md' }));

void codingTeam.start();
