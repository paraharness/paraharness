import { z } from 'zod';
import { H } from 'harness-dsl';
import type { Model } from 'harness-dsl';
import * as claudeCode from 'harness-dsl/claude-code';
import * as anthropic from 'harness-dsl/anthropic';
import * as linear from 'harness-dsl/linear';
import * as folder from 'harness-dsl/folder';
import * as sqlite from 'harness-dsl/sqlite';
import * as jsonl from 'harness-dsl/jsonl';
import * as git from 'harness-dsl/git';
import * as local from 'harness-dsl/local';
import * as markdown from 'harness-dsl/markdown';

const hourMs = 3_600_000;

const Queued = H.state('queued', 'pending');
const InProgress = H.state('in progress', 'active');
const Done = H.state('done', 'succeeded');
const Abandoned = H.state('abandoned', 'failed');
const Cancelled = H.state('cancelled', 'cancelled');
const ticketStates = [Queued, InProgress, Done, Abandoned, Cancelled];

const ticketAttributes = { priority: z.number(), area: z.string() };
const ticketFields = { title: z.string(), description: z.string(), url: z.string().optional() };

const Bug = H.work('Bug').attributes(ticketAttributes).fields(ticketFields).states(ticketStates);
const Feature = H.work('Feature').attributes(ticketAttributes).fields(ticketFields).states(ticketStates);
const Epic = H.work('Epic')
  .attributes({ priority: z.number() })
  .fields({ title: z.string(), description: z.string() })
  .states(ticketStates);

const Due = H.state('due', 'pending');
const Checking = H.state('checking', 'active');
const Healthy = H.state('healthy', 'succeeded');
const Down = H.state('down', 'failed');
const ServiceHeartbeat = H.work('ServiceHeartbeat')
  .attributes({ service: z.string(), tick: z.number() })
  .states([Due, Checking, Healthy, Down])
  .key(unit => `${unit.attributes.service}@${unit.attributes.tick}`);

const subscriptionA = claudeCode.subscription('claude-max-a', { configDir: H.env('CLAUDE_CONFIG_A') });
const subscriptionB = claudeCode.subscription('claude-max-b', { configDir: H.env('CLAUDE_CONFIG_B') });
const subscriptionC = claudeCode.subscription('claude-max-c', { configDir: H.env('CLAUDE_CONFIG_C') });
const apiAccount = anthropic.account('anthropic-api', { apiKey: H.env('ANTHROPIC_API_KEY') });

const soonestExpiring = H.policy.account('soonest-expiring-window', c =>
  [...c.eligible]
    .filter(account => account.eligible && account.harnessUtilization < account.share)
    .sort((a, b) => a.windowEndsAt - b.windowEndsAt)[0] ?? null,
);

const claudePool = H.pool('claude-subscriptions')
  .accounts([
    { account: subscriptionA, share: 0.5 },
    { account: subscriptionB, share: 0.3 },
    { account: subscriptionC, share: 0.2 },
  ])
  .prefer(soonestExpiring)
  .fallback(apiAccount);

const sonnet = claudeCode.model('claude-sonnet-4-5');
const opus = claudeCode.model('claude-opus-4-1');

const builderModel = H.policy.model('builder-model', [sonnet, opus], (c): Model => {
  const cheaper = c.metrics.success({ kind: c.unit ? c.unit.kind : Bug.name, model: sonnet, windowDays: 14 });
  return cheaper.n >= 20 && cheaper.rate !== null && cheaper.rate < 0.85 ? opus : sonnet;
});

const provenShare = (track: { present: number; succeeded: number }): number =>
  track.present === 0 ? 0 : track.succeeded / track.present;

const specificThenProven = H.policy.recall('specific-then-proven', c =>
  [...c.candidates]
    .sort((a, b) => b.specificity - a.specificity || provenShare(b.track) - provenShare(a.track))
    .slice(0, c.limit),
);

const Experience = H.memory.experience('engineering-experience');
const Taste = H.memory.taste('owner-taste');
const experienceJournal = H.journal('experience-journal', Experience)
  .store(jsonl.memory('.harness/memory/experience.jsonl'))
  .recall(specificThenProven);
const tasteJournal = H.journal('taste-journal', Taste)
  .store(jsonl.memory('.harness/memory/taste.jsonl'))
  .recall(specificThenProven);

const builderRole = H.role('builder')
  .intents(['read', 'write', 'execute', 'ask'])
  .instructions('Implement the task in the worktree. Address every listed deficit. Ask the owner when a decision is theirs.')
  .input({ task: z.string(), details: z.string(), deficits: z.array(z.string()) })
  .output({ summary: z.string(), files: z.array(z.string()) });

const auditorRole = H.role('auditor')
  .intents(['read', 'execute', 'remember'])
  .instructions('List every deficit in the change. Record lessons future builders need.')
  .input({ task: z.string(), summary: z.string(), files: z.array(z.string()) })
  .output({ deficits: z.array(z.string()) });

const plannerRole = H.role('planner')
  .intents(['read', 'search'])
  .instructions('Decompose the epic into independently shippable features.')
  .input({ task: z.string(), details: z.string() })
  .output({ features: z.array(z.object({ title: z.string(), description: z.string() })) });

const projectChecks = H.command('project-checks', ['npm', 'run', 'check']);

const builder = H.agent('builder', builderRole)
  .model(builderModel)
  .pool(claudePool)
  .recalls([experienceJournal, tasteJournal])
  .leaseWrites()
  .mustPass(projectChecks);

const auditor = H.agent('auditor', auditorRole)
  .model(opus)
  .pool(claudePool)
  .recalls([experienceJournal])
  .records(experienceJournal);

const planner = H.agent('planner', plannerRole)
  .model(opus)
  .pool(claudePool)
  .recalls([tasteJournal]);

const deliveryFlow = H.flow('delivery')
  .requires({ title: z.string(), description: z.string() })
  .params({ rounds: z.number() })
  .mark('building')
  .loop(
    'rounds',
    { carry: { deficits: z.array(z.string()) }, rounds: c => c.params.rounds },
    round => round
      .step('build', builder, c => ({
        task: c.input.title,
        details: c.input.description,
        deficits: c.carry ? c.carry.deficits : [],
      }))
      .step('audit', auditor, c => ({ task: c.input.title, summary: c.out.build.summary, files: c.out.build.files })),
    last => (last.audit.deficits.length === 0 ? null : { deficits: last.audit.deficits }),
  )
  .ends(['shipped', 'gaveUp'], c => (c.out.rounds.last.audit.deficits.length === 0 ? 'shipped' : 'gaveUp'));

const decompositionFlow = H.flow('decomposition')
  .requires({ title: z.string(), description: z.string() })
  .mark('planning')
  .step('plan', planner, c => ({ task: c.input.title, details: c.input.description }))
  .spawn('features', {
    outlet: 'feature',
    child: { title: z.string(), description: z.string() },
    items: c => c.out.plan.features,
  })
  .ends(['complete', 'incomplete'], c =>
    c.out.features.every(feature => feature.outcome === 'succeeded') ? 'complete' : 'incomplete',
  );

const healthCheck = H.command('health-check', ['scripts/health-check.sh']);

const heartbeatFlow = H.flow('heartbeat')
  .requires({ service: z.string() })
  .mark('checking')
  .step('check', healthCheck, c => ({ args: [c.input.service] }), { timeoutMs: 30_000 })
  .ends(['healthy'], () => 'healthy');

const tracker = { apiKey: H.env('LINEAR_API_KEY'), team: 'ENG' };
const trackerStatus = {
  queued: 'Todo',
  'in progress': 'In Progress',
  done: 'Done',
  abandoned: 'Canceled',
  cancelled: 'Canceled',
};

const fromIssue = (issue: linear.LinearIssue) => ({
  attributes: { priority: issue.priority, area: issue.labels[0] ?? 'general' },
  fields: { title: issue.title, description: issue.description, url: issue.url },
});

const worktrees = git.worktree({ repo: '.', base: 'main', slots: 3 });
const services = ['api', 'web', 'worker'];

const heartbeatLane = H.lane('heartbeats', ServiceHeartbeat)
  .supply([
    H.supply.schedule(ServiceHeartbeat, H.time.every({ minutes: 5 }), c =>
      services.map(service => ({ create: { attributes: { service, tick: c.now } } })),
    ),
  ])
  .runner(local.shell({ slots: 2 }))
  .handler(heartbeatFlow, { states: { checking: Checking, healthy: Healthy, failed: Down } });

const bugLane = H.lane('bugs', Bug)
  .supply([
    linear.issues(Bug, { ...tracker, labels: ['bug'] }, fromIssue),
    folder.files(Bug, 'inbox/bugs', file => ({
      attributes: { priority: 3, area: String(file.frontmatter['area'] ?? 'general') },
      fields: { title: String(file.frontmatter['title'] ?? file.path), description: file.body },
    })),
    H.supply.operator(),
  ])
  .store(linear.store(Bug, { ...tracker, status: trackerStatus }))
  .runner(worktrees)
  .handler(deliveryFlow, {
    states: { building: InProgress, shipped: Done, gaveUp: Abandoned, failed: Abandoned },
    params: { rounds: 3 },
  })
  .wip(2);

const featureLane = H.lane('features', Feature)
  .supply([linear.issues(Feature, { ...tracker, labels: ['feature'] }, fromIssue), H.supply.operator()])
  .store(linear.store(Feature, { ...tracker, status: trackerStatus }))
  .runner(worktrees)
  .handler(deliveryFlow, {
    states: { building: InProgress, shipped: Done, gaveUp: Abandoned, failed: Abandoned },
    params: { rounds: 5 },
  });

const epicLane = H.lane('epics', Epic)
  .supply([
    linear.issues(Epic, { ...tracker, labels: ['epic'] }, issue => ({
      attributes: { priority: issue.priority },
      fields: { title: issue.title, description: issue.description },
    })),
  ])
  .store(linear.store(Epic, { ...tracker, status: trackerStatus }))
  .runner(local.shell({ slots: 1, cwd: '.' }))
  .handler(decompositionFlow, {
    states: { planning: InProgress, complete: Done, incomplete: Abandoned, failed: Abandoned },
    spawns: {
      feature: H.child(featureLane, (feature: { title: string; description: string }) => ({
        attributes: { priority: 2, area: 'epic' },
        fields: { title: feature.title, description: feature.description },
      })),
    },
  })
  .wip(1);

const heartbeatFailureFilesBug = H.trigger('heartbeat-failure-files-bug', H.on.transition(heartbeatLane, { to: [Down] }))
  .creates(bugLane, event => ({
    attributes: { priority: 1, area: event.unit.attributes.service },
    fields: {
      title: `Service ${event.unit.attributes.service} failed its heartbeat`,
      description: event.outputs.check ? event.outputs.check.stderr : 'The health check produced no output.',
    },
  }));

const laneOrder = [heartbeatLane.name, bugLane.name, featureLane.name, epicLane.name];
const teamRank = (lane: string, waitedMs: number): number =>
  lane === featureLane.name && waitedMs > 2 * hourMs ? 0.5 : laneOrder.indexOf(lane);

const teamOrder = H.policy.schedule('team-order', c => ({
  start: [...c.candidates].sort((a, b) => teamRank(a.unit.lane, a.waitedMs) - teamRank(b.unit.lane, b.waitedMs)),
}));

const probeProduction = H.operation('probe-production')
  .input({ endpoint: z.string() })
  .invokes(H.command('production-probe', ['scripts/probe-production.sh']), input => ({ args: [input.endpoint] }));

const supervisorAccess = H.access('supervisor').allows([
  H.ops.readWork,
  H.ops.createWork,
  H.ops.updateWork,
  H.ops.signalWork,
  H.ops.resolveBlocks,
  H.ops.readMemory,
  H.ops.writeMemory,
  H.ops.readTelemetry,
  H.ops.readAccounts,
  H.ops.setShares,
  probeProduction,
]);

export const codingTeam = H.harness('coding-team')
  .ledger(sqlite.ledger('.harness/ledger.db'))
  .lanes([heartbeatLane, bugLane, featureLane, epicLane])
  .triggers([heartbeatFailureFilesBug])
  .schedule(teamOrder)
  .clients([claudeCode.supervisor('supervisor', supervisorAccess, { port: H.slot.port(0) })])
  .projections([markdown.board('.harness/BOARD.md'), markdown.telemetry('.harness/TELEMETRY.md')]);
