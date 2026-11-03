import { z } from 'zod';
import { H } from 'harness-dsl';
import type { PendingView } from 'harness-dsl';
import * as claude from 'harness-dsl/claude-code';
import * as anthropic from 'harness-dsl/anthropic';
import * as linear from 'harness-dsl/linear';
import * as folder from 'harness-dsl/folder';
import * as sqlite from 'harness-dsl/sqlite';
import * as jsonl from 'harness-dsl/jsonl';
import * as git from 'harness-dsl/git';
import * as shell from 'harness-dsl/shell';
import * as markdown from 'harness-dsl/markdown';

const ticket = z.object({ title: z.string(), description: z.string() });

const building = H.state('building', 'active');
const auditing = H.state('auditing', 'active');

const reported = H.state('reported', 'pending');
const fixed = H.state('fixed', 'terminal', 'success');
const unfixed = H.state('unfixed', 'terminal', 'failure');
const Bug = H.kind('bug').data(ticket).states(reported, building, auditing, fixed, unfixed);

const proposed = H.state('proposed', 'pending');
const shipped = H.state('shipped', 'terminal', 'success');
const needsDesign = H.state('needs-design', 'terminal', 'failure');
const Feature = H.kind('feature').data(ticket).states(proposed, building, auditing, shipped, needsDesign);

const open = H.state('open', 'pending');
const planning = H.state('planning', 'active');
const delivering = H.state('delivering', 'waiting');
const complete = H.state('complete', 'terminal', 'success');
const incomplete = H.state('incomplete', 'terminal', 'failure');
const Epic = H.kind('epic').data(ticket).states(open, planning, delivering, complete, incomplete);

const due = H.state('due', 'pending');
const probing = H.state('probing', 'active');
const healthy = H.state('healthy', 'terminal', 'success');
const unhealthy = H.state('unhealthy', 'terminal', 'failure');
const Heartbeat = H.kind('service-heartbeat').data(z.object({ service: z.string() })).states(due, probing, healthy, unhealthy);

const worktree = git.worktree('worktree', { repo: '.', slots: 3 });
const local = shell.local('local', { slots: 2 });

const experience = H.memory('experience', 'experience');
const taste = H.memory('taste', 'taste');
const experienceLibrary = H.library('project-experience', experience, jsonl.memory('.harness/experience.jsonl'));
const tasteLibrary = H.library('owner-taste', taste, jsonl.memory('.harness/taste.jsonl'));

const subscriptionOne = claude.subscription('claude-one', { token: H.env('CLAUDE_TOKEN_ONE') });
const subscriptionTwo = claude.subscription('claude-two', { token: H.env('CLAUDE_TOKEN_TWO') });
const subscriptionThree = claude.subscription('claude-three', { token: H.env('CLAUDE_TOKEN_THREE') });
const apiAccount = anthropic.account('anthropic-api', { apiKey: H.env('ANTHROPIC_API_KEY') });

const soonestExpiring = H.policy.account('soonest-expiring-first', ({ accounts }) => {
  const open = accounts.filter((view) => view.eligible && view.account.plan === 'subscription' && view.usedShare < view.share);
  const sorted = [...open].sort(
    (a, b) => (a.windowEndsAt?.getTime() ?? Number.POSITIVE_INFINITY) - (b.windowEndsAt?.getTime() ?? Number.POSITIVE_INFINITY)
  );
  const first = sorted[0];
  if (first !== undefined) return first.account;
  const metered = accounts.find((view) => view.eligible && view.account.plan === 'metered');
  return metered === undefined ? null : metered.account;
});

const claudePool = H.pool(
  'claude',
  [
    { account: subscriptionOne, share: 0.6 },
    { account: subscriptionTwo, share: 0.6 },
    { account: subscriptionThree, share: 0.4 },
    { account: apiAccount, share: 1 },
  ],
  soonestExpiring
);

const cheapModel = anthropic.model('claude-sonnet-4-5');
const strongModel = anthropic.model('claude-opus-4-1');

const builderModel = H.policy.model('builder-model', ({ kind, metrics }) => {
  const cheapRate = metrics.successRate({ kind, model: cheapModel, days: 14 });
  if (cheapRate.samples < 20 || cheapRate.value === null) return cheapModel;
  return cheapRate.value >= 0.85 ? cheapModel : strongModel;
});

const projectChecks = H.command('project-checks').argv(() => ['npm', 'run', 'check']).on(worktree);

const builderRole = H.role('builder')
  .input(z.object({ title: z.string(), description: z.string(), deficits: z.array(z.string()), ownerAnswer: z.string().optional() }))
  .output(z.object({ summary: z.string(), question: z.string().optional() }))
  .prompt((input) =>
    `Implement: ${input.title}\n${input.description}\nOpen deficits: ${input.deficits.join('; ')}\nOwner answer: ${input.ownerAnswer ?? 'none'}`
  )
  .intents(['read', 'edit', 'execute']);

const auditorRole = H.role('auditor')
  .input(z.object({ title: z.string(), description: z.string(), summary: z.string() }))
  .output(z.object({ deficits: z.array(z.string()) }))
  .prompt((input) => `Audit the change for "${input.title}".\n${input.description}\nBuilder says: ${input.summary}`)
  .intents(['read', 'execute']);

const plannerRole = H.role('planner')
  .input(z.object({ title: z.string(), description: z.string() }))
  .output(z.object({ features: z.array(z.object({ title: z.string(), description: z.string() })) }))
  .prompt((input) => `Decompose the epic "${input.title}" into features.\n${input.description}`)
  .intents(['read']);

const builder = H.agent('builder', builderRole)
  .model(builderModel)
  .on(worktree)
  .recalls(experienceLibrary, tasteLibrary)
  .guards(claude.fileLeases(), claude.stopCheck(projectChecks));

const auditor = H.agent('auditor', auditorRole)
  .model(strongModel)
  .on(worktree)
  .recalls(experienceLibrary)
  .records(experienceLibrary);

const planner = H.agent('planner', plannerRole).model(strongModel).on(worktree).recalls(tasteLibrary);

const ownerDecision = H.halt('owner-decision', z.object({ answer: z.string() }));

const ticketWork = H.flow('ticket-work')
  .for(Bug, Feature)
  .params(z.object({ rounds: z.number().int() }))
  .phases('building', 'auditing')
  .exits('done', 'exhausted')
  .does(async (ctx) => {
    let deficits: string[] = [];
    let ownerAnswer: string | undefined;
    for (let round = 1; round <= ctx.params.rounds; round += 1) {
      await ctx.move('building');
      const built = await ctx.run(builder, {
        title: ctx.unit.data.title,
        description: ctx.unit.data.description,
        deficits,
        ownerAnswer,
      });
      if (!built.ok) return ctx.fail(built.error);
      if (built.value.question !== undefined) {
        const decision = await ctx.halt(ownerDecision, built.value.question);
        ownerAnswer = decision.answer;
        continue;
      }
      await ctx.move('auditing');
      const audit = await ctx.run(auditor, {
        title: ctx.unit.data.title,
        description: ctx.unit.data.description,
        summary: built.value.summary,
      });
      if (!audit.ok) return ctx.fail(audit.error);
      if (audit.value.deficits.length === 0) return 'done';
      deficits = audit.value.deficits;
    }
    return 'exhausted';
  });

const heartbeatProbe = H.command('heartbeat-probe')
  .input(z.object({ service: z.string() }))
  .argv((input) => ['curl', '-fsS', `https://${input.service}.internal/health`])
  .on(local)
  .recovery('rerun');

const heartbeatWork = H.flow('heartbeat-work')
  .for(Heartbeat)
  .phases('probing')
  .exits('healthy', 'unhealthy')
  .does(async (ctx) => {
    await ctx.move('probing');
    const probe = await ctx.run(heartbeatProbe, { service: ctx.unit.data.service });
    return probe.ok ? 'healthy' : 'unhealthy';
  });

const linearKey = H.env('LINEAR_API_KEY');

const bugTracker = linear.tracker(Bug, {
  apiKey: linearKey,
  team: 'ENG',
  label: 'bug',
  read: (issue) => ({ title: issue.title, description: issue.description }),
  statuses: { reported: 'Triage', building: 'In Progress', auditing: 'In Review', fixed: 'Done', unfixed: 'Canceled' },
});

const featureTracker = linear.tracker(Feature, {
  apiKey: linearKey,
  team: 'ENG',
  label: 'feature',
  read: (issue) => ({ title: issue.title, description: issue.description }),
  statuses: { proposed: 'Backlog', building: 'In Progress', auditing: 'In Review', shipped: 'Done', 'needs-design': 'Needs Design' },
});

const epicTracker = linear.tracker(Epic, {
  apiKey: linearKey,
  team: 'ENG',
  label: 'epic',
  read: (issue) => ({ title: issue.title, description: issue.description }),
  statuses: { open: 'Backlog', planning: 'Planning', delivering: 'In Progress', complete: 'Done', incomplete: 'Canceled' },
});

const bugFolder = folder.files(Bug, {
  dir: 'bugs',
  read: (file) => ({ title: file.path, description: file.body }),
});

const heartbeatSchedule = H.clock('heartbeat-schedule', Heartbeat, { every: { minutes: 5 } }, ({ now }) =>
  ['api', 'web', 'worker'].map((service) => ({ create: { service }, key: `${service}@${now.toISOString()}` }))
);

const heartbeats = H.lane('heartbeats', Heartbeat)
  .handler(heartbeatWork, { probing, healthy, unhealthy })
  .suppliers(heartbeatSchedule);

const bugs = H.lane('bugs', Bug)
  .handler(ticketWork, { building, auditing, done: fixed, exhausted: unfixed }, { rounds: 3 })
  .suppliers(bugTracker, bugFolder, H.operator)
  .store(bugTracker)
  .wip(2);

const features = H.lane('features', Feature)
  .handler(ticketWork, { building, auditing, done: shipped, exhausted: needsDesign }, { rounds: 5 })
  .suppliers(featureTracker, H.operator)
  .store(featureTracker);

const epicWork = H.flow('epic-work')
  .for(Epic)
  .phases('planning', 'delivering')
  .exits('complete', 'incomplete')
  .does(async (ctx) => {
    await ctx.move('planning');
    const plan = await ctx.run(planner, { title: ctx.unit.data.title, description: ctx.unit.data.description });
    if (!plan.ok) return ctx.fail(plan.error);
    const children = await ctx.spawn(features, plan.value.features);
    const delivered = await ctx.wait('delivering', { children });
    return delivered.every((unit) => unit.state === 'shipped') ? 'complete' : 'incomplete';
  });

const epics = H.lane('epics', Epic)
  .handler(epicWork, { planning, delivering, complete, incomplete })
  .suppliers(epicTracker)
  .store(epicTracker)
  .wip(1);

const heartbeatFilesBug = H.trigger('heartbeat-failure-files-bug', H.on.enters(Heartbeat, 'unhealthy'), (event, act) =>
  act.create(
    bugs,
    {
      title: `Service ${event.unit.data.service} failed its heartbeat`,
      description: `The heartbeat for ${event.unit.data.service} was unhealthy at ${event.at.toISOString()}.`,
    },
    `heartbeat-${event.unit.data.service}`
  )
);

const featureStarvationMs = 6 * 60 * 60 * 1000;

const priority = (unit: PendingView): number => {
  if (unit.is(Heartbeat)) return 0;
  if (unit.is(Feature) && unit.waitedMs > featureStarvationMs) return 1;
  if (unit.is(Bug)) return 2;
  if (unit.is(Feature)) return 3;
  return 4;
};

const codingOrder = H.policy.scheduler('coding-order', ({ pending }) => ({
  start: [...pending].sort((a, b) => priority(a) - priority(b) || b.waitedMs - a.waitedMs),
}));

const productionProbe = H.command('production-health').argv(() => ['curl', '-fsS', 'https://example.com/health']).on(local);

const supervisor = claude.supervisor({
  grants: [
    H.ops.readWork,
    H.ops.writeWork,
    H.ops.resolveHalts,
    H.ops.writeMemory,
    H.ops.readTelemetry,
    H.ops.readAccounts,
    H.ops.setShares,
    H.operation('production-health', productionProbe),
  ],
});

export const codingTeam = H.harness('coding-team')
  .ledger(sqlite.ledger('.harness/ledger.db'))
  .lanes(heartbeats, bugs, features, epics)
  .pools(claudePool)
  .triggers(heartbeatFilesBug)
  .scheduler(codingOrder)
  .clients(supervisor)
  .observers(markdown.board('BOARD.md'), markdown.telemetry('TELEMETRY.md'));

export const running = codingTeam.start();
