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

const queued = H.state('queued', 'pending');
const done = H.state('done', 'terminal', 'success');
const unfinished = H.state('unfinished', 'terminal', 'failure');
const wontDo = H.state('wont-do', 'terminal', 'neutral');
const planning = H.state('planning', 'pending');
const awaitingFeatures = H.state('awaiting-features', 'waiting');
const due = H.state('due', 'pending');
const healthy = H.state('healthy', 'terminal', 'success');
const down = H.state('down', 'terminal', 'failure');

const ticketData = z.object({ title: z.string(), description: z.string() });

const bug = H.kind('bug').data(ticketData).states(queued, done, unfinished, wontDo);
const feature = H.kind('feature')
  .data(ticketData.extend({ epic: z.string().optional() }))
  .states(queued, done, unfinished, wontDo);
const epic = H.kind('epic').data(ticketData).states(planning, awaitingFeatures, done, unfinished);
const heartbeat = H.kind('service-heartbeat').data(z.object({ service: z.string() })).states(due, healthy, down);

const builderRole = H.role('builder')
  .input(z.object({
    title: z.string(),
    description: z.string(),
    deficits: z.array(z.string()),
    ownerAnswer: z.string().optional(),
  }))
  .output(z.object({ summary: z.string(), question: z.string().optional() }))
  .prompt(brief => [
    `Build: ${brief.title}`,
    brief.description,
    brief.deficits.length > 0 ? `Resolve these deficits:\n${brief.deficits.join('\n')}` : '',
    brief.ownerAnswer ? `The owner decided: ${brief.ownerAnswer}` : '',
  ].join('\n\n'))
  .intents(['read', 'edit', 'execute']);

const auditorRole = H.role('auditor')
  .input(z.object({ title: z.string(), description: z.string(), summary: z.string() }))
  .output(z.object({ deficits: z.array(z.string()) }))
  .prompt(work => `Audit the change for "${work.title}".\n${work.description}\nBuilder summary: ${work.summary}\nList every deficit.`)
  .intents(['read', 'execute']);

const plannerRole = H.role('planner')
  .input(ticketData)
  .output(z.object({ features: z.array(ticketData) }))
  .prompt(work => `Decompose the epic "${work.title}" into features.\n${work.description}`)
  .intents(['read']);

const experience = H.memory('coding-experience', 'experience');
const taste = H.memory('owner-taste', 'taste');
const experienceJournal = H.library('experience-journal', experience, jsonl.memory('.harness/experience.jsonl'));
const tasteJournal = H.library('taste-journal', taste, jsonl.memory('.harness/taste.jsonl'));

const sonnet = claudeCode.model('claude-sonnet-4-5');
const opus = claudeCode.model('claude-opus-4-1');

const subscriptionA = claudeCode.subscription('claude-max-a', { token: H.env('CLAUDE_TOKEN_A') });
const subscriptionB = claudeCode.subscription('claude-max-b', { token: H.env('CLAUDE_TOKEN_B') });
const subscriptionC = claudeCode.subscription('claude-max-c', { token: H.env('CLAUDE_TOKEN_C') });
const apiAccount = anthropic.account('anthropic-api', { apiKey: H.env('ANTHROPIC_API_KEY') });

const soonestExpiringFirst = H.policy.account('soonest-expiring-first', choice => {
  const eligible = choice.accounts.filter(view => view.eligible && view.usedShare < view.share);
  const subscriptions = eligible
    .filter(view => view.account.plan === 'subscription')
    .sort((a, b) => (a.windowEndsAt?.getTime() ?? Infinity) - (b.windowEndsAt?.getTime() ?? Infinity));
  const chosen = subscriptions[0] ?? eligible.find(view => view.account.plan === 'metered');
  return chosen ? chosen.account : null;
});

const claudePool = H.pool('claude', [
  { account: subscriptionA, share: 0.6 },
  { account: subscriptionB, share: 0.6 },
  { account: subscriptionC, share: 0.4 },
  { account: apiAccount, share: 1 },
], soonestExpiringFirst);

const builderModel = H.policy.model('builder-model', [sonnet, opus], choice => {
  const cheap = choice.metrics.successRate({ kind: choice.kind, seat: choice.seat, model: sonnet, days: 14 });
  if (cheap.samples < 20) return sonnet;
  return cheap.value !== null && cheap.value < 0.85 ? opus : sonnet;
});

const worktrees = git.worktree('worktrees', { repo: '.', slots: 3 });
const localShell = shell.local('local', { slots: 2 });

const projectChecks = H.command('project-checks').argv(() => ['npm', 'run', 'check']).on(worktrees).recovery('rerun');
const serviceProbe = H.command('service-probe')
  .input(z.object({ service: z.string() }))
  .argv(probe => ['./scripts/probe', probe.service])
  .on(localShell)
  .recovery('rerun');
const productionHealthProbe = H.command('production-health-probe').argv(() => ['./scripts/production-health']).on(localShell);

const builder = H.seat('builder-agent', builderRole)
  .model(builderModel)
  .on(worktrees)
  .recalls(experienceJournal, tasteJournal)
  .guards(claudeCode.fileLeases(), claudeCode.stopCheck(projectChecks));
const auditor = H.seat('auditor-agent', auditorRole)
  .model(opus)
  .on(worktrees)
  .recalls(experienceJournal)
  .records(experienceJournal);
const planner = H.seat('planner-agent', plannerRole).model(opus).recalls(tasteJournal);

const ownerDecision = H.halt('owner-decision', z.object({ answer: z.string() }));

const buildAndAudit = H.flow('build-and-audit')
  .for(bug, feature)
  .params(z.object({ rounds: z.number().int() }))
  .does(async ctx => {
    const { title, description } = ctx.unit.data;
    let deficits: string[] = [];
    let ownerAnswer: string | undefined;
    for (let round = 0; round < ctx.params.rounds; round++) {
      const built = await ctx.run(builder, { title, description, deficits, ownerAnswer });
      if (!built.ok) return ctx.fail(built.error);
      if (built.value.question) {
        const decision = await ctx.halt(ownerDecision, built.value.question);
        ownerAnswer = decision.answer;
        continue;
      }
      const audit = await ctx.run(auditor, { title, description, summary: built.value.summary });
      if (!audit.ok) return ctx.fail(audit.error);
      if (audit.value.deficits.length === 0) return 'done';
      deficits = audit.value.deficits;
    }
    return ctx.fail(`deficits remain after ${ctx.params.rounds} rounds`);
  });

const checkService = H.flow('check-service').for(heartbeat).does(async ctx => {
  const probed = await ctx.run(serviceProbe, { service: ctx.unit.data.service });
  return probed.ok ? 'healthy' : 'down';
});

const linearKey = H.env('LINEAR_API_KEY');

const bugTracker = linear.tracker(bug, {
  apiKey: linearKey,
  team: 'PRODUCT',
  label: 'bug',
  read: issue => ({ title: issue.title, description: issue.description }),
  statuses: { queued: 'Todo', done: 'Done', unfinished: 'Blocked', 'wont-do': 'Canceled' },
});
const featureTracker = linear.tracker(feature, {
  apiKey: linearKey,
  team: 'PRODUCT',
  label: 'feature',
  read: issue => ({ title: issue.title, description: issue.description, epic: issue.parentId }),
  statuses: { queued: 'Todo', done: 'Done', unfinished: 'Blocked', 'wont-do': 'Canceled' },
});
const epicTracker = linear.tracker(epic, {
  apiKey: linearKey,
  team: 'PRODUCT',
  label: 'epic',
  read: issue => ({ title: issue.title, description: issue.description }),
  statuses: { planning: 'Todo', 'awaiting-features': 'In Progress', done: 'Done', unfinished: 'Blocked' },
});
const bugFolder = folder.files(bug, {
  dir: 'bugs',
  read: file => ({ title: String(file.frontmatter['title'] ?? file.path), description: file.body }),
});

const services = ['api', 'web', 'worker'];

const heartbeatClock = H.clock('heartbeat-clock', heartbeat, { every: { minutes: 5 } }, tick =>
  services.map(service => ({ create: { service }, key: `${service}-${tick.now.toISOString()}` })));

const retryBackoff = { first: { minutes: 10 }, factor: 2, max: { hours: 2 } };

const heartbeats = H.lane('heartbeats', heartbeat)
  .handler(checkService)
  .suppliers(heartbeatClock)
  .retries(0, { exhausted: 'down' });

const bugs = H.lane('bugs', bug)
  .handler(buildAndAudit, { rounds: 3 })
  .suppliers(bugTracker, bugFolder, H.operator)
  .store(bugTracker)
  .wip(2)
  .retries(1, { backoff: retryBackoff, exhausted: 'unfinished' });

const features = H.lane('features', feature)
  .handler(buildAndAudit, { rounds: 5 })
  .suppliers(featureTracker, H.operator)
  .store(featureTracker)
  .retries(1, { backoff: retryBackoff, exhausted: 'unfinished' });

const decomposeEpic = H.flow('decompose-epic').for(epic).does(async ctx => {
  const plan = await ctx.run(planner, { title: ctx.unit.data.title, description: ctx.unit.data.description });
  if (!plan.ok) return ctx.fail(plan.error);
  const children = await ctx.spawn(features, plan.value.features.map(work => ({ ...work, epic: ctx.unit.key })));
  const finished = await ctx.wait('awaiting-features', { children });
  return finished.every(child => child.state === 'done') ? 'done' : 'unfinished';
});

const epics = H.lane('epics', epic)
  .handler(decomposeEpic)
  .suppliers(epicTracker)
  .store(epicTracker)
  .wip(1)
  .retries(2, { backoff: retryBackoff, exhausted: 'unfinished' });

const failedHeartbeatFilesBug = H.trigger('failed-heartbeat-files-bug', H.on.enters(heartbeat, 'down'), (event, act) =>
  act.create(bugs, {
    title: `Service ${event.unit.data.service} failed its heartbeat`,
    description: `Heartbeat ${event.unit.key} failed at ${event.at.toISOString()}.`,
  }, `heartbeat-${event.unit.data.service}`));

const featureStarvationMs = 4 * 60 * 60 * 1000;

const teamPriority = H.policy.scheduler('team-priority', view => {
  const rank = (unit: PendingView): number => {
    if (unit.is(heartbeat)) return 0;
    if (unit.is(bug)) return 1;
    if (unit.is(feature)) return unit.waitedMs > featureStarvationMs ? 0.5 : 2;
    return 3;
  };
  return { start: [...view.pending].sort((a, b) => rank(a) - rank(b) || b.waitedMs - a.waitedMs) };
});

const supervisor = claudeCode.supervisor({
  grants: [
    H.ops.readWork,
    H.ops.writeWork,
    H.ops.resolveHalts,
    H.ops.readMemory,
    H.ops.writeMemory,
    H.ops.readTelemetry,
    H.ops.readAccounts,
    H.ops.setShares,
    H.operation('production-health', productionHealthProbe),
  ],
});

export const codingTeam = H.harness('coding-team')
  .ledger(sqlite.ledger('.harness/ledger.db'))
  .lanes(heartbeats, bugs, features, epics)
  .pools(claudePool)
  .triggers(failedHeartbeatFilesBug)
  .scheduler(teamPriority)
  .clients(supervisor)
  .observers(markdown.board('BOARD.md'), markdown.telemetry('TELEMETRY.md'));
