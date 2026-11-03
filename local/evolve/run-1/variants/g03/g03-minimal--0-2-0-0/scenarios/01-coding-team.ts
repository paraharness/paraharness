import { H } from 'harness-dsl';
import type { PendingView } from 'harness-dsl';
import { z } from 'zod';
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
const planning = H.state('planning', 'pending');
const decomposed = H.state('decomposed', 'waiting');
const reviewing = H.state('reviewing', 'pending');
const due = H.state('due', 'pending');
const done = H.state('done', 'terminal', 'success');
const abandoned = H.state('abandoned', 'terminal', 'failure');
const up = H.state('up', 'terminal', 'success');
const down = H.state('down', 'terminal', 'failure');

const workData = z.object({ title: z.string(), description: z.string() });

const Bug = H.kind('Bug').data(workData).states(queued, done, abandoned).failsTo('abandoned');
const Feature = H.kind('Feature').data(workData).states(queued, done, abandoned).failsTo('abandoned');
const Epic = H.kind('Epic').data(workData).states(planning, decomposed, reviewing, done, abandoned);
const Heartbeat = H.kind('ServiceHeartbeat').data(z.object({ service: z.string() })).states(due, up, down);

const experience = H.memory('engineering-experience', 'experience');
const taste = H.memory('owner-taste', 'taste');
const experienceArchive = H.archive('experience', experience, jsonl.memory('memory/experience.jsonl'));
const tasteArchive = H.archive('taste', taste, jsonl.memory('memory/taste.jsonl'));
const builderBriefing = H.briefing('builder-briefing', [experienceArchive, tasteArchive]);
const auditorBriefing = H.briefing('auditor-briefing', [experienceArchive]);
const plannerBriefing = H.briefing('planner-briefing', [tasteArchive]);

const worktree = git.worktree('worktree', { repo: '.', slots: 3 });
const localRunner = shell.local('local', { slots: 2 });

const projectChecks = H.command('project-checks')
  .argv(() => ['npm', 'run', 'check'])
  .on(worktree)
  .recovers('rerun');

const serviceProbe = H.command('service-probe')
  .input(z.object({ service: z.string() }))
  .argv((input) => ['curl', '-fsS', `https://${input.service}.internal/health`])
  .on(localRunner)
  .recovers('rerun');

const productionHealth = H.command('production-health')
  .argv(() => ['curl', '-fsS', 'https://app.example.com/health'])
  .on(localRunner)
  .recovers('rerun');

const cheapModel = cc.model('claude-sonnet-4-5');
const strongModel = cc.model('claude-opus-4-1');

const builderModel = H.policy.model('builder-model', (choice) => {
  const cheap = choice.metrics.successRate({ kind: choice.kind, model: cheapModel, days: 14 });
  if (cheap.samples < 20) return cheapModel;
  return (cheap.value ?? 0) < 0.85 ? strongModel : cheapModel;
});

const builderRole = H.role('builder')
  .input(z.object({ title: z.string(), description: z.string(), feedback: z.array(z.string()) }))
  .output(z.object({ summary: z.string(), question: z.string().optional() }))
  .prompt((input) => `Implement: ${input.title}\n\n${input.description}\n\nAddress:\n${input.feedback.join('\n')}`)
  .intents(['read', 'edit', 'execute']);

const auditorRole = H.role('auditor')
  .input(z.object({ title: z.string(), description: z.string(), summary: z.string() }))
  .output(z.object({ deficits: z.array(z.string()) }))
  .prompt((input) => `Audit the change for "${input.title}". Builder reports: ${input.summary}. List every deficit.`)
  .intents(['read', 'execute']);

const plannerRole = H.role('planner')
  .input(z.object({ title: z.string(), description: z.string() }))
  .output(z.object({ features: z.array(z.object({ title: z.string(), description: z.string() })) }))
  .prompt((input) => `Decompose the epic "${input.title}" into features.\n\n${input.description}`)
  .intents(['read']);

const builder = H.agent('builder', builderRole)
  .model(builderModel)
  .on(worktree)
  .recalls(builderBriefing)
  .guards(cc.fileLeases(), cc.stopCheck(projectChecks));

const auditor = H.agent('auditor', auditorRole)
  .model(strongModel)
  .on(worktree)
  .recalls(auditorBriefing)
  .records(experienceArchive);

const planner = H.agent('planner', plannerRole).model(strongModel).recalls(plannerBriefing);

const ownerDecision = H.halt('owner-decision', z.object({ decision: z.string() }));

const delivery = H.flow('delivery')
  .for(Bug, Feature)
  .params(z.object({ rounds: z.number().int().positive() }))
  .does(async (ctx) => {
    const { title, description } = ctx.unit.data;
    let feedback: string[] = [];
    for (let round = 1; round <= ctx.params.rounds; round += 1) {
      const built = await ctx.run(builder, { title, description, feedback });
      if (built.ok === false) return ctx.fail(built.error);
      if (built.value.question) {
        const answer = await ctx.halt(ownerDecision, built.value.question);
        feedback = [`Owner decided: ${answer.decision}`];
        continue;
      }
      const audit = await ctx.run(auditor, { title, description, summary: built.value.summary });
      if (audit.ok === false) return ctx.fail(audit.error);
      if (audit.value.deficits.length === 0) return 'done';
      feedback = audit.value.deficits;
    }
    return ctx.fail(`deficits remain after ${ctx.params.rounds} rounds`);
  });

const heartbeatFlow = H.flow('heartbeat')
  .for(Heartbeat)
  .does(async (ctx) => {
    const probe = await ctx.run(serviceProbe, { service: ctx.unit.data.service });
    return probe.ok ? 'up' : 'down';
  });

const linearKey = H.env('LINEAR_API_KEY');
const ticketStatuses = { queued: 'Todo', done: 'Done', abandoned: 'Canceled' };

const bugTracker = linear.tracker(Bug, {
  apiKey: linearKey,
  team: 'ENG',
  label: 'bug',
  read: (issue) => ({ title: issue.title, description: issue.description }),
  statuses: ticketStatuses,
});
const bugFolder = folder.files(Bug, {
  dir: 'bugs',
  read: (file) => ({
    title: typeof file.frontmatter.title === 'string' ? file.frontmatter.title : file.path,
    description: file.body,
  }),
});
const featureTracker = linear.tracker(Feature, {
  apiKey: linearKey,
  team: 'ENG',
  label: 'feature',
  read: (issue) => ({ title: issue.title, description: issue.description }),
  statuses: ticketStatuses,
});
const epicTracker = linear.tracker(Epic, {
  apiKey: linearKey,
  team: 'ENG',
  label: 'epic',
  read: (issue) => ({ title: issue.title, description: issue.description }),
  statuses: {
    planning: 'Todo',
    decomposed: 'In Progress',
    reviewing: 'In Review',
    done: 'Done',
    abandoned: 'Canceled',
  },
});

const services = ['api', 'web', 'worker'];
const heartbeatClock = H.clock('every-five-minutes', Heartbeat, { every: { minutes: 5 } }, (tick) =>
  services.map((service) => ({ create: { service }, key: `${service}-${tick.now.toISOString()}` }))
);

const threeTries = H.policy.retry('three-tries', (view) =>
  view.failures >= 3 ? 'stop' : { retryInMs: 60_000 * 2 ** view.failures }
);

const bugs = H.lane('bugs', Bug)
  .handler(delivery, { rounds: 3 })
  .suppliers(bugTracker, bugFolder, H.operator)
  .store(bugTracker)
  .wip(2)
  .retry(threeTries);

const features = H.lane('features', Feature)
  .handler(delivery, { rounds: 5 })
  .suppliers(featureTracker, H.operator)
  .store(featureTracker)
  .retry(threeTries);

const epicFlow = H.flow('epic')
  .for(Epic)
  .does(async (ctx) => {
    const plan = await ctx.run(planner, { title: ctx.unit.data.title, description: ctx.unit.data.description });
    if (plan.ok === false) return ctx.fail(plan.error);
    await ctx.spawn(features, plan.value.features);
    return ctx.wait('decomposed', { children: true, then: 'reviewing' });
  })
  .phase('reviewing', async (ctx) => {
    const children = await ctx.children(features);
    const finished = children.every((child) => child.position === 'terminal');
    if (finished) return children.some((child) => child.state === 'abandoned') ? 'abandoned' : 'done';
    return ctx.wait('decomposed', { children: true, then: 'reviewing' });
  });

const epics = H.lane('epics', Epic).handler(epicFlow).suppliers(epicTracker).store(epicTracker).wip(1);

const heartbeats = H.lane('heartbeats', Heartbeat).handler(heartbeatFlow).suppliers(heartbeatClock);

const heartbeatBug = H.trigger('heartbeat-failure-files-bug', H.on.enters(Heartbeat, 'down'), (event, act) =>
  act.create(
    bugs,
    {
      title: `Heartbeat failed: ${event.unit.data.service}`,
      description: `The ${event.unit.data.service} health probe failed at ${event.at.toISOString()}.`,
    },
    `heartbeat-${event.unit.data.service}`
  )
);

const starvationMs = 2 * 60 * 60 * 1000;

const codingOrder = H.policy.scheduler('heartbeats-bugs-features-epics', (view) => {
  const rank = (unit: PendingView): number => {
    if (unit.lane === heartbeats.name) return 0;
    if (unit.lane === features.name && unit.waitedMs > starvationMs) return 1;
    if (unit.lane === bugs.name) return 2;
    if (unit.lane === features.name) return 3;
    return 4;
  };
  return { start: [...view.pending].sort((a, b) => rank(a) - rank(b) || b.waitedMs - a.waitedMs) };
});

const drainSoonestExpiring = H.policy.account('drain-soonest-expiring', (choice) => {
  const subscription = [...choice.accounts]
    .sort((a, b) => (a.windowEndsAt?.getTime() ?? Infinity) - (b.windowEndsAt?.getTime() ?? Infinity))
    .find((view) => view.eligible && view.account.plan === 'subscription' && view.usedShare < view.share);
  if (subscription) return subscription.account;
  const metered = choice.accounts.find((view) => view.eligible && view.account.plan === 'metered');
  return metered ? metered.account : null;
});

const claudePool = H.pool(
  'claude',
  [
    { account: cc.subscription('max-1', { token: H.env('CLAUDE_TOKEN_1') }), share: 0.8 },
    { account: cc.subscription('max-2', { token: H.env('CLAUDE_TOKEN_2') }), share: 0.6 },
    { account: cc.subscription('max-3', { token: H.env('CLAUDE_TOKEN_3') }), share: 0.5 },
    { account: anthropic.account('api-fallback', { apiKey: H.env('ANTHROPIC_API_KEY') }), share: 1 },
  ],
  drainSoonestExpiring
);

const supervisor = cc.supervisor({
  grants: [
    H.ops.readWork,
    H.ops.writeWork,
    H.ops.resolveHalts,
    H.ops.readMemory,
    H.ops.writeMemory,
    H.ops.readTelemetry,
    H.ops.readAccounts,
    H.ops.setShares,
    H.operation('production-health-probe', productionHealth),
  ],
});

export const codingTeam = H.harness('coding-team')
  .ledger(sqlite.ledger('.harness/ledger.db'))
  .lanes(heartbeats, bugs, features, epics)
  .pools(claudePool)
  .triggers(heartbeatBug)
  .scheduler(codingOrder)
  .clients(supervisor)
  .observers(markdown.board('BOARD.md'), markdown.telemetry('TELEMETRY.md'));
