import { z } from 'zod';
import { H, type PendingView } from 'harness-dsl';
import * as cc from 'harness-dsl/claude-code';
import * as anthropic from 'harness-dsl/anthropic';
import * as linear from 'harness-dsl/linear';
import * as folder from 'harness-dsl/folder';
import * as sqlite from 'harness-dsl/sqlite';
import * as jsonl from 'harness-dsl/jsonl';
import * as git from 'harness-dsl/git';
import * as shell from 'harness-dsl/shell';
import * as markdown from 'harness-dsl/markdown';

const Queued = H.state('queued', 'pending');
const Building = H.state('building', 'active');
const Auditing = H.state('auditing', 'active');
const Done = H.state('done', 'terminal', 'success');
const Abandoned = H.state('abandoned', 'terminal', 'failure');
const Planning = H.state('planning', 'active');
const Assembling = H.state('assembling', 'waiting');
const Integrating = H.state('integrating', 'pending');
const Due = H.state('due', 'pending');
const Checking = H.state('checking', 'active');
const Healthy = H.state('healthy', 'terminal', 'success');
const Unhealthy = H.state('unhealthy', 'terminal', 'failure');

const ticket = z.object({ title: z.string(), description: z.string() });

const Bug = H.kind('bug').data(ticket).states(Queued, Building, Auditing, Done, Abandoned);
const Feature = H.kind('feature').data(ticket).states(Queued, Building, Auditing, Done, Abandoned);
const Epic = H.kind('epic').data(ticket).states(Queued, Planning, Assembling, Integrating, Done, Abandoned);
const Heartbeat = H.kind('service-heartbeat')
  .data(z.object({ service: z.string(), url: z.string() }))
  .states(Due, Checking, Healthy, Unhealthy);

const builderRole = H.role('builder')
  .input(z.object({
    title: z.string(),
    description: z.string(),
    deficits: z.array(z.string()),
    guidance: z.array(z.string()),
  }))
  .output(z.object({ summary: z.string(), question: z.string().optional() }))
  .prompt(i => `Implement "${i.title}".\n\n${i.description}\n\nOpen deficits:\n${i.deficits.join('\n')}\n\nOwner guidance:\n${i.guidance.join('\n')}`)
  .intents(['read', 'edit', 'execute']);

const auditorRole = H.role('auditor')
  .input(z.object({ title: z.string(), description: z.string(), summary: z.string() }))
  .output(z.object({ deficits: z.array(z.string()) }))
  .prompt(i => `Audit the change for "${i.title}" against:\n${i.description}\n\nBuilder summary:\n${i.summary}`)
  .intents(['read', 'execute']);

const plannerRole = H.role('planner')
  .input(ticket)
  .output(z.object({ features: z.array(ticket) }))
  .prompt(i => `Decompose the epic "${i.title}" into features.\n\n${i.description}`)
  .intents(['read']);

const experience = H.memory('experience', 'experience');
const taste = H.memory('taste', 'taste');
const experienceLibrary = H.library('team-experience', experience, jsonl.memory('memory/experience.jsonl'));
const tasteLibrary = H.library('owner-taste', taste, jsonl.memory('memory/taste.jsonl'));

const worktrees = git.worktree('worktrees', { repo: '.', slots: 3 });
const local = shell.local('local', { slots: 4 });

const projectChecks = H.command('project-checks')
  .argv(() => ['npm', 'run', 'check'])
  .on(worktrees)
  .recovery('rerun');

const healthProbe = H.command('health-probe')
  .input(z.object({ url: z.string() }))
  .argv(i => ['curl', '--fail', '--silent', i.url])
  .on(local)
  .recovery('rerun');

const productionHealth = H.command('production-health')
  .argv(() => ['curl', '--fail', '--silent', 'https://app.example.com/health'])
  .on(local)
  .recovery('rerun');

const sonnet = cc.model('claude-sonnet-4-5');
const opus = cc.model('claude-opus-4-1');

const builderModel = H.policy.model('cheaper-until-it-slips', choice => {
  const cheaper = choice.metrics.successRate({ kind: choice.kind, model: sonnet.name, days: 14 });
  const slipped = cheaper.samples >= 20 && cheaper.value !== null && cheaper.value < 0.85;
  return slipped ? opus : sonnet;
});

const soonestExpiringFirst = H.policy.account('soonest-expiring-first', choice => {
  const subscriptions = choice.accounts
    .filter(a => a.eligible && a.account.plan === 'subscription' && a.usedShare < a.share)
    .sort((a, b) => (a.windowEndsAt?.getTime() ?? Number.POSITIVE_INFINITY) - (b.windowEndsAt?.getTime() ?? Number.POSITIVE_INFINITY));
  const metered = choice.accounts.find(a => a.eligible && a.account.plan === 'metered');
  return subscriptions[0]?.account ?? metered?.account ?? null;
});

const claude = H.pool('claude', [
  { account: cc.subscription('claude-max-a', { token: H.env('CLAUDE_TOKEN_A') }), share: 0.5 },
  { account: cc.subscription('claude-max-b', { token: H.env('CLAUDE_TOKEN_B') }), share: 0.3 },
  { account: cc.subscription('claude-max-c', { token: H.env('CLAUDE_TOKEN_C') }), share: 0.2 },
  { account: anthropic.account('anthropic-api', { apiKey: H.env('ANTHROPIC_API_KEY') }), share: 1 },
], soonestExpiringFirst);

const builder = H.agent('builder', builderRole)
  .model(builderModel)
  .on(worktrees)
  .recalls(experienceLibrary, tasteLibrary)
  .guards(cc.fileLeases(), cc.stopCheck(projectChecks));

const auditor = H.agent('auditor', auditorRole)
  .model(opus)
  .on(worktrees)
  .recalls(experienceLibrary)
  .records(experienceLibrary);

const planner = H.agent('planner', plannerRole)
  .model(opus)
  .recalls(tasteLibrary);

const ticketFlow = H.flow('build-and-audit')
  .for(Bug, Feature)
  .params(z.object({ rounds: z.number().int().positive() }))
  .does(async ctx => {
    const { title, description } = ctx.unit.data;
    const guidance: string[] = [];
    let deficits: string[] = [];
    for (let round = 1; round <= ctx.params.rounds; round += 1) {
      await ctx.move('building');
      const built = await ctx.run(builder, { title, description, deficits, guidance });
      if (!built.ok) return ctx.fail(built.error);
      const question = built.value.question;
      if (question !== undefined) {
        const decision = await ctx.halt({
          name: 'owner-decision',
          show: question,
          decision: z.object({ answer: z.string() }),
        });
        guidance.push(`${question}: ${decision.answer}`);
        continue;
      }
      await ctx.move('auditing');
      const audit = await ctx.run(auditor, { title, description, summary: built.value.summary });
      if (!audit.ok) return ctx.fail(audit.error);
      if (audit.value.deficits.length === 0) return 'done';
      deficits = audit.value.deficits;
    }
    return 'abandoned';
  });

const heartbeatFlow = H.flow('heartbeat').for(Heartbeat).does(async ctx => {
  await ctx.move('checking');
  const probe = await ctx.run(healthProbe, { url: ctx.unit.data.url });
  return probe.ok ? 'healthy' : 'unhealthy';
});

const bugTracker = linear.tracker(Bug, {
  apiKey: H.env('LINEAR_API_KEY'),
  team: 'PROD',
  label: 'bug',
  read: issue => ({ title: issue.title, description: issue.description }),
  statuses: { queued: 'Todo', building: 'In Progress', auditing: 'In Review', done: 'Done', abandoned: 'Canceled' },
});

const featureTracker = linear.tracker(Feature, {
  apiKey: H.env('LINEAR_API_KEY'),
  team: 'PROD',
  label: 'feature',
  read: issue => ({ title: issue.title, description: issue.description }),
  statuses: { queued: 'Todo', building: 'In Progress', auditing: 'In Review', done: 'Done', abandoned: 'Canceled' },
});

const epicTracker = linear.tracker(Epic, {
  apiKey: H.env('LINEAR_API_KEY'),
  team: 'PROD',
  label: 'epic',
  read: issue => ({ title: issue.title, description: issue.description }),
  statuses: {
    queued: 'Todo',
    planning: 'In Progress',
    assembling: 'In Progress',
    integrating: 'In Review',
    done: 'Done',
    abandoned: 'Canceled',
  },
});

const bugFiles = folder.files(Bug, {
  dir: 'bugs',
  read: file => ({ title: String(file.frontmatter.title ?? file.path), description: file.body }),
});

const bugs = H.lane('bugs', Bug)
  .handler(ticketFlow, { rounds: 3 })
  .suppliers(bugTracker, bugFiles, H.operator)
  .store(bugTracker)
  .wip(2);

const features = H.lane('features', Feature)
  .handler(ticketFlow, { rounds: 5 })
  .suppliers(featureTracker, H.operator)
  .store(featureTracker);

const epicFlow = H.flow('decompose-epic').for(Epic).does(async ctx => {
  if (ctx.unit.state === 'integrating') {
    const children = await ctx.children();
    return children.every(child => child.state === 'done') ? 'done' : 'abandoned';
  }
  await ctx.move('planning');
  const plan = await ctx.run(planner, { title: ctx.unit.data.title, description: ctx.unit.data.description });
  if (!plan.ok) return ctx.fail(plan.error);
  await ctx.spawn(features, plan.value.features);
  return ctx.until('assembling', { children: true, then: 'integrating' });
});

const epics = H.lane('epics', Epic)
  .handler(epicFlow)
  .suppliers(epicTracker)
  .store(epicTracker)
  .wip(1);

const services = [
  { service: 'api', url: 'https://api.example.com/health' },
  { service: 'web', url: 'https://www.example.com/health' },
];

const heartbeatClock = H.clock('heartbeat-clock', Heartbeat, { every: { minutes: 5 } }, () =>
  services.map(s => ({ create: s, key: `heartbeat-${s.service}` })));

const heartbeats = H.lane('heartbeats', Heartbeat)
  .handler(heartbeatFlow)
  .suppliers(heartbeatClock);

const failedHeartbeatFilesBug = H.trigger(
  'failed-heartbeat-files-bug',
  H.on.enters(Heartbeat, 'unhealthy'),
  (event, act) => act.create(bugs, {
    title: `Service ${event.unit.data.service} failed its heartbeat`,
    description: `The health probe of ${event.unit.data.url} failed at ${event.at.toISOString()}.`,
  }, `heartbeat-failure-${event.unit.data.service}`),
);

const featureStarvationMs = 4 * 60 * 60 * 1000;

const priority = (unit: PendingView): number => {
  if (unit.lane === heartbeats.name) return 0;
  if (unit.lane === features.name && unit.waitedMs > featureStarvationMs) return 1;
  if (unit.lane === bugs.name) return 2;
  if (unit.lane === features.name) return 3;
  return 4;
};

const scheduler = H.policy.scheduler('heartbeats-bugs-features-epics', view => ({
  start: [...view.pending].sort((a, b) => priority(a) - priority(b) || b.waitedMs - a.waitedMs),
}));

export const harness = H.harness('coding-team')
  .ledger(sqlite.ledger('.harness/ledger.db'))
  .lanes(heartbeats, bugs, features, epics)
  .pools(claude)
  .triggers(failedHeartbeatFilesBug)
  .scheduler(scheduler)
  .clients(cc.supervisor({
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
  }))
  .observers(markdown.board('BOARD.md'), markdown.telemetry('TELEMETRY.md'));
