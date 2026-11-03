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

const Ticket = z.object({ title: z.string(), description: z.string() });
const Service = z.object({ service: z.string() });

const building = H.state('building', 'active');
const done = H.state('done', 'terminal', 'success');

const bugOpen = H.state('bug-open', 'pending');
const bugStuck = H.state('bug-stuck', 'terminal', 'failure');
const bugWontFix = H.state('bug-wont-fix', 'terminal', 'neutral');

const featureOpen = H.state('feature-open', 'pending');
const featureStuck = H.state('feature-stuck', 'terminal', 'failure');
const featureDropped = H.state('feature-dropped', 'terminal', 'neutral');

const epicOpen = H.state('epic-open', 'pending');
const epicPlanning = H.state('epic-planning', 'active');
const epicAwaitingFeatures = H.state('epic-awaiting-features', 'waiting');
const epicDone = H.state('epic-done', 'terminal', 'success');
const epicFailed = H.state('epic-failed', 'terminal', 'failure');

const heartbeatDue = H.state('heartbeat-due', 'pending');
const heartbeatOk = H.state('heartbeat-ok', 'terminal', 'success');
const heartbeatDown = H.state('heartbeat-down', 'terminal', 'failure');

const Bug = H.kind('bug').data(Ticket).states(bugOpen, building, done, bugStuck, bugWontFix).failsTo('bug-stuck');
const Feature = H.kind('feature').data(Ticket).states(featureOpen, building, done, featureStuck, featureDropped).failsTo('feature-stuck');
const Epic = H.kind('epic').data(Ticket).states(epicOpen, epicPlanning, epicAwaitingFeatures, epicDone, epicFailed).failsTo('epic-failed');
const ServiceHeartbeat = H.kind('service-heartbeat').data(Service).states(heartbeatDue, heartbeatOk, heartbeatDown);

const buildRole = H.role('builder')
  .input(z.object({ title: z.string(), description: z.string(), deficits: z.array(z.string()), guidance: z.string() }))
  .output(z.object({ summary: z.string(), question: z.string().nullable() }))
  .prompt((task) => [
    `Implement: ${task.title}`,
    task.description,
    task.deficits.length > 0 ? `Resolve these audit deficits:\n${task.deficits.join('\n')}` : '',
    task.guidance.length > 0 ? `Owner guidance: ${task.guidance}` : '',
    'If a decision belongs to the owner, set question instead of guessing.',
  ].join('\n\n'))
  .intents(['read', 'edit', 'execute']);

const auditRole = H.role('auditor')
  .input(z.object({ title: z.string(), description: z.string(), summary: z.string() }))
  .output(z.object({ deficits: z.array(z.string()) }))
  .prompt((work) => `Audit the change for "${work.title}".\n\n${work.description}\n\nBuilder summary: ${work.summary}\n\nList every remaining deficit; an empty list means done.`)
  .intents(['read', 'execute']);

const planRole = H.role('planner')
  .input(Ticket)
  .output(z.object({ features: z.array(Ticket) }))
  .prompt((epic) => `Decompose this epic into independently shippable features.\n\n${epic.title}\n\n${epic.description}`)
  .intents(['read']);

const codingExperience = H.memory('coding-experience', 'experience');
const ownerTaste = H.memory('owner-taste', 'taste');
const experienceJournal = H.library('coding-experience-journal', codingExperience, jsonl.memory('.harness/experience.jsonl'));
const tasteJournal = H.library('owner-taste-journal', ownerTaste, jsonl.memory('.harness/taste.jsonl'));

const sonnet = anthropic.model('claude-sonnet-4-5');
const opus = anthropic.model('claude-opus-4-1');

const maxOne = claudeCode.subscription('claude-max-1', { token: H.env('CLAUDE_MAX_1_TOKEN') });
const maxTwo = claudeCode.subscription('claude-max-2', { token: H.env('CLAUDE_MAX_2_TOKEN') });
const maxThree = claudeCode.subscription('claude-max-3', { token: H.env('CLAUDE_MAX_3_TOKEN') });
const apiFallback = anthropic.account('anthropic-api', { apiKey: H.env('ANTHROPIC_API_KEY') });

const soonestExpiringFirst = H.policy.account('soonest-expiring-first', ({ accounts }) => {
  const subscriptions = accounts
    .filter((view) => view.eligible && view.account.plan === 'subscription' && view.usedShare < view.share)
    .sort((a, b) => (a.windowEndsAt?.getTime() ?? Infinity) - (b.windowEndsAt?.getTime() ?? Infinity));
  const soonest = subscriptions[0];
  if (soonest) return soonest.account;
  const metered = accounts.find((view) => view.eligible && view.account.plan === 'metered');
  return metered ? metered.account : null;
});

const claudePool = H.pool('claude', [
  { account: maxOne, share: 0.5 },
  { account: maxTwo, share: 0.4 },
  { account: maxThree, share: 0.3 },
  { account: apiFallback, share: 1 },
], soonestExpiringFirst);

const cheaperUntilItSlips = H.policy.model('builder-model', ({ kind, metrics }) => {
  const cheap = metrics.successRate({ kind, model: sonnet, days: 14 });
  return cheap.samples >= 20 && cheap.value !== null && cheap.value < 0.85 ? opus : sonnet;
});

const worktree = git.worktree('attempt-worktree', { repo: '.', slots: 3 });
const local = shell.local('local', { slots: 4 });

const projectChecks = H.command('project-checks').argv(() => ['npm', 'run', 'check']).on(worktree);
const probeService = H.command('probe-service')
  .input(Service)
  .argv((target) => ['./scripts/probe.sh', target.service])
  .on(local);
const productionHealth = H.command('production-health').argv(() => ['./scripts/production-health.sh']).on(local);

const builder = H.agent('builder', buildRole)
  .model(cheaperUntilItSlips)
  .on(worktree)
  .recalls(experienceJournal, tasteJournal)
  .guards(claudeCode.fileLeases(), claudeCode.stopCheck(projectChecks));

const auditor = H.agent('auditor', auditRole)
  .model(opus)
  .on(worktree)
  .recalls(experienceJournal)
  .records(experienceJournal);

const planner = H.agent('planner', planRole).model(opus).recalls(tasteJournal);

const ownerDecision = H.halt('owner-decision', z.object({
  action: z.enum(['continue', 'abandon']),
  guidance: z.string(),
}));

const ticketWork = H.flow('ticket-work')
  .for(Bug, Feature)
  .states('building', 'done', 'exhausted', 'abandoned')
  .params(z.object({ rounds: z.number().int().positive() }))
  .does(async (ctx) => {
    await ctx.move('building');
    let deficits: string[] = [];
    let guidance = '';
    for (let round = 1; round <= ctx.params.rounds; round++) {
      const built = await ctx.run(builder, { ...ctx.unit.data, deficits, guidance });
      if (!built.ok) return ctx.fail(built.error);
      if (built.value.question !== null) {
        const decision = await ctx.halt(ownerDecision, built.value.question);
        if (decision.action === 'abandon') return 'abandoned';
        guidance = decision.guidance;
      }
      const audit = await ctx.run(auditor, { ...ctx.unit.data, summary: built.value.summary });
      if (!audit.ok) return ctx.fail(audit.error);
      if (audit.value.deficits.length === 0) return 'done';
      deficits = audit.value.deficits;
    }
    return 'exhausted';
  });

const bugTracker = linear.tracker(Bug, {
  apiKey: H.env('LINEAR_API_KEY'),
  team: 'PRODUCT',
  label: 'bug',
  read: (issue) => ({ title: issue.title, description: issue.description }),
  statuses: {
    'bug-open': 'Todo',
    building: 'In Progress',
    done: 'Done',
    'bug-stuck': 'Needs Attention',
    'bug-wont-fix': 'Canceled',
  },
});

const bugFolder = folder.files(Bug, {
  dir: 'bugs',
  read: (file) => {
    const title = file.frontmatter['title'];
    return { title: typeof title === 'string' ? title : file.path, description: file.body };
  },
});

const featureTracker = linear.tracker(Feature, {
  apiKey: H.env('LINEAR_API_KEY'),
  team: 'PRODUCT',
  label: 'feature',
  read: (issue) => ({ title: issue.title, description: issue.description }),
  statuses: {
    'feature-open': 'Todo',
    building: 'In Progress',
    done: 'Done',
    'feature-stuck': 'Needs Attention',
    'feature-dropped': 'Canceled',
  },
});

const epicTracker = linear.tracker(Epic, {
  apiKey: H.env('LINEAR_API_KEY'),
  team: 'PRODUCT',
  label: 'epic',
  read: (issue) => ({ title: issue.title, description: issue.description }),
  statuses: {
    'epic-open': 'Todo',
    'epic-planning': 'Planning',
    'epic-awaiting-features': 'In Progress',
    'epic-done': 'Done',
    'epic-failed': 'Needs Attention',
  },
});

const bugLane = H.lane('bugs', Bug)
  .handler(ticketWork, { params: { rounds: 3 }, states: { exhausted: 'bug-stuck', abandoned: 'bug-wont-fix' } })
  .suppliers(bugTracker, bugFolder, H.operator)
  .store(bugTracker)
  .wip(2);

const featureLane = H.lane('features', Feature)
  .handler(ticketWork, { params: { rounds: 5 }, states: { exhausted: 'feature-stuck', abandoned: 'feature-dropped' } })
  .suppliers(featureTracker, H.operator)
  .store(featureTracker);

const epicWork = H.flow('epic-work')
  .for(Epic)
  .does(async (ctx) => {
    await ctx.move('epic-planning');
    const plan = await ctx.run(planner, ctx.unit.data);
    if (!plan.ok) return ctx.fail(plan.error);
    const children = await ctx.spawn(featureLane, plan.value.features);
    const features = await ctx.wait('epic-awaiting-features', { children });
    return features.some((feature) => feature.state === 'feature-stuck') ? 'epic-failed' : 'epic-done';
  });

const epicLane = H.lane('epics', Epic)
  .handler(epicWork)
  .suppliers(epicTracker)
  .store(epicTracker)
  .wip(1);

const monitoredServices = ['api', 'web', 'worker'];

const heartbeatClock = H.clock('heartbeat-clock', ServiceHeartbeat, { every: { minutes: 5 } }, ({ now }) =>
  monitoredServices.map((service) => ({ create: { service }, key: `${service}@${now.toISOString()}` })));

const heartbeatCheck = H.flow('heartbeat-check')
  .for(ServiceHeartbeat)
  .does(async (ctx) => {
    const probe = await ctx.run(probeService, ctx.unit.data);
    return probe.ok ? 'heartbeat-ok' : 'heartbeat-down';
  });

const heartbeatLane = H.lane('heartbeats', ServiceHeartbeat)
  .handler(heartbeatCheck)
  .suppliers(heartbeatClock);

const downHeartbeatFilesBug = H.trigger('down-heartbeat-files-bug', H.on.enters(ServiceHeartbeat, 'heartbeat-down'), (event, act) =>
  act.create(bugLane, {
    title: `Service ${event.unit.data.service} failed its heartbeat`,
    description: `The heartbeat for ${event.unit.data.service} failed at ${event.at.toISOString()}. Find and fix the cause.`,
  }, `heartbeat-${event.unit.data.service}`));

const featureStarvationMs = 4 * 60 * 60 * 1000;

const codingOrder = H.policy.scheduler('heartbeats-bugs-features-epics', ({ pending }) => {
  const rank = (unit: PendingView): number => {
    if (unit.is(ServiceHeartbeat)) return 0;
    if (unit.is(Feature) && unit.waitedMs > featureStarvationMs) return 1;
    if (unit.is(Bug)) return 2;
    if (unit.is(Feature)) return 3;
    return 4;
  };
  return { start: [...pending].sort((a, b) => rank(a) - rank(b) || b.waitedMs - a.waitedMs) };
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
    H.operation('production-health-probe', productionHealth),
  ],
});

export const codingTeam = H.harness('coding-team')
  .ledger(sqlite.ledger('.harness/coding-team.sqlite'))
  .lanes(heartbeatLane, bugLane, featureLane, epicLane)
  .pools(claudePool)
  .triggers(downHeartbeatFilesBug)
  .scheduler(codingOrder)
  .clients(supervisor)
  .observers(markdown.board('BOARD.md'), markdown.telemetry('TELEMETRY.md'));

export const running = codingTeam.start();
