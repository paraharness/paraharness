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
const dropped = H.state('dropped', 'terminal', 'neutral');
const stuck = H.state('stuck', 'terminal', 'failure');
const decomposed = H.state('decomposed', 'waiting');
const abandoned = H.state('abandoned', 'terminal', 'failure');
const due = H.state('due', 'pending');
const healthy = H.state('healthy', 'terminal', 'success');
const unhealthy = H.state('unhealthy', 'terminal', 'failure');

const workItem = z.object({ title: z.string(), description: z.string() });

const bug = H.kind('bug').data(workItem).states(queued, done, dropped, stuck);
const feature = H.kind('feature')
  .data(workItem.extend({ epic: z.string().optional() }))
  .states(queued, done, dropped, stuck);
const epic = H.kind('epic').data(workItem).states(queued, decomposed, done, abandoned);
const heartbeat = H.kind('heartbeat').data(z.object({ service: z.string() })).states(due, healthy, unhealthy);

const worktree = git.worktree('worktree', { repo: '.', slots: 3 });
const local = shell.local('local', { slots: 2 });

const projectChecks = H.command('project-checks').argv(() => ['npm', 'run', 'check']).on(worktree);
const serviceProbe = H.command('service-probe')
  .input(z.object({ service: z.string() }))
  .argv(probe => ['curl', '-fsS', `https://${probe.service}.internal/health`])
  .on(local);
const productionProbe = H.command('production-probe')
  .argv(() => ['curl', '-fsS', 'https://app.example.com/health'])
  .on(local);

const sonnet = claudeCode.model('claude-sonnet-4-5');
const opus = claudeCode.model('claude-opus-4-1');

const maxOne = claudeCode.subscription('claude-max-1', { token: H.env('CLAUDE_MAX_1_TOKEN') });
const maxTwo = claudeCode.subscription('claude-max-2', { token: H.env('CLAUDE_MAX_2_TOKEN') });
const maxThree = claudeCode.subscription('claude-max-3', { token: H.env('CLAUDE_MAX_3_TOKEN') });
const metered = anthropic.account('anthropic-api', { apiKey: H.env('ANTHROPIC_API_KEY') });

const soonestExpiringFirst = H.policy.account('soonest-expiring-first', choice => {
  const open = choice.accounts.filter(view => view.eligible && view.usedShare < view.share);
  const subscriptions = open
    .filter(view => view.account.plan === 'subscription')
    .sort((a, b) => (a.windowEndsAt?.getTime() ?? Infinity) - (b.windowEndsAt?.getTime() ?? Infinity));
  const pick = subscriptions[0] ?? open.find(view => view.account.plan === 'metered');
  return pick ? pick.account : null;
});

const claude = H.pool(
  'claude',
  [
    { account: maxOne, share: 0.8 },
    { account: maxTwo, share: 0.6 },
    { account: maxThree, share: 0.5 },
    { account: metered, share: 1 },
  ],
  soonestExpiringFirst
);

const experience = H.memory('engineering-experience', 'experience');
const taste = H.memory('owner-taste', 'taste');
const lessons = H.library('engineering-lessons', experience, jsonl.memory('.harness/experience.jsonl'));
const preferences = H.library('owner-preferences', taste, jsonl.memory('.harness/taste.jsonl'));

const builderRole = H.role('builder')
  .input(z.object({ title: z.string(), description: z.string(), deficits: z.array(z.string()), guidance: z.string() }))
  .output(z.object({ summary: z.string(), question: z.string().optional() }))
  .prompt(task =>
    [
      `Implement: ${task.title}`,
      task.description,
      task.deficits.length > 0 ? `Fix these audit deficits:\n${task.deficits.join('\n')}` : '',
      task.guidance !== '' ? `Owner guidance: ${task.guidance}` : '',
      'If a product decision is needed from the owner, put it in "question" and stop.',
    ].join('\n\n')
  )
  .intents(['read', 'edit', 'execute']);

const auditorRole = H.role('auditor')
  .input(z.object({ title: z.string(), description: z.string(), summary: z.string() }))
  .output(z.object({ deficits: z.array(z.string()) }))
  .prompt(task => `Audit the change for "${task.title}".\n${task.description}\nBuilder summary: ${task.summary}\nList every remaining deficit.`)
  .intents(['read', 'execute']);

const plannerRole = H.role('planner')
  .input(z.object({ title: z.string(), description: z.string() }))
  .output(z.object({ features: z.array(workItem) }))
  .prompt(task => `Decompose the epic "${task.title}" into independently shippable features.\n${task.description}`)
  .intents(['read']);

const builderModel = H.policy.model('builder-model', [sonnet, opus], choice => {
  const cheaper = choice.metrics.successRate({ kind: choice.kind, seat: choice.seat, model: sonnet, days: 14 });
  return cheaper.samples >= 20 && cheaper.value !== null && cheaper.value < 0.85 ? opus : sonnet;
});

const builder = H.seat('builder', builderRole)
  .model(builderModel)
  .on(worktree)
  .recalls(lessons, preferences)
  .guards(claudeCode.fileLeases(), claudeCode.stopCheck(projectChecks));
const auditor = H.seat('auditor', auditorRole).model(opus).on(worktree).recalls(lessons).records(lessons);
const planner = H.seat('planner', plannerRole).model(opus).recalls(preferences);

const ownerDecision = H.halt('owner-decision', z.object({ proceed: z.boolean(), guidance: z.string() }))
  .about(z.object({ question: z.string() }));

const buildAndAudit = H.flow('build-and-audit')
  .for(bug, feature)
  .params(z.object({ rounds: z.number().int().positive() }))
  .does(async ctx => {
    const { title, description } = ctx.unit.data;
    let deficits: string[] = [];
    let guidance = '';
    for (let round = 0; round < ctx.params.rounds; round += 1) {
      const built = await ctx.run(builder, { title, description, deficits, guidance });
      if (!built.ok) return ctx.fail(built.error);
      if (built.value.question !== undefined) {
        const decision = await ctx.halt(ownerDecision, built.value.question, { question: built.value.question });
        if (!decision.proceed) return 'dropped';
        guidance = decision.guidance;
        continue;
      }
      const audit = await ctx.run(auditor, { title, description, summary: built.value.summary });
      if (!audit.ok) return ctx.fail(audit.error);
      if (audit.value.deficits.length === 0) return 'done';
      deficits = audit.value.deficits;
    }
    return ctx.fail('audit deficits remain after the last round');
  });

const heartbeatFlow = H.flow('heartbeat').for(heartbeat).does(async ctx => {
  const probed = await ctx.run(serviceProbe, { service: ctx.unit.data.service });
  return probed.ok ? 'healthy' : ctx.fail(probed.error);
});

const services = ['api', 'payments', 'search'];

const heartbeatSchedule = H.clock('heartbeat-schedule', heartbeat, { every: { minutes: 5 } }, tick =>
  services.map(service => ({ create: { service }, key: `${service}-${tick.now.toISOString()}` }))
);

const bugTracker = linear.tracker(bug, {
  apiKey: H.env('LINEAR_API_KEY'),
  team: 'PROD',
  label: 'bug',
  read: issue => ({ title: issue.title, description: issue.description }),
  statuses: { queued: 'Todo', done: 'Done', dropped: 'Canceled', stuck: 'Blocked' },
});
const featureTracker = linear.tracker(feature, {
  apiKey: H.env('LINEAR_API_KEY'),
  team: 'PROD',
  label: 'feature',
  read: issue => ({ title: issue.title, description: issue.description, epic: issue.parentId }),
  statuses: { queued: 'Todo', done: 'Done', dropped: 'Canceled', stuck: 'Blocked' },
});
const epicTracker = linear.tracker(epic, {
  apiKey: H.env('LINEAR_API_KEY'),
  team: 'PROD',
  label: 'epic',
  read: issue => ({ title: issue.title, description: issue.description }),
  statuses: { queued: 'Todo', decomposed: 'In Progress', done: 'Done', abandoned: 'Canceled' },
});
const bugFolder = folder.files(bug, {
  dir: 'bugs',
  read: file => ({
    title: typeof file.frontmatter.title === 'string' ? file.frontmatter.title : file.path,
    description: file.body,
  }),
});

const heartbeats = H.lane('heartbeats', heartbeat)
  .handler(heartbeatFlow, { retries: 0, exhausted: 'unhealthy' })
  .suppliers(heartbeatSchedule);

const bugs = H.lane('bugs', bug)
  .handler(buildAndAudit, { retries: 2, exhausted: 'stuck', params: { rounds: 3 } })
  .suppliers(bugTracker, bugFolder, H.operator)
  .store(bugTracker)
  .wip(2);

const features = H.lane('features', feature)
  .handler(buildAndAudit, { retries: 2, exhausted: 'stuck', params: { rounds: 5 } })
  .suppliers(featureTracker, H.operator)
  .store(featureTracker);

const planEpic = H.flow('plan-epic').for(epic).does(async ctx => {
  const plan = await ctx.run(planner, { title: ctx.unit.data.title, description: ctx.unit.data.description });
  if (!plan.ok) return ctx.fail(plan.error);
  const children = await ctx.spawn(
    features,
    plan.value.features.map(item => ({ title: item.title, description: item.description, epic: ctx.unit.key }))
  );
  const finished = await ctx.suspend('decomposed', { children });
  return finished.every(child => child.state === 'done') ? 'done' : 'abandoned';
});

const epics = H.lane('epics', epic)
  .handler(planEpic, { retries: 1, exhausted: 'abandoned' })
  .suppliers(epicTracker)
  .store(epicTracker)
  .wip(1);

const heartbeatFailureFilesBug = H.trigger(
  'heartbeat-failure-files-bug',
  H.on.enters(heartbeat, 'unhealthy'),
  (event, act) =>
    act.create(
      bugs,
      {
        title: `Heartbeat failing: ${event.unit.data.service}`,
        description: `The ${event.unit.data.service} health probe failed at ${event.at.toISOString()}.`,
      },
      `heartbeat-${event.unit.data.service}`
    )
);

const featureStarvationMs = 2 * 60 * 60 * 1000;

const rank = (unit: PendingView): number => {
  if (unit.is(heartbeat)) return 0;
  if (unit.is(bug)) return 1;
  if (unit.is(feature)) return unit.waitedMs > featureStarvationMs ? 1 : 2;
  return 3;
};

const priority = H.policy.scheduler('heartbeats-bugs-features-epics', view => ({
  start: [...view.pending].sort((a, b) => rank(a) - rank(b) || b.waitedMs - a.waitedMs),
}));

const supervisor = claudeCode.supervisor({
  grants: [
    H.ops.readWork,
    H.ops.writeWork,
    H.ops.resolve(ownerDecision, H.halts.interrupted, H.halts.definitionChanged, H.halts.costCeiling),
    H.ops.writeMemory,
    H.ops.readTelemetry,
    H.ops.readAccounts,
    H.ops.setShares,
    H.operation('production-health-probe', productionProbe),
  ],
});

export const codingTeam = H.harness('coding-team')
  .ledger(sqlite.ledger('.harness/ledger.db'))
  .lanes(heartbeats, bugs, features, epics)
  .pools(claude)
  .triggers(heartbeatFailureFilesBug)
  .scheduler(priority)
  .clients(supervisor)
  .observers(markdown.board('BOARD.md'), markdown.telemetry('TELEMETRY.md'));
