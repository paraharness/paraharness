import { H, type PendingView } from 'harness-dsl';
import * as claudeCode from 'harness-dsl/claude-code';
import * as anthropic from 'harness-dsl/anthropic';
import * as linear from 'harness-dsl/linear';
import * as folder from 'harness-dsl/folder';
import * as sqlite from 'harness-dsl/sqlite';
import * as jsonl from 'harness-dsl/jsonl';
import * as git from 'harness-dsl/git';
import * as shell from 'harness-dsl/shell';
import * as markdown from 'harness-dsl/markdown';
import { z } from 'zod';

const todo = H.state('todo', 'pending');
const done = H.state('done', 'terminal', 'success');
const stuck = H.state('stuck', 'terminal', 'failure');
const proposed = H.state('proposed', 'pending');
const decomposed = H.state('decomposed', 'waiting');
const incomplete = H.state('incomplete', 'terminal', 'failure');
const due = H.state('due', 'pending');
const healthy = H.state('healthy', 'terminal', 'success');
const unhealthy = H.state('unhealthy', 'terminal', 'failure');

const bug = H.kind('bug')
  .data(z.object({ title: z.string(), description: z.string() }))
  .states(todo, done, stuck);
const feature = H.kind('feature')
  .data(z.object({ title: z.string(), description: z.string(), epic: z.string().optional() }))
  .states(todo, done, stuck);
const epic = H.kind('epic')
  .data(z.object({ title: z.string(), description: z.string() }))
  .states(proposed, decomposed, done, incomplete);
const heartbeat = H.kind('service-heartbeat')
  .data(z.object({ service: z.string() }))
  .states(due, healthy, unhealthy);

const buildRole = H.role('builder')
  .input(z.object({ title: z.string(), description: z.string(), deficits: z.array(z.string()), guidance: z.string() }))
  .output(z.object({ summary: z.string(), question: z.string().optional() }))
  .prompt((i) => `Build: ${i.title}\n\n${i.description}\n\nOpen deficits:\n${i.deficits.join('\n')}\n\nOwner guidance: ${i.guidance}`)
  .intents(['read', 'edit', 'execute']);
const auditRole = H.role('auditor')
  .input(z.object({ title: z.string(), description: z.string(), summary: z.string() }))
  .output(z.object({ deficits: z.array(z.string()) }))
  .prompt((i) => `Audit the change for "${i.title}".\n\n${i.description}\n\nBuilder summary: ${i.summary}\nList every deficit.`)
  .intents(['read', 'execute']);
const planRole = H.role('planner')
  .input(z.object({ title: z.string(), description: z.string() }))
  .output(z.object({ features: z.array(z.object({ title: z.string(), description: z.string() })) }))
  .prompt((i) => `Decompose the epic "${i.title}" into features.\n\n${i.description}`)
  .intents(['read']);

const experience = H.journal('team-experience', H.memory('experience', 'experience'), jsonl.memory('memory/experience.jsonl'));
const taste = H.journal('owner-taste', H.memory('taste', 'taste'), jsonl.memory('memory/taste.jsonl'));

const cheap = claudeCode.model('claude-sonnet-4-5');
const strong = claudeCode.model('claude-opus-4-1');

const builderModel = H.policy.model('builder-model', (choice) => {
  const record = choice.metrics.successRate({ kind: choice.kind, model: cheap, days: 14 });
  return record.samples >= 20 && record.value !== null && record.value < 0.85 ? strong : cheap;
});

const worktrees = git.worktree('worktrees', { repo: '.', slots: 4 });
const local = shell.local('local', { slots: 4 });

const projectChecks = H.command('project-checks').argv(() => ['npm', 'run', 'check']).on(worktrees);

const builder = H.seat('builder', buildRole)
  .model(builderModel)
  .on(worktrees)
  .recalls(experience, taste)
  .guards(claudeCode.fileLeases(), claudeCode.stopCheck(projectChecks));
const auditor = H.seat('auditor', auditRole).model(strong).on(worktrees).recalls(experience).records(experience);
const planner = H.seat('planner', planRole).model(strong).recalls(taste);

const ownerDecision = H.halt('owner-decision', z.object({ answer: z.string() }))
  .about(z.object({ question: z.string(), round: z.number() }));

const buildAndAudit = H.flow('build-and-audit')
  .for(bug, feature)
  .params(z.object({ rounds: z.number() }))
  .does(async (ctx) => {
    const { title, description } = ctx.unit.data;
    let deficits: string[] = [];
    let guidance = '';
    for (let round = 1; round <= ctx.params.rounds; round += 1) {
      const built = await ctx.run(builder, { title, description, deficits, guidance });
      if (!built.ok) return ctx.fail(built.error);
      const question = built.value.question;
      if (question !== undefined) {
        const decision = await ctx.halt(ownerDecision, question, { question, round });
        guidance = decision.answer;
        continue;
      }
      const audit = await ctx.run(auditor, { title, description, summary: built.value.summary });
      if (!audit.ok) return ctx.fail(audit.error);
      if (audit.value.deficits.length === 0) return 'done';
      deficits = audit.value.deficits;
    }
    return ctx.fail(`deficits remain after ${ctx.params.rounds} rounds: ${deficits.join('; ')}`);
  });

const bugTracker = linear.tracker(bug, {
  apiKey: H.env('LINEAR_API_KEY'),
  team: 'product',
  label: 'bug',
  read: (issue) => ({ title: issue.title, description: issue.description }),
  statuses: { todo: 'Todo', done: 'Done', stuck: 'Blocked' },
});
const featureTracker = linear.tracker(feature, {
  apiKey: H.env('LINEAR_API_KEY'),
  team: 'product',
  label: 'feature',
  read: (issue) => ({ title: issue.title, description: issue.description, epic: issue.parentId }),
  statuses: { todo: 'Todo', done: 'Done', stuck: 'Blocked' },
});
const epicTracker = linear.tracker(epic, {
  apiKey: H.env('LINEAR_API_KEY'),
  team: 'product',
  label: 'epic',
  read: (issue) => ({ title: issue.title, description: issue.description }),
  statuses: { proposed: 'Backlog', decomposed: 'In Progress', done: 'Done', incomplete: 'Canceled' },
});
const bugFolder = folder.files(bug, {
  dir: 'bugs',
  read: (file) => ({ title: String(file.frontmatter['title'] ?? file.path), description: file.body }),
});

const bugs = H.lane('bugs', bug)
  .handler(buildAndAudit, { rounds: 3 })
  .suppliers(bugTracker, bugFolder, H.operator)
  .store(bugTracker)
  .wip(2)
  .retry(H.retry({ times: 1 }), 'stuck');
const features = H.lane('features', feature)
  .handler(buildAndAudit, { rounds: 5 })
  .suppliers(featureTracker, H.operator)
  .store(featureTracker)
  .retry(H.retry({ times: 1 }), 'stuck');

const decompose = H.flow('decompose-epic')
  .for(epic)
  .does(async (ctx) => {
    const plan = await ctx.run(planner, { title: ctx.unit.data.title, description: ctx.unit.data.description });
    if (!plan.ok) return ctx.fail(plan.error);
    const children = await ctx.spawn(
      features,
      plan.value.features.map((f) => ({ title: f.title, description: f.description, epic: ctx.unit.key }))
    );
    const finished = await ctx.wait('decomposed', { children });
    return finished.every((f) => f.state === 'done') ? 'done' : 'incomplete';
  });

const epics = H.lane('epics', epic)
  .handler(decompose)
  .suppliers(epicTracker)
  .store(epicTracker)
  .wip(1)
  .retry(H.retry({ times: 1 }), 'incomplete');

const probeService = H.command('probe-service')
  .input(z.object({ service: z.string() }))
  .argv((i) => ['curl', '-fsS', `https://${i.service}.internal/health`])
  .on(local);

const checkHeartbeat = H.flow('check-heartbeat')
  .for(heartbeat)
  .does(async (ctx) => {
    const probe = await ctx.run(probeService, { service: ctx.unit.data.service });
    return probe.ok ? 'healthy' : 'unhealthy';
  });

const heartbeats = H.lane('heartbeats', heartbeat)
  .handler(checkHeartbeat)
  .suppliers(
    H.clock('every-five-minutes', heartbeat, { every: { minutes: 5 } }, (tick) => [
      { create: { service: 'api' }, key: `api-${tick.now.toISOString()}` },
    ])
  );

const heartbeatFailureFilesBug = H.trigger(
  'heartbeat-failure-files-bug',
  H.on.enters(heartbeat, 'unhealthy'),
  (event, act) =>
    act.create(bugs, {
      title: `Service ${event.unit.data.service} failed its heartbeat`,
      description: `Heartbeat ${event.unit.key} ended unhealthy at ${event.at.toISOString()}.`,
    })
);

const maxOne = claudeCode.subscription('max-1', { token: H.env('CLAUDE_TOKEN_1') });
const maxTwo = claudeCode.subscription('max-2', { token: H.env('CLAUDE_TOKEN_2') });
const maxThree = claudeCode.subscription('max-3', { token: H.env('CLAUDE_TOKEN_3') });
const api = anthropic.account('api', { apiKey: H.env('ANTHROPIC_API_KEY') });

const soonestExpiring = H.policy.account('soonest-expiring-then-api', (choice) => {
  const subscriptions = choice.accounts
    .filter((a) => a.eligible && a.account.plan === 'subscription' && a.usedShare < a.share)
    .sort((a, b) => (a.windowEndsAt?.getTime() ?? Infinity) - (b.windowEndsAt?.getTime() ?? Infinity));
  const first = subscriptions[0];
  if (first) return first.account;
  const metered = choice.accounts.find((a) => a.eligible && a.account.plan === 'metered');
  return metered ? metered.account : null;
});

const claudePool = H.pool(
  'claude',
  [
    { account: maxOne, share: 0.6 },
    { account: maxTwo, share: 0.5 },
    { account: maxThree, share: 0.4 },
    { account: api, share: 1 },
  ],
  soonestExpiring
);

const priority = [heartbeat.name, bug.name, feature.name, epic.name];
const featureStarvationMs = 7200000;
const rank = (unit: PendingView) =>
  unit.kind === feature.name && unit.waitedMs > featureStarvationMs ? 0.5 : priority.indexOf(unit.kind);

const teamScheduler = H.policy.scheduler('heartbeats-bugs-features-epics', (view) => ({
  start: [...view.pending].sort((a, b) => rank(a) - rank(b) || b.waitedMs - a.waitedMs),
}));

const workHealth = H.report('work-health', (metrics) => ({
  'heartbeat success (24h)': metrics.successRate({ kind: heartbeat, hours: 24 }),
  'bug success (14d)': metrics.successRate({ kind: bug, days: 14 }),
  'feature success (14d)': metrics.successRate({ kind: feature, days: 14 }),
  'epic success (30d)': metrics.successRate({ kind: epic, days: 30 }),
  'builder success on cheap model (14d)': metrics.successRate({ kind: bug, seat: builder, model: cheap, days: 14 }),
}));

const productionHealth = H.command('production-health')
  .argv(() => ['curl', '-fsS', 'https://app.example.com/health'])
  .on(local);

export default H.harness('coding-team')
  .ledger(sqlite.ledger('harness/ledger.db'))
  .lanes(heartbeats, bugs, features, epics)
  .pools(claudePool)
  .triggers(heartbeatFailureFilesBug)
  .scheduler(teamScheduler)
  .reports(workHealth)
  .clients(
    claudeCode.supervisor({
      grants: [
        H.ops.readWork,
        H.ops.writeWork,
        H.ops.resolve(ownerDecision),
        H.ops.readMemory,
        H.ops.writeMemory,
        H.ops.readTelemetry,
        H.ops.readAccounts,
        H.ops.setShares,
        H.operation('production-health-probe', productionHealth),
      ],
    })
  )
  .observers(markdown.board('BOARD.md'), markdown.telemetry('TELEMETRY.md'));
