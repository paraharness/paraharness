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

const areas = H.resources('areas', ['payments', 'auth', 'api', 'web']);

const ticketData = z.object({
  title: z.string(),
  description: z.string(),
  areas: z.array(areas.schema),
});
const featureData = ticketData.extend({ epic: z.string().optional() });

const ticketLifecycle = H.lifecycle({
  todo: 'pending',
  'in-progress': 'active',
  done: 'success',
  stuck: 'failure',
  cancelled: 'neutral',
});

const Bug = H.kind('Bug').data(ticketData).states(ticketLifecycle, 'todo');
const Feature = H.kind('Feature').data(featureData).states(ticketLifecycle, 'todo');
const Epic = H.kind('Epic')
  .data(ticketData)
  .states({ open: 'pending', planning: 'active', building: 'waiting', done: 'success', dropped: 'failure' }, 'open');
const ServiceHeartbeat = H.kind('ServiceHeartbeat')
  .data(z.object({ service: z.string() }))
  .states({ due: 'pending', probing: 'active', healthy: 'success', down: 'failure' }, 'due');

const experience = H.memory('experience', 'fallible');
const taste = H.memory('taste', 'owner');

const bySpecificityAndRecord = H.policy.recall('specific-and-proven', view =>
  [...view.items]
    .sort((a, b) => b.specificity - a.specificity || (b.trackRecord.value ?? 0) - (a.trackRecord.value ?? 0))
    .slice(0, 12)
);

const experienceLibrary = H.library('experience', experience, jsonl.memory('memory/experience.jsonl')).recall(bySpecificityAndRecord);
const tasteLibrary = H.library('taste', taste, jsonl.memory('memory/taste.jsonl')).recall(bySpecificityAndRecord);

const quota = sqlite.quota('../shared/quota.sqlite');
const subscriptionA = claudeCode.subscription('claude-a', { token: H.env('CLAUDE_TOKEN_A'), quota });
const subscriptionB = claudeCode.subscription('claude-b', { token: H.env('CLAUDE_TOKEN_B'), quota });
const subscriptionC = claudeCode.subscription('claude-c', { token: H.env('CLAUDE_TOKEN_C'), quota });
const apiAccount = anthropic.account('anthropic-api', { apiKey: H.env('ANTHROPIC_API_KEY'), quota });

const soonestExpiringFirst = H.policy.account('soonest-expiring-then-api', choice => {
  const subscriptions = choice.accounts
    .filter(view => view.eligible && view.account.plan === 'subscription' && view.usedShare < view.share)
    .sort((a, b) => (a.windowEndsAt?.getTime() ?? Infinity) - (b.windowEndsAt?.getTime() ?? Infinity));
  const first = subscriptions[0];
  if (first) return first.account;
  const metered = choice.accounts.find(view => view.eligible && view.account.plan === 'metered');
  return metered ? metered.account : null;
});

const claudePool = H.pool(
  'claude',
  [
    { account: subscriptionA, share: 0.8 },
    { account: subscriptionB, share: 0.6 },
    { account: subscriptionC, share: 0.5 },
    { account: apiAccount, share: 1 },
  ],
  soonestExpiringFirst
);

const cheapModel = claudeCode.model('claude-sonnet-4-5');
const strongModel = claudeCode.model('claude-opus-4-1');

const cheapUntilWeak = H.policy.model('cheap-until-weak', choice => {
  const rate = choice.metrics.successRate({ kind: choice.kind, model: cheapModel.name, days: 14 });
  const enoughSamples = rate.samples >= 20;
  const weak = typeof rate.value === 'number' && rate.value < 0.85;
  return enoughSamples && weak ? strongModel : cheapModel;
});

const local = shell.local('local', { slots: 4 });
const worktrees = git.worktree('worktrees', { repo: '.', slots: 3 });

const projectChecks = H.command('project-checks').argv(() => ['npm', 'run', 'check']);

const builderRole = H.role('builder')
  .input(z.object({
    title: z.string(),
    description: z.string(),
    deficits: z.array(z.string()),
    ownerNotes: z.array(z.string()),
  }))
  .output(z.object({ summary: z.string(), question: z.string().optional() }))
  .prompt(input => [
    `Implement: ${input.title}`,
    input.description,
    input.deficits.length > 0 ? `Fix these deficits first:\n- ${input.deficits.join('\n- ')}` : '',
    input.ownerNotes.length > 0 ? `Owner decisions:\n- ${input.ownerNotes.join('\n- ')}` : '',
    'If a decision only the owner can make blocks you, put it in `question` and stop.',
  ].join('\n\n'))
  .intents(['read', 'edit', 'execute']);

const auditorRole = H.role('auditor')
  .input(z.object({ title: z.string(), description: z.string(), summary: z.string() }))
  .output(z.object({ deficits: z.array(z.string()) }))
  .prompt(input => `Audit the work for "${input.title}".\n\n${input.description}\n\nBuilder summary:\n${input.summary}\n\nList every remaining deficit; an empty list means done.`)
  .intents(['read', 'execute']);

const plannerRole = H.role('planner')
  .input(z.object({ title: z.string(), description: z.string() }))
  .output(z.object({ features: z.array(z.object({ title: z.string(), description: z.string() })) }))
  .prompt(input => `Decompose the epic "${input.title}" into independently shippable features.\n\n${input.description}`);

const builder = H.agent('builder', builderRole)
  .model(cheapUntilWeak)
  .on(worktrees)
  .guards(claudeCode.fileLeases(), claudeCode.stopCheck(projectChecks))
  .recalls(experienceLibrary, tasteLibrary);

const auditor = H.agent('auditor', auditorRole)
  .model(strongModel)
  .on(worktrees)
  .recalls(experienceLibrary)
  .records(experienceLibrary);

const planner = H.agent('planner', plannerRole).model(strongModel).recalls(tasteLibrary);

const ownerDecision = z.object({ answer: z.string() });

const buildAndAudit = H.flow('build-and-audit')
  .for(Bug, Feature)
  .params(z.object({ rounds: z.number().int() }))
  .does(async ctx => {
    await ctx.move('in-progress');
    let deficits: readonly string[] = [];
    const ownerNotes: string[] = [];
    for (let round = 1; round <= ctx.params.rounds; round++) {
      const built = await ctx.run(builder, {
        title: ctx.unit.data.title,
        description: ctx.unit.data.description,
        deficits: [...deficits],
        ownerNotes: [...ownerNotes],
      });
      if (built.ok === false) return ctx.fail(built.error);
      const question = built.value.question;
      if (typeof question === 'string') {
        const decision = await ctx.halt({ name: 'owner-decision', show: question, decision: ownerDecision });
        ownerNotes.push(`${question} → ${decision.answer}`);
        continue;
      }
      const audited = await ctx.run(auditor, {
        title: ctx.unit.data.title,
        description: ctx.unit.data.description,
        summary: built.value.summary,
      });
      if (audited.ok === false) return ctx.fail(audited.error);
      deficits = audited.value.deficits;
      if (deficits.length === 0) return 'done';
    }
    return 'stuck';
  });

const bugTracker = linear.tracker(Bug, {
  apiKey: H.env('LINEAR_API_KEY'),
  team: 'ENG',
  label: 'bug',
  read: issue => ({
    title: issue.title,
    description: issue.description,
    areas: areas.ids.filter(area => issue.labels.includes(area)),
  }),
  statuses: { todo: 'Todo', 'in-progress': 'In Progress', done: 'Done', stuck: 'Blocked', cancelled: 'Canceled' },
});

const featureTracker = linear.tracker(Feature, {
  apiKey: H.env('LINEAR_API_KEY'),
  team: 'ENG',
  label: 'feature',
  read: issue => ({
    title: issue.title,
    description: issue.description,
    areas: areas.ids.filter(area => issue.labels.includes(area)),
    epic: issue.parentId,
  }),
  statuses: { todo: 'Todo', 'in-progress': 'In Progress', done: 'Done', stuck: 'Blocked', cancelled: 'Canceled' },
});

const epicTracker = linear.tracker(Epic, {
  apiKey: H.env('LINEAR_API_KEY'),
  team: 'ENG',
  label: 'epic',
  read: issue => ({
    title: issue.title,
    description: issue.description,
    areas: areas.ids.filter(area => issue.labels.includes(area)),
  }),
  statuses: { open: 'Backlog', planning: 'In Progress', building: 'In Progress', done: 'Done', dropped: 'Canceled' },
});

const bugFolder = folder.files(Bug, {
  dir: 'bugs',
  read: file => ({
    title: String(file.frontmatter['title'] ?? file.path),
    description: file.body,
    areas: areas.ids.filter(area => file.body.includes(area)),
  }),
});

const bugs = H.lane('bugs', Bug)
  .handler(buildAndAudit, { rounds: 3 })
  .suppliers(bugTracker, bugFolder, H.operator)
  .store(bugTracker)
  .wip(2)
  .touches(data => data.areas.map(area => areas.of(area)));

const features = H.lane('features', Feature)
  .handler(buildAndAudit, { rounds: 5 })
  .suppliers(featureTracker, H.operator)
  .store(featureTracker)
  .touches(data => data.areas.map(area => areas.of(area)));

const decomposeEpic = H.flow('decompose-epic')
  .for(Epic)
  .does(async ctx => {
    const children = await ctx.children();
    if (children.length > 0) {
      return children.every(child => child.verdict === 'success') ? 'done' : 'dropped';
    }
    await ctx.move('planning');
    const plan = await ctx.run(planner, { title: ctx.unit.data.title, description: ctx.unit.data.description });
    if (plan.ok === false) return ctx.fail(plan.error);
    await ctx.spawn(features, plan.value.features.map(feature => ({
      title: feature.title,
      description: feature.description,
      areas: ctx.unit.data.areas,
      epic: ctx.unit.key,
    })));
    return ctx.until('building', { children: true, then: 'open' });
  });

const epics = H.lane('epics', Epic)
  .handler(decomposeEpic)
  .suppliers(epicTracker)
  .store(epicTracker)
  .wip(1)
  .touches(data => data.areas.map(area => areas.of(area)));

const probeService = H.command('probe-service')
  .input(z.object({ service: z.string() }))
  .argv(input => ['curl', '-fsS', `https://${input.service}.internal.example.com/health`])
  .on(local)
  .restart('rerun');

const heartbeatFlow = H.flow('heartbeat')
  .for(ServiceHeartbeat)
  .does(async ctx => {
    await ctx.move('probing');
    const probed = await ctx.run(probeService, { service: ctx.unit.data.service });
    return probed.ok ? 'healthy' : 'down';
  });

const services = ['api', 'web', 'worker'];

const heartbeatSchedule = H.recurring('every-five-minutes', ServiceHeartbeat, { every: { minutes: 5 } }, tick =>
  services.map(service => ({ create: { service }, key: `${service}-${tick.now.toISOString()}` }))
);

const heartbeats = H.lane('heartbeats', ServiceHeartbeat)
  .handler(heartbeatFlow)
  .suppliers(heartbeatSchedule);

const outageBecomesBug = H.trigger('outage-becomes-bug', H.on.enters(ServiceHeartbeat, 'down'), (event, act) =>
  act.create(
    bugs,
    {
      title: `Service ${event.unit.data.service} failed its heartbeat`,
      description: `The heartbeat at ${event.at.toISOString()} for ${event.unit.data.service} did not pass.`,
      areas: [],
    },
    { dedupe: `outage-${event.unit.data.service}` }
  )
);

const starvationMs = 6 * 60 * 60 * 1000;

const codingPriority = H.policy.scheduler('heartbeats-bugs-features-epics', view => {
  const rank = (unit: PendingView): number => {
    if (unit.kind === ServiceHeartbeat.name) return 0;
    if (unit.kind === Feature.name && unit.waitedMs > starvationMs) return 1;
    if (unit.kind === Bug.name) return 2;
    if (unit.kind === Feature.name) return 3;
    return 4;
  };
  return { start: [...view.pending].sort((a, b) => rank(a) - rank(b) || b.waitedMs - a.waitedMs) };
});

const productionHealth = H.command('production-health')
  .argv(() => ['curl', '-fsS', 'https://api.example.com/health'])
  .on(local);

const supervisor = claudeCode.supervisor({
  grants: [
    H.ops.readWork,
    H.ops.writeWork,
    H.ops.resolveHalts,
    H.ops.writeMemory,
    H.ops.readTelemetry,
    H.ops.readAccounts,
    H.ops.setShares,
    H.operation('production-health', productionHealth),
  ],
});

export default H.harness('coding-team')
  .ledger(sqlite.ledger('.harness/ledger.sqlite'))
  .lanes(heartbeats, bugs, features, epics)
  .pools(claudePool)
  .triggers(outageBecomesBug)
  .scheduler(codingPriority)
  .clients(supervisor)
  .observers(markdown.board('BOARD.md'), markdown.telemetry('TELEMETRY.md'));
