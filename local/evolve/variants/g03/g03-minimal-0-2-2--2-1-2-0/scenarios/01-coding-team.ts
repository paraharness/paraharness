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

const queued = H.state('queued', 'pending');
const done = H.state('done', 'terminal', 'success');
const stuck = H.state('stuck', 'terminal', 'failure');
const dropped = H.state('dropped', 'terminal', 'neutral');

const bug = H.kind('Bug')
  .data(z.object({ title: z.string(), description: z.string() }))
  .states(queued, done, stuck, dropped);

const feature = H.kind('Feature')
  .data(z.object({ title: z.string(), description: z.string(), epic: z.string().optional() }))
  .states(queued, done, stuck, dropped);

const epic = H.kind('Epic')
  .data(z.object({ title: z.string(), description: z.string() }))
  .states(
    H.state('proposed', 'pending'),
    H.state('decomposed', 'waiting'),
    H.state('delivered', 'terminal', 'success'),
    H.state('abandoned', 'terminal', 'failure')
  );

const heartbeat = H.kind('ServiceHeartbeat')
  .data(z.object({ service: z.string() }))
  .states(
    H.state('due', 'pending'),
    H.state('healthy', 'terminal', 'success'),
    H.state('unhealthy', 'terminal', 'failure')
  );

const builderRole = H.role('builder')
  .input(z.object({ title: z.string(), description: z.string(), deficits: z.array(z.string()), guidance: z.string() }))
  .output(z.object({ summary: z.string(), question: z.string().optional() }))
  .prompt(i => `Build: ${i.title}\n\n${i.description}\n\nOpen deficits:\n${i.deficits.join('\n')}\n\nOwner guidance: ${i.guidance}`)
  .intents(['read', 'edit', 'execute']);

const auditorRole = H.role('auditor')
  .input(z.object({ title: z.string(), description: z.string(), summary: z.string() }))
  .output(z.object({ deficits: z.array(z.string()) }))
  .prompt(i => `Audit the change for: ${i.title}\n\n${i.description}\n\nBuilder summary: ${i.summary}`)
  .intents(['read', 'execute']);

const plannerRole = H.role('planner')
  .input(z.object({ title: z.string(), description: z.string() }))
  .output(z.object({ features: z.array(z.object({ title: z.string(), description: z.string() })) }))
  .prompt(i => `Decompose this epic into features: ${i.title}\n\n${i.description}`)
  .intents(['read']);

const ownerDecision = H.halt('owner-decision', z.object({ guidance: z.string() }));

const sonnet = claude.model('claude-sonnet');
const opus = claude.model('claude-opus');

const builderModel = H.policy.model('builder-cheaper-until-it-slips', [sonnet, opus], choice => {
  const cheaper = choice.metrics.successRate({ kind: choice.kind, model: sonnet, days: 14 });
  if (cheaper.samples < 20) return sonnet;
  return (cheaper.value ?? 0) >= 0.85 ? sonnet : opus;
});

const subscriptionA = claude.subscription('claude-a', { token: H.env('CLAUDE_TOKEN_A') });
const subscriptionB = claude.subscription('claude-b', { token: H.env('CLAUDE_TOKEN_B') });
const subscriptionC = claude.subscription('claude-c', { token: H.env('CLAUDE_TOKEN_C') });
const apiAccount = anthropic.account('anthropic-api', { apiKey: H.env('ANTHROPIC_API_KEY') });

const soonestExpiringFirst = H.policy.account('soonest-expiring-then-api', choice => {
  const subscriptions = choice.accounts
    .filter(a => a.eligible && a.account.plan === 'subscription' && a.usedShare < a.share)
    .sort((a, b) => (a.windowEndsAt?.getTime() ?? Infinity) - (b.windowEndsAt?.getTime() ?? Infinity));
  const metered = choice.accounts.find(a => a.eligible && a.account.plan === 'metered');
  return subscriptions[0]?.account ?? metered?.account ?? null;
});

const claudePool = H.pool(
  'claude',
  [
    { account: subscriptionA, share: 0.6 },
    { account: subscriptionB, share: 0.5 },
    { account: subscriptionC, share: 0.4 },
    { account: apiAccount, share: 1 },
  ],
  soonestExpiringFirst
);

const specificFirst = H.policy.recall('specific-first', view => view.ranked.slice(0, 8));
const experience = H.journal('experience', H.memory('experience', 'experience'), jsonl.memory('memory/experience.jsonl'), specificFirst);
const taste = H.journal('taste', H.memory('taste', 'taste'), jsonl.memory('memory/taste.jsonl'), specificFirst);

const worktrees = git.worktree('worktrees', { repo: '.', slots: 3 });
const local = shell.local('local', { slots: 2 });

const projectChecks = H.command('project-checks').argv(() => ['npm', 'run', 'check']).on(worktrees);

const healthProbe = H.command('health-probe')
  .input(z.object({ service: z.string() }))
  .argv(i => ['./scripts/health-probe', i.service])
  .on(local);

const builder = H.seat('builder', builderRole)
  .model(builderModel)
  .on(worktrees)
  .recalls(experience, taste)
  .guards(claude.fileLeases(), claude.stopCheck(projectChecks));

const auditor = H.seat('auditor', auditorRole).model(sonnet).on(worktrees).recalls(experience).records(experience);

const planner = H.seat('planner', plannerRole).model(opus).recalls(taste);

const buildAndAudit = H.flow('build-and-audit')
  .for(bug, feature)
  .params(z.object({ rounds: z.number() }))
  .does(async ctx => {
    const { title, description } = ctx.unit.data;
    let deficits: string[] = [];
    let guidance = '';
    for (let round = 0; round < ctx.params.rounds; round += 1) {
      const built = await ctx.run(builder, { title, description, deficits, guidance });
      if (!built.ok) return ctx.fail(built);
      if (built.value.question !== undefined) {
        const answer = await ctx.halt(ownerDecision, built.value.question);
        guidance = answer.guidance;
      }
      const audited = await ctx.run(auditor, { title, description, summary: built.value.summary });
      if (!audited.ok) return ctx.fail(audited);
      if (audited.value.deficits.length === 0) return 'done';
      deficits = audited.value.deficits;
    }
    return 'stuck';
  });

const checkHeartbeat = H.flow('heartbeat').for(heartbeat).does(async ctx => {
  const probed = await ctx.run(healthProbe, { service: ctx.unit.data.service });
  return probed.ok ? 'healthy' : 'unhealthy';
});

const bugTracker = linear.tracker(bug, {
  apiKey: H.env('LINEAR_API_KEY'),
  team: 'PRODUCT',
  label: 'bug',
  read: issue => ({ title: issue.title, description: issue.description }),
  statuses: { queued: 'Todo', done: 'Done', stuck: 'Blocked', dropped: 'Canceled' },
});

const bugFolder = folder.files(bug, {
  dir: 'inbox/bugs',
  read: file => {
    const title = file.frontmatter['title'];
    return { title: typeof title === 'string' ? title : file.path, description: file.body };
  },
});

const featureTracker = linear.tracker(feature, {
  apiKey: H.env('LINEAR_API_KEY'),
  team: 'PRODUCT',
  label: 'feature',
  read: issue => ({ title: issue.title, description: issue.description, epic: issue.parentId }),
  statuses: { queued: 'Todo', done: 'Done', stuck: 'Blocked', dropped: 'Canceled' },
});

const epicTracker = linear.tracker(epic, {
  apiKey: H.env('LINEAR_API_KEY'),
  team: 'PRODUCT',
  label: 'epic',
  read: issue => ({ title: issue.title, description: issue.description }),
  statuses: { proposed: 'Todo', decomposed: 'In Progress', delivered: 'Done', abandoned: 'Canceled' },
});

const bugs = H.lane('bugs', bug)
  .handler(buildAndAudit, { rounds: 3 })
  .retries(2, 'stuck', { first: { minutes: 10 }, factor: 2 })
  .suppliers(bugTracker, bugFolder, H.operator)
  .store(bugTracker)
  .wip(2);

const features = H.lane('features', feature)
  .handler(buildAndAudit, { rounds: 5 })
  .retries(2, 'stuck', { first: { minutes: 10 }, factor: 2 })
  .suppliers(featureTracker, H.operator)
  .store(featureTracker);

const decompose = H.flow('decompose').for(epic).does(async ctx => {
  const plan = await ctx.run(planner, { title: ctx.unit.data.title, description: ctx.unit.data.description });
  if (!plan.ok) return ctx.fail(plan);
  const children = await ctx.spawn(
    features,
    plan.value.features.map(f => ({ title: f.title, description: f.description, epic: ctx.unit.key }))
  );
  const finished = await ctx.suspend('decomposed', { children });
  return finished.every(f => f.state === 'done') ? 'delivered' : 'abandoned';
});

const epics = H.lane('epics', epic)
  .handler(decompose)
  .retries(1, 'abandoned')
  .suppliers(epicTracker)
  .store(epicTracker)
  .wip(1);

const heartbeats = H.lane('heartbeats', heartbeat)
  .handler(checkHeartbeat)
  .retries(0, 'unhealthy')
  .suppliers(
    H.clock('every-five-minutes', heartbeat, { every: { minutes: 5 } }, tick =>
      ['api', 'web', 'worker'].map(service => tick.create({ service }))
    )
  );

const heartbeatFailureFilesBug = H.trigger('heartbeat-failure-files-bug', H.on.enters(heartbeat, 'unhealthy'), (event, act) =>
  act.create(bugs, {
    title: `Heartbeat failed: ${event.unit.data.service}`,
    description: `The ${event.unit.data.service} heartbeat failed at ${event.at.toISOString()}.`,
  })
);

const priority = (unit: PendingView): number => {
  if (unit.is(heartbeat)) return 0;
  if (unit.is(feature) && unit.waitedMs > 4 * 3_600_000) return 1;
  if (unit.is(bug)) return 2;
  if (unit.is(feature)) return 3;
  return 4;
};

const scheduler = H.policy.scheduler('heartbeats-bugs-features-epics', view => ({
  start: [...view.pending].sort((a, b) => priority(a) - priority(b)),
}));

const supervisor = claude.supervisor({
  grants: [
    H.ops.readWork,
    H.ops.writeWork,
    H.ops.resolve(ownerDecision),
    H.ops.writeMemory,
    H.ops.readTelemetry,
    H.ops.readAccounts,
    H.ops.setShares,
    H.operation('production-health-probe', healthProbe),
  ],
});

export const harness = H.harness('coding-team')
  .ledger(sqlite.ledger('.harness/ledger.db'))
  .lanes(heartbeats, bugs, features, epics)
  .pools(claudePool)
  .triggers(heartbeatFailureFilesBug)
  .scheduler(scheduler)
  .clients(supervisor)
  .observers(markdown.board('BOARD.md'), markdown.telemetry('TELEMETRY.md'));
