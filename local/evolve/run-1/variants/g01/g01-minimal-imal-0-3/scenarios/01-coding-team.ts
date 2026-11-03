import { z } from 'zod';
import { H } from 'harness-dsl';
import type { PendingView } from 'harness-dsl';
import * as claudeCode from 'harness-dsl/claude-code';
import * as anthropic from 'harness-dsl/anthropic';
import * as linear from 'harness-dsl/linear';
import * as folder from 'harness-dsl/folder';
import * as sqlite from 'harness-dsl/sqlite';
import * as jsonl from 'harness-dsl/jsonl';
import * as git from 'harness-dsl/git';
import * as shell from 'harness-dsl/shell';
import * as markdown from 'harness-dsl/markdown';

const Queued = H.state('queued', 'pending');
const Building = H.state('building', 'active');
const Decomposing = H.state('decomposing', 'active');
const AwaitingFeatures = H.state('awaiting-features', 'waiting');
const Done = H.state('done', 'terminal', 'success');
const Abandoned = H.state('abandoned', 'terminal', 'failure');
const Dropped = H.state('dropped', 'terminal', 'neutral');

const HeartbeatDue = H.state('heartbeat-due', 'pending');
const Probing = H.state('probing', 'active');
const Healthy = H.state('healthy', 'terminal', 'success');
const Unhealthy = H.state('unhealthy', 'terminal', 'failure');
const Skipped = H.state('skipped', 'terminal', 'neutral');

const workData = z.object({
  title: z.string(),
  description: z.string(),
  trackerId: z.string().optional(),
});

const Bug = H.kind('Bug')
  .data(workData)
  .states([Queued, Building, Done, Abandoned, Dropped], {
    initial: 'queued',
    afterFailure: 'abandoned',
    afterCancel: 'dropped',
  });

const Feature = H.kind('Feature')
  .data(workData)
  .states([Queued, Building, Done, Abandoned, Dropped], {
    initial: 'queued',
    afterFailure: 'abandoned',
    afterCancel: 'dropped',
  });

const Epic = H.kind('Epic')
  .data(workData)
  .states([Queued, Decomposing, AwaitingFeatures, Done, Abandoned, Dropped], {
    initial: 'queued',
    afterFailure: 'abandoned',
    afterCancel: 'dropped',
  });

const ServiceHeartbeat = H.kind('ServiceHeartbeat')
  .data(z.object({ service: z.string(), url: z.string() }))
  .states([HeartbeatDue, Probing, Healthy, Unhealthy, Skipped], {
    initial: 'heartbeat-due',
    afterFailure: 'unhealthy',
    afterCancel: 'skipped',
  });

const builderRole = H.role('builder')
  .input(z.object({
    title: z.string(),
    description: z.string(),
    round: z.number().int(),
    deficits: z.array(z.string()),
  }))
  .output(z.object({ summary: z.string(), changedFiles: z.array(z.string()) }))
  .prompt(input => [
    `Implement: ${input.title}`,
    input.description,
    `Round ${input.round}.`,
    input.deficits.length > 0 ? `Resolve these deficits first:\n- ${input.deficits.join('\n- ')}` : 'No known deficits yet.',
    'If a decision belongs to the owner, ask instead of guessing.',
  ].join('\n\n'))
  .intents(['read', 'edit', 'execute', 'ask']);

const auditorRole = H.role('auditor')
  .input(z.object({ title: z.string(), description: z.string(), summary: z.string() }))
  .output(z.object({ deficits: z.array(z.string()) }))
  .prompt(input => `Audit the change for "${input.title}".\n\n${input.description}\n\nBuilder summary:\n${input.summary}\n\nList every deficit; return an empty list if none remain.`)
  .intents(['read', 'execute']);

const plannerRole = H.role('planner')
  .input(z.object({ title: z.string(), description: z.string() }))
  .output(z.object({
    features: z.array(z.object({ title: z.string(), description: z.string() })).min(1),
  }))
  .prompt(input => `Decompose the epic "${input.title}" into independently deliverable features.\n\n${input.description}`)
  .intents(['read']);

const experience = H.memory('experience', 'fallible');
const taste = H.memory('taste', 'owner');

const specificityThenRecord = H.policy.recall('specificity-then-record', view =>
  [...view.items]
    .filter(item => item.status === 'accepted')
    .sort((a, b) =>
      b.specificity - a.specificity || (b.trackRecord.value ?? 0) - (a.trackRecord.value ?? 0))
    .slice(0, 12));

const codingExperience = H.library('coding-experience', experience, jsonl.memory('.harness/experience.jsonl'))
  .recall(specificityThenRecord);
const ownerTaste = H.library('owner-taste', taste, jsonl.memory('.harness/taste.jsonl'))
  .recall(specificityThenRecord);

const sonnet = claudeCode.model('claude-sonnet-4-5');
const opus = claudeCode.model('claude-opus-4-1');

const builderModel = H.policy.model('cheaper-until-it-slips', choice => {
  const cheaper = choice.metrics.successRate({ kind: choice.kind, model: sonnet.name, days: 14 });
  if (cheaper.samples < 20 || cheaper.value === null) return sonnet;
  return cheaper.value < 0.85 ? opus : sonnet;
});

const worktrees = git.worktree('worktrees', { repo: '.', slots: 3 });
const local = shell.local('local', { slots: 4 });

const projectChecks = H.command('project-checks')
  .argv(() => ['npm', 'run', 'check'])
  .on(worktrees)
  .restart('rerun');

const builder = H.agent('builder', builderRole)
  .model(builderModel)
  .on(worktrees)
  .recalls(codingExperience, ownerTaste)
  .guards(claudeCode.fileLeases(), claudeCode.stopCheck(projectChecks));

const auditor = H.agent('auditor', auditorRole)
  .model(opus)
  .on(worktrees)
  .recalls(codingExperience)
  .records(codingExperience);

const planner = H.agent('planner', plannerRole)
  .model(opus)
  .recalls(ownerTaste);

const buildAndAudit = H.flow('build-and-audit')
  .for(Bug, Feature)
  .params(z.object({ rounds: z.number().int().positive() }))
  .does(async ctx => {
    await ctx.move('building');
    const { title, description } = ctx.unit.data;
    let deficits: string[] = [];
    for (let round = 1; round <= ctx.params.rounds; round++) {
      const built = await ctx.run(builder, { title, description, round, deficits });
      if (!built.ok) return ctx.fail(built.error);
      const audit = await ctx.run(auditor, { title, description, summary: built.value.summary });
      if (!audit.ok) return ctx.fail(audit.error);
      if (audit.value.deficits.length === 0) return 'done';
      deficits = audit.value.deficits;
    }
    return ctx.fail(`deficits remain after ${ctx.params.rounds} rounds: ${deficits.join('; ')}`);
  });

const probe = H.command('probe')
  .input(z.object({ url: z.string() }))
  .argv(input => ['curl', '--fail', '--silent', '--max-time', '10', input.url])
  .on(local)
  .restart('rerun');

const heartbeatFlow = H.flow('heartbeat')
  .for(ServiceHeartbeat)
  .does(async ctx => {
    await ctx.move('probing');
    const result = await ctx.run(probe, { url: ctx.unit.data.url });
    return result.ok ? 'healthy' : 'unhealthy';
  });

const bugTracker = linear.tracker(Bug, {
  apiKey: H.env('LINEAR_API_KEY'),
  team: 'ENG',
  label: 'bug',
  read: issue => ({ title: issue.title, description: issue.description, trackerId: issue.identifier }),
  statuses: { queued: 'Todo', building: 'In Progress', done: 'Done', abandoned: 'Canceled', dropped: 'Canceled' },
});

const featureTracker = linear.tracker(Feature, {
  apiKey: H.env('LINEAR_API_KEY'),
  team: 'ENG',
  label: 'feature',
  read: issue => ({ title: issue.title, description: issue.description, trackerId: issue.identifier }),
  statuses: { queued: 'Todo', building: 'In Progress', done: 'Done', abandoned: 'Canceled', dropped: 'Canceled' },
});

const epicTracker = linear.tracker(Epic, {
  apiKey: H.env('LINEAR_API_KEY'),
  team: 'ENG',
  label: 'epic',
  read: issue => ({ title: issue.title, description: issue.description, trackerId: issue.identifier }),
  statuses: {
    queued: 'Todo',
    decomposing: 'In Progress',
    'awaiting-features': 'In Progress',
    done: 'Done',
    abandoned: 'Canceled',
    dropped: 'Canceled',
  },
});

const bugFolder = folder.files(Bug, {
  dir: 'bugs',
  read: file => ({ title: String(file.frontmatter.title ?? file.path), description: file.body }),
});

const bugs = H.lane('bugs', Bug)
  .handler(buildAndAudit, { rounds: 3 })
  .suppliers(bugTracker, bugFolder, H.operator)
  .store(bugTracker)
  .wip(2);

const features = H.lane('features', Feature)
  .handler(buildAndAudit, { rounds: 5 })
  .suppliers(featureTracker, H.operator)
  .store(featureTracker);

const epicFlow = H.flow('decompose-epic')
  .for(Epic)
  .does(async ctx => {
    const children = await ctx.children();
    if (children.length > 0) {
      if (children.some(child => child.position !== 'terminal')) {
        return ctx.until('awaiting-features', { children: true, then: 'queued' });
      }
      return children.every(child => child.verdict === 'success') ? 'done' : 'abandoned';
    }
    await ctx.move('decomposing');
    const plan = await ctx.run(planner, { title: ctx.unit.data.title, description: ctx.unit.data.description });
    if (!plan.ok) return ctx.fail(plan.error);
    await ctx.spawn(features, plan.value.features.map(feature => ({
      title: feature.title,
      description: feature.description,
    })));
    return ctx.until('awaiting-features', { children: true, then: 'queued' });
  });

const epics = H.lane('epics', Epic)
  .handler(epicFlow)
  .suppliers(epicTracker)
  .store(epicTracker)
  .wip(1);

const heartbeats = H.lane('heartbeats', ServiceHeartbeat)
  .handler(heartbeatFlow);

const services = [
  { service: 'api', url: 'https://api.example.com/health' },
  { service: 'web', url: 'https://www.example.com/health' },
];

const everyFiveMinutes = H.trigger('heartbeat-every-five-minutes', H.on.clock({ every: { minutes: 5 } }), (_event, act) =>
  services.map(service => act.create(heartbeats, { service: service.service, url: service.url })));

const unhealthyServiceFilesBug = H.trigger('unhealthy-service-files-bug', H.on.enters(ServiceHeartbeat, 'unhealthy'), (event, act) =>
  act.create(bugs, {
    title: `Service ${event.unit.data.service} failed its heartbeat`,
    description: `The heartbeat probe of ${event.unit.data.url} failed at ${event.at.toISOString()}.`,
  }, `heartbeat-${event.unit.data.service}`));

const accountPolicy = H.policy.account('soonest-expiring-then-api', choice => {
  const subscriptions = choice.accounts
    .filter(view => view.eligible && view.account.plan === 'subscription' && view.usedShare < view.share)
    .sort((a, b) =>
      (a.windowEndsAt ? a.windowEndsAt.getTime() : Number.POSITIVE_INFINITY) -
      (b.windowEndsAt ? b.windowEndsAt.getTime() : Number.POSITIVE_INFINITY));
  const soonest = subscriptions[0];
  if (soonest) return soonest.account;
  const metered = choice.accounts.find(view => view.eligible && view.account.plan === 'metered');
  return metered ? metered.account : null;
});

const claudePool = H.pool('claude', [
  { account: claudeCode.subscription('max-1', { token: H.env('CLAUDE_TOKEN_1') }), share: 0.5 },
  { account: claudeCode.subscription('max-2', { token: H.env('CLAUDE_TOKEN_2') }), share: 0.5 },
  { account: claudeCode.subscription('max-3', { token: H.env('CLAUDE_TOKEN_3') }), share: 0.3 },
  { account: anthropic.account('api', { apiKey: H.env('ANTHROPIC_API_KEY') }), share: 1 },
], accountPolicy);

const priority: Readonly<Record<string, number>> = {
  [ServiceHeartbeat.name]: 0,
  [Bug.name]: 1,
  [Feature.name]: 2,
  [Epic.name]: 3,
};
const featureStarvationMs = 4 * 60 * 60 * 1000;

const rank = (unit: PendingView): number =>
  unit.kind === Feature.name && unit.waitedMs > featureStarvationMs ? 0.5 : priority[unit.kind] ?? 9;

const codingScheduler = H.policy.scheduler('heartbeats-bugs-features-epics', view => ({
  start: [...view.pending].sort((a, b) => rank(a) - rank(b) || b.waitedMs - a.waitedMs),
}));

const productionHealth = H.command('production-health')
  .argv(() => ['curl', '--fail', '--silent', 'https://api.example.com/health/deep'])
  .on(local)
  .restart('rerun');

const supervisor = claudeCode.supervisor({
  grants: [
    H.ops.readWork,
    H.ops.writeWork,
    H.ops.resolveHalts,
    H.ops.writeMemory,
    H.ops.readTelemetry,
    H.ops.readAccounts,
    H.ops.setShares,
    H.operation('production-health', productionHealth),
  ],
});

export default H.harness('coding-team')
  .ledger(sqlite.ledger('.harness/ledger.sqlite'))
  .lanes(heartbeats, bugs, features, epics)
  .pools(claudePool)
  .triggers(everyFiveMinutes, unhealthyServiceFilesBug)
  .scheduler(codingScheduler)
  .clients(supervisor)
  .observers(markdown.board('BOARD.md'), markdown.telemetry('TELEMETRY.md'));
