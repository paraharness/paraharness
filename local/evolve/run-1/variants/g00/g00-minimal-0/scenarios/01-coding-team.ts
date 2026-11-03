import { z } from 'zod';
import { H, PendingView } from 'harness-dsl';
import * as claudeCode from 'harness-dsl/claude-code';
import * as anthropic from 'harness-dsl/anthropic';
import * as linear from 'harness-dsl/linear';
import * as folder from 'harness-dsl/folder';
import * as sqlite from 'harness-dsl/sqlite';
import * as jsonl from 'harness-dsl/jsonl';
import * as git from 'harness-dsl/git';
import * as shell from 'harness-dsl/shell';
import * as markdown from 'harness-dsl/markdown';

const ticket = z.object({
  title: z.string(),
  description: z.string(),
  issueId: z.string().optional(),
});

const ticketLifecycle = H.lifecycle({
  todo: 'pending',
  building: 'active',
  auditing: 'active',
  done: 'succeeded',
  abandoned: 'failed',
  cancelled: 'cancelled',
});

const Bug = H.kind('Bug').data(ticket).states(ticketLifecycle, 'todo');
const Feature = H.kind('Feature').data(ticket).states(ticketLifecycle, 'todo');

const Epic = H.kind('Epic').data(ticket).states({
  todo: 'pending',
  planning: 'active',
  'in-progress': 'idle',
  integrating: 'pending',
  done: 'succeeded',
  failed: 'failed',
  cancelled: 'cancelled',
}, 'todo');

const Heartbeat = H.kind('ServiceHeartbeat').data(z.object({ service: z.string(), url: z.string() })).states({
  due: 'pending',
  probing: 'active',
  healthy: 'succeeded',
  down: 'failed',
}, 'due');

const Experience = H.memory('experience', 'fallible');
const Taste = H.memory('taste', 'owner');
const experience = H.library('experience', Experience, jsonl.memory('memory/experience.jsonl'));
const taste = H.library('taste', Taste, jsonl.memory('memory/taste.jsonl'));

const worktrees = git.worktree('worktrees', { repo: '.', slots: 4 });
const local = shell.local('local', { slots: 4 });

const projectChecks = H.command('project-checks').argv(() => ['npm', 'run', 'check']).on(worktrees);
const probeProduction = H.command('probe-production').argv(() => ['curl', '-fsS', 'https://app.example.com/health']).on(local);
const ping = H.command('ping-service')
  .input(z.object({ url: z.string() }))
  .argv(input => ['curl', '-fsS', '--max-time', '10', input.url])
  .on(local);

const builderRole = H.role('builder')
  .input(z.object({
    title: z.string(),
    description: z.string(),
    deficits: z.array(z.string()),
    answer: z.string().optional(),
  }))
  .output(z.object({ summary: z.string(), question: z.string().optional() }))
  .prompt(input => [
    `Implement: ${input.title}`,
    input.description,
    input.deficits.length > 0 ? `Resolve these deficits:\n${input.deficits.join('\n')}` : '',
    input.answer ? `The owner decided: ${input.answer}` : '',
  ].join('\n\n'))
  .intents(['read', 'edit', 'execute', 'ask']);

const auditorRole = H.role('auditor')
  .input(z.object({ title: z.string(), description: z.string(), summary: z.string() }))
  .output(z.object({ deficits: z.array(z.string()) }))
  .prompt(input => `Audit the change for "${input.title}" against:\n${input.description}\n\nBuilder summary:\n${input.summary}\n\nList every deficit.`)
  .intents(['read', 'execute']);

const plannerRole = H.role('planner')
  .input(z.object({ title: z.string(), description: z.string() }))
  .output(z.object({ features: z.array(z.object({ title: z.string(), description: z.string() })) }))
  .prompt(input => `Decompose the epic "${input.title}" into independently shippable features.\n\n${input.description}`)
  .intents(['read']);

const sonnet = claudeCode.model('claude-sonnet');
const opus = claudeCode.model('claude-opus');

const builderModel = H.policy.model('builder-model', choice => {
  const cheap = choice.metrics.successRate({ kind: choice.kind, model: sonnet.name, days: 14 });
  const tooFewSamples = cheap.samples < 20;
  const stillGood = cheap.value !== null && cheap.value >= 0.85;
  return tooFewSamples || stillGood ? sonnet : opus;
});

const builder = H.agent('builder', builderRole)
  .model(builderModel)
  .on(worktrees)
  .recalls(experience, taste)
  .guards(claudeCode.fileLeases(), claudeCode.stopCheck(projectChecks));

const auditor = H.agent('auditor', auditorRole)
  .model(opus)
  .on(worktrees)
  .recalls(experience)
  .records(experience);

const planner = H.agent('planner', plannerRole).model(opus).recalls(taste);

const subscriptionA = claudeCode.subscription('claude-a', { token: H.env('CLAUDE_A_TOKEN') });
const subscriptionB = claudeCode.subscription('claude-b', { token: H.env('CLAUDE_B_TOKEN') });
const subscriptionC = claudeCode.subscription('claude-c', { token: H.env('CLAUDE_C_TOKEN') });
const apiAccount = anthropic.account('anthropic-api', { apiKey: H.env('ANTHROPIC_API_KEY') });

const soonestExpiringFirst = H.policy.account('soonest-expiring-first', choice => {
  const subscriptions = choice.accounts
    .filter(view => view.eligible && view.account.plan === 'subscription')
    .sort((a, b) => (a.windowEndsAt?.getTime() ?? Infinity) - (b.windowEndsAt?.getTime() ?? Infinity));
  const metered = choice.accounts.find(view => view.eligible && view.account.plan === 'metered');
  return subscriptions[0]?.account ?? metered?.account ?? null;
});

const claudePool = H.pool('claude', [
  { account: subscriptionA, share: 0.5 },
  { account: subscriptionB, share: 0.3 },
  { account: subscriptionC, share: 0.2 },
  { account: apiAccount, share: 1 },
], soonestExpiringFirst);

const touchedResources = (title: string): readonly string[] =>
  /payment/i.test(title) ? ['payments'] : [];

const ticketFlow = H.flow('build-and-audit')
  .for(Bug, Feature)
  .params(z.object({ rounds: z.number().int().positive() }))
  .does(async ctx => {
    const { title, description } = ctx.unit.data;
    const scope = { resources: touchedResources(title) };
    let deficits: readonly string[] = [];
    let answer: string | undefined;
    for (let round = 1; round <= ctx.params.rounds; round++) {
      await ctx.move('building');
      const built = await ctx.run(builder, { title, description, deficits: [...deficits], answer }, { scope });
      if (!built.ok) return 'abandoned';
      const question = built.value.question;
      if (question) {
        const decision = await ctx.halt({
          name: 'owner-decision',
          show: question,
          decision: z.object({ answer: z.string() }),
        });
        answer = decision.answer;
        continue;
      }
      await ctx.move('auditing');
      const audit = await ctx.run(auditor, { title, description, summary: built.value.summary }, { scope });
      if (!audit.ok) return 'abandoned';
      if (audit.value.deficits.length === 0) return 'done';
      deficits = audit.value.deficits;
    }
    return 'abandoned';
  });

const linearKey = H.env('LINEAR_API_KEY');
const ticketStatuses = {
  todo: 'Todo',
  building: 'In Progress',
  auditing: 'In Review',
  done: 'Done',
  abandoned: 'Canceled',
  cancelled: 'Canceled',
};

const linearBugs = linear.tracker(Bug, {
  apiKey: linearKey,
  team: 'ENG',
  label: 'bug',
  read: issue => ({ title: issue.title, description: issue.description, issueId: issue.id }),
  statuses: ticketStatuses,
});
const linearFeatures = linear.tracker(Feature, {
  apiKey: linearKey,
  team: 'ENG',
  label: 'feature',
  read: issue => ({ title: issue.title, description: issue.description, issueId: issue.id }),
  statuses: ticketStatuses,
});
const linearEpics = linear.tracker(Epic, {
  apiKey: linearKey,
  team: 'ENG',
  label: 'epic',
  read: issue => ({ title: issue.title, description: issue.description, issueId: issue.id }),
  statuses: {
    todo: 'Todo',
    planning: 'In Progress',
    'in-progress': 'In Progress',
    integrating: 'In Review',
    done: 'Done',
    failed: 'Canceled',
    cancelled: 'Canceled',
  },
});
const bugFiles = folder.files(Bug, {
  dir: 'bugs',
  read: file => ({ title: String(file.frontmatter.title ?? file.path), description: file.body }),
});

const bugLane = H.lane('bugs', Bug)
  .handler(ticketFlow, { rounds: 3 })
  .suppliers(linearBugs, bugFiles, H.operator)
  .store(linearBugs)
  .wip(2);

const featureLane = H.lane('features', Feature)
  .handler(ticketFlow, { rounds: 5 })
  .suppliers(linearFeatures, H.operator)
  .store(linearFeatures);

const epicFlow = H.flow('decompose-epic')
  .for(Epic)
  .does(async ctx => {
    if (ctx.unit.state === 'integrating') {
      const children = await ctx.children();
      return children.every(child => child.outcome === 'succeeded') ? 'done' : 'failed';
    }
    await ctx.move('planning');
    const plan = await ctx.run(planner, { title: ctx.unit.data.title, description: ctx.unit.data.description });
    if (!plan.ok) return 'failed';
    await ctx.spawn(featureLane, plan.value.features);
    return ctx.until('in-progress', { children: true, then: 'integrating' });
  });

const epicLane = H.lane('epics', Epic)
  .handler(epicFlow)
  .suppliers(linearEpics)
  .store(linearEpics)
  .wip(1);

const services = [
  { service: 'api', url: 'https://api.example.com/health' },
  { service: 'web', url: 'https://app.example.com/health' },
];

const heartbeatFlow = H.flow('heartbeat')
  .for(Heartbeat)
  .does(async ctx => {
    await ctx.move('probing');
    const probe = await ctx.run(ping, { url: ctx.unit.data.url });
    return probe.ok ? 'healthy' : 'down';
  });

const heartbeatLane = H.lane('heartbeats', Heartbeat)
  .handler(heartbeatFlow)
  .suppliers(H.schedule('every-five-minutes', Heartbeat, { every: { minutes: 5 } }, tick =>
    services.map(service => ({ create: service, key: `${service.service}-${tick.now.toISOString()}` }))));

const heartbeatFailureFilesBug = H.trigger('heartbeat-failure-files-bug', H.on.enters(Heartbeat, 'down'), (event, act) =>
  act.create(bugLane, {
    title: `Service ${event.unit.data.service} failed its heartbeat`,
    description: `Heartbeat ${event.unit.key} against ${event.unit.data.url} failed at ${event.at.toISOString()}.`,
  }));

const featureStarvationMs = 2 * 60 * 60 * 1000;
const rank = (unit: PendingView): number => {
  if (unit.lane === heartbeatLane.name) return 0;
  if (unit.lane === featureLane.name && unit.waitedMs > featureStarvationMs) return 1;
  if (unit.lane === bugLane.name) return 2;
  if (unit.lane === featureLane.name) return 3;
  return 4;
};

const scheduler = H.policy.schedule('heartbeats-bugs-features-epics', view => ({
  start: [...view.pending].sort((a, b) => rank(a) - rank(b) || b.waitedMs - a.waitedMs),
}));

export const harness = H.harness('coding-team')
  .ledger(sqlite.ledger('.harness/ledger.db'))
  .lanes(heartbeatLane, bugLane, featureLane, epicLane)
  .pools(claudePool)
  .triggers(heartbeatFailureFilesBug)
  .scheduler(scheduler)
  .clients(claudeCode.supervisor({
    grants: [
      H.ops.readWork,
      H.ops.writeWork,
      H.ops.resolveHalts,
      H.ops.readMemory,
      H.ops.writeMemory,
      H.ops.readTelemetry,
      H.ops.readAccounts,
      H.ops.setShares,
      H.operation('probe-production', probeProduction),
    ],
  }))
  .observers(markdown.board('BOARD.md'), markdown.telemetry('TELEMETRY.md'));
