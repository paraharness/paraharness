import { H, type PendingView } from 'harness-dsl';
import * as cc from 'harness-dsl/claude-code';
import * as anthropic from 'harness-dsl/anthropic';
import * as linear from 'harness-dsl/linear';
import * as folder from 'harness-dsl/folder';
import * as sqlite from 'harness-dsl/sqlite';
import * as jsonl from 'harness-dsl/jsonl';
import * as git from 'harness-dsl/git';
import * as shell from 'harness-dsl/shell';
import * as markdown from 'harness-dsl/markdown';
import { z } from 'zod';

const todo = H.state('todo', 'pending');
const building = H.state('building', 'active');
const done = H.state('done', 'terminal', 'success');
const abandoned = H.state('abandoned', 'terminal', 'failure');
const wontFix = H.state('wont-fix', 'terminal', 'neutral');
const ticketLifecycle = H.lifecycle(todo, building, done, abandoned);

export const Bug = H.kind('Bug')
  .data(z.object({ title: z.string(), description: z.string() }))
  .states([...ticketLifecycle.states, wontFix], { initial: 'todo', afterFailure: 'abandoned' });

export const Feature = H.kind('Feature')
  .data(z.object({ title: z.string(), description: z.string(), epic: z.string().optional() }))
  .states(ticketLifecycle, { initial: 'todo', afterFailure: 'abandoned' });

export const Epic = H.kind('Epic')
  .data(z.object({ title: z.string(), description: z.string() }))
  .states(
    [H.state('proposed', 'pending'), H.state('planning', 'active'), H.state('decomposed', 'waiting'), done, abandoned],
    { initial: 'proposed', afterFailure: 'abandoned' }
  );

export const Heartbeat = H.kind('ServiceHeartbeat')
  .data(z.object({ service: z.string() }))
  .states(
    [H.state('due', 'pending'), H.state('checking', 'active'), H.state('healthy', 'terminal', 'success'), H.state('unhealthy', 'terminal', 'failure')],
    { initial: 'due', afterFailure: 'unhealthy' }
  );

const builderRole = H.role('builder')
  .input(z.object({ title: z.string(), description: z.string(), deficits: z.array(z.string()), round: z.number() }))
  .output(z.object({ summary: z.string() }))
  .prompt(i => `Round ${i.round}. Implement: ${i.title}\n\n${i.description}\n\nOpen deficits:\n${i.deficits.join('\n')}`)
  .intents(['read', 'edit', 'execute', 'ask']);

const auditorRole = H.role('auditor')
  .input(z.object({ title: z.string(), description: z.string(), summary: z.string() }))
  .output(z.object({ deficits: z.array(z.string()) }))
  .prompt(i => `Audit the change for "${i.title}" against:\n${i.description}\n\nBuilder summary:\n${i.summary}`)
  .intents(['read', 'execute']);

const plannerRole = H.role('planner')
  .input(z.object({ title: z.string(), description: z.string() }))
  .output(z.object({ features: z.array(z.object({ title: z.string(), description: z.string() })) }))
  .prompt(i => `Decompose the epic "${i.title}" into independently shippable features.\n\n${i.description}`)
  .intents(['read']);

const experience = H.memory('experience', 'fallible');
const taste = H.memory('taste', 'owner');

const mostSpecificFirst = H.policy.recall('most-specific-then-track-record', view =>
  [...view.items]
    .sort((a, b) => b.specificity - a.specificity || (b.trackRecord.value ?? 0) - (a.trackRecord.value ?? 0))
    .slice(0, 12)
);

export const experienceLibrary = H.library('coding-experience', experience, jsonl.memory('.harness/experience.jsonl')).recall(mostSpecificFirst);
export const tasteLibrary = H.library('owner-taste', taste, jsonl.memory('.harness/taste.jsonl')).recall(mostSpecificFirst);

const sonnet = cc.model('claude-sonnet-4-5');
const opus = cc.model('claude-opus-4-1');

const builderModel = H.policy.model('cheaper-model-until-track-record-drops', choice => {
  const cheapRecord = choice.metrics.successRate({ kind: choice.kind, model: sonnet.name, days: 14 });
  const enoughSamples = cheapRecord.samples >= 20;
  const belowBar = cheapRecord.value !== null && cheapRecord.value < 0.85;
  return enoughSamples && belowBar ? opus : sonnet;
});

const worktrees = git.worktree('worktrees', { repo: '.', slots: 3 });
const local = shell.local('local', { slots: 4 });

const projectChecks = H.command('project-checks').argv(() => ['npm', 'run', 'check']).on(worktrees);

const builder = H.agent('builder', builderRole)
  .model(builderModel)
  .on(worktrees)
  .recalls(experienceLibrary, tasteLibrary)
  .guards(cc.fileLeases(), cc.stopCheck(projectChecks));

const auditor = H.agent('auditor', auditorRole)
  .model(opus)
  .on(worktrees)
  .recalls(experienceLibrary)
  .records(experienceLibrary);

const planner = H.agent('planner', plannerRole).model(opus).recalls(tasteLibrary);

const healthCheck = H.command('service-health-check')
  .input(z.object({ service: z.string() }))
  .argv(i => ['./scripts/health-check.sh', i.service])
  .on(local);

const productionProbe = H.command('production-health-probe')
  .argv(() => ['./scripts/production-probe.sh'])
  .on(local);

const buildAndAudit = H.flow('build-and-audit')
  .for(Bug, Feature)
  .params(z.object({ rounds: z.number() }))
  .does(async ctx => {
    await ctx.move('building');
    const { title, description } = ctx.unit.data;
    let deficits: string[] = [];
    for (let round = 1; round <= ctx.params.rounds; round++) {
      const built = await ctx.run(builder, { title, description, deficits, round });
      if (!built.ok) return ctx.fail(built.error);
      const audited = await ctx.run(auditor, { title, description, summary: built.value.summary });
      if (!audited.ok) return ctx.fail(audited.error);
      if (audited.value.deficits.length === 0) return 'done';
      deficits = audited.value.deficits;
    }
    return ctx.fail(`${deficits.length} deficits remain after ${ctx.params.rounds} rounds`);
  });

const heartbeatFlow = H.flow('service-heartbeat')
  .for(Heartbeat)
  .does(async ctx => {
    await ctx.move('checking');
    const probe = await ctx.run(healthCheck, { service: ctx.unit.data.service });
    return probe.ok ? 'healthy' : ctx.fail(probe.error);
  });

const linearKey = H.env('LINEAR_API_KEY');

const bugTracker = linear.tracker(Bug, {
  apiKey: linearKey,
  team: 'PROD',
  label: 'bug',
  read: issue => ({ title: issue.title, description: issue.description }),
  statuses: { todo: 'Todo', building: 'In Progress', done: 'Done', abandoned: 'Canceled', 'wont-fix': "Won't Fix" },
});

const featureTracker = linear.tracker(Feature, {
  apiKey: linearKey,
  team: 'PROD',
  label: 'feature',
  read: issue => ({ title: issue.title, description: issue.description, epic: issue.parentId }),
  statuses: { todo: 'Todo', building: 'In Progress', done: 'Done', abandoned: 'Canceled' },
});

const epicTracker = linear.tracker(Epic, {
  apiKey: linearKey,
  team: 'PROD',
  label: 'epic',
  read: issue => ({ title: issue.title, description: issue.description }),
  statuses: { proposed: 'Backlog', planning: 'In Progress', decomposed: 'In Progress', done: 'Done', abandoned: 'Canceled' },
});

const bugFolder = folder.files(Bug, {
  dir: 'bugs',
  read: file => ({ title: String(file.frontmatter['title'] ?? file.path), description: file.body }),
});

export const bugLane = H.lane('bugs', Bug)
  .handler(buildAndAudit, { rounds: 3 })
  .suppliers(bugTracker, bugFolder, H.operator)
  .store(bugTracker)
  .wip(2);

export const featureLane = H.lane('features', Feature)
  .handler(buildAndAudit, { rounds: 5 })
  .suppliers(featureTracker, H.operator)
  .store(featureTracker);

const decomposeEpic = H.flow('decompose-epic')
  .for(Epic)
  .does(async ctx => {
    await ctx.move('planning');
    const plan = await ctx.run(planner, { title: ctx.unit.data.title, description: ctx.unit.data.description });
    if (!plan.ok) return ctx.fail(plan.error);
    await ctx.spawn(
      featureLane,
      plan.value.features.map(feature => ({ title: feature.title, description: feature.description, epic: ctx.unit.key }))
    );
    return ctx.until('decomposed', { children: true, then: 'done' });
  });

export const epicLane = H.lane('epics', Epic)
  .handler(decomposeEpic)
  .suppliers(epicTracker)
  .store(epicTracker)
  .wip(1);

const services = ['api', 'worker', 'web'];

const heartbeatCalendar = H.calendar('service-heartbeats', Heartbeat, { every: { minutes: 5 } }, () =>
  services.map(service => ({ create: { service }, key: `heartbeat-${service}` }))
);

export const heartbeatLane = H.lane('heartbeats', Heartbeat)
  .handler(heartbeatFlow)
  .suppliers(heartbeatCalendar);

const failedHeartbeatFilesBug = H.trigger('failed-heartbeat-files-bug', H.on.enters(Heartbeat, 'unhealthy'), (event, act) =>
  act.create(
    bugLane,
    {
      title: `Service ${event.unit.data.service} failed its heartbeat`,
      description: `The heartbeat for ${event.unit.data.service} failed at ${event.at.toISOString()}.`,
    },
    { key: `heartbeat-bug-${event.unit.data.service}` }
  )
);

export const subscriptionOne = cc.subscription('claude-max-1', { token: H.env('CLAUDE_TOKEN_1') });
export const subscriptionTwo = cc.subscription('claude-max-2', { token: H.env('CLAUDE_TOKEN_2') });
export const subscriptionThree = cc.subscription('claude-max-3', { token: H.env('CLAUDE_TOKEN_3') });
const apiAccount = anthropic.account('anthropic-api', { apiKey: H.env('ANTHROPIC_API_KEY') });

const soonestExpiringFirst = H.policy.account('soonest-expiring-subscription-then-api', choice => {
  const subscriptions = choice.accounts
    .filter(view => view.eligible && view.account.plan === 'subscription' && view.usedShare < view.share)
    .sort((a, b) => (a.windowEndsAt?.getTime() ?? Infinity) - (b.windowEndsAt?.getTime() ?? Infinity));
  const first = subscriptions[0];
  if (first) return first.account;
  const metered = choice.accounts.find(view => view.eligible && view.account.plan === 'metered');
  return metered ? metered.account : null;
});

const accounts = H.pool(
  'claude-accounts',
  [
    { account: subscriptionOne, share: 0.6 },
    { account: subscriptionTwo, share: 0.6 },
    { account: subscriptionThree, share: 0.6 },
    { account: apiAccount, share: 1 },
  ],
  soonestExpiringFirst
);

const featureStarvationMs = 4 * 60 * 60 * 1000;
const kindPriority = new Map([
  [Heartbeat.name, 0],
  [Bug.name, 1],
  [Feature.name, 2],
  [Epic.name, 3],
]);
const rank = (unit: PendingView) =>
  unit.kind === Feature.name && unit.waitedMs > featureStarvationMs ? 0.5 : kindPriority.get(unit.kind) ?? 9;

const scheduler = H.policy.scheduler('heartbeats-bugs-features-epics', view => ({
  start: [...view.pending].sort((a, b) => rank(a) - rank(b) || b.waitedMs - a.waitedMs),
}));

const supervisor = cc.supervisor({
  grants: [
    H.ops.readWork,
    H.ops.writeWork,
    H.ops.resolveHalts,
    H.ops.writeMemory,
    H.ops.readTelemetry,
    H.ops.readAccounts,
    H.ops.setShares,
    H.operation('production-health-probe', productionProbe),
  ],
});

export const codingTeam = H.harness('coding-team')
  .ledger(sqlite.ledger('.harness/ledger.db'))
  .lanes(heartbeatLane, bugLane, featureLane, epicLane)
  .pools(accounts)
  .triggers(failedHeartbeatFilesBug)
  .scheduler(scheduler)
  .clients(supervisor)
  .observers(markdown.board('BOARD.md'), markdown.telemetry('TELEMETRY.md'));
