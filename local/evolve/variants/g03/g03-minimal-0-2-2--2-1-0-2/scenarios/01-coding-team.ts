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
const done = H.state('done', 'terminal', 'success');
const wontDo = H.state('wont-do', 'terminal', 'neutral');
const stuck = H.state('stuck', 'terminal', 'failure');
const planned = H.state('planned', 'pending');
const inProgress = H.state('in-progress', 'waiting');
const due = H.state('due', 'pending');
const healthy = H.state('healthy', 'terminal', 'success');
const unhealthy = H.state('unhealthy', 'terminal', 'failure');

const bug = H.kind('bug')
  .data(z.object({ title: z.string(), description: z.string() }))
  .states(todo, done, wontDo, stuck);
const feature = H.kind('feature')
  .data(z.object({ title: z.string(), description: z.string(), epic: z.string().optional() }))
  .states(todo, done, wontDo, stuck);
const epic = H.kind('epic')
  .data(z.object({ title: z.string(), description: z.string() }))
  .states(planned, inProgress, done, stuck);
const heartbeat = H.kind('service-heartbeat')
  .data(z.object({ service: z.string() }))
  .states(due, healthy, unhealthy);

const sonnet = anthropic.model('claude-sonnet-4-5');
const opus = anthropic.model('claude-opus-4-1');

const maxA = claudeCode.subscription('max-a', { token: H.env('CLAUDE_MAX_A_TOKEN'), serves: [sonnet, opus] });
const maxB = claudeCode.subscription('max-b', { token: H.env('CLAUDE_MAX_B_TOKEN'), serves: [sonnet, opus] });
const maxC = claudeCode.subscription('max-c', { token: H.env('CLAUDE_MAX_C_TOKEN'), serves: [sonnet, opus] });
const api = anthropic.account('anthropic-api', { apiKey: H.env('ANTHROPIC_API_KEY'), serves: [sonnet, opus] });

const soonestExpiringFirst = H.policy.account('soonest-expiring-first', choice => {
  const subscriptions = choice.accounts
    .filter(view => view.eligible && view.account.plan === 'subscription' && view.usedShare < view.share)
    .sort(
      (a, b) =>
        (a.windowEndsAt ? a.windowEndsAt.getTime() : Number.POSITIVE_INFINITY) -
        (b.windowEndsAt ? b.windowEndsAt.getTime() : Number.POSITIVE_INFINITY)
    );
  const soonest = subscriptions[0];
  if (soonest) return soonest.account;
  const metered = choice.accounts.find(view => view.eligible && view.account.plan === 'metered');
  return metered ? metered.account : null;
});

const claude = H.pool(
  'claude',
  [
    { account: maxA, share: 0.6 },
    { account: maxB, share: 0.6 },
    { account: maxC, share: 0.4 },
    { account: api, share: 1 },
  ],
  soonestExpiringFirst
);

const builderModel = H.policy.model('cheaper-until-below-85', [sonnet, opus], choice => {
  const cheaper = choice.metrics.successRate({ kind: choice.kind, seat: choice.seat, model: sonnet, days: 14 });
  if (cheaper.samples < 20) return sonnet;
  return (cheaper.value ?? 1) < 0.85 ? opus : sonnet;
});

const experience = H.memory('engineering-experience', 'experience');
const taste = H.memory('owner-taste', 'taste');
const experienceJournal = H.journal('coding-experience', experience, jsonl.memory('memory/experience.jsonl'));
const tasteJournal = H.journal('coding-taste', taste, jsonl.memory('memory/taste.jsonl'));

const worktrees = git.worktree('worktrees', { repo: '.', slots: 3 });
const local = shell.local('local', { slots: 4 });

const projectChecks = H.command('project-checks')
  .argv(() => ['npm', 'run', 'check'])
  .on(worktrees);

const building = H.role('builder')
  .input(
    z.object({
      title: z.string(),
      description: z.string(),
      deficits: z.array(z.string()),
      ownerAnswer: z.string().optional(),
    })
  )
  .output(z.object({ summary: z.string(), question: z.string().optional() }))
  .prompt(
    input =>
      `Implement: ${input.title}\n\n${input.description}\n\nOpen deficits:\n${input.deficits.join('\n')}\n\nOwner decision: ${input.ownerAnswer ?? 'none yet'}`
  )
  .intents(['read', 'edit', 'execute']);

const auditing = H.role('auditor')
  .input(z.object({ title: z.string(), description: z.string(), summary: z.string() }))
  .output(z.object({ deficits: z.array(z.string()) }))
  .prompt(input => `Audit the change for "${input.title}".\n\n${input.description}\n\nBuilder summary:\n${input.summary}\n\nList every deficit.`)
  .intents(['read', 'execute']);

const planning = H.role('planner')
  .input(z.object({ title: z.string(), description: z.string() }))
  .output(z.object({ features: z.array(z.object({ title: z.string(), description: z.string() })) }))
  .prompt(input => `Decompose the epic "${input.title}" into independently shippable features.\n\n${input.description}`)
  .intents(['read']);

const builder = H.seat('builder', building)
  .model(builderModel)
  .on(worktrees)
  .recalls(experienceJournal, tasteJournal)
  .guards(claudeCode.fileLeases(), claudeCode.stopCheck(projectChecks));
const auditor = H.seat('auditor', auditing)
  .model(sonnet)
  .on(worktrees)
  .recalls(experienceJournal)
  .records(experienceJournal);
const planner = H.seat('planner', planning).model(opus).recalls(tasteJournal);

const ownerDecision = H.halt('owner-decision', z.object({ answer: z.string() }));

const delivery = H.flow('build-and-audit')
  .for(bug, feature)
  .params(z.object({ rounds: z.number().int() }))
  .does(async ctx => {
    let deficits: string[] = [];
    let ownerAnswer: string | undefined;
    for (let round = 1; round <= ctx.params.rounds; round++) {
      const built = await ctx.run(builder, {
        title: ctx.unit.data.title,
        description: ctx.unit.data.description,
        deficits,
        ownerAnswer,
      });
      if (built.ok === false) return ctx.fail(built.error);
      if (built.value.question) {
        const decision = await ctx.halt(ownerDecision, built.value.question);
        ownerAnswer = decision.answer;
        continue;
      }
      const audit = await ctx.run(auditor, {
        title: ctx.unit.data.title,
        description: ctx.unit.data.description,
        summary: built.value.summary,
      });
      if (audit.ok === false) return ctx.fail(audit.error);
      deficits = audit.value.deficits;
      if (deficits.length === 0) return 'done';
    }
    return ctx.fail(`${deficits.length} deficits remain after ${ctx.params.rounds} rounds`);
  });

const serviceProbe = H.command('service-probe')
  .input(z.object({ service: z.string() }))
  .argv(input => ['curl', '-fsS', `https://${input.service}.internal/health`])
  .on(local);

const heartbeatCheck = H.flow('heartbeat-check')
  .for(heartbeat)
  .does(async ctx => {
    const probe = await ctx.run(serviceProbe, { service: ctx.unit.data.service });
    return probe.ok ? 'healthy' : 'unhealthy';
  });

const bugTracker = linear.tracker(bug, {
  apiKey: H.env('LINEAR_API_KEY'),
  team: 'PRODUCT',
  label: 'bug',
  read: issue => ({ title: issue.title, description: issue.description }),
  statuses: { todo: 'Todo', done: 'Done', 'wont-do': 'Canceled', stuck: 'Blocked' },
});
const featureTracker = linear.tracker(feature, {
  apiKey: H.env('LINEAR_API_KEY'),
  team: 'PRODUCT',
  label: 'feature',
  read: issue => ({ title: issue.title, description: issue.description, epic: issue.parentId }),
  statuses: { todo: 'Todo', done: 'Done', 'wont-do': 'Canceled', stuck: 'Blocked' },
});
const epicTracker = linear.tracker(epic, {
  apiKey: H.env('LINEAR_API_KEY'),
  team: 'PRODUCT',
  label: 'epic',
  read: issue => ({ title: issue.title, description: issue.description }),
  statuses: { planned: 'Planned', 'in-progress': 'In Progress', done: 'Done', stuck: 'Blocked' },
});
const bugInbox = folder.files(bug, {
  dir: 'inbox/bugs',
  read: file => {
    const title = file.frontmatter['title'];
    return { title: typeof title === 'string' ? title : file.path, description: file.body };
  },
});

const heartbeatSchedule = H.schedule('heartbeat-every-five-minutes', heartbeat, { every: { minutes: 5 } }, () => [
  { create: { service: 'api' } },
]);

const heartbeats = H.lane('heartbeats', heartbeat)
  .handler(heartbeatCheck)
  .retries(0, { exhausted: 'unhealthy' })
  .suppliers(heartbeatSchedule);

const retryBackoff = { first: { minutes: 5 }, factor: 2, max: { hours: 1 } };

const bugs = H.lane('bugs', bug)
  .handler(delivery, { rounds: 3 })
  .retries(2, { backoff: retryBackoff, exhausted: 'stuck' })
  .suppliers(bugTracker, bugInbox, H.operator)
  .store(bugTracker)
  .wip(2);

const features = H.lane('features', feature)
  .handler(delivery, { rounds: 5 })
  .retries(2, { backoff: retryBackoff, exhausted: 'stuck' })
  .suppliers(featureTracker, H.operator)
  .store(featureTracker);

const decompose = H.flow('decompose-epic')
  .for(epic)
  .does(async ctx => {
    const plan = await ctx.run(planner, { title: ctx.unit.data.title, description: ctx.unit.data.description });
    if (plan.ok === false) return ctx.fail(plan.error);
    const children = await ctx.spawn(
      features,
      plan.value.features.map(item => ({ title: item.title, description: item.description, epic: ctx.unit.key }))
    );
    const finished = await ctx.suspend('in-progress', { children });
    return finished.every(child => child.state === 'done') ? 'done' : 'stuck';
  });

const epics = H.lane('epics', epic)
  .handler(decompose)
  .retries(1, { backoff: retryBackoff, exhausted: 'stuck' })
  .suppliers(epicTracker)
  .store(epicTracker)
  .wip(1);

const failedHeartbeatFilesBug = H.trigger(
  'failed-heartbeat-files-bug',
  H.on.enters(heartbeat, 'unhealthy'),
  (event, act) =>
    act.create(bugs, {
      title: `${event.unit.data.service} failed its heartbeat`,
      description: `Heartbeat ${event.unit.key} ended unhealthy at ${event.at.toISOString()}.`,
    })
);

const featureStarvationMs = 2 * 60 * 60 * 1000;

const workOrder = H.policy.scheduler('heartbeats-bugs-features-epics', view => {
  const rank = (unit: PendingView): number => {
    if (unit.is(heartbeat)) return 0;
    if (unit.is(feature) && unit.waitedMs > featureStarvationMs) return 1;
    if (unit.is(bug)) return 2;
    if (unit.is(feature)) return 3;
    return 4;
  };
  return { start: [...view.pending].sort((a, b) => rank(a) - rank(b) || b.waitedMs - a.waitedMs) };
});

const productionHealthProbe = H.command('production-health-probe')
  .argv(() => ['curl', '-fsS', 'https://app.example.com/health'])
  .on(local);

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
    H.operation('production-health', productionHealthProbe),
  ],
});

export const harness = H.harness('coding-team')
  .ledger(sqlite.ledger('.harness/ledger.db'))
  .lanes(heartbeats, bugs, features, epics)
  .pools(claude)
  .triggers(failedHeartbeatFilesBug)
  .scheduler(workOrder)
  .clients(supervisor)
  .observers(markdown.board('BOARD.md'), markdown.telemetry('TELEMETRY.md'));

export const running = harness.start();
