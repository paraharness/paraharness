import { z } from 'zod';
import { H, Candidate, Model, ModelChoice, PolicyEnv, SchedulingInput } from 'harness-dsl';
import * as claude from 'harness-dsl/claude-code';
import * as anthropic from 'harness-dsl/anthropic';
import * as linear from 'harness-dsl/linear';
import * as folder from 'harness-dsl/folder';
import * as sqlite from 'harness-dsl/sqlite';
import * as jsonl from 'harness-dsl/jsonl';
import * as git from 'harness-dsl/git';
import * as local from 'harness-dsl/local';
import * as markdown from 'harness-dsl/markdown';

const Todo = H.state('todo', 'pending');
const InProgress = H.state('in-progress', 'active');
const Decomposed = H.state('decomposed', 'active');
const Done = H.state('done', 'succeeded');
const Stuck = H.state('stuck', 'failed');
const Dropped = H.state('dropped', 'cancelled');

const TicketSchema = z.object({ ref: z.string(), title: z.string(), description: z.string() });
const FeatureSchema = TicketSchema.extend({ epic: z.string().optional() });
type TicketData = z.infer<typeof TicketSchema>;
type FeatureData = z.infer<typeof FeatureSchema>;

const Bug = H.work('Bug', TicketSchema).states(Todo, InProgress, Done, Stuck, Dropped).key(bug => bug.ref);
const Feature = H.work('Feature', FeatureSchema).states(Todo, InProgress, Done, Stuck, Dropped).key(feature => feature.ref);
const Epic = H.work('Epic', TicketSchema).states(Todo, Decomposed, Done, Stuck, Dropped).key(epic => epic.ref);

const HeartbeatDue = H.state('due', 'pending');
const Probing = H.state('probing', 'active');
const Healthy = H.state('healthy', 'succeeded');
const Unhealthy = H.state('unhealthy', 'failed');
const HeartbeatSchema = z.object({ service: z.string(), url: z.string(), at: z.string() });
const Heartbeat = H.work('ServiceHeartbeat', HeartbeatSchema)
  .states(HeartbeatDue, Probing, Healthy, Unhealthy)
  .key(beat => `${beat.service}@${beat.at}`);

const sourceTree = H.resource('source-tree');

const builderRole = H.role('builder')
  .intents('read', 'edit', 'execute', 'search', 'halt')
  .instructions('Implement the work item in your worktree. Halt the attempt when a decision belongs to the owner.')
  .skills('typescript');
const auditorRole = H.role('auditor')
  .intents('read', 'search', 'execute')
  .instructions('List every deficit between the work item and the worktree. Return an empty list only when nothing is missing.');
const plannerRole = H.role('planner')
  .intents('read', 'search')
  .instructions('Decompose the epic into features that can ship independently.');

const max1 = claude.subscription('max-1', { credentials: H.env('CLAUDE_MAX_1') });
const max2 = claude.subscription('max-2', { credentials: H.env('CLAUDE_MAX_2') });
const max3 = claude.subscription('max-3', { credentials: H.env('CLAUDE_MAX_3') });
const apiFallback = anthropic.apiKey('anthropic-api', { key: H.env('ANTHROPIC_API_KEY') });

const claudePool = H.pool('claude')
  .accounts(max1, max2, max3)
  .share(max1, 0.5)
  .share(max2, 0.5)
  .share(max3, 0.3)
  .order(H.policy.soonestReset())
  .fallback(apiFallback);

const sonnet = claude.model('sonnet');
const opus = claude.model('opus');

const builderModel = H.policy('builder-model', (choice: ModelChoice, env: PolicyEnv): Model => {
  const cheaper = env.metrics.successRate({ kind: choice.kind, model: sonnet, sinceDays: 14 });
  if (cheaper.samples < 20 || cheaper.rate === null) return sonnet;
  return cheaper.rate < 0.85 ? opus : sonnet;
});

const experience = H.journal('engineering-experience', H.memory.experience('engineering-experience'))
  .store(jsonl.memory('.harness/experience.jsonl'))
  .recall(H.policy.specificity({ limit: 12, trackRecord: true }));
const taste = H.journal('owner-taste', H.memory.taste('owner-taste'))
  .store(jsonl.memory('.harness/taste.jsonl'))
  .recall(H.policy.specificity({ limit: 20 }));

const projectChecks = H.command('project-checks').run(() => ['npm', 'run', 'check']);

const builder = H.agent('builder', builderRole)
  .model(builderModel)
  .pool(claudePool)
  .recall(experience, taste)
  .guards(H.guard.lease(sourceTree), H.guard.stopCheck(projectChecks));
const auditor = H.agent('auditor', auditorRole)
  .model(opus)
  .pool(claudePool)
  .recall(experience)
  .record(experience)
  .output(z.object({ deficits: z.array(z.string()) }));
const planner = H.agent('planner', plannerRole)
  .model(opus)
  .pool(claudePool)
  .recall(taste)
  .output(z.object({ features: z.array(z.object({ title: z.string(), description: z.string() })) }));

type Brief = { readonly title: string; readonly description: string };

const deliver = H.flow<Brief>('build-and-audit')
  .params(z.object({ maxRounds: z.number() }))
  .exits('clean', 'exhausted')
  .repeat(
    'rounds',
    round => round
      .call('build', builder, ctx => `Round ${ctx.round}: ${ctx.unit.data.title}\n\n${ctx.unit.data.description}`)
      .call('audit', auditor, ctx => `Audit the worktree against: ${ctx.unit.data.title}\n\nBuilder report:\n${ctx.steps.build}`),
    {
      max: ctx => ctx.params.maxRounds,
      until: ctx => ctx.steps.audit.deficits.length === 0,
    },
  )
  .exit(ctx => (ctx.steps.audit.deficits.length === 0 ? 'clean' : 'exhausted'));

const decompose = H.flow<TicketData>('decompose-epic')
  .exits('decomposed')
  .call('plan', planner, ctx => `${ctx.unit.data.title}\n\n${ctx.unit.data.description}`)
  .spawn('features', Feature, ctx =>
    ctx.steps.plan.features.map((feature, index): FeatureData => ({
      ref: `${ctx.unit.data.ref}/feature-${index + 1}`,
      title: feature.title,
      description: feature.description,
      epic: ctx.unit.data.ref,
    })),
  )
  .exit('decomposed');

const probeHealth = H.command('probe-health').run((input: { url: string }) => ['curl', '-fsS', '--max-time', '10', input.url]);

const probe = H.flow<z.infer<typeof HeartbeatSchema>>('probe-service')
  .exits('healthy', 'unhealthy')
  .call('probe', probeHealth, ctx => ({ url: ctx.unit.data.url }), { onFailure: { exit: 'unhealthy' } })
  .exit('healthy');

const services = [
  { service: 'api', url: 'https://api.example.com/health' },
  { service: 'web', url: 'https://www.example.com/health' },
  { service: 'worker', url: 'https://worker.example.com/health' },
];

const linearBugs = linear.tracker<TicketData>({
  team: 'ENG',
  apiKey: H.env('LINEAR_API_KEY'),
  labels: ['bug'],
  map: issue => ({ ref: issue.identifier, title: issue.title, description: issue.description }),
  patch: (_bug, state) => ({ state }),
});
const folderBugs = folder.markdown<TicketData>({
  dir: 'inbox/bugs',
  map: file => ({ ref: file.path, title: String(file.frontmatter.title ?? file.path), description: file.body }),
});
const linearFeatures = linear.tracker<FeatureData>({
  team: 'ENG',
  apiKey: H.env('LINEAR_API_KEY'),
  labels: ['feature'],
  map: issue => ({ ref: issue.identifier, title: issue.title, description: issue.description, epic: issue.parentId }),
  patch: (_feature, state) => ({ state }),
});
const linearEpics = linear.tracker<TicketData>({
  team: 'ENG',
  apiKey: H.env('LINEAR_API_KEY'),
  labels: ['epic'],
  map: issue => ({ ref: issue.identifier, title: issue.title, description: issue.description }),
  patch: (_epic, state) => ({ state }),
});

const worktrees = git.worktrees('worktrees', { repo: '.', base: 'main', resource: sourceTree });

const heartbeatLane = H.lane(Heartbeat)
  .supply(
    H.supply.schedule(Heartbeat, { every: { minutes: 5 } }).create(tick =>
      services.map(target => ({ ...target, at: tick.now.toISOString() })),
    ),
  )
  .handler(probe)
  .exits({ healthy: Healthy, unhealthy: Unhealthy, crashed: Unhealthy })
  .phases({ probe: Probing })
  .runner(local.runner('local'));

const bugLane = H.lane(Bug)
  .supply(linearBugs, folderBugs, H.supply.operator())
  .store(linearBugs)
  .handler(deliver, { maxRounds: 3 })
  .exits({ clean: Done, exhausted: Stuck, crashed: Stuck })
  .phases({ rounds: InProgress })
  .runner(worktrees);

const featureLane = H.lane(Feature)
  .supply(linearFeatures, H.supply.operator())
  .store(linearFeatures)
  .handler(deliver, { maxRounds: 5 })
  .exits({ clean: Done, exhausted: Stuck, crashed: Stuck })
  .phases({ rounds: InProgress })
  .runner(worktrees);

const epicLane = H.lane(Epic)
  .supply(linearEpics)
  .store(linearEpics)
  .handler(decompose)
  .exits({ decomposed: Decomposed, crashed: Stuck })
  .receive(H.down, exit => (exit.remaining === 0 ? { to: exit.failed === 0 ? Done : Stuck } : undefined));

const heartbeatFailureFilesBug = H.trigger('heartbeat-failure-files-bug')
  .on(H.on.enter(Heartbeat, Unhealthy))
  .do(event =>
    H.do.create(bugLane, {
      ref: `heartbeat/${event.unit.data.service}/${event.unit.data.at}`,
      title: `${event.unit.data.service} failed its heartbeat`,
      description: `The health probe at ${event.unit.data.url} failed at ${event.unit.data.at}.`,
    }),
  );

const laneRank = new Map<string, number>([
  [heartbeatLane.name, 0],
  [bugLane.name, 1],
  [featureLane.name, 2],
  [epicLane.name, 3],
]);
const featureStarvationSeconds = 4 * 3600;

const teamOrder = H.policy('team-order', (input: SchedulingInput, _env: PolicyEnv): readonly Candidate[] => {
  const rank = (candidate: Candidate): number =>
    candidate.lane === featureLane.name && candidate.waitingSeconds > featureStarvationSeconds
      ? 1
      : laneRank.get(candidate.lane) ?? 4;
  return [...input.pending].sort((a, b) => rank(a) - rank(b) || b.waitingSeconds - a.waitingSeconds);
});

const teamScheduler = H.scheduler('team').order(teamOrder).wip(bugLane, 2).wip(epicLane, 1);

const probeProduction = H.operation('probeProduction', {
  input: z.object({ url: z.string() }),
  run: H.command('probe-production').run((input: { url: string }) => ['curl', '-fsS', '--max-time', '10', input.url]),
});

const supervisorGrant = H.grant(
  'owner-supervisor',
  H.op.readWork,
  H.op.createWork,
  H.op.updateWork,
  H.op.cancelWork,
  H.op.resolveBlocker,
  H.op.writeMemory,
  H.op.readTelemetry,
  H.op.setAccountShare,
  probeProduction,
);

export const codingTeam = H.harness('coding-team')
  .ledger(sqlite.ledger('.harness/ledger.db'))
  .lanes(heartbeatLane, bugLane, featureLane, epicLane)
  .triggers(heartbeatFailureFilesBug)
  .scheduler(teamScheduler)
  .clients(claude.supervisor({ grant: supervisorGrant }))
  .observe(markdown.board({ path: 'BOARD.md' }), markdown.telemetry({ path: 'TELEMETRY.md' }));

void codingTeam.start();
