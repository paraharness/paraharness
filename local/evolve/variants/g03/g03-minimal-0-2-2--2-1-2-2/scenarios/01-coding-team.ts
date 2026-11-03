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

const todo = H.state('todo', 'pending');
const awaitingFeatures = H.state('awaiting-features', 'waiting');
const done = H.state('done', 'terminal', 'success');
const failed = H.state('failed', 'terminal', 'failure');
const dropped = H.state('dropped', 'terminal', 'neutral');
const due = H.state('due', 'pending');
const healthy = H.state('healthy', 'terminal', 'success');
const unhealthy = H.state('unhealthy', 'terminal', 'failure');

const ticket = z.object({ title: z.string(), description: z.string() });

const epic = H.kind('Epic').data(ticket).states(todo, awaitingFeatures, done, failed);
const feature = H.kind('Feature').data(ticket).states(todo, done, failed, dropped);
const bug = H.kind('Bug').data(ticket).states(todo, done, failed, dropped);
const heartbeat = H.kind('ServiceHeartbeat').data(z.object({ service: z.string() })).states(due, healthy, unhealthy);

const builderRole = H.role('builder')
  .input(z.object({
    title: z.string(),
    description: z.string(),
    deficits: z.array(z.string()),
    ownerAnswer: z.string(),
  }))
  .output(z.object({ summary: z.string(), question: z.string().nullable() }))
  .prompt(input => [
    `Implement: ${input.title}`,
    input.description,
    input.deficits.length > 0 ? `Fix these deficits first:\n${input.deficits.join('\n')}` : '',
    input.ownerAnswer !== '' ? `The owner answered: ${input.ownerAnswer}` : '',
  ].join('\n\n'))
  .intents(['read', 'edit', 'execute']);

const auditorRole = H.role('auditor')
  .input(z.object({ title: z.string(), description: z.string(), summary: z.string() }))
  .output(z.object({ deficits: z.array(z.string()) }))
  .prompt(input => `Audit the change for "${input.title}" against:\n${input.description}\n\nBuilder summary:\n${input.summary}\n\nList every deficit.`)
  .intents(['read', 'execute']);

const plannerRole = H.role('planner')
  .input(ticket)
  .output(z.object({ features: z.array(ticket) }))
  .prompt(input => `Decompose the epic "${input.title}" into independently shippable features.\n\n${input.description}`)
  .intents(['read']);

const experience = H.memory('engineering-experience', 'experience');
const taste = H.memory('owner-taste', 'taste');
const experienceJournal = H.journal('engineering-experience', experience, jsonl.memory('./memory/experience.jsonl'));
const tasteJournal = H.journal('owner-taste', taste, jsonl.memory('./memory/taste.jsonl'));

const subscriptionA = claudeCode.subscription('claude-max-a', { token: H.env('CLAUDE_TOKEN_A') });
const subscriptionB = claudeCode.subscription('claude-max-b', { token: H.env('CLAUDE_TOKEN_B') });
const subscriptionC = claudeCode.subscription('claude-max-c', { token: H.env('CLAUDE_TOKEN_C') });
const apiAccount = anthropic.account('anthropic-api', { apiKey: H.env('ANTHROPIC_API_KEY') });

const drainSoonestExpiring = H.policy.account('drain-soonest-expiring', choice => {
  const open = choice.accounts.filter(view =>
    view.eligible && view.account.plan === 'subscription' && view.usedShare < view.share);
  const sorted = [...open].sort((a, b) =>
    (a.windowEndsAt?.getTime() ?? Number.POSITIVE_INFINITY) - (b.windowEndsAt?.getTime() ?? Number.POSITIVE_INFINITY));
  const first = sorted[0];
  if (first !== undefined) return first.account;
  const metered = choice.accounts.find(view => view.eligible && view.account.plan === 'metered');
  return metered === undefined ? null : metered.account;
});

const claudePool = H.pool('claude', [
  { account: subscriptionA, share: 0.5 },
  { account: subscriptionB, share: 0.3 },
  { account: subscriptionC, share: 0.2 },
  { account: apiAccount, share: 1 },
], drainSoonestExpiring);

const cheapModel = claudeCode.model('claude-sonnet-4-5');
const strongModel = claudeCode.model('claude-opus-4-1');

const builderModel = H.policy.model('cheap-until-it-slips', [cheapModel, strongModel], choice => {
  const cheapRate = choice.metrics.successRate({ kind: choice.kind, seat: choice.seat, model: cheapModel, days: 14 });
  if (cheapRate.samples < 20 || cheapRate.value === null) return cheapModel;
  return cheapRate.value < 0.85 ? strongModel : cheapModel;
});

const worktree = git.worktree('builder-worktree', { repo: '.', slots: 3 });
const local = shell.local('local', { slots: 4 });

const projectChecks = H.command('project-checks')
  .argv(() => ['npm', 'run', 'check'])
  .on(worktree)
  .recovery('rerun');

const serviceHealth = H.command('service-health')
  .input(z.object({ service: z.string() }))
  .argv(input => ['curl', '-fsS', `https://${input.service}.internal/healthz`])
  .on(local)
  .recovery('rerun');

const productionProbe = H.command('production-health-probe')
  .argv(() => ['curl', '-fsS', 'https://app.example.com/healthz'])
  .on(local)
  .recovery('rerun');

const builder = H.seat('builder', builderRole)
  .model(builderModel)
  .on(worktree)
  .recalls(experienceJournal, tasteJournal)
  .guards(claudeCode.fileLeases(), claudeCode.stopCheck(projectChecks));

const auditor = H.seat('auditor', auditorRole)
  .model(strongModel)
  .on(worktree)
  .recalls(experienceJournal)
  .records(experienceJournal);

const planner = H.seat('planner', plannerRole)
  .model(strongModel)
  .recalls(tasteJournal);

const ownerDecision = H.halt('owner-decision', z.object({ proceed: z.boolean(), answer: z.string() }));

const buildAndAudit = H.flow('build-and-audit')
  .for(bug, feature)
  .params(z.object({ rounds: z.number().int() }))
  .does(async ctx => {
    const { title, description } = ctx.unit.data;
    let deficits: string[] = [];
    let ownerAnswer = '';
    for (let round = 0; round < ctx.params.rounds; round += 1) {
      const built = await ctx.run(builder, { title, description, deficits, ownerAnswer });
      if (!built.ok) return ctx.fail(built.error);
      if (built.value.question !== null) {
        const decision = await ctx.halt(ownerDecision, built.value.question);
        if (!decision.proceed) return 'dropped';
        ownerAnswer = decision.answer;
      }
      const audit = await ctx.run(auditor, { title, description, summary: built.value.summary });
      if (!audit.ok) return ctx.fail(audit.error);
      if (audit.value.deficits.length === 0) return 'done';
      deficits = audit.value.deficits;
    }
    return 'failed';
  });

const checkService = H.flow('check-service')
  .for(heartbeat)
  .does(async ctx => {
    const result = await ctx.run(serviceHealth, { service: ctx.unit.data.service });
    return result.ok ? 'healthy' : ctx.fail(result.error);
  });

const bugTracker = linear.tracker(bug, {
  apiKey: H.env('LINEAR_API_KEY'),
  team: 'ENG',
  label: 'bug',
  read: issue => ({ title: issue.title, description: issue.description }),
  statuses: { todo: 'Todo', done: 'Done', failed: 'Blocked', dropped: 'Canceled' },
});
const featureTracker = linear.tracker(feature, {
  apiKey: H.env('LINEAR_API_KEY'),
  team: 'ENG',
  label: 'feature',
  read: issue => ({ title: issue.title, description: issue.description }),
  statuses: { todo: 'Todo', done: 'Done', failed: 'Blocked', dropped: 'Canceled' },
});
const epicTracker = linear.tracker(epic, {
  apiKey: H.env('LINEAR_API_KEY'),
  team: 'ENG',
  label: 'epic',
  read: issue => ({ title: issue.title, description: issue.description }),
  statuses: { todo: 'Todo', 'awaiting-features': 'In Progress', done: 'Done', failed: 'Blocked' },
});
const bugFolder = folder.files(bug, {
  dir: './bugs',
  read: file => {
    const title = file.frontmatter['title'];
    return { title: typeof title === 'string' ? title : file.path, description: file.body };
  },
});

const heartbeatSchedule = H.clock('every-five-minutes', heartbeat, { every: { minutes: 5 } }, () =>
  ['api', 'billing', 'web'].map(service => ({ create: { service }, key: service })));

const heartbeats = H.lane('heartbeats', heartbeat)
  .handler(checkService)
  .retry({ times: 0, exhausted: 'unhealthy' })
  .suppliers(heartbeatSchedule);

const bugs = H.lane('bugs', bug)
  .handler(buildAndAudit, { rounds: 3 })
  .retry({ times: 2, backoff: { first: { minutes: 10 }, factor: 2 }, exhausted: 'failed' })
  .suppliers(bugTracker, bugFolder, H.operator)
  .store(bugTracker)
  .wip(2);

const features = H.lane('features', feature)
  .handler(buildAndAudit, { rounds: 5 })
  .retry({ times: 2, backoff: { first: { minutes: 10 }, factor: 2 }, exhausted: 'failed' })
  .suppliers(featureTracker, H.operator)
  .store(featureTracker);

const decomposeEpic = H.flow('decompose-epic')
  .for(epic)
  .does(async ctx => {
    const plan = await ctx.run(planner, ctx.unit.data);
    if (!plan.ok) return ctx.fail(plan.error);
    const children = await ctx.spawn(features, plan.value.features);
    const finished = await ctx.suspend('awaiting-features', { children });
    return finished.every(child => child.state === 'done') ? 'done' : 'failed';
  });

const epics = H.lane('epics', epic)
  .handler(decomposeEpic)
  .retry({ times: 1, exhausted: 'failed' })
  .suppliers(epicTracker)
  .store(epicTracker)
  .wip(1);

const heartbeatFailureFilesBug = H.trigger(
  'heartbeat-failure-files-bug',
  H.on.enters(heartbeat, 'unhealthy'),
  (event, act) => act.create(bugs, {
    title: `Service ${event.unit.data.service} failed its heartbeat`,
    description: `The heartbeat at ${event.at.toISOString()} failed. Find and fix the cause.`,
  }, `heartbeat-${event.unit.data.service}`),
);

const featureStarvationMs = 4 * 60 * 60 * 1000;

const rank = (unit: PendingView): number => {
  if (unit.is(heartbeat)) return 0;
  if (unit.is(feature) && unit.waitedMs > featureStarvationMs) return 1;
  if (unit.is(bug)) return 2;
  if (unit.is(feature)) return 3;
  return 4;
};

const priority = H.policy.scheduler('heartbeats-bugs-features-epics', view => ({
  start: [...view.pending].sort((a, b) => rank(a) - rank(b) || b.waitedMs - a.waitedMs),
}));

const supervisor = claudeCode.supervisor({
  grants: [
    H.ops.readWork,
    H.ops.writeWork,
    H.ops.resolve(ownerDecision, H.halts.interrupted, H.halts.definitionChanged, H.halts.costCeiling),
    H.ops.readMemory,
    H.ops.writeMemory,
    H.ops.readTelemetry,
    H.ops.readAccounts,
    H.ops.setShares,
    H.operation('production-health-probe', productionProbe),
  ],
});

const harness = H.harness('coding-team')
  .ledger(sqlite.ledger('./.harness/coding-team.sqlite'))
  .lanes(heartbeats, bugs, features, epics)
  .pools(claudePool)
  .triggers(heartbeatFailureFilesBug)
  .scheduler(priority)
  .clients(supervisor)
  .observers(markdown.board('./BOARD.md'), markdown.telemetry('./TELEMETRY.md'));

export const running = harness.start();
