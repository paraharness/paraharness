import { z } from 'zod';
import { H } from 'harness-dsl';
import { linear } from 'harness-dsl/linear';
import { folder } from 'harness-dsl/folder';
import { claudeCode } from 'harness-dsl/claude-code';
import { anthropic } from 'harness-dsl/anthropic';
import { sqlite } from 'harness-dsl/sqlite';
import { jsonl } from 'harness-dsl/jsonl';
import { git } from 'harness-dsl/git';
import { local } from 'harness-dsl/local';
import { markdown } from 'harness-dsl/markdown';

const workstation = local.runner('workstation').slots(4);

const sharedQuota = sqlite.quota('claude-quota', { path: '.harness/quota.sqlite' });
const claudeA = claudeCode.subscription('claude-a', { token: H.env('CLAUDE_A_TOKEN'), quota: sharedQuota });
const claudeB = claudeCode.subscription('claude-b', { token: H.env('CLAUDE_B_TOKEN'), quota: sharedQuota });
const claudeC = claudeCode.subscription('claude-c', { token: H.env('CLAUDE_C_TOKEN'), quota: sharedQuota });
const apiAccount = anthropic.account('anthropic-api', { apiKey: H.env('ANTHROPIC_API_KEY'), quota: sharedQuota });

const soonestExpiring = H.policy.account('soonest-expiring', ({ candidates, now }) =>
  candidates
    .filter(
      (candidate) =>
        candidate.shareUsed < candidate.shareCap &&
        (candidate.cooldownUntil === undefined || candidate.cooldownUntil.getTime() <= now.getTime()),
    )
    .sort((a, b) => a.windowResetsAt.getTime() - b.windowResetsAt.getTime())[0],
);

const subscriptions = H.pool('subscriptions')
  .accounts(claudeA, claudeB, claudeC)
  .share(claudeA, 0.6)
  .share(claudeB, 0.5)
  .share(claudeC, 0.4)
  .drain(soonestExpiring)
  .fallback(apiAccount);

const sonnet = claudeCode.model('sonnet', { id: 'claude-sonnet-4-5' });
const opus = claudeCode.model('opus', { id: 'claude-opus-4-1' });

const builderModel = H.policy.model('builder-model', [sonnet, opus], ({ kind, seat, metrics }) => {
  const cheaper = metrics.attempts({ of: kind, seat, model: sonnet, window: { lastDays: 14 } });
  return cheaper.samples >= 20 && cheaper.successRate < 0.85 ? opus : sonnet;
});

const builderRole = H.role('builder')
  .intents('read', 'edit', 'run', 'search')
  .instructions('Implement the work item in the worktree. Keep changes minimal and covered by tests.');
const auditorRole = H.role('auditor')
  .intents('read', 'run', 'search', 'record')
  .instructions('Find deficits in the change. Report each deficit as one actionable sentence.');
const plannerRole = H.role('planner')
  .intents('read', 'search')
  .instructions('Decompose an epic into independently shippable features.');

const experience = H.memory('experience', 'experience');
const taste = H.memory('taste', 'taste');

const experienceJournal = H.journal('coding-experience', experience)
  .store(jsonl.memoryStore({ path: 'memory/experience.jsonl' }))
  .recall({ by: 'specificity', limit: 12 })
  .readBy(builderRole, auditorRole)
  .recordedBy(auditorRole);

const tasteJournal = H.journal('owner-taste', taste)
  .store(jsonl.memoryStore({ path: 'memory/taste.jsonl' }))
  .recall({ by: 'specificity', limit: 20 })
  .readBy(builderRole, plannerRole);

const ownerDecision = H.halt('owner-decision').decision(
  z.object({ choice: z.string(), note: z.string() }),
);

const projectChecks = H.command('project-checks').argv(['npm', 'run', 'check']).runner(workstation);

const builder = H.seat('builder')
  .role(builderRole)
  .model(builderModel)
  .pool(subscriptions)
  .workspace(git.worktree({ repo: '.', base: 'main' }))
  .guard({ leaseFiles: true, beforeStop: projectChecks })
  .halts(ownerDecision);

const auditor = H.seat('auditor')
  .role(auditorRole)
  .model(sonnet)
  .pool(subscriptions)
  .workspace(git.worktree({ repo: '.', base: 'main' }))
  .output(z.object({ deficits: z.array(z.string()) }));

const planner = H.seat('planner')
  .role(plannerRole)
  .model(opus)
  .pool(subscriptions)
  .output(z.object({ features: z.array(z.object({ title: z.string(), body: z.string() })) }));

const workSchema = z.object({ ref: z.string(), title: z.string(), body: z.string() });

const Todo = H.state('Todo', 'pending');
const Building = H.state('Building', 'active');
const Auditing = H.state('Auditing', 'active');
const Planning = H.state('Planning', 'active');
const AwaitingFeatures = H.state('AwaitingFeatures', 'waiting');
const Done = H.terminal('Done', 'success');
const Stuck = H.terminal('Stuck', 'failure');
const Cancelled = H.terminal('Cancelled', 'neutral');

const Bug = H.kind('Bug')
  .attributes(workSchema)
  .states(Todo, Building, Auditing, Done, Stuck, Cancelled)
  .key((bug) => bug.ref)
  .initial(Todo);

const Feature = H.kind('Feature')
  .attributes(workSchema)
  .states(Todo, Building, Auditing, Done, Stuck, Cancelled)
  .key((feature) => feature.ref)
  .initial(Todo);

const Epic = H.kind('Epic')
  .attributes(workSchema)
  .states(Todo, Planning, AwaitingFeatures, Done, Stuck, Cancelled)
  .key((epic) => epic.ref)
  .initial(Todo);

const Due = H.state('Due', 'pending');
const Probing = H.state('Probing', 'active');
const Healthy = H.terminal('Healthy', 'success');
const Unhealthy = H.terminal('Unhealthy', 'failure');
const Skipped = H.terminal('Skipped', 'neutral');

const Heartbeat = H.kind('ServiceHeartbeat')
  .attributes(z.object({ service: z.string(), scheduledAt: z.string() }))
  .states(Due, Probing, Healthy, Unhealthy, Skipped)
  .key((beat) => `${beat.service}@${beat.scheduledAt}`)
  .initial(Due);

const buildAndAudit = H.flow('build-and-audit')
  .input(workSchema)
  .params(z.object({ rounds: z.number() }))
  .loop(
    'rounds',
    (round) =>
      round
        .step('build', builder, (ctx) => ({
          task: `Round ${ctx.iteration + 1}: implement "${ctx.unit.attributes.title}" and fix every deficit the auditor left in the worktree.\n${ctx.unit.attributes.body}`,
        }))
        .step('audit', auditor, (ctx) => ({
          task: `Audit the change for "${ctx.unit.attributes.title}". Builder notes: ${ctx.steps.build}`,
        })),
    {
      max: (ctx) => ctx.params.rounds,
      until: (ctx) => ctx.steps.audit.deficits.length === 0,
    },
  )
  .exit('clean', (ctx) => ctx.steps.audit.deficits.length === 0)
  .exit('roundsExhausted');

const decomposeEpic = H.flow('decompose-epic')
  .input(workSchema)
  .step('plan', planner, (ctx) => ({
    task: `Decompose the epic "${ctx.unit.attributes.title}" into features.\n${ctx.unit.attributes.body}`,
  }))
  .spawn('features', H.lane('features-placeholder', Feature), () => [])
  .exit('delivered');

const healthCheck = H.command('service-health')
  .input(z.object({ service: z.string() }))
  .argv((input) => ['./scripts/health.sh', input.service])
  .runner(workstation);

const probe = H.flow('probe')
  .input(z.object({ service: z.string(), scheduledAt: z.string() }))
  .step('probe', healthCheck, (ctx) => ({ service: ctx.unit.attributes.service }))
  .exit('healthy');

const trackerKey = H.env('LINEAR_API_KEY');
const tracker = linear.store({
  apiKey: trackerKey,
  team: 'PRODUCT',
  workflow: ['Todo', 'In Progress', 'In Review', 'Done', 'Blocked', 'Canceled'],
});

const services = ['api', 'worker', 'web'];

const heartbeats = H.lane('heartbeats', Heartbeat)
  .supply(H.clock('every-five-minutes').every({ minutes: 5 }), (tick, to) =>
    services.map((service) => to.create({ service, scheduledAt: tick.at.toISOString() })),
  )
  .handler(probe, { exits: { healthy: Healthy }, during: { probe: Probing } })
  .retry({ maxAttempts: 1, backoff: 'fixed', initialDelayMs: 0, exhausted: Unhealthy })
  .on(H.cancel, { enter: Skipped });

const bugs = H.lane('bugs', Bug)
  .supply(linear.issues({ apiKey: trackerKey, team: 'PRODUCT', labels: ['bug'] }), (issue, to) =>
    to.create({ ref: issue.identifier, title: issue.title, body: issue.description }),
  )
  .supply(folder.files({ path: 'inbox/bugs', glob: '*.md' }), (file, to) =>
    to.create({ ref: file.path, title: file.name, body: file.body }),
  )
  .supply(H.operator)
  .store(tracker, {
    Todo: 'Todo',
    Building: 'In Progress',
    Auditing: 'In Review',
    Done: 'Done',
    Stuck: 'Blocked',
    Cancelled: 'Canceled',
  })
  .handler(buildAndAudit, {
    exits: { clean: Done, roundsExhausted: Stuck },
    during: { build: Building, audit: Auditing },
    params: { rounds: 3 },
  })
  .retry({ maxAttempts: 2, backoff: 'exponential', initialDelayMs: 60_000, exhausted: Stuck })
  .on(H.cancel, { enter: Cancelled });

const features = H.lane('features', Feature)
  .supply(linear.issues({ apiKey: trackerKey, team: 'PRODUCT', labels: ['feature'] }), (issue, to) =>
    to.create({ ref: issue.identifier, title: issue.title, body: issue.description }),
  )
  .supply(H.operator)
  .store(tracker, {
    Todo: 'Todo',
    Building: 'In Progress',
    Auditing: 'In Review',
    Done: 'Done',
    Stuck: 'Blocked',
    Cancelled: 'Canceled',
  })
  .handler(buildAndAudit, {
    exits: { clean: Done, roundsExhausted: Stuck },
    during: { build: Building, audit: Auditing },
    params: { rounds: 5 },
  })
  .retry({ maxAttempts: 2, backoff: 'exponential', initialDelayMs: 60_000, exhausted: Stuck })
  .on(H.cancel, { enter: Cancelled });

const epicFlow = H.flow('epic')
  .input(workSchema)
  .step('plan', planner, (ctx) => ({
    task: `Decompose the epic "${ctx.unit.attributes.title}" into features.\n${ctx.unit.attributes.body}`,
  }))
  .spawn('features', features, (ctx) =>
    ctx.steps.plan.features.map((feature, index) => ({
      ref: `${ctx.unit.attributes.ref}#${index + 1}`,
      title: feature.title,
      body: feature.body,
    })),
  )
  .exit('delivered', (ctx) => ctx.steps.features.every((child) => child.verdict === 'success'))
  .exit('partial');

const epics = H.lane('epics', Epic)
  .supply(linear.issues({ apiKey: trackerKey, team: 'PRODUCT', labels: ['epic'] }), (issue, to) =>
    to.create({ ref: issue.identifier, title: issue.title, body: issue.description }),
  )
  .store(tracker, {
    Todo: 'Todo',
    Planning: 'In Progress',
    AwaitingFeatures: 'In Progress',
    Done: 'Done',
    Stuck: 'Blocked',
    Cancelled: 'Canceled',
  })
  .handler(epicFlow, {
    exits: { delivered: Done, partial: Stuck },
    during: { plan: Planning, features: AwaitingFeatures },
  })
  .retry({ maxAttempts: 2, backoff: 'fixed', initialDelayMs: 300_000, exhausted: Stuck })
  .on(H.cancel, { enter: Cancelled });

const heartbeatFailureFilesBug = H.trigger('heartbeat-failure-files-bug')
  .on(H.when.transition(heartbeats, { to: Unhealthy }))
  .create(bugs, (event) => ({
    ref: `heartbeat:${event.unit.attributes.service}`,
    title: `Service ${event.unit.attributes.service} failed its heartbeat`,
    body: `The heartbeat scheduled at ${event.unit.attributes.scheduledAt} failed at ${event.at.toISOString()}.`,
  }));

const scheduler = H.scheduler('coding-team')
  .priority(heartbeats, bugs, features, epics)
  .wip(bugs, 2)
  .wip(epics, 1)
  .boost(features, { afterMinutes: 240 });

const productionHealthProbe = H.operation(
  'production-health-probe',
  H.command('production-health').argv(['curl', '-fsS', 'https://status.example.com/health']).runner(workstation),
);

const supervisor = claudeCode.supervisor('owner').client('coding-supervisor', {
  grants: [
    H.ops.workRead,
    H.ops.workCreate,
    H.ops.workUpdate,
    H.ops.workCancel,
    H.ops.resolve(ownerDecision),
    H.ops.memoryRead,
    H.ops.memoryWrite,
    H.ops.telemetryRead,
    H.ops.accountsRead,
    H.ops.accountsShare,
    productionHealthProbe,
  ],
  port: H.slot.port(1),
});

export const harness = H.harness('coding-team')
  .ledger(sqlite.ledger({ path: '.harness/ledger.sqlite' }))
  .lanes(heartbeats, bugs, features, epics)
  .journals(experienceJournal, tasteJournal)
  .triggers(heartbeatFailureFilesBug)
  .scheduler(scheduler)
  .clients(supervisor)
  .observers(markdown.board({ path: 'BOARD.md' }), markdown.telemetry({ path: 'TELEMETRY.md' }));

void decomposeEpic;
void harness.start();
