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

const Open = H.state('Open', 'pending');
const NeedsOwner = H.state('NeedsOwner', 'waiting');
const Shipped = H.terminal('Shipped', 'success');
const Dropped = H.terminal('Dropped', 'neutral');
const HeartbeatDue = H.state('HeartbeatDue', 'pending');
const Healthy = H.terminal('Healthy', 'success');
const Unhealthy = H.terminal('Unhealthy', 'failure');

const workItem = z.object({ title: z.string(), body: z.string() });

const bugKind = H.kind('Bug')
  .attributes(workItem)
  .states(Open, NeedsOwner, Shipped, Dropped)
  .initial(Open);

const featureKind = H.kind('Feature')
  .attributes(z.object({ title: z.string(), body: z.string(), epicKey: z.string().optional() }))
  .states(Open, NeedsOwner, Shipped, Dropped)
  .initial(Open);

const epicKind = H.kind('Epic')
  .attributes(workItem)
  .states(Open, NeedsOwner, Shipped)
  .initial(Open);

const heartbeatKind = H.kind('ServiceHeartbeat')
  .attributes(z.object({ service: z.string() }))
  .states(HeartbeatDue, Healthy, Unhealthy)
  .initial(HeartbeatDue);

const ownerDecision = H.halt('owner-decision')
  .decision(z.object({ choice: z.string(), note: z.string().optional() }));

const claudeQuota = sqlite.quota('claude-quota', { path: '.harness/claude-quota.sqlite' });
const subscriptionA = claudeCode.subscription('claude-sub-a', { token: H.env('CLAUDE_SUB_A_TOKEN'), quota: claudeQuota });
const subscriptionB = claudeCode.subscription('claude-sub-b', { token: H.env('CLAUDE_SUB_B_TOKEN'), quota: claudeQuota });
const subscriptionC = claudeCode.subscription('claude-sub-c', { token: H.env('CLAUDE_SUB_C_TOKEN'), quota: claudeQuota });
const apiAccount = anthropic.account('anthropic-api', { apiKey: H.env('ANTHROPIC_API_KEY'), quota: claudeQuota });

const soonestExpiringFirst = H.policy.account('soonest-expiring-first', ctx =>
  [...ctx.candidates]
    .filter(a => a.cooldownUntil === undefined || a.cooldownUntil.getTime() < ctx.now.getTime())
    .filter(a => a.shareUsed < a.shareCap)
    .sort((a, b) => a.windowResetsAt.getTime() - b.windowResetsAt.getTime())[0]);

const claudePool = H.pool('claude')
  .accounts(subscriptionA, subscriptionB, subscriptionC)
  .share(subscriptionA, 0.5)
  .share(subscriptionB, 0.3)
  .share(subscriptionC, 0.2)
  .drain(soonestExpiringFirst)
  .fallback(apiAccount);

const sonnet = claudeCode.model('sonnet', { id: 'claude-sonnet-4-5' });
const opus = claudeCode.model('opus', { id: 'claude-opus-4-1' });

const builderModel = H.policy.model('builder-model', [sonnet, opus], ctx => {
  const cheaper = ctx.metrics.attempts({ of: ctx.kind, seat: ctx.seat, model: sonnet, window: { lastDays: 14 } });
  return cheaper.samples >= 20 && cheaper.successRate < 0.85 ? opus : sonnet;
});

const localRunner = local.runner('local');

const projectChecks = H.command('project-checks')
  .argv(['npm', 'run', 'check'])
  .runner(localRunner);

const worktree = git.worktree({ repo: '.', base: 'main' })
  .guard({ leaseFiles: true, beforeStop: projectChecks });

const builderRole = H.role('builder')
  .intents('read', 'edit', 'run', 'search', 'halt')
  .instructions('Implement the work item in the worktree until the project checks pass.');
const auditorRole = H.role('auditor')
  .intents('read', 'run', 'search', 'record')
  .instructions('List every deficit between the work item and the change. Record lessons as experience.');
const plannerRole = H.role('planner')
  .intents('read', 'search')
  .instructions('Decompose the epic into independently shippable features.');

const builder = H.seat('builder')
  .role(builderRole)
  .model(builderModel)
  .pool(claudePool)
  .workspace(worktree)
  .halts(ownerDecision);

const auditor = H.seat('auditor')
  .role(auditorRole)
  .model(opus)
  .pool(claudePool)
  .workspace(worktree)
  .output(z.object({ deficits: z.array(z.string()) }));

const planner = H.seat('planner')
  .role(plannerRole)
  .model(sonnet)
  .pool(claudePool)
  .output(z.object({ features: z.array(workItem) }));

const experience = H.journal('engineering-experience', H.memory('experience', 'experience'))
  .store(jsonl.memoryStore({ path: '.harness/memory/experience.jsonl' }))
  .recall({ by: 'specificity', limit: 8 })
  .readBy(builderRole, auditorRole)
  .recordedBy(auditorRole);

const taste = H.journal('owner-taste', H.memory('taste', 'taste'))
  .store(jsonl.memoryStore({ path: '.harness/memory/taste.jsonl' }))
  .recall({ by: 'specificity', limit: 12 })
  .readBy(builderRole, plannerRole);

const deliver = H.flow('deliver')
  .input(workItem)
  .params(z.object({ rounds: z.number() }))
  .loop('rounds', { schema: z.array(z.string()), initial: [] }, round => round
    .step('build', builder, ctx => ({
      task: [
        `Work item: ${ctx.unit.attributes.title}`,
        ctx.unit.attributes.body,
        ctx.steps.rounds.length === 0 ? 'First round.' : `Fix these deficits:\n${ctx.steps.rounds.join('\n')}`,
      ].join('\n\n'),
    }), { afterCrash: 'askDriver' })
    .step('audit', auditor, ctx => ({
      task: `Audit the change for: ${ctx.unit.attributes.title}\n\n${ctx.unit.attributes.body}`,
    }), { afterCrash: 'rerun' }),
  {
    max: ctx => ctx.params.rounds,
    until: ctx => ctx.steps.audit.deficits.length === 0,
    next: ctx => ctx.steps.audit.deficits,
  })
  .exit('shipped', ctx => ctx.steps.audit.deficits.length === 0)
  .exit('unfinished');

const decompose = H.flow('decompose')
  .input(workItem)
  .step('plan', planner, ctx => ({ task: `Decompose this epic:\n${ctx.unit.attributes.title}\n\n${ctx.unit.attributes.body}` }))
  .spawn('features', features(), ctx => ctx.steps.plan.features.map(f => ({ title: f.title, body: f.body, epicKey: ctx.unit.key })))
  .exit('completed', ctx => ctx.steps.features.every(child => child.verdict === 'success'))
  .exit('incomplete');

const heartbeat = H.flow('heartbeat')
  .input(z.object({ service: z.string() }))
  .step('probe', H.command('heartbeat-probe')
    .input(z.object({ service: z.string() }))
    .argv(i => ['./scripts/heartbeat.sh', i.service])
    .acceptExitCodes(0, 1)
    .runner(localRunner), ctx => ({ service: ctx.unit.attributes.service }))
  .exit('healthy', ctx => ctx.steps.probe.exitCode === 0)
  .exit('unhealthy');

const tracker = linear.store({
  apiKey: H.env('LINEAR_API_KEY'),
  team: 'ENG',
  workflow: ['Todo', 'In Progress', 'In Review', 'Blocked', 'Done', 'Canceled'],
});

const bugs = H.lane('bugs', bugKind)
  .supply(linear.issues({ apiKey: H.env('LINEAR_API_KEY'), team: 'ENG', labels: ['bug'] }), (issue, to) =>
    to.create({ title: issue.title, body: issue.description }))
  .supply(folder.files({ path: './inbox/bugs', glob: '*.md' }), (file, to) =>
    to.create({ title: file.name, body: file.body }))
  .supply(H.operator)
  .handler(deliver, { exits: { shipped: Shipped, unfinished: NeedsOwner }, params: { rounds: 3 } })
  .store(tracker, {
    states: { Open: 'Todo', NeedsOwner: 'Blocked', Shipped: 'Done', Dropped: 'Canceled' },
    inFlight: 'In Progress',
    steps: { audit: 'In Review' },
  })
  .retry({ maxAttempts: 2, backoff: 'fixed', initialDelayMs: 300_000, exhausted: NeedsOwner });

function features() {
  return featureLane;
}

const featureLane = H.lane('features', featureKind)
  .supply(linear.issues({ apiKey: H.env('LINEAR_API_KEY'), team: 'ENG', labels: ['feature'] }), (issue, to) =>
    to.create({ title: issue.title, body: issue.description }))
  .supply(H.operator)
  .handler(deliver, { exits: { shipped: Shipped, unfinished: NeedsOwner }, params: { rounds: 5 } })
  .store(tracker, {
    states: { Open: 'Todo', NeedsOwner: 'Blocked', Shipped: 'Done', Dropped: 'Canceled' },
    inFlight: 'In Progress',
    steps: { audit: 'In Review' },
  })
  .retry({ maxAttempts: 2, backoff: 'fixed', initialDelayMs: 300_000, exhausted: NeedsOwner });

const epics = H.lane('epics', epicKind)
  .supply(linear.issues({ apiKey: H.env('LINEAR_API_KEY'), team: 'ENG', labels: ['epic'] }), (issue, to) =>
    to.create({ title: issue.title, body: issue.description }))
  .handler(decompose, { exits: { completed: Shipped, incomplete: NeedsOwner } })
  .store(tracker, {
    states: { Open: 'Todo', NeedsOwner: 'Blocked', Shipped: 'Done' },
    inFlight: 'In Progress',
  })
  .retry({ maxAttempts: 1, exhausted: NeedsOwner });

const heartbeats = H.lane('heartbeats', heartbeatKind)
  .supply(H.clock('heartbeat-clock').every({ minutes: 5 }), (tick, to) => to.create({ service: 'payments-api' }))
  .handler(heartbeat, { exits: { healthy: Healthy, unhealthy: Unhealthy } })
  .retry({ maxAttempts: 1, exhausted: Unhealthy });

const heartbeatFailureFilesBug = H.trigger('heartbeat-failure-files-bug')
  .on(H.when.transition(heartbeats, { to: Unhealthy }))
  .create(bugs, e => ({
    title: `Heartbeat failed for ${e.unit.attributes.service}`,
    body: `The heartbeat of ${e.unit.attributes.service} failed at ${e.at.toISOString()}.`,
  }));

const scheduler = H.scheduler('coding-team')
  .standard(heartbeats, bugs, featureLane, epics)
  .wip(bugs, 2)
  .wip(epics, 1)
  .aging(featureLane, { afterMinutes: 240 });

const productionProbe = H.operation('production-health-probe', H.command('probe-production')
  .argv(['./scripts/probe.sh', 'production'])
  .runner(localRunner));

const supervisor = claudeCode.supervisor('supervisor', {
  grants: [
    H.ops.workRead,
    H.ops.workCreate,
    H.ops.workUpdate,
    H.ops.resolve(ownerDecision),
    H.ops.memoryRead,
    H.ops.memoryWrite,
    H.ops.telemetryRead,
    H.ops.accountsRead,
    H.ops.accountsShare,
    productionProbe,
  ],
});

export const harness = H.harness('coding-team')
  .ledger(sqlite.ledger({ path: '.harness/ledger.sqlite' }))
  .lanes(heartbeats, bugs, featureLane, epics)
  .journals(experience, taste)
  .triggers(heartbeatFailureFilesBug)
  .scheduler(scheduler)
  .clients(supervisor)
  .observers(markdown.board({ path: 'BOARD.md' }), markdown.telemetry({ path: 'TELEMETRY.md' }));

void harness.start();
