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

const Todo = H.state('todo', 'pending');
const Building = H.state('building', 'active');
const Done = H.state('done', 'terminal', 'success');
const Abandoned = H.state('abandoned', 'terminal', 'failure');

const Proposed = H.state('proposed', 'pending');
const AwaitingFeatures = H.state('awaiting-features', 'waiting');
const Settling = H.state('settling', 'pending');
const Incomplete = H.state('incomplete', 'terminal', 'failure');

const Due = H.state('due', 'pending');
const Healthy = H.state('healthy', 'terminal', 'success');
const Unhealthy = H.state('unhealthy', 'terminal', 'failure');

const workItem = z.object({ title: z.string(), description: z.string() });

const Bug = H.kind('bug').data(workItem).states(Todo, Building, Done, Abandoned).onFailure('abandoned', { afterAttempts: 3 });
const Feature = H.kind('feature').data(workItem).states(Todo, Building, Done, Abandoned).onFailure('abandoned', { afterAttempts: 3 });
const Epic = H.kind('epic').data(workItem).states(Proposed, AwaitingFeatures, Settling, Done, Incomplete);
const Heartbeat = H.kind('service-heartbeat').data(z.object({ service: z.string() })).states(Due, Healthy, Unhealthy);

const experienceMemory = H.memory('engineering-experience', 'experience');
const tasteMemory = H.memory('owner-taste', 'taste');
const experience = H.library('engineering-experience', experienceMemory, jsonl.memory('memory/experience.jsonl'));
const taste = H.library('owner-taste', tasteMemory, jsonl.memory('memory/taste.jsonl'));

const worktrees = git.worktree('worktrees', { repo: '.', slots: 4 });
const local = shell.local('local', { slots: 2 });

const sonnet = claudeCode.model('claude-sonnet-4-5');
const opus = claudeCode.model('claude-opus-4-1');

const subscriptionA = claudeCode.subscription('max-a', { token: H.env('CLAUDE_TOKEN_A') });
const subscriptionB = claudeCode.subscription('max-b', { token: H.env('CLAUDE_TOKEN_B') });
const subscriptionC = claudeCode.subscription('max-c', { token: H.env('CLAUDE_TOKEN_C') });
const apiAccount = anthropic.account('api', { apiKey: H.env('ANTHROPIC_API_KEY') });

const soonestExpiringFirst = H.policy.account('soonest-expiring-first', choice => {
  const subscriptions = choice.accounts
    .filter(a => a.eligible && a.account.plan === 'subscription' && a.usedShare < a.share)
    .sort((a, b) => (a.windowEndsAt === undefined ? Infinity : a.windowEndsAt.getTime()) - (b.windowEndsAt === undefined ? Infinity : b.windowEndsAt.getTime()));
  const first = subscriptions[0];
  if (first) return first.account;
  const metered = choice.accounts.find(a => a.eligible && a.account.plan === 'metered');
  return metered === undefined ? null : metered.account;
});

const accounts = H.pool(
  'claude',
  [
    { account: subscriptionA, share: 0.6 },
    { account: subscriptionB, share: 0.6 },
    { account: subscriptionC, share: 0.4 },
    { account: apiAccount, share: 1 },
  ],
  soonestExpiringFirst
);

const cheaperUntilItSlips = H.policy.model('cheaper-until-it-slips', choice => {
  const record = choice.metrics.successRate({ kind: choice.kind, model: sonnet, days: 14 });
  if (record.samples < 20 || record.value === null) return sonnet;
  return record.value >= 0.85 ? sonnet : opus;
});

const projectChecks = H.command('project-checks').argv(() => ['npm', 'run', 'check']).on(worktrees).recover('rerun');

const builderRole = H.role('builder')
  .input(z.object({
    title: z.string(),
    description: z.string(),
    deficits: z.array(z.string()),
    ownerAnswer: z.string().optional(),
  }))
  .output(z.object({ summary: z.string(), question: z.string().optional() }))
  .prompt(i => `Build: ${i.title}\n\n${i.description}\n\nOpen deficits:\n${i.deficits.join('\n')}\n\nOwner answer: ${i.ownerAnswer ?? 'none'}`)
  .intents(['read', 'edit', 'execute']);

const auditorRole = H.role('auditor')
  .input(z.object({ title: z.string(), description: z.string(), summary: z.string() }))
  .output(z.object({ deficits: z.array(z.string()) }))
  .prompt(i => `Audit the change for "${i.title}".\n\n${i.description}\n\nBuilder summary: ${i.summary}`)
  .intents(['read', 'execute']);

const plannerRole = H.role('planner')
  .input(z.object({ title: z.string(), description: z.string() }))
  .output(z.object({ features: z.array(workItem) }))
  .prompt(i => `Decompose the epic "${i.title}" into features.\n\n${i.description}`)
  .intents(['read']);

const builder = H.agent('builder', builderRole)
  .model(cheaperUntilItSlips)
  .on(worktrees)
  .recalls(experience, taste)
  .guards(claudeCode.fileLeases(), claudeCode.stopCheck(projectChecks));

const auditor = H.agent('auditor', auditorRole)
  .model(opus)
  .on(worktrees)
  .recalls(experience)
  .records(experience);

const planner = H.agent('planner', plannerRole).model(opus).recalls(taste);

const ownerCall = H.decision('owner-call')
  .input(z.object({ title: z.string(), question: z.string() }))
  .output(z.object({ answer: z.string() }))
  .show(i => `${i.title}: ${i.question}`);

const buildAndAudit = H.flow('build-and-audit')
  .for(Bug, Feature)
  .params(z.object({ rounds: z.number().int() }))
  .does(async ctx => {
    const { title, description } = ctx.unit.data;
    let deficits: string[] = [];
    let ownerAnswer: string | undefined;
    for (let round = 1; round <= ctx.params.rounds; round++) {
      const built = await ctx.run(builder, { title, description, deficits, ownerAnswer });
      if (built.ok === false) return ctx.fail(built.error);
      if (built.value.question) {
        const answer = await ctx.decide(ownerCall, { title, question: built.value.question });
        ownerAnswer = answer.answer;
        continue;
      }
      const audit = await ctx.run(auditor, { title, description, summary: built.value.summary });
      if (audit.ok === false) return ctx.fail(audit.error);
      if (audit.value.deficits.length === 0) return 'done';
      deficits = audit.value.deficits;
    }
    return ctx.fail(`deficits remain after ${ctx.params.rounds} rounds`);
  });

const healthCheck = H.command('health-check')
  .input(z.object({ service: z.string() }))
  .argv(i => ['scripts/health-check.sh', i.service])
  .on(local)
  .recover('rerun');

const heartbeatFlow = H.flow('heartbeat').for(Heartbeat).does(async ctx => {
  const check = await ctx.run(healthCheck, { service: ctx.unit.data.service });
  return check.ok ? 'healthy' : 'unhealthy';
});

const linearKey = H.env('LINEAR_API_KEY');
const workStatuses = { todo: 'Todo', building: 'In Progress', done: 'Done', abandoned: 'Canceled' };

const linearBugs = linear.tracker(Bug, {
  apiKey: linearKey,
  team: 'PRD',
  label: 'bug',
  read: issue => ({ title: issue.title, description: issue.description }),
  statuses: workStatuses,
});
const linearFeatures = linear.tracker(Feature, {
  apiKey: linearKey,
  team: 'PRD',
  label: 'feature',
  read: issue => ({ title: issue.title, description: issue.description }),
  statuses: workStatuses,
});
const linearEpics = linear.tracker(Epic, {
  apiKey: linearKey,
  team: 'PRD',
  label: 'epic',
  read: issue => ({ title: issue.title, description: issue.description }),
  statuses: { proposed: 'Backlog', 'awaiting-features': 'In Progress', settling: 'In Review', done: 'Done', incomplete: 'Canceled' },
});
const bugInbox = folder.files(Bug, {
  dir: 'inbox/bugs',
  read: file => {
    const title = file.frontmatter['title'];
    return { title: typeof title === 'string' ? title : file.path, description: file.body };
  },
});

const services = ['api', 'payments', 'web'];
const everyFiveMinutes = H.clock('heartbeat-clock', Heartbeat, { every: { minutes: 5 } }, tick =>
  services.map(service => ({ create: { service }, key: `${service}@${tick.now.toISOString()}` }))
);

const heartbeats = H.lane('heartbeats', Heartbeat).handler(heartbeatFlow).suppliers(everyFiveMinutes);
const bugs = H.lane('bugs', Bug).handler(buildAndAudit, { rounds: 3 }).suppliers(linearBugs, bugInbox, H.operator).store(linearBugs).wip(2);
const features = H.lane('features', Feature).handler(buildAndAudit, { rounds: 5 }).suppliers(linearFeatures, H.operator).store(linearFeatures);

const planEpic = H.flow('plan-epic').for(Epic).does(async ctx => {
  const plan = await ctx.run(planner, { title: ctx.unit.data.title, description: ctx.unit.data.description });
  if (plan.ok === false) return ctx.fail(plan.error);
  await ctx.spawn(features, plan.value.features);
  return ctx.until('awaiting-features', { children: true, then: 'settling' });
});

const settleEpic = H.flow('settle-epic').for(Epic).does(async ctx => {
  const children = await ctx.children();
  return children.every(child => child.state === 'done') ? 'done' : 'incomplete';
});

const epics = H.lane('epics', Epic)
  .handler({ proposed: planEpic, settling: settleEpic })
  .suppliers(linearEpics)
  .store(linearEpics)
  .wip(1);

const heartbeatFailureFilesBug = H.trigger('heartbeat-failure-files-bug', H.on.enters(Heartbeat, 'unhealthy'), (event, act) =>
  act.create(
    bugs,
    {
      title: `Service ${event.unit.data.service} failed its heartbeat`,
      description: `The heartbeat check for ${event.unit.data.service} failed at ${event.at.toISOString()}.`,
    },
    `heartbeat-${event.unit.data.service}`
  )
);

const featureStarvationMs = 6 * 3600_000;
const rank = (unit: PendingView): number => {
  if (unit.is(Heartbeat)) return 0;
  if (unit.is(Feature) && unit.waitedMs > featureStarvationMs) return 1;
  if (unit.is(Bug)) return 2;
  if (unit.is(Feature)) return 3;
  return 4;
};

const heartbeatsBugsFeaturesEpics = H.policy.scheduler('heartbeats-bugs-features-epics', view => ({
  start: [...view.pending].sort((a, b) => rank(a) - rank(b) || b.waitedMs - a.waitedMs),
}));

const productionProbe = H.operation(
  'production-health-probe',
  H.command('production-probe').argv(() => ['scripts/probe-production.sh']).on(local).recover('rerun')
);

const supervisor = claudeCode.supervisor({
  grants: [
    H.ops.readWork,
    H.ops.writeWork,
    H.ops.resolveDecisions,
    H.ops.writeMemory,
    H.ops.readTelemetry,
    H.ops.readAccounts,
    H.ops.setShares,
    productionProbe,
  ],
});

export const codingTeam = H.harness('coding-team')
  .ledger(sqlite.ledger('harness/coding-team.sqlite', { sharedQuota: 'harness/claude-quota.sqlite' }))
  .lanes(heartbeats, bugs, features, epics)
  .pools(accounts)
  .triggers(heartbeatFailureFilesBug)
  .scheduler(heartbeatsBugsFeaturesEpics)
  .clients(supervisor)
  .observers(markdown.board('BOARD.md'), markdown.telemetry('TELEMETRY.md'));
