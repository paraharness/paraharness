import { z } from 'zod';
import { H } from 'harness-dsl';
import type { AccountView, PendingView } from 'harness-dsl';
import { sqlite } from 'harness-dsl/sqlite';
import { jsonl } from 'harness-dsl/jsonl';
import { claudeCode } from 'harness-dsl/claude-code';
import { linear } from 'harness-dsl/linear';
import { folder } from 'harness-dsl/folder';
import { git } from 'harness-dsl/git';
import { shell } from 'harness-dsl/shell';
import { markdown } from 'harness-dsl/markdown';

const Todo = H.state('todo', 'runnable');
const Done = H.state('done', 'succeeded');
const Abandoned = H.state('abandoned', 'failed');
const Cancelled = H.state('cancelled', 'cancelled');
const Planning = H.state('planning', 'runnable');
const Delivering = H.state('delivering', 'waiting');
const Reviewing = H.state('reviewing', 'runnable');
const Due = H.state('due', 'runnable');
const Healthy = H.state('healthy', 'succeeded');
const Unhealthy = H.state('unhealthy', 'failed');

const ticketData = z.object({
  id: z.string(),
  title: z.string(),
  description: z.string(),
  areas: z.array(z.string()),
});
const featureData = ticketData.extend({ epicId: z.string().nullable() });
const epicData = z.object({ id: z.string(), title: z.string(), description: z.string() });
const heartbeatData = z.object({ service: z.string(), url: z.string(), at: z.string() });

const Bug = H.kind('Bug', { data: ticketData, key: (bug) => bug.id })
  .states([Todo, Done, Abandoned, Cancelled], { initial: Todo })
  .on('cancel', { from: [Todo], to: Cancelled, attempt: 'cancel' });

const Feature = H.kind('Feature', { data: featureData, key: (feature) => feature.id })
  .states([Todo, Done, Abandoned, Cancelled], { initial: Todo })
  .on('cancel', { from: [Todo], to: Cancelled, attempt: 'cancel' });

const Epic = H.kind('Epic', { data: epicData, key: (epic) => epic.id })
  .states([Planning, Delivering, Reviewing, Done, Abandoned, Cancelled], { initial: Planning })
  .on('down', { from: [Delivering], to: Reviewing })
  .on('cancel', { from: [Planning, Delivering, Reviewing], to: Cancelled, attempt: 'cancel' });

const ServiceHeartbeat = H.kind('ServiceHeartbeat', {
  data: heartbeatData,
  key: (beat) => `${beat.service}@${beat.at}`,
}).states([Due, Healthy, Unhealthy], { initial: Due });

const Files = H.resource('file');
const Area = H.resource('area');

const Experience = H.memory('experience', { authority: 'observed' });
const Taste = H.memory('taste', { authority: 'owner' });

const experienceJournal = H.journal('coding-experience', Experience)
  .store(jsonl.store('.harness/memory/experience.jsonl'))
  .recall(H.recall.bySpecificity({ limit: 12 }));
const tasteJournal = H.journal('owner-taste', Taste)
  .store(jsonl.store('.harness/memory/taste.jsonl'))
  .recall(H.recall.bySpecificity({ limit: 20 }));

const subscriptionA = claudeCode.subscription('max-a', { configDir: H.env('CLAUDE_CONFIG_A') });
const subscriptionB = claudeCode.subscription('max-b', { configDir: H.env('CLAUDE_CONFIG_B') });
const subscriptionC = claudeCode.subscription('max-c', { configDir: H.env('CLAUDE_CONFIG_C') });
const apiFallback = claudeCode.apiKey('api-fallback', { key: H.env('ANTHROPIC_API_KEY') });

const resetTime = (account: AccountView) =>
  account.resetsAt === null ? Number.MAX_SAFE_INTEGER : account.resetsAt.getTime();

const claudePool = H.pool('claude-subscriptions')
  .accounts([
    { account: subscriptionA, share: 0.5 },
    { account: subscriptionB, share: 0.3 },
    { account: subscriptionC, share: 0.2 },
  ])
  .order((accounts) => [...accounts].filter((account) => account.eligible).sort((a, b) => resetTime(a) - resetTime(b)))
  .fallback(apiFallback);

const sonnet = claudeCode.model('sonnet');
const opus = claudeCode.model('opus');

const builderModel = H.choose('builder-model', [sonnet, opus], (query, context) => {
  const cheap = context.metrics.successRate({ kind: { name: query.kind }, days: 14, model: sonnet, agent: query.agent });
  return cheap.samples >= 20 && cheap.value !== null && cheap.value < 0.85 ? opus : sonnet;
});

const localRunner = shell.local({ slots: 4 });
const worktree = git.worktree({ repo: '.', baseBranch: 'main' });

const projectChecks = H.command('project-checks', {
  input: z.object({ workspacePath: z.string() }),
  argv: (input) => ['npm', '--prefix', input.workspacePath, 'run', 'check'],
  runner: localRunner,
});

const productionHealth = H.command('production-health', {
  input: z.object({}),
  argv: () => ['./scripts/production-health.sh'],
  runner: localRunner,
});

const serviceProbe = H.command('service-probe', {
  input: z.object({ url: z.string() }),
  argv: (input) => ['curl', '-fsS', '--max-time', '10', input.url],
  runner: localRunner,
});

const builderRole = H.role('builder', {
  prompt: 'Implement the work item in the worktree, addressing every listed deficit. Ask the owner when a product decision is needed.',
  intents: ['read', 'edit', 'execute', 'ask'],
  input: z.object({
    title: z.string(),
    description: z.string(),
    round: z.number(),
    deficits: z.array(z.string()),
  }),
  output: z.object({ summary: z.string() }),
});

const auditorRole = H.role('auditor', {
  prompt: 'Audit the change in the worktree against the work item. List each deficit; return none when the work is complete.',
  intents: ['read', 'execute'],
  input: z.object({ title: z.string(), description: z.string(), summary: z.string() }),
  output: z.object({ deficits: z.array(z.string()) }),
});

const plannerRole = H.role('planner', {
  prompt: 'Decompose the epic into independently deliverable features.',
  intents: ['read', 'search'],
  input: z.object({ title: z.string(), description: z.string() }),
  output: z.object({ features: z.array(z.object({ title: z.string(), description: z.string() })) }),
});

const builder = H.agent('builder', builderRole)
  .model(builderModel)
  .pool(claudePool)
  .recall(experienceJournal, tasteJournal)
  .workspace(worktree)
  .guard(H.guard.lease(Files), H.guard.beforeStop(projectChecks));

const auditor = H.agent('auditor', auditorRole)
  .model(opus)
  .pool(claudePool)
  .recall(experienceJournal)
  .record(experienceJournal)
  .workspace(worktree);

const planner = H.agent('planner', plannerRole).model(opus).pool(claudePool).recall(tasteJournal);

const buildAndAudit = H.flow(
  'build-and-audit',
  {
    input: z.object({ title: z.string(), description: z.string() }),
    params: z.object({ rounds: z.number() }),
    exits: ['done', 'abandoned'],
  },
  async (ctx) => {
    let deficits: string[] = [];
    for (let round = 1; round <= ctx.params.rounds; round += 1) {
      const build = await ctx.run(`build-${round}`, builder, {
        title: ctx.input.title,
        description: ctx.input.description,
        round,
        deficits,
      });
      const audit = await ctx.run(`audit-${round}`, auditor, {
        title: ctx.input.title,
        description: ctx.input.description,
        summary: build.summary,
      });
      if (audit.deficits.length === 0) {
        return ctx.exit('done');
      }
      deficits = audit.deficits;
    }
    return ctx.exit('abandoned');
  },
);

const linearKey = H.env('LINEAR_API_KEY');
const trackerStore = linear.store({
  team: 'ENG',
  apiKey: linearKey,
  states: { todo: 'Todo', done: 'Done', abandoned: 'Canceled', cancelled: 'Canceled', planning: 'Backlog', delivering: 'In Progress', reviewing: 'In Review' },
});

const areasOf = (labels: readonly string[]) =>
  labels.filter((label) => label.startsWith('area:')).map((label) => label.slice('area:'.length));

const trackerBugs = linear.issues({ team: 'ENG', apiKey: linearKey, labels: ['bug'] }).to(Bug, (issue, unit) =>
  unit.create({ id: issue.identifier, title: issue.title, description: issue.description, areas: areasOf(issue.labels) }),
);

const folderBugs = folder
  .files({ dir: 'inbox/bugs', frontmatter: z.object({ id: z.string(), title: z.string(), areas: z.array(z.string()) }) })
  .to(Bug, (file, unit) =>
    unit.create({ id: file.frontmatter.id, title: file.frontmatter.title, description: file.body, areas: file.frontmatter.areas }),
  );

const trackerFeatures = linear.issues({ team: 'ENG', apiKey: linearKey, labels: ['feature'] }).to(Feature, (issue, unit) =>
  unit.create({
    id: issue.identifier,
    title: issue.title,
    description: issue.description,
    areas: areasOf(issue.labels),
    epicId: issue.parentId,
  }),
);

const trackerEpics = linear.issues({ team: 'ENG', apiKey: linearKey, labels: ['epic'] }).to(Epic, (issue, unit) =>
  unit.create({ id: issue.identifier, title: issue.title, description: issue.description }),
);

const bugLane = H.lane('bugs', Bug)
  .supply(trackerBugs, folderBugs, H.supply.operator(Bug))
  .store(trackerStore)
  .handle(Todo, buildAndAudit, {
    params: { rounds: 3 },
    exits: { done: Done, abandoned: Abandoned },
    crash: { retries: 1, then: Abandoned },
  })
  .limit({ wip: 2 })
  .resources((bug) => bug.areas.map((area) => Area.key(area)));

const featureLane = H.lane('features', Feature)
  .supply(trackerFeatures, H.supply.operator(Feature))
  .store(trackerStore)
  .handle(Todo, buildAndAudit, {
    params: { rounds: 5 },
    exits: { done: Done, abandoned: Abandoned },
    crash: { retries: 1, then: Abandoned },
  })
  .resources((feature) => feature.areas.map((area) => Area.key(area)));

const planEpic = H.flow('plan-epic', { input: epicData, exits: ['spawned'] }, async (ctx) => {
  const plan = await ctx.run('plan', planner, { title: ctx.input.title, description: ctx.input.description });
  await ctx.spawn(
    'features',
    featureLane,
    plan.features.map((feature, index) => ({
      id: `${ctx.input.id}-F${index + 1}`,
      title: feature.title,
      description: feature.description,
      areas: [],
      epicId: ctx.input.id,
    })),
  );
  return ctx.exit('spawned');
});

const reviewEpic = H.flow('review-epic', { input: epicData, exits: ['delivered', 'abandoned', 'waiting'] }, async (ctx) => {
  const children = await ctx.children('features');
  const open = children.filter((child) => child.outcome === 'pending' || child.outcome === 'active' || child.outcome === 'waiting');
  if (open.length > 0) {
    return ctx.exit('waiting');
  }
  return children.every((child) => child.outcome === 'succeeded') ? ctx.exit('delivered') : ctx.exit('abandoned');
});

const epicLane = H.lane('epics', Epic)
  .supply(trackerEpics)
  .store(trackerStore)
  .handle(Planning, planEpic, { exits: { spawned: Delivering } })
  .handle(Reviewing, reviewEpic, { exits: { delivered: Done, abandoned: Abandoned, waiting: Delivering } })
  .limit({ wip: 1 });

const services = [
  { name: 'api', url: 'https://api.internal/health' },
  { name: 'web', url: 'https://web.internal/health' },
  { name: 'worker', url: 'https://worker.internal/health' },
];

const heartbeatSchedule = H.supply.schedule(ServiceHeartbeat, H.time.every({ minutes: 5 }), (tick, unit) =>
  services.map((service) => unit.create({ service: service.name, url: service.url, at: tick.at.toISOString() })),
);

const checkHeartbeat = H.flow('check-heartbeat', { input: z.object({ url: z.string() }), exits: ['healthy', 'unhealthy'] }, async (ctx) => {
  const probe = await ctx.try('probe', serviceProbe, { url: ctx.input.url });
  return probe.ok ? ctx.exit('healthy') : ctx.exit('unhealthy');
});

const heartbeatLane = H.lane('heartbeats', ServiceHeartbeat)
  .supply(heartbeatSchedule)
  .handle(Due, checkHeartbeat, { exits: { healthy: Healthy, unhealthy: Unhealthy }, crash: { retries: 0, then: Unhealthy } });

const unhealthyHeartbeatOpensBug = H.trigger('unhealthy-heartbeat-opens-bug')
  .on(H.when.entered(ServiceHeartbeat, Unhealthy))
  .create(bugLane, (transition) => ({
    id: `HB-${transition.unit.data.service}-${transition.at.getTime()}`,
    title: `${transition.unit.data.service} heartbeat failed`,
    description: `The heartbeat of ${transition.unit.data.service} at ${transition.unit.data.at} failed its health probe.`,
    areas: [transition.unit.data.service],
  }));

const priority = (unit: PendingView) => {
  if (unit.is(ServiceHeartbeat)) return 0;
  if (unit.is(Feature) && unit.waitingSeconds > 4 * 3600) return 1;
  if (unit.is(Bug)) return 2;
  if (unit.is(Feature)) return 3;
  return 4;
};

const scheduler = H.scheduler('heartbeats-bugs-features-epics', (query) => ({
  order: [...query.pending].sort((a, b) => priority(a) - priority(b) || b.waitingSeconds - a.waitingSeconds),
}));

const supervisor = H.client('supervisor', claudeCode.session()).grant([
  H.ops.readWork,
  H.ops.writeWork,
  H.ops.resolveBlockers,
  H.ops.readMemory,
  H.ops.writeMemory,
  H.ops.readTelemetry,
  H.ops.readAccounts,
  H.ops.writeShares,
  H.operation('probe-production', productionHealth),
]);

export const harness = H.harness('coding-team')
  .ledger(sqlite.ledger('.harness/ledger.db'))
  .lanes([heartbeatLane, bugLane, featureLane, epicLane])
  .journals([experienceJournal, tasteJournal])
  .triggers([unhealthyHeartbeatOpensBug])
  .scheduler(scheduler)
  .clients([supervisor])
  .observers([markdown.board('BOARD.md'), markdown.telemetry('TELEMETRY.md')])
  .restart({ maxRestarts: 5, withinSeconds: 60 });
