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

const ticket = z.object({ title: z.string(), description: z.string(), epic: z.string().optional() });

const open = H.state('open', 'pending');
const done = H.state('done', 'terminal', 'success');
const declined = H.state('declined', 'terminal', 'neutral');
const stuck = H.state('stuck', 'terminal', 'failure');

export const bug = H.kind('bug').data(ticket).states(open, done, declined, stuck);
export const feature = H.kind('feature').data(ticket).states(open, done, declined, stuck);

const proposed = H.state('proposed', 'pending');
const decomposed = H.state('decomposed', 'waiting');
const incomplete = H.state('incomplete', 'terminal', 'failure');
export const epic = H.kind('epic')
  .data(z.object({ title: z.string(), description: z.string() }))
  .states(proposed, decomposed, done, incomplete);

const due = H.state('due', 'pending');
const up = H.state('up', 'terminal', 'success');
const down = H.state('down', 'terminal', 'failure');
export const heartbeat = H.kind('service-heartbeat').data(z.object({ service: z.string() })).states(due, up, down);

export const experience = H.memory('experience', 'experience');
export const taste = H.memory('taste', 'taste');
const experienceJournal = H.journal('coding-experience', experience, jsonl.memory('memory/coding-experience.jsonl'));
export const tasteJournal = H.journal('owner-taste', taste, jsonl.memory('memory/owner-taste.jsonl'));

const buildRole = H.role('build')
  .input(z.object({ title: z.string(), description: z.string(), deficits: z.array(z.string()), guidance: z.string() }))
  .output(z.object({ summary: z.string(), question: z.string().optional() }))
  .prompt(input => `Implement "${input.title}".\n\n${input.description}\n\nOpen deficits:\n${input.deficits.join('\n')}\n\nOwner guidance: ${input.guidance}`)
  .intents(['read', 'edit', 'execute']);

const auditRole = H.role('audit')
  .input(z.object({ title: z.string(), description: z.string(), summary: z.string() }))
  .output(z.object({ deficits: z.array(z.string()) }))
  .prompt(input => `Audit the change for "${input.title}" against:\n${input.description}\n\nBuilder summary: ${input.summary}\n\nList every deficit.`)
  .intents(['read', 'execute']);

const planRole = H.role('plan')
  .input(z.object({ title: z.string(), description: z.string() }))
  .output(z.object({ features: z.array(z.object({ title: z.string(), description: z.string() })) }))
  .prompt(input => `Decompose the epic "${input.title}" into features.\n\n${input.description}`)
  .intents(['read']);

const sonnet = claudeCode.model('claude-sonnet-4-5');
const opus = claudeCode.model('claude-opus-4-1');

export const claudeQuota = sqlite.quota('~/.harness/claude-quota.db');
export const max1 = claudeCode.subscription('claude-max-1', { token: H.env('CLAUDE_MAX_1_TOKEN'), quota: claudeQuota });
export const max2 = claudeCode.subscription('claude-max-2', { token: H.env('CLAUDE_MAX_2_TOKEN'), quota: claudeQuota });
export const max3 = claudeCode.subscription('claude-max-3', { token: H.env('CLAUDE_MAX_3_TOKEN'), quota: claudeQuota });
const apiAccount = anthropic.account('anthropic-api', { apiKey: H.env('ANTHROPIC_API_KEY') });

const soonestExpiringFirst = H.policy.account('soonest-expiring-first', choice => {
  const usable = choice.accounts.filter(view => view.eligible && view.usedShare < view.share);
  const subscriptions = usable
    .filter(view => view.account.plan === 'subscription')
    .sort((a, b) => (a.windowEndsAt?.getTime() ?? Number.MAX_SAFE_INTEGER) - (b.windowEndsAt?.getTime() ?? Number.MAX_SAFE_INTEGER));
  const chosen = subscriptions.find(view => view.eligible) ?? usable.find(view => view.account.plan === 'metered');
  return chosen ? chosen.account : null;
});

export const claudePool = H.pool(
  'claude',
  [
    { account: max1, share: 0.6 },
    { account: max2, share: 0.6 },
    { account: max3, share: 0.6 },
    { account: apiAccount, share: 1 },
  ],
  soonestExpiringFirst
);

const builderModel = H.policy.model('cheaper-until-success-drops', choice => {
  const cheap = choice.metrics.successRate({ kind: choice.kind, model: sonnet, days: 14 });
  if (cheap.samples < 20 || cheap.value === null) return sonnet;
  return cheap.value >= 0.85 ? sonnet : opus;
});

const worktree = git.worktree('worktree', { repo: '.', slots: 3 });
const local = shell.local('local', { slots: 2 });

const projectChecks = H.command('project-checks').argv(() => ['npm', 'run', 'check']).on(worktree);

const builder = H.seat('builder', buildRole)
  .model(builderModel)
  .on(worktree)
  .recalls(experienceJournal, tasteJournal)
  .guards(claudeCode.fileLeases(), claudeCode.stopCheck(projectChecks));

const auditor = H.seat('auditor', auditRole).model(opus).on(worktree).recalls(experienceJournal).records(experienceJournal);

const planner = H.seat('planner', planRole).model(opus).recalls(tasteJournal);

const ownerDecision = H.halt('owner-decision', z.object({ proceed: z.boolean(), guidance: z.string() }));

const delivery = H.flow('delivery')
  .for(bug, feature)
  .params(z.object({ rounds: z.number().int().positive() }))
  .does(async ctx => {
    const { title, description } = ctx.unit.data;
    let deficits: string[] = [];
    let guidance = '';
    for (let round = 1; round <= ctx.params.rounds; round += 1) {
      const built = await ctx.call(builder, { title, description, deficits, guidance });
      if (!built.ok) return ctx.fail(built.error);
      if (built.value.question !== undefined) {
        const decision = await ctx.halt(ownerDecision, built.value.question);
        if (!decision.proceed) return 'declined';
        guidance = decision.guidance;
        continue;
      }
      const audited = await ctx.call(auditor, { title, description, summary: built.value.summary });
      if (!audited.ok) return ctx.fail(audited.error);
      if (audited.value.deficits.length === 0) return 'done';
      deficits = audited.value.deficits;
    }
    return 'stuck';
  });

const linearKey = H.env('LINEAR_API_KEY');
const ticketStatuses = { open: 'Todo', done: 'Done', declined: 'Canceled', stuck: 'Blocked' };

const bugTracker = linear.tracker(bug, {
  apiKey: linearKey,
  team: 'PRODUCT',
  label: 'bug',
  read: issue => ({ title: issue.title, description: issue.description }),
  statuses: ticketStatuses,
});

const bugFolder = folder.files(bug, {
  dir: 'bugs',
  read: file => ({ title: String(file.frontmatter.title ?? file.path), description: file.body }),
});

const featureTracker = linear.tracker(feature, {
  apiKey: linearKey,
  team: 'PRODUCT',
  label: 'feature',
  read: issue => ({ title: issue.title, description: issue.description, epic: issue.parentId }),
  statuses: ticketStatuses,
});

const epicTracker = linear.tracker(epic, {
  apiKey: linearKey,
  team: 'PRODUCT',
  label: 'epic',
  read: issue => ({ title: issue.title, description: issue.description }),
  statuses: { proposed: 'Backlog', decomposed: 'In Progress', done: 'Done', incomplete: 'Blocked' },
});

const twoMoreTries = H.retry('two-more-tries', { retries: 2, backoff: { initialMs: 120_000, factor: 2 } });

export const bugs = H.lane('bugs', bug)
  .handler(delivery, { rounds: 3 })
  .suppliers(bugTracker, bugFolder, H.operator)
  .store(bugTracker)
  .wip(2)
  .retry(twoMoreTries, 'stuck');

export const features = H.lane('features', feature)
  .handler(delivery, { rounds: 5 })
  .suppliers(featureTracker, H.operator)
  .store(featureTracker)
  .retry(twoMoreTries, 'stuck');

const decomposition = H.flow('decomposition')
  .for(epic)
  .does(async ctx => {
    const planned = await ctx.call(planner, { title: ctx.unit.data.title, description: ctx.unit.data.description });
    if (!planned.ok) return ctx.fail(planned.error);
    const children = await ctx.spawn(
      features,
      planned.value.features.map(planned => ({ title: planned.title, description: planned.description, epic: ctx.unit.key }))
    );
    const finished = await ctx.wait('decomposed', { children });
    return finished.every(child => child.state === 'done') ? 'done' : 'incomplete';
  });

export const epics = H.lane('epics', epic)
  .handler(decomposition)
  .suppliers(epicTracker)
  .store(epicTracker)
  .wip(1)
  .retry(twoMoreTries, 'incomplete');

const services = ['api', 'web', 'worker'];

const probeService = H.command('probe-service')
  .input(z.object({ service: z.string() }))
  .argv(input => ['curl', '-fsS', `https://${input.service}.internal/health`])
  .on(local);

const heartbeatCheck = H.flow('heartbeat-check')
  .for(heartbeat)
  .does(async ctx => {
    const probe = await ctx.call(probeService, { service: ctx.unit.data.service });
    return probe.ok ? 'up' : 'down';
  });

export const heartbeats = H.lane('heartbeats', heartbeat)
  .handler(heartbeatCheck)
  .suppliers(
    H.clock('every-five-minutes', heartbeat, { every: { minutes: 5 } }, tick =>
      services.map(service => ({ create: { service }, key: `${service}-${tick.now.toISOString()}` }))
    )
  );

const heartbeatFailureFilesBug = H.trigger('heartbeat-failure-files-bug', H.on.enters(heartbeat, 'down'), (event, act) =>
  act.create(bugs, {
    title: `Service ${event.unit.data.service} failed its heartbeat`,
    description: `Heartbeat ${event.unit.key} failed at ${event.at.toISOString()}.`,
  })
);

const laneOrder = [heartbeats.name, bugs.name, features.name, epics.name];
const featureStarvationMs = 2 * 60 * 60 * 1000;

const heartbeatsBugsFeaturesEpics = H.policy.scheduler('heartbeats-bugs-features-epics', view => {
  const rank = (unit: PendingView): number =>
    unit.lane === features.name && unit.waitedMs > featureStarvationMs ? 0.5 : laneOrder.indexOf(unit.lane);
  return { start: [...view.pending].sort((a, b) => rank(a) - rank(b) || b.waitedMs - a.waitedMs) };
});

const productionHealthProbe = H.command('production-health-probe')
  .argv(() => ['curl', '-fsS', 'https://api.example.com/health'])
  .on(local);

const supervisor = claudeCode.supervisor({
  grants: [
    H.ops.readWork,
    H.ops.writeWork,
    H.ops.resolve(ownerDecision, H.parked),
    H.ops.readMemory,
    H.ops.writeMemory,
    H.ops.readTelemetry,
    H.ops.readAccounts,
    H.ops.setShares,
    H.operation('production-health', productionHealthProbe),
  ],
});

export const codingTeam = H.harness('coding-team')
  .ledger(sqlite.ledger('coding-team.db'))
  .lanes(heartbeats, bugs, features, epics)
  .pools(claudePool)
  .triggers(heartbeatFailureFilesBug)
  .scheduler(heartbeatsBugsFeaturesEpics)
  .clients(supervisor)
  .observers(markdown.board('BOARD.md'), markdown.telemetry('TELEMETRY.md'));
