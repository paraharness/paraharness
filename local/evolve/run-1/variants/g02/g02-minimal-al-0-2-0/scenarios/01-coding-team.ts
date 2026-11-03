import { H, type PendingView, type AccountView } from 'harness-dsl';
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

export const open = H.state('open', 'pending');
export const building = H.state('building', 'active');
export const done = H.state('done', 'terminal', 'success');
export const abandoned = H.state('abandoned', 'terminal', 'failure');

export const proposed = H.state('proposed', 'pending');
export const decomposed = H.state('decomposed', 'waiting');
export const integrating = H.state('integrating', 'pending');
export const delivered = H.state('delivered', 'terminal', 'success');

export const due = H.state('due', 'pending');
export const healthy = H.state('healthy', 'terminal', 'success');
export const unhealthy = H.state('unhealthy', 'terminal', 'failure');

export const ticketData = z.object({
  title: z.string(),
  description: z.string(),
});

export const Bug = H.kind('Bug').data(ticketData).states(open, building, done, abandoned).failsTo('abandoned');
export const Feature = H.kind('Feature').data(ticketData).states(open, building, done, abandoned).failsTo('abandoned');
export const Epic = H.kind('Epic').data(ticketData).states(proposed, decomposed, integrating, delivered);
export const ServiceHeartbeat = H.kind('ServiceHeartbeat')
  .data(z.object({ service: z.string() }))
  .states(due, healthy, unhealthy);

export const builderRole = H.role('builder')
  .input(z.object({
    title: z.string(),
    description: z.string(),
    deficits: z.array(z.string()),
    ownerNote: z.string().optional(),
  }))
  .output(z.object({ summary: z.string(), question: z.string().optional() }))
  .prompt((input) => [
    `Build: ${input.title}`,
    input.description,
    input.deficits.length === 0 ? '' : `Resolve these deficits:\n${input.deficits.join('\n')}`,
    input.ownerNote === undefined ? '' : `Owner decided: ${input.ownerNote}`,
  ].join('\n\n'))
  .intents(['read', 'edit', 'execute']);

export const auditorRole = H.role('auditor')
  .input(z.object({ title: z.string(), description: z.string(), summary: z.string() }))
  .output(z.object({ deficits: z.array(z.string()) }))
  .prompt((input) => `Audit the change for "${input.title}".\n${input.description}\nBuilder summary: ${input.summary}\nList every deficit that remains.`)
  .intents(['read', 'execute']);

export const plannerRole = H.role('planner')
  .input(z.object({ title: z.string(), description: z.string() }))
  .output(z.object({ features: z.array(ticketData) }))
  .prompt((input) => `Decompose the epic "${input.title}" into features.\n${input.description}`)
  .intents(['read']);

export const experience = H.memory('coding-experience', 'experience');
export const taste = H.memory('owner-taste', 'taste');
export const experienceArchive = H.archive('coding-experience', experience, jsonl.memory('.harness/experience.jsonl'));
export const tasteArchive = H.archive('owner-taste', taste, jsonl.memory('.harness/taste.jsonl'));
export const builderBriefing = H.briefing('builder-briefing', [experienceArchive, tasteArchive]);
export const auditorBriefing = H.briefing('auditor-briefing', [experienceArchive]);
export const plannerBriefing = H.briefing('planner-briefing', [tasteArchive]);

export const subscriptionA = cc.subscription('claude-subscription-a', { token: H.env('CLAUDE_TOKEN_A') });
export const subscriptionB = cc.subscription('claude-subscription-b', { token: H.env('CLAUDE_TOKEN_B') });
export const subscriptionC = cc.subscription('claude-subscription-c', { token: H.env('CLAUDE_TOKEN_C') });
export const apiAccount = anthropic.account('anthropic-api', { apiKey: H.env('ANTHROPIC_API_KEY') });

const windowEnd = (view: AccountView): number => view.windowEndsAt === undefined ? Number.POSITIVE_INFINITY : view.windowEndsAt.getTime();

export const soonestExpiringFirst = H.policy.account('soonest-expiring-first', (choice) => {
  const subscriptions = choice.accounts
    .filter((view) => view.eligible && view.account.plan === 'subscription' && view.usedShare < view.share)
    .sort((a, b) => windowEnd(a) - windowEnd(b));
  const first = subscriptions[0];
  if (first) return first.account;
  const metered = choice.accounts.find((view) => view.eligible && view.account.plan === 'metered');
  return metered ? metered.account : null;
});

export const claudePool = H.pool('claude', [
  { account: subscriptionA, share: 0.5 },
  { account: subscriptionB, share: 0.5 },
  { account: subscriptionC, share: 0.3 },
  { account: apiAccount, share: 1 },
], soonestExpiringFirst);

export const sonnet = cc.model('claude-sonnet');
export const opus = cc.model('claude-opus');

export const cheaperUntilItSlips = H.policy.model('cheaper-until-it-slips', (choice) => {
  const record = choice.metrics.successRate({ kind: choice.kind, model: sonnet, days: 14 });
  if (record.samples < 20 || record.value === null) return sonnet;
  return record.value < 0.85 ? opus : sonnet;
});

export const worktrees = git.worktree('builder-worktrees', { repo: '.', slots: 3 });
export const local = shell.local('local', { slots: 4 });

export const projectChecks = H.command('project-checks')
  .argv(() => ['npm', 'run', 'check'])
  .on(worktrees)
  .recovers('rerun');

export const builder = H.agent('builder', builderRole)
  .model(cheaperUntilItSlips)
  .on(worktrees)
  .recalls(builderBriefing)
  .guards(cc.fileLeases(), cc.stopCheck(projectChecks));

export const auditor = H.agent('auditor', auditorRole)
  .model(opus)
  .on(worktrees)
  .recalls(auditorBriefing)
  .records(experienceArchive);

export const planner = H.agent('planner', plannerRole)
  .model(opus)
  .recalls(plannerBriefing);

export const ownerDecision = H.halt('owner-decision', z.object({ abandon: z.boolean(), note: z.string() }));

export const ticketFlow = H.flow('build-and-audit')
  .for(Bug, Feature)
  .params(z.object({ rounds: z.number().int() }))
  .does(async (ctx) => {
    await ctx.move('building');
    const { title, description } = ctx.unit.data;
    let deficits: string[] = [];
    let ownerNote: string | undefined;
    for (let round = 1; round <= ctx.params.rounds; round += 1) {
      const built = await ctx.run(builder, { title, description, deficits, ownerNote });
      if (built.ok === false) return ctx.fail(built.error);
      if (built.value.question) {
        const answer = await ctx.halt(ownerDecision, built.value.question);
        if (answer.abandon) return 'abandoned';
        ownerNote = answer.note;
      }
      const audit = await ctx.run(auditor, { title, description, summary: built.value.summary });
      if (audit.ok === false) return ctx.fail(audit.error);
      if (audit.value.deficits.length === 0) return 'done';
      deficits = audit.value.deficits;
    }
    return 'abandoned';
  });

export const ticketRetry = H.policy.retry('three-tries-then-abandon', (view) =>
  view.failures < 3 ? { retryInMs: 60_000 * 2 ** view.failures } : 'stop');

export const featureLaneHandle = H.lane('features', Feature);

export const linearBugs = linear.tracker(Bug, {
  apiKey: H.env('LINEAR_API_KEY'),
  team: 'PRODUCT',
  label: 'bug',
  read: (issue) => ({ title: issue.title, description: issue.description }),
  statuses: { open: 'Todo', building: 'In Progress', done: 'Done', abandoned: 'Canceled' },
});

export const linearFeatures = linear.tracker(Feature, {
  apiKey: H.env('LINEAR_API_KEY'),
  team: 'PRODUCT',
  label: 'feature',
  read: (issue) => ({ title: issue.title, description: issue.description }),
  statuses: { open: 'Todo', building: 'In Progress', done: 'Done', abandoned: 'Canceled' },
});

export const linearEpics = linear.tracker(Epic, {
  apiKey: H.env('LINEAR_API_KEY'),
  team: 'PRODUCT',
  label: 'epic',
  read: (issue) => ({ title: issue.title, description: issue.description }),
  statuses: { proposed: 'Backlog', decomposed: 'In Progress', integrating: 'In Review', delivered: 'Done' },
});

export const bugFolder = folder.files(Bug, {
  dir: 'bugs',
  read: (file) => ({
    title: String(file.frontmatter['title'] ?? file.path),
    description: file.body,
  }),
});

export const bugLane = H.lane('bugs', Bug)
  .handler(ticketFlow, { rounds: 3 })
  .suppliers(linearBugs, bugFolder, H.operator)
  .store(linearBugs)
  .wip(2)
  .retry(ticketRetry);

export const featureLane = featureLaneHandle
  .handler(ticketFlow, { rounds: 5 })
  .suppliers(linearFeatures, H.operator)
  .store(linearFeatures)
  .retry(ticketRetry);

export const epicFlow = H.flow('decompose-epic')
  .for(Epic)
  .does(async (ctx) => {
    const plan = await ctx.run(planner, { title: ctx.unit.data.title, description: ctx.unit.data.description });
    if (plan.ok === false) return ctx.fail(plan.error);
    await ctx.spawn(featureLane, plan.value.features);
    return ctx.wait('decomposed', { children: true, then: 'integrating' });
  })
  .phase('integrating', async () => 'delivered');

export const epicLane = H.lane('epics', Epic)
  .handler(epicFlow)
  .suppliers(linearEpics)
  .store(linearEpics)
  .wip(1);

export const services = ['api', 'worker', 'web'] as const;

export const healthCheck = H.command('service-health')
  .input(z.object({ service: z.string() }))
  .argv((input) => ['curl', '-fsS', `https://${input.service}.internal/health`])
  .on(local)
  .recovers('rerun');

export const heartbeatFlow = H.flow('heartbeat-check')
  .for(ServiceHeartbeat)
  .does(async (ctx) => {
    const checked = await ctx.run(healthCheck, { service: ctx.unit.data.service });
    return checked.ok ? 'healthy' : 'unhealthy';
  });

export const heartbeatClock = H.clock('every-five-minutes', ServiceHeartbeat, { every: { minutes: 5 } }, (tick) =>
  services.map((service) => ({ create: { service }, key: `${service}@${tick.now.toISOString()}` })));

export const heartbeatLane = H.lane('heartbeats', ServiceHeartbeat)
  .handler(heartbeatFlow)
  .suppliers(heartbeatClock);

export const heartbeatFailureFilesBug = H.trigger(
  'heartbeat-failure-files-bug',
  H.on.enters(ServiceHeartbeat, 'unhealthy'),
  (event, act) => act.create(
    bugLane,
    {
      title: `Service ${event.unit.data.service} failed its heartbeat`,
      description: `The heartbeat at ${event.at.toISOString()} reported ${event.unit.data.service} unhealthy.`,
    },
    `heartbeat-${event.unit.data.service}`,
  ),
);

const featureStarvationMs = 4 * 60 * 60 * 1000;

export const codingOrder = H.policy.scheduler('heartbeats-bugs-features-epics', (view) => {
  const rank = (unit: PendingView): number => {
    if (unit.is(ServiceHeartbeat)) return 0;
    if (unit.is(Bug)) return 1;
    if (unit.is(Feature)) return unit.waitedMs > featureStarvationMs ? 1 : 2;
    return 3;
  };
  return { start: [...view.pending].sort((a, b) => rank(a) - rank(b) || b.waitedMs - a.waitedMs) };
});

export const productionProbe = H.command('production-health-probe')
  .argv(() => ['./scripts/probe-production.sh'])
  .on(local)
  .recovers('rerun');

export const supervisor = cc.supervisor({
  grants: [
    H.ops.readWork,
    H.ops.writeWork,
    H.ops.resolveHalts,
    H.ops.writeMemory,
    H.ops.readTelemetry,
    H.ops.readAccounts,
    H.ops.setShares,
    H.operation('production-health', productionProbe),
  ],
});

export const codingTeam = H.harness('coding-team')
  .ledger(sqlite.ledger('.harness/ledger.db'))
  .lanes(heartbeatLane, bugLane, featureLane, epicLane)
  .pools(claudePool)
  .triggers(heartbeatFailureFilesBug)
  .scheduler(codingOrder)
  .clients(supervisor)
  .observers(markdown.board('BOARD.md'), markdown.telemetry('TELEMETRY.md'));
