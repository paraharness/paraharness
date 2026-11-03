import { H } from 'harness-dsl';
import type { PendingView } from 'harness-dsl';
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

const ticketData = z.object({ title: z.string(), description: z.string() });

const ticketOpen = H.state('ticket-open', 'pending');
const ticketBuilding = H.state('ticket-building', 'active');
const ticketDone = H.state('ticket-done', 'terminal', 'success');
const ticketUnresolved = H.state('ticket-unresolved', 'terminal', 'failure');

const Bug = H.kind('bug').data(ticketData).states(ticketOpen, ticketBuilding, ticketDone, ticketUnresolved);
const Feature = H.kind('feature').data(ticketData).states(ticketOpen, ticketBuilding, ticketDone, ticketUnresolved);

const Epic = H.kind('epic')
  .data(ticketData)
  .states(
    H.state('epic-open', 'pending'),
    H.state('epic-planning', 'active'),
    H.state('epic-decomposed', 'waiting'),
    H.state('epic-done', 'terminal', 'success'),
    H.state('epic-incomplete', 'terminal', 'failure')
  );

const Heartbeat = H.kind('service-heartbeat')
  .data(z.object({ service: z.string() }))
  .states(
    H.state('beat-due', 'pending'),
    H.state('beating', 'active'),
    H.state('beat-ok', 'terminal', 'success'),
    H.state('beat-failed', 'terminal', 'failure')
  );

const experience = H.memory('coding-experience', 'experience');
const taste = H.memory('owner-taste', 'taste');
const experienceLibrary = H.library('coding-lessons', experience, jsonl.memory('.harness/experience.jsonl'));
const tasteLibrary = H.library('owner-preferences', taste, jsonl.memory('.harness/taste.jsonl'));

const sonnet = anthropic.model('claude-sonnet-4-5');
const opus = anthropic.model('claude-opus-4-1');

const builderModel = H.policy.model('builder-model', ({ kind, metrics }) => {
  const cheap = metrics.successRate({ kind, model: sonnet, days: 14 });
  const enoughSamples = cheap.samples >= 20;
  const tooWeak = cheap.value !== null && cheap.value < 0.85;
  return enoughSamples && tooWeak ? opus : sonnet;
});

const builderRole = H.role('builder')
  .input(z.object({
    title: z.string(),
    description: z.string(),
    deficits: z.array(z.string()),
    guidance: z.string()
  }))
  .output(z.object({ summary: z.string(), question: z.string().optional() }))
  .prompt((input) => [
    `Implement: ${input.title}`,
    input.description,
    input.deficits.length > 0 ? `Fix these deficits first:\n- ${input.deficits.join('\n- ')}` : '',
    input.guidance.length > 0 ? `Owner guidance: ${input.guidance}` : '',
    'If a decision belongs to the owner, return it as a question instead of guessing.'
  ].join('\n\n'))
  .intents(['read', 'edit', 'execute']);

const auditorRole = H.role('auditor')
  .input(z.object({ title: z.string(), description: z.string(), summary: z.string() }))
  .output(z.object({ deficits: z.array(z.string()) }))
  .prompt((input) => `Audit the change for "${input.title}".\n\n${input.description}\n\nBuilder summary:\n${input.summary}\n\nList every remaining deficit; an empty list means done.`)
  .intents(['read', 'execute']);

const plannerRole = H.role('planner')
  .input(z.object({ title: z.string(), description: z.string() }))
  .output(z.object({ features: z.array(z.object({ title: z.string(), description: z.string() })) }))
  .prompt((input) => `Decompose the epic "${input.title}" into independently shippable features.\n\n${input.description}`)
  .intents(['read']);

const worktrees = git.worktree('builder-worktrees', { repo: '.', slots: 3 });
const localShell = shell.local('local-shell', { slots: 4 });

const projectChecks = H.command('project-checks').argv(() => ['npm', 'run', 'check']);

const builder = H.agent('builder', builderRole)
  .model(builderModel)
  .on(worktrees)
  .recalls(experienceLibrary, tasteLibrary)
  .guards(claudeCode.fileLeases(), claudeCode.stopCheck(projectChecks));

const auditor = H.agent('auditor', auditorRole)
  .model(opus)
  .on(worktrees)
  .recalls(experienceLibrary)
  .records(experienceLibrary);

const planner = H.agent('planner', plannerRole).model(opus).recalls(tasteLibrary);

const ownerDecision = H.halt('owner-decision', z.object({ answer: z.string() }));

const ticketWork = H.flow('ticket-work')
  .for(Bug, Feature)
  .params(z.object({ rounds: z.number().int().positive() }))
  .does(async (ctx) => {
    const { title, description } = ctx.unit.data;
    let deficits: string[] = [];
    let guidance = '';
    let round = 0;
    await ctx.move('ticket-building');
    while (round < ctx.params.rounds) {
      const built = await ctx.run(builder, { title, description, deficits, guidance });
      if (!built.ok) return ctx.fail(built.error);
      const question = built.value.question;
      if (question !== undefined) {
        const decision = await ctx.halt(ownerDecision, question);
        guidance = decision.answer;
        continue;
      }
      round += 1;
      const audited = await ctx.run(auditor, { title, description, summary: built.value.summary });
      if (!audited.ok) return ctx.fail(audited.error);
      if (audited.value.deficits.length === 0) return 'ticket-done';
      deficits = audited.value.deficits;
    }
    return 'ticket-unresolved';
  });

const heartbeatCommand = H.command('service-health-check')
  .input(z.object({ service: z.string() }))
  .argv(({ service }) => ['curl', '-fsS', '--max-time', '10', `https://${service}.internal/health`])
  .on(localShell);

const heartbeatWork = H.flow('heartbeat-check')
  .for(Heartbeat)
  .does(async (ctx) => {
    await ctx.move('beating');
    const checked = await ctx.run(heartbeatCommand, { service: ctx.unit.data.service });
    return checked.ok ? 'beat-ok' : 'beat-failed';
  });

const linearKey = H.env('LINEAR_API_KEY');
const ticketStatuses = {
  'ticket-open': 'Todo',
  'ticket-building': 'In Progress',
  'ticket-done': 'Done',
  'ticket-unresolved': 'Needs Attention'
};

const bugTracker = linear.tracker(Bug, {
  apiKey: linearKey,
  team: 'product',
  label: 'bug',
  read: (issue) => ({ title: issue.title, description: issue.description }),
  statuses: ticketStatuses
});

const featureTracker = linear.tracker(Feature, {
  apiKey: linearKey,
  team: 'product',
  label: 'feature',
  read: (issue) => ({ title: issue.title, description: issue.description }),
  statuses: ticketStatuses
});

const epicTracker = linear.tracker(Epic, {
  apiKey: linearKey,
  team: 'product',
  label: 'epic',
  read: (issue) => ({ title: issue.title, description: issue.description }),
  statuses: {
    'epic-open': 'Todo',
    'epic-planning': 'In Progress',
    'epic-decomposed': 'In Progress',
    'epic-done': 'Done',
    'epic-incomplete': 'Needs Attention'
  }
});

const bugFolder = folder.files(Bug, {
  dir: 'bugs',
  read: (file) => {
    const title = file.frontmatter['title'];
    return { title: typeof title === 'string' ? title : file.path, description: file.body };
  }
});

const bugLane = H.lane('bugs', Bug)
  .handler(ticketWork, { params: { rounds: 3 } })
  .suppliers(bugTracker, bugFolder, H.operator)
  .store(bugTracker)
  .wip(2);

const featureLane = H.lane('features', Feature)
  .handler(ticketWork, { params: { rounds: 5 } })
  .suppliers(featureTracker, H.operator)
  .store(featureTracker);

const epicWork = H.flow('epic-work')
  .for(Epic)
  .does(async (ctx) => {
    await ctx.move('epic-planning');
    const plan = await ctx.run(planner, { title: ctx.unit.data.title, description: ctx.unit.data.description });
    if (!plan.ok) return ctx.fail(plan.error);
    const features = await ctx.spawn(featureLane, plan.value.features);
    const finished = await ctx.wait('epic-decomposed', { children: features });
    return finished.every((feature) => feature.state === 'ticket-done') ? 'epic-done' : 'epic-incomplete';
  });

const epicLane = H.lane('epics', Epic)
  .handler(epicWork)
  .suppliers(epicTracker)
  .store(epicTracker)
  .wip(1);

const services = ['api', 'web', 'worker'];

const heartbeatLane = H.lane('heartbeats', Heartbeat)
  .handler(heartbeatWork)
  .suppliers(H.clock('heartbeat-schedule', Heartbeat, { every: { minutes: 5 } }, ({ now }) =>
    services.map((service) => Heartbeat.create({ service }, `${service}-${now.toISOString()}`))));

const heartbeatBug = H.trigger('failed-heartbeat-files-bug', H.on.enters(Heartbeat, 'beat-failed'), (event, act) =>
  act.create(bugLane, {
    title: `Heartbeat failed for ${event.unit.data.service}`,
    description: `The deterministic health check for ${event.unit.data.service} failed at ${event.at.toISOString()}.`
  }, `heartbeat-${event.unit.data.service}-${event.at.toISOString()}`));

const max1 = claudeCode.subscription('claude-max-1', { token: H.env('CLAUDE_MAX_TOKEN_1') });
const max2 = claudeCode.subscription('claude-max-2', { token: H.env('CLAUDE_MAX_TOKEN_2') });
const max3 = claudeCode.subscription('claude-max-3', { token: H.env('CLAUDE_MAX_TOKEN_3') });
const apiAccount = anthropic.account('anthropic-api', { apiKey: H.env('ANTHROPIC_API_KEY') });

const drainSoonestExpiring = H.policy.account('drain-soonest-expiring', ({ accounts }) => {
  const subscriptions = accounts
    .filter((view) => view.eligible && view.account.plan === 'subscription' && view.usedShare < view.share)
    .sort((a, b) => (a.windowEndsAt?.getTime() ?? Infinity) - (b.windowEndsAt?.getTime() ?? Infinity));
  const soonest = subscriptions[0];
  if (soonest !== undefined) return soonest.account;
  const fallback = accounts.find((view) => view.eligible && view.account === apiAccount);
  return fallback === undefined ? null : fallback.account;
});

const claudePool = H.pool('claude-accounts', [
  { account: max1, share: 0.5 },
  { account: max2, share: 0.3 },
  { account: max3, share: 0.2 },
  { account: apiAccount, share: 1 }
], drainSoonestExpiring);

const featureStarvationMs = 2 * 60 * 60 * 1000;

const rank = (unit: PendingView): number => {
  if (unit.is(Heartbeat)) return 0;
  if (unit.is(Feature) && unit.waitedMs > featureStarvationMs) return 1;
  if (unit.is(Bug)) return 2;
  if (unit.is(Feature)) return 3;
  return 4;
};

const priority = H.policy.scheduler('heartbeats-bugs-features-epics', ({ pending }) => ({
  start: [...pending].sort((a, b) => rank(a) - rank(b) || b.waitedMs - a.waitedMs)
}));

const productionHealthProbe = H.command('production-health-probe')
  .argv(() => ['curl', '-fsS', 'https://app.example.com/health'])
  .on(localShell);

const supervisor = claudeCode.supervisor({
  grants: [
    H.ops.readWork,
    H.ops.writeWork,
    H.ops.resolveHalts,
    H.ops.writeMemory,
    H.ops.readTelemetry,
    H.ops.readAccounts,
    H.ops.setShares,
    H.operation('production-health', productionHealthProbe)
  ]
});

export default H.harness('coding-team')
  .ledger(sqlite.ledger('.harness/coding-team.db'))
  .lanes(heartbeatLane, bugLane, featureLane, epicLane)
  .pools(claudePool)
  .triggers(heartbeatBug)
  .scheduler(priority)
  .clients(supervisor)
  .observers(markdown.board('BOARD.md'), markdown.telemetry('TELEMETRY.md'));
