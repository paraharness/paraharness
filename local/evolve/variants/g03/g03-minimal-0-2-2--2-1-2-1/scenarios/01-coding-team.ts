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

const open = H.state('open', 'pending');
const done = H.state('done', 'terminal', 'success');
const wontfix = H.state('wontfix', 'terminal', 'neutral');

const proposed = H.state('proposed', 'pending');
const awaitingFeatures = H.state('awaiting-features', 'waiting');
const delivered = H.state('delivered', 'terminal', 'success');
const descoped = H.state('descoped', 'terminal', 'neutral');

const due = H.state('due', 'pending');
const healthy = H.state('healthy', 'terminal', 'success');
const unhealthy = H.state('unhealthy', 'terminal', 'failure');

export const bug = H.kind('Bug')
  .data(z.object({ title: z.string(), body: z.string() }))
  .states(open, done, wontfix);

export const feature = H.kind('Feature')
  .data(z.object({ title: z.string(), body: z.string(), epic: z.string().optional() }))
  .states(open, done, wontfix);

export const epic = H.kind('Epic')
  .data(z.object({ title: z.string(), body: z.string() }))
  .states(proposed, awaitingFeatures, delivered, descoped);

export const heartbeat = H.kind('ServiceHeartbeat')
  .data(z.object({ service: z.string() }))
  .states(due, healthy, unhealthy);

const building = H.role('builder')
  .input(z.object({ task: z.string(), deficits: z.array(z.string()), answer: z.string().optional() }))
  .output(z.object({ summary: z.string(), question: z.string().optional() }))
  .prompt(input =>
    [
      `Implement the task.\n\n${input.task}`,
      input.deficits.length > 0 ? `Fix these deficits found by the auditor:\n- ${input.deficits.join('\n- ')}` : '',
      input.answer !== undefined ? `The owner answered your question: ${input.answer}` : '',
      'If you need an owner decision before continuing, return it as question.',
    ].join('\n\n')
  )
  .intents(['read', 'edit', 'execute']);

const auditing = H.role('auditor')
  .input(z.object({ task: z.string(), summary: z.string() }))
  .output(z.object({ deficits: z.array(z.string()) }))
  .prompt(input => `Audit the change against the task. List every deficit, or none.\n\nTask:\n${input.task}\n\nBuilder summary:\n${input.summary}`)
  .intents(['read', 'execute']);

const planning = H.role('planner')
  .input(z.object({ title: z.string(), body: z.string() }))
  .output(z.object({ features: z.array(z.object({ title: z.string(), body: z.string() })) }))
  .prompt(input => `Decompose this epic into independently shippable features.\n\n${input.title}\n\n${input.body}`)
  .intents(['read']);

const experienceMemory = H.memory('experience', 'experience');
const tasteMemory = H.memory('taste', 'taste');

const experience = H.journal('team-experience', experienceMemory, jsonl.memory('memory/experience.jsonl'));
const taste = H.journal('owner-taste', tasteMemory, jsonl.memory('memory/taste.jsonl'));

const ownerDecision = H.halt('owner-decision', z.object({ answer: z.string() })).about(z.object({ question: z.string() }));

export const subscriptionOne = claude.subscription('claude-max-1', { token: H.env('CLAUDE_TOKEN_1') });
export const subscriptionTwo = claude.subscription('claude-max-2', { token: H.env('CLAUDE_TOKEN_2') });
export const subscriptionThree = claude.subscription('claude-max-3', { token: H.env('CLAUDE_TOKEN_3') });
const apiAccount = anthropic.account('anthropic-api', { apiKey: H.env('ANTHROPIC_API_KEY') });

const soonestExpiringFirst = H.policy.account('soonest-expiring-subscription-then-api', choice => {
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

const claudePool = H.pool(
  'claude',
  [
    { account: subscriptionOne, share: 0.8 },
    { account: subscriptionTwo, share: 0.6 },
    { account: subscriptionThree, share: 0.5 },
    { account: apiAccount, share: 1 },
  ],
  soonestExpiringFirst
);

const sonnet = claude.model('claude-sonnet-4-5');
const opus = claude.model('claude-opus-4-1');

const cheapSuccessFloor = 0.85;
const cheapMinSamples = 20;

const builderModel = H.policy.model('cheap-until-success-drops', [sonnet, opus], choice => {
  const cheap = choice.metrics.successRate({ kind: choice.kind, model: sonnet, days: 14 });
  if (cheap.samples < cheapMinSamples || cheap.value === null) return sonnet;
  return cheap.value < cheapSuccessFloor ? opus : sonnet;
});

const worktrees = git.worktree('builder-worktree', { repo: '.', slots: 3 });
const local = shell.local('local', { slots: 4 });

const projectChecks = H.command('project-checks').argv(() => ['npm', 'run', 'check']).on(worktrees);

const builder = H.seat('builder', building)
  .model(builderModel)
  .on(worktrees)
  .recalls(experience, taste)
  .guards(claude.fileLeases(), claude.stopCheck(projectChecks));

const auditor = H.seat('auditor', auditing).model(opus).on(worktrees).recalls(experience).records(experience);

const planner = H.seat('planner', planning).model(opus).recalls(taste);

const serviceProbe = H.command('service-probe')
  .input(z.object({ service: z.string() }))
  .argv(input => ['scripts/probe-service.sh', input.service])
  .on(local);

const productionHealth = H.command('production-health').argv(() => ['scripts/production-health.sh']).on(local);

const buildAndAudit = H.flow('build-and-audit')
  .for(bug, feature)
  .params(z.object({ rounds: z.number().int().positive() }))
  .does(async ctx => {
    const task = `${ctx.unit.data.title}\n\n${ctx.unit.data.body}`;
    let deficits: string[] = [];
    let answer: string | undefined;
    for (let round = 1; round <= ctx.params.rounds; round++) {
      const built = await ctx.run(builder, { task, deficits, answer });
      if (!built.ok) return ctx.fail(built.error);
      const question = built.value.question;
      if (question !== undefined) {
        const decision = await ctx.halt(ownerDecision, question, { question });
        answer = decision.answer;
        continue;
      }
      const audit = await ctx.run(auditor, { task, summary: built.value.summary });
      if (!audit.ok) return ctx.fail(audit.error);
      if (audit.value.deficits.length === 0) return 'done';
      deficits = audit.value.deficits;
    }
    return ctx.fail(`deficits remain after ${ctx.params.rounds} rounds: ${deficits.join('; ')}`);
  });

const checkHeartbeat = H.flow('check-heartbeat')
  .for(heartbeat)
  .does(async ctx => {
    const probe = await ctx.run(serviceProbe, { service: ctx.unit.data.service });
    return probe.ok ? 'healthy' : 'unhealthy';
  });

const linearKey = H.env('LINEAR_API_KEY');
const workStatuses = { open: 'Todo', done: 'Done', wontfix: 'Canceled' };

const bugTracker = linear.tracker(bug, {
  apiKey: linearKey,
  team: 'PRODUCT',
  label: 'bug',
  read: issue => ({ title: issue.title, body: issue.description }),
  statuses: workStatuses,
});

const featureTracker = linear.tracker(feature, {
  apiKey: linearKey,
  team: 'PRODUCT',
  label: 'feature',
  read: issue => ({ title: issue.title, body: issue.description, epic: issue.parentId }),
  statuses: workStatuses,
});

const epicTracker = linear.tracker(epic, {
  apiKey: linearKey,
  team: 'PRODUCT',
  label: 'epic',
  read: issue => ({ title: issue.title, body: issue.description }),
  statuses: { proposed: 'Backlog', 'awaiting-features': 'In Progress', delivered: 'Done', descoped: 'Canceled' },
});

const bugFolder = folder.files(bug, {
  dir: 'bugs',
  read: file => ({ title: String(file.frontmatter['title'] ?? file.path), body: file.body }),
});

const services = ['api', 'payments', 'web'];

const heartbeatClock = H.clock('every-five-minutes', heartbeat, { every: { minutes: 5 } }, () =>
  services.map(service => ({ create: { service } }))
);

export const heartbeatLane = H.lane('heartbeats', heartbeat)
  .handler(checkHeartbeat, { exhausted: 'unhealthy' })
  .suppliers(heartbeatClock);

export const bugLane = H.lane('bugs', bug)
  .handler(buildAndAudit, { params: { rounds: 3 }, retries: 1, exhausted: H.halts.exhausted })
  .suppliers(bugTracker, bugFolder, H.operator)
  .store(bugTracker)
  .wip(2);

export const featureLane = H.lane('features', feature)
  .handler(buildAndAudit, { params: { rounds: 5 }, retries: 1, exhausted: H.halts.exhausted })
  .suppliers(featureTracker, H.operator)
  .store(featureTracker);

const decomposeEpic = H.flow('decompose-epic')
  .for(epic)
  .does(async ctx => {
    const plan = await ctx.run(planner, { title: ctx.unit.data.title, body: ctx.unit.data.body });
    if (!plan.ok) return ctx.fail(plan.error);
    const children = await ctx.spawn(
      featureLane,
      plan.value.features.map(planned => ({ title: planned.title, body: planned.body, epic: ctx.unit.key }))
    );
    const finished = await ctx.suspend('awaiting-features', { children });
    return finished.every(child => child.state === 'done') ? 'delivered' : 'descoped';
  });

export const epicLane = H.lane('epics', epic)
  .handler(decomposeEpic, { exhausted: H.halts.exhausted })
  .suppliers(epicTracker)
  .store(epicTracker)
  .wip(1);

const failedHeartbeatFilesBug = H.trigger(
  'failed-heartbeat-files-bug',
  H.on.enters(heartbeat, 'unhealthy'),
  (event, act) =>
    act.create(
      bugLane,
      {
        title: `Service ${event.unit.data.service} failed its heartbeat`,
        body: `The heartbeat for ${event.unit.data.service} failed at ${event.at.toISOString()}.`,
      },
      `heartbeat-${event.unit.data.service}`
    )
);

const featureStarvedAfterMs = 4 * 60 * 60 * 1000;

const priority = (unit: PendingView): number => {
  if (unit.kind === heartbeat.name) return 0;
  if (unit.kind === feature.name && unit.waitedMs > featureStarvedAfterMs) return 1;
  if (unit.kind === bug.name) return 2;
  if (unit.kind === feature.name) return 3;
  return 4;
};

const teamScheduler = H.policy.scheduler('heartbeats-bugs-features-epics', view => ({
  start: [...view.pending].sort((a, b) => priority(a) - priority(b) || b.waitedMs - a.waitedMs),
}));

const supervisor = claude.supervisor({
  grants: [
    H.ops.readWork,
    H.ops.writeWork,
    H.ops.resolve(ownerDecision, H.halts.exhausted, H.halts.interrupted, H.halts.definitionChanged),
    H.ops.readMemory,
    H.ops.writeMemory,
    H.ops.readTelemetry,
    H.ops.readAccounts,
    H.ops.setShares,
    H.operation('production-health-probe', productionHealth),
  ],
});

export const codingTeam = H.harness('coding-team')
  .ledger(sqlite.ledger('.harness/coding-team.sqlite'))
  .lanes(heartbeatLane, bugLane, featureLane, epicLane)
  .pools(claudePool)
  .triggers(failedHeartbeatFilesBug)
  .scheduler(teamScheduler)
  .clients(supervisor)
  .observers(markdown.board('BOARD.md'), markdown.telemetry('TELEMETRY.md'));
