import { z } from 'zod';
import { H } from 'harness-dsl';
import type { PendingView } from 'harness-dsl';
import * as cc from 'harness-dsl/claude-code';
import * as anthropic from 'harness-dsl/anthropic';
import * as linear from 'harness-dsl/linear';
import * as folder from 'harness-dsl/folder';
import * as sqlite from 'harness-dsl/sqlite';
import * as jsonl from 'harness-dsl/jsonl';
import * as git from 'harness-dsl/git';
import * as shell from 'harness-dsl/shell';
import * as markdown from 'harness-dsl/markdown';

const hour = 60 * 60 * 1000;

const todo = H.state('todo', 'pending');
const decomposed = H.state('decomposed', 'waiting');
const done = H.state('done', 'terminal', 'success');
const abandoned = H.state('abandoned', 'terminal', 'failure');
const cancelled = H.state('cancelled', 'terminal', 'neutral');
const due = H.state('due', 'pending');
const healthy = H.state('healthy', 'terminal', 'success');
const unhealthy = H.state('unhealthy', 'terminal', 'failure');

const ticket = z.object({ title: z.string(), description: z.string() });

const bug = H.kind('Bug').data(ticket).states(todo, done, abandoned, cancelled);
const feature = H.kind('Feature').data(ticket).states(todo, done, abandoned, cancelled);
const epic = H.kind('Epic').data(ticket).states(todo, decomposed, done, abandoned, cancelled);
const heartbeat = H.kind('ServiceHeartbeat').data(z.object({ service: z.string() })).states(due, healthy, unhealthy);

const experience = H.memory('coding-experience', 'experience');
const taste = H.memory('owner-taste', 'taste');
const experienceJournal = H.library('coding-experience-journal', experience, jsonl.memory('memory/experience.jsonl'));
const tasteJournal = H.library('owner-taste-journal', taste, jsonl.memory('memory/taste.jsonl'));

const subscriptionOne = cc.subscription('claude-max-1', { token: H.env('CLAUDE_TOKEN_1') });
const subscriptionTwo = cc.subscription('claude-max-2', { token: H.env('CLAUDE_TOKEN_2') });
const subscriptionThree = cc.subscription('claude-max-3', { token: H.env('CLAUDE_TOKEN_3') });
const apiAccount = anthropic.account('anthropic-api', { apiKey: H.env('ANTHROPIC_API_KEY') });

const soonestExpiringFirst = H.policy.account('soonest-expiring-first', choice => {
  const subscriptions = choice.accounts
    .filter(view => view.eligible && view.account.plan === 'subscription' && view.usedShare < view.share)
    .sort((a, b) => (a.windowEndsAt?.getTime() ?? Number.MAX_SAFE_INTEGER) - (b.windowEndsAt?.getTime() ?? Number.MAX_SAFE_INTEGER));
  const first = subscriptions[0];
  if (first !== undefined) return first.account;
  const metered = choice.accounts.find(view => view.eligible && view.account.plan === 'metered');
  return metered === undefined ? null : metered.account;
});

const claudePool = H.pool(
  'claude',
  [
    { account: subscriptionOne, share: 0.5 },
    { account: subscriptionTwo, share: 0.3 },
    { account: subscriptionThree, share: 0.2 },
    { account: apiAccount, share: 1 },
  ],
  soonestExpiringFirst
);

const sonnet = cc.model('claude-sonnet-4-5');
const opus = cc.model('claude-opus-4-1');

const builderModel = H.policy.model('builder-cheaper-until-it-slips', [sonnet, opus], choice => {
  const cheaper = choice.metrics.successRate({ kind: choice.kind, model: sonnet, days: 14 });
  const slipping = cheaper.samples >= 20 && cheaper.value !== null && cheaper.value < 0.85;
  return slipping ? opus : sonnet;
});

const worktree = git.worktree('worktree', { repo: '.', slots: 3 });
const local = shell.local('local', { slots: 4 });

const projectChecks = H.command('project-checks')
  .argv(() => ['npm', 'run', 'check'])
  .on(worktree)
  .recovery('rerun');

const builderRole = H.role('builder')
  .input(z.object({ title: z.string(), description: z.string(), feedback: z.string() }))
  .output(z.object({ summary: z.string(), question: z.string().optional() }))
  .prompt(input => `Build: ${input.title}\n\n${input.description}\n\nOpen deficits:\n${input.feedback}`)
  .intents(['read', 'edit', 'execute']);

const auditorRole = H.role('auditor')
  .input(z.object({ title: z.string(), description: z.string(), summary: z.string() }))
  .output(z.object({ deficits: z.array(z.string()) }))
  .prompt(input => `Audit the change for "${input.title}".\n\n${input.description}\n\nBuilder says: ${input.summary}`)
  .intents(['read', 'execute']);

const plannerRole = H.role('planner')
  .input(ticket)
  .output(z.object({ features: z.array(ticket) }))
  .prompt(input => `Decompose the epic "${input.title}" into features.\n\n${input.description}`)
  .intents(['read']);

const builder = H.seat('builder', builderRole)
  .model(builderModel)
  .on(worktree)
  .recalls(experienceJournal, tasteJournal)
  .guards(cc.fileLeases(), cc.stopCheck(projectChecks));

const auditor = H.seat('auditor', auditorRole)
  .model(sonnet)
  .on(worktree)
  .recalls(experienceJournal)
  .records(experienceJournal);

const planner = H.seat('planner', plannerRole)
  .model(opus)
  .recalls(tasteJournal);

const ownerDecision = H.halt('owner-decision', z.object({ answer: z.string() }));

const buildAndAudit = H.flow('build-and-audit')
  .for(bug, feature)
  .params(z.object({ rounds: z.number() }))
  .does(async ctx => {
    const { title, description } = ctx.unit.data;
    let feedback = '';
    for (let round = 1; round <= ctx.params.rounds; round++) {
      const built = await ctx.run(builder, { title, description, feedback });
      if (!built.ok) return ctx.fail(built.error);
      if (built.value.question !== undefined) {
        const decision = await ctx.halt(ownerDecision, built.value.question);
        feedback = decision.answer;
        continue;
      }
      const audit = await ctx.run(auditor, { title, description, summary: built.value.summary });
      if (!audit.ok) return ctx.fail(audit.error);
      if (audit.value.deficits.length === 0) return 'done';
      feedback = audit.value.deficits.join('\n');
    }
    return ctx.fail('rounds ran out with deficits remaining');
  });

const probeService = H.command('probe-service')
  .input(z.object({ service: z.string() }))
  .argv(input => ['curl', '-fsS', `https://${input.service}.internal/health`])
  .on(local)
  .recovery('rerun');

const productionProbe = H.command('production-health-probe')
  .argv(() => ['curl', '-fsS', 'https://app.example.com/health'])
  .on(local)
  .recovery('rerun');

const heartbeatFlow = H.flow('heartbeat')
  .for(heartbeat)
  .does(async ctx => {
    const probe = await ctx.run(probeService, { service: ctx.unit.data.service });
    return probe.ok ? 'healthy' : 'unhealthy';
  });

const twoAttempts = H.policy.attemptRetry('two-attempts', view =>
  view.failedAttempts >= 2 ? 'stop' : { retryInMs: 5 * 60 * 1000 }
);

const linearKey = H.env('LINEAR_API_KEY');
const readIssue = (issue: linear.Issue) => ({ title: issue.title, description: issue.description });
const ticketStatuses = { todo: 'Todo', done: 'Done', abandoned: 'Abandoned', cancelled: 'Canceled' };

const bugTracker = linear.tracker(bug, { apiKey: linearKey, team: 'ENG', label: 'bug', read: readIssue, statuses: ticketStatuses });
const featureTracker = linear.tracker(feature, { apiKey: linearKey, team: 'ENG', label: 'feature', read: readIssue, statuses: ticketStatuses });
const epicTracker = linear.tracker(epic, {
  apiKey: linearKey,
  team: 'ENG',
  label: 'epic',
  read: readIssue,
  statuses: { ...ticketStatuses, decomposed: 'In Progress' },
});

const bugFolder = folder.files(bug, {
  dir: 'bugs',
  read: file => {
    const title = file.frontmatter['title'];
    return { title: typeof title === 'string' ? title : file.path, description: file.body };
  },
});

const heartbeatClock = H.clock('heartbeat-every-five-minutes', heartbeat, { every: { minutes: 5 } }, tick =>
  ['api', 'web', 'payments'].map(service => ({ create: { service }, key: `${service}-${tick.now.toISOString()}` }))
);

const heartbeats = H.lane('heartbeats', heartbeat)
  .handler(heartbeatFlow)
  .suppliers(heartbeatClock)
  .retry('never', 'unhealthy');

const bugs = H.lane('bugs', bug)
  .handler(buildAndAudit, { rounds: 3 })
  .suppliers(bugTracker, bugFolder, H.operator)
  .store(bugTracker)
  .wip(2)
  .retry(twoAttempts, 'abandoned');

const features = H.lane('features', feature)
  .handler(buildAndAudit, { rounds: 5 })
  .suppliers(featureTracker, H.operator)
  .store(featureTracker)
  .retry(twoAttempts, 'abandoned');

const decomposeEpic = H.flow('decompose-epic')
  .for(epic)
  .does(async ctx => {
    const plan = await ctx.run(planner, ctx.unit.data);
    if (!plan.ok) return ctx.fail(plan.error);
    const children = await ctx.spawn(features, plan.value.features);
    const finished = await ctx.wait('decomposed', { children });
    return finished.every(child => child.state === 'done') ? 'done' : 'abandoned';
  });

const epics = H.lane('epics', epic)
  .handler(decomposeEpic)
  .suppliers(epicTracker)
  .store(epicTracker)
  .wip(1)
  .retry(twoAttempts, 'abandoned');

const failedHeartbeatFilesBug = H.trigger(
  'failed-heartbeat-files-bug',
  H.on.enters(heartbeat, 'unhealthy'),
  (event, act) =>
    act.create(
      bugs,
      {
        title: `Service ${event.unit.data.service} failed its heartbeat`,
        description: `The heartbeat at ${event.at.toISOString()} could not reach ${event.unit.data.service}.`,
      },
      `heartbeat-${event.unit.data.service}`
    )
);

const starvationMs = 4 * hour;
const rank = (unit: PendingView): number => {
  if (unit.is(heartbeat)) return 0;
  if (unit.is(feature) && unit.waitedMs > starvationMs) return 1;
  if (unit.is(bug)) return 2;
  if (unit.is(feature)) return 3;
  return 4;
};

const priorities = H.policy.scheduler('heartbeats-bugs-features-epics', view => ({
  start: [...view.pending].sort((a, b) => rank(a) - rank(b) || b.waitedMs - a.waitedMs),
}));

const supervisor = cc.supervisor({
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
  .ledger(sqlite.ledger('.harness/coding-team.sqlite'))
  .lanes(heartbeats, bugs, features, epics)
  .pools(claudePool)
  .triggers(failedHeartbeatFilesBug)
  .scheduler(priorities)
  .clients(supervisor)
  .observers(markdown.board('BOARD.md'), markdown.telemetry('TELEMETRY.md'));

export const running = codingTeam.start();
