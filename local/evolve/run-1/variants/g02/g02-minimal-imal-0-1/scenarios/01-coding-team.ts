import { H, type PendingView, type Resource, type SupplyOf } from 'harness-dsl';
import { z } from 'zod';
import * as claudeCode from 'harness-dsl/claude-code';
import * as anthropic from 'harness-dsl/anthropic';
import * as linear from 'harness-dsl/linear';
import * as folder from 'harness-dsl/folder';
import * as sqlite from 'harness-dsl/sqlite';
import * as jsonl from 'harness-dsl/jsonl';
import * as git from 'harness-dsl/git';
import * as shell from 'harness-dsl/shell';
import * as markdown from 'harness-dsl/markdown';

const area = z.enum(['payments', 'auth', 'web']);
type Area = z.infer<typeof area>;
const isArea = (label: string): label is Area => area.safeParse(label).success;
const areas: Record<Area, Resource> = {
  payments: H.resource('payments'),
  auth: H.resource('auth'),
  web: H.resource('web'),
};

const ticketData = z.object({
  title: z.string(),
  description: z.string(),
  areas: z.array(area),
  epic: z.string().optional(),
});

const todo = H.state('todo', 'pending');
const inProgress = H.state('in-progress', 'active');
const done = H.state('done', { terminal: 'success' });
const wontDo = H.state('wont-do', { terminal: 'neutral' });
const abandoned = H.state('abandoned', { terminal: 'failure' });
const ticketStates = [todo, inProgress, done, wontDo, abandoned];

const Bug = H.kind('bug').data(ticketData).states(ticketStates, 'todo').failsTo('abandoned');
const Feature = H.kind('feature').data(ticketData).states(ticketStates, 'todo').failsTo('abandoned');

const Epic = H.kind('epic')
  .data(z.object({ title: z.string(), description: z.string() }))
  .states(
    [
      H.state('epic-open', 'pending'),
      H.state('epic-planning', 'active'),
      H.state('epic-decomposed', 'waiting'),
      H.state('epic-closing', 'pending'),
      H.state('epic-done', { terminal: 'success' }),
      H.state('epic-abandoned', { terminal: 'failure' }),
    ],
    'epic-open'
  )
  .failsTo('epic-abandoned');

const Heartbeat = H.kind('service-heartbeat')
  .data(z.object({ service: z.string() }))
  .states(
    [
      H.state('beat-due', 'pending'),
      H.state('beat-healthy', { terminal: 'success' }),
      H.state('beat-unhealthy', { terminal: 'failure' }),
    ],
    'beat-due'
  );

const Experience = H.memory('experience', 'fallible');
const Taste = H.memory('taste', 'owner');

const specificThenProven = H.policy.recall('specific-then-proven', (view) =>
  [...view.items]
    .filter((item) => item.status === 'accepted')
    .sort((a, b) => b.specificity - a.specificity || (b.trackRecord.value ?? 0) - (a.trackRecord.value ?? 0))
    .slice(0, 12)
);

const experience = H.library('coding-experience', Experience, jsonl.memory('memory/experience.jsonl')).recall(specificThenProven);
const taste = H.library('owner-taste', Taste, jsonl.memory('memory/taste.jsonl')).recall(specificThenProven);

const sonnet = claudeCode.model('claude-sonnet-4-5');
const opus = claudeCode.model('claude-opus-4-1');

const cheaperUntilItSlips = H.policy.model('cheaper-until-it-slips', (choice) => {
  const record = choice.metrics.successRate({ kind: choice.kind, model: sonnet.name, days: 14 });
  if (record.value === null || record.samples < 20) return sonnet;
  return record.value >= 0.85 ? sonnet : opus;
});

const drainSoonestExpiring = H.policy.account('drain-soonest-expiring', (choice) => {
  const usable = choice.accounts.filter((view) => view.eligible && view.usedShare < view.share);
  const subscriptions = usable
    .filter((view) => view.account.plan === 'subscription')
    .sort((a, b) => (a.windowEndsAt?.getTime() ?? Infinity) - (b.windowEndsAt?.getTime() ?? Infinity));
  const chosen = subscriptions.length > 0 ? subscriptions[0] : usable.find((view) => view.account.plan === 'metered');
  return chosen ? chosen.account : null;
});

const claudePool = H.pool(
  'claude',
  [
    { account: claudeCode.subscription('max-one', { token: H.env('CLAUDE_MAX_ONE_TOKEN') }), share: 0.6 },
    { account: claudeCode.subscription('max-two', { token: H.env('CLAUDE_MAX_TWO_TOKEN') }), share: 0.6 },
    { account: claudeCode.subscription('max-three', { token: H.env('CLAUDE_MAX_THREE_TOKEN') }), share: 0.4 },
    { account: anthropic.account('api-fallback', { apiKey: H.env('ANTHROPIC_API_KEY') }), share: 1 },
  ],
  drainSoonestExpiring
);

const worktrees = git.worktree('app-worktrees', { repo: '.', slots: 3 });
const local = shell.local('local', { slots: 4 });

const projectChecks = H.command('project-checks').argv(() => ['npm', 'run', 'check']).on(worktrees).restart('rerun');

const builderRole = H.role('builder')
  .input(z.object({ title: z.string(), description: z.string(), deficits: z.array(z.string()) }))
  .output(z.object({ summary: z.string() }))
  .prompt((input) =>
    `Implement: ${input.title}\n\n${input.description}\n\nOpen deficits:\n${input.deficits.map((d) => `- ${d}`).join('\n')}`
  )
  .intents(['read', 'edit', 'execute', 'ask']);

const auditorRole = H.role('auditor')
  .input(z.object({ title: z.string(), description: z.string(), summary: z.string() }))
  .output(z.object({ deficits: z.array(z.string()) }))
  .prompt((input) => `Audit the change for "${input.title}".\n\nBuilder summary: ${input.summary}\n\nList every deficit against:\n${input.description}`)
  .intents(['read', 'execute']);

const plannerRole = H.role('planner')
  .input(z.object({ title: z.string(), description: z.string() }))
  .output(z.object({ features: z.array(z.object({ title: z.string(), description: z.string(), areas: z.array(area) })) }))
  .prompt((input) => `Decompose the epic "${input.title}" into independently shippable features.\n\n${input.description}`)
  .intents(['read']);

const builder = H.agent('builder', builderRole)
  .model(cheaperUntilItSlips)
  .on(worktrees)
  .recalls(experience, taste)
  .guards(claudeCode.fileLeases(), claudeCode.stopCheck(projectChecks));

const auditor = H.agent('auditor', auditorRole).model(opus).on(worktrees).recalls(experience).records(experience);

const planner = H.agent('planner', plannerRole).model(opus).recalls(taste);

const healthCheck = H.command('service-health-check')
  .input(z.object({ service: z.string() }))
  .argv((input) => ['./scripts/health-check.sh', input.service])
  .on(local)
  .restart('rerun');

const productionProbe = H.command('production-health-probe')
  .argv(() => ['./scripts/probe-production.sh'])
  .on(local)
  .restart('rerun');

const ticketFlow = H.flow('build-and-audit')
  .for(Bug, Feature)
  .params(z.object({ rounds: z.number().int().positive() }))
  .does(async (ctx) => {
    const { title, description } = ctx.unit.data;
    const scope = { resources: ctx.unit.data.areas.map((name) => areas[name]) };
    await ctx.move('in-progress');
    let deficits: string[] = [];
    for (let round = 1; round <= ctx.params.rounds; round += 1) {
      const built = await ctx.run(builder, { title, description, deficits }, { scope });
      if (!built.ok) return ctx.fail(built.error);
      const audit = await ctx.run(auditor, { title, description, summary: built.value.summary }, { scope });
      if (!audit.ok) return ctx.fail(audit.error);
      deficits = audit.value.deficits;
      if (deficits.length === 0) return 'done';
    }
    return ctx.fail(`${deficits.length} deficits remain after ${ctx.params.rounds} rounds`);
  });

const heartbeatFlow = H.flow('heartbeat').for(Heartbeat).does(async (ctx) => {
  const checked = await ctx.run(healthCheck, { service: ctx.unit.data.service });
  return checked.ok ? 'beat-healthy' : 'beat-unhealthy';
});

const ticketStatuses = {
  todo: 'Todo',
  'in-progress': 'In Progress',
  done: 'Done',
  'wont-do': "Won't Do",
  abandoned: 'Canceled',
};

const readIssue = (issue: linear.Issue) => ({
  title: issue.title,
  description: issue.description,
  areas: issue.labels.filter(isArea),
  epic: issue.parentId,
});

const bugTracker = linear.tracker(Bug, {
  apiKey: H.env('LINEAR_API_KEY'),
  team: 'APP',
  label: 'bug',
  read: readIssue,
  statuses: ticketStatuses,
});

const featureTracker = linear.tracker(Feature, {
  apiKey: H.env('LINEAR_API_KEY'),
  team: 'APP',
  label: 'feature',
  read: readIssue,
  statuses: ticketStatuses,
});

const epicTracker = linear.tracker(Epic, {
  apiKey: H.env('LINEAR_API_KEY'),
  team: 'APP',
  label: 'epic',
  read: (issue) => ({ title: issue.title, description: issue.description }),
  statuses: {
    'epic-open': 'Todo',
    'epic-planning': 'In Progress',
    'epic-decomposed': 'In Progress',
    'epic-closing': 'In Review',
    'epic-done': 'Done',
    'epic-abandoned': 'Canceled',
  },
});

const bugFolder = folder.files(Bug, {
  dir: 'bugs',
  read: (file) =>
    ticketData.parse({
      title: file.frontmatter.title ?? file.path,
      description: file.body,
      areas: file.frontmatter.areas ?? [],
    }),
});

const bugLane = H.lane('bugs', Bug)
  .handler(ticketFlow, { rounds: 3 })
  .suppliers(bugTracker, bugFolder, H.operator)
  .store(bugTracker)
  .wip(2);

const featureLane = H.lane('features', Feature)
  .handler(ticketFlow, { rounds: 5 })
  .suppliers(featureTracker, H.operator)
  .store(featureTracker);

const epicFlow = H.flow('epic').for(Epic).does(async (ctx) => {
  if (ctx.unit.state === 'epic-closing') {
    const features = await ctx.children();
    return features.some((feature) => feature.verdict === 'failure') ? 'epic-abandoned' : 'epic-done';
  }
  await ctx.move('epic-planning');
  const plan = await ctx.run(planner, { title: ctx.unit.data.title, description: ctx.unit.data.description });
  if (!plan.ok) return ctx.fail(plan.error);
  await ctx.spawn(
    featureLane,
    plan.value.features.map((feature) => ({
      title: feature.title,
      description: feature.description,
      areas: feature.areas,
      epic: ctx.unit.key,
    }))
  );
  return ctx.until('epic-decomposed', { children: true, then: 'epic-closing' });
});

const epicLane = H.lane('epics', Epic).handler(epicFlow).suppliers(epicTracker).store(epicTracker).wip(1);

const services = ['api', 'worker', 'web'];

const everyFiveMinutes = H.timetable('heartbeat-every-five-minutes', Heartbeat, { every: { minutes: 5 } }, (tick) =>
  services.map((service): SupplyOf<typeof Heartbeat> => ({
    create: { service },
    key: `heartbeat-${service}-${tick.now.toISOString()}`,
  }))
);

const heartbeatLane = H.lane('heartbeats', Heartbeat).handler(heartbeatFlow).suppliers(everyFiveMinutes);

const unhealthyServiceFilesBug = H.trigger(
  'unhealthy-service-files-bug',
  H.on.enters(Heartbeat, 'beat-unhealthy'),
  (event, act) =>
    act.create(
      bugLane,
      {
        title: `Service ${event.unit.data.service} failed its heartbeat`,
        description: `The heartbeat for ${event.unit.data.service} failed at ${event.at.toISOString()}.`,
        areas: [],
      },
      `heartbeat-${event.unit.data.service}`
    )
);

const laneOrder = [heartbeatLane.name, bugLane.name, featureLane.name, epicLane.name];
const featureStarvationMs = 4 * 60 * 60 * 1000;

const heartbeatsThenBugsFeaturesEpics = H.policy.scheduler('heartbeats-bugs-features-epics', (view) => {
  const rank = (unit: PendingView): number =>
    unit.lane === featureLane.name && unit.waitedMs > featureStarvationMs ? 0.5 : laneOrder.indexOf(unit.lane);
  return { start: [...view.pending].sort((a, b) => rank(a) - rank(b) || b.waitedMs - a.waitedMs) };
});

const supervisor = claudeCode.supervisor({
  grants: [
    H.ops.readWork,
    H.ops.writeWork,
    H.ops.resolveHalts,
    H.ops.readMemory,
    H.ops.writeMemory,
    H.ops.readTelemetry,
    H.ops.readAccounts,
    H.ops.setShares,
    H.operation('probe-production-health', productionProbe),
  ],
});

export const codingTeam = H.harness('coding-team')
  .ledger(sqlite.ledger('.harness/ledger.sqlite'))
  .lanes(heartbeatLane, bugLane, featureLane, epicLane)
  .pools(claudePool)
  .triggers(unhealthyServiceFilesBug)
  .scheduler(heartbeatsThenBugsFeaturesEpics)
  .clients(supervisor)
  .observers(markdown.board('BOARD.md'), markdown.telemetry('TELEMETRY.md'));
