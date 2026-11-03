import { z } from 'zod';
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

const queued = H.state('queued', 'pending');
const building = H.state('building', 'active');
const done = H.state('done', 'terminal', 'success');
const wontfix = H.state('wontfix', 'terminal', 'neutral');
const planning = H.state('planning', 'active');
const featuresInFlight = H.state('featuresInFlight', 'waiting');
const assembling = H.state('assembling', 'pending');
const due = H.state('due', 'pending');
const probing = H.state('probing', 'active');
const healthy = H.state('healthy', 'terminal', 'success');
const down = H.state('down', 'terminal', 'failure');

const ticket = z.object({ title: z.string(), description: z.string() });

const Bug = H.kind('Bug').data(ticket).states(queued, building, done, wontfix);
const Feature = H.kind('Feature')
  .data(ticket.extend({ epic: z.string().optional() }))
  .states(queued, building, done, wontfix);
const Epic = H.kind('Epic').data(ticket).states(queued, planning, featuresInFlight, assembling, done, wontfix);
const Heartbeat = H.kind('Heartbeat').data(z.object({ service: z.string() })).states(due, probing, healthy, down);

const builderRole = H.role('builder')
  .input(z.object({
    title: z.string(),
    description: z.string(),
    deficits: z.array(z.string()),
    decision: z.string().optional(),
  }))
  .output(z.object({ summary: z.string(), question: z.string().optional() }))
  .prompt((input) =>
    `Implement: ${input.title}\n\n${input.description}\n\nOpen deficits:\n${input.deficits.join('\n')}\n\nOwner decision: ${input.decision ?? 'none'}`)
  .intents(['read', 'edit', 'execute']);

const auditorRole = H.role('auditor')
  .input(z.object({ title: z.string(), description: z.string(), summary: z.string() }))
  .output(z.object({ deficits: z.array(z.string()) }))
  .prompt((input) => `Audit the change for "${input.title}".\n\n${input.description}\n\nBuilder summary: ${input.summary}`)
  .intents(['read', 'execute']);

const plannerRole = H.role('planner')
  .input(z.object({ title: z.string(), description: z.string() }))
  .output(z.object({ features: z.array(z.object({ title: z.string(), description: z.string() })) }))
  .prompt((input) => `Decompose the epic "${input.title}" into features.\n\n${input.description}`)
  .intents(['read']);

const experience = H.memory('experience', 'experience');
const taste = H.memory('taste', 'taste');
const teamExperience = H.archive('team-experience', experience, jsonl.memory('.harness/experience.jsonl'));
const ownerTaste = H.archive('owner-taste', taste, jsonl.memory('.harness/taste.jsonl'));
const buildBriefing = H.briefing('build-briefing', [teamExperience, ownerTaste]);
const auditBriefing = H.briefing('audit-briefing', [teamExperience]);
const planBriefing = H.briefing('plan-briefing', [ownerTaste]);

const sonnet = cc.model('claude-sonnet-4-5');
const opus = cc.model('claude-opus-4-1');

const cheapUntilWeak = H.policy.model('cheap-until-weak', (choice) => {
  const record = choice.metrics.successRate({ kind: choice.kind, model: sonnet, days: 14 });
  if (record.samples < 20 || record.value === null) return sonnet;
  return record.value < 0.85 ? opus : sonnet;
});

const subscriptionOne = cc.subscription('claude-1', { token: H.env('CLAUDE_TOKEN_1') });
const subscriptionTwo = cc.subscription('claude-2', { token: H.env('CLAUDE_TOKEN_2') });
const subscriptionThree = cc.subscription('claude-3', { token: H.env('CLAUDE_TOKEN_3') });
const apiFallback = anthropic.account('api-fallback', { apiKey: H.env('ANTHROPIC_API_KEY') });

const soonestExpiringFirst = H.policy.account('soonest-expiring-first', (choice) => {
  const open = choice.accounts.filter(
    (view) => view.eligible && view.account.plan === 'subscription' && view.usedShare < view.share
  );
  const ordered = [...open].sort(
    (a, b) => (a.windowEndsAt?.getTime() ?? Infinity) - (b.windowEndsAt?.getTime() ?? Infinity)
  );
  const first = ordered[0];
  if (first) return first.account;
  const metered = choice.accounts.find((view) => view.eligible && view.account.plan === 'metered');
  return metered ? metered.account : null;
});

const claudePool = H.pool(
  'claude',
  [
    { account: subscriptionOne, share: 0.7 },
    { account: subscriptionTwo, share: 0.7 },
    { account: subscriptionThree, share: 0.5 },
    { account: apiFallback, share: 1 },
  ],
  soonestExpiringFirst
);

const worktrees = git.worktree('worktrees', { repo: '.', slots: 3 });
const local = shell.local('local', { slots: 4 });

const projectChecks = H.command('project-checks').argv(() => ['npm', 'run', 'check']);

const builder = H.agent('builder', builderRole)
  .model(cheapUntilWeak)
  .on(worktrees)
  .recalls(buildBriefing)
  .guards(cc.fileLeases(), cc.stopCheck(projectChecks));

const auditor = H.agent('auditor', auditorRole)
  .model(opus)
  .on(worktrees)
  .recalls(auditBriefing)
  .records(teamExperience);

const planner = H.agent('planner', plannerRole).model(opus).recalls(planBriefing);

const ownerDecision = H.halt('owner-decision', z.object({ decision: z.string() }));

const buildAndAudit = H.flow('build-and-audit')
  .for(Bug, Feature)
  .params(z.object({ rounds: z.number().int().positive() }))
  .does(async (ctx) => {
    await ctx.move('building');
    const { title, description } = ctx.unit.data;
    let deficits: string[] = [];
    let decision: string | undefined;
    for (let round = 1; round <= ctx.params.rounds; round += 1) {
      const built = await ctx.run(builder, { title, description, deficits, decision });
      if (!built.ok) return ctx.fail(built.error);
      if (built.value.question) {
        const answer = await ctx.halt(ownerDecision, built.value.question);
        decision = answer.decision;
        continue;
      }
      const audit = await ctx.run(auditor, { title, description, summary: built.value.summary });
      if (!audit.ok) return ctx.fail(audit.error);
      if (audit.value.deficits.length === 0) return 'done';
      deficits = audit.value.deficits;
    }
    return ctx.fail(`deficits remain after ${ctx.params.rounds} rounds`);
  });

const linearKey = H.env('LINEAR_API_KEY');

const bugTracker = linear.tracker(Bug, {
  apiKey: linearKey,
  team: 'PRODUCT',
  label: 'bug',
  read: (issue) => ({ title: issue.title, description: issue.description }),
  statuses: { queued: 'Todo', building: 'In Progress', done: 'Done', wontfix: 'Canceled' },
});

const featureTracker = linear.tracker(Feature, {
  apiKey: linearKey,
  team: 'PRODUCT',
  label: 'feature',
  read: (issue) => ({ title: issue.title, description: issue.description, epic: issue.parentId }),
  statuses: { queued: 'Todo', building: 'In Progress', done: 'Done', wontfix: 'Canceled' },
});

const epicTracker = linear.tracker(Epic, {
  apiKey: linearKey,
  team: 'PRODUCT',
  label: 'epic',
  read: (issue) => ({ title: issue.title, description: issue.description }),
  statuses: {
    queued: 'Todo',
    planning: 'Planning',
    featuresInFlight: 'In Progress',
    assembling: 'In Review',
    done: 'Done',
    wontfix: 'Canceled',
  },
});

const bugFolder = folder.files(Bug, {
  dir: 'bugs',
  read: (file) => ({ title: String(file.frontmatter['title'] ?? file.path), description: file.body }),
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

const epicFlow = H.flow('epic')
  .for(Epic)
  .does(async (ctx) => {
    await ctx.move('planning');
    const plan = await ctx.run(planner, { title: ctx.unit.data.title, description: ctx.unit.data.description });
    if (!plan.ok) return ctx.fail(plan.error);
    await ctx.spawn(features, plan.value.features.map((feature) => ({ ...feature, epic: ctx.unit.key })));
    return ctx.wait('featuresInFlight', { children: true, then: 'assembling' });
  })
  .phase('assembling', async (ctx) => {
    const children = await ctx.children(features);
    if (children.some((child) => child.position !== 'terminal')) {
      return ctx.wait('featuresInFlight', { children: true, then: 'assembling' });
    }
    return 'done';
  });

const epics = H.lane('epics', Epic).handler(epicFlow).suppliers(epicTracker).store(epicTracker).wip(1);

const probe = H.command('service-probe')
  .input(z.object({ service: z.string() }))
  .argv((input) => ['curl', '-fsS', `https://${input.service}.internal/health`])
  .on(local);

const heartbeatFlow = H.flow('heartbeat')
  .for(Heartbeat)
  .does(async (ctx) => {
    await ctx.move('probing');
    const result = await ctx.run(probe, { service: ctx.unit.data.service });
    return result.ok ? 'healthy' : 'down';
  });

const heartbeatClock = H.clock('every-five-minutes', Heartbeat, { every: { minutes: 5 } }, () => [
  { create: { service: 'api' } },
]);

const heartbeats = H.lane('heartbeats', Heartbeat).handler(heartbeatFlow).suppliers(heartbeatClock);

const outageFilesBug = H.trigger('outage-files-bug', H.on.enters(Heartbeat, 'down'), (event, act) =>
  act.create(bugs, {
    title: `Heartbeat down: ${event.unit.data.service}`,
    description: `The ${event.unit.data.service} heartbeat failed at ${event.at.toISOString()}.`,
  })
);

const laneOrder = [heartbeats.name, bugs.name, features.name, epics.name];
const starvedAfterMs = 2 * 60 * 60 * 1000;
const rank = (unit: PendingView): number =>
  unit.lane === features.name && unit.waitedMs > starvedAfterMs ? 0.5 : laneOrder.indexOf(unit.lane);

const scheduler = H.policy.scheduler('heartbeats-bugs-features-epics', (view) => ({
  start: [...view.pending].sort((a, b) => rank(a) - rank(b) || b.waitedMs - a.waitedMs),
}));

const productionHealth = H.command('production-health')
  .argv(() => ['curl', '-fsS', 'https://status.example.com/health'])
  .on(local);

const supervisor = cc.supervisor({
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

export const codingTeam = H.harness('coding-team')
  .ledger(sqlite.ledger('.harness/ledger.db'))
  .lanes(heartbeats, bugs, features, epics)
  .pools(claudePool)
  .triggers(outageFilesBug)
  .scheduler(scheduler)
  .clients(supervisor)
  .observers(markdown.board('BOARD.md'), markdown.telemetry('TELEMETRY.md'));

export const running = codingTeam.start();
