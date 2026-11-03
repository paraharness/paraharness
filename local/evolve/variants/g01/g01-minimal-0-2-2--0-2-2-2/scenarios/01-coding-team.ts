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

const todo = H.state('todo', 'pending');
const done = H.state('done', 'terminal', 'success');
const wontfix = H.state('wontfix', 'terminal', 'neutral');
const abandoned = H.state('abandoned', 'terminal', 'failure');

const open = H.state('open', 'pending');
const awaitingFeatures = H.state('awaiting-features', 'waiting');
const incomplete = H.state('incomplete', 'terminal', 'failure');

const due = H.state('due', 'pending');
const up = H.state('up', 'terminal', 'success');
const down = H.state('down', 'terminal', 'failure');

const workItem = z.object({ title: z.string(), description: z.string() });

const Bug = H.kind('Bug').data(workItem).states(todo, done, wontfix, abandoned);
const Feature = H.kind('Feature').data(workItem).states(todo, done, wontfix, abandoned);
const Epic = H.kind('Epic').data(workItem).states(open, awaitingFeatures, done, incomplete);
const Heartbeat = H.kind('ServiceHeartbeat').data(z.object({ service: z.string() })).states(due, up, down);

const experience = H.memory('experience', 'experience');
const taste = H.memory('taste', 'taste');
const experienceJournal = H.journal('experience', experience, jsonl.memory('.harness/experience.jsonl'));
const tasteJournal = H.journal('taste', taste, jsonl.memory('.harness/taste.jsonl'));

const worktrees = git.worktree('worktrees', { repo: '.', slots: 3 });
const local = shell.local('local', { slots: 4 });

const projectChecks = H.command('project-checks')
  .argv(() => ['npm', 'run', 'check'])
  .on(worktrees)
  .recovery('rerun');

const probeService = H.command('probe-service')
  .input(z.object({ service: z.string() }))
  .argv(input => ['curl', '-fsS', `https://${input.service}.internal/health`])
  .on(local)
  .recovery('rerun');

const probeProduction = H.command('probe-production')
  .argv(() => ['curl', '-fsS', 'https://app.example.com/health'])
  .on(local)
  .recovery('rerun');

const sonnet = claude.model('claude-sonnet-4-5');
const opus = claude.model('claude-opus-4-1');

const builderModel = H.policy.model('builder-model', choice => {
  const cheap = choice.metrics.successRate({ kind: choice.kind, seat: choice.seat, model: sonnet, days: 14 });
  const belowBar = cheap.samples >= 20 && cheap.value !== null && cheap.value < 0.85;
  return belowBar ? opus : sonnet;
});

const builderRole = H.role('builder')
  .input(z.object({ title: z.string(), description: z.string(), deficits: z.array(z.string()) }))
  .output(z.object({ summary: z.string(), question: z.string().optional() }))
  .prompt(input => `Build: ${input.title}\n\n${input.description}\n\nOpen deficits:\n${input.deficits.join('\n')}`)
  .intents(['read', 'edit', 'execute']);

const auditorRole = H.role('auditor')
  .input(z.object({ title: z.string(), description: z.string(), summary: z.string() }))
  .output(z.object({ deficits: z.array(z.string()) }))
  .prompt(input => `Audit the change for "${input.title}".\n\n${input.description}\n\nBuilder summary:\n${input.summary}`)
  .intents(['read', 'execute']);

const plannerRole = H.role('planner')
  .input(z.object({ title: z.string(), description: z.string() }))
  .output(z.object({ features: z.array(workItem) }))
  .prompt(input => `Decompose the epic "${input.title}" into features.\n\n${input.description}`)
  .intents(['read']);

const builder = H.seat('builder', builderRole)
  .model(builderModel)
  .on(worktrees)
  .recalls(experienceJournal, tasteJournal)
  .guards(claude.fileLeases(), claude.stopCheck(projectChecks));

const auditor = H.seat('auditor', auditorRole)
  .model(opus)
  .on(worktrees)
  .recalls(experienceJournal)
  .records(experienceJournal);

const planner = H.seat('planner', plannerRole)
  .model(opus)
  .recalls(tasteJournal);

const ownerDecision = H.halt('owner-decision', z.object({ proceed: z.boolean(), answer: z.string() }));

const delivery = H.flow('delivery')
  .for(Bug, Feature)
  .params(z.object({ rounds: z.number().int() }))
  .does(async ctx => {
    const { title, description } = ctx.unit.data;
    let deficits: string[] = [];
    for (let round = 0; round < ctx.params.rounds; round++) {
      const built = await ctx.run(builder, { title, description, deficits });
      if (!built.ok) return ctx.fail(built.error);
      const question = built.value.question;
      if (question) {
        const decision = await ctx.halt(ownerDecision, question);
        if (!decision.proceed) return 'wontfix';
      }
      const audit = await ctx.run(auditor, { title, description, summary: built.value.summary });
      if (!audit.ok) return ctx.fail(audit.error);
      if (audit.value.deficits.length === 0) return 'done';
      deficits = audit.value.deficits;
    }
    return ctx.fail(`deficits remain after ${ctx.params.rounds} rounds`);
  });

const heartbeatFlow = H.flow('heartbeat')
  .for(Heartbeat)
  .does(async ctx => {
    const probe = await ctx.run(probeService, { service: ctx.unit.data.service });
    return probe.ok ? 'up' : 'down';
  });

const threeAttempts = H.policy.retry('three-attempts', view =>
  view.failures >= 3 ? 'stop' : { retryInMs: 60_000 * 2 ** view.failures }
);

const linearKey = H.env('LINEAR_API_KEY');
const deliveryStatuses = { todo: 'Todo', done: 'Done', wontfix: 'Canceled', abandoned: 'Stuck' };

const bugTracker = linear.tracker(Bug, {
  apiKey: linearKey,
  team: 'ENG',
  label: 'bug',
  read: issue => ({ title: issue.title, description: issue.description }),
  statuses: deliveryStatuses,
});
const featureTracker = linear.tracker(Feature, {
  apiKey: linearKey,
  team: 'ENG',
  label: 'feature',
  read: issue => ({ title: issue.title, description: issue.description }),
  statuses: deliveryStatuses,
});
const epicTracker = linear.tracker(Epic, {
  apiKey: linearKey,
  team: 'ENG',
  label: 'epic',
  read: issue => ({ title: issue.title, description: issue.description }),
  statuses: { open: 'Todo', 'awaiting-features': 'In Progress', done: 'Done', incomplete: 'Stuck' },
});
const bugFolder = folder.files(Bug, {
  dir: 'bugs',
  read: file => ({ title: file.path, description: file.body }),
});

const bugs = H.lane('bugs', Bug)
  .handler(delivery, { rounds: 3 })
  .suppliers(bugTracker, bugFolder, H.operator)
  .store(bugTracker)
  .wip(2)
  .retry(threeAttempts, 'abandoned');

const features = H.lane('features', Feature)
  .handler(delivery, { rounds: 5 })
  .suppliers(featureTracker, H.operator)
  .store(featureTracker)
  .retry(threeAttempts, 'abandoned');

const epicFlow = H.flow('epic')
  .for(Epic)
  .does(async ctx => {
    const plan = await ctx.run(planner, { title: ctx.unit.data.title, description: ctx.unit.data.description });
    if (!plan.ok) return ctx.fail(plan.error);
    const children = await ctx.spawn(features, plan.value.features);
    const finished = await ctx.wait('awaiting-features', { children });
    return finished.every(feature => feature.state === 'done') ? 'done' : 'incomplete';
  });

const epics = H.lane('epics', Epic)
  .handler(epicFlow)
  .suppliers(epicTracker)
  .store(epicTracker)
  .wip(1);

const heartbeats = H.lane('heartbeats', Heartbeat)
  .handler(heartbeatFlow)
  .suppliers(
    H.clock('heartbeat-every-five-minutes', Heartbeat, { every: { minutes: 5 } }, tick => [
      { create: { service: 'api' }, key: `api-${tick.now.toISOString()}` },
    ])
  );

const heartbeatDownFilesBug = H.trigger('heartbeat-down-files-bug', H.on.enters(Heartbeat, 'down'), (event, act) =>
  act.create(bugs, {
    title: `Service ${event.unit.data.service} failed its heartbeat`,
    description: `The heartbeat at ${event.at.toISOString()} failed.`,
  })
);

const featureStarvationMs = 6 * 60 * 60 * 1000;

const codingScheduler = H.policy.scheduler('coding-priority', view => {
  const rank = (unit: PendingView): number => {
    if (unit.is(Heartbeat)) return 0;
    if (unit.is(Feature) && unit.waitedMs > featureStarvationMs) return 1;
    if (unit.is(Bug)) return 2;
    if (unit.is(Feature)) return 3;
    return 4;
  };
  return { start: [...view.pending].sort((a, b) => rank(a) - rank(b) || b.waitedMs - a.waitedMs) };
});

const soonestExpiring = H.policy.account('soonest-expiring-first', ({ accounts }) => {
  const subscriptions = accounts
    .filter(view => view.eligible && view.account.plan === 'subscription' && view.usedShare < view.share)
    .sort((a, b) => (a.windowEndsAt?.getTime() ?? Infinity) - (b.windowEndsAt?.getTime() ?? Infinity));
  const first = subscriptions[0];
  if (first) return first.account;
  const metered = accounts.find(view => view.eligible && view.account.plan === 'metered');
  return metered ? metered.account : null;
});

const claudePool = H.pool(
  'claude',
  [
    { account: claude.subscription('max-1', { token: H.env('CLAUDE_TOKEN_1') }), share: 0.5 },
    { account: claude.subscription('max-2', { token: H.env('CLAUDE_TOKEN_2') }), share: 0.4 },
    { account: claude.subscription('max-3', { token: H.env('CLAUDE_TOKEN_3') }), share: 0.3 },
    { account: anthropic.account('api', { apiKey: H.env('ANTHROPIC_API_KEY') }), share: 1 },
  ],
  soonestExpiring
);

const supervisor = claude.supervisor({
  grants: [
    H.ops.readWork,
    H.ops.writeWork,
    H.ops.resolveHalts,
    H.ops.writeMemory,
    H.ops.readTelemetry,
    H.ops.readAccounts,
    H.ops.setShares,
    H.operation('production-health-probe', probeProduction),
  ],
});

export const harness = H.harness('coding-team')
  .ledger(sqlite.ledger('.harness/ledger.db'))
  .lanes(heartbeats, bugs, features, epics)
  .pools(claudePool)
  .triggers(heartbeatDownFilesBug)
  .scheduler(codingScheduler)
  .clients(supervisor)
  .observers(markdown.board('.harness/board.md'), markdown.telemetry('.harness/telemetry.md'));

export const running = harness.start();
