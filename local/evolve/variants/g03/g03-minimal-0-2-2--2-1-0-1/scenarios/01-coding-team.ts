import { z } from 'zod';
import { H } from 'harness-dsl';
import type { PendingView, SupplyOf } from 'harness-dsl';
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
const decomposed = H.state('decomposed', 'waiting');
const done = H.state('done', 'terminal', 'success');
const stuck = H.state('stuck', 'terminal', 'failure');
const wontFix = H.state('wontFix', 'terminal', 'neutral');
const due = H.state('due', 'pending');
const up = H.state('up', 'terminal', 'success');
const down = H.state('down', 'terminal', 'failure');

const bugData = z.object({
  title: z.string(),
  description: z.string(),
  origin: z.enum(['tracker', 'folder', 'operator', 'heartbeat']),
});
type BugData = z.infer<typeof bugData>;

const Bug = H.kind('Bug')
  .data(bugData)
  .states(todo, done, stuck, wontFix);

const Feature = H.kind('Feature')
  .data(z.object({ title: z.string(), description: z.string(), epic: z.string().optional() }))
  .states(todo, done, stuck);

const Epic = H.kind('Epic')
  .data(z.object({ title: z.string(), description: z.string() }))
  .states(todo, decomposed, done, stuck);

const ServiceHeartbeat = H.kind('ServiceHeartbeat')
  .data(z.object({ service: z.string() }))
  .states(due, up, down);

const builderRole = H.role('builder')
  .input(z.object({
    title: z.string(),
    description: z.string(),
    feedback: z.array(z.string()),
    ownerAnswer: z.string().optional(),
  }))
  .output(z.object({ summary: z.string(), question: z.string().optional() }))
  .prompt(input => [
    `Build: ${input.title}`,
    input.description,
    input.feedback.length > 0 ? `Fix these deficits first:\n${input.feedback.join('\n')}` : '',
    input.ownerAnswer !== undefined ? `The owner answered: ${input.ownerAnswer}` : '',
    'If you need an owner decision, return it as question instead of guessing.',
  ].join('\n\n'))
  .intents(['read', 'edit', 'execute']);

const auditorRole = H.role('auditor')
  .input(z.object({ title: z.string(), description: z.string(), summary: z.string() }))
  .output(z.object({ deficits: z.array(z.string()) }))
  .prompt(input => `Audit the change for "${input.title}".\n\n${input.description}\n\nBuilder summary:\n${input.summary}\n\nList every deficit, or none.`)
  .intents(['read', 'execute']);

const plannerRole = H.role('planner')
  .input(z.object({ title: z.string(), description: z.string() }))
  .output(z.object({ features: z.array(z.object({ title: z.string(), description: z.string() })) }))
  .prompt(input => `Decompose the epic "${input.title}" into independently shippable features.\n\n${input.description}`)
  .intents(['read']);

const sonnet = anthropic.model('claude-sonnet-4-5');
const opus = anthropic.model('claude-opus-4-1');

const subscriptionA = claudeCode.subscription('claude-max-a', { token: H.env('CLAUDE_TOKEN_A') });
const subscriptionB = claudeCode.subscription('claude-max-b', { token: H.env('CLAUDE_TOKEN_B') });
const subscriptionC = claudeCode.subscription('claude-max-c', { token: H.env('CLAUDE_TOKEN_C') });
const apiAccount = anthropic.account('anthropic-api', { apiKey: H.env('ANTHROPIC_API_KEY') });

const soonestExpiring = H.policy.account('soonestExpiringFirst', choice => {
  const subscriptions = choice.accounts
    .filter(view => view.eligible && view.account.plan === 'subscription' && view.usedShare < view.share)
    .sort((a, b) => (a.windowEndsAt?.getTime() ?? Number.MAX_SAFE_INTEGER) - (b.windowEndsAt?.getTime() ?? Number.MAX_SAFE_INTEGER));
  const first = subscriptions[0];
  if (first) return first.account;
  const metered = choice.accounts.find(view => view.eligible && view.account.plan === 'metered');
  return metered ? metered.account : null;
});

const claudePool = H.pool('claude', [
  { account: subscriptionA, share: 0.5, serves: [sonnet, opus] },
  { account: subscriptionB, share: 0.3, serves: [sonnet, opus] },
  { account: subscriptionC, share: 0.2, serves: [sonnet, opus] },
  { account: apiAccount, share: 1, serves: [sonnet, opus] },
], soonestExpiring);

const builderModel = H.policy.model('cheaperUntilItSlips', [sonnet, opus], choice => {
  const cheaper = choice.metrics.successRate({ kind: choice.kind, seat: choice.seat, model: sonnet, days: 14 });
  if (cheaper.samples < 20) return sonnet;
  return cheaper.value !== null && cheaper.value < 0.85 ? opus : sonnet;
});

const experience = H.journal('experience', H.memory('experience', 'experience'), jsonl.memory('memory/experience.jsonl'));
const taste = H.journal('taste', H.memory('taste', 'taste'), jsonl.memory('memory/taste.jsonl'));

const worktrees = git.worktree('worktrees', { repo: '.', slots: 3 });
const local = shell.local('local', { slots: 4 });

const projectChecks = H.command('projectChecks')
  .argv(() => ['npm', 'run', 'check'])
  .on(worktrees)
  .recovery('rerun');

const builder = H.seat('builder', builderRole)
  .model(builderModel)
  .on(worktrees)
  .recalls(experience, taste)
  .guards(claudeCode.fileLeases(), claudeCode.stopCheck(projectChecks));

const auditor = H.seat('auditor', auditorRole)
  .model(opus)
  .on(worktrees)
  .recalls(experience)
  .records(experience);

const planner = H.seat('planner', plannerRole)
  .model(opus)
  .recalls(taste);

const ownerDecision = H.halt('ownerDecision', z.object({ answer: z.string() }));

const delivery = H.flow('delivery')
  .for(Bug, Feature)
  .params(z.object({ rounds: z.number().int().positive() }))
  .does(async ctx => {
    const { title, description } = ctx.unit.data;
    let feedback: string[] = [];
    let ownerAnswer: string | undefined;
    for (let round = 0; round < ctx.params.rounds; round += 1) {
      const built = await ctx.run(builder, { title, description, feedback, ownerAnswer });
      if (!built.ok) return ctx.fail(built.error);
      if (built.value.question !== undefined) {
        const decision = await ctx.halt(ownerDecision, built.value.question);
        ownerAnswer = decision.answer;
        continue;
      }
      const audit = await ctx.run(auditor, { title, description, summary: built.value.summary });
      if (!audit.ok) return ctx.fail(audit.error);
      if (audit.value.deficits.length === 0) return 'done';
      feedback = audit.value.deficits;
    }
    return ctx.fail('deficits remain after the last round');
  });

const healthCheck = H.command('healthCheck')
  .input(z.object({ service: z.string() }))
  .argv(input => ['curl', '-fsS', `https://${input.service}.internal/health`])
  .on(local)
  .recovery('rerun');

const heartbeat = H.flow('heartbeat')
  .for(ServiceHeartbeat)
  .does(async ctx => {
    const result = await ctx.run(healthCheck, { service: ctx.unit.data.service });
    return result.ok ? 'up' : 'down';
  });

const linearKey = H.env('LINEAR_API_KEY');

const bugTracker = linear.tracker(Bug, {
  apiKey: linearKey,
  team: 'PROD',
  label: 'bug',
  read: (issue): BugData => ({ title: issue.title, description: issue.description, origin: 'tracker' }),
  statuses: { todo: 'Todo', done: 'Done', stuck: 'Blocked', wontFix: 'Canceled' },
});

const featureTracker = linear.tracker(Feature, {
  apiKey: linearKey,
  team: 'PROD',
  label: 'feature',
  read: issue => ({ title: issue.title, description: issue.description, epic: issue.parentId }),
  statuses: { todo: 'Todo', done: 'Done', stuck: 'Blocked' },
});

const epicTracker = linear.tracker(Epic, {
  apiKey: linearKey,
  team: 'PROD',
  label: 'epic',
  read: issue => ({ title: issue.title, description: issue.description }),
  statuses: { todo: 'Todo', decomposed: 'In Progress', done: 'Done', stuck: 'Blocked' },
});

const bugFolder = folder.files(Bug, {
  dir: 'bugs',
  read: (file): BugData => ({ title: file.path, description: file.body, origin: 'folder' }),
});

const bugs = H.lane('bugs', Bug)
  .handler(delivery, { rounds: 3 })
  .attempts(2, { backoff: { first: { minutes: 10 } }, exhausted: 'stuck' })
  .suppliers(bugTracker, bugFolder, H.operator)
  .store(bugTracker)
  .wip(2);

const features = H.lane('features', Feature)
  .handler(delivery, { rounds: 5 })
  .attempts(2, { backoff: { first: { minutes: 10 } }, exhausted: 'stuck' })
  .suppliers(featureTracker, H.operator)
  .store(featureTracker);

const decomposition = H.flow('decomposition')
  .for(Epic)
  .does(async ctx => {
    const plan = await ctx.run(planner, { title: ctx.unit.data.title, description: ctx.unit.data.description });
    if (!plan.ok) return ctx.fail(plan.error);
    const children = await ctx.spawn(features, plan.value.features.map(feature => ({
      title: feature.title,
      description: feature.description,
      epic: ctx.unit.key,
    })));
    const finished = await ctx.suspend('decomposed', { children });
    return finished.every(child => child.state === 'done') ? 'done' : ctx.fail('a feature of the epic did not complete');
  });

const epics = H.lane('epics', Epic)
  .handler(decomposition)
  .attempts(1, { exhausted: 'stuck' })
  .suppliers(epicTracker)
  .store(epicTracker)
  .wip(1);

const services = ['api', 'web', 'payments'];

const heartbeats = H.lane('heartbeats', ServiceHeartbeat)
  .handler(heartbeat)
  .attempts(1, { exhausted: 'down' })
  .suppliers(H.schedule('heartbeatEveryFiveMinutes', ServiceHeartbeat, { every: { minutes: 5 } }, () =>
    services.map((service): SupplyOf<typeof ServiceHeartbeat> => ({ create: { service } }))));

const heartbeatFailureFilesBug = H.trigger(
  'heartbeatFailureFilesBug',
  H.on.enters(ServiceHeartbeat, 'down'),
  (event, act) => act.create(bugs, {
    title: `Heartbeat failed for ${event.unit.data.service}`,
    description: `The ${event.unit.data.service} health check failed at ${event.at.toISOString()}.`,
    origin: 'heartbeat',
  }),
);

const sixHoursMs = 6 * 60 * 60 * 1000;

const teamOrder = H.policy.scheduler('heartbeatsBugsFeaturesEpics', view => {
  const rank = (unit: PendingView): number => {
    if (unit.is(ServiceHeartbeat)) return 0;
    if (unit.is(Feature) && unit.waitedMs > sixHoursMs) return 0.5;
    if (unit.is(Bug)) return 1;
    if (unit.is(Feature)) return 2;
    return 3;
  };
  return { start: view.pending.slice().sort((a, b) => rank(a) - rank(b) || b.waitedMs - a.waitedMs) };
});

const productionProbe = H.command('productionProbe')
  .argv(() => ['curl', '-fsS', 'https://app.example.com/health'])
  .on(local)
  .recovery('rerun');

const supervisor = claudeCode.supervisor({
  grants: [
    H.ops.readWork,
    H.ops.writeWork,
    H.ops.resolveHalts,
    H.ops.writeMemory,
    H.ops.readTelemetry,
    H.ops.readAccounts,
    H.ops.setShares,
    H.operation('probeProduction', productionProbe),
  ],
});

export const codingTeam = H.harness('coding-team')
  .ledger(sqlite.ledger('.harness/ledger.sqlite'))
  .lanes(heartbeats, bugs, features, epics)
  .pools(claudePool)
  .triggers(heartbeatFailureFilesBug)
  .scheduler(teamOrder)
  .clients(supervisor)
  .observers(markdown.board('BOARD.md'), markdown.telemetry('TELEMETRY.md'));
