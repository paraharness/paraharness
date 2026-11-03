import { H } from 'harness-dsl';
import type { PendingView } from 'harness-dsl';
import { z } from 'zod';
import * as claude from 'harness-dsl/claude-code';
import * as anthropic from 'harness-dsl/anthropic';
import * as linear from 'harness-dsl/linear';
import * as folder from 'harness-dsl/folder';
import * as sqlite from 'harness-dsl/sqlite';
import * as jsonl from 'harness-dsl/jsonl';
import * as git from 'harness-dsl/git';
import * as shell from 'harness-dsl/shell';
import * as markdown from 'harness-dsl/markdown';

const queued = H.state('queued', 'pending');
const building = H.state('building', 'active');
const done = H.state('done', 'terminal', 'success');
const exhausted = H.state('exhausted', 'terminal', 'failure');
const abandoned = H.state('abandoned', 'terminal', 'neutral');

const epicPlanned = H.state('epic-planned', 'pending');
const epicPlanning = H.state('epic-planning', 'active');
const epicInFlight = H.state('epic-in-flight', 'waiting');
const epicDone = H.state('epic-done', 'terminal', 'success');
const epicStalled = H.state('epic-stalled', 'terminal', 'failure');

const heartbeatDue = H.state('heartbeat-due', 'pending');
const heartbeatChecking = H.state('heartbeat-checking', 'active');
const serviceHealthy = H.state('service-healthy', 'terminal', 'success');
const serviceUnhealthy = H.state('service-unhealthy', 'terminal', 'failure');

const ticket = z.object({ title: z.string(), description: z.string() });

export const Bug = H.kind('bug').data(ticket).states(queued, building, done, exhausted, abandoned);
export const Feature = H.kind('feature').data(ticket).states(queued, building, done, exhausted, abandoned);
export const Epic = H.kind('epic').data(ticket).states(epicPlanned, epicPlanning, epicInFlight, epicDone, epicStalled);
export const ServiceHeartbeat = H.kind('service-heartbeat')
  .data(z.object({ service: z.string() }))
  .states(heartbeatDue, heartbeatChecking, serviceHealthy, serviceUnhealthy);

const builderRole = H.role('builder')
  .input(z.object({
    title: z.string(),
    description: z.string(),
    deficits: z.array(z.string()),
    ownerNotes: z.array(z.string()),
  }))
  .output(z.object({ summary: z.string(), questionForOwner: z.string().nullable() }))
  .prompt((input) =>
    `Implement: ${input.title}\n\n${input.description}\n\nOpen deficits:\n${input.deficits.join('\n')}\n\nOwner notes:\n${input.ownerNotes.join('\n')}`)
  .intents(['read', 'edit', 'execute']);

const auditorRole = H.role('auditor')
  .input(z.object({ title: z.string(), description: z.string(), summary: z.string() }))
  .output(z.object({ deficits: z.array(z.string()) }))
  .prompt((input) => `Audit the change for "${input.title}".\n\nIntent:\n${input.description}\n\nBuilder summary:\n${input.summary}\n\nList every deficit.`)
  .intents(['read', 'execute']);

const plannerRole = H.role('planner')
  .input(ticket)
  .output(z.object({ features: z.array(ticket) }))
  .prompt((input) => `Decompose the epic "${input.title}" into features.\n\n${input.description}`)
  .intents(['read']);

const sonnet = claude.model('claude-sonnet-4-5');
const opus = claude.model('claude-opus-4-1');

const builderModel = H.policy.model('builder-model', ({ kind, metrics }) => {
  const cheaper = metrics.successRate({ kind, model: sonnet, days: 14 });
  if (cheaper.samples < 20 || cheaper.value === null) return sonnet;
  return cheaper.value < 0.85 ? opus : sonnet;
});

const subscriptionA = claude.subscription('claude-max-a', { token: H.env('CLAUDE_TOKEN_A') });
const subscriptionB = claude.subscription('claude-max-b', { token: H.env('CLAUDE_TOKEN_B') });
const subscriptionC = claude.subscription('claude-max-c', { token: H.env('CLAUDE_TOKEN_C') });
const apiAccount = anthropic.account('anthropic-api', { apiKey: H.env('ANTHROPIC_API_KEY') });

const soonestExpiringFirst = H.policy.account('soonest-expiring-first', ({ accounts }) => {
  const subscriptions = accounts
    .filter((view) => view.eligible && view.account.plan === 'subscription' && view.usedShare < view.share)
    .sort((a, b) => (a.windowEndsAt?.getTime() ?? Number.MAX_SAFE_INTEGER) - (b.windowEndsAt?.getTime() ?? Number.MAX_SAFE_INTEGER));
  const soonest = subscriptions[0];
  if (soonest) return soonest.account;
  const metered = accounts.find((view) => view.eligible && view.account.plan === 'metered');
  return metered ? metered.account : null;
});

export const claudePool = H.pool('claude', [
  { account: subscriptionA, share: 0.6 },
  { account: subscriptionB, share: 0.5 },
  { account: subscriptionC, share: 0.4 },
  { account: apiAccount, share: 1 },
], soonestExpiringFirst);

const experience = H.memory('experience', 'experience');
const taste = H.memory('taste', 'taste');
const codingExperience = H.library('coding-experience', experience, jsonl.memory('.harness/experience.jsonl'));
const ownerTaste = H.library('owner-taste', taste, jsonl.memory('.harness/taste.jsonl'));

const worktree = git.worktree('worktree', { repo: '.', slots: 3 });
const local = shell.local('local', { slots: 2 });

const projectChecks = H.command('project-checks').argv(() => ['npm', 'run', 'check']).on(worktree);
const heartbeatCheck = H.command('service-heartbeat-check')
  .input(z.object({ service: z.string() }))
  .argv((input) => ['./scripts/heartbeat.sh', input.service])
  .on(local);
const productionProbe = H.command('production-health-probe').argv(() => ['./scripts/probe-production.sh']).on(local);

const builder = H.agent('builder', builderRole)
  .model(builderModel)
  .on(worktree)
  .recalls(codingExperience, ownerTaste)
  .guards(claude.fileLeases(), claude.stopCheck(projectChecks));

const auditor = H.agent('auditor', auditorRole)
  .model(sonnet)
  .on(worktree)
  .recalls(codingExperience)
  .records(codingExperience);

const planner = H.agent('planner', plannerRole).model(opus).recalls(ownerTaste);

const ownerDecision = H.halt('owner-decision', z.object({
  choice: z.enum(['continue', 'abandon']),
  note: z.string(),
}));

const ticketWork = H.flow('ticket-work')
  .for(Bug, Feature)
  .params(z.object({ rounds: z.number().int().positive() }))
  .does(async (ctx) => {
    await ctx.move('building');
    const { title, description } = ctx.unit.data;
    let deficits: string[] = [];
    const ownerNotes: string[] = [];
    for (let round = 1; round <= ctx.params.rounds; round += 1) {
      const built = await ctx.run(builder, { title, description, deficits, ownerNotes });
      if (!built.ok) return ctx.fail(built.error);
      const question = built.value.questionForOwner;
      if (question !== null) {
        const decision = await ctx.halt(ownerDecision, question);
        if (decision.choice === 'abandon') return 'abandoned';
        ownerNotes.push(decision.note);
        continue;
      }
      const audit = await ctx.run(auditor, { title, description, summary: built.value.summary });
      if (!audit.ok) return ctx.fail(audit.error);
      if (audit.value.deficits.length === 0) return 'done';
      deficits = audit.value.deficits;
    }
    return 'exhausted';
  });

const heartbeatFlow = H.flow('service-heartbeat').for(ServiceHeartbeat).does(async (ctx) => {
  await ctx.move('heartbeat-checking');
  const check = await ctx.run(heartbeatCheck, { service: ctx.unit.data.service });
  return check.ok ? 'service-healthy' : 'service-unhealthy';
});

const fromIssue = (issue: linear.Issue) => ({ title: issue.title, description: issue.description });
const ticketStatuses = {
  queued: 'Todo',
  building: 'In Progress',
  done: 'Done',
  exhausted: 'Needs Attention',
  abandoned: 'Canceled',
};

const bugTracker = linear.tracker(Bug, {
  apiKey: H.env('LINEAR_API_KEY'),
  team: 'ENG',
  label: 'bug',
  read: fromIssue,
  statuses: ticketStatuses,
});
const featureTracker = linear.tracker(Feature, {
  apiKey: H.env('LINEAR_API_KEY'),
  team: 'ENG',
  label: 'feature',
  read: fromIssue,
  statuses: ticketStatuses,
});
const epicTracker = linear.tracker(Epic, {
  apiKey: H.env('LINEAR_API_KEY'),
  team: 'ENG',
  label: 'epic',
  read: fromIssue,
  statuses: {
    'epic-planned': 'Todo',
    'epic-planning': 'In Progress',
    'epic-in-flight': 'In Progress',
    'epic-done': 'Done',
    'epic-stalled': 'Needs Attention',
  },
});

const bugFolder = folder.files(Bug, {
  dir: 'bugs',
  read: (file) => {
    const title = file.frontmatter['title'];
    return { title: typeof title === 'string' ? title : file.path, description: file.body };
  },
});

const heartbeatClock = H.clock('heartbeat-clock', ServiceHeartbeat, { every: { minutes: 5 } }, ({ now }) => [
  { create: { service: 'api' }, key: `api@${now.toISOString()}` },
]);

export const heartbeats = H.lane('heartbeats', ServiceHeartbeat).handler(heartbeatFlow).suppliers(heartbeatClock);

export const bugs = H.lane('bugs', Bug)
  .handler(ticketWork, { rounds: 3 })
  .suppliers(bugTracker, bugFolder, H.operator)
  .store(bugTracker)
  .wip(2);

export const features = H.lane('features', Feature)
  .handler(ticketWork, { rounds: 5 })
  .suppliers(featureTracker, H.operator)
  .store(featureTracker);

const epicWork = H.flow('epic-work').for(Epic).does(async (ctx) => {
  await ctx.move('epic-planning');
  const plan = await ctx.run(planner, ctx.unit.data);
  if (!plan.ok) return ctx.fail(plan.error);
  const children = await ctx.spawn(features, plan.value.features);
  const finished = await ctx.wait('epic-in-flight', { children });
  return finished.every((feature) => feature.state === 'done') ? 'epic-done' : 'epic-stalled';
});

export const epics = H.lane('epics', Epic).handler(epicWork).suppliers(epicTracker).store(epicTracker).wip(1);

const unhealthyServiceFilesBug = H.trigger(
  'unhealthy-service-files-bug',
  H.on.enters(ServiceHeartbeat, 'service-unhealthy'),
  (event, act) => act.create(bugs, {
    title: `Service ${event.unit.data.service} failed its heartbeat`,
    description: `Heartbeat ${event.unit.key} failed at ${event.at.toISOString()}.`,
  }, `heartbeat-${event.unit.data.service}`),
);

const kindRank = new Map<string, number>([
  [ServiceHeartbeat.name, 0],
  [Bug.name, 1],
  [Feature.name, 2],
  [Epic.name, 3],
]);
const featureStarvationMs = 2 * 60 * 60 * 1000;
const rankOf = (unit: PendingView): number =>
  unit.kind === Feature.name && unit.waitedMs > featureStarvationMs ? 0.5 : kindRank.get(unit.kind) ?? 4;

const codingPriority = H.policy.scheduler('coding-priority', ({ pending }) => ({
  start: [...pending].sort((a, b) => rankOf(a) - rankOf(b) || b.waitedMs - a.waitedMs),
}));

const supervisor = claude.supervisor({
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
  .lanes(heartbeats, bugs, features, epics)
  .pools(claudePool)
  .triggers(unhealthyServiceFilesBug)
  .scheduler(codingPriority)
  .clients(supervisor)
  .observers(markdown.board('.harness/board.md'), markdown.telemetry('.harness/telemetry.md'));

export const running = codingTeam.start();
