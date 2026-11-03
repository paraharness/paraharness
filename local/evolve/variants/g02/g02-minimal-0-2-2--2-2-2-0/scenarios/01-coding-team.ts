import { z } from 'zod';
import { H, type PendingView } from 'harness-dsl';
import * as claudeCode from 'harness-dsl/claude-code';
import * as anthropic from 'harness-dsl/anthropic';
import * as linear from 'harness-dsl/linear';
import * as folder from 'harness-dsl/folder';
import * as sqlite from 'harness-dsl/sqlite';
import * as jsonl from 'harness-dsl/jsonl';
import * as git from 'harness-dsl/git';
import * as shell from 'harness-dsl/shell';
import * as markdown from 'harness-dsl/markdown';

const todo = H.state('todo', 'pending');
const open = H.state('open', 'pending');
const building = H.state('building', 'waiting');
const done = H.state('done', 'terminal', 'success');
const wontfix = H.state('wontfix', 'terminal', 'neutral');
const stuck = H.state('stuck', 'terminal', 'failure');
const due = H.state('due', 'pending');
const healthy = H.state('healthy', 'terminal', 'success');
const unhealthy = H.state('unhealthy', 'terminal', 'failure');

const workItem = z.object({ title: z.string(), body: z.string() });
const bug = H.kind('bug').data(workItem).states(todo, done, wontfix, stuck);
const feature = H.kind('feature').data(workItem).states(todo, done, wontfix, stuck);
const epic = H.kind('epic').data(workItem).states(open, building, done, stuck);
const heartbeat = H.kind('service-heartbeat')
  .data(z.object({ service: z.string(), url: z.string() }))
  .states(due, healthy, unhealthy);

const builderRole = H.role('builder')
  .input(z.object({ title: z.string(), body: z.string(), notes: z.array(z.string()) }))
  .output(z.object({ summary: z.string(), ownerQuestion: z.string().optional() }))
  .prompt(i => `Implement: ${i.title}\n\n${i.body}\n\nAddress:\n${i.notes.join('\n')}`)
  .intents(['read', 'edit', 'execute']);

const auditorRole = H.role('auditor')
  .input(z.object({ title: z.string(), body: z.string(), summary: z.string() }))
  .output(z.object({ deficits: z.array(z.string()) }))
  .prompt(i => `Audit the change for "${i.title}". Builder says: ${i.summary}. List every deficit against: ${i.body}`)
  .intents(['read', 'execute']);

const plannerRole = H.role('planner')
  .input(z.object({ title: z.string(), body: z.string() }))
  .output(z.object({ features: z.array(z.object({ title: z.string(), body: z.string() })) }))
  .prompt(i => `Decompose the epic "${i.title}" into features.\n\n${i.body}`)
  .intents(['read']);

const experience = H.journal('team-experience', H.memory('experience', 'experience'), jsonl.memory('memory/experience.jsonl'));
const taste = H.journal('owner-taste', H.memory('taste', 'taste'), jsonl.memory('memory/taste.jsonl'));

const quota = sqlite.quota('quota.db');
const claudeA = claudeCode.subscription('claude-a', { token: H.env('CLAUDE_TOKEN_A'), quota });
const claudeB = claudeCode.subscription('claude-b', { token: H.env('CLAUDE_TOKEN_B'), quota });
const claudeC = claudeCode.subscription('claude-c', { token: H.env('CLAUDE_TOKEN_C'), quota });
const apiAccount = anthropic.account('anthropic-api', { apiKey: H.env('ANTHROPIC_API_KEY'), quota });

const drainSoonestExpiring = H.policy.account('soonest-expiring-first', ({ accounts }) => {
  const subscriptions = accounts
    .filter(a => a.eligible && a.account.plan === 'subscription' && a.usedShare < a.share)
    .sort((a, b) => (a.windowEndsAt ? a.windowEndsAt.getTime() : Infinity) - (b.windowEndsAt ? b.windowEndsAt.getTime() : Infinity));
  const soonest = subscriptions[0];
  if (soonest) return soonest.account;
  const metered = accounts.find(a => a.eligible && a.account.plan === 'metered');
  return metered ? metered.account : null;
});

const claudePool = H.pool(
  'claude',
  [
    { account: claudeA, share: 0.5 },
    { account: claudeB, share: 0.3 },
    { account: claudeC, share: 0.2 },
    { account: apiAccount, share: 1 },
  ],
  drainSoonestExpiring
);

const sonnet = claudeCode.model('claude-sonnet-4-5');
const opus = claudeCode.model('claude-opus-4-1');

const cheaperUntilItSlips = H.policy.model('cheaper-until-it-slips', choice => {
  const cheap = choice.metrics.successRate({ kind: choice.kind, model: sonnet, days: 14 });
  if (cheap.samples < 20) return sonnet;
  return cheap.value !== null && cheap.value < 0.85 ? opus : sonnet;
});

const worktrees = git.worktree('worktrees', { repo: '.', slots: 3 });
const local = shell.local('local', { slots: 4 });

const projectChecks = H.command('project-checks').argv(() => ['npm', 'run', 'check']).on(worktrees).recovery('rerun');

const builder = H.seat('builder', builderRole)
  .model(cheaperUntilItSlips)
  .on(worktrees)
  .recalls(experience, taste)
  .guards(claudeCode.fileLeases(), claudeCode.stopCheck(projectChecks));

const auditor = H.seat('auditor', auditorRole).model(opus).on(worktrees).recalls(experience).records(experience);

const planner = H.seat('planner', plannerRole).model(opus).recalls(taste);

const ownerDecision = H.halt('owner-decision', z.object({ proceed: z.boolean(), guidance: z.string() }));

const deliver = H.flow('build-and-audit')
  .for(bug, feature)
  .params(z.object({ rounds: z.number().int() }))
  .does(async ctx => {
    const work = ctx.unit.data;
    let notes: string[] = [];
    for (let round = 1; round <= ctx.params.rounds; round++) {
      const built = await ctx.run(builder, { title: work.title, body: work.body, notes });
      if (!built.ok) return ctx.fail(built.error);
      if (built.value.ownerQuestion) {
        const decision = await ctx.halt(ownerDecision, built.value.ownerQuestion);
        if (!decision.proceed) return 'wontfix';
        notes = [decision.guidance];
        continue;
      }
      const audit = await ctx.run(auditor, { title: work.title, body: work.body, summary: built.value.summary });
      if (!audit.ok) return ctx.fail(audit.error);
      if (audit.value.deficits.length === 0) return 'done';
      notes = audit.value.deficits;
    }
    return ctx.fail('build-and-audit rounds ran out with deficits remaining');
  });

const serviceProbe = H.command('service-probe')
  .input(z.object({ url: z.string() }))
  .argv(i => ['curl', '-fsS', '--max-time', '10', i.url])
  .on(local)
  .recovery('rerun');

const checkService = H.flow('check-service')
  .for(heartbeat)
  .does(async ctx => {
    const probed = await ctx.run(serviceProbe, { url: ctx.unit.data.url });
    return probed.ok ? 'healthy' : 'unhealthy';
  });

const bugTracker = linear.tracker(bug, {
  apiKey: H.env('LINEAR_API_KEY'),
  team: 'product',
  label: 'bug',
  read: issue => ({ title: issue.title, body: issue.description }),
  statuses: { todo: 'Todo', done: 'Done', wontfix: 'Canceled', stuck: 'Blocked' },
});
const featureTracker = linear.tracker(feature, {
  apiKey: H.env('LINEAR_API_KEY'),
  team: 'product',
  label: 'feature',
  read: issue => ({ title: issue.title, body: issue.description }),
  statuses: { todo: 'Todo', done: 'Done', wontfix: 'Canceled', stuck: 'Blocked' },
});
const epicTracker = linear.tracker(epic, {
  apiKey: H.env('LINEAR_API_KEY'),
  team: 'product',
  label: 'epic',
  read: issue => ({ title: issue.title, body: issue.description }),
  statuses: { open: 'Todo', building: 'In Progress', done: 'Done', stuck: 'Blocked' },
});
const bugFolder = folder.files(bug, {
  dir: 'inbox/bugs',
  read: file => {
    const title = file.frontmatter['title'];
    return { title: typeof title === 'string' ? title : file.path, body: file.body };
  },
});

const codeRetry = H.policy.retry('code-retry', { retries: 2, firstDelayMs: 600000, factor: 2 });
const bugAllowance = H.allowance('bug-allowance', bug).retry(codeRetry, 'stuck');
const featureAllowance = H.allowance('feature-allowance', feature).retry(codeRetry, 'stuck');

const bugs = H.lane('bugs', bug)
  .handler(deliver, { rounds: 3 })
  .suppliers(bugTracker, bugFolder, H.operator)
  .store(bugTracker)
  .wip(2)
  .allowance(bugAllowance);

const features = H.lane('features', feature)
  .handler(deliver, { rounds: 5 })
  .suppliers(featureTracker, H.operator)
  .store(featureTracker)
  .allowance(featureAllowance);

const decompose = H.flow('decompose-epic')
  .for(epic)
  .does(async ctx => {
    const plan = await ctx.run(planner, { title: ctx.unit.data.title, body: ctx.unit.data.body });
    if (!plan.ok) return ctx.fail(plan.error);
    const children = await ctx.spawn(features, plan.value.features);
    const finished = await ctx.wait('building', { children });
    return finished.every(f => f.state === 'done') ? 'done' : 'stuck';
  });

const epics = H.lane('epics', epic).handler(decompose).suppliers(epicTracker).store(epicTracker).wip(1);

const services = [
  { service: 'api', url: 'https://api.internal/health' },
  { service: 'web', url: 'https://web.internal/health' },
];
const heartbeats = H.lane('heartbeats', heartbeat)
  .handler(checkService)
  .suppliers(
    H.clock('every-five-minutes', heartbeat, { every: { minutes: 5 } }, tick =>
      services.map(s => ({ create: s, key: `${s.service}-${tick.now.toISOString()}` }))
    )
  );

const heartbeatFailureFilesBug = H.trigger('heartbeat-failure-files-bug', H.on.enters(heartbeat, 'unhealthy'), (event, act) =>
  act.create(bugs, {
    title: `Heartbeat failing: ${event.unit.data.service}`,
    body: `The health probe of ${event.unit.data.url} failed at ${event.at.toISOString()}.`,
  })
);

const starvationMs = 6 * 60 * 60 * 1000;
const rank = (unit: PendingView): number => {
  if (unit.is(heartbeat)) return 0;
  if (unit.is(bug)) return 1;
  if (unit.is(feature)) return unit.waitedMs > starvationMs ? 1 : 2;
  return 3;
};
const teamPriority = H.policy.scheduler('heartbeats-bugs-features-epics', view => ({
  start: [...view.pending].sort((a, b) => rank(a) - rank(b) || b.waitedMs - a.waitedMs),
}));

const productionHealth = H.command('production-health')
  .argv(() => ['curl', '-fsS', 'https://app.example.com/health'])
  .on(local)
  .recovery('rerun');

const supervisor = claudeCode.supervisor({
  grants: [
    H.ops.readWork,
    H.ops.writeWork,
    H.ops.resolve(ownerDecision, H.halts.changed, H.halts.interrupted),
    H.ops.readMemory,
    H.ops.writeMemory,
    H.ops.readTelemetry,
    H.ops.readAccounts,
    H.ops.setShares,
    H.operation('production-health-probe', productionHealth),
  ],
});

const builderTrack = H.report('builder-track-record', metrics => ({
  'bug success on cheaper model, 14d': metrics.successRate({ kind: bug, model: sonnet, days: 14 }),
  'feature success on cheaper model, 14d': metrics.successRate({ kind: feature, model: sonnet, days: 14 }),
}));
const heartbeatHealth = H.report('heartbeat-health', metrics => ({
  'healthy heartbeats, 1d': metrics.rate({
    among: { entry: 'transition', kind: heartbeat, position: 'terminal' },
    count: { entry: 'transition', kind: heartbeat, verdict: 'success' },
    days: 1,
  }),
  'heartbeat probe duration, 1d': metrics.median({ of: 'durationMs', among: { entry: 'attempt', kind: heartbeat }, days: 1 }),
}));

export const harness = H.harness('coding-team')
  .ledger(sqlite.ledger('ledger.db'))
  .lanes(heartbeats, bugs, features, epics)
  .pools(claudePool)
  .triggers(heartbeatFailureFilesBug)
  .scheduler(teamPriority)
  .reports(builderTrack, heartbeatHealth)
  .clients(supervisor)
  .observers(markdown.board('BOARD.md'), markdown.telemetry('TELEMETRY.md'));

export const running = harness.start();
