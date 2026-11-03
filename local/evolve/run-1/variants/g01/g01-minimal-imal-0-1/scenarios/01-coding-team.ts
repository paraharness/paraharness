import { z } from 'zod';
import { H } from 'harness-dsl';
import type { AccountView, PendingView } from 'harness-dsl';
import * as claudeCode from 'harness-dsl/claude-code';
import * as anthropic from 'harness-dsl/anthropic';
import * as linear from 'harness-dsl/linear';
import * as folder from 'harness-dsl/folder';
import * as sqlite from 'harness-dsl/sqlite';
import * as jsonl from 'harness-dsl/jsonl';
import * as git from 'harness-dsl/git';
import * as shell from 'harness-dsl/shell';
import * as markdown from 'harness-dsl/markdown';

const queued = H.state('queued', 'pending');
const building = H.state('building', 'active');
const auditing = H.state('auditing', 'active');
const merged = H.state('merged', 'terminal', 'success');
const abandoned = H.state('abandoned', 'terminal', 'failure');
const declined = H.state('declined', 'terminal', 'neutral');
const ticketStates = [queued, building, auditing, merged, abandoned, declined];

const severity = z.enum(['urgent', 'normal']);
type Severity = z.infer<typeof severity>;
const severityOf = (urgent: boolean): Severity => (urgent ? 'urgent' : 'normal');

const Bug = H.kind('Bug')
  .data(z.object({ title: z.string(), body: z.string(), severity }))
  .states(ticketStates, { initial: 'queued', afterFailure: 'abandoned' });

const Feature = H.kind('Feature')
  .data(z.object({ title: z.string(), body: z.string(), epic: z.string().optional() }))
  .states(ticketStates, { initial: 'queued', afterFailure: 'abandoned' });

const Epic = H.kind('Epic')
  .data(z.object({ title: z.string(), body: z.string() }))
  .states(
    [
      H.state('proposed', 'pending'),
      H.state('planning', 'active'),
      H.state('awaiting-features', 'waiting'),
      H.state('closing', 'pending'),
      H.state('delivered', 'terminal', 'success'),
      H.state('dropped', 'terminal', 'failure'),
    ],
    { initial: 'proposed', afterFailure: 'dropped' }
  );

const service = z.enum(['api', 'web', 'worker']);

const Heartbeat = H.kind('ServiceHeartbeat')
  .data(z.object({ service }))
  .states(
    [
      H.state('due', 'pending'),
      H.state('probing', 'active'),
      H.state('up', 'terminal', 'success'),
      H.state('down', 'terminal', 'failure'),
    ],
    { initial: 'due', afterFailure: 'down' }
  );

const experience = H.memory('experience', 'experience');
const taste = H.memory('taste', 'taste');

const specificThenProven = H.policy.recall('specific-then-proven', view =>
  view.items
    .filter(item => item.status === 'accepted')
    .sort((a, b) => b.specificity - a.specificity || (b.trackRecord.value ?? 0) - (a.trackRecord.value ?? 0))
    .slice(0, 12)
);

const experienceLibrary = H.library('team-experience', experience, jsonl.memory('memory/experience.jsonl')).recall(specificThenProven);
const tasteLibrary = H.library('owner-taste', taste, jsonl.memory('memory/taste.jsonl')).recall(specificThenProven);

const quota = sqlite.quota('accounts.db');
const max1 = claudeCode.subscription('claude-max-1', { token: H.env('CLAUDE_MAX_1_TOKEN'), quota });
const max2 = claudeCode.subscription('claude-max-2', { token: H.env('CLAUDE_MAX_2_TOKEN'), quota });
const max3 = claudeCode.subscription('claude-max-3', { token: H.env('CLAUDE_MAX_3_TOKEN'), quota });
const api = anthropic.account('anthropic-api', { apiKey: H.env('ANTHROPIC_API_KEY') });

const sonnet = claudeCode.model('claude-sonnet-4-5');
const opus = claudeCode.model('claude-opus-4-1');

const windowEnd = (view: AccountView) =>
  view.windowEndsAt === undefined ? Number.POSITIVE_INFINITY : view.windowEndsAt.getTime();

const soonestExpiringFirst = H.policy.account('soonest-expiring-first', choice => {
  const open = choice.accounts
    .filter(view => view.eligible && view.account.plan === 'subscription' && view.usedShare < view.share)
    .sort((a, b) => windowEnd(a) - windowEnd(b));
  if (open.length > 0) return open[0].account;
  const metered = choice.accounts.find(view => view.eligible && view.account.plan === 'metered');
  return metered === undefined ? null : metered.account;
});

const claudePool = H.pool(
  'claude',
  [
    { account: max1, share: 0.5 },
    { account: max2, share: 0.3 },
    { account: max3, share: 0.2 },
    { account: api, share: 1 },
  ],
  soonestExpiringFirst
);

const cheaperUntilItSlips = H.policy.model('cheaper-until-it-slips', choice => {
  const cheaper = choice.metrics.successRate({ kind: choice.kind, model: sonnet.name, days: 14 });
  if (cheaper.samples < 20) return sonnet;
  return cheaper.value === null || cheaper.value >= 0.85 ? sonnet : opus;
});

const worktrees = git.worktree('worktree', { repo: '.', slots: 4 });
const local = shell.local('local', { slots: 4 });

const projectChecks = H.command('project-checks').argv(() => ['npm', 'run', 'check']).on(worktrees);

const productionHealth = H.command('production-health')
  .output(z.object({ healthy: z.boolean(), detail: z.string() }))
  .argv(() => ['./scripts/production-health.sh'])
  .on(local);

const probe = H.command('probe-service')
  .input(z.object({ service }))
  .argv(input => ['./scripts/probe.sh', input.service])
  .on(local)
  .ifInterrupted('rerun');

const builderRole = H.role('builder')
  .input(z.object({ title: z.string(), body: z.string(), round: z.number(), deficits: z.array(z.string()) }))
  .output(z.object({ summary: z.string(), declined: z.boolean() }))
  .prompt(input =>
    `Build: ${input.title}\n\n${input.body}\n\nRound ${input.round}. Open deficits:\n${input.deficits.join('\n')}`
  )
  .intents(['read', 'edit', 'execute', 'halt']);

const auditorRole = H.role('auditor')
  .input(z.object({ title: z.string(), body: z.string(), summary: z.string() }))
  .output(z.object({ deficits: z.array(z.string()) }))
  .prompt(input => `Audit the change for: ${input.title}\n\n${input.body}\n\nBuilder summary:\n${input.summary}`)
  .intents(['read', 'execute']);

const plannerRole = H.role('planner')
  .input(z.object({ title: z.string(), body: z.string() }))
  .output(z.object({ features: z.array(z.object({ title: z.string(), body: z.string() })) }))
  .prompt(input => `Decompose this epic into features: ${input.title}\n\n${input.body}`)
  .intents(['read']);

const builder = H.agent('builder', builderRole)
  .model(cheaperUntilItSlips)
  .on(worktrees)
  .recalls(experienceLibrary, tasteLibrary)
  .guards(claudeCode.fileLeases(), claudeCode.stopCheck(projectChecks));

const auditor = H.agent('auditor', auditorRole)
  .model(opus)
  .on(worktrees)
  .recalls(experienceLibrary)
  .records(experienceLibrary);

const planner = H.agent('planner', plannerRole).model(opus).recalls(tasteLibrary);

const ticketFlow = H.flow('ticket')
  .for(Bug, Feature)
  .params(z.object({ rounds: z.number().int().positive() }))
  .does(async ctx => {
    const task = { title: ctx.unit.data.title, body: ctx.unit.data.body };
    let deficits: string[] = [];
    for (let round = 1; round <= ctx.params.rounds; round++) {
      await ctx.move('building');
      const built = await ctx.run(builder, { ...task, round, deficits }, { step: `build-${round}` });
      if (built.ok === false) return ctx.fail(built.error);
      if (built.value.declined) return 'declined';
      await ctx.move('auditing');
      const audited = await ctx.run(auditor, { ...task, summary: built.value.summary }, { step: `audit-${round}` });
      if (audited.ok === false) return ctx.fail(audited.error);
      if (audited.value.deficits.length === 0) return 'merged';
      deficits = audited.value.deficits;
    }
    return 'abandoned';
  });

const heartbeatFlow = H.flow('heartbeat')
  .for(Heartbeat)
  .does(async ctx => {
    await ctx.move('probing');
    const probed = await ctx.run(probe, { service: ctx.unit.data.service }, { timeoutMs: 20_000 });
    return probed.ok ? 'up' : 'down';
  });

const ticketStatuses = {
  queued: 'Todo',
  building: 'In Progress',
  auditing: 'In Review',
  merged: 'Done',
  abandoned: 'Canceled',
  declined: 'Declined',
};

const linearBugs = linear.tracker(Bug, {
  apiKey: H.env('LINEAR_API_KEY'),
  team: 'PRODUCT',
  label: 'bug',
  read: issue => ({
    title: issue.title,
    body: issue.description,
    severity: severityOf(issue.labels.includes('urgent')),
  }),
  statuses: ticketStatuses,
});

const folderBugs = folder.files(Bug, {
  dir: 'bugs',
  read: file => ({
    title: String(file.frontmatter['title'] ?? file.path),
    body: file.body,
    severity: severityOf(file.frontmatter['severity'] === 'urgent'),
  }),
});

const linearFeatures = linear.tracker(Feature, {
  apiKey: H.env('LINEAR_API_KEY'),
  team: 'PRODUCT',
  label: 'feature',
  read: issue => ({ title: issue.title, body: issue.description, epic: issue.parentId }),
  statuses: ticketStatuses,
});

const linearEpics = linear.tracker(Epic, {
  apiKey: H.env('LINEAR_API_KEY'),
  team: 'PRODUCT',
  label: 'epic',
  read: issue => ({ title: issue.title, body: issue.description }),
  statuses: {
    proposed: 'Backlog',
    planning: 'Planning',
    'awaiting-features': 'In Progress',
    closing: 'In Review',
    delivered: 'Done',
    dropped: 'Canceled',
  },
});

const heartbeatSchedule = H.calendar('heartbeat-every-5-minutes', Heartbeat, { every: { minutes: 5 } }, tick =>
  service.options.map(name => ({ create: { service: name }, key: `heartbeat-${name}-${tick.now.toISOString()}` }))
);

const heartbeats = H.lane('heartbeats', Heartbeat).handler(heartbeatFlow).suppliers(heartbeatSchedule);

const bugs = H.lane('bugs', Bug)
  .handler(ticketFlow, { rounds: 3 })
  .suppliers(linearBugs, folderBugs, H.operator)
  .store(linearBugs)
  .wip(2);

const features = H.lane('features', Feature)
  .handler(ticketFlow, { rounds: 5 })
  .suppliers(linearFeatures, H.operator)
  .store(linearFeatures);

const epicFlow = H.flow('epic')
  .for(Epic)
  .does(async ctx => {
    if (ctx.unit.state === 'closing') {
      const children = await ctx.children();
      return children.every(child => child.state === 'merged') ? 'delivered' : 'dropped';
    }
    await ctx.move('planning');
    const plan = await ctx.run(planner, { title: ctx.unit.data.title, body: ctx.unit.data.body });
    if (plan.ok === false) return ctx.fail(plan.error);
    await ctx.spawn(
      features,
      plan.value.features.map(feature => ({ title: feature.title, body: feature.body, epic: ctx.unit.key }))
    );
    return ctx.wait('awaiting-features', { children: true, then: 'closing' });
  });

const epics = H.lane('epics', Epic).handler(epicFlow).suppliers(linearEpics).store(linearEpics).wip(1);

const heartbeatDownOpensBug = H.trigger(
  'heartbeat-down-opens-bug',
  H.on.enters(Heartbeat, 'down'),
  (event, act) =>
    act.create(
      bugs,
      {
        title: `Service ${event.unit.data.service} failed its heartbeat`,
        body: `Heartbeat ${event.unit.key} ended down at ${event.at.toISOString()}.`,
        severity: 'urgent',
      },
      `heartbeat-down-${event.unit.data.service}`
    )
);

const kindOrder = [Heartbeat.name, Bug.name, Feature.name, Epic.name];
const featureStarvationMs = 2 * 60 * 60 * 1000;

const rank = (unit: PendingView) => {
  if (unit.kind === Feature.name && unit.waitedMs > featureStarvationMs) return 1.5;
  const index = kindOrder.indexOf(unit.kind);
  return index === -1 ? kindOrder.length : index;
};

const teamScheduler = H.policy.scheduler('heartbeats-bugs-features-epics', view => ({
  start: view.pending.slice().sort((a, b) => rank(a) - rank(b) || b.waitedMs - a.waitedMs),
}));

const supervisor = claudeCode.supervisor({
  grants: [
    H.ops.readWork,
    H.ops.writeWork,
    H.ops.resolveHalts,
    H.ops.writeMemory,
    H.ops.readTelemetry,
    H.ops.readAccounts,
    H.ops.setShares,
    H.operation('production-health-probe', productionHealth),
  ],
});

export const codingTeam = H.harness('coding-team')
  .ledger(sqlite.ledger('coding-team.db'))
  .lanes(heartbeats, bugs, features, epics)
  .pools(claudePool)
  .triggers(heartbeatDownOpensBug)
  .scheduler(teamScheduler)
  .clients(supervisor)
  .observers(markdown.board('BOARD.md'), markdown.telemetry('TELEMETRY.md'));
